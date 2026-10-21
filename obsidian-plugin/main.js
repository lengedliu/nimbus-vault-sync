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
  deviceId: '',
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

    // Generate unique device ID if empty or still using legacy generic placeholder
    if (!this.settings.deviceId || this.settings.deviceId === 'Obsidian Device') {
      this.settings.deviceId = 'Obsidian-' + Math.random().toString(36).substring(2, 7);
      await this.saveSettings();
    }
    // Unique runtime session ID for accurate HTTP/WS echo suppression across multi-device setups
    this.clientId = 'client-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);

    this.localChangeQueue = new Map();
    this.isApplyingRemoteChange = false;
    this.remoteApplyingCount = 0;
    this.applyingRemotePaths = new Set();
    this.isVaultReady = false;
    this.syncBarrierActive = true; // 🛡️ 启动期下行优先屏障保护 (Pull-First Sync Barrier)
    this.pendingLocalQueueWhileBarrier = new Set();
    this.pendingLocalDeletesWhileBarrier = new Set();
    this.pendingPushes = new Map();
    this.remoteIgnorePatterns = [];
    this.fileHashes = new Map();
    this.fileLocks = new Map();
    this._wsMessageChain = Promise.resolve();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.barrierSafetyTimer = null;
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
    if (this.barrierSafetyTimer) clearTimeout(this.barrierSafetyTimer);
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
    if (this._saveSettingsTimer) {
      clearTimeout(this._saveSettingsTimer);
    }
    this._saveSettingsTimer = setTimeout(async () => {
      this._saveSettingsTimer = null;
      await this.saveSettings();
    }, 400);
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
    if (this._saveBaselineTimer) {
      clearTimeout(this._saveBaselineTimer);
    }
    this._saveBaselineTimer = setTimeout(async () => {
      this._saveBaselineTimer = null;
      await this.saveBaselineCache();
    }, 400);
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
      this.baselinesCache[vaultId][filePath] = {
        hash: meta.hash,
        mtime: meta.mtime || Date.now(),
        size: meta.size || 0
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

  setRemoteIgnorePatterns(patterns) {
    if (Array.isArray(patterns)) {
      this.remoteIgnorePatterns = patterns.filter((p) => typeof p === 'string' && p.trim().length > 0);
    }
  }

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
    const regexStr =
      prefix +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*')
        .replace(/\?/g, '.') +
      '$';
    try {
      return new RegExp(regexStr, 'i').test(normPath);
    } catch {
      return normPath.toLowerCase().includes(normPat.toLowerCase());
    }
  }

  isIgnoredLocalPath(filePath) {
    if (!filePath) return true;
    const clean = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');

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

    // 对齐服务端自定义忽略规则 (syncRules.ignorePatterns)
    if (Array.isArray(this.remoteIgnorePatterns) && this.remoteIgnorePatterns.length > 0) {
      for (const pat of this.remoteIgnorePatterns) {
        if (this.matchIgnorePattern(clean, pat)) {
          return true;
        }
      }
    }

    return false;
  }

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

  isCriticalSyncFile(filePath) {
    if (!filePath) return false;
    const clean = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
    // 隐藏目录（如 .obsidian/）或隐藏文件视为辅助系统配置，非核心笔记资产
    if (clean.startsWith('.') || clean.includes('/.')) return false;
    return true;
  }

  async withLocalFileLock(filePath, fn) {
    const clean = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return fn();
    if (!this.fileLocks) this.fileLocks = new Map();
    const prev = this.fileLocks.get(clean) || Promise.resolve();
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    const chain = prev.then(() => next, () => next);
    this.fileLocks.set(clean, chain);
    try {
      await prev;
    } catch {}
    try {
      return await fn();
    } finally {
      release();
      if (this.fileLocks.get(clean) === chain) {
        this.fileLocks.delete(clean);
      }
    }
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
    if (this.clientId) {
      headers['x-client-id'] = String(this.clientId);
    }
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

    const cleanToken = this.getCleanToken();
    if (!cleanToken || !this.settings.vaultId) {
      this.syncBarrierActive = false;
      this.updateStatusBar('idle', '☁️ Nimbus: 未配置');
      return;
    }

    // 🛡️ 启动连接时激活下行优先屏障，直到服务端握手与初次对齐完成（含 15s 超时防死锁兜底）
    this.syncBarrierActive = true;
    if (this.barrierSafetyTimer) clearTimeout(this.barrierSafetyTimer);
    this.barrierSafetyTimer = setTimeout(() => {
      this.barrierSafetyTimer = null;
      if (this.syncBarrierActive) {
        this.flushPendingLocalChangesAfterBarrier().catch(() => {});
      }
    }, 15000);

    const baseUrl = this.getCleanServerUrl();
    const wsProto = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
    const host = baseUrl.replace(/^https?:\/\//i, '');
    const localCursor = this.getVaultCursor(this.settings.vaultId || 'default');
    const wsUrl = `${wsProto}//${host}/ws?token=${encodeURIComponent(cleanToken)}&vaultId=${encodeURIComponent(this.settings.vaultId)}&deviceId=${encodeURIComponent(this.settings.deviceId || 'Obsidian Device')}&clientId=${encodeURIComponent(this.clientId || '')}&cursor=${encodeURIComponent(localCursor)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
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

      this.ws.onmessage = (evt) => {
        this._wsMessageChain = (this._wsMessageChain || Promise.resolve())
          .then(async () => {
            try {
              const msg = JSON.parse(evt.data);
              await this.handleServerMessage(msg);
            } catch (err) {
              console.error('[Nimbus] 解析服务器消息异常:', err);
            }
          })
          .catch(() => {});
      };

      this.ws.onclose = (e) => {
        this.syncBarrierActive = false;
        if (this.pendingPushes) {
          this.pendingPushes.clear();
        }
        if (this.barrierSafetyTimer) {
          clearTimeout(this.barrierSafetyTimer);
          this.barrierSafetyTimer = null;
        }
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

      this.ws.onerror = (err) => {
        console.error('[Nimbus] WebSocket 错误:', err);
        this.updateStatusBar('error');
      };
    } catch (err) {
      this.syncBarrierActive = false;
      console.error('[Nimbus] 连接初始化失败:', err);
      this.updateStatusBar('error');
    }
  }

  disconnectWebSocket() {
    this.syncBarrierActive = false;
    if (this.pendingPushes) {
      this.pendingPushes.clear();
    }
    if (this.barrierSafetyTimer) {
      clearTimeout(this.barrierSafetyTimer);
      this.barrierSafetyTimer = null;
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
        if (Array.isArray(msg.ignorePatterns)) {
          this.setRemoteIgnorePatterns(msg.ignorePatterns);
        }
        const serverCursor = typeof msg.cursor === 'number' ? msg.cursor : 0;
        const vaultId = this.settings.vaultId || 'default';
        const localCursor = this.getVaultCursor(vaultId);
        const localNonIgnoredCount = this.app.vault.getFiles().filter((f) => !this.isIgnoredLocalPath(f.path)).length;

        // 🛡️ 防御：仅当本地存在非忽略文件 (localNonIgnoredCount > 0) 时才启用游标增量快车道。
        // 若本地为 0 个文件但存在残留游标（如清空本地目录重建或换机残留配置），强制走下方 syncManifest 触发空库自愈全量拉取！
        if (localNonIgnoredCount > 0 && localCursor > 0 && serverCursor > localCursor) {
          const deltaOk = await this.syncDeltaChanges(localCursor);
          if (deltaOk) {
            await this.reconcileLocalOfflineChanges();
            await this.flushPendingLocalChangesAfterBarrier();
            break;
          }
          console.warn('[Nimbus] 增量追更未能完成全部项，自动降级为全量 3-Way 双向清单比对兜底');
        } else if (localNonIgnoredCount > 0 && localCursor > 0 && serverCursor === localCursor) {
          // 游标完全吻合，进一步扫描本地离线期间可能发生的快速修改或新增，秒级对齐完成
          await this.reconcileLocalOfflineChanges();
          await this.flushPendingLocalChangesAfterBarrier();
          new Notice('✅ 本地已与 Nimbus 云端完全对齐');
          break;
        }

        // 首次同步、本地空库自愈、游标断层或增量未完全对齐时，执行 3-Way 双向对比兜底
        let manifest = msg.manifest;
        if (!manifest || Object.keys(manifest).length === 0) {
          manifest = await this.fetchManifestHttp(vaultId);
        }
        await this.syncManifest(manifest || {}, serverCursor);
        await this.flushPendingLocalChangesAfterBarrier();
        break;
      }

      case 'rules_updated':
        if (Array.isArray(msg.ignorePatterns)) {
          this.setRemoteIgnorePatterns(msg.ignorePatterns);
        }
        break;

      case 'change':
        // A file was created/updated remotely
        if (typeof msg.cursor === 'number') {
          this.setVaultCursor(this.settings.vaultId, msg.cursor);
        }
        if (msg.path && this.isIgnoredLocalPath(msg.path)) {
          return;
        }
        if (msg.path && msg.hash && this.fileHashes.get(msg.path) === msg.hash) {
          // 本地已是目标相同哈希版本（如本设备自产生上传或已同步），无需重复拉取，拦截自反回声
          return;
        }
        if (msg.pullRequired || !msg.content) {
          await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        } else {
          await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        }
        break;

      case 'batch_file_change':
      case 'batch_change':
        if (typeof msg.cursor === 'number') {
          this.setVaultCursor(this.settings.vaultId, msg.cursor);
        }
        // Handle coalesced or server batch change notifications
        if (msg.pullRequired) {
          await this.fullSyncAllFiles();
        } else if (Array.isArray(msg.changes)) {
          for (const item of msg.changes) {
            if (!item || !item.path) continue;
            if (this.isIgnoredLocalPath(item.path)) continue;
            if (item.action === 'delete') {
              await this.applyRemoteDelete(item.path);
            } else {
              const localHash = this.fileHashes.get(item.path);
              if (item.hash && localHash === item.hash) {
                continue;
              }
              if (item.size && item.size > 2 * 1024 * 1024) {
                await this.pullRemoteFileViaHttp(item.path, item.mtime, item.hash);
              } else {
                this.sendWsMessage({ type: 'pull', path: item.path });
              }
            }
          }
        }
        break;

      case 'pull_stream':
        // Server directed large file pull via streaming HTTP
        if (msg.path && this.isIgnoredLocalPath(msg.path)) {
          return;
        }
        await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        break;

      case 'deleted':
        // A file was deleted remotely
        if (typeof msg.cursor === 'number') {
          this.setVaultCursor(this.settings.vaultId, msg.cursor);
        }
        if (msg.path && this.isIgnoredLocalPath(msg.path)) {
          return;
        }
        await this.applyRemoteDelete(msg.path);
        break;

      case 'conflict': {
        if (msg.path && this.pendingPushes) {
          this.pendingPushes.delete(msg.path);
        }
        if (msg.serverWin) {
          new Notice(`⚠️ 检测到并发冲突 (云端版本较新优先)：正在备份本地改动并拉取云端最新版本: ${msg.path}`);
          if (msg.path) {
            const localFile = this.app.vault.getAbstractFileByPath(msg.path);
            if (localFile instanceof TFile) {
              await this.backupLocalConflictFile(localFile, msg.path);
            }
            this.fileHashes.delete(msg.path);
            await this.pullRemoteFileViaHttp(msg.path, undefined, msg.currentHash);
          }
        } else {
          new Notice(`⚠️ 检测到并发冲突！已自动创建云端分支副本: ${msg.conflictPath}`);
          // 1. 自动拉取云端新创建的分支副本保存至本地
          if (msg.conflictPath) {
            this.sendWsMessage({ type: 'pull', path: msg.conflictPath });
          }
          // 2. 自动清除本地旧哈希缓存并拉取云端主文件当前胜出版本同步至本地
          if (msg.path) {
            this.fileHashes.delete(msg.path);
            this.sendWsMessage({ type: 'pull', path: msg.path });
          }
        }
        break;
      }

      case 'permission_updated':
        new Notice(`ℹ️ ${msg.message || '您的笔记库权限已更新'}`);
        break;

      case 'file':
        // Response to pull
        if (msg.path && this.isIgnoredLocalPath(msg.path)) {
          return;
        }
        await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        break;

      case 'rename_fallback': {
        if (msg.oldPath) {
          this.fileHashes.delete(msg.oldPath);
          this.updateBaselineEntry(this.settings.vaultId, msg.oldPath, null);
        }
        if (msg.path && !this.isIgnoredLocalPath(msg.path)) {
          const targetFile = this.app.vault.getAbstractFileByPath(msg.path);
          if (targetFile instanceof TFile) {
            this.fileHashes.delete(msg.path);
            await this.pushLocalFile(targetFile);
          }
        }
        break;
      }

      case 'ack': {
        const pending = (msg.path && this.pendingPushes) ? this.pendingPushes.get(msg.path) : null;
        if (msg.path && this.pendingPushes) {
          this.pendingPushes.delete(msg.path);
        }
        if (typeof msg.cursor === 'number' && msg.cursor > 0) {
          this.setVaultCursor(this.settings.vaultId, msg.cursor);
        }
        if (msg.action === 'delete') {
          if (msg.path) {
            this.fileHashes.delete(msg.path);
            this.updateBaselineEntry(this.settings.vaultId, msg.path, null);
          }
          break;
        }
        if (msg.action === 'rename') {
          if (msg.oldPath) {
            this.fileHashes.delete(msg.oldPath);
            this.updateBaselineEntry(this.settings.vaultId, msg.oldPath, null);
          }
          if (msg.path && !msg.ignored && msg.hash) {
            const localFile = this.app.vault.getAbstractFileByPath(msg.path);
            const localMtime = (localFile && localFile.stat && localFile.stat.mtime)
              ? localFile.stat.mtime
              : (msg.mtime || Date.now());
            const localSize = (localFile && localFile.stat && localFile.stat.size !== undefined)
              ? localFile.stat.size
              : (msg.size || 0);
            this.fileHashes.set(msg.path, msg.hash);
            this.updateBaselineEntry(this.settings.vaultId, msg.path, {
              hash: msg.hash,
              mtime: localMtime,
              size: localSize,
            });
          }
          break;
        }
        if (msg.ignored && msg.path) {
          // 服务端忽略规则拦截：记录本地已知哈希避免全量同步重复上传
          if (pending && pending.hash) {
            this.fileHashes.set(msg.path, pending.hash);
          }
          break;
        }
        const confirmedHash = msg.hash || (pending && pending.hash);
        if (msg.path && confirmedHash) {
          const localFile = this.app.vault.getAbstractFileByPath(msg.path);
          const localMtime = (localFile && localFile.stat && localFile.stat.mtime)
            ? localFile.stat.mtime
            : ((pending && pending.mtime) || msg.mtime || Date.now());
          const localSize = (localFile && localFile.stat && localFile.stat.size !== undefined)
            ? localFile.stat.size
            : (msg.size !== undefined ? msg.size : (pending ? pending.size : 0));
          this.fileHashes.set(msg.path, confirmedHash);
          this.updateBaselineEntry(this.settings.vaultId, msg.path, {
            hash: confirmedHash,
            mtime: localMtime,
            size: localSize,
          });
        }
        break;
      }

      case 'pong':
        break;

      case 'auth_revoked':
        new Notice(`❌ 令牌凭据已撤销: ${msg.message || '请重新配置设备令牌'}`);
        this.updateStatusBar('error', '☁️ Nimbus: 令牌已撤销');
        this.disconnectWebSocket();
        break;

      case 'error':
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
      if (Array.isArray(data.ignorePatterns)) {
        this.setRemoteIgnorePatterns(data.ignorePatterns);
      }
      if (data.full || data.fullSyncRequired) {
        console.warn('[Nimbus] 服务端要求全量快照同步, 原因:', data.reason);
        await this.syncManifest(data.manifest || {}, data.cursor || 0);
        return true;
      }

      const updates = Array.isArray(data.updates) ? data.updates : [];
      const deletes = Array.isArray(data.deletes) ? data.deletes : [];
      const totalChanges = updates.length + deletes.length;

      if (totalChanges > 0) {
        new Notice(`⚡ 正在应用增量追更: 下载 ${updates.length} 篇，删除 ${deletes.length} 篇...`);
        // 1. 删除远程已删文件（保护本地离线新建或修改过的文件不被静默误删）
        for (const del of deletes) {
          if (del && del.path) {
            const cleanDelPath = String(del.path).replace(/\\/g, '/').replace(/^\/+/, '');
            if (this.isIgnoredLocalPath(cleanDelPath)) continue;
            const localFile = this.app.vault.getAbstractFileByPath(cleanDelPath);
            const baseMeta = this.getBaselineEntry(vaultId, cleanDelPath);
            if (localFile instanceof TFile) {
              const currentLocalHash = await this.computeFileHash(localFile);
              if (currentLocalHash && (!baseMeta || !baseMeta.hash || currentLocalHash !== baseMeta.hash)) {
                // 本地离线有未同步的新建或修改，保留本地版本并通过 HTTP 同步推送至云端
                await this.pushLocalFile(localFile, { preferHttp: true });
                continue;
              }
            }
            await this.applyRemoteDelete(cleanDelPath);
          }
        }
        // 2. 更新远程改动文件：严格使用 HTTP 并发流式拉取并等待落盘屏障 (Promise Barrier)，同时对本地离线改动做 3-Way 冲突备份
        let hasPullFailure = false;
        let hasCriticalFailure = false;
        const PULL_CONCURRENCY = 4;
        for (let i = 0; i < updates.length; i += PULL_CONCURRENCY) {
          const batch = updates.slice(i, i + PULL_CONCURRENCY);
          const results = await Promise.all(batch.map(async (item) => {
            if (!item || !item.path) return true;
            const cleanPath = String(item.path).replace(/\\/g, '/').replace(/^\/+/, '');
            if (this.isIgnoredLocalPath(cleanPath)) return true;
            const localFile = this.app.vault.getAbstractFileByPath(cleanPath);
            const baseMeta = this.getBaselineEntry(vaultId, cleanPath);

            if (localFile instanceof TFile) {
              const currentLocalHash = await this.computeFileHash(localFile);
              if (item.hash && currentLocalHash === item.hash) {
                this.fileHashes.set(cleanPath, item.hash);
                this.updateBaselineEntry(vaultId, cleanPath, {
                  hash: item.hash,
                  mtime: (localFile.stat && localFile.stat.mtime) ? localFile.stat.mtime : (item.mtime || Date.now()),
                  size: (localFile.stat && localFile.stat.size !== undefined) ? localFile.stat.size : (item.size || 0),
                });
                return true;
              }
              // 若本地文件相比基线也发生了离线修改（双端并发冲突），先将本地改动备份为离线分支副本再拉取云端新版本！
              if (
                currentLocalHash &&
                ((baseMeta && baseMeta.hash && currentLocalHash !== baseMeta.hash) ||
                  (!baseMeta && item.hash && currentLocalHash !== item.hash))
              ) {
                await this.backupLocalConflictFile(localFile, cleanPath);
                this.fileHashes.delete(cleanPath);
              }
            } else {
              const localHash = this.fileHashes.get(cleanPath);
              const fileExists = this.app.vault.adapter && await this.app.vault.adapter.exists(cleanPath);
              if (item.hash && fileExists && localHash === item.hash) {
                return true;
              }
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
        this.setVaultCursor(vaultId, nextCursor);
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

  async reconcileLocalOfflineChanges() {
    try {
      const vaultId = this.settings.vaultId || 'default';
      const baseline = this.getVaultBaseline(vaultId);
      const baselineCount = Object.keys(baseline).length;
      const files = this.app.vault.getFiles();
      const localFileMap = new Map();
      const toPush = [];

      for (const f of files) {
        if (this.isIgnoredLocalPath(f.path)) continue;
        localFileMap.set(f.path, f);
      }

      // 🛡️ 空库保护：若本地有效文件为 0 但存在历史基线，绝不可作为离线删除清空云端，立即转入全量 3-Way 自愈拉取
      if (localFileMap.size === 0 && baselineCount > 0) {
        console.warn('[Nimbus] reconcileLocalOfflineChanges 检测到本地有效文件为 0 但存在历史基线，转入全量 3-Way 自愈同步');
        await this.fullSyncAllFiles();
        return;
      }

      for (const f of localFileMap.values()) {
        const baseMeta = baseline[f.path];
        if (!baseMeta || !baseMeta.hash) {
          toPush.push(f);
          continue;
        }
        // 快速路径：若文件大小和本地修改时间戳均未变化，零磁盘 I/O 直接复用基线哈希
        if (f.stat && f.stat.size === baseMeta.size && f.stat.mtime === baseMeta.mtime) {
          this.fileHashes.set(f.path, baseMeta.hash);
          continue;
        }
        // 大小或 mtime 变化时计算真实 SHA-256 比对基线
        const currentHash = await this.computeFileHash(f);
        if (currentHash && currentHash !== baseMeta.hash) {
          toPush.push(f);
        } else if (currentHash) {
          this.fileHashes.set(f.path, currentHash);
          this.updateBaselineEntry(vaultId, f.path, {
            hash: currentHash,
            mtime: f.stat?.mtime || baseMeta.mtime,
            size: f.stat?.size ?? baseMeta.size,
          });
        }
      }

      // 检测离线期间在本地被删除的文件
      const toRemoteDelete = [];
      for (const basePath of Object.keys(baseline)) {
        if (this.isIgnoredLocalPath(basePath)) continue;
        if (!localFileMap.has(basePath)) {
          toRemoteDelete.push(basePath);
        }
      }

      const delThreshold = Math.max(5, Math.floor(baselineCount * 0.35));
      if (toRemoteDelete.length > delThreshold) {
        console.error(`[Nimbus 安全熔断] 离线对账拦截异常大批量云端删除！尝试删除: ${toRemoteDelete.length} 篇，基线总数: ${baselineCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 拦截到离线期间单次尝试删除 ${toRemoteDelete.length} 篇云端笔记（超安全阈值）！\n已自动暂停云端删除以防数据丢失。`, 10000);
      } else if (toRemoteDelete.length > 0) {
        for (const delPath of toRemoteDelete) {
          await this.deleteRemoteFile(delPath, { preferHttp: true });
        }
      }

      let modifiedExistingCount = 0;
      for (const f of toPush) {
        if (baseline[f.path] && baseline[f.path].hash) {
          modifiedExistingCount++;
        }
      }
      const pushThreshold = Math.max(15, Math.floor(baselineCount * 0.4));
      if (baselineCount > 0 && modifiedExistingCount > pushThreshold) {
        console.warn(`[Nimbus 安全熔断] 离线对账拦截异常大批量修改推送: 尝试覆写 ${modifiedExistingCount} 篇，基线总数: ${baselineCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 检测到离线对账尝试单次向云端覆写 ${modifiedExistingCount} 篇已有笔记（超过安全阈值）！\n已自动暂停大批量推送以防意外覆盖云端。`, 10000);
      } else if (toPush.length > 0) {
        const PUSH_CONCURRENCY = 4;
        for (let i = 0; i < toPush.length; i += PUSH_CONCURRENCY) {
          const batch = toPush.slice(i, i + PUSH_CONCURRENCY);
          await Promise.all(batch.map((f) => this.pushLocalFile(f, { preferHttp: true })));
        }
      }
    } catch (err) {
      console.warn('[Nimbus] 扫描本地离线变更异常:', err);
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
      if (Array.isArray(data.ignorePatterns)) {
        this.setRemoteIgnorePatterns(data.ignorePatterns);
      }
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

  async syncManifest(remoteManifest, remoteCursor = 0, options = {}) {
    const isManual = Boolean(options && options.manual);
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
        if (typeof remoteCursor === 'number' && remoteCursor >= 0) {
          this.setVaultCursor(vaultId, remoteCursor);
        }

        const toPull = remoteEntries.map(([p, meta]) => ({ path: p, meta }));
        const PULL_CONCURRENCY = 6;
        for (let i = 0; i < toPull.length; i += PULL_CONCURRENCY) {
          const batch = toPull.slice(i, i + PULL_CONCURRENCY);
          await Promise.all(batch.map((item) => this.pullRemoteFileViaHttp(item.path, item.meta?.mtime, item.meta?.hash)));
          if (i + PULL_CONCURRENCY < toPull.length) {
            await new Promise((r) => setTimeout(r, 40));
          }
        }
        await this.saveBaselineCache();
        await this.saveSettings();
        return;
      }

      const allPaths = new Set([
        ...localFileMap.keys(),
        ...Object.keys(remoteManifest || {}),
        ...Object.keys(baseline)
      ]);

      const toPull = [];
      const toPush = [];
      const toLocalDelete = [];
      const toRemoteDelete = [];
      const toLocalConflictBackup = [];

      // 3-Way 对比分析：Local (本地当前) vs Remote (云端当前) vs Base (上次同步基线)
      for (const path of allPaths) {
        if (this.isIgnoredLocalPath(path)) continue;

        const localFile = localFileMap.get(path);
        const remoteMeta = remoteManifest ? remoteManifest[path] : null;
        const baseMeta = baseline[path];

        if (localFile && remoteMeta && baseMeta) {
          // 场景 1: 三方均存在
          const localHash = await this.computeFileHash(localFile);
          if (localHash === remoteMeta.hash) {
            // 内容一致，更新内存与基线（保存本地 TFile.stat.mtime 以确保离线对账快速路径命中）
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = {
              hash: remoteMeta.hash,
              mtime: (localFile.stat && localFile.stat.mtime) ? localFile.stat.mtime : remoteMeta.mtime,
              size: (localFile.stat && localFile.stat.size !== undefined) ? localFile.stat.size : remoteMeta.size
            };
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
          // 场景 2: 本地存在，基线存在，但云端已不存在 (例如 PC 端删除了云端文件)
          const localHash = await this.computeFileHash(localFile);
          const localChanged = (localHash !== baseMeta.hash);
          if (!localChanged) {
            // 本地未修改过 -> 遵从云端删除指令，删除本地文件，避免复活云端！
            toLocalDelete.push(path);
            delete baseline[path];
            this.fileHashes.delete(path);
          } else {
            // 本地离线有新编辑 -> 保留本地修改，作为新文件重新推送
            this.fileHashes.set(path, localHash);
            toPush.push(localFile);
          }
        } else if (!localFile && remoteMeta && baseMeta) {
          // 场景 3: 云端存在，基线存在，但本地已不存在 (例如本端离线时删除了该笔记)
          const remoteChanged = (remoteMeta.hash !== baseMeta.hash);
          if (!remoteChanged) {
            // 云端未被其他设备修改 -> 遵从本地删除，向云端发送删除指令
            toRemoteDelete.push(path);
          } else {
            // 云端被其他设备更新了 -> 保留云端新内容，拉取到本地
            toPull.push({ path, meta: remoteMeta });
          }
        } else if (localFile && !remoteMeta && !baseMeta) {
          // 场景 4: 本地纯新增文件 (无基线，云端无) -> 推送
          const localHash = await this.computeFileHash(localFile);
          if (localHash) {
            this.fileHashes.set(path, localHash);
          }
          toPush.push(localFile);
        } else if (!localFile && remoteMeta && !baseMeta) {
          // 场景 5: 云端纯新增文件 (无基线，本地无) -> 拉取
          toPull.push({ path, meta: remoteMeta });
        } else if (localFile && remoteMeta && !baseMeta) {
          // 场景 6: 两端均存在但无历史基线 (首次绑定/基线重置/长期离线基线断层)
          const localHash = await this.computeFileHash(localFile);
          if (localHash && remoteMeta.hash && localHash === remoteMeta.hash) {
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = {
              hash: remoteMeta.hash,
              mtime: (localFile.stat && localFile.stat.mtime) ? localFile.stat.mtime : remoteMeta.mtime,
              size: (localFile.stat && localFile.stat.size !== undefined) ? localFile.stat.size : remoteMeta.size
            };
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
      let circuitBreakerTriggered = false;
      const unconfirmedRemoteDeletes = new Set();
      const remoteDelThreshold = Math.max(5, Math.floor(remoteCount * 0.35));
      if (toRemoteDelete.length > remoteDelThreshold) {
        circuitBreakerTriggered = true;
        console.error(`[Nimbus 安全熔断] 拦截异常大批量云端删除！尝试删除: ${toRemoteDelete.length} 篇，云端总数: ${remoteCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 拦截到单次尝试删除 ${toRemoteDelete.length} 篇云端笔记！\n已自动暂停云端删除以防意外清空。若确需批量删除，请在控制台操作。`, 10000);
        for (const p of toRemoteDelete) {
          unconfirmedRemoteDeletes.add(p);
        }
        toRemoteDelete.length = 0; // 清空删除任务并保留基线记录，防止下次被误判为云端新增文件而复活
      }

      const localDelThreshold = Math.max(5, Math.floor(localCount * 0.35));
      if (toLocalDelete.length > localDelThreshold) {
        circuitBreakerTriggered = true;
        console.error(`[Nimbus 安全熔断] 拦截异常大批量本地删除！尝试删除: ${toLocalDelete.length} 篇，本地总数: ${localCount}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 拦截到单次尝试删除本地 ${toLocalDelete.length} 篇笔记！\n已自动暂停本地删除以防数据丢失。`, 10000);
        toLocalDelete.length = 0; // 清空本地删除任务
      }

      // =========================================================================
      // 🛡️ 防御机制 3: 异常大批量修改覆写安全熔断阀 (Safety Circuit Breaker for Overwrite Upload)
      // 仅统计对云端已有文件的修改覆写数量（纯本地新增文件 !remoteMeta 不存在覆盖云端风险，无条件放行）；
      // 若用户手动点击「立即全量双向同步」(isManual === true)，则遵从用户显式操作放行上传。
      // =========================================================================
      const remoteCountVal = remoteCount || 0;
      const overwritePushCount = toPush.filter((f) => Boolean(remoteManifest && remoteManifest[f.path])).length;
      const pushThreshold = Math.max(15, Math.floor(remoteCountVal * 0.4));
      if (!isManual && remoteCountVal > 0 && overwritePushCount > pushThreshold) {
        circuitBreakerTriggered = true;
        console.warn(`[Nimbus 安全熔断] 拦截异常大批量修改推送: 尝试覆写 ${overwritePushCount} 篇，云端总数: ${remoteCountVal}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 检测到当前设备尝试单次向云端覆写 ${overwritePushCount} 篇已有笔记（超过安全阈值）！\n已自动暂停大批量覆写以防意外冲毁云端较新笔记。若确认无误，请点击侧边栏「一键全量同步」放行。`, 12000);
        // 仅保留无覆盖风险的纯新增文件上传
        const safeNewFiles = toPush.filter((f) => !(remoteManifest && remoteManifest[f.path]));
        toPush.length = 0;
        toPush.push(...safeNewFiles);
      }

      const pullCount = toPull.length;
      const pushCount = toPush.length;
      const localDelCount = toLocalDelete.length;
      const remoteDelCount = toRemoteDelete.length;
      const conflictBackupCount = toLocalConflictBackup.length;

      if (pullCount === 0 && pushCount === 0 && localDelCount === 0 && remoteDelCount === 0 && conflictBackupCount === 0) {
        if (!this.baselinesCache) this.baselinesCache = {};
        this.baselinesCache[vaultId] = baseline;
        await this.saveBaselineCache();
        if (typeof remoteCursor === 'number' && remoteCursor >= 0 && !circuitBreakerTriggered) {
          this.setVaultCursor(vaultId, remoteCursor);
        }
        new Notice('✅ 本地笔记与 Nimbus 云端已保持一致 (3-Way 基线校验完成)');
        return;
      }

      new Notice(`⚡ 3-Way 同步开始: 上传 ${pushCount}，下载 ${pullCount}，本地删除 ${localDelCount}，云端删除 ${remoteDelCount}${conflictBackupCount > 0 ? `，冲突备份 ${conflictBackupCount}` : ''}`);

      // 0. 为离线并发冲突生成本地版本备份
      for (const item of toLocalConflictBackup) {
        await this.backupLocalConflictFile(item.file, item.path);
      }

      // 1. 执行本地删除 (云端已删)
      for (const delPath of toLocalDelete) {
        await this.applyRemoteDelete(delPath);
      }

      // 2. 执行云端删除 (本地已删)
      for (const delPath of toRemoteDelete) {
        const delOk = await this.deleteRemoteFile(delPath, { preferHttp: true });
        if (delOk) {
          delete baseline[delPath];
        } else {
          unconfirmedRemoteDeletes.add(delPath);
        }
      }

      // 3. 并发节流执行拉取 (PULL)，等待所有文件确认落地落盘
      let hasPullFailure = false;
      let hasCriticalFailure = false;
      const PULL_CONCURRENCY = 4;
      for (let i = 0; i < toPull.length; i += PULL_CONCURRENCY) {
        const batch = toPull.slice(i, i + PULL_CONCURRENCY);
        const results = await Promise.all(batch.map(async (item) => {
          if (this.isIgnoredLocalPath(item.path)) return true;
          const ok = await this.pullRemoteFileViaHttp(item.path, item.meta?.mtime, item.meta?.hash);
          if (ok === false) {
            if (this.isCriticalSyncFile(item.path)) {
              hasCriticalFailure = true;
            } else {
              console.warn('[Nimbus] 辅助/配置文件拉取受阻，已安全忽略:', item.path);
            }
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

      // 4. 并发节流执行推送 (PUSH)：在屏障期优先使用 HTTP PUT 直接拿回服务端确认结果与最新游标，避免与 _wsMessageChain 死锁排队
      const pushedMetaMap = new Map();
      const PUSH_CONCURRENCY = 4;
      for (let i = 0; i < toPush.length; i += PUSH_CONCURRENCY) {
        const batch = toPush.slice(i, i + PUSH_CONCURRENCY);
        await Promise.all(batch.map(async (f) => {
          const pushMeta = await this.pushLocalFile(f, { preferHttp: true });
          if (pushMeta && pushMeta.hash) {
            pushedMetaMap.set(f.path, pushMeta);
            if (typeof pushMeta.cursor === 'number' && pushMeta.cursor > remoteCursor) {
              remoteCursor = pushMeta.cursor;
            }
          }
        }));
        if (i + PUSH_CONCURRENCY < toPush.length) {
          await new Promise((r) => setTimeout(r, 30));
        }
      }

      // 🛡️ 防御机制 4: 合并同步期间实时更新的基线（含 HTTP PUT / WS ack / 新拉取文件），防止旧快照覆写冲掉新推送文件的基线
      const currentVaultFiles = this.app.vault.getFiles();
      const currentFileByPath = new Map(currentVaultFiles.map((f) => [f.path, f]));
      const currentLocalPaths = new Set(currentFileByPath.keys());
      const liveBaseline = this.getVaultBaseline(vaultId);
      const mergedBaseline = { ...baseline, ...liveBaseline };
      const sanitizedBaseline = {};
      for (const [p, bInfo] of Object.entries(mergedBaseline)) {
        if ((currentLocalPaths.has(p) || unconfirmedRemoteDeletes.has(p)) && bInfo && bInfo.hash) {
          const lf = currentFileByPath.get(p);
          sanitizedBaseline[p] = {
            ...bInfo,
            mtime: (lf && lf.stat && lf.stat.mtime) ? lf.stat.mtime : bInfo.mtime,
            size: (lf && lf.stat && lf.stat.size !== undefined) ? lf.stat.size : bInfo.size,
          };
        }
      }
      for (const item of toPull) {
        if (item && item.path && currentLocalPaths.has(item.path) && item.meta && item.meta.hash) {
          const lf = currentFileByPath.get(item.path);
          sanitizedBaseline[item.path] = {
            hash: item.meta.hash,
            mtime: (lf && lf.stat && lf.stat.mtime) ? lf.stat.mtime : (item.meta.mtime || Date.now()),
            size: (lf && lf.stat && lf.stat.size !== undefined) ? lf.stat.size : (item.meta.size || 0),
          };
        }
      }
      for (const [pushedPath, pMeta] of pushedMetaMap.entries()) {
        if (currentLocalPaths.has(pushedPath) && pMeta && pMeta.hash && pMeta.confirmed) {
          const lf = currentFileByPath.get(pushedPath);
          sanitizedBaseline[pushedPath] = {
            hash: pMeta.hash,
            mtime: (lf && lf.stat && lf.stat.mtime) ? lf.stat.mtime : (pMeta.mtime || Date.now()),
            size: (lf && lf.stat && lf.stat.size !== undefined) ? lf.stat.size : (pMeta.size || 0),
          };
        }
      }

      if (!this.baselinesCache) this.baselinesCache = {};
      this.baselinesCache[vaultId] = sanitizedBaseline;
      await this.saveBaselineCache();
      const latestRecordedCursor = Math.max(remoteCursor || 0, this.getVaultCursor(vaultId) || 0);
      if (latestRecordedCursor >= 0 && !hasCriticalFailure && !circuitBreakerTriggered) {
        this.setVaultCursor(vaultId, latestRecordedCursor);
        await this.saveSettings();
      } else if (hasCriticalFailure || circuitBreakerTriggered) {
        console.warn('[Nimbus] 3-Way 同步有核心笔记受阻或触发熔断，暂不推进最新游标以备下次重试完整对齐');
      }

      new Notice(`✅ 3-Way 自动同步完成: 成功处理 ${pushCount + pullCount + localDelCount + remoteDelCount} 个变更任务`);
    } catch (err) {
      console.error('[Nimbus] 3-Way 自动同步异常:', err);
      new Notice(`❌ 自动同步异常: ${err.message}`);
    }
  }

  async flushPendingLocalChangesAfterBarrier() {
    this.syncBarrierActive = false;
    if (this.barrierSafetyTimer) {
      clearTimeout(this.barrierSafetyTimer);
      this.barrierSafetyTimer = null;
    }

    const vaultId = this.settings.vaultId || 'default';
    const baseline = this.getVaultBaseline(vaultId);

    // 1. 先处理屏障期间捕获的本地删除事件
    if (this.pendingLocalDeletesWhileBarrier && this.pendingLocalDeletesWhileBarrier.size > 0) {
      const deletesToCheck = Array.from(this.pendingLocalDeletesWhileBarrier);
      this.pendingLocalDeletesWhileBarrier.clear();
      for (const delPath of deletesToCheck) {
        if (this.isIgnoredLocalPath(delPath)) continue;
        const stillExists = this.app.vault.getAbstractFileByPath(delPath);
        if (!stillExists && baseline[delPath]) {
          await this.deleteRemoteFile(delPath);
        }
      }
    }

    // 2. 再处理屏障期间捕获的本地新建/修改事件
    if (!this.pendingLocalQueueWhileBarrier || this.pendingLocalQueueWhileBarrier.size === 0) {
      return;
    }
    const pathsToCheck = Array.from(this.pendingLocalQueueWhileBarrier);
    this.pendingLocalQueueWhileBarrier.clear();

    for (const path of pathsToCheck) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const currentHash = await this.computeFileHash(file);
        const baseMeta = baseline[path];
        // 关键判定：只有当本地当前内容 Hash 确实与基线不一致时，说明离线/握手期间用户确实编辑了该文件，才进行上传
        if (currentHash && (!baseMeta || currentHash !== baseMeta.hash)) {
          await this.pushLocalFile(file);
        }
      }
    }
  }

  async backupLocalConflictFile(localFile, relPath) {
    if (!localFile || !(localFile instanceof TFile)) return null;
    const ext = localFile.extension ? `.${localFile.extension}` : '';
    const base = relPath.slice(0, relPath.length - ext.length);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictPath = `${base}.conflict-offline-${stamp}${ext}`;
    if (!this.applyingRemotePaths) this.applyingRemotePaths = new Set();
    this.applyingRemotePaths.add(conflictPath);
    let createdOk = false;
    try {
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
      createdOk = true;
      new Notice(`⚠️ 检测到离线并发冲突，已保留本地版本备份:\n${conflictPath}`, 7000);
    } catch (e) {
      console.warn('[Nimbus] 创建本地离线冲突备份失败:', relPath, e);
      return null;
    } finally {
      this.applyingRemotePaths.delete(conflictPath);
    }

    // 将本地离线冲突副本同步上传至云端，确保 Web 端「冲突解决中心」也能看到并管理该分支副本
    if (createdOk) {
      try {
        const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath);
        if (conflictFile instanceof TFile) {
          await this.pushLocalFile(conflictFile, { preferHttp: true });
        }
      } catch (pushErr) {
        console.warn('[Nimbus] 上传本地离线冲突副本至云端受阻，将在后续对账自动补传:', conflictPath, pushErr);
      }
    }
    return conflictPath;
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
      if (Array.isArray(data.ignorePatterns)) {
        this.setRemoteIgnorePatterns(data.ignorePatterns);
      }
      const remoteManifest = data.manifest || {};
      const remoteCursor = data.cursor || data.latestCursor || 0;
      await this.syncManifest(remoteManifest, remoteCursor, { manual: true });
    } catch (err) {
      console.error('[Nimbus] 全量双向同步失败:', err);
      new Notice(`❌ 全量双向同步失败: ${err.message}`);
    }
  }

  async forcePushAllLocalFiles() {
    new Notice('☁️ 开始强制推送本地所有笔记到云端...');
    const files = this.app.vault.getFiles().filter((f) => !this.isIgnoredLocalPath(f.path));
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
        await this.pushLocalFile(f, { force: true });
        pushed++;
      }));
      if (i + CONCURRENCY < files.length) {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    new Notice(`✅ 强制推送完成: 共扫描并推送 ${pushed} 个笔记/附件至云端`);
  }

  async applyRemoteChange(filePath, base64Content, mtime, hash) {
    if (!filePath || !base64Content) return;
    const buffer = base64ToArrayBuffer(base64Content);
    await this.applyRemoteBinaryChange(filePath, buffer, mtime, hash);
  }

  async applyRemoteBinaryChange(filePath, buffer, mtime, hash) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || !buffer) return false;
    return this.withLocalFileLock(cleanPath, async () => {
      if (!this.applyingRemotePaths) this.applyingRemotePaths = new Set();
      this.applyingRemotePaths.add(cleanPath);
      this.remoteApplyingCount = (this.remoteApplyingCount || 0) + 1;
      this.isApplyingRemoteChange = true;

      try {
        const existing = this.app.vault.getAbstractFileByPath(cleanPath);
        const isHidden = cleanPath.startsWith('.') || cleanPath.includes('/.');
        const adapterExists = this.app.vault.adapter ? await this.app.vault.adapter.exists(cleanPath) : false;

        if (existing instanceof TFile) {
          // 如果本地有尚未推送完成的编辑防抖任务或飞行中推送，先备份本地实时改动防冲毁
          if (
            (this.localChangeQueue && this.localChangeQueue.has(cleanPath)) ||
            (this.pendingPushes && this.pendingPushes.has(cleanPath))
          ) {
            if (this.localChangeQueue && this.localChangeQueue.has(cleanPath)) {
              clearTimeout(this.localChangeQueue.get(cleanPath));
              this.localChangeQueue.delete(cleanPath);
            }
            const localHashNow = await this.computeFileHash(existing);
            const incomingHashNow = hash || (await computeSha256(buffer));
            if (localHashNow && incomingHashNow && localHashNow !== incomingHashNow) {
              await this.backupLocalConflictFile(existing, cleanPath);
            }
          }
          await this.app.vault.modifyBinary(existing, buffer);
        } else if (adapterExists) {
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

        const calculatedHash = hash || (await computeSha256(buffer));
        if (calculatedHash) {
          const updatedFile = this.app.vault.getAbstractFileByPath(cleanPath);
          const localMtime = (updatedFile && updatedFile.stat && updatedFile.stat.mtime)
            ? updatedFile.stat.mtime
            : (mtime || Date.now());
          const localSize = (updatedFile && updatedFile.stat && updatedFile.stat.size !== undefined)
            ? updatedFile.stat.size
            : buffer.byteLength;
          this.fileHashes.set(cleanPath, calculatedHash);
          this.updateBaselineEntry(this.settings.vaultId, cleanPath, {
            hash: calculatedHash,
            mtime: localMtime,
            size: localSize
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
      }
    });
  }

  async pullRemoteFileViaHttp(filePath, mtime, expectedHash) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanToken = this.getCleanToken();
    if (!cleanPath || !this.settings.vaultId || !cleanToken) return false;
    if (expectedHash && this.fileHashes.get(cleanPath) === expectedHash) {
      return true;
    }
    try {
      const serverUrl = this.getCleanServerUrl();
      const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
      const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
      const headers = this.buildAuthHeaders();
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (res.status === 404) {
          console.warn(`[Nimbus] 远程文件在服务端已不存在 (404)，已安全跳过: ${cleanPath}`);
          return 'NOT_FOUND';
        }
        console.warn(`[Nimbus] HTTP 拉取文件失败 (${res.status}): ${cleanPath}`);
        return false;
      }
      const arrayBuffer = await res.arrayBuffer();
      const written = await this.applyRemoteBinaryChange(cleanPath, arrayBuffer, mtime, expectedHash);
      return written !== false;
    } catch (err) {
      console.error('[Nimbus] HTTP 流式拉取远程文件失败:', cleanPath, err);
      return false;
    }
  }

  async applyRemoteDelete(filePath) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || this.isIgnoredLocalPath(cleanPath)) return false;
    return this.withLocalFileLock(cleanPath, async () => {
      if (!this.applyingRemotePaths) this.applyingRemotePaths = new Set();
      this.applyingRemotePaths.add(cleanPath);
      this.remoteApplyingCount = (this.remoteApplyingCount || 0) + 1;
      this.isApplyingRemoteChange = true;
      try {
        const existing = this.app.vault.getAbstractFileByPath(cleanPath);
        if (existing instanceof TFile) {
          // 若本地正处于活跃编辑防抖或飞行上传中，先备份本地未同步改动，防止远端删除直接冲毁用户正在输入的内容
          if (
            (this.localChangeQueue && this.localChangeQueue.has(cleanPath)) ||
            (this.pendingPushes && this.pendingPushes.has(cleanPath))
          ) {
            if (this.localChangeQueue && this.localChangeQueue.has(cleanPath)) {
              clearTimeout(this.localChangeQueue.get(cleanPath));
              this.localChangeQueue.delete(cleanPath);
            }
            await this.backupLocalConflictFile(existing, cleanPath);
          }
          await this.app.vault.delete(existing);
        } else if (this.app.vault.adapter && await this.app.vault.adapter.exists(cleanPath)) {
          await this.app.vault.adapter.remove(cleanPath);
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
      }
    });
  }

  // --- Local File Changes ---
  async onLocalFileChange(type, file) {
    if (!this.isVaultReady || !(file instanceof TFile)) return;
    if (this.isPathApplyingRemote(file.path, false)) return;
    if (this.isIgnoredLocalPath(file.path)) return;

    // 🛡️ 启动期下行优先屏障保护 (Pull-First Sync Barrier)
    // 在首轮与云端完成下行增量或清单对齐前，禁止向云端盲目外发本地文件
    if (this.syncBarrierActive) {
      if (this.pendingLocalDeletesWhileBarrier) {
        this.pendingLocalDeletesWhileBarrier.delete(file.path);
      }
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
      await this.pushLocalFile(file);
    }, delay);

    this.localChangeQueue.set(file.path, timer);
  }

  async onLocalFileDelete(file) {
    if (!this.isVaultReady) return;
    if (file instanceof TFile) {
      if (this.isPathApplyingRemote(file.path, false)) return;
      if (this.isIgnoredLocalPath(file.path)) return;
      if (this.localChangeQueue.has(file.path)) {
        clearTimeout(this.localChangeQueue.get(file.path));
        this.localChangeQueue.delete(file.path);
      }
      if (this.syncBarrierActive) {
        if (this.pendingLocalQueueWhileBarrier) {
          this.pendingLocalQueueWhileBarrier.delete(file.path);
        }
        if (this.pendingLocalDeletesWhileBarrier) {
          this.pendingLocalDeletesWhileBarrier.add(file.path);
        }
        return;
      }
      await this.deleteRemoteFile(file.path);
    } else if (file instanceof TFolder) {
      if (this.isPathApplyingRemote(file.path, true)) return;
      const folderPrefix = file.path ? `${file.path}/` : '';
      for (const [queuedPath, timer] of this.localChangeQueue.entries()) {
        if (queuedPath.startsWith(folderPrefix)) {
          clearTimeout(timer);
          this.localChangeQueue.delete(queuedPath);
        }
      }
      const vaultId = this.settings.vaultId || 'default';
      const baseline = this.getVaultBaseline(vaultId);
      const knownPathsSet = new Set([
        ...Array.from(this.fileHashes.keys()),
        ...Object.keys(baseline || {}),
      ]);
      const matchedPaths = [];
      for (const knownPath of knownPathsSet) {
        if (knownPath.startsWith(folderPrefix) && !this.isIgnoredLocalPath(knownPath)) {
          matchedPaths.push(knownPath);
        }
      }
      if (this.syncBarrierActive) {
        for (const p of matchedPaths) {
          if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.delete(p);
          if (this.pendingLocalDeletesWhileBarrier) this.pendingLocalDeletesWhileBarrier.add(p);
        }
        return;
      }
      // 🛡️ 文件夹级批量删除安全熔断保护
      const totalKnownCount = Math.max(this.fileHashes.size, Object.keys(baseline || {}).length);
      if (matchedPaths.length > 10 && matchedPaths.length >= Math.max(1, totalKnownCount * 0.4)) {
        console.warn(`[Nimbus 安全熔断] 拦截异常文件夹批量删除: ${file.path}, 涉及文件: ${matchedPaths.length}`);
        new Notice(`⚠️ [Nimbus 安全熔断] 检测到删除文件夹包含 ${matchedPaths.length} 篇笔记（超安全阈值），已阻止向云端同步清空！`, 8000);
        return;
      }
      for (const knownPath of matchedPaths) {
        await this.deleteRemoteFile(knownPath);
      }
    }
  }

  async onLocalFileRename(file, oldPath) {
    if (!this.isVaultReady) return;
    if (file instanceof TFile) {
      if (this.isPathApplyingRemote(file.path, false) || this.isPathApplyingRemote(oldPath, false)) return;
      if (this.isIgnoredLocalPath(file.path) && this.isIgnoredLocalPath(oldPath)) return;
      if (this.localChangeQueue.has(oldPath)) {
        clearTimeout(this.localChangeQueue.get(oldPath));
        this.localChangeQueue.delete(oldPath);
      }
      if (this.syncBarrierActive) {
        if (!this.isIgnoredLocalPath(oldPath)) {
          if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.delete(oldPath);
          if (this.pendingLocalDeletesWhileBarrier) this.pendingLocalDeletesWhileBarrier.add(oldPath);
        }
        if (!this.isIgnoredLocalPath(file.path)) {
          if (this.pendingLocalDeletesWhileBarrier) this.pendingLocalDeletesWhileBarrier.delete(file.path);
          if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.add(file.path);
        }
        return;
      }
      // 若原路径与新路径均未命中忽略规则，优先调用原生 rename 指令（零流量原位重命名，保留历史版本且不污染回收站）
      if (!this.isIgnoredLocalPath(oldPath) && !this.isIgnoredLocalPath(file.path)) {
        await this.renameRemoteFile(oldPath, file);
        return;
      }
      if (!this.isIgnoredLocalPath(oldPath)) {
        await this.deleteRemoteFile(oldPath);
      }
      if (!this.isIgnoredLocalPath(file.path)) {
        this.fileHashes.delete(file.path);
        await this.pushLocalFile(file);
      }
    } else if (file instanceof TFolder) {
      if (this.isPathApplyingRemote(file.path, true) || this.isPathApplyingRemote(oldPath, true)) return;
      // 文件夹重命名：同步重命名该目录下所有子文件
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
          if (this.isIgnoredLocalPath(f.path)) continue;
          const relativePart = f.path.substring(newPrefix.length);
          const oldFilePath = oldPrefix + relativePart;
          if (this.syncBarrierActive) {
            if (!this.isIgnoredLocalPath(oldFilePath)) {
              if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.delete(oldFilePath);
              if (this.pendingLocalDeletesWhileBarrier) this.pendingLocalDeletesWhileBarrier.add(oldFilePath);
            }
            if (this.pendingLocalDeletesWhileBarrier) this.pendingLocalDeletesWhileBarrier.delete(f.path);
            if (this.pendingLocalQueueWhileBarrier) this.pendingLocalQueueWhileBarrier.add(f.path);
            continue;
          }
          if (!this.isIgnoredLocalPath(oldFilePath)) {
            await this.renameRemoteFile(oldFilePath, f);
          } else {
            this.fileHashes.delete(f.path);
            await this.pushLocalFile(f);
          }
        }
      }
    }
  }

  async renameRemoteFile(oldPath, newFile) {
    const cleanOld = String(oldPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanNew = newFile && newFile.path ? String(newFile.path).replace(/\\/g, '/').replace(/^\/+/, '') : '';
    if (!cleanOld || !cleanNew) return false;
    const wsReady = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
    if (wsReady) {
      const oldHash = this.fileHashes.get(cleanOld);
      this.fileHashes.delete(cleanOld);
      if (oldHash) {
        this.fileHashes.set(cleanNew, oldHash);
      }
      this.sendWsMessage({ type: 'rename', oldPath: cleanOld, newPath: cleanNew });
      return true;
    }
    await this.deleteRemoteFile(cleanOld);
    this.fileHashes.delete(cleanNew);
    await this.pushLocalFile(newFile);
    return true;
  }

  async deleteRemoteFile(filePath, options = {}) {
    const cleanPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || this.isIgnoredLocalPath(cleanPath)) return false;
    const vaultId = this.settings.vaultId || 'default';
    const preferHttp = Boolean(options && options.preferHttp);
    const wsReady = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);

    // 常规实时删除且 WebSocket 处于连接态时，走 WebSocket 快速通道（等待服务端 ack 确认后再抹除 baseline）
    if (!preferHttp && wsReady) {
      this.sendWsMessage({ type: 'delete', path: cleanPath });
      this.fileHashes.delete(cleanPath);
      return true;
    }

    // 屏障期批量同步 (preferHttp) 或 WebSocket 断连时，尝试使用 HTTP DELETE 确保云端真正删除
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
            if (body && typeof body.cursor === 'number' && body.cursor > 0) {
              this.setVaultCursor(vaultId, body.cursor);
            }
          } catch {}
          this.fileHashes.delete(cleanPath);
          this.updateBaselineEntry(vaultId, cleanPath, null);
          return true;
        }
      } catch (err) {
        // 网络完全断开或请求不可达
      }
    }

    if (wsReady) {
      this.sendWsMessage({ type: 'delete', path: cleanPath });
      this.fileHashes.delete(cleanPath);
      return true;
    }

    // 🛡️ 彻底离线保护：仅移除内存哈希缓存，绝不提前抹除 baseline[cleanPath]！
    // 保留 baseline 记录可确保设备重连后，reconcileLocalOfflineChanges / syncManifest
    // 能够识别出 (!localFile && baseMeta) 属于「本地离线删除」，从而向云端补发删除而非将旧文件反向复活拉回本地！
    this.fileHashes.delete(cleanPath);
    return false;
  }

  async pushLocalFile(file, options = {}) {
    if (!file || !file.path) return null;
    if (this.isIgnoredLocalPath(file.path)) return null;
    if (this.isPathApplyingRemote(file.path, false)) return null;
    const isForce = Boolean(options && options.force);
    const preferHttp = Boolean(options && options.preferHttp);
    return this.withLocalFileLock(file.path, async () => {
      if (this.isPathApplyingRemote(file.path, false)) return null;
      try {
        const buffer = await this.app.vault.readBinary(file);
        const baseMeta = this.getBaselineEntry(this.settings.vaultId, file.path);
        const inFlightPending = (this.pendingPushes && this.pendingPushes.has(file.path))
          ? this.pendingPushes.get(file.path)
          : null;
        const baseHash = isForce
          ? null
          : ((inFlightPending && inFlightPending.hash) || (baseMeta && baseMeta.hash) || this.fileHashes.get(file.path) || null);
        const currentHash = await computeSha256(buffer);
        const fileMtime = (file.stat && file.stat.mtime) ? file.stat.mtime : Date.now();

        // 🛡️ 内容无变化前置拦截：非强制模式下，若内容与已确认缓存哈希或飞行中待确认哈希完全一致，跳过冗余上传
        if (
          !isForce &&
          currentHash &&
          (this.fileHashes.get(file.path) === currentHash || (inFlightPending && inFlightPending.hash === currentHash))
        ) {
          return {
            hash: currentHash,
            mtime: fileMtime,
            size: buffer.byteLength,
            confirmed: this.fileHashes.get(file.path) === currentHash,
          };
        }
        const MAX_WS_INLINE = 2 * 1024 * 1024; // 2MB

        // If file exceeds 2MB, preferHttp is set (e.g. during init barrier sync), or WebSocket is not open, stream via HTTP PUT
        const wsReady = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
        if ((preferHttp || buffer.byteLength > MAX_WS_INLINE || !wsReady) && this.settings.serverUrl && this.settings.vaultId && this.settings.token) {
          const serverUrl = this.getCleanServerUrl();
          const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
          const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
          const headers = this.buildAuthHeaders({
            'Content-Type': 'application/octet-stream',
            ...(baseHash ? { 'x-base-hash': String(baseHash) } : {}),
            ...(fileMtime ? { 'x-mtime': String(fileMtime) } : {})
          });

          const res = await fetch(url, {
            method: 'PUT',
            headers,
            body: buffer,
          });

          if (res.ok) {
            const body = await res.json();
            if (body && typeof body.cursor === 'number' && body.cursor > 0) {
              this.setVaultCursor(this.settings.vaultId, body.cursor);
            }
            if (body && body.ignored) {
              if (currentHash) this.fileHashes.set(file.path, currentHash);
              return null;
            }
            if (body && body.serverWin) {
              new Notice(`⚠️ 检测到并发冲突 (云端版本较新优先)：已备份本地改动并拉取云端最新版本: ${file.path}`);
              await this.backupLocalConflictFile(file, file.path);
              this.fileHashes.delete(file.path);
              await this.pullRemoteFileViaHttp(file.path, undefined, body.currentHash);
              return null;
            }
            if (body && body.conflict) {
              new Notice(`⚠️ 检测到并发冲突！已自动创建冲突副本: ${body.conflict}`);
              await this.pullRemoteFileViaHttp(body.conflict, undefined, body.conflictHash);
              this.fileHashes.delete(file.path);
              await this.pullRemoteFileViaHttp(file.path, undefined, body.currentHash);
              return null;
            }
            const returnedHash = body && (body.currentHash || body.hash || currentHash);
            if (returnedHash) {
              this.fileHashes.set(file.path, returnedHash);
              this.updateBaselineEntry(this.settings.vaultId, file.path, {
                hash: returnedHash,
                mtime: fileMtime,
                size: buffer.byteLength
              });
            }
            return {
              hash: returnedHash,
              mtime: fileMtime,
              size: buffer.byteLength,
              cursor: body && body.cursor,
              confirmed: true
            };
          } else {
            console.warn(`[Nimbus] HTTP PUT 推送失败 (${res.status}):`, file.path);
            return null;
          }
        }

        if (!wsReady) {
          return null;
        }

        // WebSocket 小文件内联推送：先登记到 pendingPushes，待服务端 ack 确认后再正式写入 fileHashes 与 baseline
        if (currentHash && this.pendingPushes) {
          this.pendingPushes.set(file.path, {
            hash: currentHash,
            mtime: fileMtime,
            size: buffer.byteLength,
          });
        }

        const base64 = arrayBufferToBase64(buffer);
        this.sendWsMessage({
          type: 'push',
          path: file.path,
          content: base64,
          mtime: fileMtime,
          baseHash: baseHash || undefined,
        });
        return { hash: currentHash, mtime: fileMtime, size: buffer.byteLength, confirmed: false };
      } catch (err) {
        console.error('[Nimbus] 读取本地文件准备上传失败:', file.path, err);
        return null;
      }
    });
  }

  sendWsMessage(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
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
      const baselineCount = Object.keys(this.plugin.getVaultBaseline(currentVaultId)).length;
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
            if (this.plugin.fileHashes) {
              this.plugin.fileHashes.clear();
            }
            this.plugin.setVaultCursor(currentVaultId, 0);
            await this.plugin.saveBaselineCache();
            await this.plugin.saveSettings();
            new Notice('✅ 已重置当前 Vault 的同步基线快照与增量游标');
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
