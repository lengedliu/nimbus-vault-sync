const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { vaultFilesRoot, vaultRoot, listForUser, getById } = require('./vaults');
const { validateGitRemoteUrl } = require('./utils/gitUrlGuard');
const { encryptField, decryptField } = require('./utils/crypto');

/**
 * Git Auto-Backup and Remote Sync Engine for Nimbus Vault Sync
 * Modeled after haierkeys/fast-note-sync-service Git Automation:
 * - Auto-initializes git repository in vault notes root
 * - Supports GitHub / Gitee / GitLab / self-hosted Git repositories (HTTPS with Token / Password)
 * - Real-time debounced auto-commit & push on vault note changes
 * - Scheduled periodic backups
 * - Status inspection, remote connectivity test, pull & push, and commit history logs
 */

const debounceTimers = new Map(); // vaultId -> NodeJS.Timeout
const vaultLocks = new Map(); // vaultId -> Promise chain

async function withVaultLock(vaultId, fn) {
  const current = vaultLocks.get(vaultId) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const queued = current.then(() => next, () => next);
  vaultLocks.set(vaultId, queued);

  try {
    await current;
    return await fn();
  } finally {
    release();
    if (vaultLocks.get(vaultId) === queued) {
      vaultLocks.delete(vaultId);
    }
  }
}

function getGitConfigFile(vaultId) {
  return path.join(vaultRoot(vaultId), 'git-config.json');
}

const DEFAULT_CONFIG = {
  enabled: false,
  remoteUrl: '',
  branch: 'main',
  username: '',
  token: '',
  authorName: 'Nimbus Sync',
  authorEmail: 'sync@nimbus.local',
  autoPushOnChange: false,
  debounceSeconds: 15,
  scheduleInterval: 'off', // 'off' | 'hourly' | 'daily'
  commitMsgTemplate: 'Auto sync: {files_count} files changed [{datetime}]',
  pullBeforePush: true,
};

