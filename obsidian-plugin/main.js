const { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, Platform, arrayBufferToBase64, base64ToArrayBuffer } = require('obsidian');
let nodeCrypto = null;
try {
  nodeCrypto = require('crypto');
} catch (_) {}

async function computeSha256(arrayBuffer) {
  if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
    try {
      return nodeCrypto.createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex');
    } catch (_) {}
  }
  const cryptoObj = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : (typeof window !== 'undefined' && window.crypto ? window.crypto : null);
  if (cryptoObj && cryptoObj.subtle) {
    try {
      const hashBuffer = await cryptoObj.subtle.digest('SHA-256', arrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {}
  }
  return null;
}

const DEFAULT_SETTINGS = {
  serverUrl: 'http://192.168.50.154:8787',
  username: '',
  password: '',
  token: '',
  authToken: '',
  vaultId: '',
  vaultName: '',
  deviceId: 'Obsidian Device',
  autoSync: true,
  syncConfigFolder: false,
  syncIntervalSeconds: 30,
  syncBaselines: {},
  syncCursors: {}
};

module.exports = class NimbusSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.loadBaselineCache();

    // Default device ID if empty
    if (!this.settings.deviceId) {
      this.settings.deviceId = 'Obsidian-' + Math.random().toString(36).substring(2, 7);
      await this.saveSettings();
    }

    this.localChangeQueue = new Map();
    this.isApplyingRemoteChange = false;
    this.remoteApplyingCount = 0;
    this.applyingRemotePaths = new Set();
    this.isVaultReady = false;
    this.syncBarrierActive = true; // 🛡️ 启动期下行优先屏障保护 (Pull-First Sync Barrier)
    this.pendingLocalQueueWhileBarrier = new Set();
    // 屏障期/远端应用期间发生的本地重命名：oldPath -> newPath，屏障收尾后补发
    this.pendingLocalRenames = new Map();
    // 🛡️ 游标安全门：广播应用失败时冻结游标推进（防止“失败空洞”被后续广播跳过），
    // 冻结状态下交由下一次 init 的增量重放从本地游标补齐后解除。
    this._cursorGapBlocked = false;
    // 每个 vault 记录本会话内服务端 ack 携带过的最新游标（durable 后才回 ack，可信）
    this._lastServerCursorSeen = {};
    this.fileHashes = new Map();
    // 服务端 syncRules.ignorePatterns 镜像：由 init / rules_updated 下发，参与 isIgnoredLocalPath 判定
    this.remoteIgnorePatterns = [];
    // 按路径串行化「远端写盘」与「本地推送」，避免同一文件的读写竞态
    this.fileLocks = new Map();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this._saveSettingsTimer = null;
    this._saveBaselineTimer = null;

    // Load initial file hashes from baseline if present
    const initialBaseline = this.getVaultBaseline();
    for (const [path, meta] of Object.entries(initialBaseline)) {
      if (meta && meta.hash) {
        this.fileHashes.set(path, meta.hash);
      }
    }

    // Ribbon icon for quick sync / full sync
    this.addRibbonIcon('refresh-cw', 'Nimbus: 一键全量同步', async () => {
      await this.fullSyncAllFiles();
    });

    // Command palette commands
    this.addCommand({
      id: 'nimbus-full-sync',
      name: '立即执行全量双向同步 (Full Sync Now)',
      callback: async () => {
        await this.fullSyncAllFiles();
      }
    });
    this.addCommand({
      id: 'nimbus-force-push',
      name: '强制推送所有本地笔记到云端 (Force Push to Cloud)',
      callback: async () => {
        await this.forcePushAllLocalFiles();
      }
    });
    this.addCommand({
      id: 'nimbus-reconcile-offline',
      name: '补同步离线期间的本地变更 (Reconcile Offline Changes)',
      callback: async () => {
        await this.reconcileLocalOfflineChanges();
      }
    });

    // Status bar indicator
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar('idle', '☁️ Nimbus: 就绪');

    // Setting Tab
    this.addSettingTab(new NimbusSettingTab(this.app, this));

    // 🔗 注册 Obsidian 原生 URI 协议处理器: obsidian://nimbus-sync?...
    this.registerObsidianProtocolHandler('nimbus-sync', async (params) => {
      try {
        const server = params.server || params.serverUrl;
        const token = params.token || params.authToken;
        const vaultId = params.vaultId;
        const vaultName = params.vaultName || '';
        const device = params.device || params.deviceId;
        const autoSync = params.autoSync === '1' || params.autoSync === 'true';

        if (!server || !token) {
          new Notice('❌ Nimbus DeepLink 缺少必要的服务器地址或 Token 授权参数');
          return;
        }

        this.settings.serverUrl = server.replace(/\/+$/, '');
        this.settings.token = token.trim().replace(/^Bearer\s+/i, '');
        this.settings.authToken = this.settings.token;
        this.settings.authMode = 'token';
        if (vaultId) this.settings.vaultId = vaultId;
        if (vaultName) this.settings.vaultName = vaultName;
        if (device) this.settings.deviceId = device;
        if (params.autoSync !== undefined) this.settings.autoSync = autoSync;

        await this.saveSettings();
        new Notice(`✅ 已成功通过 DeepLink 导入 Nimbus 同步配置！\n目标库: ${vaultName || vaultId || '默认库'}`);

        this.disconnectWebSocket();
        if (this.settings.vaultId) {
          this.connectWebSocket();
        } else {
          await this.autoMatchOrCreateVault();
          if (this.settings.vaultId) this.connectWebSocket();
        }
      } catch (err) {
        new Notice('❌ 解析 Nimbus DeepLink 参数失败: ' + err.message);
      }
    });

    // Vault Event Listeners (protected by isVaultReady)
    this.registerEvent(this.app.vault.on('modify', (file) => this.onLocalFileChange('modify', file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onLocalFileChange('create', file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onLocalFileDelete(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onLocalFileRename(file, oldPath)));

    // 🛡️ 等待 Obsidian 工作区与本地文件系统完全索引就绪 (尤其防止移动端冷启动文件列表为空)
    this.app.workspace.onLayoutReady(async () => {
      await this.ensureVaultReady();
      this.isVaultReady = true;

      // Auto connect or auto-bind on startup
      if (this.settings.autoSync && this.settings.token) {
        if (this.settings.vaultId) {
          this.connectWebSocket();
        } else {
          this.autoMatchOrCreateVault().then(() => {
            if (this.settings.vaultId) this.connectWebSocket();
          });
        }
      }
    });
  }

  async ensureVaultReady() {
    // 移动端沙盒文件扫描速度较慢，给足稳定探测时间
    const isMobile = Platform ? Platform.isMobile : false;
    const maxWaitTime = isMobile ? 3500 : 800;
    const startTime = Date.now();
    let lastCount = this.app.vault.getFiles().length;

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((r) => setTimeout(r, isMobile ? 400 : 150));
      const currentCount = this.app.vault.getFiles().length;
      if (currentCount > 0 && currentCount === lastCount) {
        // 文件数量稳定且大于 0，说明扫描完成
        break;
      }
      lastCount = currentCount;
    }
  }

  onunload() {
    this.disconnectWebSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.localChangeQueue) {
      for (const timer of this.localChangeQueue.values()) {
        clearTimeout(timer);
      }
      this.localChangeQueue.clear();
    }
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // 智能双向对齐 token 与 authToken 引用
    if (!this.settings.token && this.settings.authToken) {
      this.settings.token = this.settings.authToken;
    }
    if (!this.settings.authToken && this.settings.token) {
      this.settings.authToken = this.settings.token;
    }

    // 容错：如果粘贴配置中携带 wsUrl 且包含 token 参数，提取作为令牌兜底
    if (!this.settings.token && this.settings.wsUrl) {
      try {
        const dummyUrl = new URL(this.settings.wsUrl.replace(/^wss?:\/\//i, 'http://'));
        const extracted = dummyUrl.searchParams.get('token') || dummyUrl.searchParams.get('authToken');
        if (extracted) {
          this.settings.token = extracted;
          this.settings.authToken = extracted;
        }
      } catch {}
    }
  }

  async saveSettings() {
    if (this.settings.token && !this.settings.authToken) {
      this.settings.authToken = this.settings.token;
    } else if (this.settings.authToken && !this.settings.token) {
      this.settings.token = this.settings.authToken;
    }
    await this.saveData(this.settings);
  }

  scheduleSaveSettings() {
    // 🛡️ 防抖但给硬截止：400ms 防抖在高频变更风暴下会无限后移，强杀进程时整个窗口全部丢失。
    // 首次调用起 5 秒内必须落盘一次。
    if (!this._saveSettingsDeadline) {
      this._saveSettingsDeadline = Date.now() + 5000;
    }
    if (this._saveSettingsTimer) {
      clearTimeout(this._saveSettingsTimer);
    }
    const wait = Math.max(50, Math.min(400, this._saveSettingsDeadline - Date.now()));
    this._saveSettingsTimer = setTimeout(async () => {
      this._saveSettingsTimer = null;
      this._saveSettingsDeadline = null;
      try {
        await this.saveSettings();
      } catch (e) {
        console.error('[Nimbus] 保存设置失败:', e);
      }
    }, wait);
  }

  async loadBaselineCache() {
    this.baselinesCache = {};
    const configDir = (this.app.vault && this.app.vault.configDir) || '.obsidian';
    const baselineFilePath = `${configDir}/plugins/nimbus-sync/baseline.cache.json`;
    try {
      if (this.app.vault && this.app.vault.adapter && await this.app.vault.adapter.exists(baselineFilePath)) {
        const raw = await this.app.vault.adapter.read(baselineFilePath);
        this.baselinesCache = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[Nimbus] 读取独立基线缓存异常:', e);
    }

    // 兼容迁移：如果以前保存在 settings.syncBaselines 中，自动迁出到独立基线文件
    if (this.settings.syncBaselines && typeof this.settings.syncBaselines === 'object' && Object.keys(this.settings.syncBaselines).length > 0) {
      for (const [vId, bMap] of Object.entries(this.settings.syncBaselines)) {
        if (!this.baselinesCache[vId] || Object.keys(this.baselinesCache[vId]).length === 0) {
          this.baselinesCache[vId] = bMap;
        }
      }
      delete this.settings.syncBaselines;
      await this.saveSettings();
      await this.saveBaselineCache();
    }
  }

  async saveBaselineCache() {
    const configDir = (this.app.vault && this.app.vault.configDir) || '.obsidian';
    const baselineFilePath = `${configDir}/plugins/nimbus-sync/baseline.cache.json`;
    try {
      if (this.app.vault && this.app.vault.adapter) {
        const json = JSON.stringify(this.baselinesCache || {});
        await this.app.vault.adapter.write(baselineFilePath, json);
      }
    } catch (e) {
      console.warn('[Nimbus] 写入独立基线缓存异常:', e);
    }
  }

  scheduleSaveBaselineCache() {
    // 🛡️ 与 scheduleSaveSettings 相同：5 秒硬截止防无限后移
    if (!this._saveBaselineDeadline) {
      this._saveBaselineDeadline = Date.now() + 5000;
    }
    if (this._saveBaselineTimer) {
      clearTimeout(this._saveBaselineTimer);
    }
    const wait = Math.max(50, Math.min(400, this._saveBaselineDeadline - Date.now()));
    this._saveBaselineTimer = setTimeout(async () => {
      this._saveBaselineTimer = null;
      this._saveBaselineDeadline = null;
      try {
        await this.saveBaselineCache();
      } catch (e) {
        console.error('[Nimbus] 保存基线缓存失败:', e);
      }
    }, wait);
  }

  getVaultBaseline(vaultId = this.settings.vaultId) {
    if (!vaultId) return {};
    if (!this.baselinesCache) {
      this.baselinesCache = {};
    }
    return this.baselinesCache[vaultId] || {};
  }

  getBaselineEntry(vaultId = this.settings.vaultId, filePath) {
    if (!vaultId || !filePath) return null;
    const baseline = this.getVaultBaseline(vaultId);
    return baseline ? baseline[filePath] || null : null;
  }

  updateBaselineEntry(vaultId, filePath, meta) {
    if (!vaultId || !filePath) return;
    if (!this.baselinesCache) {
      this.baselinesCache = {};
    }
    if (!this.baselinesCache[vaultId]) {
      this.baselinesCache[vaultId] = {};
    }
    if (meta === null || meta === undefined) {
      delete this.baselinesCache[vaultId][filePath];
    } else {
      // 🛡️ ignored 标记必须持久化（W-9）：3-Way 的「黑名单文件不参与删除判定、
      // 无需比对」语义（场景 2 分支）依赖 baseMeta.ignored；旧实现把条目归一化成
      // {hash,mtime,size} 时把标记静默裁剪，语义从未真正落过盘。
      this.baselinesCache[vaultId][filePath] = {
        hash: meta.hash,
        mtime: meta.mtime || Date.now(),
        size: meta.size || 0,
        ...(meta.ignored ? { ignored: true } : {})
      };
    }
    this.scheduleSaveBaselineCache();
  }

  getVaultCursor(vaultId = this.settings.vaultId) {
    if (!vaultId) return 0;
    if (!this.settings.syncCursors) this.settings.syncCursors = {};
    return this.settings.syncCursors[vaultId] || 0;
  }

  setVaultCursor(vaultId, cursor) {
    if (!vaultId || typeof cursor !== 'number') return;
    if (!this.settings.syncCursors) this.settings.syncCursors = {};
    this.settings.syncCursors[vaultId] = cursor;
    this.scheduleSaveSettings();
  }

  /**
   * 🛡️ 广播/拉取成功后的游标推进：必须同时满足
   *  1) 没有失败空洞（之前某条广播曾应用失败——直接推进到“最新”会永久跳过那条变更，
   *     下一次 init 因游标已对齐不会再增量重放，缺口只能等手动全量对账）；
   *  2) 确实大于本地游标。
   * 失败时置 _cursorGapBlocked 冻结后续推进，直到 init 增量重放（从本地游标起）补齐空洞后解除。
   */
  _advanceCursorIfSafe(vaultId, cursor) {
    if (typeof cursor !== 'number') return;
    if (this._cursorGapBlocked) return;
    if (cursor > this.getVaultCursor(vaultId)) {
      this.setVaultCursor(vaultId, cursor);
    }
  }

  _blockCursorOnFailure() {
    if (!this._cursorGapBlocked) {
      this._cursorGapBlocked = true;
      console.warn('[Nimbus] 广播/拉取应用存在失败项，冻结游标推进，待下次连接增量重放补齐缺口');
    }
  }

  /** 记录服务端可信游标（ack 只在变更记录持久化完成后返回） */
  _noteServerCursor(msg) {
    const cursor = msg && typeof msg.cursor === 'number' ? msg.cursor : null;
    if (cursor === null) return;
    const vaultId = this.settings.vaultId || 'default';
    if (!this._lastServerCursorSeen) this._lastServerCursorSeen = {};
    this._lastServerCursorSeen[vaultId] = Math.max(this._lastServerCursorSeen[vaultId] || 0, cursor);
  }

  /**
   * 对齐服务端自定义忽略规则 (syncRules.ignorePatterns)。
   * 由 WS init / get_manifest / rules_updated 下发；命中规则的文件在本地保留但不参与同步。
   */
  setRemoteIgnorePatterns(patterns) {
    if (!Array.isArray(patterns)) return;
    const next = patterns
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
    const changed = next.length !== this.remoteIgnorePatterns.length
      || next.some((p, i) => p !== this.remoteIgnorePatterns[i]);
    this.remoteIgnorePatterns = next;
    if (changed) {
      console.log(`[Nimbus] 已同步云端忽略规则 ${next.length} 条:`, next);
    }
  }

  /** 单条 glob 规则匹配（支持 **、*、?、./ 前缀、*.ext 快捷写法） */
  matchIgnorePattern(relPath, pattern) {
    const normPath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const normPat = String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normPat) return false;
    if (normPath === normPat) return true;
    if (!normPat.includes('/') && normPat.startsWith('*.')) {
      const ext = normPat.slice(1);
      if (normPath.toLowerCase().endsWith(ext.toLowerCase())) return true;
    }
    let p = normPat;
    let prefix = '^';
    if (p.startsWith('**/')) {
      prefix = '^(?:.*/)?';
      p = p.slice(3);
    }
    // 先用占位符保护 globstar，再展开 * 与 ?：
    // 否则展开出的 (?:.*/)? 里的 ? 会被后续 replace 再改写成通配符，导致 a/**/b 类规则永远无法匹配。
    // 🛡️ 项 4：移除 (?<!\.) lookbehind——占位符已保证裸 * 才走到这一步，转义点号后面的
    // 裸 *（notes.* 这种写法）同样要按 [^/]* 展开；旧 lookbehind 把它留成量词，
    // 规则被退化成 ^notes\.*$（只匹配 "notes" 加任意个点，匹配不到 notes.md）。
    // ? → [^/] 保持不跨路径分隔符的语义（与服务端新管线一致）。
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
      return new RegExp(regexStr, 'i').test(normPath);
    } catch {
      return normPath.toLowerCase().includes(normPat.toLowerCase());
    }
  }

  /** 判断某路径（或文件夹下任意路径）是否正处于「远端写入落盘」过程中 */
  isPathApplyingRemote(filePath, isFolder = false) {
    if (!filePath || !this.applyingRemotePaths || this.applyingRemotePaths.size === 0) return false;
    const clean = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.applyingRemotePaths.has(clean)) return true;
    if (isFolder) {
      const prefix = clean ? `${clean}/` : '';
      for (const p of this.applyingRemotePaths) {
        if (p.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  /**
   * 获取某路径的本地排他锁，返回释放函数（同一路径的远端写盘与本地推送串行执行）。
   * 注意：不可在同一路径上嵌套获取，否则会自锁。
   */
  async acquireLocalFileLock(filePath) {
    const clean = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return () => {};
    if (!this.fileLocks) this.fileLocks = new Map();
    const prev = this.fileLocks.get(clean) || Promise.resolve();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const chain = prev.then(() => gate, () => gate);
    this.fileLocks.set(clean, chain);
    try {
      await prev;
    } catch {}
    return () => {
      release();
      if (this.fileLocks.get(clean) === chain) {
        this.fileLocks.delete(clean);
      }
    };
  }

  async withLocalFileLock(filePath, fn) {
    const release = await this.acquireLocalFileLock(filePath);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isIgnoredLocalPath(filePath) {
    if (!filePath) return true;
    const clean = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');

    // 插件凭据文件（无论所在配置目录叫什么）永远不同步
    const configDir = ((this.app.vault && this.app.vault.configDir) || '.obsidian').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (`${configDir}/plugins/nimbus-sync/data.json`.toLowerCase() === clean.toLowerCase()) return true;

    // 无论是否开启配置目录同步，机台强绑定的本地 UI / 工作区状态 / 本插件运行态永远绝对忽略
    const alwaysIgnoredPatterns = [
      /^\.git(\/|$)/,
      /^\.obsidian\/workspace.*\.json$/,
      /^\.obsidian\/app\.json$/,
      /^\.obsidian\/appearance\.json$/,
      /^\.obsidian\/cache(\/|$)/,
      /^\.obsidian\/icons(\/|$)/,
      /^\.obsidian\/plugins\/nimbus-sync(\/|$)/,
      /^\.trash(\/|$)/,
      /\.DS_Store$/,
      /Thumbs\.db$/,
      /desktop\.ini$/,
      /\.tmp$/,
      /\.swp$/
    ];
    if (alwaysIgnoredPatterns.some((rx) => rx.test(clean))) {
      return true;
    }

    // 如果未开启配置目录同步，忽略所有其余 .obsidian/ 下的文件
    if (!this.settings.syncConfigFolder && (clean.startsWith('.obsidian/') || clean === '.obsidian')) {
      return true;
    }

    // 对齐服务端自定义忽略规则 (syncRules.ignorePatterns)：本地保留但不同步
    if (Array.isArray(this.remoteIgnorePatterns) && this.remoteIgnorePatterns.length > 0) {
      for (const pat of this.remoteIgnorePatterns) {
        if (this.matchIgnorePattern(clean, pat)) return true;
      }
    }

    return false;
  }

  isCriticalSyncFile(filePath) {
    if (!filePath) return false;
    const clean = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
    // 隐藏目录（如 .obsidian/）或隐藏文件视为辅助系统配置，非核心笔记资产
    if (clean.startsWith('.') || clean.includes('/.')) return false;
    return true;
  }

  updateStatusBar(status, customText) {
    if (!this.statusBarItem) return;
    switch (status) {
      case 'syncing':
        this.statusBarItem.setText('☁️ Nimbus: 正在同步...');
        break;
      case 'connected':
        this.statusBarItem.setText('☁️ Nimbus: 实时连接中');
        break;
      case 'error':
        this.statusBarItem.setText('☁️ Nimbus: 同步中断');
        break;
      case 'idle':
      default:
        this.statusBarItem.setText(customText || '☁️ Nimbus: 就绪');
        break;
    }
  }

  getCleanServerUrl() {
    return (this.settings.serverUrl || '').trim().replace(/\/+$/, '');
  }

  getCleanToken() {
    const raw = (this.settings.token || this.settings.authToken || '').trim();
    // 过滤掉 Bearer 前缀并彻底清理非可打印 ASCII 字符，杜绝 fetch Headers 报 non ISO-8859-1 code point 致命异常
    return raw.replace(/^Bearer\s+/i, '').replace(/[^\x20-\x7E]/g, '').trim();
  }

  buildAuthHeaders(extra = {}) {
    const cleanToken = this.getCleanToken();
    const headers = {
      'Authorization': `Bearer ${cleanToken}`,
    };
    if (this.settings.deviceId) {
      // 对设备名进行 URI 编码，彻底防御 Windows PC (默认设备) 等中文设备名称击穿 fetch 请求头校验
      headers['x-device-id'] = encodeURIComponent(String(this.settings.deviceId));
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) {
        const str = String(v);
        headers[k] = /[\u0080-\uffff]/.test(str) ? encodeURIComponent(str) : str;
      }
    }
    return headers;
  }

  // --- API Authentication & Vaults ---
  async autoMatchOrCreateVault() {
    if (!this.settings.token) return null;
    const localVaultName = this.app.vault.getName() || 'DefaultVault';
    const vaults = await this.fetchVaults();

    // 1. Check if server already has a vault matching current local vault name
    let targetVault = vaults.find(v => v.name.toLowerCase() === localVaultName.toLowerCase());

    // 2. If not matched, check if current settings vault exists
    if (!targetVault && this.settings.vaultId) {
      targetVault = vaults.find(v => v.id === this.settings.vaultId);
    }

    // 3. If still no vault or server has 0 vaults, auto-create one matching local vault name!
    if (!targetVault) {
      if (vaults.length === 0) {
        new Notice(`☁️ 服务端暂无 Vault，正在自动为您创建并绑定「${localVaultName}」...`);
        targetVault = await this.createVault(localVaultName);
      } else {
        // Use first vault or auto-create local vault
        targetVault = vaults[0];
      }
    }

    if (targetVault) {
      this.settings.vaultId = targetVault.id;
      this.settings.vaultName = targetVault.name;
      await this.saveSettings();
      new Notice(`🎯 已自动加载并绑定知识库:「${targetVault.name}」`);
    }

    return targetVault;
  }

  async login() {
    const baseUrl = this.getCleanServerUrl();
    if (!baseUrl) {
      new Notice('❌ 请先填写服务器地址');
      return false;
    }

    try {
      const resp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.settings.username,
          password: this.settings.password
        })
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      this.settings.token = data.token;
      this.settings.authToken = data.token;
      await this.saveSettings();

      new Notice('✅ 成功登录到 Nimbus 服务器！');

      // Automatically detect, match or create vault for the current local vault!
      await this.autoMatchOrCreateVault();

      if (this.settings.vaultId && this.settings.autoSync) {
        this.connectWebSocket();
      }

      return true;
    } catch (e) {
      new Notice(`❌ 登录失败: ${e.message}`);
      return false;
    }
  }

  async fetchVaults() {
    const baseUrl = this.getCleanServerUrl();
    const token = this.getCleanToken();
    if (!token) return [];

    try {
      const resp = await fetch(`${baseUrl}/api/vaults`, {
        headers: this.buildAuthHeaders()
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      this.availableVaults = data.vaults || [];
      
      // Auto select first vault if none selected
      if (this.availableVaults.length > 0 && (!this.settings.vaultId || !this.availableVaults.some(v => v.id === this.settings.vaultId))) {
        this.settings.vaultId = this.availableVaults[0].id;
        this.settings.vaultName = this.availableVaults[0].name;
        await this.saveSettings();
      }
      return this.availableVaults;
    } catch (err) {
      console.error('[Nimbus] 获取 Vault 列表失败:', err);
      return [];
    }
  }

  async createVault(name) {
    const baseUrl = this.getCleanServerUrl();
    const token = this.getCleanToken();
    if (!token) return null;

    try {
      const resp = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: this.buildAuthHeaders({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ name })
      });
      if (!resp.ok) throw new Error('创建失败');
      const data = await resp.json();
      await this.fetchVaults();
      return data.vault;
    } catch (err) {
      new Notice(`❌ 创建 Vault 失败: ${err.message}`);
      return null;
    }
  }

  // --- WebSocket Connection ---
  connectWebSocket() {
    this.disconnectWebSocket();

    // 🛡️ 启动连接时激活下行优先屏障，直到服务端握手与初次对齐完成
    this.syncBarrierActive = true;

    const cleanToken = this.getCleanToken();
    if (!cleanToken || !this.settings.vaultId) {
      this.updateStatusBar('idle', '☁️ Nimbus: 未配置');
      return;
    }

    const baseUrl = this.getCleanServerUrl();
    const wsProto = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
    const host = baseUrl.replace(/^https?:\/\//i, '');
    const localCursor = this.getVaultCursor(this.settings.vaultId || 'default');
    const wsUrl = `${wsProto}//${host}/ws?token=${encodeURIComponent(cleanToken)}&vaultId=${encodeURIComponent(this.settings.vaultId)}&deviceId=${encodeURIComponent(this.settings.deviceId || 'Obsidian Device')}&cursor=${encodeURIComponent(localCursor)}`;

    // 🛡️ 多库切换卫生：目标库变化时清空上一库的内存状态（回声哈希、防抖队列、挂起队列），
    // 并用新库基线重播 fileHashes。否则旧库哈希会参与新库的回声抑制，造成漏拉/漏推。
    if (this._connectedVaultId && this._connectedVaultId !== this.settings.vaultId) {
      if (this.localChangeQueue) {
        for (const timer of this.localChangeQueue.values()) clearTimeout(timer);
        this.localChangeQueue.clear();
      }
      this.fileHashes = new Map();
      if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.clear();
      if (this.pendingLocalDeletes) this.pendingLocalDeletes.clear();
      if (this.pendingLocalRenames) this.pendingLocalRenames.clear();
      this._cursorGapBlocked = false;
      this._lastServerCursorSeen = {};
      const nextBaseline = this.getVaultBaseline(this.settings.vaultId);
      for (const [path, meta] of Object.entries(nextBaseline)) {
        if (meta && meta.hash) this.fileHashes.set(path, meta.hash);
      }
      console.log(`[Nimbus] 切换笔记库: ${this._connectedVaultId} -> ${this.settings.vaultId}（已重置内存同步状态）`);
    }
    this._connectedVaultId = this.settings.vaultId;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        this.updateStatusBar('connected');
        new Notice('☁️ Nimbus 实时双向同步已连接');

        // Start ping heartbeat
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      socket.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          await this.handleServerMessage(msg);
        } catch (err) {
          console.error('[Nimbus] 解析服务器消息异常:', err);
        }
      };

      socket.onclose = (e) => {
        // 🛡️ 只有"当前这一条连接"被意外关闭时才安排重连。
        // 若 close 由 connectWebSocket() 换线/主动断开触发（this.ws 已被替换或置空），
        // 这里直接忽略——否则旧连接会每 5 秒催生一条新连接，形成永不停止的重连震荡。
        if (this.ws !== socket) return;
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (e && (e.code === 4001 || e.code === 4003)) {
          this.updateStatusBar('error', '☁️ Nimbus: 令牌已失效');
          return;
        }
        this.updateStatusBar('idle', '☁️ Nimbus: 连接已断开');
        // Auto reconnect
        if (this.settings.autoSync) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
        }
      };

      socket.onerror = (err) => {
        console.error('[Nimbus] WebSocket 错误:', err);
        this.updateStatusBar('error');
      };
    } catch (err) {
      console.error('[Nimbus] 连接初始化失败:', err);
      this.updateStatusBar('error');
    }
  }

  disconnectWebSocket() {
    this.syncBarrierActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // --- Server Message Handling ---
  async handleServerMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'init': {
        // 云端忽略规则必须在任何同步判定（syncManifest / 增量 / flush）之前就位
        this.setRemoteIgnorePatterns(msg.ignorePatterns);
        // init 意味着即将从本地游标做一次完整增量重放：先解除上一轮广播失败留下的冻结
        this._cursorGapBlocked = false;
        const serverCursor = typeof msg.cursor === 'number' ? msg.cursor : 0;
        const vaultId = this.settings.vaultId || 'default';
        const localCursor = this.getVaultCursor(vaultId);

        // 如果本地已存在有效游标且服务端游标大于本地游标，优先执行秒级增量追更 (Delta Sync)
        if (localCursor >= 0 && serverCursor > localCursor) {
          const deltaOk = await this.syncDeltaChanges(localCursor);
          if (deltaOk) {
            await this.flushPendingLocalChangesAfterBarrier();
            await this.scanOfflineDiskDiffAfterDelta();
            break;
          }
          console.warn('[Nimbus] 增量追更未能完成全部项，自动降级为全量 3-Way 双向清单比对兜底');
        } else if (localCursor > 0 && serverCursor === localCursor) {
          // 游标完全吻合，秒级对齐完成
          await this.flushPendingLocalChangesAfterBarrier();
          await this.scanOfflineDiskDiffAfterDelta();
          new Notice('✅ 本地已与 Nimbus 云端完全对齐');
          break;
        }

        // 首次同步、游标断层或增量未完全对齐时，执行 3-Way 双向对比兜底
        let manifest = msg.manifest;
        if (!manifest || Object.keys(manifest).length === 0) {
          const fetched = await this.fetchManifestHttp(vaultId);
          if (fetched === null) {
            // 🛡️ 拉取失败 ≠ 云端空库！绝不能用空清单执行 3-Way（否则场景 2 会把本地笔记当作“云端已删”批量删除）
            // 保持屏障与待推队列原样，等下次连接成功后自然重试
            console.error('[Nimbus] 云端全量清单拉取失败，已跳过本轮 3-Way 同步以防误删本地笔记');
            new Notice('⚠️ 云端清单获取失败，本轮同步已安全跳过，将在网络恢复后自动重试');
            break;
          }
          manifest = fetched;
        }
        // 🛡️ 若屏障期有挂起的本地重命名，先向云端执行 rename 并同步修正内存 manifest，
        // 避免 syncManifest 把重命名拆解成 DELETE 旧路径 + PUT 新路径而丢失历史版本关联
        if (this.pendingLocalRenames && this.pendingLocalRenames.size > 0) {
          const renamePairs = Array.from(this.pendingLocalRenames.entries());
          await this.flushPendingLocalRenames();
          if (manifest && typeof manifest === 'object') {
            manifest = { ...manifest };
            for (const [oldP, newP] of renamePairs) {
              const target = this.app.vault.getAbstractFileByPath(newP);
              const oldStill = this.app.vault.getAbstractFileByPath(oldP);
              if ((target instanceof TFile) && !(oldStill instanceof TFile) && manifest[oldP] && !manifest[newP]) {
                manifest[newP] = manifest[oldP];
                delete manifest[oldP];
              }
            }
          }
        }
        await this.syncManifest(manifest, serverCursor);
        await this.flushPendingLocalChangesAfterBarrier();
        break;
      }

      case 'change':
        // A file was created/updated remotely
        // 🛡️ 游标在应用成功后才推进（见下方 changeApplied 分支）；
        // 绝不能在 apply 失败前就消费掉 msg.cursor，否则增量通道不再重放，文件将被永久漏拉。
        if (!msg.path) break;
        if (this.isIgnoredLocalPath(msg.path)) {
          return;
        }
        if (msg.hash && this.fileHashes.get(msg.path) === msg.hash) {
          // 本地已是目标相同哈希版本（如本设备自产生上传或已同步），无需重复拉取，拦截自反回声
          this._advanceCursorIfSafe(this.settings.vaultId || 'default', msg.cursor);
          return;
        }
        let changeApplied = false;
        if (msg.pullRequired || !msg.content) {
          changeApplied = await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        } else {
          changeApplied = await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        }
        if (changeApplied) {
          this._advanceCursorIfSafe(this.settings.vaultId || 'default', msg.cursor);
        } else {
          // 🛡️ 失败空洞：本条变更未落地。置冻结门，让后续广播不可直接把游标推到“最新”，
          // 否则两次 init 之间将形成游标对齐假象、这条缺口永不再被增量重放。
          this._blockCursorOnFailure();
        }
        break;

      case 'batch_file_change':
      case 'batch_change':
        // Handle coalesced or server batch change notifications
        if (msg.pullRequired) {
          await this.fullSyncAllFiles();
        } else if (Array.isArray(msg.changes)) {
          let allApplied = true;
          // 🛡️ 项 3：游标推进基准 = 本批最后一条实际处理的条目自身的游标（服务端
          // batch 广播每条已带 cursor，且有序交付内单调递增）；旧服务端不带
          // per-item cursor 时回退 msg.cursor（兼容位）。绝不越过未收到的变更。
          let lastAppliedCursor = null;
          for (const item of msg.changes) {
            if (!item || !item.path) continue;
            if (item.action === 'delete') {
              allApplied = (await this.applyRemoteDelete(item.path, true)) && allApplied;
            } else {
              const localHash = this.fileHashes.get(item.path);
              if (item.hash && localHash === item.hash) {
                if (typeof item.cursor === 'number') lastAppliedCursor = item.cursor;
                continue;
              }
              allApplied = (await this.pullRemoteFileViaHttp(item.path, item.mtime, item.hash)) && allApplied;
            }
            if (typeof item.cursor === 'number') lastAppliedCursor = item.cursor;
          }
          const advanceTo = lastAppliedCursor !== null
            ? lastAppliedCursor
            : (typeof msg.cursor === 'number' ? msg.cursor : null);
          if (allApplied && advanceTo !== null) {
            this._advanceCursorIfSafe(this.settings.vaultId || 'default', advanceTo);
          } else {
            this._blockCursorOnFailure();
          }
        }
        break;

      case 'pull_stream': {
        // Server directed large file pull via streaming HTTP
        const streamApplied = await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        if (streamApplied !== false) {
          this._advanceCursorIfSafe(this.settings.vaultId || 'default', msg.cursor);
        } else {
          this._blockCursorOnFailure();
        }
        break;
      }

      case 'deleted': {
        // A file was deleted remotely
        const deleteApplied = await this.applyRemoteDelete(msg.path, true);
        if (deleteApplied !== false) {
          this._advanceCursorIfSafe(this.settings.vaultId || 'default', msg.cursor);
        } else {
          this._blockCursorOnFailure();
        }
        break;
      }

      case 'conflict':
        // 🛡️ E-4：serverWin 分支没有 conflictPath，文案按响应类型区分，
        // 旧实现无论哪种都提示「副本: ${msg.conflictPath}」→ serverWin 下用户看到 undefined
        new Notice(msg.serverWin
          ? '⚠️ 并发冲突（云端优先策略）：本地修改已自动备份，正在拉取云端胜出版本'
          : `⚠️ 检测到并发冲突！已自动创建云端分支副本: ${msg.conflictPath}`);
        // 1. 自动拉取云端新创建的分支副本保存至本地（本端离线编辑的内容终于有了可靠落点）
        if (msg.conflictPath) {
          this.sendWsMessage({ type: 'pull', path: msg.conflictPath });
        }
        // 2. 自动拉取云端主文件当前胜出版本同步至本地
        if (msg.path) {
          // 🛡️ 冲突自恢复流：仅当云端已创建分支副本 (msg.conflictPath && !msg.serverWin) 时，
          // 本地内容才已经原样存在于上面的分支副本中，主路径的覆盖拉取不应再生成另一个本地副本；
          // 若是 serverWin（无云端分支副本），绝不能加入 _conflictRestorePaths，必须由 R-1 本地备份兜底！
          if (msg.conflictPath && !msg.serverWin) {
            if (!this._conflictRestorePaths) this._conflictRestorePaths = new Set();
            this._conflictRestorePaths.add(msg.path);
          }
          this.sendWsMessage({ type: 'pull', path: msg.path });
        }
        break;

      case 'permission_updated':
        new Notice(`ℹ️ ${msg.message || '您的笔记库权限已更新'}`);
        break;

      case 'rules_updated':
        // 服务端 syncRules.ignorePatterns 变更实时下发：立即生效，无需重连
        this.setRemoteIgnorePatterns(msg.ignorePatterns);
        new Notice(`ℹ️ 云端同步忽略规则已更新（${this.remoteIgnorePatterns.length} 条），已即时生效`);
        break;

      case 'rename_fallback': {
        // 服务端没有旧路径（本地刚创建即被重命名/移动）：立即结束等待，回退为 delete + push
        const waitingRename = this.pendingSyncAcks && this.pendingSyncAcks.get(`rename:${msg.path}`);
        if (waitingRename) waitingRename.resolve(false);
        break;
      }

      case 'file': {
        // Response to pull
        const fileApplied = await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        if (fileApplied !== false) {
          this._advanceCursorIfSafe(this.settings.vaultId || 'default', msg.cursor);
        } else {
          this._blockCursorOnFailure();
        }
        break;
      }

      case 'ack':
        // 🛡️ 记账可信游标：ack 只在变更记录持久化完成后返回，其 cursor 可参与
        // 3-Way 收尾时的游标基线（否则自推产生的变更会让下次 init 多跑一轮重放）
        this._noteServerCursor(msg);
        if (msg.path && this.pendingSyncAcks) {
          const ok = msg.action === 'delete'
            ? msg.deleted !== false
            : (msg.ignored || msg.conflict ? true : !!msg.hash); // ignored 是服务端黑名单的终态确认，不算失败；conflict 同为终态（副本已落云端）
          this.pendingSyncAcks.get(`${msg.action || 'push'}:${msg.path}`)?.resolve(ok, msg);
        }
        if (msg.hash && msg.action !== 'delete' && !msg.conflict) {
          const isDeletedOrMoved = (this.pendingLocalDeletes && this.pendingLocalDeletes.has(msg.path))
            || (this.pendingLocalRenames && this.pendingLocalRenames.has(msg.path))
            || (msg.action !== 'rename' && this._deletedOrMovedPaths && this._deletedOrMovedPaths.has(msg.path));
          if (!isDeletedOrMoved) {
            this.fileHashes.set(msg.path, msg.hash);
            this.updateBaselineEntry(this.settings.vaultId, msg.path, {
              hash: msg.hash,
              mtime: msg.mtime || Date.now()
            });
          }
        }
        break;

      case 'pong':
        break;

      case 'auth_revoked':
        new Notice(`❌ 令牌凭据已撤销: ${msg.message || '请重新配置设备令牌'}`);
        this.updateStatusBar('error', '☁️ Nimbus: 令牌已撤销');
        this.disconnectWebSocket();
        break;

      case 'error':
        if (msg.path) {
          if (this._conflictRestorePaths) {
            this._conflictRestorePaths.delete(msg.path);
          }
          if (this.pendingSyncAcks) {
            this.pendingSyncAcks.get(`push:${msg.path}`)?.resolve(false);
            this.pendingSyncAcks.get(`delete:${msg.path}`)?.resolve(false);
            this.pendingSyncAcks.get(`rename:${msg.path}`)?.resolve(false);
          }
        }
        console.warn('[Nimbus] 服务器返回错误:', msg.message);
        break;
    }
  }

  async syncDeltaChanges(sinceCursor) {
    try {
      const baseUrl = this.getCleanServerUrl();
      const vaultId = this.settings.vaultId;
      const cleanToken = this.getCleanToken();
      if (!baseUrl || !vaultId || !cleanToken) return false;

      const url = `${baseUrl}/api/vaults/${encodeURIComponent(vaultId)}/changes?since=${sinceCursor}&limit=500&compact=true`;
      const res = await fetch(url, {
        headers: this.buildAuthHeaders()
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.full || data.fullSyncRequired) {
        console.warn('[Nimbus] 服务端要求全量快照同步, 原因:', data.reason);
        let fullManifest = data.manifest;
        if (!fullManifest || Object.keys(fullManifest).length === 0) {
          // 同样不可把“清单缺失/失败”折叠成空清单：先尝试 HTTP 重新拉取
          const fetched = await this.fetchManifestHttp(vaultId);
          if (fetched === null) {
            console.error('[Nimbus] 全量快照清单拉取失败，本轮同步已中止，绝不以空清单执行 3-Way');
            return false;
          }
          fullManifest = fetched;
        }
        await this.syncManifest(fullManifest, data.cursor || 0);
        return true;
      }

      const updates = Array.isArray(data.updates) ? data.updates : [];
      const deletes = Array.isArray(data.deletes) ? data.deletes : [];
      const totalChanges = updates.length + deletes.length;

      if (totalChanges > 0) {
        new Notice(`⚡ 正在应用增量追更: 下载 ${updates.length} 篇，删除 ${deletes.length} 篇...`);
        // 1. 删除远程已删文件
        for (const del of deletes) {
          if (del && del.path) {
            const deleted = await this.applyRemoteDelete(del.path, true);
            if (deleted === false) {
              console.warn('[Nimbus] 增量删除未能落地，保留游标等待重试:', del.path);
              return false;
            }
          }
        }
        // 2. 更新远程改动文件：严格使用 HTTP 并发流式拉取并等待落盘屏障 (Promise Barrier)
        let hasPullFailure = false;
        let hasCriticalFailure = false;
        const PULL_CONCURRENCY = 4;
        for (let i = 0; i < updates.length; i += PULL_CONCURRENCY) {
          const batch = updates.slice(i, i + PULL_CONCURRENCY);
          const results = await Promise.all(batch.map(async (item) => {
            if (!item || !item.path) return true;
            const cleanPath = String(item.path).replace(/\\/g, '/').replace(/^\/+/, '');
            if (this.isIgnoredLocalPath(cleanPath)) return true;
            const localHash = this.fileHashes.get(cleanPath);
            const localFile = this.app.vault.getAbstractFileByPath(cleanPath);
            const fileExists = (localFile instanceof TFile) || (this.app.vault.adapter && await this.app.vault.adapter.exists(cleanPath));
            if (item.hash && fileExists && localHash === item.hash) {
              return true;
            }
            const ok = await this.pullRemoteFileViaHttp(cleanPath, item.mtime, item.hash);
            if (ok === false) {
              if (this.isCriticalSyncFile(cleanPath)) {
                hasCriticalFailure = true;
              } else {
                console.warn('[Nimbus] 辅助/配置文件拉取受阻，已安全忽略以保证核心笔记游标推进:', cleanPath);
              }
            }
            return ok !== false;
          }));
          if (results.some((r) => !r)) {
            hasPullFailure = true;
          }
          if (i + PULL_CONCURRENCY < updates.length) {
            await new Promise((r) => setTimeout(r, 30));
          }
        }

        // 🛡️ 增量一致性防线：仅当核心内容（Markdown / 附件）拉取失败时阻止推进游标；辅助配置失败则宽容放行并记录警告
        if (hasCriticalFailure) {
          console.warn('[Nimbus] 增量追更有核心笔记未能成功落地，已中止推进游标以防永久漏拉');
          new Notice('⚠️ 部分核心笔记拉取受阻，已暂停游标推进以防漏拉，将在网络恢复后自动重试');
          return false;
        }
      }

      const nextCursor = typeof data.cursor === 'number' ? data.cursor : (typeof data.latestCursor === 'number' ? data.latestCursor : sinceCursor);
      if (nextCursor) {
        if (nextCursor > this.getVaultCursor(vaultId)) {
          this.setVaultCursor(vaultId, nextCursor);
        }
        await this.saveSettings();
        await this.saveBaselineCache();
      }

      // 如果有分页数据且游标有向前推进，继续追更下一页
      if (data.hasMore && nextCursor > sinceCursor) {
        return await this.syncDeltaChanges(nextCursor);
      }

      if (totalChanges > 0) {
        new Notice(`✅ 增量追更完成 (共 ${totalChanges} 项)，游标已推进至 #${nextCursor}`);
      }
      return true;
    } catch (err) {
      console.warn('[Nimbus] 增量追更发生异常，将回退至全量对比:', err);
      return false;
    }
  }

  async fetchManifestHttp(vaultId) {
    try {
      const baseUrl = this.getCleanServerUrl();
      const cleanToken = this.getCleanToken();
      if (!baseUrl || !vaultId || !cleanToken) return null;
      const res = await fetch(`${baseUrl}/api/vaults/${encodeURIComponent(vaultId)}/manifest`, {
        headers: this.buildAuthHeaders()
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.manifest || null;
    } catch (err) {
      console.error('[Nimbus] 获取云端全量清单失败:', err);
      return null;
    }
  }

  async computeFileHash(file) {
    if (!file || !(file instanceof TFile)) return null;
    try {
      const buffer = await this.app.vault.readBinary(file);
      return await computeSha256(buffer);
    } catch (err) {
      console.warn('[Nimbus] 计算本地文件哈希失败:', file.path, err);
      return null;
    }
  }

  async syncManifest(remoteManifest, remoteCursor = 0) {
    new Notice('☁️ Nimbus 正在检查笔记库并自动同步 (3-Way Diff)...');
    try {
      const vaultId = this.settings.vaultId || 'default';
      let baseline = { ...this.getVaultBaseline(vaultId) };
      const files = this.app.vault.getFiles();
      const localFileMap = new Map();
      for (const f of files) {
        if (!this.isIgnoredLocalPath(f.path)) {
          localFileMap.set(f.path, f);
        }
      }

      const remoteEntries = Object.entries(remoteManifest || {});
      const remoteCount = remoteEntries.length;
      const localCount = localFileMap.size;

      // =========================================================================
      // 🛡️ 防御机制 1: 本地空库 / 新设备换机自愈 (Fresh Vault / New Device Auto-Heal)
      // 若本地为 0 个文件而云端有笔记，这 100% 是新设备安装或配置迁移，绝非用户主动删库！
      // 彻底清空任何历史/拷贝带来的幽灵基线 (Phantom Baseline)，禁止产生任何删除，转为全量初始拉取！
      // =========================================================================
      if (localCount === 0 && remoteCount > 0) {
        console.warn(`[Nimbus] 检测到本地库为空 (0 个文件)，而云端有 ${remoteCount} 个文件。判定为新设备/初次拉取，自动重置基线并全量拉取！`);
        new Notice(`🌱 首次同步 / 换机恢复：正在从云端拉取全部 ${remoteCount} 篇笔记...`);

        // 重置该库基线，防止误用 PC 端复制过来的 baseline
        if (!this.baselinesCache) this.baselinesCache = {};
        this.baselinesCache[vaultId] = {};
        await this.saveBaselineCache();

        const toPull = remoteEntries.map(([p, meta]) => ({ path: p, meta }));
        const pulledOk = new Set(); // 🛡️ 全量首拉也必须记录成功项；失败项绝不推进游标，留待增量重试
        const PULL_CONCURRENCY = 6;
        for (let i = 0; i < toPull.length; i += PULL_CONCURRENCY) {
          const batch = toPull.slice(i, i + PULL_CONCURRENCY);
          await Promise.all(batch.map(async (item) => {
            if (item.path && this.isIgnoredLocalPath(item.path)) return;
            const ok = await this.pullRemoteFileViaHttp(item.path, item.meta?.mtime, item.meta?.hash);
            if (ok) pulledOk.add(item.path);
            else console.warn('[Nimbus] 首次全量拉取失败，已推迟游标推进以便自动重试:', item.path);
          }));
          if (i + PULL_CONCURRENCY < toPull.length) {
            await new Promise((r) => setTimeout(r, 40));
          }
        }
        await this.saveBaselineCache();
        // 🛡️ 仅在全部拉取成功（或没有需要拉取的条目）时才推进游标；有失败时保持旧游标，下次 init 走增量重放补漏
        if (pulledOk.size === toPull.length && typeof remoteCursor === 'number' && remoteCursor >= 0) {
          // 🛡️ 收尾游标 = max(当前游标, 清单时点游标, 本会话 ack 见过的最新游标)；
          // ack 的 cursor 全部 durable 后返回，首拉期间自推行为已包含，
          // 下一次 init 无需为自家推送/备份再重放一轮增量。
          const ackSeen = this._lastServerCursorSeen ? (this._lastServerCursorSeen[vaultId] || 0) : 0;
          this.setVaultCursor(vaultId, Math.max(this.getVaultCursor(vaultId), remoteCursor, ackSeen));
          await this.saveSettings();
        }
        if (pulledOk.size < toPull.length) {
          new Notice(`⚠️ 首次拉取有 ${toPull.length - pulledOk.size} 篇未成功，将在下次连接时自动重试`);
        }
        return;
      }

      const allPaths = new Set([
        ...localFileMap.keys(),
        ...Object.keys(remoteManifest || {}),
        ...Object.keys(baseline)
      ]);

      // 只为需要三方判断的路径计算哈希，并限制并发读取，避免逐文件串行扫描拖慢大型 Vault。
      const hashTargets = [];
      for (const path of allPaths) {
        const localFile = localFileMap.get(path);
        if (!localFile) continue;
        const remoteMeta = remoteManifest[path];
        const baseMeta = baseline[path];
        if (baseMeta && !remoteMeta && baseMeta.ignored) continue; // 黑名单文件无需比对
        if ((remoteMeta && baseMeta) || (!remoteMeta && baseMeta) || (remoteMeta && !baseMeta)) {
          hashTargets.push([path, localFile]);
        }
      }
      const localHashes = new Map();
      const HASH_CONCURRENCY = 4;
      for (let i = 0; i < hashTargets.length; i += HASH_CONCURRENCY) {
        const batch = hashTargets.slice(i, i + HASH_CONCURRENCY);
        const hashes = await Promise.all(batch.map(([, file]) => this.computeFileHash(file)));
        for (let j = 0; j < batch.length; j++) localHashes.set(batch[j][0], hashes[j]);
      }

      const toPull = [];
      const toPush = [];
      const toLocalDelete = [];
      const toRemoteDelete = [];
      const toLocalConflictBackup = [];
      let hasDeferredRemoteDeletes = false;
      let hasDeferredLocalDeletes = false;
      let hasDeferredLocalPushes = false;

      // 3-Way 对比分析：Local (本地当前) vs Remote (云端当前) vs Base (上次同步基线)
      for (const path of allPaths) {
        if (this.isIgnoredLocalPath(path)) continue;

        const localFile = localFileMap.get(path);
        const remoteMeta = remoteManifest ? remoteManifest[path] : null;
        const baseMeta = baseline[path];

        if (localFile && remoteMeta && baseMeta) {
          // 场景 1: 三方均存在
          const localHash = localHashes.get(path);
          if (localHash === remoteMeta.hash) {
            // 内容一致，更新内存与基线
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = { hash: remoteMeta.hash, mtime: remoteMeta.mtime, size: remoteMeta.size };
          } else {
            const localChanged = (localHash !== baseMeta.hash);
            const remoteChanged = (remoteMeta.hash !== baseMeta.hash);

            if (localChanged && !remoteChanged) {
              // 仅本地修改 -> 推送至云端
              toPush.push(localFile);
            } else if (!localChanged && remoteChanged) {
              // 仅云端修改 -> 拉取至本地
              toPull.push({ path, meta: remoteMeta });
            } else {
              // 🛡️ 两端均发生修改（真正并发冲突）
              // 绝不能凭操作系统不可靠的 mtime 覆盖云端！
              // 永远以权威云端优先拉取，并在本地妥善保留离线修改为分支副本，防止误伤云端新笔记
              toLocalConflictBackup.push({ file: localFile, path });
              toPull.push({ path, meta: remoteMeta });
            }
          }
        } else if (localFile && !remoteMeta && baseMeta) {
          if (baseMeta.ignored) {
            // 🛡️ 服务端黑名单文件：不入同步域。本地保留，不参与“云端已删→本地删”判定，也不重复推送
            continue;
          }
          // 场景 2: 本地存在，基线存在，但云端已不存在 (例如 PC 端删除了云端文件)
          const localHash = localHashes.get(path);
          const localChanged = (localHash !== baseMeta.hash);
          if (!localChanged) {
            // 本地未修改过 -> 遵从云端删除指令，删除本地文件，避免复活云端！
            toLocalDelete.push(path);
            this.fileHashes.delete(path);
          } else {
            // 本地离线有新编辑 -> 保留本地修改，作为新文件重新推送
            toPush.push(localFile);
          }
        } else if (!localFile && remoteMeta && baseMeta) {
          // 场景 3: 云端存在，基线存在，但本地已不存在 (例如本端离线时删除了该笔记)
          const remoteChanged = (remoteMeta.hash !== baseMeta.hash);
          if (!remoteChanged) {
            // 云端未被其他设备修改 -> 遵从本地删除，向云端发送删除指令
            toRemoteDelete.push(path);
            this.fileHashes.delete(path);
          } else {
            // 云端被其他设备更新了 -> 保留云端新内容，拉取到本地
            toPull.push({ path, meta: remoteMeta });
          }
        } else if (localFile && !remoteMeta && !baseMeta) {
          // 场景 4: 本地纯新增文件 (无基线，云端无) -> 推送
          toPush.push(localFile);
        } else if (!localFile && remoteMeta && !baseMeta) {
          // 场景 5: 云端纯新增文件 (无基线，本地无) -> 拉取
          toPull.push({ path, meta: remoteMeta });
        } else if (localFile && remoteMeta && !baseMeta) {
          // 场景 6: 两端均存在但无历史基线 (首次绑定/基线重置/长期离线基线断层)
          const localHash = localHashes.get(path);
          if (localHash && remoteMeta.hash && localHash === remoteMeta.hash) {
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = { hash: remoteMeta.hash, mtime: remoteMeta.mtime, size: remoteMeta.size };
          } else {
            // 🛡️ 两端内容不一致且无历史基线时：云端为权威源（Source of Truth）优先拉取，
            // 绝不盲目信赖本地被 OS 刷新的 mtime。本地版本自动保留为离线分支副本，防止旧客户端逆向冲毁云端！
            toLocalConflictBackup.push({ file: localFile, path });
            toPull.push({ path, meta: remoteMeta });
          }
        } else if (!localFile && !remoteMeta && baseMeta) {
          // 场景 7: 两端均已删除
          delete baseline[path];
          this.fileHashes.delete(path);
        }
      }

      // =========================================================================
      // 🛡️ 防御机制 2: 批量删除安全熔断阀 (Safety Circuit Breaker)
      // 若单次尝试删除超过安全阈值（例如 > 5 篇且占总比 > 35%），自动强制拦截！
      // =========================================================================
      const remoteDelThreshold = Math.max(5, Math.floor(remoteCount * 0.35));
      if (toRemoteDelete.length > remoteDelThreshold) {
        console.error(`[Nimbus 安全熔断] 拦截异常大批量云端删除！尝试删除: ${toRemoteDelete.length} 篇，云端总数: ${remoteCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 拦截到单次尝试删除 ${toRemoteDelete.length} 篇云端笔记！\n已自动暂停云端删除以防意外清空。若确需批量删除，请在控制台操作。`, 10000);
        hasDeferredRemoteDeletes = true;
        toRemoteDelete.length = 0; // 保留旧基线，等待用户确认后重新评估
      }

      const localDelThreshold = Math.max(5, Math.floor(localCount * 0.35));
      if (toLocalDelete.length > localDelThreshold) {
        console.error(`[Nimbus 安全熔断] 拦截异常大批量本地删除！尝试删除: ${toLocalDelete.length} 篇，本地总数: ${localCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 拦截到单次尝试删除本地 ${toLocalDelete.length} 篇笔记！\n已自动暂停本地删除以防数据丢失。`, 10000);
        hasDeferredLocalDeletes = true;
        toLocalDelete.length = 0; // 清空本地删除任务
      }

      // =========================================================================
      // 🛡️ 防御机制 3: 异常大批量上传安全熔断阀 (Safety Circuit Breaker for Upload)
      // 若单次尝试上传超过安全阈值（例如 > 15 篇且占云端总比 > 40%），拦截疑似陈旧设备大批量覆盖
      // =========================================================================
      const remoteCountVal = remoteCount || 0;
      const pushThreshold = Math.max(15, Math.floor(remoteCountVal * 0.4));
      if (remoteCountVal > 0 && toPush.length > pushThreshold) {
        console.warn(`[Nimbus 安全熔断] 拦截异常大批量推送: 尝试上传 ${toPush.length} 篇，云端总数: ${remoteCountVal}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 检测到当前设备尝试单次向云端推送 ${toPush.length} 篇笔记（超过安全阈值）！\n已自动暂停大批量推送以防意外覆盖云端较新笔记。请在控制台核对。`, 12000);
        toPush.length = 0;
        // 🛡️ 与删除熔断同一语义：熔断 = 未完成，绝不推进游标（否则下次增量对齐会跳过这批推送）
        hasDeferredLocalPushes = true;
      }

      const pullCount = toPull.length;
      const pushCount = toPush.length;
      const localDelCount = toLocalDelete.length;
      const remoteDelCount = toRemoteDelete.length;
      const conflictBackupCount = toLocalConflictBackup.length;

      if (pullCount === 0 && pushCount === 0 && localDelCount === 0 && remoteDelCount === 0 && conflictBackupCount === 0 && !hasDeferredRemoteDeletes && !hasDeferredLocalDeletes && !hasDeferredLocalPushes) {
        if (!this.baselinesCache) this.baselinesCache = {};
        this.baselinesCache[vaultId] = baseline;
        await this.saveBaselineCache();
        if (typeof remoteCursor === 'number' && remoteCursor >= 0) {
          const ackSeen = this._lastServerCursorSeen ? (this._lastServerCursorSeen[vaultId] || 0) : 0;
          this.setVaultCursor(vaultId, Math.max(this.getVaultCursor(vaultId), remoteCursor, ackSeen));
        }
        new Notice('✅ 本地笔记与 Nimbus 云端已保持一致 (3-Way 基线校验完成)');
        return;
      }

      new Notice(`⚡ 3-Way 同步开始: 上传 ${pushCount}，下载 ${pullCount}，本地删除 ${localDelCount}，云端删除 ${remoteDelCount}${conflictBackupCount > 0 ? `，冲突备份 ${conflictBackupCount}` : ''}`);

      let hasPullFailure = false;
      let hasCriticalFailure = false;

      // 0. 为离线并发冲突生成本地版本备份
      // 🛡️ 只有备份真正成功的路径才允许 backupDone=true 透传（R-1 语义完整性，A2）：
      // 旧实现用「计划清单」预置集合、忽略 backupLocalConflictFile 的失败返回值——
      // 备份失败（null）的路径也带上 backupDone=true 拉取，等于对本地未同步修改
      // 直接放行裸覆盖。现在失败路径不进集合，交由 applyRemoteBinaryChange 的
      // 覆盖防护重试备份，仍失败则拒绝拉取（返回 false → hasPullFailure → 游标不推进）。
      const conflictBackupPaths = new Set();
      for (const item of toLocalConflictBackup) {
        const backed = await this.backupLocalConflictFile(item.file, item.path);
        if (backed) conflictBackupPaths.add(item.path);
      }

      // 1. 执行本地删除 (云端已删)
      for (const delPath of toLocalDelete) {
        if (!(await this.applyRemoteDelete(delPath))) hasPullFailure = true;
      }

      // 2. 执行云端删除 (本地已删)
      for (const delPath of toRemoteDelete) {
        const deleted = await this.sendWsMessageAndWait({ type: 'delete', path: delPath });
        if (deleted) delete baseline[delPath];
        else hasPullFailure = true;
      }

      // 3. 并发节流执行拉取 (PULL)，等待所有文件确认落地落盘
      const pulledOk = new Set(); // 🛡️ 仅记录已确认拉取成功的文件；未成功的文件绝不写入基线
      const PULL_CONCURRENCY = 4;
      for (let i = 0; i < toPull.length; i += PULL_CONCURRENCY) {
        const batch = toPull.slice(i, i + PULL_CONCURRENCY);
        const results = await Promise.all(batch.map(async (item) => {
          if (this.isIgnoredLocalPath(item.path)) return true;
          const ok = await this.pullRemoteFileViaHttp(item.path, item.meta?.mtime, item.meta?.hash, { backupDone: conflictBackupPaths.has(item.path) });
          if (ok === false) {
            if (this.isCriticalSyncFile(item.path)) {
              hasCriticalFailure = true;
            } else {
              console.warn('[Nimbus] 辅助/配置文件拉取受阻，已安全忽略:', item.path);
            }
          } else {
            pulledOk.add(item.path);
          }
          return ok !== false;
        }));
        if (results.some((r) => r === false)) {
          hasPullFailure = true;
        }
        if (i + PULL_CONCURRENCY < toPull.length) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }

      // 4. 并发节流执行推送 (PUSH)
      const PUSH_CONCURRENCY = 4;
      for (let i = 0; i < toPush.length; i += PUSH_CONCURRENCY) {
        const batch = toPush.slice(i, i + PUSH_CONCURRENCY);
        const results = await Promise.all(batch.map((f) => this.pushLocalFile(f)));
        if (results.some((ok) => !ok)) hasPullFailure = true;
        if (i + PUSH_CONCURRENCY < toPush.length) {
          await new Promise((r) => setTimeout(r, 30));
        }
      }

      // 🛡️ 防御机制 3: 仅固化本地已经存在且内容确认的文件基线，新拉取落盘的文件也一并纳入
      const currentVaultFiles = this.app.vault.getFiles();
      const currentLocalPaths = new Set(currentVaultFiles.map((f) => f.path));
      const sanitizedBaseline = {};
      for (const [p, bInfo] of Object.entries(baseline)) {
        if (currentLocalPaths.has(p) || (remoteManifest[p] && (toRemoteDelete.includes(p) || hasDeferredRemoteDeletes))) {
          sanitizedBaseline[p] = bInfo;
        }
      }
      for (const item of toPull) {
        // 🛡️ 只有拉取确实已确认落盘的文件才允许写入云端基线；
        // 否则本地内容可能是旧版本，基线却被污染成云端最新 hash，
        // 随后 flush 阶段会把旧内容反向推回云端（baseHash 恰好等于云端当前 hash，连冲突副本都不会留）
        if (item && item.path && pulledOk.has(item.path) && currentLocalPaths.has(item.path) && item.meta) {
          sanitizedBaseline[item.path] = {
            hash: item.meta.hash,
            mtime: item.meta.mtime || Date.now(),
            size: item.meta.size || 0,
          };
        }
      }

      if (!this.baselinesCache) this.baselinesCache = {};
      this.baselinesCache[vaultId] = sanitizedBaseline;
      await this.saveBaselineCache();
      if (typeof remoteCursor === 'number' && remoteCursor >= 0 && !hasCriticalFailure && !hasPullFailure && !hasDeferredRemoteDeletes && !hasDeferredLocalDeletes && !hasDeferredLocalPushes) {
        // 🛡️ 收尾游标 = max(当前游标, 清单时点游标, 本会话 ack 见过的最新游标)；
        // ack 的 cursor 全部 durable 后返回，3-Way 期间自推/自删产生的变更已包含，
        // 下一次 init 无需为自家变更再重放一轮增量（旧行为：游标退回 remoteCursor）。
        const ackSeen = this._lastServerCursorSeen ? (this._lastServerCursorSeen[vaultId] || 0) : 0;
        this.setVaultCursor(vaultId, Math.max(this.getVaultCursor(vaultId), remoteCursor, ackSeen));
        await this.saveSettings();
      } else if (hasCriticalFailure || hasPullFailure || hasDeferredRemoteDeletes || hasDeferredLocalDeletes || hasDeferredLocalPushes) {
        console.warn('[Nimbus] 3-Way 同步存在未完成操作或拉取失败，暂不推进最新游标以备下次重试完整对齐');
        new Notice('⚠️ 部分同步操作未完成，暂不推进游标以防漏拉，将在网络稳定后自动重试');
      }

      new Notice(`✅ 3-Way 自动同步完成: 成功处理 ${pushCount + pullCount + localDelCount + remoteDelCount} 个变更任务`);
    } catch (err) {
      console.error('[Nimbus] 3-Way 自动同步异常:', err);
      new Notice(`❌ 自动同步异常: ${err.message}`);
    }
  }

  async flushPendingLocalChangesAfterBarrier() {
    this.syncBarrierActive = false;
    // 🛡️ 先执行屏障期挂起的本地重命名，再处理新路径上的补充修改推送，
    // 防止「先 push 新路径修改、后 rename 旧路径」导致云端新修改被旧文件覆盖！
    await this.flushPendingLocalRenames();
    if (!this.pendingLocalQueueWhileBarrier || this.pendingLocalQueueWhileBarrier.size === 0) {
      await this.flushPendingLocalDeletes();
      return;
    }
    const pathsToCheck = Array.from(this.pendingLocalQueueWhileBarrier);
    this.pendingLocalQueueWhileBarrier.clear();

    const vaultId = this.settings.vaultId || 'default';
    const baseline = this.getVaultBaseline(vaultId);

    for (const path of pathsToCheck) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const currentHash = await this.computeFileHash(file);
        const baseMeta = baseline[path];
        // 关键判定：只有当本地当前内容 Hash 确实与基线不一致时，说明离线期间用户确实编辑了该文件，才进行上传
        if (currentHash && (!baseMeta || currentHash !== baseMeta.hash)) {
          await this.pushLocalFile(file);
        }
      }
    }
    await this.flushPendingLocalDeletes();
  }

  /**
   * 增量追更 / 游标秒级对齐快速通道后的本地离线磁盘扫描：
   * 捕捉 Obsidian 未打开期间（如外部编辑器修改、外部新建/删除文件）的磁盘变更，
   * 与本地 baseline 对账后补推或补删，复用 3-Way 同级的安全熔断保护。
   */
  async scanOfflineDiskDiffAfterDelta() {
    try {
      const vaultId = this.settings.vaultId || 'default';
      const baseline = this.getVaultBaseline(vaultId);
      if (!baseline || typeof baseline !== 'object') return false;
      const baseEntries = Object.entries(baseline);
      if (baseEntries.length === 0) return false;
      if (!this.app || !this.app.vault || typeof this.app.vault.getFiles !== 'function') return false;

      const files = this.app.vault.getFiles();
      const localFileMap = new Map();
      for (const f of files) {
        if (f && f.path && !this.isIgnoredLocalPath(f.path)) {
          localFileMap.set(f.path, f);
        }
      }

      // 🛡️ 本地空库保护：本地 0 个文件时绝不触发任何云端删除
      if (localFileMap.size === 0) return false;

      const toPush = [];
      const toRemoteDelete = [];

      for (const [path, file] of localFileMap.entries()) {
        const baseMeta = baseline[path];
        if (!baseMeta) {
          toPush.push(file);
          continue;
        }
        if (baseMeta.ignored) continue;
        // 快速跳过：stat.mtime 与 stat.size 未变且内存 hash 与基线一致时免读盘
        if (
          file.stat
          && typeof baseMeta.mtime === 'number'
          && typeof baseMeta.size === 'number'
          && file.stat.mtime === baseMeta.mtime
          && file.stat.size === baseMeta.size
          && this.fileHashes.get(path) === baseMeta.hash
        ) {
          continue;
        }
        const currentHash = await this.computeFileHash(file);
        if (currentHash && currentHash !== baseMeta.hash) {
          toPush.push(file);
        }
      }

      for (const [path, baseMeta] of baseEntries) {
        if (!baseMeta || baseMeta.ignored) continue;
        if (this.isIgnoredLocalPath(path)) continue;
        if (!localFileMap.has(path)) {
          if (this.pendingLocalDeletes && this.pendingLocalDeletes.has(path)) continue;
          toRemoteDelete.push(path);
        }
      }

      const baseCount = baseEntries.length;
      const remoteDelThreshold = Math.max(5, Math.floor(baseCount * 0.35));
      if (toRemoteDelete.length > remoteDelThreshold) {
        console.warn(`[Nimbus 安全熔断] 增量后离线扫描拦截异常大批量云端删除: ${toRemoteDelete.length} / ${baseCount}`);
        toRemoteDelete.length = 0;
      }

      const pushThreshold = Math.max(15, Math.floor(baseCount * 0.4));
      if (toPush.length > pushThreshold) {
        console.warn(`[Nimbus 安全熔断] 增量后离线扫描拦截异常大批量推送: ${toPush.length} / ${baseCount}`);
        toPush.length = 0;
      }

      for (const delPath of toRemoteDelete) {
        await this.deleteRemoteFile(delPath);
      }
      for (const file of toPush) {
        await this.pushLocalFile(file);
      }
      return toRemoteDelete.length > 0 || toPush.length > 0;
    } catch (err) {
      console.warn('[Nimbus] 增量后离线磁盘差异扫描异常:', err);
      return false;
    }
  }

  /**
   * 补发“删除指令未确认/屏障期产生”的挂起删除：
   * 逐条等待云端 ack；确认成功后清基线；仍失败则继续挂起，等待下一次屏障完成。
   */
  /**
   * 补发屏障期/远端应用期间被记录的本地重命名：
   * 逐条确认云端 ack；过期记录（目标又改了名/不存在）跳过，交给 3-Way 对账兜底。
   */
  async flushPendingLocalRenames() {
    if (!this.pendingLocalRenames || this.pendingLocalRenames.size === 0) return;
    const entries = Array.from(this.pendingLocalRenames.entries());
    this.pendingLocalRenames.clear();
    for (const [oldPath, newPath] of entries) {
      // 目标已再次消失/被删除：旧的改名记录过期，交由下次 3-Way 对账兜底
      if (this.isIgnoredLocalPath(oldPath) && this.isIgnoredLocalPath(newPath)) continue;
      const target = this.app.vault.getAbstractFileByPath(newPath);
      const oldStill = this.app.vault.getAbstractFileByPath(oldPath);
      if (!(target instanceof TFile) || (oldStill instanceof TFile)) {
        console.warn('[Nimbus] 屏障期重命名记录已过期，跳过并交由 3-Way 对账:', oldPath, '->', newPath);
        continue;
      }
      const renamed = await this.renameRemoteFile(oldPath, target);
      if (!renamed) {
        console.warn('[Nimbus] 屏障期重命名补发未获确认，交由下次对账兜底:', oldPath, '->', newPath);
      }
    }
  }

  async flushPendingLocalDeletes() {
    if (!this.pendingLocalDeletes || this.pendingLocalDeletes.size === 0) return;
    const deletes = Array.from(this.pendingLocalDeletes);
    for (const delPath of deletes) {
      const ack = await this.sendWsMessageAndWait({ type: 'delete', path: delPath });
      if (ack) {
        this.pendingLocalDeletes.delete(delPath);
        this.fileHashes.delete(delPath);
        this.updateBaselineEntry(this.settings.vaultId, delPath, null);
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // 失败但连接仍健康（如 ack 超时）：丢弃本次挂起，依赖下次 3-Way 场景 3 兜底，
        // 避免把永久失败的删除放进集合变成死循环。
        this.pendingLocalDeletes.delete(delPath);
        console.warn('[Nimbus] 挂起删除仍未获确认，交由下次 3-Way 对账兜底:', delPath);
      }
      // 连接中断时保留挂起，等重连后的屏障阶段继续重试
    }
  }

  async backupLocalConflictFile(localFile, relPath) {
    if (!localFile || !(localFile instanceof TFile)) return null;
    try {
      const ext = localFile.extension ? `.${localFile.extension}` : '';
      const base = relPath.slice(0, relPath.length - ext.length);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const conflictPath = `${base}.conflict-offline-${stamp}${ext}`;
      const buffer = await this.app.vault.readBinary(localFile);

      // 确保父目录存在
      const parts = conflictPath.split('/');
      if (parts.length > 1) {
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath += (currentPath ? '/' : '') + parts[i];
          if (!this.app.vault.getAbstractFileByPath(currentPath)) {
            await this.app.vault.createFolder(currentPath);
          }
        }
      }
      await this.app.vault.createBinary(conflictPath, buffer);
      new Notice(`⚠️ 检测到离线并发冲突，已保留本地版本备份:\n${conflictPath}`, 7000);
      return conflictPath;
    } catch (e) {
      console.warn('[Nimbus] 创建本地离线冲突备份失败:', relPath, e);
      return null;
    }
  }

  async fullSyncAllFiles() {
    new Notice('☁️ 开始全量双向同步...');
    if (!this.settings.token || !this.settings.vaultId) {
      new Notice('❌ 请先在 Nimbus 设置中完成登录并绑定 Vault');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
    }

    try {
      const baseUrl = this.getCleanServerUrl();
      const cleanToken = this.getCleanToken();
      if (!baseUrl || !cleanToken || !this.settings.vaultId) return;
      const res = await fetch(`${baseUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/manifest`, {
        headers: this.buildAuthHeaders()
      });

      if (!res.ok) {
        throw new Error(`获取云端清单失败 (HTTP ${res.status})`);
      }

      const data = await res.json();
      const remoteManifest = data.manifest || {};
      const remoteCursor = data.cursor || data.latestCursor || 0;
      await this.syncManifest(remoteManifest, remoteCursor);
    } catch (err) {
      console.error('[Nimbus] 全量双向同步失败:', err);
      new Notice(`❌ 全量双向同步失败: ${err.message}`);
    }
  }

  async forcePushAllLocalFiles() {
    new Notice('☁️ 开始强制推送本地所有笔记到云端...');
    const files = this.app.vault.getFiles();
    if (!this.settings.token || !this.settings.vaultId) {
      new Notice('❌ 请先在 Nimbus 设置中完成登录并绑定 Vault');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
      await new Promise((r) => setTimeout(r, 1000));
    }

    let pushed = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (f) => {
        await this.pushLocalFile(f);
        pushed++;
      }));
      if (i + CONCURRENCY < files.length) {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    new Notice(`✅ 强制推送完成: 共扫描并推送 ${pushed} 个笔记/附件至云端`);
  }

  async applyRemoteChange(filePath, base64Content, mtime, hash) {
    // 🛡️ E-3：0 字节文件的 base64 是 ''（合法内容而非失败）。旧实现的 !base64 把
    // 空 file 响应误判为失败——WS 'file' 通道上空文件永不落地、游标被冻结到下次
    // init（HTTP 通道因 ArrayBuffer 恒 truthy 而无此洞）。只拒绝真正的缺参。
    if (!filePath || base64Content == null) return false;
    const buffer = base64ToArrayBuffer(base64Content);
    return this.applyRemoteBinaryChange(filePath, buffer, mtime, hash);
  }

  async applyRemoteBinaryChange(filePath, buffer, mtime, hash, options = {}) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || !buffer) return false;
    // 🛡️ 先校验再写盘：buffer 就在手上。任何与声明哈希不符的内容（代理错误页、
    // 传输损坏）在触碰磁盘之前就被拒绝。旧实现先落盘后校验，坏内容会在
    // “校验失败但写入已完成”的路径上残留，还会被后续「本地 ≠ 基线」的判定
    // 当成用户修改推回云端，反向污染云端。
    const actualHash = await computeSha256(buffer);
    if (hash && actualHash && String(hash) !== actualHash) {
      console.error(`[Nimbus] 拉取内容与其声明哈希不一致，拒绝写入: ${cleanPath} expected=${hash} actual=${actualHash}`);
      return false;
    }
    // 🛡️ R-B：一次性期待集的正确消费点位。_conflictRestorePaths 里的标记语义是
    // 「本次拉取的内容已在别处备份（3-Way 冲突备份），覆盖防护不必再生成副本」——
    // 它只为**这一次**写入有效。旧实现在 TFile 分支内部才 delete：
    // 1) options.backupDone === true 短路时标记根本不被消费，残留到未来某次
    //    无关的同路径拉取上，会让那次覆盖防护被静默跳过；
    // 2) 非 TFile 分支（adapter/新建）走到也不清理，同样泄漏。
    // 现在校验通过后即无条件消费（哈希不符的拒绝写入返回 false 例外：标记保留，
    // 让重试拉取仍带完整防护）。后续任何提前 return 的失败路径（备份失败等）
    // 拒绝写盘、基线未变，重试时防护会按基线重算，安全。
    let conflictRestorePending = false;
    if (this._conflictRestorePaths instanceof Set) {
      conflictRestorePending = this._conflictRestorePaths.delete(cleanPath);
    }
    if (!this.applyingRemotePaths) this.applyingRemotePaths = new Set();
    // 先拿路径锁，再标记「远端写入中」：
    // 否则等待锁期间设置 applyingRemotePaths 会让持有锁的本地推送被误判为“远端回声”而静默丢弃；
    // 若调用方已持有该路径锁（options.skipLock === true，例如 onLocalFileChange -> pushLocalFile -> HTTP 冲突拉取），则跳过重入加锁以防自锁死锁
    const releaseLocalLock = options.skipLock ? () => {} : await this.acquireLocalFileLock(cleanPath);
    this.applyingRemotePaths.add(cleanPath);
    this.remoteApplyingCount = (this.remoteApplyingCount || 0) + 1;
    this.isApplyingRemoteChange = true;

    try {
      const existing = this.app.vault.getAbstractFileByPath(cleanPath);
      const isHidden = cleanPath.startsWith('.') || cleanPath.includes('/.');
      const adapterExists = this.app.vault.adapter ? await this.app.vault.adapter.exists(cleanPath) : false;

      if (existing instanceof TFile) {
        // 🛡️ 覆盖防护：远端更新即将覆盖本地文件。若本地内容相对“上次已同步基线”
        // 存在未推送的修改（离线编辑 / 推送仍在途），绝不能静默覆盖——
        // 先把本地版本备份为 .conflict-offline-* 副本（与 applyRemoteDelete 的
        // protectModified 语义一致），备份失败则拒绝本次覆盖；否则本地离线编辑
        // 会被增量/实时远端版本悄悄抹掉且基线随后更新为远端 hash，任何兜底都救不回。
        // 已显式做过备份的调用方（3-Way toLocalConflictBackup）与冲突自恢复拉取
        // 传 backupDone / 一次性期待集（消费在函数入口，见上方 R-B 注释）。
        const backupDone = options.backupDone === true || conflictRestorePending;
        if (!backupDone) {
          const baseMeta = this.getBaselineEntry(this.settings.vaultId, cleanPath);
          const lastKnown = (baseMeta && baseMeta.hash) || this.fileHashes.get(cleanPath) || null;
          const localHash = await this.computeFileHash(existing);
          if (!localHash) {
            console.warn('[Nimbus] 远端写盘防护：无法读取本地内容计算哈希，已暂停该覆盖指令:', cleanPath);
            return false;
          }
          if (!lastKnown || lastKnown !== localHash) {
            const conflictPath = await this.backupLocalConflictFile(existing, cleanPath);
            if (!conflictPath) {
              console.warn('[Nimbus] 远端写盘防护：本地修改备份失败，已暂停该覆盖指令以防数据丢失:', cleanPath);
              return false;
            }
            // 备份副本的创建事件会被 isApplyingRemoteChange 屏蔽，这里直接推送它参与同步
            // （与 applyRemoteDelete 的删除防护同一语义；屏障期重复入队无害，hash 拦截会跳过）
            const backupFile = this.app.vault.getAbstractFileByPath(conflictPath);
            if (backupFile instanceof TFile) {
              await this.pushLocalFile(backupFile);
            }
          }
        }
        await this.app.vault.modifyBinary(existing, buffer);
      } else if (adapterExists) {
        // 文件已在磁盘上存在（例如 .obsidian/ 隐藏配置或未被抽象索引的文件）
        if (this.app.vault.adapter) {
          await this.app.vault.adapter.writeBinary(cleanPath, buffer);
        }
      } else {
        // Ensure parent directories exist
        const parts = cleanPath.split('/');
        if (parts.length > 1) {
          let currentPath = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentPath += (currentPath ? '/' : '') + parts[i];
            const folderExists = this.app.vault.getAbstractFileByPath(currentPath) ||
              (this.app.vault.adapter && await this.app.vault.adapter.exists(currentPath));
            if (!folderExists) {
              try {
                if (currentPath.startsWith('.')) {
                  if (this.app.vault.adapter) await this.app.vault.adapter.mkdir(currentPath);
                } else {
                  await this.app.vault.createFolder(currentPath);
                }
              } catch (folderErr) {
                // Folder may already exist or created concurrently
              }
            }
          }
        }
        try {
          if (isHidden) {
            // 隐藏目录/配置：直接使用底层 adapter 写入，杜绝 app.vault.createBinary 拒绝或 File already exists 异常
            if (this.app.vault.adapter) {
              await this.app.vault.adapter.writeBinary(cleanPath, buffer);
            } else {
              await this.app.vault.createBinary(cleanPath, buffer);
            }
          } else {
            await this.app.vault.createBinary(cleanPath, buffer);
          }
        } catch (createErr) {
          if (this.app.vault.adapter) {
            await this.app.vault.adapter.writeBinary(cleanPath, buffer);
          } else {
            throw createErr;
          }
        }
      }

      // 字节级哈希校验已在写盘之前完成（见函数入口），actualHash 即实际写入内容；
      // 仅在极端环境拿不到哈希（null）时回退到服务端声明的 hash。
      const calculatedHash = actualHash || hash;
      if (calculatedHash) {
        if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(cleanPath);
        this.fileHashes.set(cleanPath, calculatedHash);
        this.updateBaselineEntry(this.settings.vaultId, cleanPath, {
          hash: calculatedHash,
          mtime: mtime || Date.now(),
          size: buffer.byteLength
        });
      }
      return true;
    } catch (err) {
      console.error('[Nimbus] 写入远程文件失败:', cleanPath, err);
      return false;
    } finally {
      this.applyingRemotePaths.delete(cleanPath);
      this.remoteApplyingCount = Math.max(0, (this.remoteApplyingCount || 1) - 1);
      this.isApplyingRemoteChange = (this.remoteApplyingCount > 0);
      releaseLocalLock();
    }
  }

  async pullRemoteFileViaHttp(filePath, mtime, expectedHash, options = {}) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanToken = this.getCleanToken();
    if (!cleanPath || !this.settings.vaultId || !cleanToken) return false;
    const isConflictRestore = Boolean(this._conflictRestorePaths instanceof Set && this._conflictRestorePaths.has(cleanPath));
    if (!isConflictRestore && !options.forcePull && expectedHash && this.fileHashes.get(cleanPath) === expectedHash) {
      return true;
    }
    try {
      const serverUrl = this.getCleanServerUrl();
      const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
      const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
      const headers = this.buildAuthHeaders();
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (isConflictRestore && this._conflictRestorePaths instanceof Set) {
          this._conflictRestorePaths.delete(cleanPath);
        }
        console.warn(`[Nimbus] HTTP 拉取文件失败 (${res.status}): ${cleanPath}`);
        return false;
      }
      const arrayBuffer = await res.arrayBuffer();
      const written = await this.applyRemoteBinaryChange(cleanPath, arrayBuffer, mtime, expectedHash, options);
      return written !== false;
    } catch (err) {
      if (isConflictRestore && this._conflictRestorePaths instanceof Set) {
        this._conflictRestorePaths.delete(cleanPath);
      }
      console.error('[Nimbus] HTTP 流式拉取远程文件失败:', cleanPath, err);
      return false;
    }
  }

  async applyRemoteDelete(filePath, protectModified = false) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath) return false;
    // 🛡️ E-2（插件端对称防线的最后一块）：即使删除请求从 web/MCP/git-pull 等
    // 旁路通道漏进来（服务端各删除通道都有黑名单检查，但纵深防御要求端侧兜底），
    // 黑名单路径保持「本地保留、不同步」语义：不执行删除，只清理本地同步状态
    //（基线/文件哈希）——等价于 WS ignored ack 的清理动作。
    if (this.isIgnoredLocalPath(cleanPath)) {
      this.fileHashes.delete(cleanPath);
      this.updateBaselineEntry(this.settings.vaultId, cleanPath, null);
      console.warn(`[Nimbus] 黑名单路径的远端删除已按「本地保留」处理:`, cleanPath);
      return true;
    }
    if (!this.applyingRemotePaths) this.applyingRemotePaths = new Set();
    const releaseLocalLock = await this.acquireLocalFileLock(cleanPath);
    this.applyingRemotePaths.add(cleanPath);
    this.remoteApplyingCount = (this.remoteApplyingCount || 0) + 1;
    this.isApplyingRemoteChange = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(cleanPath);
      if (protectModified && existing instanceof TFile) {
        // 🛡️ 增量/实时删除防护：本地内容与“上次已同步基线”不一致（有离线修改）时，
        // 绝不能静默执行远端删除指令。先把本地版本备份为 `.conflict-offline-*` 副本再删，
        // 与 3-Way 场景 2 的“本地有修改→保留修改”语义保持一致。
        const baseMeta = this.getBaselineEntry(this.settings.vaultId, cleanPath);
        const lastKnown = (baseMeta && baseMeta.hash) || this.fileHashes.get(cleanPath) || null;
        const currentHash = await this.computeFileHash(existing);
        if (!currentHash) {
          console.warn('[Nimbus] 删除防护：无法读取本地内容计算哈希，已安全跳过该删除指令:', cleanPath);
          return false;
        }
        if (!lastKnown || lastKnown !== currentHash) {
          const conflictPath = await this.backupLocalConflictFile(existing, cleanPath);
          if (!conflictPath) {
            console.warn('[Nimbus] 删除防护：本地修改备份失败，已暂停该删除指令以防数据丢失:', cleanPath);
            return false;
          }
          // 备份副本的创建事件会被 isApplyingRemoteChange 屏蔽，这里直接推送它参与同步
          const backupFile = this.app.vault.getAbstractFileByPath(conflictPath);
          if (backupFile instanceof TFile) {
            await this.pushLocalFile(backupFile);
          }
        }
      }
      if (existing instanceof TFile) {
        await this.app.vault.delete(existing);
      } else if (this.app.vault.adapter && await this.app.vault.adapter.exists(cleanPath)) {
        await this.app.vault.adapter.remove(cleanPath);
      }
      // 清理因删除文件而变空的父文件夹
      const parts = cleanPath.split('/');
      parts.pop();
      while (parts.length > 0) {
        const folderPath = parts.join('/');
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder) || folder.children.length > 0) break;
        await this.app.vault.delete(folder);
        parts.pop();
      }
      this.fileHashes.delete(cleanPath);
      this.updateBaselineEntry(this.settings.vaultId, cleanPath, null);
      return true;
    } catch (err) {
      console.error('[Nimbus] 删除本地文件失败:', cleanPath, err);
      return false;
    } finally {
      this.applyingRemotePaths.delete(cleanPath);
      this.remoteApplyingCount = Math.max(0, (this.remoteApplyingCount || 1) - 1);
      this.isApplyingRemoteChange = (this.remoteApplyingCount > 0);
      releaseLocalLock();
    }
  }

  // --- Local File Changes ---
  async onLocalFileChange(type, file) {
    if (!this.isVaultReady || !(file instanceof TFile)) return;
    // 🛡️ 事件抑制按“正在写盘的具体路径”精确判定（R-3 收窄）：
    // 旧的全局 isApplyingRemoteChange 门会把远端写盘期间其他路径上的用户
    // 真实编辑事件一起吞掉，被吞的修改只能等下一次全量对账兜底。
    // 远端写盘路径在 acquireLocalFileLock 之后、任何 IO 之前加入
    // applyingRemotePaths，本路径自身的回声事件仍会被精确拦截。
    if (this.isPathApplyingRemote(file.path)) return;
    if (this.isIgnoredLocalPath(file.path)) return;
    if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(file.path);

    // 🛡️ 启动期下行优先屏障保护 (Pull-First Sync Barrier)
    // 在首轮与云端完成下行增量或清单对齐前，禁止向云端盲目外发本地文件
    if (this.syncBarrierActive) {
      if (this.pendingLocalQueueWhileBarrier) {
        this.pendingLocalQueueWhileBarrier.add(file.path);
      }
      return;
    }

    // 清除该文件之前的未执行防抖计时器
    if (this.localChangeQueue.has(file.path)) {
      clearTimeout(this.localChangeQueue.get(file.path));
    }

    // 新建文件立即或短延时推送，修改文件使用 400ms 防抖避免击穿 WebSocket 与产生多余历史版本
    const delay = type === 'create' ? 50 : 400;
    const timer = setTimeout(async () => {
      this.localChangeQueue.delete(file.path);
      // 与远端写盘串行化：避免「远端刚写入的版本」被「本端稍早的推送」覆盖
      await this.withLocalFileLock(file.path, () => this.pushLocalFile(file, { lockHeld: true }));
    }, delay);

    this.localChangeQueue.set(file.path, timer);
  }

  async onLocalFileDelete(file) {
    // 🛡️ R-3 收窄：不再用全局 isApplyingRemoteChange 吞掉远端写盘期间
    // 其他路径上的真实删除事件；本路径自身的删除回声由下方
    // isPathApplyingRemote 精确拦截（路径级判定在非屏障分支保持原样）。
    if (!this.isVaultReady || this.syncBarrierActive) {
      // 🛡️ 屏障期删除不能丢弃（旧实现直接 return）：记入挂起删除，屏障结束后补发。
      // 远端删除自身触发的回声事件按路径精确拦截（否则屏障期增量重放的
      // removed 会把刚应用完的删除再跑一遍挂起队列，多余但无害——这里直接省掉）。
      if (this.syncBarrierActive && file instanceof TFile
        && !this.isPathApplyingRemote(file.path) && !this.isIgnoredLocalPath(file.path)) {
        this.queuePendingLocalDelete(file.path);
      } else if (this.syncBarrierActive && file instanceof TFolder) {
        // 🛡️ 屏障期删除整个目录同样不能丢弃：目录已从本地消失，用 fileHashes
        // 推导目录下已知同步文件并逐个挂起补发；超大目录沿用文件夹级熔断阈值。
        const prefix = file.path ? `${file.path}/` : '';
        const matched = Array.from(this.fileHashes.keys())
          .filter((p) => p.startsWith(prefix) && !this.isIgnoredLocalPath(p));
        if (matched.length > 10 && matched.length >= Math.max(1, this.fileHashes.size * 0.4)) {
          console.warn(`[Nimbus 安全熔断] 屏障期拦截异常文件夹批量删除: ${file.path}, 涉及文件: ${matched.length}`);
          new Notice(`⚠️ [Nimbus 安全熔断] 屏障期检测到删除文件夹包含 ${matched.length} 篇笔记（超安全阈值），未同步云端删除，稍后将对账确认！`, 8000);
          return;
        }
        for (const knownPath of matched) {
          this.queuePendingLocalDelete(knownPath);
        }
      }
      return;
    }
    if (file instanceof TFile) {
      if (this.isPathApplyingRemote(file.path)) return;
      if (this.isIgnoredLocalPath(file.path)) return;
      if (this.localChangeQueue.has(file.path)) {
        clearTimeout(this.localChangeQueue.get(file.path));
        this.localChangeQueue.delete(file.path);
      }
      // 统一走 deleteRemoteFile：ack 确认后才抹基线；未确认/离线则自动挂起补发
      const deleted = await this.deleteRemoteFile(file.path);
      if (!deleted) {
        console.warn('[Nimbus] 云端删除指令未获确认，已挂起等待重试/3-Way 补发:', file.path);
      }
    } else if (file instanceof TFolder) {
      const folderPrefix = file.path ? `${file.path}/` : '';
      for (const [queuedPath, timer] of this.localChangeQueue.entries()) {
        if (queuedPath.startsWith(folderPrefix)) {
          clearTimeout(timer);
          this.localChangeQueue.delete(queuedPath);
        }
      }
      const matchedPaths = [];
      for (const knownPath of Array.from(this.fileHashes.keys())) {
        if (knownPath.startsWith(folderPrefix) && !this.isIgnoredLocalPath(knownPath)) {
          matchedPaths.push(knownPath);
        }
      }
      // 🛡️ 文件夹级批量删除安全熔断保护
      if (matchedPaths.length > 10 && matchedPaths.length >= Math.max(1, this.fileHashes.size * 0.4)) {
        console.warn(`[Nimbus 安全熔断] 拦截异常文件夹批量删除: ${file.path}, 涉及文件: ${matchedPaths.length}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 检测到删除文件夹包含 ${matchedPaths.length} 篇笔记（超安全阈值），已阻止向云端同步清空！`, 8000);
        return;
      }
      // 🛡️ 不再逐条 fire-and-forget 清基线（旧实现 WS 不在线时删除指令静默丢弃 + 基线被清 → 全部复活）。
      // 统一走挂起删除，与单文件删除同一条可靠通道。
      if (!this.pendingLocalDeletes) this.pendingLocalDeletes = new Set();
      for (const knownPath of matchedPaths) {
        this.queuePendingLocalDelete(knownPath);
        this.fileHashes.delete(knownPath);
      }
    }
  }

  async onLocalFileRename(file, oldPath) {
    // 🛡️ R-3 收窄：isApplyingRemoteChange 期间不再整体丢弃真实重命名；
    // 改用按路径记录挂起重命名（远端应用代码从不产生 rename 事件，
    // 这里是纯粹的用户操作），补发路径见 flushPendingLocalRenames。
    if (!this.isVaultReady || this.syncBarrierActive) {
      // 🛡️ 屏障期/远端应用期的重命名不能丢弃（旧实现直接 return）：改名后的文件
      // 既不在 pendingLocalQueue、也不在 pendingLocalDeletes 里，只能等下一次
      // 全量 3-Way 才会被人发现（若日常一直是 delta-only 连接则可能长期不上传）。
      // 记录 (旧→新) 待屏障收尾补发；同一链条的连续改名自动折叠为首尾映射。
      if (file instanceof TFile && !this.isPathApplyingRemote(file.path) && !this.isPathApplyingRemote(oldPath)) {
        this.queuePendingLocalRename(oldPath, file.path);
      } else if (file instanceof TFolder && this.syncBarrierActive) {
        const oldPrefix = oldPath ? `${oldPath}/` : '';
        const newPrefix = file.path ? `${file.path}/` : '';
        const allFiles = (this.app && this.app.vault && typeof this.app.vault.getFiles === 'function')
          ? this.app.vault.getFiles()
          : [];
        for (const f of allFiles) {
          if (f && f.path && f.path.startsWith(newPrefix) && !this.isIgnoredLocalPath(f.path)) {
            const relativePart = f.path.substring(newPrefix.length);
            this.queuePendingLocalRename(oldPrefix + relativePart, f.path);
          }
        }
      }
      return;
    }
    if (file instanceof TFile) {
      if (this.isPathApplyingRemote(file.path) || this.isPathApplyingRemote(oldPath)) return;
      if (this.isIgnoredLocalPath(file.path) && this.isIgnoredLocalPath(oldPath)) return;
      if (this.localChangeQueue.has(oldPath)) {
        clearTimeout(this.localChangeQueue.get(oldPath));
        this.localChangeQueue.delete(oldPath);
      }
      this._markPathDeletedOrMoved(oldPath);
      if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(file.path);
      // 优先让服务端做真正的 move/rename（保留云端历史版本）；不支持时内部自动回退 delete + push
      await this.renameRemoteFile(oldPath, file);
    } else if (file instanceof TFolder) {
      // 文件夹重命名：同步重命名并推送该目录下所有子文件
      const oldPrefix = oldPath ? `${oldPath}/` : '';
      const newPrefix = file.path ? `${file.path}/` : '';
      for (const [queuedPath, timer] of this.localChangeQueue.entries()) {
        if (queuedPath.startsWith(oldPrefix)) {
          clearTimeout(timer);
          this.localChangeQueue.delete(queuedPath);
        }
      }
      const allFiles = this.app.vault.getFiles();
      for (const f of allFiles) {
        if (f.path.startsWith(newPrefix)) {
          const relativePart = f.path.substring(newPrefix.length);
          const oldFilePath = oldPrefix + relativePart;
          if (this.isIgnoredLocalPath(f.path) && this.isIgnoredLocalPath(oldFilePath)) continue;
          this._markPathDeletedOrMoved(oldFilePath);
          if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(f.path);
          // 优先走服务端原子 rename（保留云端历史版本与冲突安全保护）；不支持或失败时内部自动回退 delete + push
          await this.renameRemoteFile(oldFilePath, f);
        }
      }
    }
  }

  async pushLocalFile(file, options = {}) {
    if (this.isIgnoredLocalPath(file.path)) return true;
    if (this.isPathApplyingRemote(file.path)) return true;
    if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(file.path);
    try {
      const buffer = await this.app.vault.readBinary(file);
      const baseMeta = this.getBaselineEntry(this.settings.vaultId, file.path);
      const baseHash = (baseMeta && baseMeta.hash) || this.fileHashes.get(file.path) || null;
      const currentHash = await computeSha256(buffer);

      // 🛡️ 内容无变化前置拦截：若内容与缓存哈希完全一致，跳过冗余的网络序列化与上传
      if (currentHash && this.fileHashes.get(file.path) === currentHash) {
        return true;
      }
      const MAX_WS_INLINE = 2 * 1024 * 1024; // 2MB

      // If file exceeds 2MB, stream via HTTP PUT to avoid WebSocket buffer memory pressure
      if (buffer.byteLength > MAX_WS_INLINE && this.settings.serverUrl && this.settings.vaultId && this.settings.token) {
        const serverUrl = this.getCleanServerUrl();
        const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
        const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
        const headers = this.buildAuthHeaders({
          'Content-Type': 'application/octet-stream',
          ...(baseHash ? { 'x-base-hash': String(baseHash) } : {}),
          ...((file.stat && file.stat.mtime) ? { 'x-mtime': String(file.stat.mtime) } : {})
        });

        const res = await fetch(url, {
          method: 'PUT',
          headers,
          body: buffer,
        });

        if (res.ok) {
          const body = await res.json();
          if (body && body.ignored) {
            // 🛡️ 服务端同步规则黑名单明确排除了该文件：
            // 标记基线为 ignored=true（本地保留、不参与云端删除判定、不再重复推送），
            // 绝不能用本地 hash 伪造“云端已存在”的基线（那会在 3-Way 场景 2 中被误判为“云端已删”而删除本地文件）
            this.fileHashes.set(file.path, currentHash);
            this.updateBaselineEntry(this.settings.vaultId, file.path, {
              hash: currentHash,
              mtime: file.stat ? file.stat.mtime : Date.now(),
              size: buffer.byteLength,
              ignored: true
            });
            console.warn(`[Nimbus] 服务端同步规则已忽略该文件，已标记为本地保留（不参与 3-Way 删除判定）:`, file.path);
            return true;
          }
          // 🛡️ 冲突协议（HTTP 通道版，与 WS 通道 case 'conflict' 同语义，严禁与黑名单混淆）：
          // - body.conflict：baseHash 漂移，服务端已把本端推送内容存为 .conflict-* 副本
          //   （副本已由服务端广播给其他设备，本端不需要再拉取副本）；
          // - body.serverWin：服务端按 server_win 策略保留云端胜出版本、拒绝本端推送。
          // 旧实现把 written===false 的一切响应都折叠进黑名单分支并伪造
          // 「hash=本地内容且 ignored=true」的基线——本地并发编辑从此与云端形成
          // 对齐假象，下一次 3-Way 判定 lastKnown==localHash 时会**无备份直接覆盖**
          // 本地版本（R-1 防护被基线假象完全绕过）。
          // 正确做法：对主路径触发受保护拉取（applyRemoteBinaryChange 的
          // R-1 覆盖防护会先把本地未同步内容备份为 .conflict-offline-* 副本再覆盖）。
          if (body && (body.serverWin || body.conflict)) {
            console.warn(`[Nimbus] HTTP 推送遇并发冲突，按受保护拉取收敛:`, file.path);
            new Notice('⚠️ 检测到并发冲突：云端版本已拉取，本地修改已自动备份', 6000);
            const pulled = await this.pullRemoteFileViaHttp(file.path, body.mtime, body.currentHash, {
              skipLock: Boolean(options && options.lockHeld),
              forcePull: true,
            });
            if (!pulled) {
              // 拉取失败：不伪造基线，挂起该路径等待下一轮（拉取成功前基线保持诚实，
              // 3-Way 会把本地内容当作待对账修改继续保护）
              this.queuePendingLocalPush(file.path);
              return false;
            }
            return true;
          }
          const returnedHash = body && (body.currentHash || body.hash || currentHash);
          if (returnedHash) {
            this.fileHashes.set(file.path, returnedHash);
            this.updateBaselineEntry(this.settings.vaultId, file.path, {
              hash: returnedHash,
              mtime: file.stat ? file.stat.mtime : Date.now(),
              size: buffer.byteLength
            });
          }
          return true;
        } else {
          // 🛡️ 终态失败（超出服务端 maxUploadSizeMb / 令牌或写权限无效）：
          // 进补推队列只会形成「每次重连 → 重试 → 必败」的循环，这里返回 false 但不挂起。
          // 临时性失败（5xx/429/网络错误/delta 持久化 400）维持原挂起重试语义。
          if (res.status === 413 || res.status === 401 || res.status === 403) {
            console.warn(`[Nimbus] 大文件 HTTP PUT 终态失败 (HTTP ${res.status})，忽略该文件的重试循环:`, file.path);
          } else {
            console.warn(`[Nimbus] 大文件 HTTP PUT 推送失败 (${res.status}):`, file.path);
            this.queuePendingLocalPush(file.path);
          }
          return false;
        }
      }

      const base64 = arrayBufferToBase64(buffer);
      const result = await this.sendWsMessageAndWait({
        type: 'push',
        path: file.path,
        content: base64,
        mtime: file.stat ? file.stat.mtime : Date.now(),
        baseHash: baseHash || undefined,
      });
      if (result && result.ignored) {
        // 🛡️ WS 推送命中服务端黑名单：与 HTTP ignored 分支同语义，标记基线避免误删与重复推送
        this.fileHashes.set(file.path, currentHash);
        this.updateBaselineEntry(this.settings.vaultId, file.path, {
          hash: currentHash,
          mtime: file.stat ? file.stat.mtime : Date.now(),
          size: buffer.byteLength,
          ignored: true
        });
        console.warn(`[Nimbus] 服务端同步规则已忽略该文件，已标记为本地保留:`, file.path);
      }
      if (result && result.conflict) {
        // 🛡️ 服务端已把本端内容存为云端冲突副本，'conflict' 通知的自动拉取会完成本地收敛。
        // 这里绝不能把本地文件登记为“云端主路径内容”（会伪造基线），
        // 也不进补推队列——否则重连后 flush 重推会重复制造冲突副本（冲突重影）。
        return true;
      }
      if (!result) {
        // 🛡️ WS 未连接 / 未获 ack：把路径放入重连后补推队列，避免离线编辑被静默丢弃
        this.queuePendingLocalPush(file.path);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Nimbus] 读取本地文件准备上传失败:', file.path, err);
      return false;
    }
  }

  async sendWsMessageAndWait(payload, timeoutMs = 15000) {
    if (!payload || !payload.path || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (!this.pendingSyncAcks) this.pendingSyncAcks = new Map();
    const key = `${payload.type}:${payload.path}`;
    const previous = this.pendingSyncAcks.get(key);
    if (previous) previous.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSyncAcks.delete(key);
        resolve(false);
      }, timeoutMs);
      this.pendingSyncAcks.set(key, {
        resolve: (ok, msg) => {
          clearTimeout(timer);
          this.pendingSyncAcks.delete(key);
          resolve(ok ? msg : false);
        }
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pendingSyncAcks.get(key)?.resolve(false);
      }
    });
  }

  sendWsMessage(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // --- Reliable outbound operations (offline-safe) ---
  /** 标记路径已被本地删除或移走，同时立即终止该路径在途的 push 等待，防止迟到 push ack 复活基线 */
  _markPathDeletedOrMoved(filePath) {
    const clean = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return;
    if (!this._deletedOrMovedPaths) this._deletedOrMovedPaths = new Set();
    this._deletedOrMovedPaths.add(clean);
    if (this.pendingSyncAcks && this.pendingSyncAcks.has(`push:${clean}`)) {
      this.pendingSyncAcks.get(`push:${clean}`)?.resolve(false);
    }
  }

  /** 记录「离线 / 未确认」的本地推送，重连后的屏障收尾阶段统一补推 */
  queuePendingLocalPush(filePath) {
    if (!filePath) return;
    if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(filePath);
    if (!this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier = new Set();
    this.pendingLocalQueueWhileBarrier.add(filePath);
  }

  /** 记录「离线 / 未确认」的云端删除，重连后由 flushPendingLocalDeletes 补发 */
  queuePendingLocalDelete(filePath) {
    if (!filePath) return;
    this._markPathDeletedOrMoved(filePath);
    if (!this.pendingLocalDeletes) this.pendingLocalDeletes = new Set();
    this.pendingLocalDeletes.add(filePath);
  }

  /**
   * 记录屏障期/远端应用期间发生的本地重命名（旧实现直接丢弃）：
   * 支持链式改名折叠（A -> B -> C 自动合并为 A -> C；A -> B -> A 抵消），
   * 并联动更新 pendingLocalQueueWhileBarrier 中的待推路径，屏障收尾由 flushPendingLocalRenames 补发。
   */
  queuePendingLocalRename(oldPath, newPath) {
    if (!this.pendingLocalRenames) this.pendingLocalRenames = new Map();
    const cleanOld = String(oldPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanNew = String(newPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return;
    this._markPathDeletedOrMoved(cleanOld);
    if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(cleanNew);

    if (this.pendingLocalQueueWhileBarrier && this.pendingLocalQueueWhileBarrier.has(cleanOld)) {
      this.pendingLocalQueueWhileBarrier.delete(cleanOld);
      this.pendingLocalQueueWhileBarrier.add(cleanNew);
    }

    let originOld = cleanOld;
    for (const [k, v] of this.pendingLocalRenames.entries()) {
      if (v === cleanOld) {
        originOld = k;
        this.pendingLocalRenames.delete(k);
        break;
      }
    }
    if (originOld === cleanNew) {
      return;
    }
    this.pendingLocalRenames.set(originOld, cleanNew);
  }

  /**
   * 删除云端文件。
   * - 实时（WS 可用且未要求 HTTP）：等待服务端 ack 确认后才抹除基线；未确认则挂起重试。
   * - 对账（preferHttp）或 WS 断连：走 HTTP DELETE，确保云端真正删除。
   * - 完全离线：只清内存 hash，**绝不提前抹除基线**（否则重连后 3-Way 会把已删文件复活）。
   */
  async deleteRemoteFile(filePath, options = {}) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || this.isIgnoredLocalPath(cleanPath)) return false;
    this._markPathDeletedOrMoved(cleanPath);
    const vaultId = this.settings.vaultId || 'default';
    const preferHttp = Boolean(options && options.preferHttp);
    const wsReady = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);

    if (!preferHttp && wsReady) {
      const ack = await this.sendWsMessageAndWait({ type: 'delete', path: cleanPath });
      if (ack) {
        this.fileHashes.delete(cleanPath);
        this.updateBaselineEntry(vaultId, cleanPath, null);
        return true;
      }
      this.queuePendingLocalDelete(cleanPath);
      this.fileHashes.delete(cleanPath);
      return false;
    }

    const serverUrl = this.getCleanServerUrl();
    const cleanToken = this.getCleanToken();
    if (serverUrl && vaultId && cleanToken) {
      try {
        const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
        const url = `${serverUrl}/api/vaults/${encodeURIComponent(vaultId)}/files/${encodedPath}`;
        const res = await fetch(url, {
          method: 'DELETE',
          headers: this.buildAuthHeaders(),
        });
        if (res.ok || res.status === 404) {
          try {
            const body = await res.json();
            if (body && typeof body.cursor === 'number' && body.cursor > this.getVaultCursor(vaultId)) {
              this.setVaultCursor(vaultId, body.cursor);
            }
          } catch {}
          this.fileHashes.delete(cleanPath);
          this.updateBaselineEntry(vaultId, cleanPath, null);
          return true;
        }
      } catch (err) {
        // 网络完全断开或请求不可达：继续走下方兜底
      }
    }

    if (wsReady) {
      const ack = await this.sendWsMessageAndWait({ type: 'delete', path: cleanPath });
      if (ack) {
        this.fileHashes.delete(cleanPath);
        this.updateBaselineEntry(vaultId, cleanPath, null);
        return true;
      }
    }

    // 🛡️ 彻底离线：仅移除内存哈希缓存，保留基线；重连后由挂起队列 / 3-Way 场景 3 补发删除
    this.queuePendingLocalDelete(cleanPath);
    this.fileHashes.delete(cleanPath);
    return false;
  }

  /**
   * 重命名/移动云端文件。
   * 优先走服务端 rename（保留云端历史版本）；服务端没有旧路径时（rename_fallback）或
   * WS 不可用、ack 未确认时，回退为 delete + push。
   */
  async renameRemoteFile(oldPath, newFile) {
    const cleanOld = String(oldPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanNew = newFile && newFile.path
      ? String(newFile.path).replace(/\\/g, '/').replace(/^\/+/, '')
      : '';
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return false;
    this._markPathDeletedOrMoved(cleanOld);
    if (this._deletedOrMovedPaths) this._deletedOrMovedPaths.delete(cleanNew);
    if (this.isIgnoredLocalPath(cleanNew)) {
      // 新路径命中云端忽略规则：等价于从云端移除旧路径
      await this.deleteRemoteFile(cleanOld);
      return true;
    }

    const wsReady = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
    if (wsReady) {
      const oldHash = this.fileHashes.get(cleanOld) || null;
      // path 字段与 newPath 一致，供 sendWsMessageAndWait 匹配 rename:<newPath> 的 ack
      const ack = await this.sendWsMessageAndWait({
        type: 'rename',
        oldPath: cleanOld,
        newPath: cleanNew,
        path: cleanNew,
      });
      if (ack) {
        this.fileHashes.delete(cleanOld);
        this.updateBaselineEntry(this.settings.vaultId, cleanOld, null);
        // 若云端目标路径已存在不同内容并触发冲突保护，由 case 'conflict' 自动拉取收敛，不将旧 hash 写进新路径基线
        if (ack.conflict) {
          return true;
        }
        // ack 携带 hash 时基线已由 handleServerMessage 的 ack 分支写入；这里只兜底 hash 缺失场景
        if (!ack.hash && oldHash) {
          this.fileHashes.set(cleanNew, oldHash);
          this.updateBaselineEntry(this.settings.vaultId, cleanNew, {
            hash: oldHash,
            mtime: (newFile.stat && newFile.stat.mtime) || Date.now(),
            size: (newFile.stat && newFile.stat.size) || 0,
          });
        }
        return true;
      }
      console.warn('[Nimbus] 云端重命名未获确认，回退为 delete + push:', cleanOld, '->', cleanNew);
    }

    await this.deleteRemoteFile(cleanOld, { preferHttp: true });
    this.fileHashes.delete(cleanNew);
    return this.pushLocalFile(newFile);
  }

  /**
   * 显式「离线变更对账」入口（命令面板可手动触发，也可在重连后由上层调用）。
   *
   * 本分支的 3-Way（syncManifest）已内建 main 侧三项安全熔断：
   *   1) 本地空库保护：本地 0 文件 + 云端有文件 → 重置基线并全量拉取（换机自愈）
   *   2) 云端批量删除熔断：> max(5, 云端总数 × 35%)
   *   3) 批量推送熔断：> max(15, 云端总数 × 40%)
   * 因此不再维护第二套删除判定（main 版曾出现「只清 hash 不清基线导致文件复活」的分叉），
   * 统一走：补推离线编辑 → 补发挂起删除 → 全量 3-Way 校验。
   */
  async reconcileLocalOfflineChanges() {
    if (!this.isVaultReady) return false;
    if (!this.settings.vaultId || !this.settings.token) {
      new Notice('❌ 请先在 Nimbus 设置中完成登录并绑定 Vault');
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
      await new Promise((r) => setTimeout(r, 800));
    }
    await this.flushPendingLocalChangesAfterBarrier();
    await this.flushPendingLocalDeletes();
    await this.fullSyncAllFiles();
    return true;
  }

  async manualSync() {
    this.updateStatusBar('syncing');
    if (!this.settings.token) {
      const ok = await this.login();
      if (!ok) return;
    }
    this.connectWebSocket();
    new Notice('☁️ 正在触发 Nimbus 同步...');
  }
};

// --- Settings UI ---
class NimbusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '☁️ Nimbus 同步插件设置' });
    containerEl.createEl('p', { text: '连接您的私有 Nimbus 服务端，实现多设备极速双向无缝同步。', cls: 'setting-item-description' });

    // ⚡ Quick Import from Clipboard (DeepLink / data.json / JSON)
    new Setting(containerEl)
      .setName('⚡ 快速导入与扫码直连')
      .setDesc('一键从系统剪贴板导入网页端复制的 DeepLink 直连链接或 JSON 配置')
      .addButton(btn => btn
        .setButtonText('📋 从剪贴板一键导入')
        .setCta()
        .onClick(async () => {
          try {
            let clipboardText = '';
            if (navigator.clipboard && navigator.clipboard.readText) {
              clipboardText = await navigator.clipboard.readText();
            } else {
              new Notice('❌ 浏览器安全限制，无法直接读取剪贴板，请在下方手动填入');
              return;
            }

            clipboardText = (clipboardText || '').trim();
            if (!clipboardText) {
              new Notice('⚠️ 剪贴板为空，请先在 Nimbus 网页端点击「复制 DeepLink」或「复制配置」');
              return;
            }

            // Case A: obsidian://nimbus-sync?... URI
            if (clipboardText.startsWith('obsidian://nimbus-sync')) {
              const url = new URL(clipboardText);
              const params = url.searchParams;
              const server = params.get('server') || params.get('serverUrl');
              const token = params.get('token') || params.get('authToken');
              const vaultId = params.get('vaultId');
              const vaultName = params.get('vaultName');
              const device = params.get('device') || params.get('deviceId');

              if (server) this.plugin.settings.serverUrl = server.replace(/\/+$/, '');
              if (token) {
                this.plugin.settings.token = token.trim().replace(/^Bearer\s+/i, '');
                this.plugin.settings.authToken = this.plugin.settings.token;
              }
              if (vaultId) this.plugin.settings.vaultId = vaultId;
              if (vaultName) this.plugin.settings.vaultName = vaultName;
              if (device) this.plugin.settings.deviceId = device;
              this.plugin.settings.authMode = 'token';

              await this.plugin.saveSettings();
              new Notice('✅ 成功从剪贴板导入 Nimbus DeepLink 直连配置！');
              await this.display();
              this.plugin.connectWebSocket();
              return;
            }

            // Case B: JSON format
            if (clipboardText.startsWith('{') && clipboardText.endsWith('}')) {
              const parsed = JSON.parse(clipboardText);
              if (parsed.serverUrl) this.plugin.settings.serverUrl = parsed.serverUrl.replace(/\/+$/, '');
              if (parsed.token || parsed.authToken) {
                const t = parsed.token || parsed.authToken;
                this.plugin.settings.token = t.trim().replace(/^Bearer\s+/i, '');
                this.plugin.settings.authToken = this.plugin.settings.token;
              }
              if (parsed.vaultId) this.plugin.settings.vaultId = parsed.vaultId;
              if (parsed.vaultName) this.plugin.settings.vaultName = parsed.vaultName;
              if (parsed.deviceId || parsed.deviceName) this.plugin.settings.deviceId = parsed.deviceId || parsed.deviceName;
              this.plugin.settings.authMode = 'token';

              await this.plugin.saveSettings();
              new Notice('✅ 成功从剪贴板导入 Nimbus JSON 配置！');
              await this.display();
              this.plugin.connectWebSocket();
              return;
            }

            new Notice('⚠️ 剪贴板内容不是有效的 Nimbus DeepLink 或 JSON 配置');
          } catch (e) {
            new Notice('❌ 导入失败: ' + e.message);
          }
        }));

    // 1. Auth Mode Switch
    new Setting(containerEl)
      .setName('🔑 认证模式 (Auth Method)')
      .setDesc('支持直接使用账号密码登录，或粘贴网页端生成的「设备专属令牌」')
      .addDropdown(dd => {
        dd.addOption('password', '账号密码登录 (默认)')
          .addOption('token', '设备专属令牌 (Token 免密)')
          .setValue(this.plugin.settings.authMode || 'password')
          .onChange(async (val) => {
            this.plugin.settings.authMode = val;
            await this.plugin.saveSettings();
            await this.display();
          });
      });

    // 2. Server URL
    new Setting(containerEl)
      .setName('服务器地址 (Server URL)')
      .setDesc('Nimbus 服务端完整访问地址 (例如 http://192.168.50.154:8787)')
      .addText(text => text
        .setPlaceholder('http://192.168.50.154:8787')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (val) => {
          this.plugin.settings.serverUrl = val;
          await this.plugin.saveSettings();
        }));

    const currentAuthMode = this.plugin.settings.authMode || 'password';

    if (currentAuthMode === 'password') {
      // 3. Username
      new Setting(containerEl)
        .setName('用户名 (Username)')
        .setDesc('Nimbus 管理后台账号')
        .addText(text => text
          .setValue(this.plugin.settings.username)
          .onChange(async (val) => {
            this.plugin.settings.username = val;
            await this.plugin.saveSettings();
          }));

      // 4. Password
      new Setting(containerEl)
        .setName('密码 (Password)')
        .setDesc('Nimbus 账号登录密码')
        .addText(text => {
          text.inputEl.type = 'password';
          text.setValue(this.plugin.settings.password)
            .onChange(async (val) => {
              this.plugin.settings.password = val;
              await this.plugin.saveSettings();
            });
        });
    } else {
      // Token input mode
      new Setting(containerEl)
        .setName('设备专属令牌 (Device Access Token)')
        .setDesc('在 Nimbus 网页端 [设置] -> [设备专属令牌] 复制的 Token 字符串')
        .addText(text => {
          text.inputEl.type = 'password';
          text.setPlaceholder('粘贴 eyJhbGciOi... 令牌')
            .setValue(this.plugin.settings.token || this.plugin.settings.authToken || '')
            .onChange(async (val) => {
              const clean = val.trim().replace(/^Bearer\s+/i, '').trim();
              this.plugin.settings.token = clean;
              this.plugin.settings.authToken = clean;
              await this.plugin.saveSettings();
            });
        });
    }

    // 4. Device ID
    new Setting(containerEl)
      .setName('设备标识 (Device Name)')
      .setDesc('在 Nimbus 控制台管理时显示的设备名称')
      .addText(text => text
        .setValue(this.plugin.settings.deviceId)
        .onChange(async (val) => {
          this.plugin.settings.deviceId = val;
          await this.plugin.saveSettings();
        }));

    // 5. Auth Action Button
    if (currentAuthMode === 'password') {
      new Setting(containerEl)
        .setName('身份验证')
        .setDesc(this.plugin.settings.token ? '✅ 已获取登录凭证' : '尚未登录')
        .addButton(btn => btn
          .setButtonText(this.plugin.settings.token ? '重新登录' : '登录验证')
          .setCta()
          .onClick(async () => {
            const success = await this.plugin.login();
            if (success) {
              await this.display();
            }
          }));
    } else {
      new Setting(containerEl)
        .setName('令牌验证与连接')
        .setDesc(this.plugin.settings.token ? '✅ 已填入令牌' : '请先粘贴设备专属令牌')
        .addButton(btn => btn
          .setButtonText('测试并连接')
          .setCta()
          .onClick(async () => {
            if (!this.plugin.settings.token) {
              new Notice('❌ 请先粘贴设备专属令牌');
              return;
            }
            await this.plugin.autoMatchOrCreateVault();
            if (this.plugin.settings.vaultId) {
              this.plugin.connectWebSocket();
            }
            await this.display();
          }));
    }

    // 6. Local Vault Detection & Cloud Vault Selection
    if (this.plugin.settings.token) {
      const localVaultName = this.app.vault.getName() || 'DefaultVault';
      
      // Auto-ensure matching vault if not selected
      if (!this.plugin.settings.vaultId) {
        await this.plugin.autoMatchOrCreateVault();
      }

      const vaults = await this.plugin.fetchVaults();

      // Show local Vault notice
      new Setting(containerEl)
        .setName('📍 本地知识库 (Local Vault)')
        .setDesc(`当前检测到本地 Vault:「${localVaultName}」`)
        .addButton(btn => btn
          .setButtonText('🔄 自动重新匹配')
          .onClick(async () => {
            await this.plugin.autoMatchOrCreateVault();
            await this.display();
          }));

      // Cloud Vault selection
      const vaultSetting = new Setting(containerEl)
        .setName('☁️ 云端同步存储库 (Cloud Vault)')
        .setDesc('选择当前本地库绑定的云端存储库');

      if (vaults.length > 0) {
        vaultSetting.addDropdown(dd => {
          vaults.forEach(v => dd.addOption(v.id, v.name));
          dd.setValue(this.plugin.settings.vaultId || vaults[0].id);
          dd.onChange(async (val) => {
            this.plugin.settings.vaultId = val;
            const found = vaults.find(v => v.id === val);
            this.plugin.settings.vaultName = found ? found.name : '';
            await this.plugin.saveSettings();
            this.plugin.connectWebSocket();
          });
        });
      } else {
        vaultSetting.setDesc('当前账号下暂无 Vault，系统将自动创建');
      }

      // One-click Push All Notes
      new Setting(containerEl)
        .setName('🚀 立即全量双向同步')
        .setDesc('采用 3-Way 状态比对，自动双向同步、下载更新并精确清理已删除文件')
        .addButton(btn => btn
          .setButtonText('立即同步所有本地笔记')
          .setCta()
          .onClick(async () => {
            await this.plugin.fullSyncAllFiles();
          }));

      // Baseline management
      const currentVaultId = this.plugin.settings.vaultId || 'default';
      const baselineCount = Object.keys(this.plugin.getVaultBaseline(currentVaultId) || {}).length;
      new Setting(containerEl)
        .setName('📋 同步基线快照 (Sync Baseline)')
        .setDesc(`当前 Vault 已记录 ${baselineCount} 个文件的同步基线快照（用于识别跨端删除，防止已删文件复活）`)
        .addButton(btn => btn
          .setButtonText('重置基线快照')
          .onClick(async () => {
            if (!this.plugin.baselinesCache) {
              this.plugin.baselinesCache = {};
            }
            this.plugin.baselinesCache[currentVaultId] = {};
            if (this.plugin.settings.syncBaselines) {
              delete this.plugin.settings.syncBaselines[currentVaultId];
            }
            if (this.plugin.fileHashes) {
              this.plugin.fileHashes.clear();
            }
            this.plugin.setVaultCursor(currentVaultId, 0);
            await this.plugin.saveBaselineCache();
            await this.plugin.saveSettings();
            new Notice('✅ 已重置当前 Vault 的同步基线快照');
            await this.display();
          }));

      // Add Create Vault option
      new Setting(containerEl)
        .setName('新建云端 Vault')
        .setDesc('在服务器上手动创建一个新的笔记库')
        .addText(text => {
          text.setPlaceholder(`Vault 命名 (默认: ${localVaultName})`);
          text.setValue(localVaultName);
          this.newVaultInput = text;
        })
        .addButton(btn => btn
          .setButtonText('创建并绑定')
          .onClick(async () => {
            const name = this.newVaultInput.getValue().trim() || localVaultName;
            const created = await this.plugin.createVault(name);
            if (created) {
              this.plugin.settings.vaultId = created.id;
              this.plugin.settings.vaultName = created.name;
              await this.plugin.saveSettings();
              new Notice(`✅ 成功创建并绑定 Vault: ${created.name}`);
              await this.display();
              this.plugin.connectWebSocket();
            }
          }));
    }

    // 7. Auto sync toggle
    new Setting(containerEl)
      .setName('实时自动同步 (Real-time Auto Sync)')
      .setDesc('本地文件发生变动或服务端有新文件时自动同步')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (val) => {
          this.plugin.settings.autoSync = val;
          await this.plugin.saveSettings();
          if (val) {
            this.plugin.connectWebSocket();
          } else {
            this.plugin.disconnectWebSocket();
          }
        }));

    // 8. Sync Config Folder toggle
    new Setting(containerEl)
      .setName('同步 Obsidian 核心配置 (.obsidian 目录)')
      .setDesc('开启后同步主题与插件设置等配置。关闭时只专注同步笔记内容与多媒体附件，避免跨设备窗口与环境冲突（默认关闭推荐）')
      .addToggle(toggle => toggle
        .setValue(Boolean(this.plugin.settings.syncConfigFolder))
        .onChange(async (val) => {
          this.plugin.settings.syncConfigFolder = val;
          await this.plugin.saveSettings();
        }));
  }
}
