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
    // 与真实 Obsidian 行为一致：删除一个 TFile 后缓冲区里不再有该路径
    delete: async (target) => { if (target && target.path) delete buffers[target.path]; },
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

test('插件：applyRemoteDelete 黑名单路径本地保留 (E-2)', async (t) => {
  await t.test('命中 remoteIgnorePatterns 的路径远端删除不执行，仅清理同步状态', async () => {
    const plugin = makePlugin();
    const enc = new TextEncoder();
    const buffers = { 'secret.md': enc.encode('precious').buffer.slice(0) };
    const vault = makeVaultStub(plugin, buffers);
    plugin.remoteIgnorePatterns = ['secret.md'];
    plugin.updateBaselineEntry('vault-test', 'secret.md', { hash: 'bbb', mtime: 1, size: 8 });

    const ok = await plugin.applyRemoteDelete('secret.md', true);
    assert.equal(ok, true);
    assert.ok(buffers['secret.md'], '黑名单文件本地保留，绝不物理删除');
    assert.equal(plugin.getBaselineEntry('vault-test', 'secret.md'), null, '基线清理等价于 WS ignored ack');
  });

  await t.test('非黑名单路径的远端删除照常执行（对照语义不变）', async () => {
    const plugin = makePlugin();
    const enc = new TextEncoder();
    const buffers = { 'normal.md': enc.encode('deletable').buffer.slice(0) };
    makeVaultStub(plugin, buffers);
    plugin.remoteIgnorePatterns = ['secret.md'];

    const ok = await plugin.applyRemoteDelete('normal.md', true);
    assert.equal(ok, true);
    assert.equal(buffers['normal.md'], undefined, '非黑名单文件照常本地删除');
    assert.equal(plugin.getBaselineEntry('vault-test', 'normal.md'), null);
  });
});

test('插件：0 字节远端内容的 WS file 通道接受 (E-3)', async () => {
  const plugin = makePlugin();
  const buffers = {};
  makeVaultStub(plugin, buffers);
  const sha = (b) => require('node:crypto').createHash('sha256').update(Buffer.from(b)).digest('hex');

  // 情况 1：远端把已有文件清空（modifyBinary 到空 buffer）。
  // 基线对齐当前内容，避免进入「离线修改备份→补推等待」分支（那是 15s 超时慢路径）。
  buffers['empty.md'] = new TextEncoder().encode('was content').buffer.slice(0);
  plugin.updateBaselineEntry('vault-test', 'empty.md', { hash: sha('was content'), mtime: 1, size: 11 });
  const sha256Empty = sha('');
  const ok1 = await plugin.applyRemoteChange('empty.md', '', 5, sha256Empty);
  assert.equal(ok1, true, '空 base64 是合法内容，不得误判失败');
  assert.equal(buffers['empty.md'].byteLength, 0, '0 字节内容已落盘');
  let entry = plugin.getBaselineEntry('vault-test', 'empty.md');
  assert.equal(entry.hash, sha256Empty, '基线对齐空文件');

  // 情况 2：远端新建一个空文件（createBinary 空内容）
  const ok2 = await plugin.applyRemoteChange('fresh-empty.md', '', 5, sha256Empty);
  assert.equal(ok2, true);
  assert.ok(buffers['fresh-empty.md'], '新建空文件也必须落地');
  assert.equal(buffers['fresh-empty.md'].byteLength, 0);
});

