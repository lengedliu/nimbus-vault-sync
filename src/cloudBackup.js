const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const { VAULTS_DIR, DATA_DIR } = require('./config');
const { getById: getVaultById } = require('./vaults');
const storage = require('./storage');
const JsonDb = require('./jsonDb');
const { encryptField, decryptField } = require('./utils/crypto');
const { resolvePublicAddresses, createPinnedLookup } = require('./utils/ssrfGuard');

const cloudConfigDb = new JsonDb(path.join(DATA_DIR, 'cloud-backup-config.json'), { vaults: {} });

function getVaultCloudConfig(vaultId) {
  const db = cloudConfigDb.read();
  const config = (db.vaults && db.vaults[vaultId]) || {
    enabled: false,
    provider: 's3', // 's3' | 'webdav'
    autoBackup: false,
    backupIntervalHours: 24,
    retentionCount: 10,
    s3: {
      endpoint: '', // e.g. https://s3.us-east-1.amazonaws.com or https://oss-cn-hangzhou.aliyuncs.com
      region: 'us-east-1',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      pathPrefix: 'nimbus-backups',
    },
    webdav: {
      url: '', // e.g. https://dav.jianguoyun.com/dav/ or https://nas.local:5006/dav/
      username: '',
      password: '',
      pathPrefix: '/nimbus-backups',
    },
    lastBackupAt: null,
    lastBackupStatus: null, // { success: boolean, message: string, time: string }
  };
  const saved = db.vaults && db.vaults[vaultId];
  if (saved) {
    const hasLegacySecret = [saved.s3 && saved.s3.secretAccessKey, saved.webdav && saved.webdav.password]
      .some((value) => typeof value === 'string' && value && !value.startsWith('enc:v1:'));
    if (hasLegacySecret) {
      cloudConfigDb.update((data) => {
        const current = data.vaults && data.vaults[vaultId];
        if (!current) return data;
        if (current.s3 && current.s3.secretAccessKey && !current.s3.secretAccessKey.startsWith('enc:v1:')) {
          current.s3.secretAccessKey = encryptField(current.s3.secretAccessKey);
        }
        if (current.webdav && current.webdav.password && !current.webdav.password.startsWith('enc:v1:')) {
          current.webdav.password = encryptField(current.webdav.password);
        }
        return data;
      });
    }
  }
  return {
    ...config,
    s3: { ...(config.s3 || {}), secretAccessKey: decryptField(config.s3 && config.s3.secretAccessKey) },
    webdav: { ...(config.webdav || {}), password: decryptField(config.webdav && config.webdav.password) },
  };
}

function saveVaultCloudConfig(vaultId, config) {
  const current = getVaultCloudConfig(vaultId);
  const plain = {
    ...config,
    s3: { ...(config.s3 || {}), secretAccessKey: (config.s3 && config.s3.secretAccessKey) || current.s3.secretAccessKey || '' },
    webdav: { ...(config.webdav || {}), password: (config.webdav && config.webdav.password) || current.webdav.password || '' },
  };
  const persisted = {
    ...plain,
    s3: { ...plain.s3, secretAccessKey: encryptField(plain.s3.secretAccessKey) },
    webdav: { ...plain.webdav, password: encryptField(plain.webdav.password) },
  };
  cloudConfigDb.update((data) => {
    if (!data.vaults) data.vaults = {};
    data.vaults[vaultId] = persisted;
    return data;
  });
  return plain;
}

