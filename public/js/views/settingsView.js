// --------------------------- View: Server & Client Settings ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';
import { THEMES, THEME_LABELS, FONT_SIZES, applyTheme, applyFontSize, openThemeSelectorModal } from '../core/themes.js';
import { renderDatabaseSettingsSubtab } from './databaseView.js';

let currentSettingsSubTab = 'plugin';

export async function renderSettingsPanel(subTab = null, containerEl = null) {
  if (subTab) currentSettingsSubTab = subTab;
  const mainPanel = containerEl || $('#main-panel');
  if (!mainPanel) return;

  mainPanel.innerHTML = '<div class="empty-state">正在加载设置…</div>';

  let settingsData = null;
  let tokensList = [];
  try {
    const [resSettings, resTokens] = await Promise.all([
      api('/api/settings'),
      api('/api/settings/tokens'),
    ]);
    if (resSettings.ok) {
      const body = await resSettings.json();
      settingsData = body.settings;
    }
    if (resTokens.ok) {
      const body = await resTokens.json();
      tokensList = body.tokens || [];
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  }

  const settings = settingsData || {
    serverName: 'Nimbus Vault Sync',
    publicUrl: '',
    wsHeartbeatInterval: 30,
    conflictStrategy: 'conflict_copy',
    maxFileSizeMb: 100,
    chunkSizeMb: 5,
    versionRetentionCount: 30,
    versionRetentionDays: 30,
    trashRetentionDays: 30,
    syncHiddenConfig: true,
    syncAttachments: true,
    autoPurgeTrash: false,
    defaultIgnorePatterns: ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '**/*.tmp', '**/.DS_Store', '**/Thumbs.db', '**/.git/**'],
  };

  const isAdmin = state.user?.role === 'admin';
  const serverOrigin = window.location.origin;
  const currentVault = state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0] || { id: 'default', name: 'Default Vault' };

  mainPanel.innerHTML = `
    <div class="settings-container">
      <div class="settings-header">
        <div>
          <h2 style="margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px;">
            <span>⚙️</span>
            <span>设置 (Nimbus Vault Sync)</span>
          </h2>
          <p style="margin:0;font-size:13px;color:var(--muted)">
            配置 Obsidian 客户端同步参数、实时冲突裁决机制、多端专属令牌与数据保留策略
          </p>
        </div>
        <div style="display:flex;gap:8px;">
          <span class="badge" style="background:var(--accent-bg);color:var(--accent)">
            ${isAdmin ? '👑 系统管理员' : '👤 普通用户'}
          </span>
        </div>
      </div>

      <div class="settings-subnav">
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'plugin' ? 'active' : ''}" data-subtab="plugin">
          ⚡ Obsidian 插件配置
        </button>
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'sync' ? 'active' : ''}" data-subtab="sync">
          🔄 同步策略与冲突处理
        </button>
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'database' ? 'active' : ''}" data-subtab="database">
          🗄️ 数据库与存储引擎
        </button>
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'history' ? 'active' : ''}" data-subtab="history">
          🕒 版本快照与回收站
        </button>
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'tokens' ? 'active' : ''}" data-subtab="tokens">
          🔑 设备专属令牌 (${tokensList.length})
        </button>
        <button class="settings-subnav-btn ${currentSettingsSubTab === 'account' ? 'active' : ''}" data-subtab="account">
          👤 账户安全与修改密码
        </button>
      </div>

      <div id="settings-tab-content"></div>
    </div>
  `;

  // Bind subnav tabs
  mainPanel.querySelectorAll('.settings-subnav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentSettingsSubTab = btn.dataset.subtab;
      mainPanel.querySelectorAll('.settings-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.subtab === currentSettingsSubTab));
      renderSettingsSubTabContent(currentSettingsSubTab, settings, tokensList, currentVault, isAdmin, serverOrigin, mainPanel);
    });
  });

  renderSettingsSubTabContent(currentSettingsSubTab, settings, tokensList, currentVault, isAdmin, serverOrigin, mainPanel);
}

