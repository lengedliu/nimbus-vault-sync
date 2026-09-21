const net = require('node:net');
const dns = require('node:dns').promises;

/**
 * 判断一个 IPv4/IPv6 地址是否落在内网/本机/链路本地/云主机元数据等
 * 不该被服务器主动发起请求访问的范围内。
 *
 * 独立成一个零依赖模块，方便单元测试，也方便未来任何"服务器代用户去请求
 * 一个用户提供的 URL"的功能（webhook、附件抓取等）复用同一份判断逻辑。
 */
function isPrivateOrReservedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local, includes cloud metadata 169.254.169.254
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1 — unwrap and check the embedded IPv4.
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    }
    return false;
  }
  return true; // couldn't parse — fail closed
}

function assertSafePublicUrl(targetUrl, contextName = 'URL') {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(`无法解析的 ${contextName}: "${targetUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${contextName} 仅支持 http: 或 https: 协议`);
  }
  return parsed;
}

/**
 * 校验指定 hostname 的所有解析地址，确保均不为私有/内网/保留 IP。
 * 返回首个有效解析的 IP（可供直接发起网络请求，避免二次 DNS 解析产生 DNS Rebinding）。
 */
async function resolveAndAssertSafeIp(hostname, targetUrlForError) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`无法解析主机 "${hostname}": ${e.message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`主机 "${hostname}" 未解析到有效 IP 地址`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(
        `拒绝请求目标 "${targetUrlForError || hostname}": 目标地址解析到了私有/保留地址 (${address})。禁止向内网地址发送网络请求。`
      );
    }
  }
  return addresses[0].address;
}

module.exports = { isPrivateOrReservedIp, assertSafePublicUrl, resolveAndAssertSafeIp };
