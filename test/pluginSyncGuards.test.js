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
  plugin.pendingLocalRenames = new Map();
  plugin.localChangeQueue = new Map();
  plugin.pendingLocalQueueWhileBarrier = new Set();
  plugin.scheduleSaveBaselineCache = () => {};
  plugin.scheduleSaveSettings = () => {};
  plugin.saveData = async () => {};
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

test('插件：WS push 冲突 ack 为终态，不伪造基线也不进补推队列', async () => {
  const plugin = makePlugin();
  const initialContent = 'old cloud content';
  const bytes = new TextEncoder().encode(initialContent);
  const buffers = { 'p.md': bytes.buffer.slice(0) };
  makeVaultStub(plugin, buffers);

  // 冲突场景：本地内容与基线一致（已同步），事后基线仍不变且本地文件不再被动 —— 即不做任何登记
  plugin.updateBaselineEntry('vault-test', 'p.md', { hash: 'base-hash', mtime: 1, size: bytes.byteLength });
  let pushedMsg = null;
  plugin.sendWsMessageAndWait = async (payload) => {
    pushedMsg = payload;
    // 模拟真实 sendWsMessageAndWait：注册 pending ack，随后由服务端消息终结等待
    if (!plugin.pendingSyncAcks) plugin.pendingSyncAcks = new Map();
    return new Promise((resolve) => {
      plugin.pendingSyncAcks.set(`${payload.type}:${payload.path}`, { resolve });
      // 模拟服务端返回冲突终态 ack（不带 hash，带 conflict 路径）
      setTimeout(() => {
        plugin.handleServerMessage({ type: 'ack', action: 'push', path: payload.path, conflict: 'p.conflict-offline-1.md', cursor: 9 }).catch(() => {});
      }, 0);
    });
  };

  const ok = await plugin.pushLocalFile(Object.assign(new obsidianStub.TFile(), { path: 'p.md', extension: 'md', stat: { mtime: 1, size: bytes.byteLength } }));
  assert.equal(ok, true, '冲突终态 ack 应让 pushLocalFile 正常完成');
  assert.equal(pushedMsg.type, 'push');

  // 不伪造基线：云端主路径内容（旧实现若把 hash 写回会造成伪对齐）未被登记
  assert.equal(plugin.getBaselineEntry('vault-test', 'p.md').hash, 'base-hash');
  // 不进补推队列
  assert.equal(plugin.pendingLocalQueueWhileBarrier.size, 0);
});

test('插件：广播失败冻结游标推进，init 后恢复并按 ack 记账最新游标 (W-2/W-3)', async (t) => {
  await t.test('change 应用失败 → 冻结；冻结期内哈希命中跳过分支也不推进', async () => {
    const plugin = makePlugin();
    plugin.pullRemoteFileViaHttp = async () => false;
    await plugin.handleServerMessage({ type: 'change', path: 'a.md', cursor: 5, pullRequired: true });
    assert.equal(plugin._cursorGapBlocked, true);
    assert.equal(plugin.getVaultCursor('vault-test'), 0);

    // 冻结期内自反回声（hash 命中）也不得推进，否则两次 init 之间形成游标对齐假象
    plugin.fileHashes.set('b.md', 'same');
    await plugin.handleServerMessage({ type: 'change', path: 'b.md', hash: 'same', cursor: 6 });
    assert.equal(plugin.getVaultCursor('vault-test'), 0);
  });

  await t.test('init 解除冻结后自反回声正常推进（pull_stream/deleted 同语义）', async () => {
    const plugin = makePlugin();
    plugin._cursorGapBlocked = false; // init 后状态
    plugin.fileHashes.set('b.md', 'same');
    await plugin.handleServerMessage({ type: 'change', path: 'b.md', hash: 'same', cursor: 6 });
    assert.equal(plugin.getVaultCursor('vault-test'), 6);

    plugin.applyRemoteDelete = async () => false;
    await plugin.handleServerMessage({ type: 'deleted', path: 'c.md', cursor: 9 });
    assert.equal(plugin._cursorGapBlocked, true);
    assert.equal(plugin.getVaultCursor('vault-test'), 6);

    plugin._cursorGapBlocked = false;
    plugin.pullRemoteFileViaHttp = async (p) => (p === 'big.md' ? true : false);
    await plugin.handleServerMessage({ type: 'pull_stream', path: 'big.md', hash: 'x', cursor: 12 });
    assert.equal(plugin.getVaultCursor('vault-test'), 12);
  });

  await t.test('ack 附带 cursor 记账 _lastServerCursorSeen（单调取大）', async () => {
    const plugin = makePlugin();
    await plugin.handleServerMessage({ type: 'ack', action: 'push', path: 'p.md', hash: 'h', cursor: 42 });
    await plugin.handleServerMessage({ type: 'ack', action: 'push', path: 'q.md', hash: 'h2', cursor: 41 });
    assert.equal(plugin._lastServerCursorSeen['vault-test'], 42);
  });

  await t.test('batch 应用失败 → 冻结；全部成功才推进', async () => {
    const plugin = makePlugin();
    plugin.applyRemoteDelete = async () => true;
    plugin.pullRemoteFileViaHttp = async (p) => (p === 'fail.md' ? false : true);
    await plugin.handleServerMessage({
      type: 'batch_file_change',
      cursor: 20,
      changes: [
        { action: 'delete', path: 'd.md' },
        { action: 'update', path: 'fail.md' },
      ],
    });
    assert.equal(plugin._cursorGapBlocked, true);
    assert.equal(plugin.getVaultCursor('vault-test'), 0);
  });
});