async function validateCloudTarget(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('云备份目标 URL 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('云备份目标仅支持不含内嵌账号信息的 HTTP(S) URL');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = process.env.ALLOW_PRIVATE_CLOUD_BACKUP_TARGETS === 'true'
    ? await dns.lookup(hostname, { all: true })
    : await resolvePublicAddresses(hostname);
  if (!addresses.length) throw new Error('云备份目标域名没有可用地址');
  return { parsed, addresses };
}

async function requestCloudTarget(rawUrl, { method, headers = {}, body = null } = {}) {
  const { parsed, addresses } = await validateCloudTarget(rawUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: method || 'GET',
      headers,
      lookup: createPinnedLookup(addresses),
      timeout: 120000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      const maxResponseBytes = 1024 * 1024;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          request.destroy(new Error('Cloud backup response exceeded 1 MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, text: async () => text });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Cloud backup request timed out')));
    request.on('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}

// --------------------------- AWS SigV4 for S3 ---------------------------
function hmacSha256(key, secret) {
  return crypto.createHmac('sha256', key).update(secret).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmacSha256('AWS4' + key, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function s3Request({ method, url, headers = {}, body = null, accessKeyId, secretAccessKey, region = 'us-east-1' }) {
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const canonicalUri = parsedUrl.pathname || '/';
  const canonicalQuery = parsedUrl.search ? parsedUrl.search.substring(1).split('&').sort().join('&') : '';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.substring(0, 8); // YYYYMMDD

  const payloadHash = body ? sha256Hex(body) : sha256Hex('');

  const reqHeaders = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...headers,
  };

  const sortedHeaderKeys = Object.keys(reqHeaders).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${reqHeaders[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchHeaders = {
    ...reqHeaders,
    Authorization: authorizationHeader,
  };

  const res = await requestCloudTarget(url, {
    method,
    headers: fetchHeaders,
    body,
  });

  return res;
}

// --------------------------- S3 Actions ---------------------------
async function testS3Config(s3Config) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = s3Config;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 配置不完整，请提供 Endpoint, Bucket, Access Key 与 Secret Key');
  }

  const baseEndpoint = endpoint.replace(/\/+$/, '');
  const testUrl = baseEndpoint.includes('{bucket}')
    ? baseEndpoint.replace('{bucket}', bucket) + '?location'
    : `${baseEndpoint}/${bucket}?location`;

  const res = await s3Request({
    method: 'GET',
    url: testUrl,
    accessKeyId,
    secretAccessKey,
    region: region || 'us-east-1',
  });

  if (!res.ok && res.status !== 200) {
    const errText = await res.text();
    throw new Error(`S3 连接失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  return { ok: true, message: 'S3 对象存储连通性测试成功！' };
}

async function uploadToS3(s3Config, objectKey, buffer) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = s3Config;
  const baseEndpoint = endpoint.replace(/\/+$/, '');
  const objectUrl = baseEndpoint.includes('{bucket}')
    ? `${baseEndpoint.replace('{bucket}', bucket)}/${objectKey}`
    : `${baseEndpoint}/${bucket}/${objectKey}`;

  const res = await s3Request({
    method: 'PUT',
    url: objectUrl,
    headers: {
      'content-type': 'application/zip',
    },
    body: buffer,
    accessKeyId,
    secretAccessKey,
    region: region || 'us-east-1',
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`上传文件到 S3 失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  return { ok: true, objectKey, url: objectUrl };
}

// --------------------------- WebDAV Actions ---------------------------
async function testWebDAVConfig(webdavConfig) {
  const { url, username, password } = webdavConfig;
  if (!url) throw new Error('WebDAV 服务端 URL 不能为空');

  const cleanUrl = url.replace(/\/+$/, '');
  const headers = {
    'Depth': '0',
  };
  if (username && password) {
    const authStr = Buffer.from(`${username}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${authStr}`;
  }

  const res = await requestCloudTarget(cleanUrl, {
    method: 'PROPFIND',
    headers,
  });

  if (res.status !== 200 && res.status !== 207) {
    throw new Error(`WebDAV 连接失败 (HTTP ${res.status})，请检查 URL 与账号密码`);
  }

  return { ok: true, message: 'WebDAV 服务端连通性测试成功！' };
}

async function uploadToWebDAV(webdavConfig, remotePath, buffer) {
  const { url, username, password } = webdavConfig;
  const cleanUrl = url.replace(/\/+$/, '');
  const targetUrl = `${cleanUrl}/${remotePath.replace(/^\/+/, '')}`;

  const headers = {
    'Content-Type': 'application/zip',
  };
  if (username && password) {
    const authStr = Buffer.from(`${username}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${authStr}`;
  }

  const res = await requestCloudTarget(targetUrl, {
    method: 'PUT',
    headers,
    body: buffer,
  });

  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`WebDAV 上传失败 (HTTP ${res.status})`);
  }

  return { ok: true, targetUrl };
}

// --------------------------- Core High-Level Cloud Backup Execute ---------------------------
async function runVaultCloudBackup(vaultId, label = '多云容灾备份') {
  const config = getVaultCloudConfig(vaultId);
  if (!config || !config.enabled) {
    throw new Error('未开启多云容灾备份');
  }

  const vault = getVaultById(vaultId);
  if (!vault) throw new Error(`Vault 不存在: ${vaultId}`);

  // Create temporary in-memory or file ZIP snapshot
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${vault.name || vaultId}_snapshot_${timestamp}.zip`;

  const zipPath = path.join(DATA_DIR, `.temp_${filename}`);
  try {
    await storage.createVaultZipSnapshot(vaultId, zipPath, label);
    const buffer = fs.readFileSync(zipPath);

    let result = null;
    if (config.provider === 's3') {
      const prefix = (config.s3.pathPrefix || 'nimbus-backups').replace(/\/+$/, '');
      const objectKey = `${prefix}/${filename}`;
      result = await uploadToS3(config.s3, objectKey, buffer);
    } else if (config.provider === 'webdav') {
      const prefix = (config.webdav.pathPrefix || 'nimbus-backups').replace(/\/+$/, '');
      const remotePath = `${prefix}/${filename}`;
      result = await uploadToWebDAV(config.webdav, remotePath, buffer);
    } else {
      throw new Error(`不支持的云存储服务商: ${config.provider}`);
    }

    config.lastBackupAt = new Date().toISOString();
    config.lastBackupStatus = {
      success: true,
      message: `成功推送到 ${config.provider.toUpperCase()} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`,
      time: config.lastBackupAt,
      filename,
    };
    saveVaultCloudConfig(vaultId, config);

    return {
      ok: true,
      filename,
      provider: config.provider,
      size: buffer.length,
      time: config.lastBackupAt,
      result,
    };
  } catch (err) {
    config.lastBackupAt = new Date().toISOString();
    config.lastBackupStatus = {
      success: false,
      message: err.message,
      time: config.lastBackupAt,
    };
    saveVaultCloudConfig(vaultId, config);
    throw err;
  } finally {
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {}
  }
}

module.exports = {
  getVaultCloudConfig,
  saveVaultCloudConfig,
  testS3Config,
  testWebDAVConfig,
  runVaultCloudBackup,
};
