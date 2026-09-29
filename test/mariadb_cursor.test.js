const test = require('node:test');
const assert = require('node:assert');
const dbManager = require('../src/db');

test('MariaDB/MySQL keyword sanitization: cursor 规范化转义且不产生双反引号', () => {
  const origType = dbManager.type;
  dbManager.type = 'mysql';

  const sql1 = 'SELECT MAX(cursor) as maxCursor FROM vault_changes WHERE vault_id = ?';
  const clean1 = dbManager._sanitizeSql(sql1);
  assert.strictEqual(clean1, 'SELECT MAX(`cursor`) as maxCursor FROM vault_changes WHERE vault_id = ?');

  const sql2 = 'INSERT INTO vault_changes (vault_id, `cursor`, path) VALUES (?, ?, ?)';
  const clean2 = dbManager._sanitizeSql(sql2);
  assert.strictEqual(clean2, 'INSERT INTO vault_changes (vault_id, `cursor`, path) VALUES (?, ?, ?)');
  assert.ok(!clean2.includes('``cursor``'));

  dbManager.type = 'postgres';
  const cleanPg = dbManager._sanitizeSql('SELECT `cursor` FROM vault_changes');
  assert.strictEqual(cleanPg, 'SELECT "cursor" FROM vault_changes');

  dbManager.type = origType;
});
