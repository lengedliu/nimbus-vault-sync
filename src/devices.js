const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { DATA_DIR, JWT_SECRET } = require('./config');
const JsonDb = require('./jsonDb');
const dbManager = require('./db');
const webhooks = require('./webhooks');

const jsonDb = new JsonDb(path.join(DATA_DIR, 'devices.json'), []);
const revokedJsonDb = new JsonDb(path.join(DATA_DIR, 'revoked_tokens.json'), []);

const legacyTokensJsonDb = new JsonDb(path.join(DATA_DIR, 'api_tokens.json'), []);

let devicesCache = [];
let revokedTokensSet = new Set();

function refreshCacheFromJson() {
  try {
    const rawDevs = jsonDb.read() || [];
    const list = Array.isArray(rawDevs) ? [...rawDevs] : [];
    try {
      const legacy = legacyTokensJsonDb.read() || [];
      if (Array.isArray(legacy)) {
        for (const t of legacy) {
          if (t && t.id && !list.some((d) => d.id === t.id)) {
            list.push({
              id: t.id,
              userId: t.userId || t.user_id,
              deviceName: t.deviceName || t.label || 'Obsidian Device',
              platform: t.platform || 'desktop',
              clientIp: t.clientIp || t.client_ip || '',
              userAgent: t.userAgent || t.user_agent || '',
              token: t.token,
              createdAt: Number(t.createdAt || t.created_at || Date.now()),
              lastActiveAt: Number(t.lastActiveAt || t.lastUsedAt || t.last_used_at || t.createdAt || Date.now()),
              status: t.status || 'active',
            });
          }
        }
      }
    } catch {}
    devicesCache = list;
  } catch {
    devicesCache = [];
  }
  try {
    const list = revokedJsonDb.read() || [];
    revokedTokensSet = new Set(Array.isArray(list) ? list : []);
  } catch {
    revokedTokensSet = new Set();
  }
}

function addRevokedToken(token) {
  if (!token || typeof token !== 'string') return;
  revokedTokensSet.add(token);
  try {
    revokedJsonDb.update((list) => {
      const arr = Array.isArray(list) ? list : [];
      if (!arr.includes(token)) {
        arr.push(token);
      }
      return arr.slice(-2000); // 保留最近 2000 条吊销记录
    });
  } catch (err) {
    console.error('[Devices] Failed to persist revoked token:', err.message);
  }
}

async function loadFromDb() {
  if (dbManager.type === 'json') {
    refreshCacheFromJson();
    return;
  }
  try {
    const rows = await dbManager.queryAll(
      'SELECT id, user_id, label, token, created_at, last_used_at, platform, client_ip, user_agent FROM api_tokens'
    );
    devicesCache = rows.map((r) => ({
      id: r.id,
      userId: r.user_id || r.userId,
      deviceName: r.label || 'Obsidian Device',
      platform: r.platform || 'Unknown',
      clientIp: r.client_ip || r.clientIp || '',
      userAgent: r.user_agent || r.userAgent || '',
      token: r.token,
      createdAt: Number(r.created_at || r.createdAt || Date.now()),
      lastActiveAt: Number(r.last_active_at || r.last_used_at || r.lastActiveAt || Date.now()),
      status: r.status || 'active',
    }));
  } catch (err) {
    refreshCacheFromJson();
  }
}

function listForUser(userId) {
  return devicesCache
    .filter((d) => d.userId === userId && d.status !== 'revoked')
    .sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));
}

function listAll() {
  return devicesCache
    .filter((d) => d.status !== 'revoked')
    .sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));
}

async function generateDeviceToken(user, deviceName = 'Obsidian Client', platform = 'desktop', expiresInDays = 365) {
  const id = crypto.randomBytes(8).toString('hex');
  const durationDays = Number(expiresInDays) > 0 ? Number(expiresInDays) : 365;
  const jti = crypto.randomBytes(8).toString('hex');
  // Long-lived token for dedicated device sync
  const token = jwt.sign(
    { sub: user.id, username: user.username, deviceId: id, deviceName: (deviceName || 'Obsidian Device').trim(), type: 'device', jti },
    JWT_SECRET,
    { expiresIn: durationDays > 0 ? `${durationDays}d` : '3650d' }
  );

  const now = Date.now();
  const record = {
    id,
    userId: user.id,
    deviceName: (deviceName || 'Obsidian Device').trim(),
    platform: platform || 'desktop',
    clientIp: '',
    userAgent: '',
    token,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
  };

  if (dbManager.type === 'json') {
    jsonDb.update((list) => [record, ...(Array.isArray(list) ? list : [])]);
  } else {
    await dbManager.execute(
      'INSERT INTO api_tokens (id, user_id, label, token, created_at, last_used_at, platform, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [record.id, record.userId, record.deviceName, record.token, record.createdAt, record.lastActiveAt, record.platform, record.clientIp, record.userAgent]
    );
  }
  devicesCache = [record, ...devicesCache];

  return record;
}

