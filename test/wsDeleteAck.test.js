const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-wsack-'));

const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');
const hub = require('../src/wsHub');

const VAULT_ID = 'wsack-vault';

function makeClient(sents) {
  return {
    ws: {
      readyState: 1,
      OPEN: 1,
      send: (s) => sents.push(JSON.parse(s)),
    },
    userId: 1,
    username: 'tester',
    deviceName: 'wsack-test',
    token: null,
  };
}

test('wsHub delete：只回一条含 deleted+cursor 的终态 ack (C-1)', async () => {
  const sents = [];
  const client = makeClient(sents);
  storage.writeFile(VAULT_ID, 'gone.md', Buffer.from('delete me'));

  await hub._onMessage(client, VAULT_ID, JSON.stringify({ type: 'delete', path: 'gone.md' }));

  const acks = sents.filter((m) => m.type === 'ack' && m.action === 'delete');
  // 🛡️ 旧实现回两条 ack：首条缺失 deleted 字段——插件侧 `msg.deleted !== false`
  // 会把失败终态误读成成功并提前终结 sendWsMessageAndWait
  assert.equal(acks.length, 1, '应只回一条终态 ack');
  assert.equal(acks[0].path, 'gone.md');
  assert.equal(acks[0].deleted, true);
  assert.equal(typeof acks[0].cursor, 'number');
  assert.equal(acks[0].cursor, deltaSync.getLatestCursor(VAULT_ID));

  // DELETE 变更已 durable：可从增量通道重放
  const data = await deltaSync.getChanges(VAULT_ID, 1, 500);
  assert.ok((data.deletes || []).some((d) => d.path === 'gone.md'));
});

test('wsHub delete：幂等终态（服务端本无此文件）同样单条 ack 携带 completed', async () => {
  const sents = [];
  const client = makeClient(sents);

  // 从未存在 → deleteFileAsync false，但 completed = ok || !manifestEntry = true
  await hub._onMessage(client, VAULT_ID, JSON.stringify({ type: 'delete', path: 'never-existed.md' }));

  const acks = sents.filter((m) => m.type === 'ack' && m.action === 'delete');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].deleted, true);
});

test('wsHub delete：黑名单路径回 ignored 终态 ack（不产生变更记录）', async () => {
  const syncRules = require('../src/syncRules');
  syncRules.saveRules(VAULT_ID, { ignorePatterns: ['secret*'] });

  const sents = [];
  const client = makeClient(sents);

  await hub._onMessage(client, VAULT_ID, JSON.stringify({ type: 'delete', path: 'secret.md' }));

  const acks = sents.filter((m) => m.type === 'ack' && m.action === 'delete');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ignored, true);
  assert.equal(acks[0].deleted, true);
});
