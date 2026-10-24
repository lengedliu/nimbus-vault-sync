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
    const configuredPassword = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
    if (configuredPassword && configuredPassword.length < 6) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be at least 6 characters long.');
    }
    try {
      const initialPassword = configuredPassword || 'admin123';
      const passwordHash = await bcrypt.hash(initialPassword, 10);
      const user = {
        id: uuid(),
        username: 'admin',
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString(),
      };
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
      usersCache.push(user);
      if (configuredPassword) {
        console.log('[Users] 初始管理员账号已创建，密码已通过环境变量注入');
      } else {
        console.warn('[Users] 未配置 INITIAL_ADMIN_PASSWORD，已创建默认管理员账号 (admin / admin123)，请登录后尽快修改密码');
      }
    } catch (err) {
      console.error('[Users] 自动初始化 admin 失败:', err.message);
      throw err;
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

  // Write through to active DB backend
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
  usersCache.push(user);

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
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).map((u) => (u.id === userId ? { ...u, passwordHash } : u));
      return data;
    });
  } else {
    await dbManager.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  }
  user.passwordHash = passwordHash;

  // Disconnect active real-time sync sessions after the new password is durable.
  try {
    const wsHub = require('./wsHub');
    wsHub.disconnectUser(userId, 'password_changed');
  } catch {}
  return true;
}

async function updateUser(userId, { password, role }) {
  const user = findById(userId);
  if (!user) throw new Error('User not found');

  const updated = { ...user };
  if (role && (role === 'admin' || role === 'user')) updated.role = role;

  const passwordChanged = !!(password && password.trim());
  if (passwordChanged) {
    updated.passwordHash = await bcrypt.hash(password, 10);
  }

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).map((u) => (u.id === userId ? { ...updated } : u));
      return data;
    });
  } else {
    await dbManager.execute('UPDATE users SET password_hash = ?, role = ? WHERE id = ?', [
      updated.passwordHash,
      updated.role,
      userId,
    ]);
  }

  Object.assign(user, updated);
  if (passwordChanged) {
    try {
      const wsHub = require('./wsHub');
      wsHub.disconnectUser(userId, 'password_changed_by_admin');
    } catch {}
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

async function remove(userId) {
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.users = (data.users || []).filter((u) => u.id !== userId);
      return data;
    });
  } else {
    await dbManager.execute('DELETE FROM users WHERE id = ?', [userId]);
  }
  usersCache = usersCache.filter((u) => u.id !== userId);
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
