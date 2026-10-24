const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-wscursor-'));

const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');
const hub = require('../src/wsHub');

/**
 * 项 3 回归（游标竞态）：
 *  - 广播/ack 携带「该变更自身的游标」而非全局最新——客户端推进不会越过
 *    未接收到的变更（断线缺口由下次 init 增量重放补齐，而不是被对齐假象跳过）；
 *  - init 握手发出前不广播（ready 门），否则窗口内广播先于 init 到达，
 *    重连客户端把游标推进到最新，离线期间的变更被跳过；
 *  - message/close/error 监听在任何 await 之前注册（L5：旧实现 init 之后
 *    才注册，窗口内的客户端消息无人读取直接丢失）。
 */

const V1 = 'wscursor-vault';
const V2 = 'wshandshake-vault';

test('getLatestCursorForPath：返回该路径自身最近一条 durable 记录的游标；未知路径 null', async () => {
  storage.writeFile(V1, 'a.md', Buffer.from('a'));
  await deltaSync.waitForPendingWrites(V1);
  const cursorA = deltaSync.getLatestCursor(V1);
  assert.equal(deltaSync.getLatestCursorForPath(V1, 'a.md'), cursorA);

  // 其他路径的后续记录不影响 a.md 的自身游标
  storage.writeFile(V1, 'b.md', Buffer.from('b'));
  await deltaSync.waitForPendingWrites(V1);
  const latest = deltaSync.getLatestCursor(V1);
  assert.equal(deltaSync.getLatestCursorForPath(V1, 'a.md'), cursorA, 'a.md 自身游标不被 b.md 推进');
  assert.equal(deltaSync.getLatestCursorForPath(V1, 'b.md'), latest);

  assert.equal(deltaSync.getLatestCursorForPath(V1, 'unknown.md'), null, 'ring 未记录的路径返回 null（广播省略 cursor 字段）');

  // 删除后返回 DELETE 记录自身游标
  await storage.deleteFileAsync(V1, 'a.md');
  await deltaSync.waitForPendingWrites(V1);
  assert.equal(deltaSync.getLatestCursorForPath(V1, 'a.md'), deltaSync.getLatestCursor(V1));
});

test('broadcastFileChange/Delete：携带自身游标；未 ready 的客户端不接收广播', async () => {
  storage.writeFile(V1, 'c.md', Buffer.from('inline content'));
  await deltaSync.waitForPendingWrites(V1);
  const ownCursor = deltaSync.getLatestCursorForPath(V1, 'c.md');
  assert.equal(typeof ownCursor, 'number');

  const sends = [];
  const client = {
    ws: { readyState: 1, OPEN: 1, send: (s) => sends.push(JSON.parse(s)) },
    userId: 1,
    ready: false, // 🛡️ init 握手未发出的客户端
  };
  hub.rooms.set(V1, new Set([client]));

  try {
    // 未 ready：内容是刚写 durable 的文件，但握手窗口内不广播
    hub.broadcastFileChange(V1, 'c.md', { currentHash: 'h' }, 1);
    assert.equal(sends.length, 0, 'init 握手发出前不得广播（防伪对齐）');

    // ready 之后接收广播，且 cursor = 该变更自身的游标
    client.ready = true;
    hub.broadcastFileChange(V1, 'c.md', { currentHash: 'h' }, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].cursor, ownCursor, 'inline 广播携带自身游标而非全局最新');

    sends.length = 0;
    await storage.deleteFileAsync(V1, 'c.md');
    await deltaSync.waitForPendingWrites(V1);
    const delCursor = deltaSync.getLatestCursorForPath(V1, 'c.md');
    hub.broadcastFileDelete(V1, 'c.md', 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].type, 'deleted');
    assert.equal(sends[0].cursor, delCursor, '删除广播携带 DELETE 记录自身的游标');
  } finally {
    hub.rooms.delete(V1);
  }
});

test('_onConnection：message/close/error 监听在任何 await 之前注册；init 发出后 client.ready 置位', async () => {
  const listeners = [];
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    on: (ev) => { listeners.push(ev); },
    send: (s) => sent.push(JSON.parse(s)),
  };

  // 不 await：init 之前的同步段必须已完成监听注册
  const connPromise = hub._onConnection(
    ws,
    { id: 'u1', username: 'u1' },
    V2,
    { deviceId: 'd-test', deviceName: 'probe' },
    'read-write',
    {}
  );

  assert.ok(listeners.includes('message'), 'message 监听在任何 await 之前注册（窗口内客户端消息不再丢失）');
  assert.ok(listeners.includes('close'));
  assert.ok(listeners.includes('error'));
  await connPromise;

  const initMsg = sent.find((m) => m.type === 'init');
  assert.ok(initMsg, '握手包已发送');
  assert.equal(typeof initMsg.cursor, 'number');
});
