const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-deltareplay-'));

const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');

const VAULT_1 = 'dedupe-vault';
const VAULT_2 = 'gap-repair-vault';

/**
 * H-2 回归：持久化失败后的重试不再丟失变更记录。
 * 背景：writeFile / writeFileFromPath 的「内容相同」早退分支与 deleteFileAsync
 * 的「文件不存在」早退分支都不再补记——重试永远补不回 UPSERT/DELETE，
 * delta-only 设备永久缺这批变更。
 */

test('dedupeLatest 语义：相同内容跳过、新内容补记、DELETE 后重复删除幂等', async () => {
  storage.writeFile(VAULT_1, 'doc.md', Buffer.from('v0'));
  await deltaSync.waitForPendingWrites(VAULT_1);
  const c1 = deltaSync.getLatestCursor(VAULT_1);

  // 相同内容重试（未变内容）：dedupeLatest 跳过 → 游标不推进、增量日志不膨胀
  storage.writeFile(VAULT_1, 'doc.md', Buffer.from('v0'));
  await deltaSync.waitForPendingWrites(VAULT_1);
  assert.equal(deltaSync.getLatestCursor(VAULT_1), c1, '相同内容的重复推送不得新增记录');

  // 新内容：正常记录
  storage.writeFile(VAULT_1, 'doc.md', Buffer.from('v1'));
  await deltaSync.waitForPendingWrites(VAULT_1);
  assert.ok(deltaSync.getLatestCursor(VAULT_1) > c1, '内容变化必须记录');

  // 删除后再次删除（文件已不存在）：幂等跳过
  assert.equal(await storage.deleteFileAsync(VAULT_1, 'doc.md'), true);
  await deltaSync.waitForPendingWrites(VAULT_1);
  const afterDel = deltaSync.getLatestCursor(VAULT_1);
  assert.equal(await storage.deleteFileAsync(VAULT_1, 'doc.md'), true);
  await deltaSync.waitForPendingWrites(VAULT_1);
  assert.equal(deltaSync.getLatestCursor(VAULT_1), afterDel, '重复删除不得新增记录');
});

test('durable 断层补录：持久化失败后重试相同内容，UPSERT 被补进增量日志', async () => {
  // 稳定基线：v0 正常 durable
  storage.writeFile(VAULT_2, 'gap.md', Buffer.from('v0'));
  await deltaSync.waitForPendingWrites(VAULT_2);
  // （避免 off-by-one：since=1 恰为最新游标时分页返回空，v0 记录靠 ring/durable 语义由下一阶段断言覆盖）

  // 注入持久化失败：失败发生在队列任务内部（_persistChange），与真实
  // DB 抖动同型——磁盘写下 v1，delta 记录失败（即「断层」现场）。
  const realPersistChange = deltaSync._persistChange.bind(deltaSync);
  let failNext = false;
  deltaSync._persistChange = async (v, item) => {
    if (failNext) throw new Error('delta persist down');
    return realPersistChange(v, item);
  };
  try {
    failNext = true;
    storage.writeFile(VAULT_2, 'gap.md', Buffer.from('v1'));
    await assert.rejects(() => deltaSync.waitForPendingWrites(VAULT_2), /delta persist down/);
  } finally {
    deltaSync._persistChange = realPersistChange;
  }

  // 现场等价于用户场景：磁盘内容已是 v1、增量日志停在 v0。
  // 旧实现：客户端重推 v1 → 内容相同早退 → delta 永远缺 v1。
  // 修复后：dedupeLatest 发现最近 durable 记录（v0）≠ v1 → 补记。
  await storage.writeFileAsync(VAULT_2, 'gap.md', Buffer.from('v1'), {});
  await deltaSync.waitForPendingWrites(VAULT_2);

  const data1 = await deltaSync.getChanges(VAULT_2, 1, 100);
  const v1Recs = (data1.updates || []).filter((u) => u.path === 'gap.md' && u.hash);
  const v1 = require('node:crypto').createHash('sha256').update(Buffer.from('v1')).digest('hex');
  assert.ok(v1Recs.some((u) => u.hash === v1), '重试必须把缺失的 UPSERT 补进增量日志');
});
