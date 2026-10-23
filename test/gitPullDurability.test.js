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

test('gitSync.recordPulledChanges: 删除路径进 deletePaths 并广播 deleted、黑名单路径被过滤 (E-1/E-2)', async () => {
  const vaults = require('../src/vaults');
  const syncRules = require('../src/syncRules');
  const hub = require('../src/wsHub');
  const VAULT2 = 'gitpull-delete-vault';

  await gitSync.initRepo(VAULT2);
  const repoDir = vaults.vaultFilesRoot(VAULT2);

  storage.writeFile(VAULT2, 'gone.md', Buffer.from('to be removed'));
  storage.writeFile(VAULT2, 'secret.md', Buffer.from('never synced'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'v1']);

  // v2：删除 gone.md、新增 secret2.md（命中黑名单，diff 会同时出现 A/D 两类）
  syncRules.saveRules(VAULT2, { ignorePatterns: ['secret2.md'] });
  fs.unlinkSync(path.join(repoDir, 'gone.md'));
  fs.writeFileSync(path.join(repoDir, 'secret2.md'), Buffer.from('ignored by rules'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'v2']);

  // ORIG_HEAD=v1（模拟 pull 把 HEAD 从 v1 推进到 v2）
  gitRun(repoDir, ['update-ref', 'ORIG_HEAD', 'HEAD~1']);

  await deltaSync.waitForPendingWrites(VAULT2);
  const cursorBefore = deltaSync.getLatestCursor(VAULT2);

  const res = await gitSync.recordPulledChanges(VAULT2);
  assert.deepEqual(res.deletePaths, ['gone.md'], '删除路径必须进 deletePaths（E-1）');
  assert.deepEqual(res.changedPaths, [], 'secret2.md 命中黑名单不得进入同步域（E-2）');

  await deltaSync.waitForPendingWrites(VAULT2);
  const data = await deltaSync.getChanges(VAULT2, Math.max(cursorBefore, 1), 500);
  assert.ok((data.deletes || []).some((d) => d.path === 'gone.md'), 'DELETE 变更 durable 且可重放');
  assert.ok(!(data.updates || []).some((u) => u.path === 'secret2.md'), '黑名单新增不得记录 delta');

  // E-1 广播契约：UPSERT 走 change/deleted 各自通道，删除路径必须产生 'deleted' 事件
  const sents = [];
  const client = { ws: { readyState: 1, OPEN: 1, send: (s) => sents.push(JSON.parse(s)) }, userId: 1 };
  hub.rooms.set(VAULT2, new Set([client]));
  try {
    gitSync.broadcastPulledChanges(VAULT2, res);
    const deletedMsg = sents.find((m) => m.type === 'deleted' && m.path === 'gone.md');
    assert.ok(deletedMsg, '删除路径必须广播 deleted（否则在线客户端游标越过未应用删除）');
    assert.equal(typeof deletedMsg.cursor, 'number');
    assert.ok(!sents.some((m) => m.type === 'change' && m.path === 'secret2.md'), '黑名单路径不得广播 change');
  } finally {
    hub.rooms.delete(VAULT2);
  }
});

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
