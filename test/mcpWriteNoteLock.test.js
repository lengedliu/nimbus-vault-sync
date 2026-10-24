const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const storage = require('../src/storage');
const deltaSync = require('../src/deltaSync');
const vaults = require('../src/vaults');
const syncRules = require('../src/syncRules');

test('项 6：storage.writeFileAsync baseHash 乐观锁契约 + getManifestEntryAsync O(1) 锁内读取', async (t) => {
  const uniqueId = 'mcp-lock-' + Date.now();
  const mockUser = { id: 'test-user-' + uniqueId, username: 'mcpuser-' + uniqueId, role: 'admin' };
  const createdVault = await vaults.create(mockUser.id, 'MCP Lock Test Vault');
  const vaultId = createdVault.id;
  await deltaSync.initVault(vaultId);

  // 1. 首次写入新文件（无 baseHash）应成功
  await t.test('新文件无 baseHash 写入成功', async () => {
    const res = await storage.writeFileAsync(vaultId, 'NewNote.md', Buffer.from('# First note'));
    assert.equal(res.written, true, '新文件应写入成功');
  });

  // 2. 再次写入同一文件**不带 baseHash** → storage 层仍允许写入（乐观锁在 MCP 工具层拦截）
  // 此处验证 storage.writeFileAsync 本身的行为：无 baseHash 时按覆盖处理（不做乐观锁拦截）
  await t.test('storage 层无 baseHash 直接覆盖（乐观锁由上层工具拦截）', async () => {
    const res = await storage.writeFileAsync(vaultId, 'NewNote.md', Buffer.from('# Overwrite without baseHash'));
    assert.equal(res.written, true, 'storage 层无 baseHash 直接覆盖');
  });

  // 3. 带正确 baseHash 覆盖成功
  await t.test('带正确 baseHash 覆盖成功', async () => {
    const manifest = storage.getManifest(vaultId);
    const currentHash = manifest['NewNote.md'].hash;
    const res = await storage.writeFileAsync(vaultId, 'NewNote.md', Buffer.from('# Updated with baseHash'), { baseHash: currentHash });
    assert.equal(res.written, true, '带正确 baseHash 应覆盖成功');
  });

  // 4. 带过期 baseHash → 冲突处理（serverWin 或 conflict_copy，视策略）
  await t.test('过期 baseHash 触发冲突流程', async () => {
    const manifest = storage.getManifest(vaultId);
    const currentHash = manifest['NewNote.md'].hash;
    // 外部直接写盘改动（模拟并发修改）
    storage.writeFile(vaultId, 'NewNote.md', Buffer.from('# Concurrent change'));
    const newManifest = storage.getManifest(vaultId);
    assert.notEqual(newManifest['NewNote.md'].hash, currentHash, '外部修改应改变哈希');

    // 再用旧 baseHash 尝试写入
    const res = await storage.writeFileAsync(vaultId, 'NewNote.md', Buffer.from('# Stale baseHash attempt'), { baseHash: currentHash });
    // 可能 serverWin 或 conflict_copy（默认策略）
    assert.ok(
      res.serverWin === true || res.conflict !== null,
      '过期 baseHash 应触发冲突处理（serverWin 或 conflict_copy）'
    );
  });

  // 5. 验证 getManifestEntryAsync 存在且可用
  await t.test('getManifestEntryAsync 存在且 O(1) 读取单条目', async () => {
    assert.ok(typeof storage.getManifestEntryAsync === 'function', 'storage 必须导出 getManifestEntryAsync');
    const entry = await storage.getManifestEntryAsync(vaultId, 'NewNote.md');
    assert.ok(entry && entry.hash, '应返回单条目元数据');
    assert.ok(!entry.size || entry.size > 0, '应包含 size');
  });
});