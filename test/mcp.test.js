const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateOrReservedIp } = require('../src/utils/ssrfGuard');

test('isPrivateOrReservedIp: 应该拦截常见内网/本机/元数据地址', () => {
  const shouldBlock = [
    '127.0.0.1',
    '127.0.0.53',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // 云主机元数据接口
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
  ];
  for (const ip of shouldBlock) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} 应该被判定为内网/保留地址`);
  }
});

test('isPrivateOrReservedIp: 不应该拦截公网地址', () => {
  const shouldAllow = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111'];
  for (const ip of shouldAllow) {
    assert.equal(isPrivateOrReservedIp(ip), false, `${ip} 不应该被拦截`);
  }
});

test('assertSafePublicUrl: 验证协议规范与 URL 有效性', () => {
  const { assertSafePublicUrl } = require('../src/utils/ssrfGuard');
  assert.throws(() => assertSafePublicUrl('file:///etc/passwd'), /仅支持 http: 或 https: 协议/);
  assert.throws(() => assertSafePublicUrl('ftp://example.com/file'), /仅支持 http: 或 https: 协议/);
  assert.throws(() => assertSafePublicUrl('javascript:alert(1)'), /仅支持 http: 或 https: 协议/);
  assert.throws(() => assertSafePublicUrl('not a url'), /无法解析/);

  const parsed = assertSafePublicUrl('https://example.com/test?a=1');
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.protocol, 'https:');
});

test('resolveAndAssertSafeIp: 拒绝解析到内网或保留 IP 的域名', async () => {
  const { resolveAndAssertSafeIp } = require('../src/utils/ssrfGuard');
  await assert.rejects(
    async () => resolveAndAssertSafeIp('localhost', 'http://localhost/test'),
    /目标地址解析到了私有\/保留地址/
  );
  await assert.rejects(
    async () => resolveAndAssertSafeIp('127.0.0.1', 'http://127.0.0.1/test'),
    /目标地址解析到了私有\/保留地址/
  );
});