async function recordActivity(deviceIdOrToken, { clientIp, userAgent, deviceName } = {}) {
  const now = Date.now();
  const existing = devicesCache.find((d) => d.id === deviceIdOrToken || d.token === deviceIdOrToken);
  if (!existing) return false;
  const updatedRecord = {
    ...existing,
    deviceName: deviceName || existing.deviceName,
    clientIp: clientIp || existing.clientIp,
    userAgent: userAgent || existing.userAgent,
    lastActiveAt: now,
  };

  if (dbManager.type === 'json') {
    jsonDb.update((list) => (Array.isArray(list) ? list : []).map((d) => d.id === existing.id ? updatedRecord : d));
  } else {
    await dbManager.execute(
      'UPDATE api_tokens SET label = ?, last_used_at = ?, client_ip = ?, user_agent = ? WHERE id = ?',
      [updatedRecord.deviceName, now, updatedRecord.clientIp, updatedRecord.userAgent, existing.id]
    );
  }
  devicesCache = devicesCache.map((d) => d.id === existing.id ? updatedRecord : d);
  return true;
}

async function regenerateDeviceToken(id, user, expiresInDays = 365, isAdmin = false) {
  const durationDays = Number(expiresInDays) > 0 ? Number(expiresInDays) : 365;
  const now = Date.now();
  let updatedRecord = null;
  let oldToken = null;

  const existing = devicesCache.find((d) => d.id === id && (isAdmin || d.userId === user.id));
  if (existing) {
      oldToken = existing.token;
      const jti = crypto.randomBytes(8).toString('hex');
      const newToken = jwt.sign(
        { sub: existing.userId, username: user.username, deviceId: existing.id, deviceName: existing.deviceName, type: 'device', jti },
        JWT_SECRET,
        { expiresIn: durationDays > 0 ? `${durationDays}d` : '3650d' }
      );
      updatedRecord = {
        ...existing,
        token: newToken,
        createdAt: now,
        status: 'active',
      };
  }

  if (updatedRecord) {
    if (dbManager.type === 'json') {
      jsonDb.update((list) => (Array.isArray(list) ? list : []).map((d) => d.id === id ? updatedRecord : d));
    } else {
      await dbManager.execute(
        'UPDATE api_tokens SET token = ?, created_at = ? WHERE id = ?' + (!isAdmin ? ' AND user_id = ?' : ''),
        !isAdmin ? [updatedRecord.token, updatedRecord.createdAt, id, user.id] : [updatedRecord.token, updatedRecord.createdAt, id]
      );
    }
    devicesCache = devicesCache.map((d) => d.id === id ? updatedRecord : d);
    if (oldToken) {
      addRevokedToken(oldToken);
      try { require('./wsHub').disconnectToken(oldToken, 'token_regenerated'); } catch {}
    }
  }

  return updatedRecord;
}

async function extendDeviceToken(id, user, extendDays = 365, isAdmin = false) {
  const addDays = Number(extendDays) > 0 ? Number(extendDays) : 365;
  let updatedRecord = null;
  let oldToken = null;

  const existing = devicesCache.find((d) => d.id === id && (isAdmin || d.userId === user.id));
  if (existing) {
      const d = existing;
      oldToken = d.token;
      let remainingSecs = 0;
      try {
        const decoded = jwt.decode(d.token);
        if (decoded && decoded.exp) {
          const expMs = decoded.exp * 1000;
          if (expMs > Date.now()) {
            remainingSecs = Math.max(0, Math.round((expMs - Date.now()) / 1000));
          }
        }
      } catch (e) {}

      const totalSecs = remainingSecs + addDays * 86400;
      const jti = crypto.randomBytes(8).toString('hex');
      const newToken = jwt.sign(
        { sub: d.userId, username: user.username, deviceId: d.id, deviceName: d.deviceName, type: 'device', jti },
        JWT_SECRET,
        { expiresIn: `${totalSecs}s` }
      );

      updatedRecord = {
        ...d,
        token: newToken,
        status: 'active',
      };
  }

  if (updatedRecord) {
    if (dbManager.type === 'json') {
      jsonDb.update((list) => (Array.isArray(list) ? list : []).map((d) => d.id === id ? updatedRecord : d));
    } else {
      await dbManager.execute(
        'UPDATE api_tokens SET token = ? WHERE id = ?' + (!isAdmin ? ' AND user_id = ?' : ''),
        !isAdmin ? [updatedRecord.token, id, user.id] : [updatedRecord.token, id]
      );
    }
    devicesCache = devicesCache.map((d) => d.id === id ? updatedRecord : d);
    if (oldToken && oldToken !== updatedRecord.token) {
      addRevokedToken(oldToken);
      try { require('./wsHub').disconnectToken(oldToken, 'token_extended_rotated'); } catch {}
    }
  }

  return updatedRecord;
}

