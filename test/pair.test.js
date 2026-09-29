const test = require('node:test');
const assert = require('node:assert');
const pairing = require('../src/pairing');

test('Pairing: 创建配对码并在有效期内获取数据', () => {
  const payload = {
    userId: 'user_1',
    vaultId: 'v_100',
    token: 'test_token_123',
    deviceName: 'TestDevice',
    serverUrl: 'http://localhost:3000',
  };

  const { code, expiresAt } = pairing.createPairSession(payload);
  assert.ok(code);
  assert.strictEqual(typeof code, 'string');
  assert.ok(expiresAt > Date.now());

  const retrieved = pairing.getPairSession(code);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.vaultId, 'v_100');
  assert.strictEqual(retrieved.token, 'test_token_123');
});
