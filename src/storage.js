const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiverPkg = require('archiver');
const { vaultFilesRoot, vaultRoot } = require('./vaults');
const gitSync = require('./gitSync');
const deltaSync = require('./deltaSync');
const ftsEngine = require('./ftsEngine');

function createArchiver(format, options = {}) {
  if (typeof archiverPkg === 'function') {
    return archiverPkg(format, options);
  }
  if (format === 'zip') {
    return new archiverPkg.ZipArchive(options);
  }
  return new archiverPkg.TarArchive(options);
}

/*
 * Layout inside a vault's data folder:
 *   files/                the actual synced note/attachment tree (this is
 *                          the only part reflected in getManifest() / synced
 *                          to Obsidian clients)
 *   manifest-cache.json    hash cache, keyed by path (sibling of files/)
 *   history/               snapshots of overwritten file content
 *   history-index.json     [{id, path, size, savedAt}]
 *   trash/                  soft-deleted files, kept until purged
 *   trash-index.json        [{id, path, size, deletedAt}]
 */

const MAX_HISTORY_VERSIONS_PER_PATH = 20;
const MAX_VAULT_TOTAL_HISTORY = 500;
const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days retention

function getEffectiveHistoryPolicy() {
  try {
    const settings = require('./settings');
    const maxPerPath = Number(settings.get('versionRetentionCount'));
    const maxDays = Number(settings.get('versionRetentionDays'));
    return {
      maxPerPath: maxPerPath > 0 ? maxPerPath : MAX_HISTORY_VERSIONS_PER_PATH,
      maxAgeMs: maxDays > 0 ? maxDays * 24 * 60 * 60 * 1000 : MAX_HISTORY_AGE_MS,
      maxTotal: MAX_VAULT_TOTAL_HISTORY,
    };
  } catch {
    return {
      maxPerPath: MAX_HISTORY_VERSIONS_PER_PATH,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxTotal: MAX_VAULT_TOTAL_HISTORY,
    };
  }
}

function getEffectiveConflictStrategy() {
  try {
    const settings = require('./settings');
    const strategy = settings.get('conflictStrategy');
    if (strategy === 'overwrite_latest' || strategy === 'server_win' || strategy === 'conflict_copy') {
      return strategy;
    }
  } catch {}
  return 'conflict_copy';
}

const NOISE_FILE_REGEXES = [
  /^\.DS_Store$/i,
  /^\._/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\.Trash/i,
  /^\.Trashes/i,
];

// --------------------------- Key-Based File Mutex ---------------------------
// 基于文件路径的轻量级 Promise 链式锁（毫秒级并发互斥），无第三方依赖。
// 确保同一 Vault 下针对同一相对路径的写入、覆盖、删除操作在单进程内严格串行化，
// 消除“读取原文件 Hash”与“写入新文件内容”之间的微小并发竞态窗口。
const fileLocks = new Map(); // key (${vaultId}:${relPath}) -> Promise chain

function getFileLockKey(vaultId, relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return `${vaultId}:${norm}`;
}

async function withFileLock(vaultId, relPath, fn) {
  const key = getFileLockKey(vaultId, relPath);
  const current = fileLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const tail = current.then(() => next, () => next);
  fileLocks.set(key, tail);

  try {
    await current;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === tail) {
      fileLocks.delete(key);
    }
  }
}

async function waitForVaultLocks(vaultId) {
  const prefix = `${vaultId}:`;
  while (true) {
    const pending = Array.from(fileLocks.entries()).filter(([key]) => key.startsWith(prefix));
    if (pending.length === 0) return;
    await Promise.allSettled(pending.map(([, tail]) => tail));
    for (const [key, tail] of pending) {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    }
  }
}

async function withDualFileLock(vaultId, pathA, pathB, fn) {
  const normA = String(pathA || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normB = String(pathB || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normA || normA === normB) {
    return withFileLock(vaultId, normA || normB, fn);
  }
  const [first, second] = normA < normB ? [normA, normB] : [normB, normA];
  return withFileLock(vaultId, first, () => withFileLock(vaultId, second, fn));
}

function clearVaultLocks(vaultId) {
  const prefix = `${vaultId}:`;
  for (const key of Array.from(fileLocks.keys())) {
    if (key.startsWith(prefix)) {
      fileLocks.delete(key);
    }
  }
}

function isNoiseFile(name) {
  if (!name) return false;
  return NOISE_FILE_REGEXES.some((re) => re.test(name));
}

const NOISE_PATH_REGEXES = [
  /^\.git(\/|$)/i,
  /^\.obsidian\/workspace.*\.json$/i,
  /^\.obsidian\/app\.json$/i,
  /^\.obsidian\/appearance\.json$/i,
  /^\.obsidian\/cache(\/|$)/i,
  /^\.obsidian\/icons(\/|$)/i,
  /^\.obsidian\/plugins\/nimbus-sync(\/|$)/i,
];

function isNoisePath(relPath) {
  if (!relPath) return true;
  const norm = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = norm.split('/');
  for (const seg of segments) {
    if (isNoiseFile(seg)) return true;
  }
  return NOISE_PATH_REGEXES.some((rx) => rx.test(norm));
}

/** 凭据保护：识别 vault 内任意位置下的 Nimbus Sync 插件 data.json（例如 .config/plugins/...） */
function isPrivateVaultPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const segments = normalized.split('/');
  return segments.includes('.git') || (segments.length >= 4
    && segments[segments.length - 4].startsWith('.')
    && segments.slice(-3).join('/') === 'plugins/nimbus-sync/data.json');
}

/** Prevent path traversal: resolve relPath against root and ensure it stays inside root. */
function safeJoin(root, relPath) {
  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  // 双重保险：就算 walk() 不会把 .git 列进 manifest，也要挡住"直接按路径请求
  // .git/config"这种绕过枚举、凭直觉/猜测硬点路径的访问方式——REST 的
  // GET/PUT/DELETE .../files/.git/xxx 和 MCP 的 read_note/write_note 等
  // 工具最终都会走到这里，一处拦截，处处生效。
  const segments = normalized.split(/[/\\]/);
  if (segments.some((seg) => seg === '.git')) {
    throw new Error('Access to the .git directory is not allowed.');
  }
  const normalizedSegments = segments.map((seg) => seg.toLowerCase());
  if (normalizedSegments.length >= 4
    && normalizedSegments[normalizedSegments.length - 4].startsWith('.')
    && normalizedSegments.slice(-3).join('/') === 'plugins/nimbus-sync/data.json') {
    throw new Error('Access to the Nimbus Sync plugin credentials file is not allowed.');
  }
  const full = path.join(root, normalized);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) {
    throw new Error('Invalid path (outside vault root)');
  }

  // Lexical containment alone does not stop an in-vault symlink from pointing
  // outside the vault. Reject symlinked path components before any read/write.
  let current = path.resolve(root);
  const rootStat = fs.existsSync(current) ? fs.lstatSync(current) : null;
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error('Symbolic links are not allowed in vault storage paths.');
  }
  const relative = path.relative(current, full);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in vault storage paths.');
      }
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') break;
      throw err;
    }
  }
  return full;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Calculate SHA-256 asynchronously, streaming large files (>512KB) to avoid memory spikes and event-loop stalls. */
async function sha256FileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Rename, falling back to copy+unlink if src/dest are on different filesystems (EXDEV). */
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

// ------------------------------- manifest cache -------------------------------

function manifestCachePath(vaultId) {
  return path.join(vaultRoot(vaultId), 'manifest-cache.json');
}

