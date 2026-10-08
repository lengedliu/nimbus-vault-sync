const express = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const users = require('../users');
const vaultsStore = require('../vaults');
const vaultMembers = require('../vaultMembers');
const sharesStore = require('../shares');
const syncRulesStore = require('../syncRules');
const settingsManager = require('../settings');
const syncLogger = require('../syncLogger');
const devicesStore = require('../devices');
const deltaSync = require('../deltaSync');
const dbManager = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/users', (req, res) => {
  const allUsers = users.listAll();
  const allVaults = vaultsStore.getRawVaults();
  const vaultMap = Object.fromEntries(allVaults.map((v) => [v.id, v.name]));

  const usersWithVaults = allUsers.map((u) => {
    const memberships = vaultMembers.listForUser(u.id).map((m) => ({
      vaultId: m.vaultId,
      vaultName: vaultMap[m.vaultId] || m.vaultId,
      permission: m.permission,
    }));
    const owned = allVaults.filter((v) => v.ownerId === u.id).map((v) => ({
      vaultId: v.id,
      vaultName: v.name,
      permission: 'owner',
    }));
    return {
      ...u,
      memberships,
      ownedVaults: owned,
      totalAccessibleVaults: memberships.length + owned.length,
    };
  });

  res.json({ users: usersWithVaults });
});

router.post('/users', asyncHandler(async (req, res) => {
  const { username, password, role, vaultAssignments } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password.length < 6) return res.status(400).json({ error: '密码长度至少需要 6 位' });
  try {
    const user = await users.createUser(username, password, role === 'admin' ? 'admin' : 'user');

    if (Array.isArray(vaultAssignments) && vaultAssignments.length > 0) {
      for (const item of vaultAssignments) {
        if (item && item.vaultId) {
          const perm = item.permission === 'read-only' ? 'read-only' : 'read-write';
          await vaultMembers.addOrUpdateMember(item.vaultId, user.id, perm);
        }
      }
    }

    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.put('/users/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { password, role, vaultAssignments } = req.body || {};
  const user = users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Self-demotion check: prevent admin from accidentally removing their own admin role
  if (userId === req.user.id && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot demote your own admin account' });
  }

  try {
    const updatedUser = await users.updateUser(userId, {
      password: password && password.trim() ? password.trim() : undefined,
      role: role === 'admin' ? 'admin' : (role === 'user' ? 'user' : undefined),
    });

    // If vaultAssignments provided, update vault memberships as well
    if (Array.isArray(vaultAssignments)) {
      const current = vaultMembers.listForUser(userId);
      for (const c of current) {
        await vaultMembers.removeMember(c.vaultId, userId);
      }
      for (const item of vaultAssignments) {
        if (item && item.vaultId) {
          const v = vaultsStore.getById(item.vaultId);
          if (v && v.ownerId !== userId) {
            const perm = item.permission === 'read-only' ? 'read-only' : 'read-write';
            await vaultMembers.addOrUpdateMember(item.vaultId, userId, perm);
          }
        }
      }
    }

    res.json({ ok: true, user: updatedUser });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.put('/users/:userId/password', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body || {};
  const user = users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码长度至少需要 6 位' });
  }
  const updatedUser = await users.updateUser(userId, { password: password.trim() });
  res.json({ ok: true, user: updatedUser });
}));

router.get('/users/:userId/vaults', (req, res) => {
  const { userId } = req.params;
  const user = users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const allVaults = vaultsStore.getRawVaults();
  const memberships = vaultMembers.listForUser(userId);
  const memMap = Object.fromEntries(memberships.map((m) => [m.vaultId, m.permission]));

  const vaultsList = allVaults.map((v) => ({
    id: v.id,
    name: v.name,
    ownerId: v.ownerId,
    isOwner: v.ownerId === userId,
    assigned: v.ownerId === userId || !!memMap[v.id],
    permission: v.ownerId === userId ? 'owner' : (memMap[v.id] || 'read-write'),
  }));

  res.json({ user, vaults: vaultsList });
});

router.put('/users/:userId/vaults', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { vaultAssignments } = req.body || {};
  const user = users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const current = vaultMembers.listForUser(userId);
  for (const c of current) {
    await vaultMembers.removeMember(c.vaultId, userId);
  }

  if (Array.isArray(vaultAssignments)) {
    for (const item of vaultAssignments) {
      if (item && item.vaultId) {
        const v = vaultsStore.getById(item.vaultId);
        if (v && v.ownerId !== userId) {
          const perm = item.permission === 'read-only' ? 'read-only' : 'read-write';
          await vaultMembers.addOrUpdateMember(item.vaultId, userId, perm);
        }
      }
    }
  }

  res.json({ ok: true, memberships: vaultMembers.listForUser(userId) });
}));

