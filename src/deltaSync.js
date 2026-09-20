const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const dbManager = require('./db');
const JsonDb = require('./jsonDb');

const MAX_MEMORY_CHANGES_PER_VAULT = 5000;
const MAX_CHANGES_RETENTION = parseInt(process.env.MAX_DELTA_CHANGES_PER_VAULT || '5000', 10);
const PRUNE_INTERVAL_CHANGES = 200; // 每累计 200 次变更触发一次检查与清理
const MAX_CHANGES_AGE_DAYS = parseInt(process.env.MAX_DELTA_CHANGES_AGE_DAYS || '30', 10);
const MAX_CHANGES_AGE_MS = MAX_CHANGES_AGE_DAYS * 24 * 60 * 60 * 1000;

class DeltaSyncService {
  constructor() {
    // vaultId -> { latestCursor: number, ring: Array<{ cursor, path, action, size, mtime, hash, createdAt }> }
    this.vaultState = new Map();
    this.jsonStores = new Map();
    this.initPromises = new Map();
  }

  _getJsonStore(vaultId) {
    let store = this.jsonStores.get(vaultId);
    if (!store) {
      const storePath = path.join(DATA_DIR, 'changes', `changes_${vaultId}.json`);
      store = new JsonDb(storePath, { latestCursor: 0, changes: [] });
      this.jsonStores.set(vaultId, store);
    }
    return store;
  }

  async initVault(vaultId) {
    if (this.vaultState.has(vaultId)) return;
    if (this.initPromises.has(vaultId)) {
      return this.initPromises.get(vaultId);
    }

    const initPromise = (async () => {
      let latestCursor = 0;
      const ring = [];

      if (dbManager.type !== 'json') {
        try {
          const row = await dbManager.queryOne(
            'SELECT MAX(cursor) as maxCursor FROM vault_changes WHERE vault_id = ?',
            [vaultId]
          );
          if (row) {
            const rawMax = row.maxCursor ?? row.maxcursor;
            if (rawMax != null) {
              latestCursor = Number(rawMax);
            }
          }

          const rows = await dbManager.queryAll(
            'SELECT cursor, path, action, size, mtime, hash, created_at as createdAt FROM vault_changes WHERE vault_id = ? ORDER BY cursor DESC LIMIT 500',
            [vaultId]
          );
          if (rows && rows.length > 0) {
            rows.reverse().forEach((r) => {
              ring.push({
                cursor: Number(r.cursor),
                path: r.path,
                action: r.action,
                size: Number(r.size || 0),
                mtime: Number(r.mtime || 0),
                hash: r.hash || '',
                createdAt: Number(r.createdat ?? r.createdAt ?? r.created_at ?? 0),
              });
            });
          }
        } catch (err) {
          console.error('[DeltaSync] SQL DB init error for vault', vaultId, err.message);
        }
      } else {
        // JSON store fallback
        try {
          const store = this._getJsonStore(vaultId);
          const data = store.read();
          latestCursor = data.latestCursor || 0;
          if (Array.isArray(data.changes)) {
            const recent = data.changes.slice(-500);
            recent.forEach((c) => ring.push(c));
          }
        } catch (err) {
          console.error('[DeltaSync] JsonDb init error for vault', vaultId, err.message);
        }
      }

      this.vaultState.set(vaultId, { latestCursor, ring, unprunedCount: 0 });
      // 启动时在后台清理可能遗留的过量陈旧变更日志，释放磁盘空间
      this.pruneOldChanges(vaultId).catch(() => {});
    })();

    this.initPromises.set(vaultId, initPromise);
    try {
      await initPromise;
    } finally {
      this.initPromises.delete(vaultId);
    }
  }

  getLatestCursor(vaultId) {
    const st = this.vaultState.get(vaultId);
    return st ? st.latestCursor : 0;
  }

