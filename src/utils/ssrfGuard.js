const net = require('node:net');
const dns = require('node:dns').promises;

async function resolvePublicAddresses(hostname) {
  const normalizedHost = String(hostname || '').replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await dns.lookup(normalizedHost, { all: true });
  } catch (err) {
    throw new Error(`Could not resolve host "${normalizedHost}": ${err.message}`);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    const blocked = addresses.find(({ address }) => isPrivateOrReservedIp(address));
    throw new Error(blocked
      ? `Host "${normalizedHost}" resolves to a private/internal address (${blocked.address}), 私有/保留地址。`
      : `Host "${normalizedHost}" did not resolve to a usable address.`);
  }
  return addresses;
}

function createPinnedLookup(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('At least one validated DNS address is required.');
  }
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
}

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
    if (a === 192 && b === 0) return true; // protocol assignments and documentation ranges
    if (a === 192 && b === 2) return true; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // TEST-NET-2
    if (a === 203 && b === 0) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower === '::') return true; // unspecified
    if (lower.startsWith('2001:db8:')) return true; // documentation range
    if (lower.startsWith('ff')) return true; // multicast
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

module.exports = { isPrivateOrReservedIp, resolvePublicAddresses, createPinnedLookup };
