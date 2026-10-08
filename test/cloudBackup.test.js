const test = require('node:test');
const assert = require('node:assert');
const cloudBackup = require('../src/cloudBackup');

test('Cloud Backup: 保存与读取 Vault 多云容灾配置', () => {
  const vaultId = 'test_vault_dr_1';
  const newConfig = {
    enabled: true,
    provider: 's3',
    s3: {
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-nimbus-bucket',
      region: 'cn-hangzhou',
      accessKeyId: 'LTAI5testKey',
      secretAccessKey: 'testSecretKey123',
      pathPrefix: 'vault-backups',
    },
    webdav: {
      url: 'https://dav.jianguoyun.com/dav/',
      username: 'user@example.com',
      password: 'app-password',
      pathPrefix: '/nimbus-backups',
    },
    lastBackupAt: null,
    lastBackupStatus: null,
  };

  cloudBackup.saveVaultCloudConfig(vaultId, newConfig);

  const loaded = cloudBackup.getVaultCloudConfig(vaultId);
  assert.strictEqual(loaded.enabled, true);
  assert.strictEqual(loaded.provider, 's3');
  assert.strictEqual(loaded.s3.bucket, 'my-nimbus-bucket');
  assert.strictEqual(loaded.s3.region, 'cn-hangzhou');
});