  async recordChange(vaultId, { path: relPath, action, size = 0, mtime = Date.now(), hash = '' }) {
    if (!this.vaultState.has(vaultId)) {
      await this.initVault(vaultId);
    }
    const st = this.vaultState.get(vaultId);
    st.latestCursor += 1;
    const cursor = st.latestCursor;
    const createdAt = Date.now();

    const changeItem = {
      cursor,
      path: relPath,
      action: action || 'UPSERT', // 'UPSERT' | 'DELETE'
      size,
      mtime,
      hash,
      createdAt,
    };

    st.ring.push(changeItem);
    if (st.ring.length > MAX_MEMORY_CHANGES_PER_VAULT) {
      st.ring.splice(0, st.ring.length - MAX_MEMORY_CHANGES_PER_VAULT);
    }

    // Persist to DB asynchronously
    this._persistChange(vaultId, changeItem).catch((err) => {
      console.error('[DeltaSync] Persist error:', err.message);
    });

    // 增量计数与自动衰减清理调度
    st.unprunedCount = (st.unprunedCount || 0) + 1;
    if (st.unprunedCount >= PRUNE_INTERVAL_CHANGES) {
      st.unprunedCount = 0;
      this.pruneOldChanges(vaultId).catch((err) => {
        console.warn('[DeltaSync] Periodic prune error:', err.message);
      });
    }

    return cursor;
  }

  async recordBatchChanges(vaultId, items) {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (!this.vaultState.has(vaultId)) {
      await this.initVault(vaultId);
    }
    const st = this.vaultState.get(vaultId);
    const createdAt = Date.now();
    const changeItems = [];

    for (const item of items) {
      st.latestCursor += 1;
      const changeItem = {
        cursor: st.latestCursor,
        path: item.path,
        action: item.action || 'UPSERT',
        size: item.size || 0,
        mtime: item.mtime || createdAt,
        hash: item.hash || '',
        createdAt,
      };
      st.ring.push(changeItem);
      changeItems.push(changeItem);
    }

    if (st.ring.length > MAX_MEMORY_CHANGES_PER_VAULT) {
      st.ring.splice(0, st.ring.length - MAX_MEMORY_CHANGES_PER_VAULT);
    }

    this._persistBatchChanges(vaultId, changeItems).catch((err) => {
      console.error('[DeltaSync] Persist batch error:', err.message);
    });

    // 批量增量计数与自动衰减清理调度
    st.unprunedCount = (st.unprunedCount || 0) + changeItems.length;
    if (st.unprunedCount >= PRUNE_INTERVAL_CHANGES) {
      st.unprunedCount = 0;
      this.pruneOldChanges(vaultId).catch((err) => {
        console.warn('[DeltaSync] Periodic batch prune error:', err.message);
      });
    }

    return changeItems;
  }