function loadConfig(vaultId) {
  const p = getGitConfigFile(vaultId);
  if (!fs.existsSync(p)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...raw };
    // token 落盘时是加密过的（enc:v1:...），这里统一解密成明文给内部逻辑用；
    // decryptField 对还没升级过的旧明文数据会原样返回，升级不会丢已有配置。
    merged.token = decryptField(merged.token);
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(vaultId, config) {
  // 保存时就校验，避免一开始就把一个危险的 remoteUrl 落盘——这是防线之一，
  // 不是唯一防线：下面 updateRemoteUrl/testConnection 在真正调用 git 命令前还会再查一次，
  // 这样就算磁盘上已经有升级前被写入的旧的危险配置，也不会被放行执行。
  if (Object.prototype.hasOwnProperty.call(config, 'remoteUrl')) {
    validateGitRemoteUrl(config.remoteUrl);
  }
  const p = getGitConfigFile(vaultId);
  const current = loadConfig(vaultId); // 已经是解密后的明文
  const updated = { ...current, ...config };
  // 落盘前才加密——updated（返回给调用方的）保持明文，磁盘上的文件是密文，
  // 这样 gitSync.js 内部其他函数、以及 REST/MCP 调用方都不需要关心加密细节。
  const toPersist = { ...updated, token: encryptField(updated.token) };
  fs.writeFileSync(p, JSON.stringify(toPersist, null, 2), 'utf8');
  return updated;
}

function isGitRepo(vaultId) {
  const repoDir = vaultFilesRoot(vaultId);
  const gitDir = path.join(repoDir, '.git');
  return fs.existsSync(gitDir);
}

function execGitRaw(vaultId, args, env = {}) {
  const cwd = vaultFilesRoot(vaultId);
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  return new Promise((resolve) => {
    const defaultEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'en_US.UTF-8',
      ...env,
    };

    execFile('git', args, { cwd, env: defaultEnv, maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        code: error ? error.code : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

async function execGit(vaultId, args, env = {}) {
  return execGitRaw(vaultId, args, env);
}

function formatCommitMessage(template, filesCount) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datetime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  
  let msg = template || DEFAULT_CONFIG.commitMsgTemplate;
  msg = msg.replace('{files_count}', String(filesCount || 1));
  msg = msg.replace('{datetime}', datetime);
  msg = msg.replace('{timestamp}', String(Date.now()));
  return msg;
}

/** Build authenticated remote URL if username/token are provided */
function buildAuthUrl(remoteUrl, username, token) {
  if (!remoteUrl) return '';
  const trimmed = remoteUrl.trim();
  if (!username && !token) return trimmed;

  try {
    const urlObj = new URL(trimmed);
    if (urlObj.protocol === 'https:' || urlObj.protocol === 'http:') {
      if (token && username) {
        urlObj.username = encodeURIComponent(username);
        urlObj.password = encodeURIComponent(token);
      } else if (token) {
        urlObj.username = 'oauth2';
        urlObj.password = encodeURIComponent(token);
      }
      return urlObj.toString();
    }
  } catch {
    // If not standard URL (e.g. ssh), return as-is
  }
  return trimmed;
}

/** Mask password/token in URL or text for safe display/logging */
function maskSecrets(text) {
  if (!text) return '';
  return text.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, '$1$2:***@');
}

/**
 * Initialize Git repository in vault files root
 */
async function initRepo(vaultId) {
  const config = loadConfig(vaultId);
  const cwd = vaultFilesRoot(vaultId);
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  // Create default .gitignore if not present
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = [
      '# OS generated files',
      '.DS_Store',
      '.DS_Store?',
      '._*',
      '.Spotlight-V100',
      '.Trashes',
      'ehthumbs.db',
      'Thumbs.db',
      '# Temp files',
      '*.tmp',
      '*.sync-conflict-*',
      '',
    ].join('\n');
    fs.writeFileSync(gitignorePath, gitignoreContent, 'utf8');
  }

  // git init
  await execGit(vaultId, ['init', '-b', config.branch || 'main']);

  // Configure author
  await execGit(vaultId, ['config', 'user.name', config.authorName || 'Nimbus Sync']);
  await execGit(vaultId, ['config', 'user.email', config.authorEmail || 'sync@nimbus.local']);
  await execGit(vaultId, ['config', 'core.quotepath', 'false']);
  await execGit(vaultId, ['config', 'pull.rebase', 'true']);

  // Set remote origin if configured
  if (config.remoteUrl) {
    await updateRemoteUrl(vaultId, config);
  }

  return { ok: true, initialized: true };
}

async function updateRemoteUrl(vaultId, config) {
  // 真正要把这个地址交给 git 子进程之前再校验一次——即使 config 是从磁盘上的旧文件加载的
  // （比如这次修复上线前就已经被写入的危险值），这里也会拦下来，不会被放行执行。
  validateGitRemoteUrl(config.remoteUrl);
  const authUrl = buildAuthUrl(config.remoteUrl, config.username, config.token);
  const remotesRes = await execGit(vaultId, ['remote']);
  const hasOrigin = remotesRes.stdout.split('\n').map((s) => s.trim()).includes('origin');

  if (hasOrigin) {
    await execGit(vaultId, ['remote', 'set-url', 'origin', authUrl]);
  } else if (authUrl) {
    await execGit(vaultId, ['remote', 'add', 'origin', authUrl]);
  }
}

/**
 * Get comprehensive Git status for vault
 */
async function getStatus(vaultId) {
  const config = loadConfig(vaultId);
  const initialized = isGitRepo(vaultId);

  if (!initialized) {
    return {
      initialized: false,
      config: { ...config, token: config.token ? '********' : '' },
      branch: config.branch || 'main',
      remoteUrl: config.remoteUrl,
      uncommittedCount: 0,
      changedFiles: [],
      lastCommit: null,
      lastPush: config.lastPush || null,
      statusText: 'Git 仓库未初始化',
    };
  }

  // Branch
  const branchRes = await execGit(vaultId, ['branch', '--show-current']);
  const currentBranch = branchRes.stdout || config.branch || 'main';

  // Status porcelain
  const statusRes = await execGit(vaultId, ['status', '--porcelain', '-uall']);
  const changedFiles = [];
  if (statusRes.stdout) {
    const lines = statusRes.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
      changedFiles.push({ code, path: filePath });
    }
  }

  // Last commit
  const logRes = await execGit(vaultId, ['log', '-1', '--pretty=format:%H%x00%an%x00%ar%x00%s%x00%ad']);
  let lastCommit = null;
  if (logRes.success && logRes.stdout) {
    const [hash, author, relativeTime, message, date] = logRes.stdout.split('\x00');
    lastCommit = { hash, shortHash: hash ? hash.slice(0, 7) : '', author, relativeTime, message, date };
  }

  // Unpushed count if remote exists
  let unpushedCommits = 0;
  if (config.remoteUrl) {
    const unpushedRes = await execGit(vaultId, ['rev-list', `origin/${currentBranch}..HEAD`, '--count']);
    if (unpushedRes.success) {
      unpushedCommits = parseInt(unpushedRes.stdout, 10) || 0;
    }
  }

  return {
    initialized: true,
    config: { ...config, token: config.token ? '********' : '' },
    branch: currentBranch,
    remoteUrl: maskSecrets(config.remoteUrl),
    uncommittedCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, 100),
    unpushedCommits,
    lastCommit,
    lastPush: config.lastPush || null,
    statusText: changedFiles.length > 0 ? `有 ${changedFiles.length} 个未提交变更` : '工作区干净，所有文件已提交',
  };
}