function loadCache(vaultId) {
  const p = manifestCachePath(vaultId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// In-memory manifest cache: vaultId -> { manifest, lastScanned }
const inMemoryManifestCache = new Map();

// 🛡️ 写入代数计数：updateManifestEntry 每次（单条写/删）自增。
// getManifestAsync 的异步重建用它检测"扫盘窗口期间发生过写入"，据此立刻重扫，
// 避免旧快照整体覆盖内存清单、新文件永久缺失（见 getManifestAsync 内注释）。
const manifestGeneration = new Map();
function bumpManifestGeneration(vaultId) {
  manifestGeneration.set(vaultId, (manifestGeneration.get(vaultId) || 0) + 1);
}
function getManifestGeneration(vaultId) {
  return manifestGeneration.get(vaultId) || 0;
}

function invalidateManifestCache(vaultId) {
  bumpManifestGeneration(vaultId);
  inMemoryManifestCache.delete(vaultId);
  contentCache.delete(vaultId);
  clearVaultTagCache(vaultId);
}

function clearVaultCache(vaultId) {
  inMemoryManifestCache.delete(vaultId);
  contentCache.delete(vaultId);
  clearVaultTagCache(vaultId);
  clearVaultLocks(vaultId);
}

function deleteVaultDirectory(vaultId) {
  const { DATA_DIR, VAULTS_DIR } = require('./config');
  clearVaultCache(vaultId);

  // 1. 删除主 Vault 目录（包含 files/, history/, trash/, sync-rules.json 等）
  const vRoot = vaultRoot(vaultId);
  if (fs.existsSync(vRoot)) {
    try {
      fs.rmSync(vRoot, { recursive: true, force: true });
    } catch (e) {
      console.error(`[Storage] Failed to remove vault dir ${vRoot}:`, e.message);
    }
  }

  // 2. 清理可能存在的独立 data/trash/:vaultId 目录
  const legacyTrashDir = path.join(DATA_DIR, 'trash', vaultId);
  if (fs.existsSync(legacyTrashDir)) {
    try {
      fs.rmSync(legacyTrashDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[Storage] Failed to remove legacy trash dir ${legacyTrashDir}:`, e.message);
    }
  }
}

function updateManifestEntry(vaultId, relPath, meta) {
  const normRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  bumpManifestGeneration(vaultId); // 🛡️ 通知在途的 getManifestAsync 重建：期间有写入，快照已过期
  let cachedMem = inMemoryManifestCache.get(vaultId);
  if (!cachedMem) {
    getManifest(vaultId);
    cachedMem = inMemoryManifestCache.get(vaultId);
  }
  if (cachedMem && cachedMem.manifest) {
    if (meta === null) {
      delete cachedMem.manifest[normRel];
    } else {
      const mtimeVal = meta.mtime !== undefined ? meta.mtime : meta.mtimeMs;
      const ctimeVal = meta.ctime !== undefined ? meta.ctime : (meta.ctimeMs !== undefined ? meta.ctimeMs : mtimeVal);
      cachedMem.manifest[normRel] = {
        ...meta,
        mtime: mtimeVal,
        mtimeMs: meta.mtimeMs !== undefined ? meta.mtimeMs : mtimeVal,
        ctime: ctimeVal,
        ctimeMs: meta.ctimeMs !== undefined ? meta.ctimeMs : ctimeVal,
      };
    }
    // 🛡️ 磁盘扫描缓存的条目契约是 { size, mtimeMs, ctimeMs, hash }；
    // 绝不能把 manifest 形状（{ size, mtime, ctime }）整个覆盖进缓存文件——
    // 否则下一次全量构建对所有条目 100% miss，整个库被迫重读盘重哈希。
    // 这里按契约只合并受影响的这一条。
    try {
      const scanCache = loadCache(vaultId);
      if (meta === null) {
        delete scanCache[normRel];
      } else {
        scanCache[normRel] = {
          size: meta.size,
          mtimeMs: meta.mtime,
          ctimeMs: (meta.ctime !== undefined ? meta.ctime : meta.mtime),
          hash: meta.hash,
        };
      }
      saveCacheAsync(vaultId, scanCache).catch(() => {});
    } catch {}
  }
}

/** O(1) single-entry manifest lookup avoiding full manifest object cloning. */
function getManifestEntry(vaultId, relPath) {
  const cachedMem = inMemoryManifestCache.get(vaultId);
  if (cachedMem && cachedMem.manifest) {
    return cachedMem.manifest[relPath] || null;
  }
  const manifest = getManifest(vaultId);
  return manifest ? (manifest[relPath] || null) : null;
}

async function getManifestEntryAsync(vaultId, relPath) {
  const manifest = await getManifestAsync(vaultId);
  return manifest ? (manifest[relPath] || null) : null;
}

function saveCache(vaultId, cache) {
  const p = manifestCachePath(vaultId);
  const tmp = p + '.tmp.' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, p);
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

async function saveCacheAsync(vaultId, cache) {
  const p = manifestCachePath(vaultId);
  const tmp = p + '.tmp.' + Date.now();
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(cache));
    await fs.promises.rename(tmp, p);
  } catch {
    try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch {}
  }
}

/** Recursively list all files under a vault's files/ dir asynchronously without blocking the event loop. */
async function walkAsync(dir, base, out = []) {
  if (!fs.existsSync(dir)) return out;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name === '.git' || isNoiseFile(entry.name))) continue;
      if (entry.isFile() && isNoiseFile(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (isNoisePath(rel) || isPrivateVaultPath(rel)) continue;
      if (entry.isDirectory()) {
        await walkAsync(full, base, out);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  } catch {
    // Directory could be deleted or unreadable
  }
  return out;
}

/** Recursively list all files under a vault's files/ dir. */
function walk(dir, base, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // .git 是 Git 仓库自己的内部数据（可能包含写入了凭据的 .git/config），
    // 不是用户的笔记内容，绝不能把它当成普通 vault 文件列出来。
    if (entry.isDirectory() && (entry.name === '.git' || isNoiseFile(entry.name))) continue;
    if (entry.isFile() && isNoiseFile(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (isNoisePath(rel) || isPrivateVaultPath(rel)) continue;
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Build a manifest asynchronously: { path: { size, mtimeMs, hash } }.
 * Uses chunked concurrency and streaming hash for large files.
 * Yields to the Node.js event loop after each batch to prevent blocking during large directory scans.
 */
async function getManifestAsync(vaultId, forceRefresh = false) {
  const cachedMem = inMemoryManifestCache.get(vaultId);
  if (!forceRefresh && cachedMem && cachedMem.manifest) {
    return cachedMem.manifest;
  }

  const root = vaultFilesRoot(vaultId);

  // 🛡️ 修复重建竞态：本轮 walk 到写完内存缓存之间有多个 await 让出点，
  // 期间任何一次 updateManifestEntry（即任何普通写文件）都可能发生。
  // 若快照收尾时发现代数计数变了，说明这份 walk 的文件快照已过时——
  // 直接落库的话，新写入文件的条目会被旧快照整体覆盖、manifest “持久”缺文件。
  // 因此立刻重扫，直到两轮之间没有新写入（上限 3 轮，防写入风暴）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const genBefore = getManifestGeneration(vaultId);

    let cache = {};
    const cacheP = manifestCachePath(vaultId);
    if (fs.existsSync(cacheP)) {
      try {
        const data = await fs.promises.readFile(cacheP, 'utf8');
        cache = JSON.parse(data);
      } catch {
        cache = {};
      }
    }

    const relPaths = await walkAsync(root, root);
    const nextCache = {};
    const manifest = {};
    const BATCH_SIZE = 32;

    for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
      const chunk = relPaths.slice(i, i + BATCH_SIZE);
      await Promise.all(
        chunk.map(async (rel) => {
          const full = path.join(root, rel);
          try {
            const stat = await fs.promises.stat(full);
            const cached = cache[rel];
            const cachedMtime = cached ? (cached.mtimeMs !== undefined ? cached.mtimeMs : cached.mtime) : undefined;
            let hash;
            if (cached && cached.size === stat.size && cachedMtime === stat.mtimeMs && cached.hash) {
              hash = cached.hash;
            } else if (stat.size > 512 * 1024) {
              hash = await sha256FileAsync(full);
            } else {
              const buf = await fs.promises.readFile(full);
              hash = sha256(buf);
            }
            const ctime = (stat.birthtimeMs && stat.birthtimeMs > 0) ? stat.birthtimeMs : (stat.ctimeMs || stat.mtimeMs);
            nextCache[rel] = { size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs, ctime, ctimeMs: ctime, hash };
            manifest[rel] = { size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs, ctime, ctimeMs: ctime, hash };
          } catch {
            // File could be deleted or locked concurrently
          }
        })
      );

      // Yield control back to the event loop so incoming HTTP/WebSocket connections are not blocked
      await yieldToEventLoop();
    }

    if (getManifestGeneration(vaultId) !== genBefore && attempt < 2) {
      continue; // 期间有写入，这轮快照不完整，立刻重扫
    }

    saveCacheAsync(vaultId, nextCache).catch((err) => {
      console.error('[Storage] manifest 扫描缓存保存失败:', vaultId, (err && err.message) || err);
    });
    inMemoryManifestCache.set(vaultId, { manifest, lastScanned: Date.now() });
    return manifest;
  }
}

/** Build a manifest: { path: { size, mtimeMs, hash } }, cached in memory and on disk. */
function getManifest(vaultId, forceRefresh = false) {
  const cachedMem = inMemoryManifestCache.get(vaultId);
  if (!forceRefresh && cachedMem && cachedMem.manifest) {
    return cachedMem.manifest;
  }

  const root = vaultFilesRoot(vaultId);
  const cache = loadCache(vaultId);
  const nextCache = {};
  const manifest = {};

  for (const rel of walk(root, root)) {
    const full = path.join(root, rel);
    try {
      const stat = fs.statSync(full);
      const cached = cache[rel];
      const cachedMtime = cached ? (cached.mtimeMs !== undefined ? cached.mtimeMs : cached.mtime) : undefined;
      let hash;
      if (cached && cached.size === stat.size && cachedMtime === stat.mtimeMs && cached.hash) {
        hash = cached.hash;
      } else {
        hash = sha256(fs.readFileSync(full));
      }
      const ctime = (stat.birthtimeMs && stat.birthtimeMs > 0) ? stat.birthtimeMs : (stat.ctimeMs || stat.mtimeMs);
      nextCache[rel] = { size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs, ctime, ctimeMs: ctime, hash };
      manifest[rel] = { size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs, ctime, ctimeMs: ctime, hash };
    } catch {
      // File could be deleted or locked concurrently
    }
  }

  saveCache(vaultId, nextCache);
  inMemoryManifestCache.set(vaultId, { manifest, lastScanned: Date.now() });
  return manifest;
}

function readFile(vaultId, relPath) {
  const full = safeJoin(vaultFilesRoot(vaultId), relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

/**
 * 拿一个可读流用于下载，而不是把整份文件读进内存再 res.send(buf)。
 * 对大附件（视频、PDF、压缩包……）来说，流式传输能显著降低单次请求的内存占用，
 * 也不会因为同步 readFileSync 而卡住事件循环。
 */
function readFileStream(vaultId, relPath) {
  const full = safeJoin(vaultFilesRoot(vaultId), relPath);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  return { stream: fs.createReadStream(full), size: stat.size };
}

function tmpUploadDir(vaultId) {
  return path.join(vaultRoot(vaultId), '.tmp-uploads');
}

/**
 * 服务器重启前如果正好有上传在进行中，进程一退出这些临时文件必然是半成品、
 * 不可能再被续传完成——启动时统一清一遍，避免每次重启都留一堆垃圾文件占磁盘。
 */
function cleanupAllStaleUploadTemps() {
  const { VAULTS_DIR } = require('./config');
  if (!fs.existsSync(VAULTS_DIR)) return;
  let vaultDirs;
  try {
    vaultDirs = fs.readdirSync(VAULTS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of vaultDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(VAULTS_DIR, entry.name, '.tmp-uploads');
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[Storage] Failed to clean stale upload temp dir ${dir}:`, e.message);
      }
    }
  }
}

/** 生成一个供上传流写入的临时文件路径（调用方负责在出错时清理）。 */
function createUploadTempPath(vaultId) {
  const dir = tmpUploadDir(vaultId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `upload-${Date.now()}-${randomId()}.part`);
}

// ----------------------------- tags index & cache -----------------------------

// In-memory per-vault tag index: vaultId -> Map<relPath, { mtime, size, tags: Set<string> }>
const vaultTagFileIndex = new Map();
// Cached aggregated tags array: vaultId -> Array<{ tag, count, files }>
const vaultAggregatedTagsCache = new Map();
// Dirty flag set for vaults that need re-aggregation
const vaultTagCacheDirty = new Set();

function extractTagsFromContent(content) {
  const tags = new Set();
  if (!content || typeof content !== 'string') return tags;

  // 1. Frontmatter tags (YAML block)
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    // Pattern A: tags: [a, b, c] or tag: [a, b, c]
    const bracketMatch = fm.match(/(?:tags|tag):\s*\[(.*?)\]/i);
    if (bracketMatch) {
      const list = bracketMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"#]|['"]$/g, ''))
        .filter(Boolean);
      for (const t of list) {
        const cleanT = t.toLowerCase();
        if (cleanT.length > 0) tags.add(cleanT);
      }
    }

    // Pattern B: multiline YAML list:
    // tags:
    //   - item1
    //   - item2
    const yamlListMatch = fm.match(/(?:tags|tag):\s*\r?\n((?:\s*-\s+[^\r\n]+\r?\n?)+)/i);
    if (yamlListMatch) {
      const lines = yamlListMatch[1].split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*-\s+['"#]?([^'"#\r\n]+?)['"]?\s*$/);
        if (m && m[1]) {
          const cleanT = m[1].trim().toLowerCase();
          if (cleanT.length > 0) tags.add(cleanT);
        }
      }
    }

    // Pattern C: tags: single_tag
    const singleMatch = fm.match(/(?:tags|tag):\s*([a-zA-Z0-9_\u4e00-\u9fa5\/-]+)\s*$/m);
    if (singleMatch && !bracketMatch && !yamlListMatch) {
      const cleanT = singleMatch[1].trim().toLowerCase();
      if (cleanT.length > 0 && cleanT !== 'true' && cleanT !== 'false') tags.add(cleanT);
    }
  }

  // 2. Strip code blocks and inline code to prevent false positives in markdown
  let stripped = content
    .replace(/^---[\s\S]*?---/g, '') // remove frontmatter
    .replace(/```[\s\S]*?```/g, ' ') // remove code blocks
    .replace(/~~~[\s\S]*?~~~/g, ' ') // remove tilde code blocks
    .replace(/`[^`\n]*`/g, ' ') // remove inline code
    .replace(/<!--[\s\S]*?-->/g, ' '); // remove html comments

  // 3. Inline #tag and #nested/tag
  const tagRegex = /(?:^|\s)#([a-zA-Z\u4e00-\u9fa5_][\w\u4e00-\u9fa5_\-/]*)/g;
  let match;
  while ((match = tagRegex.exec(stripped)) !== null) {
    const tag = match[1].toLowerCase();
    // Exclude markdown headings h1-h6 and pure hex colors (e.g. #fff, #1a2b3c) or numbers
    if (tag.length > 0 && !/^h[1-6]$/.test(tag) && !/^[0-9a-fA-F]{3,8}$/.test(tag) && !/^\d+$/.test(tag)) {
      tags.add(tag);
    }
  }

  return tags;
}

function invalidateTagCacheEntry(vaultId, relPath) {
  if (relPath && !relPath.toLowerCase().endsWith('.md')) return;
  vaultTagCacheDirty.add(vaultId);
  vaultAggregatedTagsCache.delete(vaultId);
  const fileIndex = vaultTagFileIndex.get(vaultId);
  if (fileIndex) {
    fileIndex.delete(relPath);
  }
}

function clearVaultTagCache(vaultId) {
  vaultTagFileIndex.delete(vaultId);
  vaultAggregatedTagsCache.delete(vaultId);
  vaultTagCacheDirty.delete(vaultId);
}

function getVaultTags(vaultId, options = {}) {
  const force = options && options.forceRefresh;
  if (!force && !vaultTagCacheDirty.has(vaultId) && vaultAggregatedTagsCache.has(vaultId)) {
    return vaultAggregatedTagsCache.get(vaultId);
  }

  const root = vaultFilesRoot(vaultId);
  const manifest = getManifest(vaultId);

  let fileIndex = vaultTagFileIndex.get(vaultId);
  if (!fileIndex) {
    fileIndex = new Map();
    vaultTagFileIndex.set(vaultId, fileIndex);
  }

  // Remove stale deleted files from index
  for (const relPath of fileIndex.keys()) {
    if (!manifest[relPath] || !relPath.toLowerCase().endsWith('.md')) {
      fileIndex.delete(relPath);
    }
  }

  // Incremental index: only read disk for changed / new files!
  for (const [relPath, meta] of Object.entries(manifest)) {
    if (!relPath.toLowerCase().endsWith('.md')) continue;
    const cached = fileIndex.get(relPath);
    if (!force && cached && cached.mtime === meta.mtime && cached.size === meta.size) {
      continue; // Cache hit! Zero disk read!
    }

    const full = safeJoin(root, relPath);
    if (!fs.existsSync(full)) continue;

    try {
      const content = fs.readFileSync(full, 'utf8');
      const tags = extractTagsFromContent(content);
      fileIndex.set(relPath, {
        mtime: meta.mtime,
        size: meta.size,
        tags,
      });
    } catch {
      // Ignore read errors
    }
  }

  // Aggregate results
  const tagMap = new Map();
  for (const [relPath, entry] of fileIndex.entries()) {
    for (const tag of entry.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, new Set());
      tagMap.get(tag).add(relPath);
    }
  }

  const result = [];
  for (const [tag, fileSet] of tagMap.entries()) {
    result.push({
      tag,
      count: fileSet.size,
      files: Array.from(fileSet).sort(),
    });
  }
  result.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  vaultAggregatedTagsCache.set(vaultId, result);
  vaultTagCacheDirty.delete(vaultId);
  return result;
}

function touchMtime(full, mtimeMs) {
  if (!mtimeMs) return;
  const d = new Date(mtimeMs);
  fs.utimesSync(full, d, d);
}

// ---------------------------------- history ------------------------------------

function historyDir(vaultId) {
  return path.join(vaultRoot(vaultId), 'history');
}
function historyIndexPath(vaultId) {
  return path.join(vaultRoot(vaultId), 'history-index.json');
}
function loadIndex(p) {
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.warn(`[Storage] Index file ${p} corrupt, attempting backup recovery:`, e.message);
    }
  }
  const bak = p + '.bak';
  if (fs.existsSync(bak)) {
    try {
      return JSON.parse(fs.readFileSync(bak, 'utf8'));
    } catch {}
  }
  return [];
}

function saveIndex(p, entries) {
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    const data = JSON.stringify(entries, null, 2);
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Keep backup of previous good version if exists
    if (fs.existsSync(p)) {
      try { fs.copyFileSync(p, p + '.bak'); } catch {}
    }
    fs.renameSync(tmp, p);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Safely mutate an index file atomically without lost updates */
function mutateIndex(p, mutator) {
  const entries = loadIndex(p);
  const updated = mutator(entries);
  saveIndex(p, updated !== undefined ? updated : entries);
  return updated !== undefined ? updated : entries;
}

/** Snapshot the current (about-to-be-overwritten) content of a file into history. */
function snapshotBeforeOverwrite(vaultId, relPath, oldBuffer) {
  fs.mkdirSync(historyDir(vaultId), { recursive: true });
  const id = randomId();
  fs.writeFileSync(path.join(historyDir(vaultId), id), oldBuffer);

  const policy = getEffectiveHistoryPolicy();
  const idxPath = historyIndexPath(vaultId);
  mutateIndex(idxPath, (entries) => {
    entries.push({ id, path: relPath, size: oldBuffer.length, savedAt: Date.now() });

    // Cap history per path so it can't grow unbounded.
    const forThisPath = entries.filter((e) => e.path === relPath).sort((a, b) => a.savedAt - b.savedAt);
    let remaining = entries;
    if (forThisPath.length > policy.maxPerPath) {
      const toDrop = forThisPath.slice(0, forThisPath.length - policy.maxPerPath);
      const dropIds = new Set(toDrop.map((e) => e.id));
      for (const e of toDrop) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !dropIds.has(e.id));
    }

    // Global vault history cap & age expiration
    const now = Date.now();
    const cutoff = now - policy.maxAgeMs;
    const expired = remaining.filter((e) => e.savedAt < cutoff && e.id !== id);
    if (expired.length > 0) {
      const expIds = new Set(expired.map((e) => e.id));
      for (const e of expired) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !expIds.has(e.id));
    }

    if (remaining.length > policy.maxTotal) {
      // Sort oldest first and drop excess
      remaining.sort((a, b) => a.savedAt - b.savedAt);
      const excess = remaining.slice(0, remaining.length - policy.maxTotal);
      const dropIds = new Set(excess.map((e) => e.id));
      for (const e of excess) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !dropIds.has(e.id));
    }

    return remaining;
  });
}

/**
 * Prune obsolete history versions based on retention policy
 */
function pruneVaultHistory(vaultId, { maxAgeMs, maxTotal } = {}) {
  const policy = getEffectiveHistoryPolicy();
  const effectiveMaxAgeMs = maxAgeMs !== undefined ? maxAgeMs : policy.maxAgeMs;
  const effectiveMaxTotal = maxTotal !== undefined ? maxTotal : policy.maxTotal;
  const idxPath = historyIndexPath(vaultId);
  return mutateIndex(idxPath, (entries) => {
    const now = Date.now();
    const cutoff = now - effectiveMaxAgeMs;
    const kept = [];
    const dropped = [];

    for (const e of entries) {
      if (e.savedAt < cutoff) {
        dropped.push(e);
      } else {
        kept.push(e);
      }
    }

    if (kept.length > effectiveMaxTotal) {
      kept.sort((a, b) => a.savedAt - b.savedAt);
      const excess = kept.splice(0, kept.length - effectiveMaxTotal);
      dropped.push(...excess);
    }

    for (const e of dropped) {
      const f = path.join(historyDir(vaultId), e.id);
      fs.promises.unlink(f).catch(() => {});
    }

    return kept;
  });
}

/**
 * 同上，但直接从磁盘上的已有文件复制到 history/，不把旧内容读进内存。
 * 流式上传路径（writeFileFromPath）用这个版本，避免"只是为了存历史快照"
 * 而把一份可能很大的旧文件整个 Buffer 化。
 */
function snapshotBeforeOverwriteFromFile(vaultId, relPath, existingFullPath, existingSize) {
  fs.mkdirSync(historyDir(vaultId), { recursive: true });
  const id = randomId();
  fs.copyFileSync(existingFullPath, path.join(historyDir(vaultId), id));

  const policy = getEffectiveHistoryPolicy();
  const idxPath = historyIndexPath(vaultId);
  mutateIndex(idxPath, (entries) => {
    entries.push({ id, path: relPath, size: existingSize, savedAt: Date.now() });

    const forThisPath = entries.filter((e) => e.path === relPath).sort((a, b) => a.savedAt - b.savedAt);
    let remaining = entries;
    if (forThisPath.length > policy.maxPerPath) {
      const toDrop = forThisPath.slice(0, forThisPath.length - policy.maxPerPath);
      const dropIds = new Set(toDrop.map((e) => e.id));
      for (const e of toDrop) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !dropIds.has(e.id));
    }

    // Global vault history cap & age expiration
    const now = Date.now();
    const cutoff = now - policy.maxAgeMs;
    const expired = remaining.filter((e) => e.savedAt < cutoff && e.id !== id);
    if (expired.length > 0) {
      const expIds = new Set(expired.map((e) => e.id));
      for (const e of expired) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !expIds.has(e.id));
    }

    if (remaining.length > policy.maxTotal) {
      remaining.sort((a, b) => a.savedAt - b.savedAt);
      const excess = remaining.slice(0, remaining.length - policy.maxTotal);
      const dropIds = new Set(excess.map((e) => e.id));
      for (const e of excess) {
        const f = path.join(historyDir(vaultId), e.id);
        fs.promises.unlink(f).catch(() => {});
      }
      remaining = remaining.filter((e) => !dropIds.has(e.id));
    }

    return remaining;
  });
}

function listHistory(vaultId, relPath) {
  return loadIndex(historyIndexPath(vaultId))
    .filter((e) => e.path === relPath)
    .sort((a, b) => b.savedAt - a.savedAt);
}

function readHistoryVersion(vaultId, versionId) {
  const entry = loadIndex(historyIndexPath(vaultId)).find((e) => e.id === versionId);
  if (!entry) return null;
  const full = path.join(historyDir(vaultId), versionId);
  if (!fs.existsSync(full)) return null;
  return { entry, buffer: fs.readFileSync(full) };
}

async function readHistoryVersionAsync(vaultId, versionId) {
  const entry = loadIndex(historyIndexPath(vaultId)).find((e) => e.id === versionId);
  if (!entry) return null;
  const full = path.join(historyDir(vaultId), versionId);
  try {
    const buffer = await fs.promises.readFile(full);
    return { entry, buffer };
  } catch {
    return null;
  }
}

// ------------------------------------ trash --------------------------------------

function trashDir(vaultId) {
  return path.join(vaultRoot(vaultId), 'trash');
}
function trashIndexPath(vaultId) {
  return path.join(vaultRoot(vaultId), 'trash-index.json');
}

function listTrash(vaultId) {
  return loadIndex(trashIndexPath(vaultId)).sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Restore a trashed file back to its original path (overwrites anything currently there). */
async function restoreFromTrash(vaultId, trashId) {
  const result = await restoreBatchTrash(vaultId, [trashId]);
  return result.restoredPaths.length > 0 ? result.restoredPaths[0] : null;
}

/** Restore multiple trashed files back to their original paths in batch with high performance chunking. */
async function restoreBatchTrash(vaultId, trashIds) {
  if (!Array.isArray(trashIds) || trashIds.length === 0) {
    return { restoredCount: 0, restoredPaths: [] };
  }
  const idSet = new Set(trashIds);
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const targetEntries = entries.filter((e) => idSet.has(e.id));
  if (targetEntries.length === 0) {
    return { restoredCount: 0, restoredPaths: [] };
  }

  const restoredPaths = [];
  const successfullyRestoredIds = new Set();
  const deltaChanges = [];
  const now = Date.now();
  const vFilesRoot = vaultFilesRoot(vaultId);
  const vTrashDir = trashDir(vaultId);

  const manifest = await getManifestAsync(vaultId);

  const CHUNK_SIZE = 50;
  for (let i = 0; i < targetEntries.length; i += CHUNK_SIZE) {
    const chunk = targetEntries.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (entry) => withFileLock(vaultId, entry.path, async () => {
        const trashFull = path.join(vTrashDir, entry.id);
        if (!fs.existsSync(trashFull)) return;
        try {
          const buffer = await fs.promises.readFile(trashFull);
          let targetRelPath = entry.path;
          let destFull = safeJoin(vFilesRoot, targetRelPath);

          // 🛡️ 目标同名文件冲突保护：若目标已存在且哈希不同，自动生成副本以防覆盖
          if (fs.existsSync(destFull)) {
            const existingBuf = await fs.promises.readFile(destFull);
            if (sha256(existingBuf) !== sha256(buffer)) {
              const ext = path.extname(entry.path);
              const baseName = entry.path.slice(0, entry.path.length - ext.length);
              targetRelPath = `${baseName} (已恢复)${ext}`;
              destFull = safeJoin(vFilesRoot, targetRelPath);
            }
          }

          await fs.promises.mkdir(path.dirname(destFull), { recursive: true });
          await fs.promises.writeFile(destFull, buffer);
          // 🛡️ W-7：回收站物理文件在 delta 记录 durable 之前不许删除——
          // 否则 recordBatchChanges 抛错重试时 trash 副本已缺失，恢复永远无法重试。
          // 副本清理挪到记录持久化成功之后统一执行（见下方清理循环）。

          const destStat = await fs.promises.stat(destFull);
          const mtimeVal = destStat.mtimeMs || now;
          successfullyRestoredIds.add(entry.id);
          restoredPaths.push(targetRelPath);

          const hash = sha256(buffer);
          const meta = { size: buffer.length, mtime: mtimeVal, mtimeMs: mtimeVal, ctime: mtimeVal, ctimeMs: mtimeVal, hash };
          manifest[targetRelPath] = meta;
          updateManifestEntry(vaultId, targetRelPath, meta);
          invalidateContentCacheEntry(vaultId, targetRelPath);

          deltaChanges.push({
            path: targetRelPath,
            action: 'UPSERT',
            size: buffer.length,
            mtime: mtimeVal,
            hash,
          });

          try {
            ftsEngine.onFileWrite(vaultId, targetRelPath, buffer.toString('utf8'), meta);
          } catch {}
        } catch (err) {
          console.error(`[Trash] Failed to restore "${entry.path}":`, err);
        }
      }))
    );

    if (i + CHUNK_SIZE < targetEntries.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (successfullyRestoredIds.size > 0) {
    // 🛡️ durable 语义与写/删路径对齐（W-7）：UPSERT 记录先于清回收站索引持久化，
    // 失败时向上抛出（HTTP 回 5xx）且回收站条目完好，重试可完整重来。
    // 旧实现吞错继续返回成功——文件已落盘但 delta 日志缺这条 UPSERT、游标未推进，
    // 下次 init 双方游标相同判定「已对齐」，delta-only 客户端永远收不到恢复的文件，
    // 直到手动全量对账。
    if (deltaChanges.length > 0) {
      await deltaSync.recordBatchChanges(vaultId, deltaChanges);
    }
    // 🛡️ delta 记录 durable 之后才物理清理回收站副本（W-7，次序契约）：
    // 记录失败 → 上抛 → trash 文件与索引均保持原状，HTTP 回 5xx，重试完整重来。
    for (const entry of targetEntries) {
      if (!successfullyRestoredIds.has(entry.id)) continue;
      try {
        await fs.promises.unlink(path.join(vTrashDir, entry.id));
      } catch {}
    }
    mutateIndex(idxPath, (current) => current.filter((e) => !successfullyRestoredIds.has(e.id)));
    // 🛡️ 磁盘扫描缓存契约是 { size, mtimeMs, ctimeMs, hash }；manifest 形状（mtime/ctime）
    // 不能直接写入缓存文件，需转换后保存，避免下次全量构建全表 miss。
    const currentManifest = inMemoryManifestCache.get(vaultId)?.manifest || manifest;
    const shapedCache = {};
    for (const [rel, m] of Object.entries(currentManifest)) {
      if (m && typeof m === 'object') {
        shapedCache[rel] = {
          size: m.size,
          mtimeMs: m.mtime,
          ctimeMs: (m.ctime !== undefined ? m.ctime : m.mtime),
          hash: m.hash,
        };
      }
    }
    await saveCacheAsync(vaultId, shapedCache).catch((err) => {
      console.error('[Storage] 回收站恢复后的扫描缓存保存失败:', vaultId, (err && err.message) || err);
    });
    try {
      gitSync.notifyChange(vaultId);
    } catch {}
  }

  return { restoredCount: restoredPaths.length, restoredPaths };
}

/** Restore all items in trash. */
async function restoreAllTrash(vaultId) {
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const allIds = entries.map((e) => e.id);
  return await restoreBatchTrash(vaultId, allIds);
}

/** Permanently delete a trashed item (no way back after this). */
async function purgeTrash(vaultId, trashId) {
  const res = await purgeBatchTrash(vaultId, [trashId]);
  return res.purgedCount > 0;
}

/** Purge selected items in trash. */
async function purgeBatchTrash(vaultId, trashIds) {
  if (!Array.isArray(trashIds) || trashIds.length === 0) {
    return { purgedCount: 0 };
  }
  const idSet = new Set(trashIds);
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const targetEntries = entries.filter((e) => idSet.has(e.id));
  const vTrashDir = trashDir(vaultId);

  const CHUNK_SIZE = 100;
  for (let i = 0; i < targetEntries.length; i += CHUNK_SIZE) {
    const chunk = targetEntries.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (entry) => {
        const f = path.join(vTrashDir, entry.id);
        try {
          if (fs.existsSync(f)) await fs.promises.unlink(f);
        } catch {}
      })
    );
    if (i + CHUNK_SIZE < targetEntries.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  mutateIndex(idxPath, (current) => current.filter((e) => !idSet.has(e.id)));
  return { purgedCount: targetEntries.length };
}

/** Purge all items in trash. */
async function purgeAllTrash(vaultId) {
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const allIds = entries.map((e) => e.id);
  const result = await purgeBatchTrash(vaultId, allIds);
  return result.purgedCount;
}

/** Read content of a trashed file for preview. */
function readTrashVersion(vaultId, trashId) {
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const entry = entries.find((e) => e.id === trashId);
  if (!entry) return null;
  const trashFull = path.join(trashDir(vaultId), trashId);
  if (!fs.existsSync(trashFull)) return null;
  return { entry, buffer: fs.readFileSync(trashFull) };
}

// -------------------------------- write / delete ----------------------------------

/**
 * 给 deltaSync.recordChange 挂一个"只记日志"的旁路 catch：
 * - 同步调用方不 await 时，杜绝持久化失败升级成 unhandledRejection（server.js 会因此停机）；
 * - 保留 promise 自身的 rejection 语义，*Async 调用方仍可显式 await 并据此拒绝向客户端 ack 成功。
 */
function trackRecordChange(vaultId, desc, promise) {
  if (promise === undefined) {
    promise = desc;
    desc = '';
  }
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      console.error(`[Storage] deltaSync 持久化失败 (${vaultId}${desc ? ` ${desc}` : ''}):`, (err && err.message) || err);
    });
  }
  return promise;
}

/**
 * Write a file, with:
 *  - conflict-copy protection: if the file changed on the server since the
 *    caller last knew about it (baseHash mismatch), save a `.conflict-*`
 *    copy instead of silently overwriting.
 *  - automatic history snapshot: any real overwrite saves the previous
 *    content into history/ first, so it can be recovered later.
 */
function writeFile(vaultId, relPath, buffer, { mtime, baseHash } = {}) {
  const normRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const root = vaultFilesRoot(vaultId);
  const full = safeJoin(root, normRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  if (fs.existsSync(full)) {
    const existingBuf = fs.readFileSync(full);
    const existingHash = sha256(existingBuf);
    const incomingHash = sha256(buffer);

    if (existingHash === incomingHash) {
      // No real change — just acknowledge, no history entry needed.
      if (mtime) {
        touchMtime(full, mtime);
      }
      // 内容未变也要把真实 mtime 刷进清单：否则客户端续传/去重时看到的是旧 mtime
      try {
        const st = fs.statSync(full);
        const mtimeVal = st.mtimeMs || mtime || Date.now();
        const ctimeVal = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : (st.ctimeMs || mtimeVal);
        updateManifestEntry(vaultId, normRel, { size: buffer.length, mtime: mtimeVal, ctime: ctimeVal, hash: incomingHash });
      } catch {}
      return { written: true, conflict: null, currentHash: incomingHash, size: buffer.length, mtime: mtime || fs.statSync(full).mtimeMs };
    }

    if (baseHash && existingHash !== baseHash) {
      const strategy = getEffectiveConflictStrategy();
      if (strategy === 'server_win') {
        return { written: false, conflict: null, serverWin: true, currentHash: existingHash };
      }
      if (strategy !== 'overwrite_latest') {
        // Default 'conflict_copy': Someone else changed the file since this client last synced it — real conflict.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(normRel);
        const base = normRel.slice(0, normRel.length - ext.length);
        const conflictRel = `${base}.conflict-${stamp}${ext}`;
        const conflictFull = safeJoin(root, conflictRel);
        fs.mkdirSync(path.dirname(conflictFull), { recursive: true });
        fs.writeFileSync(conflictFull, buffer);
        if (mtime) touchMtime(conflictFull, mtime);

        const conflictStat = fs.statSync(conflictFull);
        const hash = sha256(buffer);
        const mtimeVal = conflictStat.mtimeMs || mtime || Date.now();
        const ctimeVal = (conflictStat.birthtimeMs && conflictStat.birthtimeMs > 0) ? conflictStat.birthtimeMs : (conflictStat.ctimeMs || mtimeVal);
        updateManifestEntry(vaultId, conflictRel, { size: buffer.length, mtime: mtimeVal, ctime: ctimeVal, hash });
        invalidateContentCacheEntry(vaultId, conflictRel);
        const changePromise = trackRecordChange(vaultId, conflictRel, deltaSync.recordChange(vaultId, { path: conflictRel, action: 'UPSERT', size: buffer.length, mtime: mtimeVal, hash }));
        try {
          ftsEngine.onFileWrite(vaultId, conflictRel, buffer.toString('utf8'), { size: buffer.length, mtime: mtimeVal, hash });
        } catch {}
        try {
          gitSync.notifyChange(vaultId);
        } catch {}

        // Don't touch the existing (server) version in this case.
        return { written: false, conflict: conflictRel, currentHash: existingHash, conflictHash: hash, conflictSize: buffer.length, conflictMtime: mtimeVal, changePromise };
      }
      // If strategy === 'overwrite_latest', fall through to snapshotBeforeOverwrite & overwrite
    }

    snapshotBeforeOverwrite(vaultId, normRel, existingBuf);
  }

  fs.writeFileSync(full, buffer);
  if (mtime) touchMtime(full, mtime);
  const finalStat = fs.statSync(full);
  const hash = sha256(buffer);
  const mtimeVal = finalStat.mtimeMs || mtime || Date.now();
  const ctimeVal = (finalStat.birthtimeMs && finalStat.birthtimeMs > 0) ? finalStat.birthtimeMs : (finalStat.ctimeMs || mtimeVal);
  updateManifestEntry(vaultId, normRel, { size: buffer.length, mtime: mtimeVal, ctime: ctimeVal, hash });
  invalidateContentCacheEntry(vaultId, normRel);
  const changePromise = trackRecordChange(vaultId, normRel, deltaSync.recordChange(vaultId, { path: normRel, action: 'UPSERT', size: buffer.length, mtime: mtimeVal, hash }));
  try {
    ftsEngine.onFileWrite(vaultId, normRel, buffer.toString('utf8'), { size: buffer.length, mtime: mtimeVal, hash });
  } catch {}
  try {
    gitSync.notifyChange(vaultId);
  } catch {}
  return { written: true, conflict: null, currentHash: hash, changePromise };
}

/**
 * 异步版本的 writeFile：在写盘与元数据更新完成后，确保 deltaSync 变更记录与游标持久化已完成。
 * 持久化失败会抛给调用方（调用方应在这种情况下拒绝向客户端 ack 成功文件已同步）。
 */
async function writeFileAsync(vaultId, relPath, buffer, options = {}) {
  const result = writeFile(vaultId, relPath, buffer, options);
  if (result && result.changePromise) {
    await result.changePromise;
  }
  return result;
}

/**
 * 流式版本的 writeFile：调用方已经把上传内容写到磁盘上的临时文件 tempFilePath，
 * 并且在流式接收的同时算好了 incomingHash（不需要在这里再整份读一遍新内容）。
 * 判断"服务器上现有内容"是否相同时，直接用 manifest 缓存里已经算好的 hash，
 * 而不是重新读盘+重新 sha256——这是这条路径相对 writeFile() 省掉的第二处整读整算。
 * 最终落盘用 rename（同分区下几乎零成本），而不是再写一次 Buffer。
 */
function writeFileFromPath(vaultId, relPath, tempFilePath, incomingHash, { mtime, baseHash } = {}) {
  const normRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const root = vaultFilesRoot(vaultId);
  const full = safeJoin(root, normRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const manifest = getManifest(vaultId);
  const existingMeta = manifest[normRel];

  if (fs.existsSync(full)) {
    const existingStat = fs.statSync(full);
    let existingHash = null;

    if (existingMeta && existingMeta.size === existingStat.size && existingMeta.hash) {
      existingHash = existingMeta.hash;
    } else {
      try {
        const existingBuf = fs.readFileSync(full);
        existingHash = sha256(existingBuf);
      } catch {
        existingHash = null;
      }
    }

    if (existingHash && existingHash === incomingHash) {
      // 内容没有实际变化，丢弃临时文件，只在需要时touch一下 mtime。
      try { fs.unlinkSync(tempFilePath); } catch {}
      if (mtime) {
        touchMtime(full, mtime);
        try {
          // 🛡️ 修复：touch 之后重新 stat 取真实 size/mtime。
          // 旧代码引用了未定义的 st，每次都 ReferenceError 且被空 catch 吞掉，
          // manifest 的 mtime/ctime 长期陈旧，下载响应的 X-File-Mtime 随之失真。
          const st = fs.statSync(full);
          updateManifestEntry(vaultId, normRel, { size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs || st.mtimeMs, hash: incomingHash });
        } catch {}
      }
      return { written: true, conflict: null, currentHash: incomingHash, identical: true };
    }

    if (baseHash && existingHash && existingHash !== baseHash) {
      const strategy = getEffectiveConflictStrategy();
      if (strategy === 'server_win') {
        try { fs.unlinkSync(tempFilePath); } catch {}
        return { written: false, conflict: null, serverWin: true, currentHash: existingHash };
      }
      if (strategy !== 'overwrite_latest') {
        // 服务器上的版本在这期间被别的设备改过——生成冲突副本，不动现有文件。
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(normRel);
        const base = normRel.slice(0, normRel.length - ext.length);
        const conflictRel = `${base}.conflict-${stamp}${ext}`;
        const conflictFull = safeJoin(root, conflictRel);
        moveFile(tempFilePath, conflictFull);
        if (mtime) touchMtime(conflictFull, mtime);

        const stat = fs.statSync(conflictFull);
        const mtimeVal = stat.mtimeMs || mtime || Date.now();
        const ctimeVal = (stat.birthtimeMs && stat.birthtimeMs > 0) ? stat.birthtimeMs : (stat.ctimeMs || mtimeVal);
        updateManifestEntry(vaultId, conflictRel, { size: stat.size, mtime: mtimeVal, ctime: ctimeVal, hash: incomingHash });
        invalidateContentCacheEntry(vaultId, conflictRel);
        const changePromise = trackRecordChange(vaultId, conflictRel, deltaSync.recordChange(vaultId, { path: conflictRel, action: 'UPSERT', size: stat.size, mtime: mtimeVal, hash: incomingHash }));
        try {
          if (stat.size <= 2 * 1024 * 1024) {
            const buf = fs.readFileSync(conflictFull);
            ftsEngine.onFileWrite(vaultId, conflictRel, buf.toString('utf8'), { size: stat.size, mtime: mtimeVal, hash: incomingHash });
          }
        } catch {}
        try {
          gitSync.notifyChange(vaultId);
        } catch {}

        return { written: false, conflict: conflictRel, currentHash: existingHash, conflictHash: incomingHash, conflictSize: stat.size, conflictMtime: mtimeVal, changePromise };
      }
    }

    // 真实覆盖：把旧文件直接拷贝进 history/（不读进内存），再用临时文件替换它。
    snapshotBeforeOverwriteFromFile(vaultId, normRel, full, existingStat.size);
  }

  moveFile(tempFilePath, full);
  if (mtime) touchMtime(full, mtime);
  const stat = fs.statSync(full);
  const mtimeVal = stat.mtimeMs || mtime || Date.now();
  const ctimeVal = (stat.birthtimeMs && stat.birthtimeMs > 0) ? stat.birthtimeMs : (stat.ctimeMs || mtimeVal);
  updateManifestEntry(vaultId, normRel, { size: stat.size, mtime: mtimeVal, ctime: ctimeVal, hash: incomingHash });
  invalidateContentCacheEntry(vaultId, normRel);
  const changePromise = trackRecordChange(vaultId, normRel, deltaSync.recordChange(vaultId, { path: normRel, action: 'UPSERT', size: stat.size, mtime: mtimeVal, hash: incomingHash }));
  try {
    if (stat.size <= 2 * 1024 * 1024) {
      const buf = fs.readFileSync(full);
      ftsEngine.onFileWrite(vaultId, normRel, buf.toString('utf8'), { size: stat.size, mtime: mtimeVal, hash: incomingHash });
    }
  } catch {}
  try {
    gitSync.notifyChange(vaultId);
  } catch {}
  return { written: true, conflict: null, currentHash: incomingHash, changePromise };
}

/** 异步版本的 writeFileFromPath：确保 deltaSync 变更记录与游标持久化已完成；失败会抛给调用方 */
async function writeFileFromPathAsync(vaultId, relPath, tempFilePath, incomingHash, options = {}) {
  const result = writeFileFromPath(vaultId, relPath, tempFilePath, incomingHash, options);
  if (result && result.changePromise) {
    await result.changePromise;
  }
  return result;
}

/** Soft-delete: move the file into trash/ instead of unlinking it outright. */
function deleteFile(vaultId, relPath) {
  const normRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = safeJoin(vaultFilesRoot(vaultId), normRel);
  if (!fs.existsSync(full)) return false;

  fs.mkdirSync(trashDir(vaultId), { recursive: true });
  const id = randomId();
  fs.renameSync(full, path.join(trashDir(vaultId), id));

  // 同步清单只记录文件；删除最后一个文件后清理空父目录，避免服务端遗留旧目录树。
  const filesRoot = path.resolve(vaultFilesRoot(vaultId));
  let parentDir = path.dirname(full);
  while (parentDir !== filesRoot && parentDir.startsWith(filesRoot + path.sep)) {
    try {
      fs.rmdirSync(parentDir);
      parentDir = path.dirname(parentDir);
    } catch {
      break; // 目录仍有文件、子目录或当前进程无权删除时保留
    }
  }

  const idxPath = trashIndexPath(vaultId);
  const size = fs.statSync(path.join(trashDir(vaultId), id)).size;
  mutateIndex(idxPath, (entries) => {
    entries.push({ id, path: normRel, size, deletedAt: Date.now() });
    return entries;
  });
  updateManifestEntry(vaultId, normRel, null);
  invalidateContentCacheEntry(vaultId, normRel);
  trackRecordChange(vaultId, normRel, deltaSync.recordChange(vaultId, { path: normRel, action: 'DELETE', size: 0, mtime: Date.now() }));
  try {
    ftsEngine.onFileDelete(vaultId, normRel);
  } catch {}
  try {
    gitSync.notifyChange(vaultId);
  } catch {}

  return true;
}

/** 异步版本的 deleteFile：确保 deltaSync 变更记录与游标持久化已完成 */
async function deleteFileAsync(vaultId, relPath) {
  const normRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = safeJoin(vaultFilesRoot(vaultId), normRel);
  if (!fs.existsSync(full)) return false;

  fs.mkdirSync(trashDir(vaultId), { recursive: true });
  const id = randomId();
  fs.renameSync(full, path.join(trashDir(vaultId), id));

  const idxPath = trashIndexPath(vaultId);
  const size = fs.statSync(path.join(trashDir(vaultId), id)).size;
  mutateIndex(idxPath, (entries) => {
    entries.push({ id, path: normRel, size, deletedAt: Date.now() });
    return entries;
  });
  updateManifestEntry(vaultId, normRel, null);
  invalidateContentCacheEntry(vaultId, normRel);
  // 🛡️ durable 语义与写路径对齐：DELETE 变更记录持久化失败必须向上抛出
  // （HTTP DELETE 回 5xx / WS 无 ack），由客户端挂起重试。旧实现吞掉错误仍
  // 返回 true，其他设备在 delta 通道上将永远收不到这条删除。
  // 文件本身删除已成功（回收站 + manifest 清理），重试幂等收敛由
  // wsHub 的 `completed = ok || !manifestEntry` 保证：文件已不在时仍回 ack deleted:true。
  await deltaSync.recordChange(vaultId, { path: normRel, action: 'DELETE', size: 0, mtime: Date.now() });
  try {
    ftsEngine.onFileDelete(vaultId, normRel);
  } catch {}
  try {
    gitSync.notifyChange(vaultId);
  } catch {}

  return true;
}

// ------------------------------ search & stats -----------------------------------

// 每个 vault 一份文本内容缓存：relPath -> { mtimeMs, size, content }
// 命中缓存就不用再同步读盘，是重复搜索时最大的一块开销来源。
const contentCache = new Map();
const MAX_CONTENT_CACHE_PER_VAULT = 250;
const MAX_SEARCHABLE_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB: 超过 2MB 的巨型文件只做路径匹配，不加载全文本入内存

function getContentCache(vaultId) {
  if (!contentCache.has(vaultId)) contentCache.set(vaultId, new Map());
  return contentCache.get(vaultId);
}

function setContentCache(vaultId, relPath, entry) {
  const cache = getContentCache(vaultId);
  if (cache.size >= MAX_CONTENT_CACHE_PER_VAULT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(relPath, entry);
}

/** 文件被写入/删除时，让内容缓存与标签索引缓存跟着失效——避免命中过期内容。 */
function invalidateContentCacheEntry(vaultId, relPath) {
  const cache = contentCache.get(vaultId);
  if (cache) cache.delete(relPath);
  invalidateTagCacheEntry(vaultId, relPath);
}

const SEARCHABLE_EXT_RE = /\.(md|txt|json|js|ts|css|html|yaml|yml|csv|canvas)$/i;
// 每处理这么多个文件就让出一次事件循环，避免大 vault 全文搜索长时间卡住整个进程
const SEARCH_YIELD_BATCH_SIZE = 40;

/**
 * 读取一个文件的文本内容，命中缓存（size/mtime 都没变）就不用重新读盘。
 * 导出给 mcp.js 的 get_vault_stats / search_notes / list_tags 复用，
 * 这几个工具需要遍历整个 vault 的文本内容，不应该各自再实现一遍读盘逻辑。
 * meta 是调用方已经从 getManifest() 里拿到的那条 { size, mtime, ... }，避免重复查表。
 */
function getTextContent(vaultId, relPath, meta) {
  if (meta && meta.size > MAX_SEARCHABLE_CONTENT_BYTES) {
    return null; // 超限大文件跳过文本读取，防止搜索导致 V8 内存爆炸
  }
  const cache = getContentCache(vaultId);
  const cached = cache.get(relPath);
  if (cached && cached.mtimeMs === meta.mtime && cached.size === meta.size) {
    return cached.content;
  }
  const buf = readFile(vaultId, relPath);
  if (!buf) return null;
  const text = buf.toString('utf8');
  setContentCache(vaultId, relPath, { mtimeMs: meta.mtime, size: meta.size, content: text });
  return text;
}

/**
 * 毫秒级倒排索引 + BM25 排序检索
 */
async function searchVault(vaultId, query, limit = 50) {
  if (!query || !query.trim()) return [];
  const q = query.trim();

  // 1. Trigger background index warm-up if not already loaded/indexed
  const manifest = await getManifestAsync(vaultId);
  const idx = ftsEngine.getIndex(vaultId);
  if (!idx.isLoaded || idx.docCount === 0) {
    // Warm up index asynchronously
    ftsEngine.buildVaultIndexAsync(vaultId, manifest, (p) => readFile(vaultId, p));
  }

  // 2. Perform fast FTS search using inverted index + BM25
  const readContentFn = (relPath) => {
    const meta = manifest[relPath];
    return getTextContent(vaultId, relPath, meta);
  };

  const ftsResults = ftsEngine.searchVault(vaultId, q, { limit, readContentFn });
  if (ftsResults && ftsResults.length > 0) {
    return ftsResults;
  }

  // 3. Fallback: linear scan for files (e.g. while background index is building)
  const qLower = q.toLowerCase();
  const paths = Object.keys(manifest).sort();
  const results = [];

  let processed = 0;
  for (const relPath of paths) {
    const meta = manifest[relPath];
    const pathLower = relPath.toLowerCase();
    const isPathMatch = pathLower.includes(qLower);

    let snippet = '';
    let matchesCount = 0;

    if (SEARCHABLE_EXT_RE.test(relPath) && meta.size <= MAX_SEARCHABLE_CONTENT_BYTES) {
      const text = getTextContent(vaultId, relPath, meta);

      if (text) {
        const lowerText = text.toLowerCase();
        let idxPos = lowerText.indexOf(qLower);
        while (idxPos !== -1 && matchesCount < 5) {
          matchesCount++;
          if (!snippet) {
            const start = Math.max(0, idxPos - 40);
            const end = Math.min(text.length, idxPos + qLower.length + 60);
            snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/[\r\n]+/g, ' ') + (end < text.length ? '…' : '');
          }
          idxPos = lowerText.indexOf(qLower, idxPos + qLower.length);
        }
      }
    }

    if (isPathMatch || matchesCount > 0) {
      results.push({
        path: relPath,
        size: meta.size,
        mtime: meta.mtime,
        isPathMatch,
        matchesCount,
        snippet,
      });
    }

    processed++;
    if (processed % SEARCH_YIELD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  results.sort((a, b) => {
    if (a.isPathMatch && !b.isPathMatch) return -1;
    if (!a.isPathMatch && b.isPathMatch) return 1;
    return b.matchesCount - a.matchesCount;
  });

  return results.slice(0, limit);
}

/** Vault statistics summary. */
async function getVaultStats(vaultId) {
  const manifest = await getManifestAsync(vaultId);
  const paths = Object.keys(manifest);
  let totalBytes = 0;
  let notesCount = 0;
  let attachmentsCount = 0;
  let configsCount = 0;

  for (const p of paths) {
    const meta = manifest[p];
    totalBytes += meta.size;
    if (p.toLowerCase().endsWith('.md')) {
      notesCount++;
    } else if (p.startsWith('.obsidian/')) {
      configsCount++;
    } else {
      attachmentsCount++;
    }
  }

  const trashEntries = loadIndex(trashIndexPath(vaultId));
  const historyEntries = loadIndex(historyIndexPath(vaultId));

  return {
    totalFiles: paths.length,
    notesCount,
    attachmentsCount,
    configsCount,
    totalBytes,
    trashCount: trashEntries.length,
    historyCount: historyEntries.length,
  };
}

/** Stream a ZIP archive of all files in vault's files/ folder. */
function exportVaultZip(vaultId, outputStream) {
  const archive = createArchiver('zip', { zlib: { level: 6 } });
  archive.pipe(outputStream);
  const root = vaultFilesRoot(vaultId);
  if (fs.existsSync(root)) {
    archive.directory(root, false, (entry) => !isPrivateVaultPath(entry.name));
  }
  return archive.finalize();
}

/** Create a ZIP snapshot file on disk for a vault's files/ folder (used by cloudBackup). */
async function createVaultZipSnapshot(vaultId, destZipPath) {
  fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
  const output = fs.createWriteStream(destZipPath);
  const archive = createArchiver('zip', { zlib: { level: 6 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve({ path: destZipPath, size: archive.pointer() }));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    const root = vaultFilesRoot(vaultId);
    if (fs.existsSync(root)) {
      archive.directory(root, false);
    }
    archive.finalize();
  });
}

/** Stream a ZIP archive of selected files in vault's files/ folder. */
function exportFilesZip(vaultId, relPaths, outputStream) {
  const archive = createArchiver('zip', { zlib: { level: 6 } });
  archive.pipe(outputStream);
  const root = vaultFilesRoot(vaultId);
  const pathSet = new Set(Array.isArray(relPaths) ? relPaths : [relPaths]);
  for (const rel of pathSet) {
    if (!rel || typeof rel !== 'string') continue;
    const full = safeJoin(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      archive.file(full, { name: rel });
    }
  }
  return archive.finalize();
}

/** Move or rename a file within a vault */
function moveVaultFile(vaultId, oldRelPath, newRelPath, options = {}) {
  const overwrite = Boolean(options && options.overwrite);
  const normOld = String(oldRelPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normNew = String(newRelPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const root = vaultFilesRoot(vaultId);
  const oldFull = safeJoin(root, normOld);
  const newFull = safeJoin(root, normNew);
  if (!fs.existsSync(oldFull)) return { ok: false, error: '原文件不存在' };
  if (fs.existsSync(newFull) && oldFull !== newFull) {
    if (!overwrite) {
      return { ok: false, error: '目标路径已存在同名文件' };
    }
    try {
      const existingStat = fs.statSync(newFull);
      snapshotBeforeOverwriteFromFile(vaultId, normNew, newFull, existingStat.size);
    } catch {}
  }

  // Reuse existing manifest hash & cached text content before rename to avoid redundant disk reads
  const oldMeta = getManifestEntry(vaultId, normOld);
  const vContentCache = contentCache.get(vaultId);
  const cachedTextObj = vContentCache ? vContentCache.get(normOld) : null;

  fs.mkdirSync(path.dirname(newFull), { recursive: true });
  moveFile(oldFull, newFull);

  // 更新历史版本索引中的路径，确保重命名后历史版本链路不丢失
  const idxPath = historyIndexPath(vaultId);
  try {
    mutateIndex(idxPath, (entries) => {
      for (const entry of entries) {
        if (entry.path === normOld) {
          entry.path = normNew;
        }
      }
      return entries;
    });
  } catch (e) {
    console.warn('[Storage] 重命名历史版本索引关联失败:', e.message);
  }

  updateManifestEntry(vaultId, normOld, null);
  invalidateContentCacheEntry(vaultId, normOld);
  const pDel = trackRecordChange(vaultId, normOld, deltaSync.recordChange(vaultId, { path: normOld, action: 'DELETE', size: 0, mtime: Date.now() }));
  try {
    ftsEngine.onFileDelete(vaultId, normOld);
  } catch {}

  const stat = fs.statSync(newFull);
  let fileBuf = null;
  let hash = oldMeta && oldMeta.size === stat.size && oldMeta.hash ? oldMeta.hash : null;
  if (!hash) {
    fileBuf = fs.readFileSync(newFull);
    hash = sha256(fileBuf);
  }
  const mtimeVal = stat.mtimeMs || Date.now();
  const ctimeVal = oldMeta?.ctime || stat.birthtimeMs || stat.ctimeMs || mtimeVal;
  updateManifestEntry(vaultId, normNew, { size: stat.size, mtime: mtimeVal, ctime: ctimeVal, hash });
  invalidateContentCacheEntry(vaultId, normNew);
  const pUpsert = trackRecordChange(vaultId, normNew, deltaSync.recordChange(vaultId, { path: normNew, action: 'UPSERT', size: stat.size, mtime: mtimeVal, hash }));
  const changePromise = Promise.all([pDel, pUpsert]);
  try {
    if (SEARCHABLE_EXT_RE.test(normNew) && stat.size <= 2 * 1024 * 1024) {
      const text = cachedTextObj && cachedTextObj.size === stat.size
        ? cachedTextObj.content
        : (fileBuf || fs.readFileSync(newFull)).toString('utf8');
      ftsEngine.onFileWrite(vaultId, normNew, text, { size: stat.size, mtime: mtimeVal, hash });
    }
  } catch {}

  try { gitSync.notifyChange(vaultId); } catch {}
  return { ok: true, hash, mtime: mtimeVal, size: stat.size, changePromise };
}

/** 异步版本：等待两条变更记录（DELETE 旧路径 + UPSERT 新路径）持久化完成；失败抛给调用方 */
async function moveVaultFileAsync(vaultId, oldRelPath, newRelPath, options = {}) {
  const res = moveVaultFile(vaultId, oldRelPath, newRelPath, options);
  if (res && res.changePromise) {
    await res.changePromise;
  }
  if (res && res.changePromise !== undefined) delete res.changePromise;
  return res;
}

/**
 * Automatically purge expired items in trash older than maxDays
 */
async function purgeExpiredTrash(vaultId, maxDays = 30) {
  const days = Number(maxDays) > 0 ? Number(maxDays) : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const idxPath = trashIndexPath(vaultId);
  const entries = loadIndex(idxPath);
  const expiredIds = entries.filter((e) => (e.deletedAt || 0) < cutoff).map((e) => e.id);
  if (expiredIds.length === 0) return { purgedCount: 0 };
  return await purgeBatchTrash(vaultId, expiredIds);
}

/**
 * Clean up old history versions according to retention policy:
 * - Keep all versions within maxDays (default 30 days)
 * - Cap max versions per file (default 20)
 * Returns { cleanedCount, freedBytes }
 */
function cleanupOldHistoryVersions(vaultId, maxDays = 30, maxVersionsPerPath = 20) {
  const idxPath = historyIndexPath(vaultId);
  let cleanedCount = 0;
  let freedBytes = 0;

  mutateIndex(idxPath, (entries) => {
    if (!entries.length) return entries;

    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const byPath = new Map();

    for (const entry of entries) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, []);
      byPath.get(entry.path).push(entry);
    }

    const toKeep = [];
    const toDrop = [];

    for (const [, fileEntries] of byPath.entries()) {
      // Sort newest first
      fileEntries.sort((a, b) => b.savedAt - a.savedAt);
      fileEntries.forEach((entry, idx) => {
        // Keep at least 1 most recent version even if older than cutoff
        if (idx === 0) {
          toKeep.push(entry);
        } else if (idx >= maxVersionsPerPath || entry.savedAt < cutoff) {
          toDrop.push(entry);
        } else {
          toKeep.push(entry);
        }
      });
    }

    for (const drop of toDrop) {
      const full = path.join(historyDir(vaultId), drop.id);
      try {
        if (fs.existsSync(full)) {
          freedBytes += drop.size || 0;
          fs.unlinkSync(full);
        }
      } catch {}
    }

    cleanedCount = toDrop.length;
    return toKeep;
  });

  return { cleanedCount, freedBytes };
}

module.exports = {
  getManifest,
  getManifestAsync,
  getManifestEntry,
  getManifestEntryAsync,
  walkAsync,
  invalidateManifestCache,
  readFile,
  readFileStream,
  createUploadTempPath,
  writeFile,
  writeFileAsync,
  writeFileFromPath,
  writeFileFromPathAsync,
  deleteFile,
  deleteFileAsync,
  sha256,
  safeJoin,
  listHistory,
  readHistoryVersion,
  cleanupOldHistoryVersions,
  listTrash,
  readTrashVersion,
  restoreFromTrash,
  restoreBatchTrash,
  restoreAllTrash,
  purgeTrash,
  purgeBatchTrash,
  purgeAllTrash,
  purgeExpiredTrash,
  searchVault,
  getVaultTags,
  getVaultStats,
  exportVaultZip,
  createVaultZipSnapshot,
  exportFilesZip,
  moveVaultFile,
  moveVaultFileAsync,
  cleanupAllStaleUploadTemps,
  getTextContent,
  yieldToEventLoop,
  SEARCHABLE_EXT_RE,
  SEARCH_YIELD_BATCH_SIZE,
  isNoiseFile,
  pruneVaultHistory,
  withFileLock,
  waitForVaultLocks,
  withDualFileLock,
  clearVaultCache,
  deleteVaultDirectory,
};