test('插件：远端写盘其他路径时用户真实事件不再被全局吞掉 (R-3)', async (t) => {
  await t.test('onLocalFileChange 按路径精确抑制', () => {
    const plugin = makePlugin();
    plugin.isVaultReady = true;
    plugin.isApplyingRemoteChange = true; // 旧全局门下的抑制窗口
    plugin.applyingRemotePaths.add('remote.md');
    const userFile = new obsidianStub.TFile();
    userFile.path = 'user-edit.md';
    userFile.extension = 'md';
    userFile.stat = { mtime: 1, size: 3 };

    plugin.onLocalFileChange('create', userFile);
    // 事件进入防抖队列而不是被吞掉
    assert.equal(plugin.localChangeQueue.has('user-edit.md'), true);
    clearTimeout(plugin.localChangeQueue.get('user-edit.md'));
    plugin.localChangeQueue.delete('user-edit.md');

    // 本路径自身的回声仍被精确拦截
    plugin.applyingRemotePaths.add('user-edit.md');
    plugin.onLocalFileChange('create', userFile);
    clearTimeout(plugin.localChangeQueue.get('user-edit.md'));
    plugin.localChangeQueue.delete('user-edit.md');
    assert.equal(plugin.localChangeQueue.has('user-edit.md'), false);
  });

  await t.test('onLocalFileDelete 屏障期远端删除回声不入挂起队列', () => {
    const plugin = makePlugin();
    plugin.isVaultReady = true;
    plugin.syncBarrierActive = true;
    plugin.applyingRemotePaths.add('echo.md');
    const f = new obsidianStub.TFile();
    f.path = 'echo.md';
    f.extension = 'md';
    plugin.onLocalFileDelete(f);
    assert.equal(plugin.pendingLocalDeletes.size, 0);
  });
});

test('插件：大文件 PUT 终态失败不进补推队列，临时失败保持重试 (W-4)', async (t) => {
  const bigBytes = new Uint8Array(2 * 1024 * 1024 + 16); // > 2MB，走 HTTP PUT 通道
  const bigBuffer = bigBytes.buffer;
  const fakeFile = () => Object.assign(new obsidianStub.TFile(), {
    path: 'big.md',
    extension: 'md',
    stat: { mtime: 1, size: bigBuffer.byteLength },
  });

  await t.test('413 超出服务端上限：不挂起（终态）', async () => {
    const plugin = makePlugin();
    makeVaultStub(plugin, { 'big.md': bigBuffer });
    const ok = await withFetch(() => Promise.resolve({ ok: false, status: 413 }), () => plugin.pushLocalFile(fakeFile()));
    assert.equal(ok, false);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.size, 0);
  });

  await t.test('403 权限无效：不挂起（终态）', async () => {
    const plugin = makePlugin();
    makeVaultStub(plugin, { 'big.md': bigBuffer });
    const ok = await withFetch(() => Promise.resolve({ ok: false, status: 403 }), () => plugin.pushLocalFile(fakeFile()));
    assert.equal(ok, false);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.size, 0);
  });

  await t.test('500 临时失败：保持挂起重试', async () => {
    const plugin = makePlugin();
    makeVaultStub(plugin, { 'big.md': bigBuffer });
    const ok = await withFetch(() => Promise.resolve({ ok: false, status: 500 }), () => plugin.pushLocalFile(fakeFile()));
    assert.equal(ok, false);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.has('big.md'), true);
  });
});

