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

test('H-2: recordPulledChanges 支持显式 diffBase；durable 失败可按固化区间补放', async () => {
  const VAULT3 = 'gitpull-replay-vault';
  await gitSync.initRepo(VAULT3);
  const repoDir = vaults.vaultFilesRoot(VAULT3);
  const markerPath = path.join(repoDir, '..', 'git-sync-pending.json');
  const shaOf = (txt) => require('node:crypto').createHash('sha256').update(Buffer.from(txt)).digest('hex');

  storage.writeFile(VAULT3, 'p.md', Buffer.from('p0'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'c0']);
  const prePullHead = gitRun(repoDir, ['rev-parse', 'HEAD']);

  // c1（模拟 pull 引入的变更：p.md 更新为 p1）
  storage.writeFile(VAULT3, 'p.md', Buffer.from('p1'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'c1']);

  let failing = true;
  const realRecordBatch = deltaSync.recordBatchChanges.bind(deltaSync);
  deltaSync.recordBatchChanges = async (v, items) => {
    if (failing) throw new Error('delta down');
    return realRecordBatch(v, items);
  };
  try {
    // 1) 显式 diffBase 的记录失败 → 必须上抛
    try {
      await gitSync.recordPulledChanges(VAULT3, { diffBase: prePullHead });
      assert.fail('recordPulledChanges 失败必须上抛');
    } catch (err) {
      assert.ok(/delta down/.test(String(err.message)));
    }

    // 2) 固化区间；模拟 ORIG_HEAD 被 pull 重写（实测「已是最新」的 pull 也会重写）
    gitSync.markPendingPulledRange(VAULT3, prePullHead, gitRun(repoDir, ['rev-parse', 'HEAD']));
    assert.ok(fs.existsSync(markerPath), '固化标记写入 vaultRoot（files/ git 工作树之外）');
    gitRun(repoDir, ['update-ref', 'ORIG_HEAD', 'HEAD']);

    // 3) 按 ORIG_HEAD 的重放已不可能（diff 为空——与线上实测一致），
    //    但按固化区间补放成功、标记清除、记录可从增量通道重放
    failing = false;
    const rep = await gitSync.replayPendingPulledChanges(VAULT3);
    assert.ok(rep.replayed >= 1, '固化区间重放必须产生记录');
    assert.ok(!fs.existsSync(markerPath), '补放 durable 成功后标记必须清除');
    await deltaSync.waitForPendingWrites(VAULT3);
    const data = await deltaSync.getChanges(VAULT3, 1, 200);
    const p1 = shaOf('p1');
    assert.ok((data.updates || []).some((u) => u.path === 'p.md' && u.hash === p1), '缺失的 c1 变更已补进增量日志');
  } finally {
    deltaSync.recordBatchChanges = realRecordBatch;
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
  }
});

test('H-2: 固化区间 base 不可解析时弃用标记（3-Way 全量对账兜底）', async () => {
  const VAULT4 = 'gitpull-replay-drop-vault';
  await gitSync.initRepo(VAULT4);
  const repoDir = vaults.vaultFilesRoot(VAULT4);
  const markerPath = path.join(repoDir, '..', 'git-sync-pending.json');
  storage.writeFile(VAULT4, 'z.md', Buffer.from('z'));
  gitRun(repoDir, ['add', '-A']);
  gitRun(repoDir, ['commit', '-m', 'c0']);
  gitSync.markPendingPulledRange(VAULT4, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', gitRun(repoDir, ['rev-parse', 'HEAD']));
  assert.ok(fs.existsSync(markerPath));
  const rep = await gitSync.replayPendingPulledChanges(VAULT4);
  assert.equal(rep.replayed, 0);
  assert.equal(rep.dropped, true);
  assert.ok(!fs.existsSync(markerPath), '不可解析区间必须清除标记，避免永久卡死');
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
