const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-deltasync-'));
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

  await t.test('SQL 存储模式下持久化、内存重启恢复与溢出回查测试', async () => {
    const dbManager = require('../src/db');
    const sqlVaultId = 'test-sql-vault-' + Date.now();
    const testSqlitePath = path.join(__dirname, '../data/test_deltasync_' + Date.now() + '.sqlite');

    // 临时初始化 SQLite 引擎
    const prevType = dbManager.type;
    await dbManager.init({ type: 'sqlite', sqlitePath: testSqlitePath });

    try {
      // 1. 批量记录变更
      await deltaSync.recordBatchChanges(sqlVaultId, [
        { path: 'file1.md', action: 'UPSERT', size: 100, hash: 'h1' },
        { path: 'file2.md', action: 'UPSERT', size: 200, hash: 'h2' },
        { path: 'file3.md', action: 'DELETE' },
      ]);

      const cursorBefore = deltaSync.getLatestCursor(sqlVaultId);
      assert.equal(cursorBefore, 3);

      // 验证数据库中有 3 条记录
      const rows = await dbManager.queryAll('SELECT * FROM vault_changes WHERE vault_id = ?', [sqlVaultId]);
      assert.equal(rows.length, 3);

      // 2. 清理内存缓存模拟服务重启
      deltaSync.clearCache();
      assert.equal(deltaSync.vaultState.has(sqlVaultId), false);

      // 重新 initVault，应自动从 SQL 数据库恢复最新游标与近期变更
      await deltaSync.initVault(sqlVaultId);
      const cursorAfter = deltaSync.getLatestCursor(sqlVaultId);
      assert.equal(cursorAfter, 3, '重启后游标应从数据库完整恢复为 3');

      // 3. 测试从持久化层回查 (强制绕过内存环通过 since=0/fallback)
      const queryRes = await deltaSync.getChanges(sqlVaultId, 1, 10);
      assert.equal(queryRes.changesCount, 2); // cursors 2 and 3
      assert.equal(queryRes.updates.length, 1);
      assert.equal(queryRes.updates[0].path, 'file2.md');
      assert.equal(queryRes.deletes.length, 1);
      assert.equal(queryRes.deletes[0].path, 'file3.md');

      // 4. 测试 getAllChangesForMigration 导出
      const migrationChanges = await deltaSync.getAllChangesForMigration();
      assert.ok(Array.isArray(migrationChanges));
      const forThisVault = migrationChanges.filter((c) => c.vaultId === sqlVaultId);
      assert.equal(forThisVault.length, 3);
      assert.equal(forThisVault[0].path, 'file1.md');
    } finally {
      // 清理测试临时 SQLite 文件
      if (fs.existsSync(testSqlitePath)) {
        try { fs.unlinkSync(testSqlitePath); } catch {}
      }
      // 恢复原引擎
      await dbManager.init({ type: prevType });
      deltaSync.clearCache();
    }
  });

  await t.test('DDL 验证：PostgreSQL 与 MySQL 表结构定义中包含 vault_changes 及联合索引', async () => {
    const dbFileContent = fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8');

    // 验证 PostgreSQL 表结构与索引定义
    assert.match(dbFileContent, /_createPostgresTables\s*\(\)\s*\{[\s\S]*?CREATE TABLE IF NOT EXISTS vault_changes\s*\(/);
    assert.match(dbFileContent, /_createPostgresTables\s*\(\)\s*\{[\s\S]*?idx_vault_changes_cursor/);
    assert.match(dbFileContent, /_createPostgresTables\s*\(\)\s*\{[\s\S]*?idx_vault_changes_created/);

    // 验证 MySQL 表结构与索引定义
    assert.match(dbFileContent, /_createMysqlTables\s*\(\)\s*\{[\s\S]*?CREATE TABLE IF NOT EXISTS vault_changes\s*\(/);
    assert.match(dbFileContent, /_createMysqlTables\s*\(\)\s*\{[\s\S]*?INDEX idx_vault_changes_cursor/);
    assert.match(dbFileContent, /_createMysqlTables\s*\(\)\s*\{[\s\S]*?INDEX idx_vault_changes_created/);
  });
});
