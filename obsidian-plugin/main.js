const { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, arrayBufferToBase64, base64ToArrayBuffer } = require('obsidian');
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
  syncIntervalSeconds: 30,
  syncBaselines: {}
};

module.exports = class NimbusSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Default device ID if empty
    if (!this.settings.deviceId) {
      this.settings.deviceId = 'Obsidian-' + Math.random().toString(36).substring(2, 7);
      await this.saveSettings();
    }

    this.localChangeQueue = new Map();
    this.isApplyingRemoteChange = false;
    this.fileHashes = new Map();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this._saveSettingsTimer = null;

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

    // Vault Event Listeners
    this.registerEvent(this.app.vault.on('modify', (file) => this.onLocalFileChange('modify', file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onLocalFileChange('create', file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onLocalFileDelete(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onLocalFileRename(file, oldPath)));

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
    if (this._saveSettingsTimer) {
      clearTimeout(this._saveSettingsTimer);
    }
    this._saveSettingsTimer = setTimeout(async () => {
      this._saveSettingsTimer = null;
      await this.saveSettings();
    }, 400);
  }

  getVaultBaseline(vaultId = this.settings.vaultId) {
    if (!vaultId) return {};
    if (!this.settings.syncBaselines) {
      this.settings.syncBaselines = {};
    }
    return this.settings.syncBaselines[vaultId] || {};
  }

  updateBaselineEntry(vaultId, filePath, meta) {
    if (!vaultId || !filePath) return;
    if (!this.settings.syncBaselines) {
      this.settings.syncBaselines = {};
    }
    if (!this.settings.syncBaselines[vaultId]) {
      this.settings.syncBaselines[vaultId] = {};
    }
    if (meta === null || meta === undefined) {
      delete this.settings.syncBaselines[vaultId][filePath];
    } else {
      this.settings.syncBaselines[vaultId][filePath] = {
        hash: meta.hash,
        mtime: meta.mtime || Date.now(),
        size: meta.size || 0
      };
    }
    this.scheduleSaveSettings();
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
    if (!this.settings.token) return [];

    try {
      const resp = await fetch(`${baseUrl}/api/vaults`, {
        headers: { 'Authorization': `Bearer ${this.settings.token}` }
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
    if (!this.settings.token) return null;

    try {
      const resp = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.token}`
        },
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

    const rawToken = (this.settings.token || this.settings.authToken || '').trim();
    if (!rawToken || !this.settings.vaultId) {
      this.updateStatusBar('idle', '☁️ Nimbus: 未配置');
      return;
    }

    const cleanToken = rawToken.replace(/^Bearer\s+/i, '').trim();

    const baseUrl = this.getCleanServerUrl();
    const wsProto = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
    const host = baseUrl.replace(/^https?:\/\//i, '');
    const wsUrl = `${wsProto}//${host}/ws?token=${encodeURIComponent(cleanToken)}&vaultId=${encodeURIComponent(this.settings.vaultId)}&deviceId=${encodeURIComponent(this.settings.deviceId)}`;

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

      this.ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          await this.handleServerMessage(msg);
        } catch (err) {
          console.error('[Nimbus] 解析服务器消息异常:', err);
        }
      };

      this.ws.onclose = (e) => {
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
      console.error('[Nimbus] 连接初始化失败:', err);
      this.updateStatusBar('error');
    }
  }

  disconnectWebSocket() {
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
      case 'init':
        // Initial sync manifest check
        await this.syncManifest(msg.manifest || {});
        break;

      case 'change':
        // A file was created/updated remotely
        if (msg.pullRequired || !msg.content) {
          await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        } else {
          await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        }
        break;

      case 'batch_file_change':
        // Handle coalesced or server batch change notifications
        if (Array.isArray(msg.changes)) {
          for (const item of msg.changes) {
            if (!item || !item.path) continue;
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
        await this.pullRemoteFileViaHttp(msg.path, msg.mtime, msg.hash);
        break;

      case 'deleted':
        // A file was deleted remotely
        await this.applyRemoteDelete(msg.path);
        break;

      case 'conflict':
        new Notice(`⚠️ 检测到并发冲突！已自动创建云端分支副本: ${msg.conflictPath}`);
        // 1. 自动拉取云端新创建的分支副本保存至本地
        if (msg.conflictPath) {
          this.sendWsMessage({ type: 'pull', path: msg.conflictPath });
        }
        // 2. 自动拉取云端主文件当前胜出版本同步至本地
        if (msg.path) {
          this.sendWsMessage({ type: 'pull', path: msg.path });
        }
        break;

      case 'permission_updated':
        new Notice(`ℹ️ ${msg.message || '您的笔记库权限已更新'}`);
        break;

      case 'file':
        // Response to pull
        await this.applyRemoteChange(msg.path, msg.content, msg.mtime, msg.hash);
        break;

      case 'ack':
        if (msg.hash) {
          this.fileHashes.set(msg.path, msg.hash);
          this.updateBaselineEntry(this.settings.vaultId, msg.path, {
            hash: msg.hash,
            mtime: msg.mtime || Date.now()
          });
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
        console.warn('[Nimbus] 服务器返回错误:', msg.message);
        break;
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

  async syncManifest(remoteManifest) {
    new Notice('☁️ Nimbus 正在检查笔记库并自动同步 (3-Way Diff)...');
    try {
      const vaultId = this.settings.vaultId || 'default';
      const baseline = { ...this.getVaultBaseline(vaultId) };
      const files = this.app.vault.getFiles();
      const localFileMap = new Map();
      for (const f of files) {
        localFileMap.set(f.path, f);
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

      // 3-Way 对比分析：Local (本地当前) vs Remote (云端当前) vs Base (上次同步基线)
      for (const path of allPaths) {
        const localFile = localFileMap.get(path);
        const remoteMeta = remoteManifest ? remoteManifest[path] : null;
        const baseMeta = baseline[path];

        if (localFile && remoteMeta && baseMeta) {
          // 场景 1: 三方均存在
          const localHash = await this.computeFileHash(localFile);
          if (localHash === remoteMeta.hash) {
            // 内容一致，更新内存与基线
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = { hash: remoteMeta.hash, mtime: remoteMeta.mtime, size: remoteMeta.size };
          } else {
            const localChanged = (localHash !== baseMeta.hash);
            const remoteChanged = (remoteMeta.hash !== baseMeta.hash);

            if (localChanged && !remoteChanged) {
              // 仅本地修改 -> 推送至云端
              this.fileHashes.set(path, localHash);
              toPush.push(localFile);
            } else if (!localChanged && remoteChanged) {
              // 仅云端修改 -> 拉取至本地
              toPull.push({ path, meta: remoteMeta });
            } else {
              // 并发修改/时间戳比对
              const localMtime = (localFile.stat && localFile.stat.mtime) ? localFile.stat.mtime : 0;
              const remoteMtime = (remoteMeta.mtime) ? remoteMeta.mtime : 0;
              if (remoteMtime > localMtime) {
                toPull.push({ path, meta: remoteMeta });
              } else {
                this.fileHashes.set(path, localHash);
                toPush.push(localFile);
              }
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
            delete baseline[path];
            this.fileHashes.delete(path);
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
          // 场景 6: 两端均存在但无历史基线 (首次绑定/基线重置)
          const localHash = await this.computeFileHash(localFile);
          if (localHash && remoteMeta.hash && localHash === remoteMeta.hash) {
            this.fileHashes.set(path, remoteMeta.hash);
            baseline[path] = { hash: remoteMeta.hash, mtime: remoteMeta.mtime, size: remoteMeta.size };
          } else {
            const localMtime = (localFile.stat && localFile.stat.mtime) ? localFile.stat.mtime : 0;
            const remoteMtime = (remoteMeta.mtime) ? remoteMeta.mtime : 0;
            if (remoteMtime > localMtime) {
              toPull.push({ path, meta: remoteMeta });
            } else {
              if (localHash) this.fileHashes.set(path, localHash);
              toPush.push(localFile);
            }
          }
        } else if (!localFile && !remoteMeta && baseMeta) {
          // 场景 7: 两端均已删除
          delete baseline[path];
          this.fileHashes.delete(path);
        }
      }

      const pullCount = toPull.length;
      const pushCount = toPush.length;
      const localDelCount = toLocalDelete.length;
      const remoteDelCount = toRemoteDelete.length;

      if (pullCount === 0 && pushCount === 0 && localDelCount === 0 && remoteDelCount === 0) {
        if (!this.settings.syncBaselines) this.settings.syncBaselines = {};
        this.settings.syncBaselines[vaultId] = baseline;
        await this.saveSettings();
        new Notice('✅ 本地笔记与 Nimbus 云端已保持一致 (3-Way 基线校验完成)');
        return;
      }

      new Notice(`⚡ 3-Way 同步开始: 上传 ${pushCount}，下载 ${pullCount}，本地删除 ${localDelCount}，云端删除 ${remoteDelCount}`);

      // 1. 执行本地删除 (云端已删)
      for (const delPath of toLocalDelete) {
        await this.applyRemoteDelete(delPath);
      }

      // 2. 执行云端删除 (本地已删)
      for (const delPath of toRemoteDelete) {
        this.sendWsMessage({ type: 'delete', path: delPath });
      }

      // 3. 并发节流执行拉取 (PULL)
      const PULL_CONCURRENCY = 6;
      for (let i = 0; i < toPull.length; i += PULL_CONCURRENCY) {
        const batch = toPull.slice(i, i + PULL_CONCURRENCY);
        for (const item of batch) {
          if (item.meta && item.meta.size && item.meta.size > 2 * 1024 * 1024) {
            await this.pullRemoteFileViaHttp(item.path, item.meta.mtime, item.meta.hash);
          } else {
            this.sendWsMessage({ type: 'pull', path: item.path });
          }
        }
        if (i + PULL_CONCURRENCY < toPull.length) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }

      // 4. 并发节流执行推送 (PUSH)
      const PUSH_CONCURRENCY = 4;
      for (let i = 0; i < toPush.length; i += PUSH_CONCURRENCY) {
        const batch = toPush.slice(i, i + PUSH_CONCURRENCY);
        await Promise.all(batch.map((f) => this.pushLocalFile(f)));
        if (i + PUSH_CONCURRENCY < toPush.length) {
          await new Promise((r) => setTimeout(r, 30));
        }
      }

      // 同步完成后保存最新基线
      if (!this.settings.syncBaselines) this.settings.syncBaselines = {};
      this.settings.syncBaselines[vaultId] = baseline;
      await this.saveSettings();

      new Notice(`✅ 3-Way 自动同步完成: 成功处理 ${pushCount + pullCount + localDelCount + remoteDelCount} 个变更任务`);
    } catch (err) {
      console.error('[Nimbus] 3-Way 自动同步异常:', err);
      new Notice(`❌ 自动同步异常: ${err.message}`);
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
      const res = await fetch(`${baseUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/manifest`, {
        headers: {
          'Authorization': `Bearer ${this.settings.token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`获取云端清单失败 (HTTP ${res.status})`);
      }

      const data = await res.json();
      const remoteManifest = data.manifest || {};
      await this.syncManifest(remoteManifest);
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
    if (!filePath || !base64Content) return;
    const buffer = base64ToArrayBuffer(base64Content);
    await this.applyRemoteBinaryChange(filePath, buffer, mtime, hash);
  }

  async applyRemoteBinaryChange(filePath, buffer, mtime, hash) {
    if (!filePath || !buffer) return;
    this.isApplyingRemoteChange = true;

    try {
      const existing = this.app.vault.getAbstractFileByPath(filePath);

      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, buffer);
      } else {
        // Ensure parent directories exist
        const parts = filePath.split('/');
        if (parts.length > 1) {
          let currentPath = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentPath += (currentPath ? '/' : '') + parts[i];
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
              await this.app.vault.createFolder(currentPath);
            }
          }
        }
        await this.app.vault.createBinary(filePath, buffer);
      }

      const calculatedHash = hash || (await computeSha256(buffer));
      if (calculatedHash) {
        this.fileHashes.set(filePath, calculatedHash);
        this.updateBaselineEntry(this.settings.vaultId, filePath, {
          hash: calculatedHash,
          mtime: mtime || Date.now(),
          size: buffer.byteLength
        });
      }
    } catch (err) {
      console.error('[Nimbus] 写入远程文件失败:', filePath, err);
    } finally {
      this.isApplyingRemoteChange = false;
    }
  }

  async pullRemoteFileViaHttp(filePath, mtime, expectedHash) {
    if (!filePath || !this.settings.vaultId || !this.settings.token) return;
    try {
      const serverUrl = this.settings.serverUrl.replace(/\/+$/, '');
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.settings.token}`,
        },
      });
      if (!res.ok) {
        console.warn(`[Nimbus] HTTP 拉取大文件失败 (${res.status}): ${filePath}`);
        return;
      }
      const arrayBuffer = await res.arrayBuffer();
      await this.applyRemoteBinaryChange(filePath, arrayBuffer, mtime, expectedHash);
    } catch (err) {
      console.error('[Nimbus] HTTP 流式拉取远程文件失败:', filePath, err);
    }
  }

  async applyRemoteDelete(filePath) {
    if (!filePath) return;
    this.isApplyingRemoteChange = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        await this.app.vault.delete(existing);
      }
      this.fileHashes.delete(filePath);
      this.updateBaselineEntry(this.settings.vaultId, filePath, null);
    } catch (err) {
      console.error('[Nimbus] 删除本地文件失败:', filePath, err);
    } finally {
      this.isApplyingRemoteChange = false;
    }
  }

  // --- Local File Changes ---
  async onLocalFileChange(type, file) {
    if (this.isApplyingRemoteChange || !(file instanceof TFile)) return;

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
    if (this.isApplyingRemoteChange) return;
    if (file instanceof TFile) {
      if (this.localChangeQueue.has(file.path)) {
        clearTimeout(this.localChangeQueue.get(file.path));
        this.localChangeQueue.delete(file.path);
      }
      this.sendWsMessage({
        type: 'delete',
        path: file.path
      });
      this.fileHashes.delete(file.path);
      this.updateBaselineEntry(this.settings.vaultId, file.path, null);
    } else if (file instanceof TFolder) {
      const folderPrefix = file.path ? `${file.path}/` : '';
      for (const [queuedPath, timer] of this.localChangeQueue.entries()) {
        if (queuedPath.startsWith(folderPrefix)) {
          clearTimeout(timer);
          this.localChangeQueue.delete(queuedPath);
        }
      }
      for (const knownPath of Array.from(this.fileHashes.keys())) {
        if (knownPath.startsWith(folderPrefix)) {
          this.sendWsMessage({ type: 'delete', path: knownPath });
          this.fileHashes.delete(knownPath);
          this.updateBaselineEntry(this.settings.vaultId, knownPath, null);
        }
      }
    }
  }

  async onLocalFileRename(file, oldPath) {
    if (this.isApplyingRemoteChange) return;
    if (file instanceof TFile) {
      if (this.localChangeQueue.has(oldPath)) {
        clearTimeout(this.localChangeQueue.get(oldPath));
        this.localChangeQueue.delete(oldPath);
      }
      // Delete old path on server and push new path
      this.sendWsMessage({ type: 'delete', path: oldPath });
      this.fileHashes.delete(oldPath);
      this.updateBaselineEntry(this.settings.vaultId, oldPath, null);
      await this.pushLocalFile(file);
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
          this.sendWsMessage({ type: 'delete', path: oldFilePath });
          const oldHash = this.fileHashes.get(oldFilePath);
          this.fileHashes.delete(oldFilePath);
          this.updateBaselineEntry(this.settings.vaultId, oldFilePath, null);
          if (oldHash) {
            this.fileHashes.set(f.path, oldHash);
          }
          await this.pushLocalFile(f);
        }
      }
    }
  }

  async pushLocalFile(file) {
    try {
      const buffer = await this.app.vault.readBinary(file);
      const baseHash = this.fileHashes.get(file.path);
      const currentHash = await computeSha256(buffer);
      const MAX_WS_INLINE = 2 * 1024 * 1024; // 2MB

      // If file exceeds 2MB, stream via HTTP PUT to avoid WebSocket buffer memory pressure
      if (buffer.byteLength > MAX_WS_INLINE && this.settings.serverUrl && this.settings.vaultId && this.settings.token) {
        const serverUrl = this.settings.serverUrl.replace(/\/+$/, '');
        const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
        const url = `${serverUrl}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/files/${encodedPath}`;
        const headers = {
          'Authorization': `Bearer ${this.settings.token}`,
          'Content-Type': 'application/octet-stream',
        };
        if (baseHash) headers['x-base-hash'] = baseHash;
        if (file.stat && file.stat.mtime) headers['x-mtime'] = String(file.stat.mtime);

        const res = await fetch(url, {
          method: 'PUT',
          headers,
          body: buffer,
        });

        if (res.ok) {
          const body = await res.json();
          const returnedHash = body && (body.currentHash || body.hash || currentHash);
          if (returnedHash) {
            this.fileHashes.set(file.path, returnedHash);
            this.updateBaselineEntry(this.settings.vaultId, file.path, {
              hash: returnedHash,
              mtime: file.stat ? file.stat.mtime : Date.now(),
              size: buffer.byteLength
            });
          }
          if (body && body.conflict) {
            new Notice(`⚠️ 检测到并发冲突！已自动创建冲突副本: ${body.conflict}`);
          }
        } else {
          console.warn(`[Nimbus] 大文件 HTTP PUT 推送失败 (${res.status}):`, file.path);
        }
        return;
      }

      if (currentHash) {
        this.fileHashes.set(file.path, currentHash);
        this.updateBaselineEntry(this.settings.vaultId, file.path, {
          hash: currentHash,
          mtime: file.stat ? file.stat.mtime : Date.now(),
          size: buffer.byteLength
        });
      }

      const base64 = arrayBufferToBase64(buffer);
      this.sendWsMessage({
        type: 'push',
        path: file.path,
        content: base64,
        mtime: file.stat ? file.stat.mtime : Date.now(),
        baseHash: baseHash || undefined,
      });
    } catch (err) {
      console.error('[Nimbus] 读取本地文件准备上传失败:', file.path, err);
    }
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
      const baselineCount = Object.keys((this.plugin.settings.syncBaselines && this.plugin.settings.syncBaselines[currentVaultId]) || {}).length;
      new Setting(containerEl)
        .setName('📋 同步基线快照 (Sync Baseline)')
        .setDesc(`当前 Vault 已记录 ${baselineCount} 个文件的同步基线快照（用于识别跨端删除，防止已删文件复活）`)
        .addButton(btn => btn
          .setButtonText('重置基线快照')
          .onClick(async () => {
            if (!this.plugin.settings.syncBaselines) {
              this.plugin.settings.syncBaselines = {};
            }
            this.plugin.settings.syncBaselines[currentVaultId] = {};
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
  }
}
