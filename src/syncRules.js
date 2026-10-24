const fs = require('fs');
const path = require('path');
const { vaultRoot } = require('./vaults');
const dbManager = require('./db');

const DEFAULT_RULES = {
  ignorePatterns: [
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/workspace*.json',
    '.obsidian/app.json',
    '.obsidian/cache/**',
    '.obsidian/icons/**',
    '.obsidian/plugins/nimbus-sync/**',
    '**/plugins/nimbus-sync/data.json',
    '**/*.tmp',
    '**/*.swp',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/desktop.ini',
    '**/.git/**',
    '**/node_modules/**',
  ],
  maxFileSizeMb: 100,
  syncAttachments: true,
  syncConfig: true,
};

const rulesCache = new Map();

function rulesPath(vaultId) {
  return path.join(vaultRoot(vaultId), 'sync-rules.json');
}

function getRules(vaultId) {
  if (rulesCache.has(vaultId)) {
    return { ...DEFAULT_RULES, ...rulesCache.get(vaultId) };
  }

  const p = rulesPath(vaultId);
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const merged = { ...DEFAULT_RULES, ...raw };
      rulesCache.set(vaultId, merged);
      return merged;
    } catch {}
  }
  return { ...DEFAULT_RULES };
}

async function loadFromDb() {
  if (dbManager.type === 'json') return;
  try {
    const rows = await dbManager.queryAll('SELECT vault_id, rules_json FROM sync_rules');
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.rules_json || '{}');
        rulesCache.set(r.vault_id || r.vaultId, { ...DEFAULT_RULES, ...parsed });
      } catch {}
    }
  } catch (err) {
    console.error('[SyncRules] Error loading rules from DB:', err.message);
  }
}

async function saveRules(vaultId, rules) {
  const merged = { ...DEFAULT_RULES, ...rules };
  if (dbManager.type === 'json') {
    const p = rulesPath(vaultId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  } else {
    const jsonStr = JSON.stringify(merged);
    const now = Date.now();
    if (dbManager.type === 'sqlite') {
      await dbManager.execute('INSERT OR REPLACE INTO sync_rules (vault_id, rules_json, updated_at) VALUES (?, ?, ?)', [vaultId, jsonStr, now]);
    } else if (dbManager.type === 'postgres') {
      await dbManager.execute(
        'INSERT INTO sync_rules (vault_id, rules_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (vault_id) DO UPDATE SET rules_json = EXCLUDED.rules_json, updated_at = EXCLUDED.updated_at',
        [vaultId, jsonStr, now]
      );
    } else if (dbManager.type === 'mysql') {
      await dbManager.execute(
        'INSERT INTO sync_rules (vault_id, rules_json, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rules_json = VALUES(rules_json), updated_at = VALUES(updated_at)',
        [vaultId, jsonStr, now]
      );
    }
    // SQL is authoritative in SQL mode; JSON is only a portability copy.
    try {
      const p = rulesPath(vaultId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(merged, null, 2));
    } catch (err) {
      console.warn('[SyncRules] Failed to refresh JSON portability copy:', err.message);
    }
  }

  rulesCache.set(vaultId, merged);
  return merged;
}

function matchPattern(relPath, pattern) {
  const normPath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  let normPat = String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normPat) return false;

  // Simple direct exact match
  if (normPath === normPat) return true;

  // If pattern does not contain slash and is like *.ext, it should match anywhere in hierarchy
  if (!normPat.includes('/') && normPat.startsWith('*.')) {
    const ext = normPat.slice(1);
    if (normPath.endsWith(ext) || normPath.endsWith(ext.toLowerCase()) || normPath.endsWith(ext.toUpperCase())) return true;
  }

  // Handle leading **/
  let p = normPat;
  let prefix = '^';
  if (p.startsWith('**/')) {
    prefix = '^(?:.*/)?';
    p = p.slice(3);
  }

  // 🛡️ 项 4（glob 转换修复，与插件端 matchIgnorePattern 同一管线）：
  // 1) 先用占位符保护 globstar 再展开单星与问号——否则展开出的 (?:.*/)? 里的
  //    问号会被后续 ? 替换改写掉，中段 **/ 规则（a/**/b.md、Archive/**/drafts/*）
  //    永远无法匹配（占位符方案：插件端注释已写明原因，服务端此前漏改）。
  // 2) 移除 (?<!\.) lookbehind：占位符已保证裸 * 才会走到这一步，转义点号
  //    后面的裸 *（notes.*）同样该按 [^/]* 展开——旧 lookbehind 把它留成了
  //    量词，规则被退化成 ^notes\.*$（只匹配 "notes" 加任意个点）。
  // 3) ? → [^/] 与插件端一致，不跨路径分隔符。
  const STAR_SLASH = '\u0000GLOBSTAR_SLASH\u0000';
  const STAR = '\u0000GLOBSTAR\u0000';
  const regexStr =
    prefix +
    p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, STAR_SLASH)
      .replace(/\*\*/g, STAR)
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(new RegExp(STAR_SLASH, 'g'), '(?:.*/)?')
      .replace(new RegExp(STAR, 'g'), '.*') +
    '$';

  try {
    const reg = new RegExp(regexStr, 'i');
    return reg.test(normPath);
  } catch {
    return normPath.toLowerCase().includes(normPat.toLowerCase());
  }
}

function isPathIgnored(vaultId, relPath) {
  const rules = getRules(vaultId);
  for (const pat of rules.ignorePatterns || []) {
    if (matchPattern(relPath, pat)) return true;
  }
  return false;
}

async function removeRulesForVault(vaultId) {
  if (dbManager.type !== 'json') {
    await dbManager.execute('DELETE FROM sync_rules WHERE vault_id = ?', [vaultId]);
  }
  rulesCache.delete(vaultId);
  try {
    fs.rmSync(rulesPath(vaultId), { force: true });
  } catch (err) {
    console.warn('[SyncRules] Failed to remove JSON portability copy:', err.message);
  }
}

module.exports = {
  getRules,
  saveRules,
  removeRulesForVault,
  isPathIgnored,
  DEFAULT_RULES,
  loadFromDb,
  getRawRules: () => {
    const res = {};
    for (const [k, v] of rulesCache.entries()) {
      res[k] = v;
    }
    return res;
  },
  getAllRules: () => {
    const res = {};
    for (const [k, v] of rulesCache.entries()) {
      res[k] = v;
    }
    return res;
  },
};