async function revokeDevice(id, userId, isAdmin = false) {
  const existing = devicesCache.find((d) => d.id === id && (isAdmin || d.userId === userId));
  if (!existing) return false;
  if (dbManager.type === 'json') {
    jsonDb.update((list) => (Array.isArray(list) ? list : []).filter((d) => d.id !== id || (!isAdmin && userId && d.userId !== userId)));
  } else {
    await dbManager.execute('DELETE FROM api_tokens WHERE id = ?' + (!isAdmin && userId ? ' AND user_id = ?' : ''), !isAdmin && userId ? [id, userId] : [id]);
  }
  let found = false;
  let revokedToken = null;
  devicesCache = devicesCache.map((d) => {
    if (d.id === id && (isAdmin || d.userId === userId)) {
      found = true;
      revokedToken = d.token;
      return { ...d, status: 'revoked' };
    }
    return d;
  });

  if (revokedToken) {
    addRevokedToken(revokedToken);
  }

  try {
    const wsHub = require('./wsHub');
    wsHub.disconnectDevice(id, 'device_revoked');
    if (revokedToken) wsHub.disconnectToken(revokedToken, 'token_revoked');
  } catch {}

  return found;
}

async function revokeAllForUser(userId) {
  if (!userId) return;
  const userDevs = devicesCache.filter((d) => d.userId === userId);
  if (dbManager.type === 'json') {
    jsonDb.update((list) => (Array.isArray(list) ? list : []).filter((d) => d.userId !== userId));
  } else {
    await dbManager.execute('DELETE FROM api_tokens WHERE user_id = ?', [userId]);
  }
  for (const d of userDevs) {
    if (d.token) {
      addRevokedToken(d.token);
    }
  }

  try {
    const wsHub = require('./wsHub');
    wsHub.disconnectUser(userId, 'all_devices_revoked');
  } catch {}

  devicesCache = devicesCache.map((d) => (d.userId === userId ? { ...d, status: 'revoked' } : d));

  devicesCache = devicesCache.filter((d) => d.userId !== userId);
}

function ensureDeviceRecordFromPayload(token, payload) {
  if (!token || !payload || !payload.deviceId || !payload.sub) return null;
  const existing = devicesCache.find((d) => d.id === payload.deviceId);
  if (existing) return existing;

  const now = Date.now();
  const createdAt = payload.iat ? payload.iat * 1000 : now;
  const record = {
    id: payload.deviceId,
    userId: payload.sub,
    deviceName: (payload.deviceName || payload.label || 'Obsidian Device').trim(),
    platform: payload.platform || 'desktop',
    clientIp: '',
    userAgent: '',
    token,
    createdAt,
    lastActiveAt: now,
    status: 'active',
  };
  devicesCache = [record, ...devicesCache];
  try {
    if (dbManager.type === 'json') {
      jsonDb.update((list) => {
        const arr = Array.isArray(list) ? list : [];
        if (arr.some((d) => d.id === record.id)) return arr;
        return [record, ...arr];
      });
    } else if (dbManager.initialized) {
      dbManager.execute(
        'INSERT INTO api_tokens (id, user_id, label, token, created_at, last_used_at, platform, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [record.id, record.userId, record.deviceName, record.token, record.createdAt, record.lastActiveAt, record.platform, record.clientIp, record.userAgent]
      ).catch(() => {});
    }
  } catch {}
  return record;
}

function isTokenRevoked(token, parsedPayload = null) {
  if (!token) return true;

  // 1. 显式吊销黑名单检查
  if (revokedTokensSet.has(token)) return true;

  // 2. 检查数据库中是否有对应标记为 revoked 的记录
  const record = devicesCache.find((d) => d.token === token);
  if (record && record.status === 'revoked') return true;

  // 3. 检查设备专属令牌状态与轮换一致性
  let payload = parsedPayload;
  if (!payload) {
    try {
      payload = jwt.decode(token);
    } catch {}
  }

  if (payload && payload.deviceId) {
    const dev = devicesCache.find((d) => d.id === payload.deviceId);
    if (dev) {
      // 设备已注销，或者设备当前存储的最新 token 与此 token 不一致（已被重新生成/轮换）
      if (dev.status === 'revoked') return true;
      if (dev.token && dev.token !== token) return true;
    } else if (payload.sub) {
      // 设备记录在缓存中缺失（例如切换数据库引擎或重置了 devices.json），
      // 但该令牌未进入吊销黑名单：当调用方已校验或当前可用 JWT_SECRET 验签通过时，自动自愈补齐设备记录
      let verified = parsedPayload;
      if (!verified) {
        try {
          verified = jwt.verify(token, JWT_SECRET);
        } catch {
          return true;
        }
      }
      ensureDeviceRecordFromPayload(token, verified);
    }
  }

  return false;
}

refreshCacheFromJson();

module.exports = {
  listForUser,
  listAll,
  getRawDevices: () => devicesCache,
  generateDeviceToken,
  regenerateDeviceToken,
  extendDeviceToken,
  recordActivity,
  revokeDevice,
  revokeAllForUser,
  isTokenRevoked,
  loadFromDb,
};