test('插件：屏障期重命名/目录删除记录补发而非丢弃', async (t) => {
  await t.test('屏障期 rename 进入挂起队列并在收尾补发', async () => {
    const plugin = makePlugin();
    plugin.syncBarrierActive = true;
    plugin.isVaultReady = true;
    const file = new obsidianStub.TFile();
    file.path = 'new-name.md';
    file.extension = 'md';
    file.stat = { mtime: 1, size: 5 };

    plugin.app.vault.getAbstractFileByPath = (p) => (p === 'new-name.md' ? file : null);
    plugin.onLocalFileRename(file, 'old-name.md');
    assert.equal(plugin.pendingLocalRenames.get('old-name.md'), 'new-name.md');

    // 收尾补发：走 renameRemoteFile（打桩记录）
    const calls = [];
    plugin.renameRemoteFile = async (oldP, target) => {
      calls.push([oldP, target.path]);
      return true;
    };
    await plugin.flushPendingLocalRenames();
    assert.deepEqual(calls, [['old-name.md', 'new-name.md']]);
    assert.equal(plugin.pendingLocalRenames.size, 0);
  });

  await t.test('目标再次消失/旧路径仍在：过期记录跳过', async () => {
    const plugin = makePlugin();
    plugin.queuePendingLocalRename('a.md', 'b.md');
    const calls = [];
    plugin.renameRemoteFile = async (...args) => { calls.push(args); return true; };

    // 目标 b.md 不存在 → 过期
    await plugin.flushPendingLocalRenames();
    assert.deepEqual(calls, []);
    // 旧路径又回来了（重新创建 a.md，b.md 也在）→ 过期
    plugin.queuePendingLocalRename('a.md', 'b.md');
    const fA = new obsidianStub.TFile(); fA.path = 'a.md'; fA.extension = 'md';
    const fB = new obsidianStub.TFile(); fB.path = 'b.md'; fB.extension = 'md';
    plugin.app.vault.getAbstractFileByPath = (p) => (p === 'a.md' ? fA : (p === 'b.md' ? fB : null));
    await plugin.flushPendingLocalRenames();
    assert.deepEqual(calls, []);
    assert.equal(plugin.pendingLocalRenames.size, 0);
  });

  await t.test('屏障期目录删除逐个挂起，超大目录触发熔断', async () => {
    const plugin = makePlugin();
    plugin.syncBarrierActive = true;
    plugin.isVaultReady = true;
    for (let i = 0; i < 5; i++) plugin.fileHashes.set(`dir/f${i}.md`, `h${i}`);
    const folder = new obsidianStub.TFolder();
    folder.path = 'dir';

    plugin.onLocalFileDelete(folder);
    assert.deepEqual(Array.from(plugin.pendingLocalDeletes), ['dir/f0.md', 'dir/f1.md', 'dir/f2.md', 'dir/f3.md', 'dir/f4.md']);

    // 超阈值：>10 且 >= 总哈希 40%
    const bigVault = makePlugin();
    bigVault.syncBarrierActive = true;
    for (let i = 0; i < 20; i++) bigVault.fileHashes.set(`big/f${i}.md`, `h${i}`);
    const bigFolder = new obsidianStub.TFolder();
    bigFolder.path = 'big';
    bigVault.onLocalFileDelete(bigFolder);
    assert.equal(bigVault.pendingLocalDeletes.size, 0);
  });
});

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

test('插件：基线条目保留 ignored 标记 (W-9)', async (t) => {
  await t.test('ignored 条目不丢标记（3-Way 场景 2 删除判定依赖它）', () => {
    const plugin = makePlugin();
    plugin.updateBaselineEntry('vault-test', 'x.md', { hash: 'h', mtime: 1, size: 2, ignored: true });
    const entry = plugin.getBaselineEntry('vault-test', 'x.md');
    assert.equal(entry.ignored, true);
    assert.equal(entry.hash, 'h');
  });

  await t.test('常规条目保持基线形状干净（不带 ignored 字段）', () => {
    const plugin = makePlugin();
    plugin.updateBaselineEntry('vault-test', 'y.md', { hash: 'h2', mtime: 2, size: 3 });
    const entry = plugin.getBaselineEntry('vault-test', 'y.md');
    assert.equal(entry.ignored, undefined);
    assert.equal(entry.hash, 'h2');
  });
});

