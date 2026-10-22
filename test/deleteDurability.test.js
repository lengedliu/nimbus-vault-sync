const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-durability-'));

const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');

const VAULT_ID = 'durability-vault';

test('deleteFileAsync: 变更记录持久化失败必须向上抛出（durable 语义回归 W-1）', async () => {
  storage.writeFile(VAULT_ID, 'x.md', Buffer.from('content'));
  // 写入本身合法推进了游标（durable UPSERT），先等它持久化完成再取失效前基线
  await deltaSync.waitForPendingWrites(VAULT_ID);
  const baseCursor = deltaSync.getLatestCursor(VAULT_ID);

  const original = deltaSync.recordChange;
  deltaSync.recordChange = async () => {
    throw new Error('db down');
  };
  try {
    await assert.rejects(() => storage.deleteFileAsync(VAULT_ID, 'x.md'), /db down/);
  } finally {
    deltaSync.recordChange = original;
  }

  // 文件本身的删除动作已发生（回收站 + manifest 清理）：
  // 幂等重试收敛由 wsHub 的 completed = ok || !manifestEntry 保证（此处返回 false）
  assert.equal(await storage.deleteFileAsync(VAULT_ID, 'x.md'), false);

  // recordChange 抛出即未 durable：游标不得推进内存态
  assert.equal(deltaSync.getLatestCursor(VAULT_ID), baseCursor);
});

test('deleteFileAsync: 成功路径返回 true，DELETE 变更进入增量日志', async () => {
  storage.writeFile(VAULT_ID, 'y.md', Buffer.from('keep me'));
  assert.equal(await storage.deleteFileAsync(VAULT_ID, 'y.md'), true);

  // 重放该 DELETE 变更：下游设备能从 delta 通道收到删除（旧实现持久化失败时静默吞掉）
  // since 从 1 起（0 表示“从未同步”，服务端会直接要求全量快照）
  const data = await deltaSync.getChanges(VAULT_ID, 1, 500);
  assert.ok(
    (data.deletes || []).some((d) => d.path === 'y.md'),
    'DELETE 变更记录应已持久化并可从增量通道重放'
  );
});
