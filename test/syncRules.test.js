const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-rules-'));
const syncRules = require('../src/syncRules');
const vaults = require('../src/vaults');

test('Sync Rules and Blacklist Filtering', async (t) => {
  const vaultId = 'test-rules-vault-' + Date.now();

  await t.test('默认规则拦截临时文件与系统噪音文件', () => {
    assert.equal(syncRules.isPathIgnored(vaultId, '.obsidian/workspace.json'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'temp.tmp'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'sub/folder/file.swp'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'node_modules/package/index.js'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, '.DS_Store'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'folder/.DS_Store'), true);
  });

  await t.test('正常笔记与附件应允许通过', () => {
    assert.equal(syncRules.isPathIgnored(vaultId, 'Daily Notes/2026-09-19.md'), false);
    assert.equal(syncRules.isPathIgnored(vaultId, 'attachments/diagram.png'), false);
    assert.equal(syncRules.isPathIgnored(vaultId, 'projects/nimbus/spec.txt'), false);
  });

  await t.test('自定义黑名单规则生效', () => {
    syncRules.saveRules(vaultId, {
      ignorePatterns: ['*.bak', 'private/**', '.obsidian/workspace.json'],
    });

    assert.equal(syncRules.isPathIgnored(vaultId, 'backup.bak'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'private/secret.md'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'public/note.md'), false);
  });

  await t.test('Windows 风格反斜杠路径自动兼容匹配', () => {
    assert.equal(syncRules.isPathIgnored(vaultId, 'private\\secret.md'), true);
    assert.equal(syncRules.isPathIgnored(vaultId, 'sub\\folder\\test.bak'), true);
  });
});
