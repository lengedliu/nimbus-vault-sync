// --------------------------- Connect, MCP, Docs & Global Search Modals ---------------------------
import { state, $, escapeHtml } from '../core/state.js';
import { api } from '../core/api.js';
import { showModal, toast } from '../core/dialogs.js';

export async function showObsidianConnectModal(vault, initialToken, initialDeviceName) {
  const serverUrl = state.serverBase.replace(/\/$/, '');
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  const vaultObj = typeof vault === 'string'
    ? (state.vaults.find((v) => v.id === vault) || { id: vault, name: vault })
    : (vault || state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0] || { id: 'YOUR_VAULT_ID', name: 'Vault' });
  const vaultId = vaultObj?.id || 'YOUR_VAULT_ID';
  const vaultName = vaultObj?.name || 'Vault';
  const bratRepoUrl = 'https://github.com/lengedliu/nimbus-vault-sync';

  let userTokens = [];
  try {
    const res = await api('/api/devices');
    const data = await res.json();
    if (data && data.devices) {
      userTokens = data.devices.map((d) => ({
        id: d.id,
        label: d.deviceName || d.name || 'Obsidian Client',
        token: d.token,
        maskedToken: d.tokenPreview || (d.token ? `${d.token.slice(0, 10)}...${d.token.slice(-6)}` : ''),
      }));
    }
  } catch {}

  let currentToken = initialToken || state.token;
  let currentDevice = initialDeviceName || (state.user?.username ? `${state.user.username}-Obsidian` : 'Client-Obsidian');

  const tokenOptions = [
    `<option value="${state.token}" ${currentToken === state.token ? 'selected' : ''}>🔑 当前主登录令牌 (${state.user?.username || 'Main User'})</option>`,
    ...userTokens.map((t) => `<option value="${escapeHtml(t.token || state.token)}" ${currentToken === t.token ? 'selected' : ''}>📱 [专属设备] ${escapeHtml(t.label)} (${escapeHtml(t.maskedToken || '')})</option>`),
  ].join('');

  function buildConfig(selectedToken, deviceName) {
    return {
      serverUrl,
      wsUrl: `${wsUrl}?vaultId=${vaultId}&token=${selectedToken}&deviceId=${encodeURIComponent(deviceName)}`,
      vaultId,
      vaultName,
      token: selectedToken,
      authToken: selectedToken,
      deviceName,
      autoSyncOnStartup: true,
      syncIntervalSeconds: 30,
      conflictStrategy: 'conflict_copy',
    };
  }

  let pluginConfig = buildConfig(currentToken, currentDevice);

  const html = `
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">⚡</span>
        <div>
          <h3 style="margin:0;font-size:16px;">Obsidian 插件安装与对接配置</h3>
          <div style="font-size:11.5px;color:var(--muted)">支持 BRAT 一键安装、手动安装与 data.json 快速导入</div>
        </div>
      </div>
      <button class="modal-close ghost">✕</button>
    </div>

    <div class="modal-body" style="max-height:72vh;overflow-y:auto;padding:16px 20px;">
      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;">
            <span>📦 步骤 1：在 Obsidian 中安装同步插件</span>
          </div>
          <span style="font-size:11px;background:rgba(88,166,255,0.15);color:#58a6ff;padding:2px 8px;border-radius:10px;font-weight:600;">首推 BRAT 安装</span>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px;">
          <button id="modal-install-tab-brat" class="btn-sm primary" style="font-size:12px;padding:4px 12px;border-radius:4px;">✨ 方式一：通过 BRAT 一键安装 (推荐)</button>
          <button id="modal-install-tab-manual" class="btn-sm secondary" style="font-size:12px;padding:4px 12px;border-radius:4px;">📁 方式二：手动解压安装</button>
        </div>

        <div id="modal-install-panel-brat" style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;">
          <div style="background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.25);border-radius:6px;padding:8px 12px;margin-bottom:10px;color:var(--text);font-size:12px;">
            💡 <b>什么是 BRAT？</b> Obsidian 官方社区最流行的插件测试与安装神器 (Beta Reviewers Auto-update Tester)，支持桌面端与手机端通过 GitHub 链接一键下载安装与自动更新，免去手动解压。
          </div>
          <ol style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:6px;">
            <li><b>安装 BRAT 插件</b>：在 Obsidian 中进入 <code>设置</code> ➔ <code>第三方插件</code> ➔ 社区插件市场中搜索 <b>BRAT</b> 并安装启用。</li>
            <li><b>打开 BRAT 设置</b>：在 Obsidian 左侧设置中找到 <b>BRAT</b>，或按快捷键 <kbd>Ctrl/Cmd + P</kbd> 输入 <code>BRAT: Add a beta plugin for testing</code>。</li>
            <li><b>添加插件仓库</b>：点击 <b>Add Beta plugin</b> 按钮，在弹出的输入框中粘贴下方 GitHub 仓库地址：
              <div style="display:flex;gap:6px;align-items:center;margin:6px 0;">
                <input type="text" id="modal-brat-repo-input" readonly value="${escapeHtml(bratRepoUrl)}" style="margin:0;padding:5px 8px;font-size:12px;font-family:ui-monospace,monospace;flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);" />
                <button id="modal-copy-brat-btn" class="token-act-btn primary" style="padding:4px 10px;font-size:12px;white-space:nowrap;">📋 复制仓库链接</button>
              </div>
            </li>
            <li><b>激活并配置</b>：点击 <b>Add Plugin</b> 确认，BRAT 将在几秒内自动下载并启用 <b>Nimbus Sync</b> 插件！</li>
          </ol>
        </div>

        <div id="modal-install-panel-manual" style="display:none;font-size:12.5px;color:var(--text-secondary);line-height:1.7;">
          <ol style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:6px;">
            <li>在本地电脑打开您的 Obsidian 笔记库根目录，进入 <code>.obsidian/plugins/</code> 文件夹。</li>
            <li>新建名为 <code>nimbus-sync</code> 的子文件夹（即完整路径 <code>.obsidian/plugins/nimbus-sync/</code>）。</li>
            <li>将插件的 <code>main.js</code>、<code>manifest.json</code>、<code>styles.css</code> 以及下方生成的 <code>data.json</code> 放入该目录中。</li>
            <li>打开 Obsidian <code>设置</code> ➔ <code>第三方插件</code>，点击“重新加载插件”，然后启用 <b>Nimbus Sync</b>。</li>
          </ol>
        </div>
      </div>

      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;">
        <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;display:flex;align-items:center;gap:6px;">
          <span>🔑 步骤 2：填入连接参数或导入配置</span>
        </div>

        <div style="display:grid;grid-template-columns:120px 1fr;gap:10px 12px;font-size:13px;align-items:center;">
          <span style="color:var(--muted)">目标笔记库:</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <b>📓 ${escapeHtml(vaultName)}</b>
            <code style="font-size:11.5px;color:var(--muted);background:var(--bg);padding:2px 6px;border-radius:4px;border:1px solid var(--border);">${vaultId}</code>
          </div>

          <span style="color:var(--muted)">服务器地址:</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="modal-server-preview" readonly value="${escapeHtml(serverUrl)}" style="margin:0;padding:5px 8px;font-size:12px;font-family:ui-monospace,monospace;flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);" />
            <button id="modal-copy-server-btn" class="token-act-btn" style="padding:4px 8px;">📋 复制</button>
          </div>

          <span style="color:var(--muted)">授权访问令牌:</span>
          <select id="modal-token-select" style="margin:0;padding:5px 8px;font-size:12.5px;">
            ${tokenOptions}
          </select>

          <span style="color:var(--muted)">客户端设备标识:</span>
          <input type="text" id="modal-device-input" value="${escapeHtml(currentDevice)}" placeholder="例如: MacBook-Pro, iPad" style="margin:0;padding:5px 8px;font-size:12.5px;" />
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-close btn-primary">完成</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const bratTab = dialog.querySelector('#modal-install-tab-brat');
    const manualTab = dialog.querySelector('#modal-install-tab-manual');
    const bratPanel = dialog.querySelector('#modal-install-panel-brat');
    const manualPanel = dialog.querySelector('#modal-install-panel-manual');
    const copyBratBtn = dialog.querySelector('#modal-copy-brat-btn');
    const copyServerBtn = dialog.querySelector('#modal-copy-server-btn');

    if (bratTab && manualTab) {
      bratTab.onclick = () => {
        bratTab.className = 'btn-sm primary';
        manualTab.className = 'btn-sm secondary';
        bratPanel.style.display = 'block';
        manualPanel.style.display = 'none';
      };
      manualTab.onclick = () => {
        manualTab.className = 'btn-sm primary';
        bratTab.className = 'btn-sm secondary';
        bratPanel.style.display = 'none';
        manualPanel.style.display = 'block';
      };
    }

    if (copyBratBtn) {
      copyBratBtn.onclick = () => {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(bratRepoUrl).then(() => toast('BRAT 插件仓库链接已复制'));
        }
      };
    }

    if (copyServerBtn) {
      copyServerBtn.onclick = () => {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(serverUrl).then(() => toast('服务器地址已复制'));
        }
      };
    }
  });
}

export async function showMcpModal(defaultVaultName) {
  const selectedVaultName = defaultVaultName || (state.vaults && state.vaults[0] ? state.vaults[0].name : '');
  let toolsData = [];
  try {
    const res = await api('/api/mcp/tools');
    const data = await res.json();
    if (data && data.tools) {
      toolsData = data.tools;
    }
  } catch {
    toolsData = [];
  }

  function generateConfig(vaultName) {
    return {
      mcpServers: {
        'nimbus-fast-note-sync': {
          url: state.serverBase.replace(/\/$/, '') + '/api/mcp',
          type: 'http',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.token}`,
            'X-Default-Vault-Name': vaultName,
          },
        },
      },
    };
  }

  const initialConfig = JSON.stringify(generateConfig(selectedVaultName), null, 2);

  const html = `
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:18px">🤖</span>
        <div>
          <h3 style="margin:0;font-size:16px">Model Context Protocol (MCP) 服务与工具接口</h3>
          <div style="font-size:11.5px;color:var(--muted)">支持 Cursor、Cherry Studio、Claude Desktop、Cline 等 AI 客户端实时读写 Obsidian 笔记</div>
        </div>
      </div>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="mcp-nav-tabs">
      <button class="mcp-nav-tab active" id="mcp-tab-config-btn">⚙️ 客户端连接配置</button>
      <button class="mcp-nav-tab" id="mcp-tab-tools-btn">🛠️ 18 个 MCP 工具清单 (${toolsData.length || 18})</button>
    </div>
    <div class="modal-body" style="max-height:65vh;overflow-y:auto;padding:16px 20px;">
      <div id="mcp-tab-config-view">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:13px;color:var(--text-secondary)">选择绑定的默认笔记库：</div>
          <select id="mcp-vault-select" style="padding:4px 10px;font-size:12.5px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text);">
            ${(state.vaults || []).map((v) => `<option value="${escapeHtml(v.name)}" ${v.name === selectedVaultName ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <pre class="code-snippet" id="mcp-config-code" style="max-height:220px">${escapeHtml(initialConfig)}</pre>
      </div>
    </div>
    <div class="modal-footer">
      <button id="copy-mcp-btn" class="btn-primary">📋 复制当前 MCP 配置</button>
      <button class="modal-close secondary">关闭</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const copyBtn = dialog.querySelector('#copy-mcp-btn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const text = initialConfig;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(() => toast('MCP JSON 配置已复制到剪贴板'));
        }
      };
    }
  });
}
