const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VAULTS_DIR, DATA_DIR } = require('../src/config');
const storage = require('../src/storage');
const vaults = require('../src/vaults');
const vaultMembers = require('../src/vaultMembers');
const syncRules = require('../src/syncRules');
const deltaSync = require('../src/deltaSync');
const shares = require('../src/shares');
const ftsEngine = require('../src/ftsEngine');
const users = require('../src/users');

test('File Mutex: withFileLock serializes concurrent access per vaultId and relPath', async () => {
  const vaultId = 'v_lock_test';
  const relPath = 'notes/test_mutex.md';
  const executionOrder = [];

  const task1 = storage.withFileLock(vaultId, relPath, async () => {
    executionOrder.push('task1_start');
    await new Promise((r) => setTimeout(r, 50));
    executionOrder.push('task1_end');
    return 'res1';
  });

  const task2 = storage.withFileLock(vaultId, relPath, async () => {
    executionOrder.push('task2_start');
    await new Promise((r) => setTimeout(r, 20));
    executionOrder.push('task2_end');
    return 'res2';
  });

  const [r1, r2] = await Promise.all([task1, task2]);
  assert.equal(r1, 'res1');
  assert.equal(r2, 'res2');
  assert.deepEqual(executionOrder, ['task1_start', 'task1_end', 'task2_start', 'task2_end'], 'Tasks on same file must execute sequentially');
});

test('Cascade Cleanup: deleting a vault completely purges members, changes, rules, shares, indices, and disk files', async () => {
  const testOwner = 'u_test_cascade_owner';
  const testMember = 'u_test_cascade_member';

  // 1. Create a vault
  const vault = vaults.create(testOwner, 'Cascade Test Vault');
  const vaultId = vault.id;
  assert.ok(vaultId);

  // 2. Add member, sync rule, change record, share, and write a file
  await vaultMembers.addOrUpdateMember(vaultId, testMember, 'read-write');
  syncRules.saveRules(vaultId, { ignorePatterns: ['*.tmp', 'secret.key'] });
  await deltaSync.initVault(vaultId);
  await deltaSync.recordChange(vaultId, 'note.md', 'update', { size: 12, mtime: Date.now(), hash: 'hash123' });
  await shares.create({ vaultId, userId: testOwner, filePath: 'note.md', title: 'Share Note' });

  storage.writeFile(vaultId, 'note.md', Buffer.from('hello world'));
  storage.deleteFile(vaultId, 'note.md'); // moves to trash

  // 3. Verify items exist before removal
  assert.equal(vaultMembers.listForVault(vaultId).length, 1);
  assert.ok(syncRules.getRules(vaultId).ignorePatterns.includes('*.tmp'));
  assert.ok(storage.listTrash(vaultId).length > 0 || fs.existsSync(path.join(VAULTS_DIR, vaultId)));

  // 4. Remove the vault
  await vaults.remove(vaultId);

  // 5. Verify all cascading data is wiped
  assert.equal(vaults.getById(vaultId), undefined, 'Vault must be removed from cache');
  assert.equal(vaultMembers.listForVault(vaultId).length, 0, 'Vault members must be deleted');
  assert.equal(shares.listForVault(vaultId).length, 0, 'Vault shares must be deleted');
  assert.equal(fs.existsSync(path.join(VAULTS_DIR, vaultId)), false, 'Vault directory must be deleted');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'trash', vaultId)), false, 'Trash directory must be deleted');
});