test('插件：serverWin 冲突通知文案不再误报 conflictPath (E-4)', async () => {
  const plugin = makePlugin();
  await plugin.handleServerMessage({ type: 'conflict', path: 'p.md', serverWin: true, currentHash: 'h' });
  assert.ok(!obsidianStub.lastNotice.includes('undefined'), 'serverWin 无 conflictPath，不得把 undefined 打给用户');
  assert.ok(obsidianStub.lastNotice.includes('云端优先'), 'serverWin 使用专属文案');

  await plugin.handleServerMessage({ type: 'conflict', path: 'p.md', conflictPath: 'p.conflict-x.md', currentHash: 'h' });
  assert.ok(obsidianStub.lastNotice.includes('p.conflict-x.md'), 'conflict-copy 文案保持不变');
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

// ---------------------------------------------------------------------------
// Round 5 回归测试：7 项同步业务逻辑闭环
// ---------------------------------------------------------------------------

test('Round 5 #1：init 走游标吻合或增量追更快速通道后，扫描并同步 Obsidian 关闭期间的磁盘离线变更', async (t) => {
  const crypto = require('node:crypto');
  const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');
  const enc = new TextEncoder();

  await t.test('serverCursor === localCursor 时，自动推送外部新增/修改并删除外部已删文件', async () => {
    const plugin = makePlugin();
    plugin.setVaultCursor('vault-test', 10);
    const buffers = {
      'kept.md': enc.encode('same').buffer.slice(0),
      'edited.md': enc.encode('offline external edit').buffer.slice(0),
      'new-external.md': enc.encode('created while closed').buffer.slice(0),
    };
    makeVaultStub(plugin, buffers);

    plugin.updateBaselineEntry('vault-test', 'kept.md', { hash: sha('same'), mtime: 1, size: 4 });
    plugin.updateBaselineEntry('vault-test', 'edited.md', { hash: sha('old content'), mtime: 1, size: 11 });
    plugin.updateBaselineEntry('vault-test', 'deleted-external.md', { hash: sha('gone'), mtime: 1, size: 4 });
    plugin.fileHashes.set('kept.md', sha('same'));

    const pushed = [];
    const deleted = [];
    plugin.pushLocalFile = async (f) => {
      pushed.push(f.path);
      return true;
    };
    plugin.deleteRemoteFile = async (p) => {
      deleted.push(p);
      return true;
    };

    await plugin.handleServerMessage({ type: 'init', cursor: 10, ignorePatterns: [] });
    assert.deepEqual(pushed.sort(), ['edited.md', 'new-external.md']);
    assert.deepEqual(deleted, ['deleted-external.md']);
  });

  await t.test('本地空库（0 文件）时触发空库保护，绝不发起任何云端删除', async () => {
    const plugin = makePlugin();
    plugin.setVaultCursor('vault-test', 10);
    makeVaultStub(plugin, {});
    plugin.updateBaselineEntry('vault-test', 'a.md', { hash: sha('a'), mtime: 1, size: 1 });

    let deletedCalled = false;
    plugin.deleteRemoteFile = async () => {
      deletedCalled = true;
      return true;
    };

    await plugin.handleServerMessage({ type: 'init', cursor: 10, ignorePatterns: [] });
    assert.equal(deletedCalled, false, '空库保护下不得删除云端文件');
  });
});

test('Round 5 #2 & #3：链式重命名折叠、屏障期先 rename 后 push、目录重命名与 3-Way 前重命名对齐', async (t) => {
  await t.test('链式重命名 A -> B -> C 折叠为 A -> C，且联动更新待推队列；A -> B -> A 抵消', async () => {
    const plugin = makePlugin();
    plugin.queuePendingLocalPush('a.md');
    plugin.queuePendingLocalRename('a.md', 'b.md');
    plugin.queuePendingLocalRename('b.md', 'c.md');

    assert.deepEqual(Array.from(plugin.pendingLocalRenames.entries()), [['a.md', 'c.md']]);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.has('a.md'), false);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.has('b.md'), false);
    assert.equal(plugin.pendingLocalQueueWhileBarrier.has('c.md'), true);

    // 环路改回原名 A -> C -> A 应自动抵消
    plugin.queuePendingLocalRename('c.md', 'a.md');
    assert.equal(plugin.pendingLocalRenames.size, 0);
  });

  await t.test('屏障期重命名并修改：flush 时先执行 rename 再执行 push，防止旧文件覆盖新修改', async () => {
    const plugin = makePlugin();
    const enc = new TextEncoder();
    const buffers = { 'b.md': enc.encode('edited after rename').buffer.slice(0) };
    makeVaultStub(plugin, buffers);

    plugin.syncBarrierActive = true;
    plugin.queuePendingLocalRename('a.md', 'b.md');
    plugin.queuePendingLocalPush('b.md');

    const order = [];
    plugin.renameRemoteFile = async (oldP, newF) => {
      order.push(`rename:${oldP}->${newF.path}`);
      return true;
    };
    plugin.pushLocalFile = async (f) => {
      order.push(`push:${f.path}`);
      return true;
    };

    await plugin.flushPendingLocalChangesAfterBarrier();
    assert.deepEqual(order, ['rename:a.md->b.md', 'push:b.md']);
  });

  await t.test('屏障期重命名文件夹：自动为目录下所有子文件记录挂起重命名', async () => {
    const plugin = makePlugin();
    plugin.isVaultReady = true;
    plugin.syncBarrierActive = true;
    const enc = new TextEncoder();
    makeVaultStub(plugin, {
      'newDir/sub/1.md': enc.encode('1').buffer.slice(0),
      'newDir/2.md': enc.encode('2').buffer.slice(0),
    });

    const folder = Object.assign(new obsidianStub.TFolder(), { path: 'newDir' });
    await plugin.onLocalFileRename(folder, 'oldDir');

    assert.deepEqual(Array.from(plugin.pendingLocalRenames.entries()).sort(), [
      ['oldDir/2.md', 'newDir/2.md'],
      ['oldDir/sub/1.md', 'newDir/sub/1.md'],
    ]);
  });
});

