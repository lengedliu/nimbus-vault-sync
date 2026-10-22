const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
// 轻量 obsidian 运行时桩：让插件类可以在 node 下直接实例化，从而对
// 「云端忽略规则匹配 / 离线可靠删除 / 重命名回退 / 路径锁」等纯逻辑做回归。
// ---------------------------------------------------------------------------
const obsidianStub = {
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {
    constructor(message) {
      obsidianStub.lastNotice = String(message);
    }
  },
  TFile: class TFile {},
  TFolder: class TFolder {},
  Platform: { isMobile: false },
  arrayBufferToBase64: () => '',
  base64ToArrayBuffer: () => new ArrayBuffer(0),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};
const NimbusSyncPlugin = require(path.join(__dirname, '..', 'obsidian-plugin', 'main.js'));
Module._load = originalLoad;

if (!global.WebSocket) global.WebSocket = { OPEN: 1 };

function makePlugin({ wsReady = true } = {}) {
  const plugin = new NimbusSyncPlugin();
  plugin.settings = {
    serverUrl: 'http://127.0.0.1:1',
    token: 'test-token',
    authToken: '',
    vaultId: 'vault-test',
    deviceId: 'test-device',
    autoSync: false,
    syncConfigFolder: false,
    syncBaselines: {},
    syncCursors: {},
  };
  plugin.baselinesCache = { 'vault-test': {} };
  plugin.fileHashes = new Map();
  plugin.fileLocks = new Map();
  plugin.remoteIgnorePatterns = [];
  plugin.applyingRemotePaths = new Set();
  plugin.pendingLocalDeletes = new Set();
  plugin.pendingLocalQueueWhileBarrier = new Set();
  plugin.scheduleSaveBaselineCache = () => {};
  plugin.scheduleSaveSettings = () => {};
  plugin.ws = wsReady ? { readyState: 1, send() {} } : null;
  plugin.app = {
    vault: {
      configDir: '.obsidian',
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      adapter: null,
    },
  };
  return plugin;
}

async function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test('插件：云端忽略规则匹配 (matchIgnorePattern)', async (t) => {
  const plugin = makePlugin();

  await t.test('扩展名快捷写法命中任意目录', () => {
    assert.equal(plugin.matchIgnorePattern('temp.tmp', '*.tmp'), true);
    assert.equal(plugin.matchIgnorePattern('notes/deep/temp.TMP', '*.tmp'), true);
    assert.equal(plugin.matchIgnorePattern('notes/temp.md', '*.tmp'), false);
  });

  await t.test('目录通配 ** 与前缀匹配', () => {
    assert.equal(plugin.matchIgnorePattern('private/secret.md', 'private/**'), true);
    assert.equal(plugin.matchIgnorePattern('private', 'private/**'), false);
    assert.equal(plugin.matchIgnorePattern('a/b/c.md', '**/b/*.md'), true);
    assert.equal(plugin.matchIgnorePattern('b/c.md', '**/b/*.md'), true);
    assert.equal(plugin.matchIgnorePattern('a/b/c/deep.md', 'a/**/deep.md'), true);
  });

  await t.test('单字符通配 ? 只匹配一个字符', () => {
    assert.equal(plugin.matchIgnorePattern('notes/n1.md', 'notes/n?.md'), true);
    assert.equal(plugin.matchIgnorePattern('notes/n10.md', 'notes/n?.md'), false);
  });

  await t.test('Windows 反斜杠与空规则', () => {
    assert.equal(plugin.matchIgnorePattern('a\\b\\c.md', 'a/b/*.md'), true);
    assert.equal(plugin.matchIgnorePattern('/private/x.md', 'private/**'), true);
    assert.equal(plugin.matchIgnorePattern('notes/a.md', ''), false);
    assert.equal(plugin.matchIgnorePattern('notes/a.md', null), false);
  });
});

test('插件：服务端忽略规则接入 isIgnoredLocalPath', async (t) => {
  const plugin = makePlugin();

  await t.test('setRemoteIgnorePatterns 过滤非法值', () => {
    plugin.setRemoteIgnorePatterns(['*.tmp', '', '  ', 42, 'private/**']);
    assert.deepEqual(plugin.remoteIgnorePatterns, ['*.tmp', 'private/**']);
  });

  await t.test('非数组输入不覆盖已有规则', () => {
    plugin.setRemoteIgnorePatterns(undefined);
    assert.deepEqual(plugin.remoteIgnorePatterns, ['*.tmp', 'private/**']);
  });

  await t.test('命中云端规则的文件被视为忽略', () => {
    assert.equal(plugin.isIgnoredLocalPath('notes/x.tmp'), true);
    assert.equal(plugin.isIgnoredLocalPath('private/a.md'), true);
    assert.equal(plugin.isIgnoredLocalPath('notes/a.md'), false);
  });

  await t.test('本地强制忽略规则优先级不受影响', () => {
    assert.equal(plugin.isIgnoredLocalPath('.git/config'), true);
    assert.equal(plugin.isIgnoredLocalPath('.obsidian/workspace.json'), true);
    assert.equal(plugin.isIgnoredLocalPath('Thumbs.db'), true);
  });

  await t.test('syncConfigFolder 开启后其余 .obsidian/ 文件可同步', () => {
    const p2 = makePlugin();
    p2.settings.syncConfigFolder = true;
    assert.equal(p2.isIgnoredLocalPath('.obsidian/themes/custom.css'), false);
    p2.settings.syncConfigFolder = false;
    assert.equal(p2.isIgnoredLocalPath('.obsidian/themes/custom.css'), true);
  });
});

