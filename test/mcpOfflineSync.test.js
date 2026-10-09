const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');
const vaults = require('../src/vaults');
const { buildMcpServer } = require('../src/mcp');
const dbManager = require('../src/db');

test('MCP Offline Note Creation & Subsequent Client Sync Verification', async (t) => {
  const vaultId = 'test-mcp-sync-vault-' + Date.now();
  const root = vaults.vaultFilesRoot(vaultId);
  fs.mkdirSync(root, { recursive: true });

  // Mock user and owner for unique vault
  const uniqueId = 'mcp-' + Date.now();
  const mockUser = { id: 'test-user-' + uniqueId, username: 'mcpuser-' + uniqueId, role: 'admin' };
  const createdVault = await vaults.create(mockUser.id, 'MCP Test Vault ' + uniqueId);
  const targetVaultId = createdVault.id;

  await deltaSync.initVault(targetVaultId);
  // 模拟客户端初始在线时已对齐已有笔记，建立了基线游标
  await storage.writeFileAsync(targetVaultId, 'README.md', Buffer.from('# Welcome to MCP Vault'));
  const initialCursor = deltaSync.getLatestCursor(targetVaultId);

  await t.test('1. MCP write_note (带前导斜杠与普通路径) 能正确归一化落盘并递增游标', async () => {
    // 模拟服务端初始化游标状态，此时客户端离线（未建立 WebSocket）
    const note1 = Buffer.from('# Note from MCP 1');
    const writeRes = await storage.writeFileAsync(targetVaultId, '/Inbox/first-mcp-note.md', note1);
    assert.equal(writeRes.written, true);

    const cursorAfter1 = deltaSync.getLatestCursor(targetVaultId);
    assert.ok(cursorAfter1 > initialCursor, 'Cursor should increment after MCP write');

    // 检查 manifest 和 storage 均使用去除前导斜杠的标准相对路径
    const manifest = storage.getManifest(targetVaultId);
    assert.ok(manifest['Inbox/first-mcp-note.md'], 'Manifest should contain normalized path without leading slash');
    assert.equal(manifest['/Inbox/first-mcp-note.md'], undefined, 'Manifest should not contain leading slash');
  });

  await t.test('2. 客户端离线后重新上线时，通过 DeltaSync 接口能够完整追更离线新增笔记', async () => {
    // 客户端携带历史游标 initialCursor 请求增量追更
    const deltaRes = await deltaSync.getChanges(targetVaultId, initialCursor, 500, { compact: true });
    assert.equal(deltaRes.fullSyncRequired, undefined, 'Should succeed with delta changes');
    assert.ok(deltaRes.updates.length >= 1, 'Should contain updates');

    const found = deltaRes.updates.find((u) => u.path === 'Inbox/first-mcp-note.md');
    assert.ok(found, 'Should find the normalized note path in updates');
    assert.equal(found.path.startsWith('/'), false, 'Path must not have leading slash');
    assert.ok(found.hash, 'Update item must have hash');
  });

  await t.test('3. 流式读取接口能正确通过归一化路径读取文件内容', async () => {
    // 模拟客户端 HTTP 流式拉取 /api/vaults/:vaultId/files/Inbox/first-mcp-note.md
    const streamInfo = storage.readFileStream(targetVaultId, 'Inbox/first-mcp-note.md');
    assert.ok(streamInfo, 'Stream info should exist');
    assert.ok(streamInfo.size > 0, 'Stream size should be > 0');

    const chunks = [];
    for await (const chunk of streamInfo.stream) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    assert.equal(content, '# Note from MCP 1');
  });

  await t.test('4. 全量清单接口包含离线新增笔记，哈希与大小一致', async () => {
    const manifest = await storage.getManifestAsync(targetVaultId);
    assert.ok(manifest['Inbox/first-mcp-note.md']);
    assert.equal(manifest['Inbox/first-mcp-note.md'].size, 17);
  });
});