test('Round 5 #4：服务端 moveVaultFile conflictSafe 冲突保护与插件 rename 冲突收敛', async (t) => {
  const storage = require('../src/storage');

  await t.test('storage.moveVaultFileAsync 在 conflictSafe=true 且目标存在不同内容时生成 .conflict-* 副本并保留原目标', async () => {
    const vaultId = `test-rename-conflict-${Date.now()}`;
    try {
      await storage.writeFileAsync(vaultId, 'src.md', Buffer.from('from source rename'), { mtime: 100 });
      await storage.writeFileAsync(vaultId, 'dest.md', Buffer.from('existing target on server'), { mtime: 200 });

      const res = await storage.moveVaultFileAsync(vaultId, 'src.md', 'dest.md', { overwrite: true, conflictSafe: true });
      assert.equal(res.ok, true);
      assert.equal(res.written, false);
      assert.ok(res.conflict && res.conflict.startsWith('dest.conflict-'), '应生成 dest.conflict-* 分支副本');

      // 原目标文件完好无损
      const destBuf = storage.readFile(vaultId, 'dest.md');
      assert.equal(destBuf.toString('utf8'), 'existing target on server');
      // 源文件已移入冲突副本
      assert.equal(storage.readFile(vaultId, 'src.md'), null);
      const conflictBuf = storage.readFile(vaultId, res.conflict);
      assert.equal(conflictBuf.toString('utf8'), 'from source rename');
    } finally {
      try { storage.deleteVaultDirectory(vaultId); } catch {}
    }
  });

  await t.test('插件 renameRemoteFile 收到带 conflict 的 ack 时，清理旧基线且不把旧 hash 写进新路径基线', async () => {
    const plugin = makePlugin();
    plugin.fileHashes.set('old.md', 'old-hash');
    plugin.updateBaselineEntry('vault-test', 'old.md', { hash: 'old-hash', mtime: 1, size: 3 });
    plugin.sendWsMessageAndWait = async () => ({
      type: 'ack',
      action: 'rename',
      oldPath: 'old.md',
      path: 'new.md',
      conflict: 'new.conflict-1.md',
      cursor: 15,
    });

    const ok = await plugin.renameRemoteFile('old.md', { path: 'new.md', stat: { mtime: 2, size: 3 } });
    assert.equal(ok, true);
    assert.equal(plugin.getBaselineEntry('vault-test', 'old.md'), null);
    assert.equal(plugin.getBaselineEntry('vault-test', 'new.md'), null, '冲突时不应把旧 hash 伪造成新路径基线');
  });
});

test('Round 5 #5：在途 push 期间文件被删除或重命名，迟到的 push ack 不复活已删路径基线', async () => {
  const plugin = makePlugin();
  plugin.updateBaselineEntry('vault-test', 'victim.md', { hash: 'h0', mtime: 1, size: 2 });
  plugin.fileHashes.set('victim.md', 'h0');

  // 本地触发删除（例如用户在 push 飞出后立刻删了该文件）
  plugin.queuePendingLocalDelete('victim.md');
  plugin.updateBaselineEntry('vault-test', 'victim.md', null);
  plugin.fileHashes.delete('victim.md');

  // 随后网络上迟到的 push ack 抵达
  await plugin.handleServerMessage({
    type: 'ack',
    action: 'push',
    path: 'victim.md',
    hash: 'h-late-push',
    mtime: 99,
    cursor: 20,
  });

  assert.equal(plugin.getBaselineEntry('vault-test', 'victim.md'), null, '迟到的 push ack 绝不能复活已删除文件的基线');
  assert.equal(plugin.fileHashes.has('victim.md'), false);
});