/**
 * Test remote connection using git ls-remote
 */
async function testConnection(vaultId, testParams = {}) {
  const current = loadConfig(vaultId);
  const remoteUrl = testParams.remoteUrl || current.remoteUrl;
  const username = testParams.username !== undefined ? testParams.username : current.username;
  const token = testParams.token !== undefined ? testParams.token : current.token;
  const branch = testParams.branch || current.branch || 'main';

  if (!remoteUrl) {
    return { ok: false, error: '请先填写远端 Git 仓库地址 (URL)' };
  }

  try {
    validateGitRemoteUrl(remoteUrl);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const authUrl = buildAuthUrl(remoteUrl, username, token);
  const result = await execGit(vaultId, ['ls-remote', '-h', authUrl, branch]);

  if (result.success) {
    return {
      ok: true,
      message: `连通性测试成功！已成功连接到远端仓库分支 ${branch}`,
      branchFound: result.stdout.includes(branch),
      output: maskSecrets(result.stdout),
    };
  } else {
    return {
      ok: false,
      error: maskSecrets(result.stderr || result.stdout || '连接失败，请检查 URL、分支名与访问凭证 (Token/Password)'),
    };
  }
}

/**
 * Stage all changes, commit, and push to remote
 */
async function commitAndPush(vaultId, { customMessage, author } = {}) {
  if (!isGitRepo(vaultId)) {
    await initRepo(vaultId);
  }

  const config = loadConfig(vaultId);
  const branch = config.branch || 'main';

  // Ensure remote origin is configured
  if (config.remoteUrl) {
    await updateRemoteUrl(vaultId, config);
  }

  // 1. Stage all changes
  await execGit(vaultId, ['add', '-A']);

  // 2. Check if there are changes to commit
  const statusRes = await execGit(vaultId, ['status', '--porcelain']);
  const hasChanges = Boolean(statusRes.stdout && statusRes.stdout.trim());
  const changedLines = hasChanges ? statusRes.stdout.trim().split('\n').length : 0;

  let commitHash = null;
  if (hasChanges) {
    const commitMsg = customMessage || formatCommitMessage(config.commitMsgTemplate, changedLines);
    const authorEnv = {};
    if (author) {
      authorEnv.GIT_AUTHOR_NAME = author;
      authorEnv.GIT_COMMITTER_NAME = author;
    }

    const commitRes = await execGit(vaultId, ['commit', '-m', commitMsg], authorEnv);
    if (!commitRes.success) {
      return { ok: false, stage: 'commit', error: maskSecrets(commitRes.stderr || commitRes.stdout) };
    }

    const hashRes = await execGit(vaultId, ['rev-parse', 'HEAD']);
    commitHash = hashRes.stdout.trim();
  }

  // 3. Push to remote if remote URL configured
  if (config.remoteUrl) {
    // Optional pull rebase before pushing
    if (config.pullBeforePush) {
      const pullRes = await execGit(vaultId, ['pull', '--rebase', 'origin', branch]);
      if (!pullRes.success && !pullRes.stderr.includes('Couldn\'t find remote ref')) {
        // Log warning but try push or return
      }
    }

    const pushRes = await execGit(vaultId, ['push', '-u', 'origin', branch]);
    if (!pushRes.success) {
      const errorMsg = maskSecrets(pushRes.stderr || pushRes.stdout);
      saveConfig(vaultId, {
        lastPush: {
          success: false,
          time: Date.now(),
          error: errorMsg,
        },
      });
      return {
        ok: false,
        stage: 'push',
        committed: hasChanges,
        commitHash,
        error: errorMsg,
      };
    }

    saveConfig(vaultId, {
      lastPush: {
        success: true,
        time: Date.now(),
        commitHash,
      },
    });

    return {
      ok: true,
      committed: hasChanges,
      pushed: true,
      commitHash,
      filesChanged: changedLines,
      message: hasChanges ? `已成功提交 ${changedLines} 个文件变更并推送到远端 ${branch} 分支` : `工作区无新变更，已与远端 ${branch} 保持同步`,
    };
  }

  return {
    ok: true,
    committed: hasChanges,
    pushed: false,
    commitHash,
    filesChanged: changedLines,
    message: hasChanges ? `已成功生成本地 Git 提交 (${changedLines} 个文件)` : '工作区无变更，无需提交',
  };
}

/**
 * Pull latest changes from remote
 */
/**
 * git pull 后的 durable 段（W-8）：diff ORIG_HEAD..HEAD → 重建 manifest →
 * 把变更写入 deltaSync 增量日志。任何一步失败都向上抛出（调用方拿到真实
 * 失败并重试），绝不再吞错静默「成功」。
 */
async function recordPulledChanges(vaultId) {
  const changedPaths = [];
  const deletePaths = [];
  const storage = require('./storage');
  const deltaSync = require('./deltaSync');
  const syncRules = require('./syncRules');

  // 🛡️ 记录 git pull 引入的文件变更：旧实现完全旁路 deltaSync，游标不推进，
  // 增量终端（/changes）将永久漏掉这批变更，直到下次全量对账。
  const diffRes = await execGit(vaultId, ['diff', '--name-status', 'ORIG_HEAD', 'HEAD']);
  const upsertChanges = [];
  if (diffRes.success && diffRes.stdout) {
    for (const line of diffRes.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const status = (parts[0] || '').charAt(0).toUpperCase();
      const filePath = parts[parts.length - 1];
      if (!filePath) continue;
      const rel = filePath.replace(/\\/g, '/');
      // 🛡️ E-2：黑名单路径不进同步域——不记录 delta、不参与广播（与 REST PUT 的
      // ignored 语义对齐，避免 git pull 借道把 ignores 外的规则目录写回同步域）
      if (syncRules.isPathIgnored(vaultId, rel)) continue;
      if (status === 'D' && parts.length === 2) {
        upsertChanges.push({ path: rel, action: 'DELETE', size: 0, mtime: Date.now(), hash: '' });
        // 🛡️ E-1：删除路径必须参与广播（broadcastPulledChanges → 'deleted'），
        // 否则在线客户端游标会越过从未收到/应用的删除，被删文件在其他设备永久滞留
        deletePaths.push(rel);
        continue;
      }
      if (parts.length >= 3 && (status === 'R' || status === 'C')) {
        // R100/Copy 重命名：diff 只报告新路径，旧路径"消失"需要补一条 DELETE
        const oldRel = parts[1].replace(/\\/g, '/');
        if (!syncRules.isPathIgnored(vaultId, oldRel)) {
          upsertChanges.push({ path: oldRel, action: 'DELETE', size: 0, mtime: Date.now(), hash: '' });
          deletePaths.push(oldRel);
        }
      }
      upsertChanges.push({ path: rel, action: 'UPSERT', size: 0, mtime: Date.now(), hash: '' });
      changedPaths.push(rel);
    }
  }

  storage.invalidateManifestCache(vaultId);
  const newManifest = await storage.getManifestAsync(vaultId, true);

  // 为 UPSERT 补齐 manifest 里的精确元数据（size/mtime/hash）
  const finalChanges = [];
  for (const ch of upsertChanges) {
    const meta = newManifest[ch.path];
    if (ch.action === 'UPSERT' && meta) {
      finalChanges.push({ path: ch.path, action: 'UPSERT', size: meta.size, mtime: meta.mtime, hash: meta.hash });
    } else {
      finalChanges.push(ch);
    }
  }

  if (finalChanges.length > 0) {
    // 🛡️ durable 语义（W-8）：失败上抛而非吞错继续。游标只在 durable 后推进的
    // 全局合约由这里维持；重试幂等由 ORIG_HEAD 语义保证（无新提交时不移动）。
    await deltaSync.recordBatchChanges(vaultId, finalChanges);
    console.log(`[GitSync] 已将 git pull 引入的 ${finalChanges.length} 条文件变更写入增量记录`);
  }

  return { changedPaths, deletePaths, manifest: newManifest };
}

/**
 * git pull 后的 best-effort 广播（E-1）：UPSERT 路径走批量 change 通知，
 * DELETE 路径逐个走 'deleted' 通知。旧实现只广播 changedPaths（UPSERT），
 * 删除路径从不进广播——在线客户端把游标推进到已包含 DELETE 的最新游标、
 * 却从未收到该删除，被 git pull 删除的文件在其他设备永久滞留。
 */
function broadcastPulledChanges(vaultId, { changedPaths = [], deletePaths = [] } = {}) {
  const wsHub = require('./wsHub');
  if (!wsHub) return;
  if (typeof wsHub.broadcastBatchFileChange === 'function' && changedPaths.length > 0) {
    // 只广播本次 pull 真正变更的路径，而不是全库所有文件
    wsHub.broadcastBatchFileChange(vaultId, changedPaths, null, null);
  }
  if (Array.isArray(deletePaths)) {
    for (const p of deletePaths) {
      if (typeof wsHub.broadcastFileDelete === 'function') {
        wsHub.broadcastFileDelete(vaultId, p, null, null);
      }
    }
  }
}

async function pull(vaultId) {
  if (!isGitRepo(vaultId)) {
    await initRepo(vaultId);
  }

  const config = loadConfig(vaultId);
  if (!config.remoteUrl) {
    return { ok: false, error: '未配置远端 Git 仓库地址' };
  }

  await updateRemoteUrl(vaultId, config);
  const branch = config.branch || 'main';

  const pullRes = await execGit(vaultId, ['pull', 'origin', branch]);
  if (!pullRes.success) {
    return { ok: false, error: maskSecrets(pullRes.stderr || pullRes.stdout) };
  }

  // 远端拉取成功后：先走 durable 段（manifest 重建 + delta 记录，失败上抛），
  // 再走 best-effort 段（FTS/广播，失败仅降级）。
  // 🛡️ W-8：durable 段失败必须让调用方感知（HTTP 5xx / MCP 工具错误 / 调度器
  // catch 警告）。旧实现整段吞错继续返回「拉取成功」——git 已把远端提交写到
  // Vault 磁盘，但 manifest/增量日志/游标都不认识这批文件，delta-only 客户端
  // 永远漏拉，只能等手动全量对账。重试安全：已拉取的重跑 pull() 是 no-op，
  // ORIG_HEAD 在无新提交时不移动，diff 仍能重放同一批变更（与 restore 路径
  // W-7 同型契约）。
  const { changedPaths, deletePaths, manifest: newManifest } = await recordPulledChanges(vaultId);

  // —— best-effort 段：FTS 与广播失败仅降级，不影响 pull 的成功语义 ——
  try {
    const storage = require('./storage');
    // FTS 倒排索引：使用实际存在的 buildVaultIndexAsync（此前的 rebuildVaultIndex 根本不存在，
    // typeof 判断让它被静默跳过，FTS 索引在 pull 后一直是过期状态）
    const ftsEngine = require('./ftsEngine');
    if (ftsEngine && typeof ftsEngine.buildVaultIndexAsync === 'function') {
      ftsEngine.buildVaultIndexAsync(vaultId, newManifest, (p) => storage.readFile(vaultId, p)).catch(() => {});
    }

    const wsHub = require('./wsHub');
    if (wsHub) {
      // 🛡️ E-1：删除路径也必须广播（'deleted'），UPSERT 走批量 change
      broadcastPulledChanges(vaultId, { changedPaths, deletePaths });
    }
  } catch (err) {
    console.error(`[GitSync] 远端拉取后刷新缓存/广播失败: ${vaultId}`, err);
  }

  return {
    ok: true,
    message: `拉取成功：${pullRes.stdout || '已是最新状态'}`,
    output: maskSecrets(pullRes.stdout),
  };
}

/**
 * Get commit history logs
 */
async function getLogs(vaultId, limit = 25) {
  if (!isGitRepo(vaultId)) {
    return [];
  }

  const result = await execGit(vaultId, [
    'log',
    `-n${limit}`,
    '--pretty=format:%H%x00%an%x00%ar%x00%s%x00%ad%x00%ae',
  ]);

  if (!result.success || !result.stdout) {
    return [];
  }

  const commits = [];
  const entries = result.stdout.split('\n').filter(Boolean);
  for (const entry of entries) {
    const [hash, author, relativeTime, message, date, email] = entry.split('\x00');
    commits.push({
      hash,
      shortHash: hash ? hash.slice(0, 7) : '',
      author,
      email,
      relativeTime,
      message,
      date,
    });
  }
  return commits;
}

/**
 * Notify that a file in the vault has been modified/deleted.
 * If autoPushOnChange is enabled, debounces and pushes to Git!
 */
function notifyChange(vaultId) {
  const config = loadConfig(vaultId);
  if (!config.enabled || !config.autoPushOnChange || !config.remoteUrl) {
    return;
  }

  if (debounceTimers.has(vaultId)) {
    clearTimeout(debounceTimers.get(vaultId));
  }

  const delayMs = Math.max(3, config.debounceSeconds || 15) * 1000;
  const timer = setTimeout(async () => {
    debounceTimers.delete(vaultId);
    try {
      console.log(`[GitSync] Debounce triggered auto-push for vault ${vaultId}`);
      await commitAndPush(vaultId);
    } catch (err) {
      console.error(`[GitSync] Auto-push error for vault ${vaultId}:`, err.message);
    }
  }, delayMs);
  if (timer && timer.unref) timer.unref();

  debounceTimers.set(vaultId, timer);
}

let gitSchedulerTimer = null;
const lastAutoSyncMap = new Map();

function startGitSyncScheduler(checkIntervalMs = 60 * 1000) {
  if (gitSchedulerTimer) return gitSchedulerTimer;
  gitSchedulerTimer = setInterval(async () => {
    try {
      const vaultsStore = require('./vaults');
      const allVaults = vaultsStore.getRawVaults ? vaultsStore.getRawVaults() : [];
      const now = Date.now();
      for (const v of allVaults) {
        const cfg = loadConfig(v.id);
        const intervalMin = Number(cfg.autoSyncIntervalMinutes) || 0;
        if (!cfg.enabled || !cfg.remoteUrl || intervalMin <= 0) continue;
        const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
        const lastRun = lastAutoSyncMap.get(v.id) || 0;
        if (now - lastRun >= intervalMs) {
          lastAutoSyncMap.set(v.id, now);
          withVaultLock(v.id, async () => {
            try {
              await pull(v.id);
              await commitAndPush(v.id);
            } catch (err) {
              console.warn(`[GitSync] Scheduled sync error for vault ${v.id}:`, err.message);
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[GitSync] Scheduler error:', err.message);
    }
  }, checkIntervalMs);
  if (gitSchedulerTimer.unref) gitSchedulerTimer.unref();
  return gitSchedulerTimer;
}

module.exports = {
  loadConfig,
  saveConfig,
  isGitRepo,
  recordPulledChanges,
  broadcastPulledChanges,
  initRepo: (vaultId) => withVaultLock(vaultId, () => initRepo(vaultId)),
  getStatus: (vaultId) => withVaultLock(vaultId, () => getStatus(vaultId)),
  testConnection: (vaultId, testParams) => withVaultLock(vaultId, () => testConnection(vaultId, testParams)),
  commitAndPush: (vaultId, opts) => withVaultLock(vaultId, () => commitAndPush(vaultId, opts)),
  pull: (vaultId) => withVaultLock(vaultId, () => pull(vaultId)),
  getLogs,
  notifyChange,
  startGitSyncScheduler,
};
