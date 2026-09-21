const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const JsonDb = require('./jsonDb');
const { VAULTS_FILE, VAULTS_DIR } = require('./config');
const dbManager = require('./db');
const vaultMembers = require('./vaultMembers');

const jsonDb = new JsonDb(VAULTS_FILE, { vaults: [] });

let vaultsCache = [];

function refreshCacheFromJson() {
  try {
    vaultsCache = jsonDb.read().vaults || [];
  } catch {
    vaultsCache = [];
  }
}

async function loadFromDb() {
  if (dbManager.type === 'json') {
    refreshCacheFromJson();
    return;
  }
  try {
    const rows = await dbManager.queryAll('SELECT id, owner_id, name, created_at FROM vaults');
    vaultsCache = rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id || r.ownerId,
      name: r.name,
      createdAt: r.created_at || r.createdAt,
    }));
  } catch (err) {
    console.error('[Vaults] Error loading vaults from SQL database, fallback to JSON:', err.message);
    refreshCacheFromJson();
  }
}

function listForUser(userId, isAdmin = false) {
  if (isAdmin) {
    return vaultsCache.map((v) => ({
      ...v,
      myPermission: v.ownerId === userId ? 'owner' : 'admin',
      isOwner: v.ownerId === userId,
    }));
  }

  const owned = vaultsCache
    .filter((v) => v.ownerId === userId)
    .map((v) => ({ ...v, myPermission: 'owner', isOwner: true }));

  const memberRecords = vaultMembers.listForUser(userId);
  const shared = [];
  for (const m of memberRecords) {
    const v = getById(m.vaultId);
    if (v && v.ownerId !== userId) {
      shared.push({
        ...v,
        myPermission: m.permission || 'read-write',
        isOwner: false,
      });
    }
  }

  return [...owned, ...shared];
}

function getById(vaultId) {
  return vaultsCache.find((v) => v.id === vaultId);
}

function getUserPermission(userId, vaultId, isAdmin = false) {
  const v = getById(vaultId);
  if (!v) return null;
  if (v.ownerId === userId) return 'owner';
  if (isAdmin) return 'admin';
  const m = vaultMembers.getMember(vaultId, userId);
  return m ? m.permission : null;
}

function hasReadAccess(userId, vaultId, isAdmin = false) {
  const perm = getUserPermission(userId, vaultId, isAdmin);
  return !!perm;
}

function hasWriteAccess(userId, vaultId, isAdmin = false) {
  const perm = getUserPermission(userId, vaultId, isAdmin);
  return perm === 'owner' || perm === 'admin' || perm === 'read-write';
}

async function create(ownerId, name) {
  const vault = { id: uuid(), ownerId, name, createdAt: new Date().toISOString() };
  vaultsCache.push(vault);

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.vaults = data.vaults || [];
      data.vaults.push(vault);
      return data;
    });
  } else {
    try {
      await dbManager.execute('INSERT INTO vaults (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)', [
        vault.id,
        vault.ownerId,
        vault.name,
        vault.createdAt,
      ]);
    } catch (err) {
      console.error('[Vaults] DB insert vault error:', err);
    }
  }

  const root = vaultFilesRoot(vault.id);
  fs.mkdirSync(root, { recursive: true });
  return vault;
}

async function ensureDefaultVaults(ownerId) {
  if (vaultsCache.length > 0 || !ownerId) return;

  console.log('[Vaults] No vaults found in system. Initializing default test vaults...');

  const storage = require('./storage');

  // Vault 1: TestVault
  const testVault = await create(ownerId, 'TestVault');
  if (testVault) {
    try {
      storage.writeFile(
        testVault.id,
        'Welcome.md',
        Buffer.from(
          '# 欢迎使用 Nimbus Vault Sync 🚀\n\n这是一个自动生成的测试笔记库 (TestVault)。\n\n## 功能特性\n- ⚡ **高速双向增量同步**：支持 Obsidian 扩展插件极速同步\n- 🛡️ **Git 自动备份**：自动按次或按时提交 Git 历史\n- 📝 **Web 随手记与在线编辑器**：支持 Markdown 预览与多文件编辑\n- 🤝 **多人协同与权限隔离**：支持只读/读写/所有者细粒度控制\n'
        )
      );
      storage.writeFile(
        testVault.id,
        'Getting Started.md',
        Buffer.from(
          '# 快速上手指南 📖\n\n1. 在 Obsidian 插件设置中输入当前服务器地址和登录 Token\n2. 选择连接本笔记库 TestVault\n3. 开始实时同步！\n'
        )
      );
      storage.writeFile(
        testVault.id,
        'TodoList.md',
        Buffer.from(
          '# 今日待办事项 📋\n\n- [x] 启动 Nimbus Vault Sync 服务\n- [ ] 连接 Obsidian 客户端\n- [ ] 体验在线 Markdown 编辑与版本双向同步\n'
        )
      );
    } catch (e) {
      console.error('[Vaults] Failed to seed files for TestVault:', e.message);
    }
  }

  // Vault 2: 工作笔记库
  const workVault = await create(ownerId, '工作笔记库');
  if (workVault) {
    try {
      storage.writeFile(
        workVault.id,
        'Index.md',
        Buffer.from('# 工作笔记索引 💼\n\n欢迎体验多 Vault 隔离与角色权限分配！\n')
      );
    } catch (e) {
      console.error('[Vaults] Failed to seed files for WorkVault:', e.message);
    }
  }
}

