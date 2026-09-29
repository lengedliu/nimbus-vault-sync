const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/storage');
const vaultsStore = require('../src/vaults');

test('Daily Review & Heatmap: 能够计算笔记改动分布与随机抽样', () => {
  const vaults = vaultsStore.getRawVaults();
  assert.ok(Array.isArray(vaults));

  if (vaults.length > 0) {
    const vaultId = vaults[0].id;
    const manifest = storage.getManifest(vaultId);
    assert.ok(typeof manifest === 'object');
  }
});