test('插件：_conflictRestorePaths 一次性期待集的消费纪律 (R-B)', async (t) => {
  const crypto = require('node:crypto');
  const sha = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
  const enc = new TextEncoder();

  await t.test('backupDone=true 不再把标记泄漏到未来无关的同路径拉取', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': enc.encode('local unsynced edit').buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    plugin._conflictRestorePaths = new Set(['p.md']);

    const incoming = enc.encode('cloud version one');
    const ok = await plugin.applyRemoteBinaryChange('p.md', incoming.buffer.slice(0), 5, sha(incoming), { backupDone: true });
    assert.equal(ok, true);
    // 🛡️ 旧实现在 TFile 分支 backupDone===true 短路，标记从不被消费——
    // 残留到未来某次无关的同路径拉取会让那次的覆盖防护被静默跳过
    assert.equal(plugin._conflictRestorePaths.size, 0, 'backupDone 短路也必须消费一次性标记');
  });

  await t.test('非 TFile 分支（adapter-only）同样消费标记', async () => {
    const plugin = makePlugin();
    makeVaultStub(plugin, {});
    plugin.app.vault.adapter = {
      exists: async (p) => p === '.obsidian/app.json',
      writeBinary: async () => {},
    };
    plugin._conflictRestorePaths = new Set(['.obsidian/app.json']);

    const content = enc.encode('{}');
    const ok = await plugin.applyRemoteBinaryChange('.obsidian/app.json', content.buffer.slice(0), 1, sha(content), {});
    assert.equal(ok, true);
    assert.equal(plugin._conflictRestorePaths.size, 0, 'adapter 分支不应泄漏标记');
  });

  await t.test('内容哈希校验拒绝写入时保留标记（重试拉取仍带完整防护）', async () => {
    const plugin = makePlugin();
    const buffers = { 'p.md': enc.encode('local unsynced edit').buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    plugin._conflictRestorePaths = new Set(['p.md']);

    const tampered = enc.encode('tampered payload');
    const ok = await plugin.applyRemoteBinaryChange('p.md', tampered.buffer.slice(0), 5, 'not-the-real-hash', {});
    assert.equal(ok, false);
    assert.equal(plugin._conflictRestorePaths.size, 1, '校验失败不得消费标记');
    assert.equal(buffers['p.md'].byteLength, enc.encode('local unsynced edit').buffer.byteLength, '未触碰磁盘');
  });
});

test('插件：serverWin 终态 ack 立即终结推送等待 (D-2)', async () => {
  const plugin = makePlugin();
  plugin.pendingSyncAcks = new Map();

  // sendWsMessageAndWait 的真实等待面：pending 注册后由服务端消息终结
  const waiter = new Promise((resolve) => {
    plugin.pendingSyncAcks.set('push:p.md', { resolve: (ok, msg) => resolve(ok ? msg : false) });
  });

  // 服务端顺序：conflict 通知(serverWin) + D-2 新增的终态 ack（不带 hash）
  await plugin.handleServerMessage({ type: 'conflict', path: 'p.md', serverWin: true, currentHash: 'srv' });
  await plugin.handleServerMessage({ type: 'ack', action: 'push', path: 'p.md', conflict: true, currentHash: 'srv', cursor: 11 });

  const result = await Promise.race([waiter, new Promise((r) => setTimeout(() => r(null), 200))]);
  assert.ok(result, 'serverWin 的终态 ack 应立即终结推送等待（不白等 15s）');
  assert.equal(result.conflict, true, 'pushLocalFile 依赖 result.conflict 判定终态（不进补推队列）');
  assert.equal(plugin._lastServerCursorSeen['vault-test'], 11);
});

test('插件：3-Way 冲突备份的后透传语义——仅成功路径带 backupDone (A2)', async (t) => {
  const remoteManifest = { 'c.md': { size: 3, mtime: 7, hash: 'remote-hash' } };

  async function runSyncLocalConflict(backupResult) {
    const plugin = makePlugin();
    const localBytes = new TextEncoder().encode('local offline edit');
    makeVaultStub(plugin, { 'c.md': localBytes.buffer.slice(0) });
    // 基线：本地相对基线有修改，云端同时改动 → 进入「两端均修改」真并发冲突分支
    plugin.updateBaselineEntry('vault-test', 'c.md', { hash: 'base-hash', mtime: 1, size: 4 });

    plugin.backupLocalConflictFile = async () => backupResult;

    let pullOpts = null;
    plugin.pullRemoteFileViaHttp = async (p, mtime, hash, options) => {
      pullOpts = options;
      return true;
    };

    await plugin.syncManifest(remoteManifest, 10);
    return pullOpts;
  }

  await t.test('备份失败（返回 null）：绝不能带 backupDone=true 裸拉取', async () => {
    const pullOpts = await runSyncLocalConflict(null);
    assert.ok(pullOpts, '本地并发修改路径应当触发拉取');
    assert.notEqual(pullOpts.backupDone, true, '备份失败的路径必须交回 applyRemoteBinaryChange 的覆盖防护，不得透传 backupDone');
  });

  await t.test('备份成功：带上 backupDone 避免重复副本', async () => {
    const pullOpts = await runSyncLocalConflict('c.md.conflict-offline-1.md');
    assert.ok(pullOpts, '本地并发修改路径应当触发拉取');
    assert.equal(pullOpts.backupDone, true);
  });
});