test('Round 5 #6：syncDeltaChanges 与 syncManifest 游标严格单调不回退，且首拉半途失败不提前写游标', async (t) => {
  await t.test('syncDeltaChanges 遇到并发已推进的更高本地游标时不回退', async () => {
    const plugin = makePlugin();
    plugin.setVaultCursor('vault-test', 50);

    await withFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ updates: [], deletes: [], cursor: 30, hasMore: false }),
    }), () => plugin.syncDeltaChanges(25));

    assert.equal(plugin.getVaultCursor('vault-test'), 50, '本地游标已高于增量页 cursor 时不得倒退');
  });

  await t.test('新设备首拉（localCount === 0）若有文件拉取失败，不提前把游标设为 remoteCursor', async () => {
    const plugin = makePlugin();
    makeVaultStub(plugin, {});
    plugin.setVaultCursor('vault-test', 0);
    plugin.pullRemoteFileViaHttp = async (p) => p !== 'fail.md';

    await plugin.syncManifest({
      'ok.md': { hash: 'h1', mtime: 1, size: 2 },
      'fail.md': { hash: 'h2', mtime: 1, size: 2 },
    }, 88);

    assert.equal(plugin.getVaultCursor('vault-test'), 0, '首拉存在失败项时游标必须保持为 0 以便重连重试');
  });
});

// ---------------------------------------------------------------------------
// Round 6 回归测试：业务逻辑与会话权限闭环
// ---------------------------------------------------------------------------

test('Round 6：wsHub.disconnectWebSessions 仅踢出网页登录会话，保留独立设备 Token 连接', async () => {
  const wsHub = require('../src/wsHub');
  const vaultId = `test-ws-session-${Date.now()}`;
  const closedWeb = [];
  const closedDevice = [];

  const webClient = {
    userId: 'u-1',
    username: 'alice',
    deviceId: 'Web-Dashboard',
    tokenPayload: { sub: 'u-1', passwordVersion: 'old-ver' },
    ws: {
      readyState: 1,
      OPEN: 1,
      send: () => {},
      close: (code, reason) => closedWeb.push({ code, reason }),
    },
  };
  const deviceClient = {
    userId: 'u-1',
    username: 'alice',
    deviceId: 'dev-obsidian-1',
    tokenPayload: { sub: 'u-1', deviceId: 'dev-obsidian-1', type: 'device' },
    ws: {
      readyState: 1,
      OPEN: 1,
      send: () => {},
      close: (code, reason) => closedDevice.push({ code, reason }),
    },
  };

  const room = wsHub._room(vaultId);
  room.add(webClient);
  room.add(deviceClient);

  try {
    const kicked = wsHub.disconnectWebSessions('u-1', 'password_changed');
    assert.equal(kicked, 1, '应仅断开 1 个网页端 WebSocket 会话');
    assert.equal(closedWeb.length, 1);
    assert.equal(closedWeb[0].code, 4001);
    assert.equal(closedDevice.length, 0, '专用设备 Token 的连接在改密后应保持不断开');
    assert.equal(room.has(deviceClient), true);
  } finally {
    wsHub.rooms.delete(vaultId);
  }
});

// ---------------------------------------------------------------------------
// Round 7 回归测试：冲突备份防护、自死锁消除与文件夹原子重命名
// ---------------------------------------------------------------------------

