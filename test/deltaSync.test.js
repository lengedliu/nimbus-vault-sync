const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const deltaSync = require('../src/deltaSync');

test('DeltaSync: First sync and cursor boundary tests', async (t) => {
  const testVaultId = 'test-deltasync-' + Date.now();

  await t.test('新接入设备以 since=0 或空游标请求，必须返回 fullSyncRequired', async () => {
    // 写入几条变更，使服务端 latestCursor > 0
    await deltaSync.recordChange(testVaultId, { path: 'note1.md', action: 'UPSERT', size: 100, hash: 'h1' });
    await deltaSync.recordChange(testVaultId, { path: 'note2.md', action: 'UPSERT', size: 200, hash: 'h2' });

    const latest = deltaSync.getLatestCursor(testVaultId);
    assert.ok(latest >= 2, 'Latest cursor should be at least 2');

    // 1. since = 0
    const res0 = await deltaSync.getChanges(testVaultId, 0);
    assert.equal(res0.fullSyncRequired, true);
    assert.equal(res0.reason, 'FIRST_SYNC_FULL_SNAPSHOT_REQUIRED');
    assert.equal(res0.cursor, latest);

    // 2. since = -1
    const resNeg = await deltaSync.getChanges(testVaultId, -1);
    assert.equal(resNeg.fullSyncRequired, true);
    assert.equal(resNeg.reason, 'FIRST_SYNC_FULL_SNAPSHOT_REQUIRED');

    // 3. since = null / undefined
    const resNull = await deltaSync.getChanges(testVaultId, null);
    assert.equal(resNull.fullSyncRequired, true);
    assert.equal(resNull.reason, 'FIRST_SYNC_FULL_SNAPSHOT_REQUIRED');
  });

  await t.test('有效历史游标进行增量同步，应准确返回更新记录', async () => {
    const latest = deltaSync.getLatestCursor(testVaultId);
    // 请求 since = latest - 1
    const res = await deltaSync.getChanges(testVaultId, latest - 1);
    assert.equal(res.fullSyncRequired, undefined);
    assert.equal(res.changesCount, 1);
    assert.equal(res.updates.length, 1);
    assert.equal(res.updates[0].path, 'note2.md');
    assert.equal(res.cursor, latest);
  });

  await t.test('客户端已完全对齐 (since === latestCursor) 时，返回空变更', async () => {
    const latest = deltaSync.getLatestCursor(testVaultId);
    const res = await deltaSync.getChanges(testVaultId, latest);
    assert.equal(res.fullSyncRequired, undefined);
    assert.equal(res.changesCount, 0);
    assert.equal(res.hasMore, false);
    assert.deepEqual(res.updates, []);
    assert.deepEqual(res.deletes, []);
    assert.equal(res.cursor, latest);
  });

  await t.test('客户端游标超前服务端时 (since > latestCursor)，触发全量重同步', async () => {
    const latest = deltaSync.getLatestCursor(testVaultId);
    const res = await deltaSync.getChanges(testVaultId, latest + 999);
    assert.equal(res.fullSyncRequired, true);
    assert.equal(res.reason, 'CURSOR_AHEAD_OF_SERVER');
  });

  await t.test('增量追更 compact 选项测试：同一文件多次更新自动去重合并', async () => {
    const compactVaultId = 'test-compact-' + Date.now();
    await deltaSync.recordChange(compactVaultId, { path: 'docA.md', action: 'UPSERT', size: 10, hash: 'hA1' });
    await deltaSync.recordChange(compactVaultId, { path: 'docB.md', action: 'UPSERT', size: 20, hash: 'hB1' });
    await deltaSync.recordChange(compactVaultId, { path: 'docA.md', action: 'UPSERT', size: 15, hash: 'hA2' });
    await deltaSync.recordChange(compactVaultId, { path: 'docB.md', action: 'DELETE' });

    // 未启用 compact: updates 包含 2 条 docA，deletes 包含 1 条 docB，updates 包含 1 条 docB
    const resRaw = await deltaSync.getChanges(compactVaultId, 1, 50, { compact: false });
    assert.equal(resRaw.changesCount, 3); // cursors 2, 3, 4

    // 启用 compact: docA 只保留最新的 hA2，docB 最终为 DELETE
    const resCompact = await deltaSync.getChanges(compactVaultId, 1, 50, { compact: true });
    assert.equal(resCompact.updates.length, 1);
    assert.equal(resCompact.updates[0].path, 'docA.md');
    assert.equal(resCompact.updates[0].hash, 'hA2');
    assert.equal(resCompact.deletes.length, 1);
    assert.equal(resCompact.deletes[0].path, 'docB.md');
  });
});
