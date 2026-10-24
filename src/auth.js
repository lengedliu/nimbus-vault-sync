const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET, TOKEN_TTL } = require('./config');
const users = require('./users');

function signToken(user) {
  const storedUser = users.findById(user.id);
  const passwordVersion = storedUser && storedUser.passwordHash
    ? crypto.createHash('sha256').update(storedUser.passwordHash).digest('hex')
    : undefined;
  return jwt.sign({ sub: user.id, username: user.username, passwordVersion }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Express middleware: requires `Authorization: Bearer <token>` */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized', message: 'Unauthorized', code: 401 });
  const devicesStore = require('./devices');
  if (token && devicesStore.isTokenRevoked(token, payload)) {
    return res.status(401).json({ ok: false, error: '此设备令牌已被注销废除或已重新生成失效', message: '此设备令牌已被注销废除或已重新生成失效', code: 401 });
  }
  let user = users.findById(payload.sub);
  if (!user && payload.deviceId && payload.username === 'admin') {
    user = users.findByUsername('admin');
  }
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized', message: 'Unauthorized', code: 401 });
  if (!payload.deviceId && !payload.passwordVersion) {
    return res.status(401).json({ ok: false, error: '登录凭证已过期，请重新登录', message: '登录凭证已过期，请重新登录', code: 401 });
  }
  if (!payload.deviceId && payload.passwordVersion) {
    const currentVersion = crypto.createHash('sha256').update(user.passwordHash || '').digest('hex');
    if (payload.passwordVersion !== currentVersion) {
      return res.status(401).json({ ok: false, error: '登录凭证已失效，请重新登录', message: '登录凭证已失效，请重新登录', code: 401 });
    }
  }
  req.user = { id: user.id, username: user.username, role: user.role || 'user' };
  next();
}

/** Must be used after requireAuth. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin access required', message: 'Admin access required', code: 403 });
  }
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin };
