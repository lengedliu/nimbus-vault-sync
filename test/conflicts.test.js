const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-conflicts-'));
const storage = require('../src/storage');
const vaults = require('../src/vaults');
const conflicts = require('../src/conflicts');
const deltaSync = require('../src/deltaSync');

test('Conflicts resolution and snapshot edge cases', async (t) => {
  const vaultId = 'test-conflict-vault-' + Date.now();
  const root = vaults.vaultFilesRoot(vaultId);
  fs.mkdirSync(root, { recursive: true });

  await t.test('writeFileFromPath: 在 manifest 未命中但物理文件已存在时，必须进行冲突检查与历史快照', () => {
    const relPath = 'cold-start.md';
    const originalContent = Buffer.from('Original Server Content');
    const full = path.join(root, relPath);
    // 直接物理落盘，绕过内存 manifest 缓存，模拟冷启动/外部同步场景
    fs.writeFileSync(full, originalContent);
    const originalHash = crypto.createHash('sha256').update(originalContent).digest('hex');

    // 此时内存 Manifest 尚未包含 cold-start.md
    storage.invalidateManifestCache(vaultId);

    // 1. 尝试覆盖写入，但带有过期的 baseHash
    const tempPath = storage.createUploadTempPath(vaultId);
    const newContent = Buffer.from('Incoming Conflict Content');
    fs.writeFileSync(tempPath, newContent);
    const newHash = crypto.createHash('sha256').update(newContent).digest('hex');

    const resultConflict = storage.writeFileFromPath(vaultId, relPath, tempPath, newHash, {
      baseHash: 'outdated-hash-000',
    });

    assert.equal(resultConflict.written, false, '应该识别出物理文件冲突');
    assert.ok(resultConflict.conflict, '应该返回 conflict 副本路径');
    assert.equal(fs.readFileSync(full, 'utf8'), 'Original Server Content', '原物理文件不应被覆盖');

    // 2. 尝试无冲突正常覆盖，验证必须留下历史版本快照
    const tempPath2 = storage.createUploadTempPath(vaultId);
    const validContent = Buffer.from('Valid Overwrite Content');
    fs.writeFileSync(tempPath2, validContent);
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');

    const resultOverwrite = storage.writeFileFromPath(vaultId, relPath, tempPath2, validHash, {
      baseHash: originalHash,
    });

    assert.equal(resultOverwrite.written, true);
    assert.equal(fs.readFileSync(full, 'utf8'), 'Valid Overwrite Content');

    const history = storage.listHistory(vaultId, relPath);
    assert.ok(history.length >= 1, '覆盖物理文件必须生成历史快照');
  });

  await t.test('resolveConflict: 解决冲突必须通过 storage.deleteFile 记录 deltaSync 删除事件', async () => {
    const baseName = 'test-doc.md';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictName = `test-doc.conflict-${stamp}.md`;

    storage.writeFile(vaultId, baseName, Buffer.from('Server Version'));
    storage.writeFile(vaultId, conflictName, Buffer.from('Conflict Version'));

    const beforeCursor = deltaSync.getLatestCursor(vaultId);

    const resolveRes = await conflicts.resolveConflict(vaultId, {
      conflictPath: conflictName,
      resolution: 'keep-current',
      userId: 'user-1',
    });

    assert.equal(resolveRes.ok, true);
    assert.equal(resolveRes.basePath, baseName);

    // 验证冲突文件已从原路径移除
    const conflictFull = path.join(root, conflictName);
    assert.equal(fs.existsSync(conflictFull), false, '冲突文件原路径应不存在');

    // 验证 deltaSync 记录了该冲突副本的 DELETE 变更，以便增量同步客户端能够清理该文件
    const afterCursor = deltaSync.getLatestCursor(vaultId);
    assert.ok(afterCursor > beforeCursor, '游标应该递增');

    const changes = await deltaSync.getChanges(vaultId, beforeCursor);
    assert.ok(changes.deletes.some((d) => d.path === conflictName), 'deletes 列表必须包含被删除的冲突副本');
  });
});