test('插件：isPathApplyingRemote 支持文件夹前缀判定', () => {
  const plugin = makePlugin();
  plugin.applyingRemotePaths.add('folder/a.md');

  assert.equal(plugin.isPathApplyingRemote('folder/a.md'), true);
  assert.equal(plugin.isPathApplyingRemote('folder/b.md'), false);
  assert.equal(plugin.isPathApplyingRemote('folder'), false);
  assert.equal(plugin.isPathApplyingRemote('folder', true), true);
  assert.equal(plugin.isPathApplyingRemote('', false), false);

  plugin.applyingRemotePaths.clear();
  assert.equal(plugin.isPathApplyingRemote('folder/a.md'), false);
});

test('插件：withLocalFileLock 同路径串行、不同路径互不阻塞', async (t) => {
  await t.test('同路径严格串行且锁表自动清理', async () => {
    const plugin = makePlugin();
    const order = [];
    const first = plugin.withLocalFileLock('x.md', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const second = plugin.withLocalFileLock('x.md', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
    assert.equal(plugin.fileLocks.size, 0);
  });

  await t.test('fn 抛错也会释放锁', async () => {
    const plugin = makePlugin();
    await assert.rejects(plugin.withLocalFileLock('y.md', async () => {
      throw new Error('boom');
    }), /boom/);
    assert.equal(plugin.fileLocks.size, 0);
    assert.equal(await plugin.withLocalFileLock('y.md', async () => 'ok'), 'ok');
  });
});

test('插件：deleteRemoteFile 的 ack / 离线 / HTTP 三条通道', async (t) => {
  await t.test('WS ack 成功后才抹除基线与内存哈希', async () => {
    const plugin = makePlugin();
    plugin.fileHashes.set('a.md', 'h1');
    plugin.updateBaselineEntry('vault-test', 'a.md', { hash: 'h1', mtime: 1, size: 1 });
    plugin.sendWsMessageAndWait = async (payload) => {
      assert.equal(payload.type, 'delete');
      assert.equal(payload.path, 'a.md');
      return { type: 'ack', action: 'delete', path: 'a.md', deleted: true };
    };

    assert.equal(await plugin.deleteRemoteFile('a.md'), true);
    assert.equal(plugin.fileHashes.has('a.md'), false);
    assert.equal(plugin.getVaultBaseline('vault-test')['a.md'], undefined);
    assert.equal(plugin.pendingLocalDeletes.size, 0);
  });

  await t.test('ack 未确认：保留基线、清 hash、挂起补发（防复活）', async () => {
    const plugin = makePlugin();
    plugin.fileHashes.set('b.md', 'h2');
    plugin.updateBaselineEntry('vault-test', 'b.md', { hash: 'h2', mtime: 1, size: 1 });
    plugin.sendWsMessageAndWait = async () => false;

    assert.equal(await plugin.deleteRemoteFile('b.md'), false);
    assert.equal(plugin.fileHashes.has('b.md'), false);
    assert.equal(plugin.getVaultBaseline('vault-test')['b.md'].hash, 'h2');
    assert.equal(plugin.pendingLocalDeletes.has('b.md'), true);
  });

  await t.test('完全离线：只清 hash，基线保留并挂起', async () => {
    const plugin = makePlugin({ wsReady: false });
    plugin.fileHashes.set('c.md', 'h3');
    plugin.updateBaselineEntry('vault-test', 'c.md', { hash: 'h3', mtime: 1, size: 1 });

    const ok = await withFetch(async () => {
      throw new Error('offline');
    }, () => plugin.deleteRemoteFile('c.md'));

    assert.equal(ok, false);
    assert.equal(plugin.fileHashes.has('c.md'), false);
    assert.equal(plugin.getVaultBaseline('vault-test')['c.md'].hash, 'h3');
    assert.equal(plugin.pendingLocalDeletes.has('c.md'), true);
  });

  await t.test('preferHttp：HTTP DELETE 成功并推进游标', async () => {
    const plugin = makePlugin({ wsReady: false });
    plugin.fileHashes.set('d.md', 'h4');
    plugin.updateBaselineEntry('vault-test', 'd.md', { hash: 'h4', mtime: 1, size: 1 });

    let seenUrl = '';
    const ok = await withFetch(async (url, init) => {
      seenUrl = String(url);
      assert.equal(init.method, 'DELETE');
      return { ok: true, status: 200, json: async () => ({ cursor: 42 }) };
    }, () => plugin.deleteRemoteFile('d.md', { preferHttp: true }));

    assert.equal(ok, true);
    assert.match(seenUrl, /\/api\/vaults\/vault-test\/files\/d\.md$/);
    assert.equal(plugin.getVaultCursor('vault-test'), 42);
    assert.equal(plugin.getVaultBaseline('vault-test')['d.md'], undefined);
    assert.equal(plugin.pendingLocalDeletes.size, 0);
  });

  await t.test('命中云端忽略规则的路径不发起请求', async () => {
    const plugin = makePlugin();
    plugin.setRemoteIgnorePatterns(['private/**']);
    let called = false;
    const ok = await withFetch(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }, () => plugin.deleteRemoteFile('private/x.md', { preferHttp: true }));

    assert.equal(ok, false);
    assert.equal(called, false);
  });
});

test('插件：renameRemoteFile 优先服务端 rename，失败回退 delete + push', async (t) => {
  await t.test('WS rename ack：清理旧路径哈希与基线', async () => {
    const plugin = makePlugin();
    plugin.fileHashes.set('old.md', 'h');
    plugin.updateBaselineEntry('vault-test', 'old.md', { hash: 'h', mtime: 1, size: 1 });
    plugin.sendWsMessageAndWait = async (payload) => {
      assert.equal(payload.type, 'rename');
      assert.equal(payload.oldPath, 'old.md');
      assert.equal(payload.newPath, 'new.md');
      assert.equal(payload.path, 'new.md');
      return { type: 'ack', action: 'rename', oldPath: 'old.md', path: 'new.md', hash: 'h' };
    };

    const ok = await plugin.renameRemoteFile('old.md', { path: 'new.md', stat: { mtime: 5, size: 1 } });
    assert.equal(ok, true);
    assert.equal(plugin.fileHashes.has('old.md'), false);
    assert.equal(plugin.getVaultBaseline('vault-test')['old.md'], undefined);
  });

  await t.test('WS 不可用时回退 delete(preferHttp) + push', async () => {
    const plugin = makePlugin({ wsReady: false });
    const calls = [];
    plugin.deleteRemoteFile = async (p, opts) => {
      calls.push(['delete', p, opts]);
      return true;
    };
    plugin.pushLocalFile = async (f) => {
      calls.push(['push', f.path]);
      return true;
    };

    const ok = await plugin.renameRemoteFile('old.md', { path: 'new.md', stat: {} });
    assert.equal(ok, true);
    assert.deepEqual(calls, [
      ['delete', 'old.md', { preferHttp: true }],
      ['push', 'new.md'],
    ]);
  });

  await t.test('新路径命中忽略规则等价于删除旧路径', async () => {
    const plugin = makePlugin();
    plugin.setRemoteIgnorePatterns(['private/**']);
    const calls = [];
    plugin.deleteRemoteFile = async (p) => {
      calls.push(p);
      return true;
    };
    plugin.pushLocalFile = async () => {
      throw new Error('不应推送被忽略的路径');
    };

    const ok = await plugin.renameRemoteFile('note.md', { path: 'private/note.md', stat: {} });
    assert.equal(ok, true);
    assert.deepEqual(calls, ['note.md']);
  });

  await t.test('空路径直接返回 false', async () => {
    const plugin = makePlugin();
    assert.equal(await plugin.renameRemoteFile('', { path: 'new.md' }), false);
    assert.equal(await plugin.renameRemoteFile('old.md', { path: '' }), false);
    assert.equal(await plugin.renameRemoteFile('same.md', { path: 'same.md' }), false);
  });
});

test('插件：队列辅助方法保证离线变更不丢失', async () => {
  const plugin = makePlugin();
  plugin.queuePendingLocalPush('a.md');
  plugin.queuePendingLocalPush('a.md');
  plugin.queuePendingLocalPush('');
  plugin.queuePendingLocalDelete('b.md');
  plugin.queuePendingLocalDelete(null);

  assert.deepEqual(Array.from(plugin.pendingLocalQueueWhileBarrier), ['a.md']);
  assert.deepEqual(Array.from(plugin.pendingLocalDeletes), ['b.md']);
});

// ---------------------------------------------------------------------------
// 覆盖防护 (applyRemoteBinaryChange)：远端版本覆盖本地文件前，
// 本地若有未推送的离线修改，必须先落 .conflict-offline-* 备份，防止静默丢改动。
// ---------------------------------------------------------------------------
function makeVaultStub(plugin, buffers) {
  const created = {};
  const modified = {};
  const fileFor = (p) => {
    const f = new obsidianStub.TFile();
    f.path = p;
    f.extension = p.split('/').pop().split('.').pop();
    f.stat = { mtime: 1, size: buffers[p] ? buffers[p].byteLength : 0 };
    return f;
  };
  plugin.app.vault = {
    configDir: '.obsidian',
    getFiles: () => Object.keys(buffers).filter((p) => !p.includes('conflict-offline')).map(fileFor),
    getAbstractFileByPath: (p) => (p && buffers[p] !== undefined ? fileFor(p) : null),
    readBinary: async (f) => buffers[f.path] || new ArrayBuffer(0),
    createBinary: async (p, buf) => { buffers[p] = buf; },
    modifyBinary: async (f, buf) => { buffers[f.path] = buf; },
    delete: async () => {},
    writeBinary: async (p, buf) => { buffers[p] = buf; },
  };
  return { created, modified, buffers, fileFor };
}

test('插件：远端覆盖防护在本地存在未推送修改时先备份', async (t) => {
  const enc = new TextEncoder();
  const sha = (bytes) => require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const remoteBytes = enc.encode('cloud version');
  const localBytes = enc.encode('offline edit');
  const putOpts = (hash) => ({ ok: true, status: 200, arrayBuffer: async () => remoteBytes.buffer.slice(remoteBytes.byteOffset, remoteBytes.byteOffset + remoteBytes.byteLength) });

  await t.test('本地有离线修改：先备份副本再覆盖，且备份经推送参与同步', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': localBytes.buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    // 基线是“上次已同步版本”，与本地当前内容不一致 → 判定存在未推送修改
    plugin.updateBaselineEntry('vault-test', 'p.md', { hash: sha(enc.encode('base version')), mtime: 1, size: 3 });
    const pushed = [];
    plugin.sendWsMessageAndWait = async (payload) => {
      pushed.push({ type: payload.type, path: payload.path });
      return { type: 'ack', action: 'push', path: payload.path, hash: 'x' };
    };

    const ok = await withFetch(() => Promise.resolve(putOpts()), () => plugin.pullRemoteFileViaHttp('p.md', 1, sha(remoteBytes)));
    assert.equal(ok, true);
    const backupPaths = Object.keys(buffers).filter((p) => p.includes('.conflict-offline-'));
    assert.equal(backupPaths.length, 1);
    assert.deepEqual(pushed, [{ type: 'push', path: backupPaths[0] }]);
    assert.equal(Buffer.from(buffers['p.md']).toString(), 'cloud version');
    assert.equal(plugin.getBaselineEntry('vault-test', 'p.md').hash, sha(remoteBytes));
  });

  await t.test('本地与基线一致：直接覆盖，不产生副本', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': enc.encode('base version').buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    plugin.updateBaselineEntry('vault-test', 'p.md', { hash: sha(enc.encode('base version')), mtime: 1, size: 3 });
    plugin.sendWsMessageAndWait = async () => { throw new Error('不应产生备份推送'); };

    const ok = await withFetch(() => Promise.resolve(putOpts()), () => plugin.pullRemoteFileViaHttp('p.md', 1, sha(remoteBytes)));
    assert.equal(ok, true);
    assert.equal(Object.keys(buffers).some((p) => p.includes('.conflict-offline-')), false);
    assert.equal(Buffer.from(buffers['p.md']).toString(), 'cloud version');
  });

  await t.test('3-Way 已备份（backupDone）：不再生成重复副本', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': localBytes.buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    plugin.sendWsMessageAndWait = async () => false;

    const ok = await plugin.applyRemoteBinaryChange('p.md', remoteBytes.buffer.slice(remoteBytes.byteOffset, remoteBytes.byteOffset + remoteBytes.byteLength), 1, sha(remoteBytes), { backupDone: true });
    assert.equal(ok, true);
    assert.equal(Object.keys(buffers).some((p) => p.includes('.conflict-offline-')), false);
  });

  await t.test('内容与其声明哈希不符：拒绝应用，不写盘也不建副本', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': enc.encode('base version').buffer.slice(0) };
    const { modified } = makeVaultStub(plugin, buffers);

    const ok = await withFetch(() => Promise.resolve(putOpts()), () => plugin.pullRemoteFileViaHttp('p.md', 1, 'deadbeef'));
    assert.equal(ok, false);
    assert.equal(Object.keys(modified).length, 0);
    assert.equal(Object.keys(buffers).some((p) => p.includes('.conflict-offline-')), false);
  });
});