test('Round 7：WS serverWin 冲突不污染 _conflictRestorePaths，确保本地修改被备份为 .conflict-offline-*', async () => {
  const crypto = require('node:crypto');
  const sha = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
  const enc = new TextEncoder();

  const plugin = makePlugin();
  const localContent = enc.encode('local unsaved rename/edit');
  const serverContent = enc.encode('server winning content');
  const buffers = { 'target.md': localContent.buffer.slice(0) };
  makeVaultStub(plugin, buffers);
  // 本地尚未与 serverContent 对齐（无基线或旧基线）
  plugin.updateBaselineEntry('vault-test', 'target.md', { hash: 'old-base-hash', mtime: 1, size: 10 });

  await plugin.handleServerMessage({
    type: 'conflict',
    path: 'target.md',
    serverWin: true,
    currentHash: sha(serverContent),
  });

  assert.equal(
    plugin._conflictRestorePaths && plugin._conflictRestorePaths.has('target.md'),
    false,
    'serverWin 无云端分支副本，绝不能将主路径加入 _conflictRestorePaths'
  );

  // 随后服务端响应 pull 下发 file 消息时，应触发 R-1 本地备份
  const ok = await plugin.applyRemoteBinaryChange(
    'target.md',
    serverContent.buffer.slice(0),
    Date.now(),
    sha(serverContent)
  );
  assert.equal(ok, true);
  const backupKeys = Object.keys(buffers).filter((k) => k.startsWith('target.conflict-offline-'));
  assert.equal(backupKeys.length, 1, 'serverWin 覆盖前必须为本地修改生成 .conflict-offline-* 备份副本');
});

test('Round 7：HTTP 大文件推送遇冲突时在 withLocalFileLock 内受保护拉取不发生自死锁', async () => {
  const crypto = require('node:crypto');
  const sha = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');

  const plugin = makePlugin();
  // 构造 >2MB 的本地文件以触发 HTTP PUT 分支
  const bigLocal = new Uint8Array(2 * 1024 * 1024 + 64);
  bigLocal.fill(65);
  const serverWinning = new TextEncoder().encode('server winning version after conflict');
  const serverHash = sha(serverWinning);

  const buffers = { 'big.bin': bigLocal.buffer.slice(0) };
  makeVaultStub(plugin, buffers);
  plugin.updateBaselineEntry('vault-test', 'big.bin', { hash: 'old-hash', mtime: 1, size: 100 });

  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          written: false,
          serverWin: true,
          currentHash: serverHash,
          mtime: 123456,
        }),
      };
    }
    // GET pullRemoteFileViaHttp
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => {
          if (h.toLowerCase() === 'x-file-hash') return serverHash;
          if (h.toLowerCase() === 'x-file-mtime') return '123456';
          return null;
        },
      },
      arrayBuffer: async () => serverWinning.buffer.slice(0),
    };
  };

  try {
    const fileObj = plugin.app.vault.getAbstractFileByPath('big.bin');
    // 模拟 onLocalFileChange 持锁调用 pushLocalFile(file, { lockHeld: true })
    const res = await Promise.race([
      plugin.withLocalFileLock('big.bin', () => plugin.pushLocalFile(fileObj, { lockHeld: true })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Deadlock detected!')), 1500)),
    ]);
    assert.equal(res, true, '持锁状态下完成 HTTP 冲突受保护拉取且不死锁');
    assert.equal(buffers['big.bin'].byteLength, serverWinning.byteLength, '主文件已更新为云端胜出版本');
  } finally {
    global.fetch = origFetch;
  }
});

test('Round 7：在线重命名文件夹走 renameRemoteFile 原子移动而非 delete+push', async () => {
  const plugin = makePlugin();
  const enc = new TextEncoder();
  const buffers = {
    'NewFolder/a.md': enc.encode('hello a').buffer.slice(0),
    'NewFolder/sub/b.md': enc.encode('hello b').buffer.slice(0),
  };
  makeVaultStub(plugin, buffers);
  plugin.isVaultReady = true;
  plugin.syncBarrierActive = false;

  const renamedPairs = [];
  let deleteCalled = false;
  plugin.renameRemoteFile = async (oldPath, newFile) => {
    renamedPairs.push([oldPath, newFile.path]);
    return true;
  };
  plugin.deleteRemoteFile = async () => {
    deleteCalled = true;
    return true;
  };

  const folder = Object.assign(new obsidianStub.TFolder(), { path: 'NewFolder' });
  await plugin.onLocalFileRename(folder, 'OldFolder');

  assert.equal(deleteCalled, false, '在线文件夹重命名不应直接调用 deleteRemoteFile 破坏历史链路');
  assert.deepEqual(renamedPairs, [
    ['OldFolder/a.md', 'NewFolder/a.md'],
    ['OldFolder/sub/b.md', 'NewFolder/sub/b.md'],
  ]);
});



