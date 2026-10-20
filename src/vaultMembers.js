const path = require('path');
const { v4: uuid } = require('uuid');
const JsonDb = require('./jsonDb');
const { DATA_DIR } = require('./config');
const dbManager = require('./db');

const MEMBERS_FILE = path.join(DATA_DIR, 'vault_members.json');
const jsonDb = new JsonDb(MEMBERS_FILE, { members: [] });

let membersCache = [];

function refreshCacheFromJson() {
  try {
    membersCache = jsonDb.read().members || [];
  } catch {
    membersCache = [];
  }
}

async function loadFromDb() {
  if (dbManager.type === 'json') {
    refreshCacheFromJson();
    return;
  }
  try {
    const rows = await dbManager.queryAll('SELECT id, vault_id, user_id, permission, created_at FROM vault_members');
    membersCache = rows.map((r) => ({
      id: r.id,
      vaultId: r.vault_id || r.vaultId,
      userId: r.user_id || r.userId,
      permission: r.permission || 'read-write',
      createdAt: r.created_at || r.createdAt || Date.now(),
    }));
  } catch (err) {
    console.error('[VaultMembers] Error loading from SQL database, fallback to JSON:', err.message);
    refreshCacheFromJson();
  }
}

function listForVault(vaultId) {
  return membersCache.filter((m) => m.vaultId === vaultId);
}

function listForUser(userId) {
  return membersCache.filter((m) => m.userId === userId);
}

function getMember(vaultId, userId) {
  return membersCache.find((m) => m.vaultId === vaultId && m.userId === userId);
}

async function addOrUpdateMember(vaultId, userId, permission = 'read-write') {
  const existing = membersCache.find((m) => m.vaultId === vaultId && m.userId === userId);
  const now = Date.now();
  const updated = existing
    ? { ...existing, permission }
    : { id: uuid(), vaultId, userId, permission, createdAt: now };

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.members = data.members || [];
      const idx = data.members.findIndex((m) => m.vaultId === vaultId && m.userId === userId);
      if (idx >= 0) data.members[idx] = updated;
      else data.members.push(updated);
      return data;
    });
  } else {
    try {
      if (dbManager.type === 'sqlite') {
        await dbManager.execute(
          `INSERT INTO vault_members (id, vault_id, user_id, permission, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(vault_id, user_id) DO UPDATE SET permission = excluded.permission`,
          [updated.id, vaultId, userId, permission, updated.createdAt]
        );
      } else if (dbManager.type === 'postgres') {
        await dbManager.execute(
          `INSERT INTO vault_members (id, vault_id, user_id, permission, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (vault_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
          [updated.id, vaultId, userId, permission, updated.createdAt]
        );
      } else if (dbManager.type === 'mysql') {
        await dbManager.execute(
          `INSERT INTO vault_members (id, vault_id, user_id, permission, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE permission = VALUES(permission)`,
          [updated.id, vaultId, userId, permission, updated.createdAt]
        );
      }
    } catch (err) { throw err; }
  }

  if (existing) membersCache = membersCache.map((m) => m.id === existing.id ? updated : m);
  else membersCache.push(updated);
  return updated;
}

async function removeMember(vaultId, userId) {
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.members = (data.members || []).filter((m) => !(m.vaultId === vaultId && m.userId === userId));
      return data;
    });
  } else {
    await dbManager.execute('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?', [vaultId, userId]);
  }
  membersCache = membersCache.filter((m) => !(m.vaultId === vaultId && m.userId === userId));
}

async function removeAllForVault(vaultId) {
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.members = (data.members || []).filter((m) => m.vaultId !== vaultId);
      return data;
    });
  } else {
    await dbManager.execute('DELETE FROM vault_members WHERE vault_id = ?', [vaultId]);
  }
  membersCache = membersCache.filter((m) => m.vaultId !== vaultId);
}

async function removeAllForUser(userId) {
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.members = (data.members || []).filter((m) => m.userId !== userId);
      return data;
    });
  } else {
    await dbManager.execute('DELETE FROM vault_members WHERE user_id = ?', [userId]);
  }
  membersCache = membersCache.filter((m) => m.userId !== userId);
}

refreshCacheFromJson();

module.exports = {
  loadFromDb,
  listForVault,
  listForUser,
  getMember,
  addOrUpdateMember,
  removeMember,
  removeAllForVault,
  removeAllForUser,
  getRawMembers: () => membersCache,
};