function renderSettingsSubTabContent(subTab, settings, tokensList, currentVault, isAdmin, serverOrigin, mainPanel) {
  const container = mainPanel.querySelector('#settings-tab-content');
  if (!container) return;

  if (subTab === 'plugin') {
    const vaultOptions = state.vaults.map((v) => `<option value="${v.id}" ${v.id === currentVault.id ? 'selected' : ''}>${escapeHtml(v.name)} (${v.id})</option>`).join('');
    const tokenOptions = [
      `<option value="${state.token}">🔑 当前登录主令牌 (${state.user?.username || 'Main'})</option>`,
      ...tokensList.map((t) => `<option value="${escapeHtml(t.token || '')}">📱 [专属设备] ${escapeHtml(t.label)} (${escapeHtml(t.maskedToken || '')})</option>`),
    ].join('');
    const bratRepoUrl = 'https://github.com/lengedliu/nimbus-vault-sync';

    container.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-header">
          <h3><span>⚡</span> Obsidian Nimbus 插件对接与安装配置</h3>
          <p>为您的 Obsidian 笔记库快速生成同步插件所需的一键配置，支持 BRAT 自动安装与离线安装</p>
        </div>

        <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;">
          <div style="font-weight:600;font-size:13.5px;margin-bottom:8px;">📦 第一步：在 Obsidian 中安装同步插件</div>
          <p style="font-size:12.5px;color:var(--text-secondary);margin:0 0 10px 0;">
            推荐使用 <b>BRAT</b> (Beta Reviewers Auto-update Tester) 社区插件一键安装，支持手机端与桌面端自动更新：
          </p>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="text" id="cfg-brat-url" readonly value="${escapeHtml(bratRepoUrl)}" style="font-family:ui-monospace,monospace;font-size:12px;background:var(--bg);flex:1;" />
            <button id="copy-brat-url-btn" class="secondary" style="white-space:nowrap;">📋 复制 BRAT 链接</button>
          </div>
        </div>

        <div class="settings-card-header" style="margin-top:20px;">
          <h3><span>⚙️</span> 第二步：生成专属同步配置 (data.json)</h3>
          <p>选择您要绑定的笔记库与设备令牌：</p>
        </div>

        <div class="settings-form-grid" style="margin-bottom:16px;">
          <label>
            <span>选择目标笔记库 (Vault)</span>
            <select id="cfg-select-vault">${vaultOptions}</select>
          </label>
          <label>
            <span>选择连接授权令牌 (Auth Token)</span>
            <select id="cfg-select-token">${tokenOptions}</select>
          </label>
          <label>
            <span>设备标识名称 (Device Name)</span>
            <input type="text" id="cfg-device-name" value="${escapeHtml(state.user?.username ? state.user.username + '-Device' : 'Obsidian-Client')}" />
          </label>
          <label>
            <span>服务器地址 (Server URL)</span>
            <input type="text" id="cfg-server-url" value="${escapeHtml(serverOrigin)}" />
          </label>
        </div>

        <div class="nav-section-title">生成的插件配置文件 (<code>data.json</code>)</div>
        <pre class="code-snippet" id="generated-config-json" style="max-height:220px;"></pre>

        <div style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap;">
          <button id="copy-plugin-json-btn" class="btn-primary">📋 一键复制 data.json 配置</button>
          <button id="test-server-ping-btn" class="secondary">⚡ 测试服务器连接</button>
          <span id="test-server-ping-result"></span>
        </div>
      </div>
    `;

    function updateConfigJson() {
      const selectedVaultId = container.querySelector('#cfg-select-vault')?.value || currentVault.id;
      const selectedVault = state.vaults.find((v) => v.id === selectedVaultId) || currentVault;
      const selectedToken = container.querySelector('#cfg-select-token')?.value || state.token;
      const devName = container.querySelector('#cfg-device-name')?.value.trim() || 'Obsidian-Device';
      const srvUrl = (container.querySelector('#cfg-server-url')?.value.trim() || serverOrigin).replace(/\/+$/, '');
      const wsUrl = srvUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://') + '/ws';

      const config = {
        serverUrl: srvUrl,
        wsUrl: `${wsUrl}?vaultId=${selectedVault.id}&token=${selectedToken}&deviceId=${encodeURIComponent(devName)}`,
        vaultId: selectedVault.id,
        vaultName: selectedVault.name,
        token: selectedToken,
        authToken: selectedToken,
        deviceName: devName,
        autoSyncOnStartup: true,
        syncIntervalSeconds: 30,
        conflictStrategy: 'conflict_copy',
      };

      const pre = container.querySelector('#generated-config-json');
      if (pre) pre.textContent = JSON.stringify(config, null, 2);
    }

    updateConfigJson();

    container.querySelector('#cfg-select-vault')?.addEventListener('change', updateConfigJson);
    container.querySelector('#cfg-select-token')?.addEventListener('change', updateConfigJson);
    container.querySelector('#cfg-device-name')?.addEventListener('input', updateConfigJson);
    container.querySelector('#cfg-server-url')?.addEventListener('input', updateConfigJson);

    container.querySelector('#copy-brat-url-btn')?.addEventListener('click', () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(bratRepoUrl).then(() => toast('BRAT 插件仓库链接已复制'));
      }
    });

    container.querySelector('#copy-plugin-json-btn')?.addEventListener('click', () => {
      const text = container.querySelector('#generated-config-json')?.textContent || '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('✓ data.json 配置已复制到剪贴板！'));
      } else {
        prompt('复制配置：', text);
      }
    });

    container.querySelector('#test-server-ping-btn')?.addEventListener('click', async () => {
      const testRes = container.querySelector('#test-server-ping-result');
      testRes.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在探测服务端连通性…</span>';
      const start = Date.now();
      try {
        const res = await api('/api/health');
        const dur = Date.now() - start;
        if (res.ok) {
          testRes.innerHTML = `<span style="color:#2ecc71;font-size:13px;">✓ 服务端通信正常！HTTP 延迟: ${dur}ms, WebSocket 同步服务已就绪。</span>`;
        } else {
          testRes.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 服务端响应异常 (HTTP ${res.status})</span>`;
        }
      } catch (e) {
        testRes.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 连接测试失败: ${escapeHtml(e.message)}</span>`;
      }
    });
  } else if (subTab === 'sync') {
    const ignoreText = (settings.defaultIgnorePatterns || []).join('\n');

    container.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-header">
          <h3><span>🔄</span> 同步策略与冲突处理 (Nimbus Sync Engine)</h3>
          <p>控制文件冲突时的自动裁决机制、传输限制与全局忽略黑名单</p>
        </div>

        <div class="settings-form-grid" style="margin-bottom:16px;">
          <label>
            <span>冲突解决策略 (Conflict Resolution)</span>
            <select id="setting-conflict-strategy" ${!isAdmin ? 'disabled' : ''}>
              <option value="conflict_copy" ${settings.conflictStrategy === 'conflict_copy' ? 'selected' : ''}>
                自动生成冲突副本 (conflict_copy - 默认推荐，安全不丢数据)
              </option>
              <option value="overwrite_latest" ${settings.conflictStrategy === 'overwrite_latest' ? 'selected' : ''}>
                按修改时间覆盖 (overwrite_latest - 最新修改胜出)
              </option>
              <option value="server_win" ${settings.conflictStrategy === 'server_win' ? 'selected' : ''}>
                以服务器为准 (server_win - 服务端版本强制覆盖客户端)
              </option>
            </select>
            <div class="settings-help">当多台设备同时离线编辑同一篇笔记并上线合并时采取的策略</div>
          </label>

          <label>
            <span>WebSocket 心跳保活检测间隔 (秒)</span>
            <input type="number" id="setting-heartbeat" value="${settings.wsHeartbeatInterval || 30}" min="5" max="300" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">客户端与服务端的保活 Ping 频率，防止网络代理断开长连接</div>
          </label>

          <label>
            <span>单文件传输体积上限 (Max File Size, MB)</span>
            <input type="number" id="setting-max-filesize" value="${settings.maxFileSizeMb || 100}" min="1" max="2048" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">超过此大小的文件将跳过同步或发出超限警告</div>
          </label>

          <label>
            <span>大文件切片分片大小 (Chunk Size, MB)</span>
            <input type="number" id="setting-chunk-size" value="${settings.chunkSizeMb || 5}" min="1" max="50" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">对音视频或大文件进行流式切片传输的大小</div>
          </label>
        </div>

        <div class="settings-card-header" style="margin-top:20px;">
          <h3><span>📂</span> 同步范围与开关</h3>
        </div>

        <div class="settings-toggle-row">
          <div class="settings-toggle-info">
            <h4>同步 .obsidian 配置与插件外观目录</h4>
            <p>开启后将同步 Obsidian 的插件设置、快捷键与主题外观（.obsidian/ 目录）</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" id="setting-sync-config" ${settings.syncHiddenConfig ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''}>
            <span class="settings-slider"></span>
          </label>
        </div>

        <div class="settings-toggle-row">
          <div class="settings-toggle-info">
            <h4>同步附件与媒体文件 (Sync Attachments)</h4>
            <p>同步图片（PNG/JPG/SVG）、音频、视频、PDF 及常用附件文件</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" id="setting-sync-attachments" ${settings.syncAttachments ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''}>
            <span class="settings-slider"></span>
          </label>
        </div>

        <div class="settings-card-header" style="margin-top:20px;">
          <h3><span>🚫</span> 全局忽略规则黑名单 (Global Ignore Patterns)</h3>
          <p>匹配以下 Glob 通配符规则的文件或文件夹将自动被同步引擎忽略（每行一个规则）：</p>
        </div>

        <label>
          <textarea id="setting-ignore-patterns" rows="6" style="font-family:ui-monospace,monospace;font-size:12.5px;" ${!isAdmin ? 'disabled' : ''}>${escapeHtml(ignoreText)}</textarea>
          <div class="settings-help">支持标准 Glob 通配符，如 <code>.obsidian/workspace*.json</code>、<code>**/.git/**</code>、<code>**/*.tmp</code> 等</div>
        </label>

        <div style="display:flex;gap:12px;margin-top:20px;align-items:center;">
          ${isAdmin
            ? `<button id="sync-settings-save-btn" class="btn-primary">💾 保存同步策略设置</button>`
            : `<span style="color:var(--muted);font-size:13px;">🔒 全局同步策略仅管理员可修改，普通用户可查看。</span>`
          }
          <div id="sync-settings-result"></div>
        </div>
      </div>
    `;

    container.querySelector('#sync-settings-save-btn')?.addEventListener('click', async () => {
      const patterns = (container.querySelector('#setting-ignore-patterns').value || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      const updates = {
        conflictStrategy: container.querySelector('#setting-conflict-strategy').value,
        wsHeartbeatInterval: parseInt(container.querySelector('#setting-heartbeat').value, 10) || 30,
        maxFileSizeMb: parseInt(container.querySelector('#setting-max-filesize').value, 10) || 100,
        chunkSizeMb: parseInt(container.querySelector('#setting-chunk-size').value, 10) || 5,
        syncHiddenConfig: container.querySelector('#setting-sync-config').checked,
        syncAttachments: container.querySelector('#setting-sync-attachments').checked,
        defaultIgnorePatterns: patterns,
      };

      const resDiv = container.querySelector('#sync-settings-result');
      resDiv.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在保存设置…</span>';

      try {
        const res = await api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        const body = await res.json();
        if (body.ok) {
          resDiv.innerHTML = `<span style="color:#2ecc71;font-size:13px;">✓ ${escapeHtml(body.message || '设置已保存并持久化到数据库')}</span>`;
          toast('同步策略已更新');
        } else {
          resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 保存失败: ${escapeHtml(body.error)}</span>`;
        }
      } catch (e) {
        resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 保存失败: ${escapeHtml(e.message)}</span>`;
      }
    });
  } else if (subTab === 'database') {
    renderDatabaseSettingsSubtab(container);
  } else if (subTab === 'history') {
    container.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-header">
          <h3><span>🕒</span> 版本历史快照与回收站生命周期</h3>
          <p>管理笔记修改历史快照的版本上限、保存周期与回收站清理策略</p>
        </div>

        <div class="settings-form-grid" style="margin-bottom:16px;">
          <label>
            <span>单个文件最大历史版本数 (Max Versions)</span>
            <input type="number" id="setting-retention-count" value="${settings.versionRetentionCount || 30}" min="5" max="200" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">单个文件历史版本数超过设定值时，最早的旧快照将自动轮替清除</div>
          </label>

          <label>
            <span>历史版本最长保留天数 (Retention Days)</span>
            <input type="number" id="setting-retention-days" value="${settings.versionRetentionDays || 30}" min="1" max="365" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">超过此天数的历史快照将自动淘汰</div>
          </label>

          <label>
            <span>回收站软删除保留天数 (Trash Retention)</span>
            <input type="number" id="setting-trash-days" value="${settings.trashRetentionDays || 30}" min="1" max="365" ${!isAdmin ? 'disabled' : ''} />
            <div class="settings-help">在 Obsidian 中删除的文件将先放入服务端回收站，防止误删</div>
          </label>
        </div>

        <div class="settings-toggle-row">
          <div class="settings-toggle-info">
            <h4>自动定时垃圾回收清理 (Auto Purge)</h4>
            <p>服务器每日凌晨自动扫描并物理清除超出保留天数的过期垃圾文件</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" id="setting-auto-purge" ${settings.autoPurgeTrash ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''}>
            <span class="settings-slider"></span>
          </label>
        </div>

        <div style="display:flex;gap:12px;margin-top:20px;align-items:center;flex-wrap:wrap;">
          ${isAdmin ? `<button id="history-settings-save-btn" class="btn-primary">💾 保存版本生命周期设置</button>` : ''}
          <button id="purge-all-trash-btn" class="btn-secondary" style="color:var(--danger);border-color:rgba(248,81,73,0.3);">
            🧹 清空当前 Vault 回收站
          </button>
          <div id="history-settings-result"></div>
        </div>
      </div>
    `;

    container.querySelector('#history-settings-save-btn')?.addEventListener('click', async () => {
      const updates = {
        versionRetentionCount: parseInt(container.querySelector('#setting-retention-count').value, 10) || 30,
        versionRetentionDays: parseInt(container.querySelector('#setting-retention-days').value, 10) || 30,
        trashRetentionDays: parseInt(container.querySelector('#setting-trash-days').value, 10) || 30,
        autoPurgeTrash: container.querySelector('#setting-auto-purge').checked,
      };

      const resDiv = container.querySelector('#history-settings-result');
      resDiv.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在保存设置…</span>';

      try {
        const res = await api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        const body = await res.json();
        if (body.ok) {
          resDiv.innerHTML = `<span style="color:#2ecc71;font-size:13px;">✓ ${escapeHtml(body.message || '设置已保存')}</span>`;
          toast('版本保留设置已更新');
        } else {
          resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 保存失败: ${escapeHtml(body.error)}</span>`;
        }
      } catch (e) {
        resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 保存失败: ${escapeHtml(e.message)}</span>`;
      }
    });

    container.querySelector('#purge-all-trash-btn')?.addEventListener('click', async () => {
      const ok = await showConfirm({
        title: '清空回收站确认',
        message: `确定要清空 Vault「${currentVault.name}」的所有回收站文件吗？此操作无法撤销。`,
        confirmText: '清空回收站',
        type: 'danger',
        icon: '🗑️',
      });
      if (!ok) return;
      try {
        const res = await api(`/api/vaults/${currentVault.id}/trash/purge-all`, { method: 'POST' });
        const body = await res.json();
        toast(`已彻底清理 ${body.purgedCount || 0} 个回收站文件`);
      } catch (e) {
        toast(`清理失败: ${e.message}`);
      }
    });
  } else if (subTab === 'tokens') {
    function getTokenExpiryInfo(t) {
      let expiresAt = t.expiresAt || null;
      let durationText = t.durationText || '';
      let isExpired = t.isExpired || false;

      if ((!expiresAt || !durationText) && t.token) {
        try {
          const parts = t.token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
            if (payload.exp) {
              expiresAt = payload.exp * 1000;
              isExpired = Date.now() > expiresAt;
              const totalSecs = payload.iat ? payload.exp - payload.iat : Math.round((expiresAt - (t.createdAt || Date.now())) / 1000);
              const days = Math.round(totalSecs / 86400);
              if (days >= 3600) {
                durationText = '永久有效 (10 年)';
              } else if (days >= 350) {
                durationText = '1 年 (365 天)';
              } else if (days >= 80 && days <= 100) {
                durationText = '90 天';
              } else if (days >= 25 && days <= 35) {
                durationText = '30 天';
              } else {
                durationText = `${days} 天`;
              }
            }
          }
        } catch (e) {}
      }

      if (!durationText) durationText = '1 年 (365 天)';
      return { expiresAt, durationText, isExpired };
    }

    function renderTokenTableBody() {
      if (!tokensList || tokensList.length === 0) {
        return `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">暂无专属设备令牌，您可点击下方创建</td></tr>`;
      }
      return tokensList.map((t) => {
        const displayMasked = t.maskedToken || (t.token ? `${t.token.slice(0, 10)}...${t.token.slice(-6)}` : '******');
        const { expiresAt, durationText, isExpired } = getTokenExpiryInfo(t);
        const expiryHtml = isExpired
          ? `<span style="color:var(--danger);font-size:12px;font-weight:500;" title="令牌已过期">⚠️ ${new Date(expiresAt).toLocaleString()} (已过期)</span>`
          : expiresAt
          ? `<span style="color:var(--text-secondary);font-size:12px;">${new Date(expiresAt).toLocaleString()}</span>`
          : `<span style="color:var(--muted);font-size:12px;">永久有效</span>`;

        return `
          <tr id="token-row-${t.id}">
            <td><b>${escapeHtml(t.label || '设备')}</b></td>
            <td>
              <div class="token-val-box">
                <code id="token-display-${t.id}">${escapeHtml(displayMasked)}</code>
                <button class="token-act-btn token-toggle-btn" data-tokenid="${t.id}" data-state="masked" title="查看 / 隐藏完整令牌">👁️ 查看</button>
                <button class="token-act-btn primary token-copy-btn" data-token="${escapeHtml(t.token || '')}" title="复制完整令牌">📋 复制</button>
              </div>
            </td>
            <td>
              <span class="token-duration-badge" style="display:inline-block;background:var(--panel-2);border:1px solid var(--border);padding:2px 8px;border-radius:10px;font-size:11.5px;color:var(--text-secondary);white-space:nowrap;">
                ${escapeHtml(durationText)}
              </span>
            </td>
            <td>${expiryHtml}</td>
            <td style="color:var(--muted);font-size:12px;">${new Date(t.createdAt).toLocaleString()}</td>
            <td style="color:var(--muted);font-size:12px;">${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '<span style="color:var(--muted)">从未使用</span>'}</td>
            <td>
              <div style="display:flex;gap:4px;align-items:center;flex-wrap:nowrap;">
                <button class="btn-sm secondary token-cfg-btn" data-tokenid="${t.id}" title="查看并复制对应 Obsidian 插件配置">⚡ 配置</button>
                <button class="btn-sm secondary token-extend-btn" data-tokenid="${t.id}" title="手动延长此令牌的到期时间" style="color:var(--accent);">⏳ 延期</button>
                <button class="btn-sm secondary token-renew-btn" data-tokenid="${t.id}" title="重新生成新的访问令牌（旧令牌失效）">🔄 重签</button>
                <button class="btn-sm ghost token-del-btn" data-tokenid="${t.id}" title="注销设备令牌" style="color:var(--danger)">注销</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    container.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-header">
          <h3><span>🔑</span> 多端专属设备令牌 (Device Access Tokens)</h3>
          <p>为每台设备（如 MacBook、iPhone、Windows 办公电脑）签发独立 Token，支持随时查看、复制、到期延期、重新生成与注销，各端独立鉴权便于安全管理</p>
        </div>

        <div class="token-table-wrap" style="margin-bottom:20px;">
          <table class="token-table">
            <thead>
              <tr>
                <th style="width:130px;">设备名称 / 备注</th>
                <th>访问令牌 (Token)</th>
                <th style="width:110px;">令牌期限</th>
                <th style="width:155px;">到期时间</th>
                <th style="width:150px;">创建时间</th>
                <th style="width:150px;">最近活跃</th>
                <th style="width:215px;">操作</th>
              </tr>
            </thead>
            <tbody id="tokens-table-tbody">
              ${renderTokenTableBody()}
            </tbody>
          </table>
        </div>

        <div id="new-token-display-box" style="margin-bottom:20px;"></div>

        <div class="settings-card-header" style="margin-top:24px;">
          <h3><span>➕</span> 新建专属设备 Token</h3>
          <p>创建后系统将自动保存并支持随时查看或复制，可直接用于 Obsidian 同步插件鉴权</p>
        </div>

        <div class="settings-form-grid" style="align-items:flex-end;">
          <label>
            <span>设备名称 / 备注 (如: iMac 27-inch, iPhone 16)</span>
            <input type="text" id="new-token-label" placeholder="例如: MacBook-Pro-Work" required />
          </label>

          <label>
            <span>令牌有效期 (Token Expiration)</span>
            <select id="new-token-expiry">
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365" selected>1 年 (365 天)</option>
              <option value="3650">永久有效 (10 年)</option>
            </select>
          </label>

          <div style="padding-bottom:14px;">
            <button id="create-token-btn" class="btn-primary">＋ 生成设备 Token</button>
          </div>
        </div>
      </div>
    `;

    function bindTokenRowEvents() {
      container.querySelectorAll('.token-toggle-btn').forEach((btn) => {
        btn.onclick = () => {
          const tid = btn.dataset.tokenid;
          const targetToken = tokensList.find((t) => t.id === tid);
          const codeEl = container.querySelector(`#token-display-${tid}`);
          if (!targetToken || !codeEl) return;

          if (!targetToken.token) {
            toast('🔒 出于安全防护，完整 Token 仅在创建或重签时明文可见。如需新凭证请点击「🔄 重签」');
            return;
          }

          const isMasked = btn.dataset.state === 'masked';
          if (isMasked) {
            codeEl.textContent = targetToken.token;
            codeEl.style.color = '#3fb950';
            btn.dataset.state = 'revealed';
            btn.textContent = '🙈 隐藏';
          } else {
            codeEl.textContent = targetToken.maskedToken || `${targetToken.token.slice(0, 10)}...${targetToken.token.slice(-6)}`;
            codeEl.style.color = 'var(--accent)';
            btn.dataset.state = 'masked';
            btn.textContent = '👁️ 查看';
          }
        };
      });

      container.querySelectorAll('.token-copy-btn').forEach((btn) => {
        btn.onclick = () => {
          const token = btn.dataset.token;
          if (!token) {
            toast('🔒 出于安全防护，长期 Token 仅在创建或重签时展示一次。点击「🔄 重签」可生成新令牌并立即复制。');
            return;
          }
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(token).then(() => toast('✓ 设备 Token 已复制到剪贴板！'));
          } else {
            prompt('复制设备 Token：', token);
          }
        };
      });

      container.querySelectorAll('.token-cfg-btn').forEach((btn) => {
        btn.onclick = () => {
          const tid = btn.dataset.tokenid;
          const targetToken = tokensList.find((t) => t.id === tid);
          if (!targetToken) return;

          const serverUrl = serverOrigin.replace(/\/+$/, '');
          const wsUrl = serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://') + '/ws';
          const devName = targetToken.label || 'Obsidian-Device';
          const cfg = {
            serverUrl,
            wsUrl: `${wsUrl}?vaultId=${currentVault.id}&token=${targetToken.token || ''}&deviceId=${encodeURIComponent(devName)}`,
            vaultId: currentVault.id,
            token: targetToken.token || '',
            authToken: targetToken.token || '',
            deviceName: devName,
            autoSyncOnStartup: true,
          };

          const modalHtml = `
            <div class="modal-header">
              <h3>📱 设备「${escapeHtml(targetToken.label)}」Obsidian 配置</h3>
              <button class="modal-close ghost">✕</button>
            </div>
            <div class="modal-body">
              <p style="color:var(--text-secondary);margin-bottom:12px;">
                以下是为设备 <b>${escapeHtml(targetToken.label)}</b> 生成的独立专属同步配置：
              </p>
              <div class="nav-section-title">配置文件 <code>data.json</code></div>
              <pre class="code-snippet" style="max-height:220px;">${escapeHtml(JSON.stringify(cfg, null, 2))}</pre>
              <p style="color:var(--muted);font-size:12px;margin-top:10px;">
                💡 复制后可直接保存至该设备 Obsidian 库目录 <code>.obsidian/plugins/nimbus/data.json</code>。
              </p>
            </div>
            <div class="modal-footer">
              <button id="modal-copy-device-cfg-btn" class="btn-primary">📋 复制 data.json 配置</button>
              <button class="modal-close secondary">关闭</button>
            </div>
          `;
          showModal(modalHtml, (diag) => {
            diag.querySelector('#modal-copy-device-cfg-btn').onclick = () => {
              const text = JSON.stringify(cfg, null, 2);
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(() => toast('配置已复制到剪贴板！'));
              } else {
                prompt('复制配置：', text);
              }
            };
          });
        };
      });

      container.querySelectorAll('.token-extend-btn').forEach((btn) => {
        btn.onclick = () => {
          const tid = btn.dataset.tokenid;
          const targetToken = tokensList.find((t) => t.id === tid);
          if (!targetToken) return;

          const { expiresAt, isExpired } = getTokenExpiryInfo(targetToken);
          const currentExpiryText = isExpired
            ? `<span style="color:var(--danger);font-weight:600;">⚠️ 已于 ${new Date(expiresAt).toLocaleString()} 过期</span>`
            : expiresAt
            ? `<span style="color:var(--text);font-weight:500;">${new Date(expiresAt).toLocaleString()}</span>`
            : `<span style="color:var(--muted)">永久有效</span>`;

          const modalHtml = `
            <div class="modal-header">
              <h3>⏳ 延长设备令牌有效期</h3>
              <button class="modal-close ghost">✕</button>
            </div>
            <div class="modal-body">
              <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:16px;">
                <div style="font-size:13.5px;color:var(--text);margin-bottom:4px;">设备名称：<b>${escapeHtml(targetToken.label)}</b></div>
                <div style="font-size:12.5px;color:var(--text-secondary);">当前状态：${currentExpiryText}</div>
              </div>

              <label style="display:block;margin-bottom:14px;">
                <span style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:var(--text);">选择延长时长 (Extend Duration)</span>
                <select id="modal-extend-days-select" class="form-control" style="width:100%;">
                  <option value="30">+ 30 天 (1 个月)</option>
                  <option value="90">+ 90 天 (3 个月)</option>
                  <option value="365" selected>+ 1 年 (365 天)</option>
                  <option value="3650">+ 永久有效 (10 年)</option>
                </select>
              </label>

              <p style="color:var(--muted);font-size:12px;margin:0;line-height:1.5;">
                💡 <b>平滑延期说明</b>：若令牌未过期，将在原到期时间基础上顺延；若已过期，将从即日起延长。
              </p>
            </div>
            <div class="modal-footer">
              <button id="modal-confirm-extend-btn" class="btn-primary">⏳ 确认延长有效期</button>
              <button class="modal-close secondary">取消</button>
            </div>
          `;

          showModal(modalHtml, (diag) => {
            diag.querySelector('#modal-confirm-extend-btn').onclick = async () => {
              const days = diag.querySelector('#modal-extend-days-select')?.value || '365';
              try {
                const res = await api(`/api/settings/tokens/${tid}/extend`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ extendDays: days }),
                });
                const body = await res.json();
                if (body.ok && body.token) {
                  tokensList = tokensList.map((t) => (t.id === tid ? body.token : t));
                  const tbody = container.querySelector('#tokens-table-tbody');
                  if (tbody) tbody.innerHTML = renderTokenTableBody();
                  bindTokenRowEvents();
                  closeModal();
                  toast(`✓ 设备「${targetToken.label}」令牌已成功延长！`);
                } else {
                  toast(`延期失败: ${body.error || '未知错误'}`);
                }
              } catch (err) {
                toast(`延期失败: ${err.message}`);
              }
            };
          });
        };
      });

      container.querySelectorAll('.token-del-btn').forEach((btn) => {
        btn.onclick = async () => {
          const tid = btn.dataset.tokenid;
          const targetToken = tokensList.find((t) => t.id === tid);
          const label = targetToken?.label || '该设备';
          const ok = await showConfirm({
            title: '注销设备专属令牌',
            message: `确定要注销并废除「${label}」的专属令牌吗？注销后该设备将无法继续同步。`,
            confirmText: '确认注销',
            type: 'danger',
            icon: '🔑',
          });
          if (!ok) return;
          try {
            const res = await api(`/api/settings/tokens/${tid}`, { method: 'DELETE' });
            const body = await res.json();
            if (body.ok) {
              toast(`设备令牌「${label}」已注销`);
              tokensList = tokensList.filter((t) => t.id !== tid);
              const tbody = container.querySelector('#tokens-table-tbody');
              if (tbody) tbody.innerHTML = renderTokenTableBody();
              bindTokenRowEvents();
            } else {
              toast(`注销失败: ${body.error || '未知错误'}`);
            }
          } catch (e) {
            toast(`注销失败: ${e.message}`);
          }
        };
      });
    }

    bindTokenRowEvents();

    container.querySelector('#create-token-btn')?.addEventListener('click', async () => {
      const label = container.querySelector('#new-token-label').value.trim();
      const expiry = container.querySelector('#new-token-expiry').value;
      if (!label) {
        toast('请输入设备名称或备注');
        return;
      }

      try {
        const res = await api('/api/settings/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, expiresInDays: expiry }),
        });
        const body = await res.json();
        if (body.ok && body.token) {
          const newToken = body.token;
          tokensList = [newToken, ...tokensList.filter((t) => t.id !== newToken.id)];
          container.querySelector('#new-token-label').value = '';
          const tbody = container.querySelector('#tokens-table-tbody');
          if (tbody) tbody.innerHTML = renderTokenTableBody();
          bindTokenRowEvents();

          const display = container.querySelector('#new-token-display-box');
          display.innerHTML = `
            <div style="background:var(--panel-2);border:1px solid #2ecc71;border-radius:var(--radius);padding:16px;position:relative;">
              <button id="close-token-success-btn" style="position:absolute;top:10px;right:10px;background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;">✕</button>
              <div style="color:#2ecc71;font-weight:600;font-size:14px;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                <span>✓</span> 设备专属令牌「${escapeHtml(newToken.label)}」创建成功！
              </div>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:10px;">
                您可以立即复制下方 Token 填入 Obsidian 插件：
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" readonly value="${escapeHtml(newToken.token)}" id="created-token-value" style="font-family:ui-monospace,monospace;font-size:12px;background:var(--panel-3);border:1px solid var(--border);flex:1;" />
                <button id="copy-created-token-btn" class="btn-primary" style="flex-shrink:0;">📋 复制 Token</button>
              </div>
            </div>
          `;

          container.querySelector('#close-token-success-btn')?.addEventListener('click', () => {
            display.innerHTML = '';
          });

          container.querySelector('#copy-created-token-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(newToken.token).then(() => {
              toast('Token 已复制到剪贴板！');
            });
          });

          toast(`✓ 设备令牌「${newToken.label}」创建成功`);
        } else {
          toast(`创建失败: ${body.error || '未知错误'}`);
        }
      } catch (e) {
        toast(`创建失败: ${e.message}`);
      }
    });
  } else if (subTab === 'account') {
    const currentTheme = localStorage.getItem('nimbus_theme') || 'cyber-blue';
    const currentFontSize = localStorage.getItem('nimbus_font_size') || 'normal';

    container.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-header">
          <h3><span>🎨</span> 界面外观与个性化设置</h3>
          <p>选择您喜欢的后台配色风格与界面字体比例，支持实时切换并自动保存偏好</p>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;">精选主题风格</div>
          <button class="btn btn-outline" id="settings-open-theme-gallery-btn" style="padding:4px 10px;font-size:12px;">🎨 打开 13 款主题画廊</button>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(210px, 1fr));gap:10px;margin-bottom:24px;">
          ${THEMES.slice(0, 6)
            .map((th) => {
              const isSel = currentTheme === th.id;
              return `
                <div class="theme-card-picker ${isSel ? 'selected' : ''}" data-val="${th.id}" style="cursor:pointer;padding:10px 12px;background:var(--panel-2);border:1px solid ${isSel ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius);display:flex;align-items:center;gap:10px;transition:all 0.15s;">
                  <span class="dot" style="width:14px;height:14px;border-radius:50%;background:${th.primaryColor};box-shadow:0 0 8px ${th.primaryColor};flex-shrink:0;"></span>
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(th.name)}</div>
                    <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(th.subtitle.split('，')[0])}</div>
                  </div>
                  ${isSel ? '<span style="color:var(--accent);font-weight:700;font-size:13px;">✓</span>' : ''}
                </div>
              `;
            })
            .join('')}
        </div>

        <div class="settings-card-header">
          <h3><span>👤</span> 个人账户信息</h3>
          <p>查看当前登录用户凭证</p>
        </div>

        <div style="display:grid;grid-template-columns:120px 1fr;gap:10px 14px;font-size:13.5px;margin-bottom:24px;background:var(--panel-2);padding:16px;border-radius:var(--radius);border:1px solid var(--border);">
          <span style="color:var(--muted)">当前登录用户:</span>
          <span><b>${escapeHtml(state.user?.username)}</b></span>
          <span style="color:var(--muted)">权限角色:</span>
          <span><span class="badge">${state.user?.role === 'admin' ? '系统管理员' : '标准用户'}</span></span>
          <span style="color:var(--muted)">用户 ID:</span>
          <code style="font-size:12px">${state.user?.id || 'N/A'}</code>
        </div>

        <div class="settings-card-header">
          <h3><span>🔒</span> 修改登录密码</h3>
          <p>定期更新密码以保证多端同步数据的安全性</p>
        </div>

        <form id="change-password-form" style="max-width:420px;">
          <label>
            <span>原密码 (Current Password)</span>
            <input type="password" id="old-password" required autocomplete="current-password" placeholder="输入当前使用的密码" />
          </label>
          <label>
            <span>新密码 (New Password)</span>
            <input type="password" id="new-password" required autocomplete="new-password" placeholder="至少4位字符" minlength="4" />
          </label>
          <label>
            <span>确认新密码 (Confirm New Password)</span>
            <input type="password" id="confirm-password" required autocomplete="new-password" placeholder="再次输入新密码" minlength="4" />
          </label>

          <div id="password-change-result" style="margin:10px 0;"></div>

          <button type="submit" class="btn-primary" style="margin-top:8px;">确认修改密码</button>
        </form>
      </div>
    `;

    container.querySelector('#settings-open-theme-gallery-btn')?.addEventListener('click', () => {
      openThemeSelectorModal();
    });

    container.querySelectorAll('.theme-card-picker').forEach((card) => {
      card.addEventListener('click', () => {
        const val = card.dataset.val;
        applyTheme(val);
        const name = THEME_LABELS[val] || val;
        toast(`已切换至「${name}」风格`);
        renderSettingsPanel('account');
      });
    });

    container.querySelector('#change-password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPassword = container.querySelector('#old-password').value;
      const newPassword = container.querySelector('#new-password').value;
      const confirmPassword = container.querySelector('#confirm-password').value;
      const resultDiv = container.querySelector('#password-change-result');

      if (newPassword !== confirmPassword) {
        resultDiv.innerHTML = '<span style="color:#e74c3c;font-size:13px;">✕ 两次输入的新密码不一致</span>';
        return;
      }

      resultDiv.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在提交修改…</span>';

      try {
        const res = await api('/api/settings/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword, newPassword }),
        });
        const body = await res.json();
        if (body.ok) {
          resultDiv.innerHTML = `<span style="color:#2ecc71;font-size:13px;">✓ ${escapeHtml(body.message || '密码修改成功')}</span>`;
          toast('密码修改成功');
          container.querySelector('#old-password').value = '';
          container.querySelector('#new-password').value = '';
          container.querySelector('#confirm-password').value = '';
        } else {
          resultDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 修改失败: ${escapeHtml(body.error || '原密码错误')}</span>`;
        }
      } catch (err) {
        resultDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 请求错误: ${escapeHtml(err.message)}</span>`;
      }
    });
  }

  translate(mainPanel);
}
