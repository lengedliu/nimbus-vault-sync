const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('../src/storage');
const vaults = require('../src/vaults');
const deltaSync = require('../src/deltaSync');

test('Stale Client Re-joining & Conflict Prevention Tests', async (t) => {
  const vaultId = 'test-stale-vault-' + Date.now();
  const root = vaults.vaultFilesRoot(vaultId);
  fs.mkdirSync(root, { recursive: true });

  await t.test('陈旧客户端携带旧 baseHash 推送时，必须触发冲突保护生成 .conflict 副本且不覆盖云端最新版本', async () => {
    const relPath = 'my-important-notes.md';
    // 1. 云端初始版本 (Version 1)
    const v1Content = Buffer.from('# Version 1 (Initial note)');
    const v1Res = storage.writeFile(vaultId, relPath, v1Content);
    assert.equal(v1Res.written, true);
    const v1Hash = v1Res.currentHash;

    // 2. 模拟客户端 B 在离线期间，将云端更新为了 Version 2
    const v2Content = Buffer.from('# Version 2 (Edited by Client B while A was offline)');
    const v2Res = storage.writeFile(vaultId, relPath, v2Content, { baseHash: v1Hash });
    assert.equal(v2Res.written, true);
    const v2Hash = v2Res.currentHash;

    // 3. 此时陈旧客户端 A 刚上线，本地还拿着 Version 1 的 baseHash，尝试写入本地的老修改 Version A_old
    const vAOldContent = Buffer.from('# Version A_old (Old offline edits from Client A)');
    const vARes = storage.writeFile(vaultId, relPath, vAOldContent, { baseHash: v1Hash });

    // 验证：绝对不能覆盖云端 Version 2
    assert.equal(vARes.written, false, '应该拒绝直接覆盖');
    assert.ok(vARes.conflict, '应该生成 conflict 副本');
    assert.match(vARes.conflict, /\.conflict-/, '冲突文件名需包含 .conflict 标识');

    // 验证云端主文件依然是 Version 2
    const currentOnCloud = storage.readFile(vaultId, relPath);
    assert.equal(currentOnCloud.toString('utf8'), v2Content.toString('utf8'), '云端最新内容必须保持完整');

    // 验证冲突副本包含了客户端 A 的修改
    const conflictContent = storage.readFile(vaultId, vARes.conflict);
    assert.equal(conflictContent.toString('utf8'), vAOldContent.toString('utf8'), '冲突副本必须完整保存客户端 A 的离线修改');
  });

  await t.test('当客户端离线时间过长且游标超出保留窗口时，DeltaSync 必须强制指示全量快照重对齐', async () => {
    await deltaSync.initVault(vaultId);
    // 模拟服务端产生了多次变更
    for (let i = 0; i < 5; i++) {
      await deltaSync.recordChange(vaultId, {
        path: `note-${i}.md`,
        action: 'UPSERT',
        size: 100,
        mtime: Date.now(),
        hash: 'hash-' + i,
      });
    }

    // 客户端拿一个超前游标 (比最新还大) -> 必须要求全量快照
    const futureRes = await deltaSync.getChanges(vaultId, 999999);
    assert.equal(futureRes.fullSyncRequired, true);
    assert.equal(futureRes.reason, 'CURSOR_AHEAD_OF_SERVER');

    // 客户端 since <= 0 -> 必须要求全量快照
    const zeroRes = await deltaSync.getChanges(vaultId, 0);
    assert.equal(zeroRes.fullSyncRequired, true);
    assert.equal(zeroRes.reason, 'FIRST_SYNC_FULL_SNAPSHOT_REQUIRED');
  });
});