test('插件：HTTP 推送冲突协议三分类——serverWin/conflict 受保护拉取，ignored 维持原语义 (D-1)', async (t) => {
  const crypto = require('node:crypto');
  const sha = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');

  const makeBig = () => new Uint8Array(2 * 1024 * 1024 + 32); // >2MB 强制走 HTTP PUT 通道
  const serverContent = new TextEncoder().encode('server wins entirely');
  const serverHash = sha(serverContent);

  async function runScenario(body, { expectPull = true } = {}) {
    const plugin = makePlugin();
    const big = makeBig();
    const buffers = { 'big.md': big.buffer.slice(0) };
    makeVaultStub(plugin, buffers);

    const calls = [];
    let putCount = 0;
    await withFetch(async (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      calls.push({ method, url: String(url) });
      if (method === 'PUT') {
        // 仅本地首次主动推送返回冲突体（真实服务端语义：备份副本推送 baseHash 为空，不会触发冲突）
        putCount++;
        return { ok: true, status: 200, json: async () => (putCount === 1 ? body : { written: true, currentHash: 'pushed-' + putCount }) };
      }
      // GET：受保护拉取，云端胜出版本
      return { ok: true, status: 200, arrayBuffer: async () => serverContent.buffer.slice(0) };
    }, async () => plugin.pushLocalFile(Object.assign(new obsidianStub.TFile(), {
      path: 'big.md', extension: 'md', stat: { mtime: 1, size: big.byteLength },
    })));

    const baselineBase = plugin.getBaselineEntry('vault-test', 'big.md');
    return { plugin, calls, buffers, serverHash, baselineBase, serverContent };
  }

  await t.test('serverWin 响应：不伪造 ignored 基线，触发受保护拉取并落基线', async () => {
    const { plugin, calls, buffers, baselineBase } = await runScenario({ written: false, serverWin: true, conflict: null, currentHash: serverHash });
    // 序列：PUT(main) → GET(protected pull) → PUT(本地备份副本推送)
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[1].method, 'GET');
    assert.ok(calls[2] && calls[2].method === 'PUT', '本地备份副本应被推送参与同步');
    // 基线以云端胜出版本为准（旧实现会写入本地旧内容 hash + ignored:true）
    assert.equal(baselineBase.hash, serverHash);
    assert.equal(baselineBase.ignored, undefined);
    // 本地文件已被云端胜出版本收敛，且存在 .conflict-offline-* 备份
    const pulledText = Buffer.from(buffers['big.md']).toString();
    assert.equal(pulledText, 'server wins entirely');
    assert.ok(Object.keys(buffers).some((p) => p.includes('.conflict-offline-')), '本地修改应有 .conflict-offline-* 备份');
    // 不进补推队列
    assert.equal(plugin.pendingLocalQueueWhileBarrier.size, 0);
  });

  await t.test('conflict 响应：同样受保护拉取（不再落入黑名单分支）', async () => {
    const { plugin, calls, buffers, baselineBase } = await runScenario({
      written: false, conflict: 'big.conflict-stamp.md', currentHash: serverHash,
    });
    assert.equal(calls[1].method, 'GET');
    assert.equal(baselineBase.hash, serverHash);
    assert.equal(baselineBase.ignored, undefined);
    // 受保护拉取只针对主路径；服务端冲突副本不重复物化到本地
    assert.equal(buffers['big.conflict-stamp.md'], undefined);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.size, 0);
  });

  await t.test('ignored（真·黑名单）响应：维持既有 ignored 基线语义，不触发拉取', async () => {
    const localHash = sha(new Uint8Array(2 * 1024 * 1024 + 32));
    const { calls, buffers, baselineBase } = await runScenario({ written: false, ignored: true, conflict: null, path: 'big.md' });
    assert.equal(calls.length, 1, '黑名单响应不触发任何 GET 拉取');
    assert.equal(baselineBase.hash, localHash);
    assert.equal(baselineBase.ignored, true);
    assert.equal(buffers['big.md'].byteLength, 2 * 1024 * 1024 + 32, '本地内容原样保留');
  });
});