async function remove(vaultId) {
  vaultsCache = vaultsCache.filter((v) => v.id !== vaultId);

  // 1. 显式删除 vault_members 关联成员记录 (SQL & JSON & 内存)
  try {
    await vaultMembers.removeAllForVault(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing members for vault ${vaultId}:`, e.message);
  }

  // 2. 显式删除 vault_changes 增量同步变更历史 (SQL & JSON & 内存)
  try {
    const deltaSync = require('./deltaSync');
    await deltaSync.removeVaultData(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing delta sync data for vault ${vaultId}:`, e.message);
  }

  // 3. 显式删除 sync_rules 规则记录 (SQL & 内存)
  try {
    const syncRules = require('./syncRules');
    await syncRules.removeRulesForVault(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing sync rules for vault ${vaultId}:`, e.message);
  }

  // 4. 显式删除 shares 分享外链记录 (SQL & 内存)
  try {
    const shares = require('./shares');
    await shares.removeAllForVault(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing shares for vault ${vaultId}:`, e.message);
  }

  // 5. 清理全文搜索索引文件与内存状态
  try {
    const ftsEngine = require('./ftsEngine');
    ftsEngine.removeVaultIndex(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing FTS index for vault ${vaultId}:`, e.message);
  }

  // 6. 广播并断开 WebSocket 活跃房间
  try {
    const wsHub = require('./wsHub');
    wsHub.closeVault(vaultId);
  } catch (e) {}

  // 7. 彻底清理 Vault 磁盘目录（含 files/, history/, trash/）及独立 data/trash/:vaultId
  try {
    const storage = require('./storage');
    storage.deleteVaultDirectory(vaultId);
  } catch (e) {
    console.error(`[Vaults] Error removing storage directory for vault ${vaultId}:`, e.message);
  }

  // 8. 彻底清理 vaults 表中的记录
  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.vaults = (data.vaults || []).filter((v) => v.id !== vaultId);
      return data;
    });
  } else {
    try {
      await dbManager.execute('DELETE FROM vaults WHERE id = ?', [vaultId]);
    } catch (err) {
      console.error('[Vaults] DB delete vault error:', err);
    }
  }
}

function vaultRoot(vaultId) {
  return path.join(VAULTS_DIR, vaultId);
}

function vaultFilesRoot(vaultId) {
  return path.join(vaultRoot(vaultId), 'files');
}

function userOwnsVault(userId, vaultId) {
  const v = getById(vaultId);
  return !!v && v.ownerId === userId;
}

function listOwnedByUser(userId) {
  return vaultsCache.filter((v) => v.ownerId === userId);
}

/**
 * 把一个 vault 的所有权转移给另一个用户——目前主要用在"删除用户"这个流程里：
 * 被删除用户名下拥有的 vault 不能就地变成孤儿（ownerId 指向一个已经不存在的
 * 用户，普通用户从此再也进不去，只能靠管理员的越权豁免才够得到）。
 */
async function transferOwnership(vaultId, newOwnerId) {
  const vault = getById(vaultId);
  if (!vault) return null;
  vault.ownerId = newOwnerId;

  if (dbManager.type === 'json') {
    jsonDb.update((data) => {
      data.vaults = (data.vaults || []).map((v) => (v.id === vaultId ? { ...v, ownerId: newOwnerId } : v));
      return data;
    });
  } else {
    dbManager
      .execute('UPDATE vaults SET owner_id = ? WHERE id = ?', [newOwnerId, vaultId])
      .catch((err) => console.error('[Vaults] DB transfer ownership error:', err));
  }

  return vault;
}

refreshCacheFromJson();

module.exports = {
  listForUser,
  getById,
  create,
  remove,
  vaultRoot,
  vaultFilesRoot,
  userOwnsVault,
  listOwnedByUser,
  transferOwnership,
  getUserPermission,
  hasReadAccess,
  hasWriteAccess,
  loadFromDb,
  ensureDefaultVaults,
  getRawVaults: () => vaultsCache,
};