  async _persistBatchChanges(vaultId, changeItems) {
    if (!Array.isArray(changeItems) || changeItems.length === 0) return;

    if (dbManager.type !== 'json') {
      if (dbManager.type === 'sqlite' && dbManager.sqliteDb) {
        return new Promise((resolve, reject) => {
          const db = dbManager.sqliteDb;
          db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare(
              `INSERT INTO vault_changes (vault_id, cursor, path, action, size, mtime, hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const change of changeItems) {
              stmt.run([
                vaultId,
                change.cursor,
                change.path,
                change.action,
                change.size || 0,
                change.mtime || 0,
                change.hash || '',
                change.createdAt || Date.now(),
              ]);
            }
            stmt.finalize();
            db.run('COMMIT', (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        });
      }

      // PostgreSQL & MySQL batch insertion
      const BATCH_SIZE = 100;
      for (let i = 0; i < changeItems.length; i += BATCH_SIZE) {
        const batch = changeItems.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const sql = `INSERT INTO vault_changes (vault_id, cursor, path, action, size, mtime, hash, created_at) VALUES ${placeholders}`;
        const params = [];
        for (const item of batch) {
          params.push(
            vaultId,
            item.cursor,
            item.path,
            item.action,
            item.size || 0,
            item.mtime || 0,
            item.hash || '',
            item.createdAt || Date.now()
          );
        }
        await dbManager.execute(sql, params);
      }
    } else {
      const store = this._getJsonStore(vaultId);
      store.update((data) => {
        const maxCursor = changeItems[changeItems.length - 1].cursor;
        data.latestCursor = Math.max(data.latestCursor || 0, maxCursor);
        if (!Array.isArray(data.changes)) data.changes = [];
        data.changes.push(...changeItems);
        if (data.changes.length > MAX_CHANGES_RETENTION) {
          data.changes = data.changes.slice(-MAX_CHANGES_RETENTION);
        }
        return data;
      });
    }
  }

  async _persistChange(vaultId, change) {
    if (dbManager.type !== 'json') {
      try {
        await dbManager.execute(
          `INSERT INTO vault_changes (vault_id, cursor, path, action, size, mtime, hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            vaultId,
            change.cursor,
            change.path,
            change.action,
            change.size || 0,
            change.mtime || 0,
            change.hash || '',
            change.createdAt || Date.now(),
          ]
        );
      } catch (err) {
        console.error('[DeltaSync] SQL DB persist error:', err.message);
      }
    } else {
      const store = this._getJsonStore(vaultId);
      store.update((data) => {
        data.latestCursor = Math.max(data.latestCursor || 0, change.cursor);
        if (!Array.isArray(data.changes)) data.changes = [];
        data.changes.push(change);
        if (data.changes.length > MAX_CHANGES_RETENTION) {
          data.changes = data.changes.slice(-MAX_CHANGES_RETENTION);
        }
        return data;
      });
    }
  }

  /**
   * 清理并回收指定 Vault 的陈旧增量变更日志，防止数据库或 JSON 存储文件无限膨胀
   */
  async pruneOldChanges(vaultId) {
    const st = this.vaultState.get(vaultId);
    const currentCursor = st ? st.latestCursor : 0;
    const cursorCutoff = Math.max(0, currentCursor - MAX_CHANGES_RETENTION);
    const timeCutoff = Date.now() - MAX_CHANGES_AGE_MS;

    if (dbManager.type !== 'json') {
      try {
        const result = await dbManager.execute(
          `DELETE FROM vault_changes
           WHERE vault_id = ?
             AND (
               cursor <= ?
               OR (created_at < ? AND cursor <= (? - 1000))
             )`,
          [vaultId, cursorCutoff, timeCutoff, currentCursor]
        );
        if (result && result.changes > 0) {
          console.log(`[DeltaSync] Pruned ${result.changes} obsolete SQL change records for vault ${vaultId}`);
        }
      } catch (err) {
        console.warn(`[DeltaSync] SQL prune failed for vault ${vaultId}:`, err.message);
      }
    } else {
      // JSON Store 模式清理
      try {
        const store = this._getJsonStore(vaultId);
        store.update((data) => {
          if (Array.isArray(data.changes) && data.changes.length > MAX_CHANGES_RETENTION) {
            const before = data.changes.length;
            data.changes = data.changes.slice(-MAX_CHANGES_RETENTION);
            const pruned = before - data.changes.length;
            if (pruned > 0) {
              console.log(`[DeltaSync] Pruned ${pruned} obsolete JSON change records for vault ${vaultId}`);
            }
          }
          return data;
        });
      } catch (err) {
        console.warn('[DeltaSync] JsonDb prune error for vault', vaultId, err.message);
      }
    }
  }

  /**
   * Helper to deduplicate and compact changes by path, keeping latest state per path
   */
  _compactChanges(items) {
    if (!Array.isArray(items) || items.length <= 1) return items;
    const pathMap = new Map();
    for (const item of items) {
      pathMap.set(item.path, item);
    }
    return Array.from(pathMap.values()).sort((a, b) => a.cursor - b.cursor);
  }

  /**
   * Query changes since cursor.
   * If since is <= 0 or older than retained history, caller should fall back to full snapshot.
   */
  async getChanges(vaultId, sinceCursor = 0, limit = 500, options = {}) {
    if (!this.vaultState.has(vaultId)) {
      await this.initVault(vaultId);
    }
    const st = this.vaultState.get(vaultId);
    const since = parseInt(sinceCursor || '0', 10);
    const maxLimit = Math.min(Math.max(parseInt(limit || '500', 10), 1), 1000);
    const shouldCompact = Boolean(options && (options.compact === true || options.compact === 'true' || options.compact === '1'));

    // 1. 首次同步判定：当 since <= 0 或非有效正整数时，表示客户端从未同步过或已重置，必须强制下发全量快照 (fullSyncRequired)
    if (Number.isNaN(since) || since <= 0) {
      return {
        fullSyncRequired: true,
        cursor: st.latestCursor,
        reason: 'FIRST_SYNC_FULL_SNAPSHOT_REQUIRED',
      };
    }

    // 2. 客户端游标超前服务端：可能发生于服务端重置或测试数据回滚，必须触发全量重同步
    if (since > st.latestCursor) {
      return {
        fullSyncRequired: true,
        cursor: st.latestCursor,
        reason: 'CURSOR_AHEAD_OF_SERVER',
      };
    }

    // 3. 游标完全吻合最新状态：客户端已是最新，无新变更
    if (since === st.latestCursor) {
      return {
        cursor: st.latestCursor,
        latestCursor: st.latestCursor,
        hasMore: false,
        changesCount: 0,
        updates: [],
        deletes: [],
      };
    }

    // 4. 检查内存环形缓冲区 (Memory Ring) 是否连续覆盖了 since 之后的所有变更
    if (st.ring.length > 0 && since >= st.ring[0].cursor - 1) {
      const matched = st.ring.filter((c) => c.cursor > since);
      const sliced = matched.slice(0, maxLimit);
      const hasMore = matched.length > maxLimit;
      const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].cursor : st.latestCursor;

      const itemsToProcess = shouldCompact ? this._compactChanges(sliced) : sliced;
      const updates = [];
      const deletes = [];

      for (const item of itemsToProcess) {
        if (item.action === 'DELETE') {
          deletes.push({ path: item.path, cursor: item.cursor, timestamp: item.createdAt });
        } else {
          updates.push({
            path: item.path,
            size: item.size,
            mtime: item.mtime,
            hash: item.hash,
            cursor: item.cursor,
            timestamp: item.createdAt,
          });
        }
      }

      return {
        cursor: nextCursor,
        latestCursor: st.latestCursor,
        hasMore,
        changesCount: itemsToProcess.length,
        rawChangesCount: sliced.length,
        updates,
        deletes,
      };
    }

    // 5. 内存环已溢出或未命中，尝试从持久化存储检索
    // 5.1 SQL 引擎持久化查询 (SQLite, PostgreSQL, MySQL)
    if (dbManager.type !== 'json') {
      try {
        const rows = await dbManager.queryAll(
          `SELECT cursor, path, action, size, mtime, hash, created_at as createdAt
           FROM vault_changes
           WHERE vault_id = ? AND cursor > ?
           ORDER BY cursor ASC
           LIMIT ?`,
          [vaultId, since, maxLimit + 1]
        );

        const normalizedRows = rows.map((r) => ({
          cursor: Number(r.cursor),
          path: r.path,
          action: r.action,
          size: Number(r.size || 0),
          mtime: Number(r.mtime || 0),
          hash: r.hash || '',
          createdAt: Number(r.createdat ?? r.createdAt ?? r.created_at ?? 0),
        }));

        // 仅当查到记录且最旧一条游标紧随 since (无历史断层 gap) 时才允许增量返回
        if (normalizedRows.length > 0 && normalizedRows[0].cursor <= since + 1) {
          const hasMore = normalizedRows.length > maxLimit;
          const sliced = normalizedRows.slice(0, maxLimit);
          const nextCursor = sliced[sliced.length - 1].cursor;

          const itemsToProcess = shouldCompact ? this._compactChanges(sliced) : sliced;
          const updates = [];
          const deletes = [];
          for (const item of itemsToProcess) {
            if (item.action === 'DELETE') {
              deletes.push({ path: item.path, cursor: item.cursor, timestamp: item.createdAt });
            } else {
              updates.push({
                path: item.path,
                size: item.size,
                mtime: item.mtime,
                hash: item.hash,
                cursor: item.cursor,
                timestamp: item.createdAt,
              });
            }
          }

          return {
            cursor: nextCursor,
            latestCursor: st.latestCursor,
            hasMore,
            changesCount: itemsToProcess.length,
            rawChangesCount: sliced.length,
            updates,
            deletes,
          };
        }
      } catch (err) {
        console.error('[DeltaSync] SQL DB Query error:', err.message);
      }
    } else {
      // 5.2 JSON Store 持久化查询 (单机轻量部署)
      try {
        const store = this._getJsonStore(vaultId);
        const data = store.read();
        if (Array.isArray(data.changes) && data.changes.length > 0) {
          const matched = data.changes.filter((c) => c.cursor > since);
          if (matched.length > 0 && matched[0].cursor <= since + 1) {
            const hasMore = matched.length > maxLimit;
            const sliced = matched.slice(0, maxLimit);
            const nextCursor = sliced[sliced.length - 1].cursor;

            const itemsToProcess = shouldCompact ? this._compactChanges(sliced) : sliced;
            const updates = [];
            const deletes = [];
            for (const item of itemsToProcess) {
              if (item.action === 'DELETE') {
                deletes.push({ path: item.path, cursor: item.cursor, timestamp: item.createdAt });
              } else {
                updates.push({
                  path: item.path,
                  size: item.size,
                  mtime: item.mtime,
                  hash: item.hash,
                  cursor: item.cursor,
                  timestamp: item.createdAt,
                });
              }
            }

            return {
              cursor: nextCursor,
              latestCursor: st.latestCursor,
              hasMore,
              changesCount: itemsToProcess.length,
              rawChangesCount: sliced.length,
              updates,
              deletes,
            };
          }
        }
      } catch (err) {
        console.error('[DeltaSync] JsonDb Query error:', err.message);
      }
    }

    // 6. 游标超出可追溯范围或历史已被清理 -> 必须下发全量快照
    return {
      fullSyncRequired: true,
      cursor: st.latestCursor,
      reason: 'CURSOR_OUT_OF_BOUNDS_OR_PURGED',
    };
  }

  /**
   * 重置 DeltaSync 内存缓存状态（常用于热切换数据库引擎或重载元数据）
   */
  clearCache() {
    this.vaultState.clear();
    this.jsonStores.clear();
    this.initPromises.clear();
  }

  /**
   * 跨数据库引擎热迁移时抓取全部已持久化的变更记录
   */
  async getAllChangesForMigration() {
    if (dbManager.type !== 'json') {
      try {
        const rows = await dbManager.queryAll(
          'SELECT vault_id as vaultId, cursor, path, action, size, mtime, hash, created_at as createdAt FROM vault_changes ORDER BY cursor ASC'
        );
        return rows.map((r) => ({
          vaultId: r.vaultid || r.vaultId || r.vault_id,
          cursor: Number(r.cursor),
          path: r.path,
          action: r.action,
          size: Number(r.size || 0),
          mtime: Number(r.mtime || 0),
          hash: r.hash || '',
          createdAt: Number(r.createdat ?? r.createdAt ?? r.created_at ?? 0),
        }));
      } catch (err) {
        console.warn('[DeltaSync] Failed to read changes for migration from DB:', err.message);
        return [];
      }
    } else {
      const changesDir = path.join(DATA_DIR, 'changes');
      if (!fs.existsSync(changesDir)) return [];
      const files = fs.readdirSync(changesDir).filter((f) => f.startsWith('changes_') && f.endsWith('.json'));
      const allChanges = [];
      for (const file of files) {
        const vaultId = file.replace(/^changes_/, '').replace(/\.json$/, '');
        try {
          const content = JSON.parse(fs.readFileSync(path.join(changesDir, file), 'utf8'));
          if (Array.isArray(content.changes)) {
            for (const c of content.changes) {
              allChanges.push({
                vaultId,
                cursor: Number(c.cursor),
                path: c.path,
                action: c.action,
                size: Number(c.size || 0),
                mtime: Number(c.mtime || 0),
                hash: c.hash || '',
                createdAt: Number(c.createdAt || 0),
              });
            }
          }
        } catch {}
      }
      return allChanges;
    }
  }
}

const deltaSync = new DeltaSyncService();
module.exports = deltaSync;
