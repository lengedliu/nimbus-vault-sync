const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-gitpull-'));

const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');
const gitSync = require('../src/gitSync');
const vaults = require('../src/vaults');

const VAULT = 'gitpull-vault';

function gitRun(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString().trim();
}

test('gitSync.recordPulledChanges: 变更记录持久化失败必须上抛，重试可补录 (W-8)', async () => {
  // Vault 本地仓库（initRepo 负责 git init + 用户身份 + .gitignore）
  await gitSync.initRepo(VAULT);
  const repoDir = vaults.vaultFilesRoot(VAULT);

  // 空 root 提交，便于之后用 ORIG_HEAD=HEAD~2 把 a.md/b.md 都纳入 diff 重放
  gitRun(repoDir, ['commit', '--allow-empty', '-m', 'root']);

  storage.writeFile(VAULT, 'a.md', Buffer.from('alpha'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'v1']);

  storage.writeFile(VAULT, 'b.md', Buffer.from('bravo'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'v2']);

  // 模拟一次成功的 pull 之后的状态：ORIG_HEAD = root 提交，HEAD = v2。
  // 与真实 pull() 的差异只在：这里绕过「连远端」这一步（本地 file:// 远端被
  // gitUrlGuard 出于跨租户安全有意拒绝，测试用 update-ref 置位 ORIG_HEAD 等价复现）。
  gitRun(repoDir, ['update-ref', 'ORIG_HEAD', 'HEAD~2']);

  await deltaSync.waitForPendingWrites(VAULT);
  const cursorBefore = deltaSync.getLatestCursor(VAULT);

  const first = await gitSync.recordPulledChanges(VAULT);
  assert.ok(Array.isArray(first.changedPaths));
  assert.ok(first.changedPaths.includes('a.md'));
  assert.ok(first.changedPaths.includes('b.md'));

  await deltaSync.waitForPendingWrites(VAULT);
  const cursorAfter = deltaSync.getLatestCursor(VAULT);
  assert.ok(cursorAfter > cursorBefore, 'UPSERT 记录 durable 后游标推进');

  let data = await deltaSync.getChanges(VAULT, Math.max(cursorBefore, 1), 500);
  assert.ok((data.updates || []).some((u) => u.path === 'a.md'), 'a.md 的 UPSERT 可从增量通道重放');

  // —— 第三笔提交 + 注入 deltaSync 持久化失败 ——
  storage.writeFile(VAULT, 'c.md', Buffer.from('charlie'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'v3']);

  const original = deltaSync.recordBatchChanges;
  deltaSync.recordBatchChanges = async () => {
    throw new Error('delta db down');
  };
  try {
    // 🛡️ 旧实现吞错继续返回成功：文件已落盘但 UPSERT 未 durable、游标不推进，
    // delta-only 客户端永远漏拉。现在必须上抛。
    await assert.rejects(() => gitSync.recordPulledChanges(VAULT), /delta db down/);
  } finally {
    deltaSync.recordBatchChanges = original;
  }
  //（注：c.md 经 storage.writeFile 本身就有一条 durable UPSERT——durable 写路径
  // 的本职行为，与本修复无关；git pull 引入的文件才会绕过 storage 写路径，
  // 这正是 recordPulledChanges 存在的意义。因此这里不断言「无半条记录」。）

  // —— 重试：ORIG_HEAD 在无新提交时不移动，diff 重放同一批变更 ——
  const again = await gitSync.recordPulledChanges(VAULT);
  assert.ok(again.changedPaths.includes('c.md'));

  await deltaSync.waitForPendingWrites(VAULT);
  const cursorRetry = deltaSync.getLatestCursor(VAULT);
  assert.ok(cursorRetry > cursorAfter, '重试补录后游标推进');
  data = await deltaSync.getChanges(VAULT, Math.max(cursorAfter, 1), 500);
  assert.ok((data.updates || []).some((u) => u.path === 'c.md'), '重试后 UPSERT 可从增量通道重放');
});
