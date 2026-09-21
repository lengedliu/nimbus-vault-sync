const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-secdiscoveries-'));
const devices = require('../src/devices');
const backups = require('../src/backups');
const vaults = require('../src/vaults');
const users = require('../src/users');

test('Discovery 1: 设备令牌重新生成后旧令牌必须失效，被吊销后也必须失效', async () => {
  const dummyUser = { id: 'u_test_sec_1', username: 'test_sec_user' };
  
  // 1. 生成设备令牌
  const dev = devices.generateDeviceToken(dummyUser, 'Test-MacBook', 'desktop', 30);
  const originalToken = dev.token;
  assert.ok(originalToken, '应该生成原始 token');
  assert.equal(devices.isTokenRevoked(originalToken), false, '刚生成的 token 不应被判定为 revoked');

  // 2. 重新生成令牌 (Regenerate)
  const updatedDev = devices.regenerateDeviceToken(dev.id, dummyUser, 30);
  assert.ok(updatedDev.token, '应该生成新 token');
  assert.notEqual(updatedDev.token, originalToken, '新旧 token 必须不同');

  // 验证：旧 token 必须被判定为已失效
  assert.equal(devices.isTokenRevoked(originalToken), true, '重新生成后，旧 token 必须立即失效');
  // 验证：新 token 应该有效
  assert.equal(devices.isTokenRevoked(updatedDev.token), false, '新 token 应当有效');

  // 3. 吊销设备 (Revoke)
  const revoked = devices.revokeDevice(dev.id, dummyUser.id);
  assert.equal(revoked, true, '应当成功吊销设备');
  assert.equal(devices.isTokenRevoked(updatedDev.token), true, '吊销后新 token 也必须立即失效');
});

test('Discovery 3: 备份快照文件名安全净化与路径穿越防护', async () => {
  // 创建一个测试用的临时 vault
  const dummyOwner = 'u_sec_owner';
  const dummyVault = vaults.create(dummyOwner, 'Test/../../Evil..Vault:Name');
  assert.ok(dummyVault.id);

  try {
    const backup = await backups.createBackup(dummyVault.id, '安全测试快照');
    assert.ok(backup.filename);
    assert.equal(backup.filename.includes('..'), false, '备份文件名绝不可包含 ..');
    assert.equal(backup.filename.includes('/'), false, '备份文件名绝不可包含 /');
    assert.equal(backup.filename.includes('\\'), false, '备份文件名绝不可包含 \\');

    const fileInfo = backups.getBackupFilePath(dummyVault.id, backup.id);
    assert.ok(fileInfo);
    assert.ok(fs.existsSync(fileInfo.fullPath));

    // 非法路径探测必须被安全拦截
    const illegalPath = backups.getBackupFilePath(dummyVault.id, '../../package.json');
    assert.equal(illegalPath, null, '非法穿越参数必须返回 null');

    const deleted = backups.deleteBackup(dummyVault.id, backup.id);
    assert.equal(deleted, true, '正常备份应能安全删除');
  } finally {
    try {
      vaults.deleteVault(dummyVault.id, dummyOwner);
    } catch {}
  }
});

test('Discovery 4: 权限查询与协作者配置生成兼容性测试', async () => {
  const ownerId = 'u_perm_owner';
  const memberId = 'u_perm_member';
  const vault = vaults.create(ownerId, 'PermTestVault');

  try {
    const vaultMembers = require('../src/vaultMembers');
    await vaultMembers.addOrUpdateMember(vault.id, memberId, 'read-write');

    // 1. 验证 getUserPermission
    const ownerPerm = vaults.getUserPermission(ownerId, vault.id, false);
    assert.equal(ownerPerm, 'owner');

    const memberPerm = vaults.getUserPermission(memberId, vault.id, false);
    assert.equal(memberPerm, 'read-write');

    // 2. 验证 hasReadAccess 对协作者有效
    assert.equal(vaults.hasReadAccess(memberId, vault.id, false), true);
    assert.equal(vaults.hasReadAccess('stranger_id', vault.id, false), false);
  } finally {
    try {
      vaults.deleteVault(vault.id, ownerId);
    } catch {}
  }
});

test('Discovery 5: Webhook URL SSRF 防护测试', async () => {
  const webhooks = require('../src/webhooks');

  // 1. 尝试向 127.0.0.1 发送 Webhook 必须被拒绝
  await assert.rejects(
    async () => {
      await webhooks.testWebhook({
        url: 'http://127.0.0.1:3000/api/health',
        platform: 'custom',
      });
    },
    /私有\/保留地址|禁止向内网/,
    '向 127.0.0.1 发送 Webhook 必须被 SSRF 防护拦截'
  );

  // 2. 尝试向 localhost 发送 Webhook 必须被拒绝
  await assert.rejects(
    async () => {
      await webhooks.testWebhook({
        url: 'http://localhost:8080/webhook',
        platform: 'custom',
      });
    },
    /私有\/保留地址|禁止向内网/,
    '向 localhost 发送 Webhook 必须被 SSRF 防护拦截'
  );

  // 3. 保存 Webhook 时：启用状态下验证 URL 地址不能为空；停用状态下允许为空但若填写则验证协议合法
  assert.throws(
    () => webhooks.saveWebhookConfig({ enabled: true, url: '' }),
    /Webhook 回调 URL 地址不能为空/
  );
  assert.throws(
    () => webhooks.saveWebhookConfig({ enabled: true, url: '   ' }),
    /Webhook 回调 URL 地址不能为空/
  );
  assert.throws(
    () => webhooks.saveWebhookConfig({ enabled: false, url: 'ftp://example.com' }),
    /仅支持 http: 或 https: 协议/
  );

  const disabledConfig = webhooks.saveWebhookConfig({ enabled: false, url: '' });
  assert.strictEqual(disabledConfig.enabled, false);
  assert.strictEqual(disabledConfig.url, '');
});

test('Discovery 6: 用户注销级联吊销设备令牌与成员关系', async () => {
  const users = require('../src/users');
  const devices = require('../src/devices');
  const vaultMembers = require('../src/vaultMembers');

  const testUser = { id: 'u_cascade_test', username: 'cascade_user' };
  const dev = devices.generateDeviceToken(testUser, 'Cascade Phone', 'ios');
  assert.equal(devices.isTokenRevoked(dev.token), false);

  await vaultMembers.addOrUpdateMember('vlt_cascade_dummy', testUser.id, 'read-only');
  assert.equal(vaultMembers.listForUser(testUser.id).length >= 1, true);

  // 执行级联清理
  devices.revokeAllForUser(testUser.id);
  await vaultMembers.removeAllForUser(testUser.id);

  // 验证令牌被即时吊销
  assert.equal(devices.isTokenRevoked(dev.token), true);
  // 验证成员关系被即时清除
  assert.equal(vaultMembers.listForUser(testUser.id).length, 0);
});