router.delete('/users/:userId', express.json(), asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account here." });
  }

  const targetUser = users.findById(userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  // 支持通过 query 参数或 request body 指定对该用户拥有的 Vaults 的处置策略：
  // 1. 'transfer' (默认): 自动转让给系统管理员 (Admin)，保留数据和访问配置
  // 2. 'cascade_delete' / 'delete' / 'destroy': 级联销毁该用户拥有的所有 Vaults 及其全部历史、成员、变更与磁盘数据
  const actionParam = (req.query.vaultAction || req.query.action || (req.body && (req.body.vaultAction || req.body.action)) || 'transfer').toLowerCase();
  const isCascadeDelete = actionParam === 'cascade_delete' || actionParam === 'delete' || actionParam === 'destroy';

  const ownedVaults = vaultsStore.listOwnedByUser(userId);
  const transferredVaults = [];
  const deletedVaults = [];

  if (isCascadeDelete) {
    // 级联彻底销毁所有名下 Vaults
    for (const v of ownedVaults) {
      await vaultsStore.remove(v.id);
      deletedVaults.push({ id: v.id, name: v.name });
    }
  } else {
    // 自动转让所有权给系统管理员（优先使用指定的 transferToUserId，否则转给当前操作管理员或首个可用管理员）
    let targetAdminId = req.query.transferToUserId || (req.body && req.body.transferToUserId) || req.user.id;
    const targetAdminUser = users.findById(targetAdminId);
    if (!targetAdminUser || targetAdminUser.id === userId) {
      const fallbackAdmin = users.listAll().find((u) => u.role === 'admin' && u.id !== userId);
      targetAdminId = fallbackAdmin ? fallbackAdmin.id : req.user.id;
    }

    for (const v of ownedVaults) {
      await vaultsStore.transferOwnership(v.id, targetAdminId);
      transferredVaults.push({ id: v.id, name: v.name, transferredTo: targetAdminId });
    }
  }

  // 2. 撤销该用户所有活跃的设备与 API 令牌
  devicesStore.revokeAllForUser(userId);

  // 3. 移除该用户在所有库中的成员资格
  await vaultMembers.removeAllForUser(userId);

  // 4. 清理该用户创建的所有分享外链
  await sharesStore.removeAllForUser(userId);

  // 5. 断开该用户的 WebSocket 实时连接
  const fnsHub = req.app.get('fnsHub');
  if (fnsHub) {
    try {
      fnsHub.disconnectUser(userId, 'user_deleted');
    } catch {}
  }

  // 6. 删除用户账号记录
  users.remove(userId);

  res.json({
    ok: true,
    action: isCascadeDelete ? 'cascade_delete' : 'transfer',
    transferredVaults,
    deletedVaults,
    message: isCascadeDelete
      ? `用户已删除，其名下的 ${deletedVaults.length} 个库已级联销毁`
      : `用户已删除，其名下的 ${transferredVaults.length} 个库已转让给管理员`,
  });
}));

// All vaults across all users, with owner username attached — for the admin dashboard.
router.get('/vaults', (req, res) => {
  const allUsers = users.listAll();
  const byId = Object.fromEntries(allUsers.map((u) => [u.id, u.username]));
  const all = vaultsStore.getRawVaults();
  const withOwner = all.map((v) => ({ ...v, ownerUsername: byId[v.ownerId] || '(unknown)' }));
  res.json({ vaults: withOwner });
});

// ---------------------- Database Management Endpoints ----------------------

router.get('/database/status', asyncHandler(async (req, res) => {
  try {
    const status = dbManager.getStatus();
    const stats = {
      usersCount: users.listAll().length,
      vaultsCount: users.listAll().flatMap((u) => vaultsStore.listForUser(u.id)).length,
      sharesCount: sharesStore.getRawShares().length,
    };
    res.json({ ...status, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

router.post('/database/test', asyncHandler(async (req, res) => {
  const config = req.body || {};
  try {
    const result = await dbManager.testConnection(config);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

router.post('/database/switch', asyncHandler(async (req, res) => {
  const config = req.body || {};
  const migrateExisting = Boolean(req.body.migrateExisting);

  try {
    // Snapshot current memory state before switching if migration requested
    const dataset = {
      users: users.getRawUsers ? users.getRawUsers() : [],
      vaults: vaultsStore.getRawVaults ? vaultsStore.getRawVaults() : [],
      vaultMembers: vaultMembers.getRawMembers ? vaultMembers.getRawMembers() : [],
      shares: sharesStore.getRawShares ? sharesStore.getRawShares() : [],
      syncRules: syncRulesStore.getRawRules ? syncRulesStore.getRawRules() : (syncRulesStore.getAllRules ? syncRulesStore.getAllRules() : {}),
      systemSettings: settingsManager.getSystemSettings ? settingsManager.getSystemSettings() : {},
      apiTokens: settingsManager.getAllTokens ? settingsManager.getAllTokens() : [],
      syncLogs: syncLogger.getRawLogs ? syncLogger.getRawLogs() : [],
      vaultChanges: deltaSync.getAllChangesForMigration ? await deltaSync.getAllChangesForMigration() : [],
    };

    const result = await dbManager.switchAndMigrate(config, dataset, migrateExisting);

    // Refresh memory cache from the newly selected DB
    await users.loadFromDb();
    await vaultsStore.loadFromDb();
    await vaultMembers.loadFromDb();
    await sharesStore.loadFromDb();
    await syncRulesStore.loadFromDb();
    await settingsManager.loadFromDb();
    await syncLogger.loadFromDb();
    if (deltaSync.clearCache) {
      deltaSync.clearCache();
    }

    res.json({
      ok: true,
      message: result.message || `已成功切换数据库引擎至 ${dbManager.type.toUpperCase()}`,
      status: dbManager.getStatus(),
      migrated: result.migrated,
      counts: result.counts,
    });
  } catch (err) {
    console.error('[DB Switch Error]', err);
    res.status(500).json({ error: `数据库切换失败: ${err.message}` });
  }
}));

// Admin global sync logs endpoint
router.get('/sync-logs', (req, res) => {
  const { vaultId, action, status, search, limit, offset } = req.query;
  const result = syncLogger.getLogs({
    vaultId: vaultId || null,
    action: action || null,
    status: status || null,
    search: search || null,
    limit: limit ? parseInt(limit, 10) : 100,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  res.json(result);
});

module.exports = router;
