const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const dbManager = require('./db');
const JsonDb = require('./jsonDb');

const MAX_MEMORY_CHANGES_PER_VAULT = 5000;

class DeltaSyncService {
  constructor() {
    // vaultId -> { latestCursor: number, ring: Array<{ cursor, path, action, size, mtime, hash, createdAt }> }
    this.vaultState = new Map();
    this.jsonStores = new Map();
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

    let latestCursor = 0;
    const ring = [];

    if (dbManager.type === 'sqlite' && dbManager.sqliteDb) {
      try {
        await new Promise((resolve) => {
          dbManager.sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS vault_changes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              vault_id TEXT NOT NULL,
              cursor INTEGER NOT NULL,
              path TEXT NOT NULL,
              action TEXT NOT NULL,
              size INTEGER,
              mtime INTEGER,
              hash TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_vault_changes_cursor ON vault_changes(vault_id, cursor);
          `, () => resolve());
        });

        const row = await new Promise((resolve) => {
          dbManager.sqliteDb.get(
            'SELECT MAX(cursor) as maxCursor FROM vault_changes WHERE vault_id = ?',
            [vaultId],
            (err, r) => resolve(r)
          );
        });
        if (row && row.maxCursor) {
          latestCursor = row.maxCursor;
        }

        const rows = await new Promise((resolve) => {
          dbManager.sqliteDb.all(
            'SELECT cursor, path, action, size, mtime, hash, created_at as createdAt FROM vault_changes WHERE vault_id = ? ORDER BY cursor DESC LIMIT 500',
            [vaultId],
            (err, r) => resolve(r || [])
          );
        });
        if (rows && rows.length > 0) {
          rows.reverse().forEach((r) => ring.push(r));
        }
      } catch (err) {
        console.error('[DeltaSync] SQLite init error for vault', vaultId, err.message);
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

    this.vaultState.set(vaultId, { latestCursor, ring });
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

    return changeItems;
  }

  async _persistBatchChanges(vaultId, changeItems) {
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
              change.size,
              change.mtime,
              change.hash,
              change.createdAt,
            ]);
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
    } else {
      const store = this._getJsonStore(vaultId);
      store.update((data) => {
        const maxCursor = changeItems[changeItems.length - 1].cursor;
        data.latestCursor = Math.max(data.latestCursor || 0, maxCursor);
        if (!Array.isArray(data.changes)) data.changes = [];
        data.changes.push(...changeItems);
        if (data.changes.length > 2000) {
          data.changes = data.changes.slice(-2000);
        }
        return data;
      });
    }
  }

  async _persistChange(vaultId, change) {
    if (dbManager.type === 'sqlite' && dbManager.sqliteDb) {
      return new Promise((resolve, reject) => {
        dbManager.sqliteDb.run(
          `INSERT INTO vault_changes (vault_id, cursor, path, action, size, mtime, hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            vaultId,
            change.cursor,
            change.path,
            change.action,
            change.size,
            change.mtime,
            change.hash,
            change.createdAt,
          ],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });
    } else {
      const store = this._getJsonStore(vaultId);
      store.update((data) => {
        data.latestCursor = Math.max(data.latestCursor || 0, change.cursor);
        if (!Array.isArray(data.changes)) data.changes = [];
        data.changes.push(change);
        if (data.changes.length > 2000) {
          data.changes = data.changes.slice(-2000);
        }
        return data;
      });
    }
  }

  /**
   * Query changes since cursor.
   * If since is 0 or older than retained history, caller should fall back to full snapshot.
   */
  async getChanges(vaultId, sinceCursor = 0, limit = 500) {
    if (!this.vaultState.has(vaultId)) {
      await this.initVault(vaultId);
    }
    const st = this.vaultState.get(vaultId);
    const since = parseInt(sinceCursor || '0', 10);
    const maxLimit = Math.min(Math.max(parseInt(limit || '500', 10), 1), 1000);

    if (since === st.latestCursor) {
      return {
        cursor: st.latestCursor,
        hasMore: false,
        changesCount: 0,
        updates: [],
        deletes: [],
      };
    }

    // Check if since is in memory ring
    const oldestMemoryCursor = st.ring.length > 0 ? st.ring[0].cursor : st.latestCursor + 1;

    if (since >= oldestMemoryCursor - 1) {
      const matched = st.ring.filter((c) => c.cursor > since);
      const sliced = matched.slice(0, maxLimit);
      const hasMore = matched.length > maxLimit;
      const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].cursor : st.latestCursor;

      const updates = [];
      const deletes = [];

      for (const item of sliced) {
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
        changesCount: sliced.length,
        updates,
        deletes,
      };
    }

    // If SQLite, try querying DB
    if (dbManager.type === 'sqlite' && dbManager.sqliteDb) {
      try {
        const rows = await new Promise((resolve, reject) => {
          dbManager.sqliteDb.all(
            `SELECT cursor, path, action, size, mtime, hash, created_at as createdAt
             FROM vault_changes
             WHERE vault_id = ? AND cursor > ?
             ORDER BY cursor ASC
             LIMIT ?`,
            [vaultId, since, maxLimit + 1],
            (err, r) => (err ? reject(err) : resolve(r || []))
          );
        });

        if (rows.length > 0) {
          const hasMore = rows.length > maxLimit;
          const sliced = rows.slice(0, maxLimit);
          const nextCursor = sliced[sliced.length - 1].cursor;

          const updates = [];
          const deletes = [];
          for (const item of sliced) {
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
            changesCount: sliced.length,
            updates,
            deletes,
          };
        }
      } catch (err) {
        console.error('[DeltaSync] DB Query error:', err.message);
      }
    }

    // Since is too old or not found -> signal full snapshot required
    return {
      fullSyncRequired: true,
      cursor: st.latestCursor,
      reason: 'CURSOR_OUT_OF_BOUNDS_OR_FIRST_SYNC',
    };
  }
}

const deltaSync = new DeltaSyncService();
module.exports = deltaSync;
