const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const JsonDb = require('./jsonDb');
const { USERS_FILE } = require('./config');
const dbManager = require('./db');

const jsonDb = new JsonDb(USERS_FILE, { users: [] });

// Sync in-memory cache for fast lookups and auth tokens
let usersCache = [];

function refreshCacheFromJson() {
  try {
    usersCache = jsonDb.read().users || [];
  } catch {
    usersCache = [];
  }
}

async function loadFromDb() {
  if (dbManager.type === 'json') {
    refreshCacheFromJson();
    await ensureDefaultAdmin();
    return;
  }
  try {
    const rows = await dbManager.queryAll('SELECT id, username, password_hash, role, created_at FROM users');
    usersCache = rows.map((r) => ({
      id: r.id,
      username: r.username,
      passwordHash: r.password_hash || r.passwordHash,
      role: r.role,
      createdAt: r.created_at || r.createdAt,
    }));
    await ensureDefaultAdmin();
  } catch (err) {
    console.error('[Users] Error loading users from SQL database, falling back to JSON:', err.message);
    refreshCacheFromJson();
    await ensureDefaultAdmin();
  }
}

async function ensureDefaultAdmin() {
  if (!findByUsername('admin')) {
    try {
      const initialPassword = (process.env.INITIAL_ADMIN_PASSWORD || 'admin123').trim();
      const passwordHash = await bcrypt.hash(initialPassword, 10);
      const user = {
        id: uuid(),
        username: 'admin',
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString(),
      };
      usersCache.push(user);
      if (dbManager.type === 'json') {
        jsonDb.update((data) => {
          data.users = data.users || [];
          data.users.push(user);
          return data;
        });
      } else {
        await dbManager.execute(
          'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
          [user.id, user.username, user.passwordHash, user.role, user.createdAt]
        );
      }
      if (initialPassword === 'admin123') {
        console.warn('⚠️ [安全警报] 初始管理员账号已创建: 用户名 admin, 默认密码 admin123 (高风险！请尽快在后台修改密码！)');
      } else {
        console.log('[Users] 初始管理员账号已创建，密码已通过环境变量注入');
      }
    } catch (err) {
      console.error('[Users] 自动初始化 admin 失败:', err.message);
    }
  }
}

async function isDefaultAdminPassword() {
  const admin = findByUsername('admin');
  if (!admin || !admin.passwordHash) return false;
  try {
    return await bcrypt.compare('admin123', admin.passwordHash);
  } catch {
    return false;
  }
}

function findByUsername(username) {
  return usersCache.find((u) => u.username === username);
}

function findById(id) {
  return usersCache.find((u) => u.id === id);
}

async function createUser(username, password, role) {
  if (findByUsername(username)) {
    throw new Error(`User "${username}" already exists`);
  }
  const isFirstUser = !hasAnyUser();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuid(),
    username,
    passwordHash,
    role: role || (isFirstUser ? 'admin' : 'user'),
    createdAt: new Date().toISOString(),
  };

  usersCache.push(user);

  // Write through to active DB backend
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = data.users || [];
      data.users.push(user);
      return data;
    });
  } else {
    dbManager
      .execute(
        'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.username, user.passwordHash, user.role, user.createdAt]
      )
      .catch((err) => console.error('[Users] DB insert user error:', err));
  }

  return { id: user.id, username: user.username, role: user.role };
}

async function verifyPassword(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? { id: user.id, username: user.username, role: user.role || 'user' } : null;
}

async function updatePassword(userId, newPassword) {
  const user = findById(userId);
  if (!user) throw new Error('User not found');
  const passwordHash = await bcrypt.hash(newPassword, 10);
  user.passwordHash = passwordHash;

  // Disconnect any active real-time sync sessions for this user so they must re-authenticate
  try {
    const wsHub = require('./wsHub');
    wsHub.disconnectUser(userId, 'password_changed');
  } catch {}

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).map((u) => (u.id === userId ? { ...u, passwordHash } : u));
      return data;
    });
  } else {
    dbManager
      .execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId])
      .catch((err) => console.error('[Users] DB update password error:', err));
  }
  return true;
}

async function updateUser(userId, { password, role }) {
  const user = findById(userId);
  if (!user) throw new Error('User not found');

  if (role && (role === 'admin' || role === 'user')) {
    user.role = role;
  }

  const passwordChanged = !!(password && password.trim());
  if (passwordChanged) {
    user.passwordHash = await bcrypt.hash(password, 10);
    try {
      const wsHub = require('./wsHub');
      wsHub.disconnectUser(userId, 'password_changed_by_admin');
    } catch {}
  }

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).map((u) => (u.id === userId ? { ...user } : u));
      return data;
    });
  } else {
    dbManager
      .execute('UPDATE users SET password_hash = ?, role = ? WHERE id = ?', [
        user.passwordHash,
        user.role,
        userId,
      ])
      .catch((err) => console.error('[Users] DB update user error:', err));
  }

  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

function listAll() {
  return usersCache.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role || 'user',
    createdAt: u.createdAt,
  }));
}

function remove(userId) {
  usersCache = usersCache.filter((u) => u.id !== userId);

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).filter((u) => u.id !== userId);
      return data;
    });
  } else {
    dbManager
      .execute('DELETE FROM users WHERE id = ?', [userId])
      .catch((err) => console.error('[Users] DB delete user error:', err));
  }
}

function hasAnyUser() {
  return usersCache.length > 0;
}

// Initial sync on module load
refreshCacheFromJson();

module.exports = {
  findByUsername,
  findById,
  createUser,
  updateUser,
  verifyPassword,
  updatePassword,
  hasAnyUser,
  isDefaultAdminPassword,
  listAll,
  remove,
  loadFromDb,
  getRawUsers: () => usersCache,
};
