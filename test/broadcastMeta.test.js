const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-bcast-'));

const storage = require('../src/storage');
const hub = require('../src/wsHub');

const VAULT = 'bcast-vault';

function openRoom() {
  const sents = [];
  const client = {
    ws: { readyState: 1, OPEN: 1, send: (s) => sents.push(JSON.parse(s)) },
    userId: 1,
  };
  hub.rooms.set(VAULT, new Set([client]));
  return {
    sents,
    close: () => hub.rooms.delete(VAULT),
  };
}

function watchReads() {
  let reads = 0;
  const original = storage.readFile;
  storage.readFile = (...args) => {
    reads++;
    return original(...args);
  };
  return { get: () => reads, restore: () => { storage.readFile = original; } };
}

test('broadcastFileChange: 大文件广播绝不再同步整读盘 (C-3)', async (t) => {
  await t.test('调用方缺 size 元数据（冲突广播形状）：走内存 manifest，O(1) 判级', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 64, 7); // > 2MB 阈值
    storage.writeFile(VAULT, 'big.md', big);

    const room = openRoom();
    const { get, restore } = watchReads();
    let change;
    try {
      // conflicts.js / MCP 冲突广播的真实形状：只带 currentHash，没有 size/mtime
      hub.broadcastFileChange(VAULT, 'big.md', { currentHash: 'hash-big' }, 1);
      change = room.sents.find((m) => m.type === 'change' && m.path === 'big.md');
    } finally {
      restore();
      room.close();
    }

    assert.equal(get(), 0, '缺 size 的广播不得把整个文件读进内存');
    assert.ok(change, '仍应通知客户端');
    assert.equal(change.pullRequired, true, '超大文件走 metadata + pullRequired');
    assert.equal(change.size, big.length);
    assert.equal(change.hash, 'hash-big');
  });

  await t.test('manifest 条目缺失：降级 statSync 取元数据（仍不读内容）', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 128, 9);
    storage.writeFile(VAULT, 'big2.md', big);

    const room = openRoom();
    const originalEntry = storage.getManifestEntry;
    storage.getManifestEntry = () => null; // 模拟缓存冷启动 / 竞态窗口
    const { get, restore } = watchReads();
    let change;
    try {
      // 批量恢复（broadcastBatchFileChange）的真实形状：result = {}
      hub.broadcastFileChange(VAULT, 'big2.md', {}, 1);
      change = room.sents.find((m) => m.type === 'change' && m.path === 'big2.md');
    } finally {
      restore();
      storage.getManifestEntry = originalEntry;
      room.close();
    }

    assert.equal(get(), 0, 'statSync 降级路径也不得整读文件');
    assert.ok(change);
    assert.equal(change.pullRequired, true);
    assert.equal(change.size, big.length);
  });

  await t.test('小文件：维持 inline 内容广播的原语义', () => {
    storage.writeFile(VAULT, 'small.md', Buffer.from('tiny content'));

    const room = openRoom();
    let change;
    try {
      hub.broadcastFileChange(VAULT, 'small.md', {}, 1);
      change = room.sents.find((m) => m.type === 'change' && m.path === 'small.md');
    } finally {
      room.close();
    }

    assert.ok(change);
    assert.equal(change.pullRequired, undefined, '小文件仍直接携带内容');
    assert.equal(Buffer.from(change.content, 'base64').toString(), 'tiny content');
  });

  await t.test('文件不存在：与旧语义一致静默返回，不产生广播', () => {
    const room = openRoom();
    const originalEntry = storage.getManifestEntry;
    storage.getManifestEntry = () => null;
    try {
      hub.broadcastFileChange(VAULT, 'ghost.md', {}, 1);
    } finally {
      storage.getManifestEntry = originalEntry;
      room.close();
    }

    assert.equal(room.sents.length, 0, '元数据全空（文件不存在）不得崩溃也不广播');
  });
});
