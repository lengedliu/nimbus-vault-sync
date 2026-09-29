// --------------------------- Connect, MCP, Docs & Global Search Modals ---------------------------
import { state, $, escapeHtml } from '../core/state.js';
import { api } from '../core/api.js';
import { showModal, toast } from '../core/dialogs.js';
import { generateQRCodeSVG } from '../core/qrcode.js';

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

  const defaultMainDevice = state.user?.username ? `${state.user.username}-Obsidian` : 'Client-Obsidian';
  let currentToken = initialToken || state.token;
  let currentDevice = initialDeviceName || defaultMainDevice;

  const tokenOptions = [
    `<option value="${state.token}" data-devicename="${escapeHtml(defaultMainDevice)}" ${currentToken === state.token ? 'selected' : ''}>🔑 当前主登录令牌 (${state.user?.username || 'Main User'})</option>`,
    ...userTokens.map((t) => `<option value="${escapeHtml(t.token || state.token)}" data-devicename="${escapeHtml(t.label || '')}" ${currentToken === t.token ? 'selected' : ''}>📱 [专属设备] ${escapeHtml(t.label)} (${escapeHtml(t.maskedToken || '')})</option>`),
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

  function buildDeepLink(selectedToken, deviceName) {
    const params = new URLSearchParams({
      server: serverUrl,
      vaultId,
      vaultName,
      token: selectedToken,
      device: deviceName,
      autoSync: '1',
    });
    return `obsidian://nimbus-sync?${params.toString()}`;
  }

  let pluginConfig = buildConfig(currentToken, currentDevice);
  let deepLinkUrl = buildDeepLink(currentToken, currentDevice);
  const qrSvg = generateQRCodeSVG(JSON.stringify(pluginConfig), { size: 160 });

  const html = `
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">⚡</span>
        <div>
          <h3 style="margin:0;font-size:16px;">Obsidian 插件安装与多端对接</h3>
          <div style="font-size:11.5px;color:var(--muted)">支持手机扫码直连、BRAT 一键安装与 data.json 快速导入</div>
        </div>
      </div>
      <button class="modal-close ghost">✕</button>
    </div>

    <div class="modal-body" style="max-height:74vh;overflow-y:auto;padding:16px 20px;">
      <!-- STEP 1: Installation method selection -->
      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;">
            <span>📦 步骤 1：在 Obsidian 中安装同步插件</span>
          </div>
          <span style="font-size:11px;background:rgba(88,166,255,0.15);color:#58a6ff;padding:2px 8px;border-radius:10px;font-weight:600;">多端支持</span>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px;flex-wrap:wrap;">
          <button id="modal-install-tab-qr" class="btn-sm btn-primary" style="font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;">📱 方式一：手机扫码一键配对 (极速)</button>
          <button id="modal-install-tab-brat" class="btn-sm secondary" style="font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;">✨ 方式二：通过 BRAT 一键安装</button>
          <button id="modal-install-tab-manual" class="btn-sm secondary" style="font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;">📁 方式三：手动解压安装</button>
        </div>

        <!-- Panel 1: QR Code Scanner -->
        <div id="modal-install-panel-qr" style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;">
          <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;">
            <div id="modal-qr-container" style="background:#fff;padding:8px;border-radius:10px;border:1px solid var(--border);display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
              ${qrSvg}
            </div>
            <div style="flex:1;min-width:220px;">
              <div style="font-weight:700;font-size:14px;color:var(--text);margin-bottom:6px;">📲 移动端扫码秒级接入</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                在手机 / 平板端 Obsidian 打开 <b>Nimbus Sync</b> 插件设置，点击 <b>「扫描二维码配对」</b> 即可将服务器地址、令牌与库标识全自动注入！
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="modal-copy-deeplink-btn" class="btn-primary" style="padding:7px 14px;font-size:12px;border-radius:6px;color:#ffffff !important;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:none;">🔗 复制 DeepLink (免输入直连)</button>
                <button id="modal-download-datajson-btn" class="secondary" style="padding:7px 14px;font-size:12px;border-radius:6px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">💾 下载 data.json 配置文件</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Panel 2: BRAT -->
        <div id="modal-install-panel-brat" style="display:none;font-size:12.5px;color:var(--text-secondary);line-height:1.7;">
          <div style="background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.25);border-radius:6px;padding:8px 12px;margin-bottom:10px;color:var(--text);font-size:12px;">
            💡 <b>什么是 BRAT？</b> Obsidian 官方社区最流行的插件测试与安装神器 (Beta Reviewers Auto-update Tester)，支持桌面端与手机端通过 GitHub 链接一键下载安装与自动更新，免去手动解压。
          </div>
          <ol style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:6px;">
            <li><b>安装 BRAT 插件</b>：在 Obsidian 中进入 <code>设置</code> ➔ <code>第三方插件</code> ➔ 社区插件市场中搜索 <b>BRAT</b> 并安装启用。</li>
            <li><b>打开 BRAT 设置</b>：在 Obsidian 左侧设置中找到 <b>BRAT</b>，或按快捷键 <kbd>Ctrl/Cmd + P</kbd> 输入 <code>BRAT: Add a beta plugin for testing</code>。</li>
            <li><b>添加插件仓库</b>：点击 <b>Add Beta plugin</b> 按钮，在弹出的输入框中粘贴下方 GitHub 仓库地址：
              <div style="display:flex;gap:6px;align-items:center;margin:6px 0;">
                <input type="text" id="modal-brat-repo-input" readonly value="${escapeHtml(bratRepoUrl)}" style="margin:0;padding:5px 8px;font-size:12px;font-family:ui-monospace,monospace;flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);" />
                <button id="modal-copy-brat-btn" class="btn-primary" style="padding:5px 12px;font-size:12px;color:#ffffff !important;border-radius:4px;white-space:nowrap;cursor:pointer;border:none;">📋 复制仓库链接</button>
              </div>
            </li>
            <li><b>激活并配置</b>：点击 <b>Add Plugin</b> 确认，BRAT 将在几秒内自动下载并启用 <b>Nimbus Sync</b> 插件！</li>
          </ol>
        </div>

        <!-- Panel 3: Manual -->
        <div id="modal-install-panel-manual" style="display:none;font-size:12.5px;color:var(--text-secondary);line-height:1.7;">
          <ol style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:6px;">
            <li>在本地电脑打开您的 Obsidian 笔记库根目录，进入 <code>.obsidian/plugins/</code> 文件夹。</li>
            <li>新建名为 <code>nimbus-sync</code> 的子文件夹（即完整路径 <code>.obsidian/plugins/nimbus-sync/</code>）。</li>
            <li>将插件的 <code>main.js</code>、<code>manifest.json</code>、<code>styles.css</code> 以及下方生成的 <code>data.json</code> 放入该目录中。</li>
            <li>打开 Obsidian <code>设置</code> ➔ <code>第三方插件</code>，点击“重新加载插件”，然后启用 <b>Nimbus Sync</b>。</li>
          </ol>
        </div>
      </div>

      <!-- STEP 2: Parameters and Credentials -->
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
            <button id="modal-copy-server-btn" class="secondary" style="padding:4px 10px;font-size:12px;border-radius:4px;cursor:pointer;">📋 复制</button>
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
    const qrTab = dialog.querySelector('#modal-install-tab-qr');
    const bratTab = dialog.querySelector('#modal-install-tab-brat');
    const manualTab = dialog.querySelector('#modal-install-tab-manual');
    const qrPanel = dialog.querySelector('#modal-install-panel-qr');
    const bratPanel = dialog.querySelector('#modal-install-panel-brat');
    const manualPanel = dialog.querySelector('#modal-install-panel-manual');
    const qrContainer = dialog.querySelector('#modal-qr-container');
    const copyBratBtn = dialog.querySelector('#modal-copy-brat-btn');
    const copyServerBtn = dialog.querySelector('#modal-copy-server-btn');
    const copyDeepLinkBtn = dialog.querySelector('#modal-copy-deeplink-btn');
    const downloadDataJsonBtn = dialog.querySelector('#modal-download-datajson-btn');
    const tokenSelect = dialog.querySelector('#modal-token-select');
    const deviceInput = dialog.querySelector('#modal-device-input');

    function updateLiveConfig() {
      const selectedToken = tokenSelect ? tokenSelect.value : currentToken;
      const deviceName = deviceInput ? deviceInput.value.trim() || defaultMainDevice : currentDevice;
      pluginConfig = buildConfig(selectedToken, deviceName);
      deepLinkUrl = buildDeepLink(selectedToken, deviceName);
      if (qrContainer) {
        qrContainer.innerHTML = generateQRCodeSVG(JSON.stringify(pluginConfig), { size: 160 });
      }
    }

    if (qrTab && bratTab && manualTab) {
      qrTab.onclick = () => {
        qrTab.className = 'btn-sm btn-primary';
        bratTab.className = 'btn-sm secondary';
        manualTab.className = 'btn-sm secondary';
        qrPanel.style.display = 'block';
        bratPanel.style.display = 'none';
        manualPanel.style.display = 'none';
      };
      bratTab.onclick = () => {
        bratTab.className = 'btn-sm btn-primary';
        qrTab.className = 'btn-sm secondary';
        manualTab.className = 'btn-sm secondary';
        bratPanel.style.display = 'block';
        qrPanel.style.display = 'none';
        manualPanel.style.display = 'none';
      };
      manualTab.onclick = () => {
        manualTab.className = 'btn-sm btn-primary';
        qrTab.className = 'btn-sm secondary';
        bratTab.className = 'btn-sm secondary';
        manualPanel.style.display = 'block';
        qrPanel.style.display = 'none';
        bratPanel.style.display = 'none';
      };
    }

    if (copyDeepLinkBtn) {
      copyDeepLinkBtn.onclick = () => {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(deepLinkUrl).then(() => toast('已复制 Obsidian 直连 DeepLink'));
        }
      };
    }

    if (downloadDataJsonBtn) {
      downloadDataJsonBtn.onclick = () => {
        const blob = new Blob([JSON.stringify(pluginConfig, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'data.json';
        a.click();
        URL.revokeObjectURL(url);
        toast('已下载 data.json 配置文件');
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

    if (tokenSelect && deviceInput) {
      tokenSelect.onchange = () => {
        const opt = tokenSelect.options[tokenSelect.selectedIndex];
        const devName = opt?.getAttribute('data-devicename');
        if (devName) {
          deviceInput.value = devName;
        }
        updateLiveConfig();
      };
      deviceInput.oninput = () => {
        updateLiveConfig();
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
    if (data && Array.isArray(data.tools)) {
      toolsData = data.tools;
    } else if (data && data.data && Array.isArray(data.data.tools)) {
      toolsData = data.data.tools;
    }
  } catch (err) {
    console.warn('[Nimbus] Failed to fetch MCP tools:', err);
  }

  // Fallback default tools if network is unreachable
  if (!toolsData || toolsData.length === 0) {
    toolsData = [
      { name: 'list_vaults', category: '库管理与统计', description: '获取当前用户账户下所有 Obsidian 笔记库列表（包含库ID、名称、文件数、容量及权限信息）。', parameters: {} },
      { name: 'get_vault_stats', category: '库管理与统计', description: '获取笔记库的全面统计信息（Markdown笔记数、HTML网页数、附件容量、热门标签 Top 20 及最近修改文件）。', parameters: { vaultId: '可选，笔记库ID' } },
      { name: 'list_notes', category: '笔记与文件检索', description: '多维度检索笔记与文件，支持文件夹过滤、文件扩展名（md/html/media/config）、时间排序（创建时间/修改时间）及元数据模式。', parameters: { vaultId: '可选', folder: '可选目录前缀', extension: 'all | md | html | media | config', sortBy: 'ctime | mtime | name | size', sortOrder: 'desc | asc', limit: '默认100', includeMetadata: '布尔值' } },
      { name: 'get_note_metadata', category: '笔记与文件检索', description: '提取单篇笔记的深层结构元数据，包含字数、阅读时长、YAML Frontmatter、Obsidian标签(#tag)、双向链接([[Link]])及大纲目录。', parameters: { path: '必填，笔记相对路径', vaultId: '可选' } },
      { name: 'read_note', category: '读取与写入', description: '读取笔记或文件的完整 UTF-8 文本内容。', parameters: { path: '必填，笔记路径，如 "Projects/idea.md"', vaultId: '可选' } },
      { name: 'write_note', category: '读取与写入', description: '创建或覆盖笔记，具备冲突检测与历史版本快照，保存后实时通过 WebSocket 广播推送到所有连接的 Obsidian 客户端。', parameters: { path: '必填', content: '必填，完整内容', baseHash: '可选，乐观锁防冲突', vaultId: '可选' } },
      { name: 'append_note', category: '读取与写入', description: '向已有笔记末尾（或指定标题下方）追加内容，支持自动追加时间戳，常用于 AI 会议记录、随手记、文献摘要或待办增补。', parameters: { path: '必填', content: '必填', heading: '可选标题（如 "## AI 记录"）', withTimestamp: '可选布尔值', vaultId: '可选' } },
      { name: 'prepend_note', category: '读取与写入', description: '在笔记顶部（保持 YAML Frontmatter 结构不变）插入内容，常用于插入 AI 生成的核心摘要或置顶提醒。', parameters: { path: '必填', content: '必填', withTimestamp: '可选布尔值', vaultId: '可选' } },
      { name: 'patch_note', category: '读取与写入', description: '精准局部搜索并替换笔记文本，无需重传整篇文件，修改即时广播同步。', parameters: { path: '必填', search: '待查找文本', replace: '替换文本', replaceAll: '可选布尔值', vaultId: '可选' } },
      { name: 'upload_attachment', category: '附件与多媒体', description: '上传图片、PDF、音频或二进制附件到笔记库（支持 Base64 数据或指定网络图片 URL 自动下载存储），自动广播同步并返回 ![[附件名]] 双链语法。', parameters: { path: '必填相对路径（如 "_resources/image.png"）', contentBase64: '可选 Base64 字符串', sourceUrl: '可选网络下载 URL', overwrite: '可选布尔值', vaultId: '可选' } },
      { name: 'get_attachment_base64', category: '附件与多媒体', description: '将笔记库中的图片/附件读取为 Base64 编码，供 AI 视觉分析或多模态理解。', parameters: { path: '必填附件路径', vaultId: '可选' } },
      { name: 'get_daily_note', category: '日记与日志 (Daily Note)', description: '获取今日（或指定日期）的 Obsidian 日记。若日记不存在可自动按规范初始化。', parameters: { date: '可选 "YYYY-MM-DD"', folder: '可选 "Daily"', createIfMissing: '默认 true', vaultId: '可选' } },
      { name: 'append_daily_note', category: '日记与日志 (Daily Note)', description: '快速将思考碎片、任务或会议纪要追加记录到今日（或指定日期）的日记中，默认附加 [HH:mm:ss] 时间戳。', parameters: { content: '必填记录文本', date: '可选', folder: '可选', heading: '可选分类标题', withTimestamp: '默认 true', vaultId: '可选' } },
      { name: 'search_notes', category: '全文检索与标签', description: '在所有 Markdown 与 HTML 笔记中执行全文搜索，返回匹配上下文片段、行号及文件路径，支持正则搜索与大小写匹配。', parameters: { query: '必填关键词或正则表达式', folder: '可选', limit: '默认20', useRegex: '可选布尔值', caseSensitive: '可选布尔值', vaultId: '可选' } },
      { name: 'list_tags', category: '全文检索与标签', description: '自动扫描并聚合笔记库中所有 Obsidian 标签（#tag 及 #父/子 嵌套标签），统计词频与关联笔记路径。', parameters: { folder: '可选目录过滤', vaultId: '可选' } },
      { name: 'move_note', category: '组织与管理', description: '重命名或移动笔记/附件至新目录，自动维护索引并广播实时同步。', parameters: { oldPath: '原路径', newPath: '新路径', overwrite: '可选布尔值', vaultId: '可选' } },
      { name: 'delete_note', category: '组织与管理', description: '安全删除笔记（自动移入笔记库回收站，可随时还原），即时推送到 Obsidian。', parameters: { path: '必填路径', vaultId: '可选' } },
      { name: 'get_note_history', category: '版本历史', description: '查询单篇笔记的所有历史备份快照列表与时间戳。', parameters: { path: '必填路径', vaultId: '可选' } },
      { name: 'read_history_version', category: '版本历史', description: '读取笔记特定历史版本快照的原始内容。', parameters: { versionId: '必填版本ID', vaultId: '可选' } },
      { name: 'create_share_link', category: '外链分享', description: '直接通过 AI 为笔记生成公开外链分享地址（支持密码保护与有效期设定）。', parameters: { path: '必填笔记路径', title: '可选标题', password: '可选密码', expiresDays: '可选天数', allowCopy: '默认 true', vaultId: '可选' } },
      { name: 'get_vault_git_status', category: 'Git 自动化备份', description: '自省当前笔记库的 Git 版本控制与远端同步状态（当前分支、未提交文件数、未推送提交、最近提交快照及远端仓库地址）。', parameters: { vaultId: '可选笔记库ID' } },
      { name: 'git_sync_vault', category: 'Git 自动化备份', description: '执行 Git 仓库自动化操作：提交并推送到远端 Git 仓库 (GitHub/Gitee/GitLab)、从远端拉取更新或测试连通性。', parameters: { vaultId: '可选', action: 'commit_and_push | pull | test_connection', commitMessage: '可选自定义提交信息' } },
    ];
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

  let currentVaultName = selectedVaultName;
  let currentConfigText = JSON.stringify(generateConfig(currentVaultName), null, 2);

  const categories = [...new Set(toolsData.map((t) => t.category || '通用工具'))];

  const toolsHtml = toolsData.map((t) => {
    const paramsEntries = t.parameters ? Object.entries(t.parameters) : [];
    const paramsHtml = paramsEntries.length > 0
      ? `<div class="mcp-tool-params" style="margin-top:8px;">
           <div style="font-weight:600;margin-bottom:4px;color:var(--text);font-size:11.5px;">入参声明 (Parameters)：</div>
           <div style="display:flex;flex-direction:column;gap:3px;">
             ${paramsEntries.map(([k, v]) => `<div><code style="font-family:ui-monospace,monospace;font-weight:600;color:var(--primary);">${escapeHtml(k)}</code>: <span style="color:var(--text-muted);">${escapeHtml(String(v))}</span></div>`).join('')}
           </div>
         </div>`
      : `<div class="mcp-tool-params" style="margin-top:8px;color:var(--text-dim);font-style:italic;">无必填入参 (无需参数即可调用)</div>`;

    return `
      <div class="mcp-tool-card" data-name="${escapeHtml(t.name.toLowerCase())}" data-category="${escapeHtml((t.category || '').toLowerCase())}" data-desc="${escapeHtml((t.description || '').toLowerCase())}">
        <div class="mcp-tool-header">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="mcp-tool-name">${escapeHtml(t.name)}</span>
            <span class="mcp-tool-category">${escapeHtml(t.category || 'MCP 工具')}</span>
          </div>
          <button type="button" class="copy-tool-name-btn ghost" data-tool="${escapeHtml(t.name)}" title="复制工具名" style="font-size:11.5px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--panel);color:var(--text-secondary);">📋 复制名称</button>
        </div>
        <div class="mcp-tool-desc">${escapeHtml(t.description)}</div>
        ${paramsHtml}
      </div>
    `;
  }).join('');

  const html = `
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">🤖</span>
        <div>
          <h3 style="margin:0;font-size:16px;">Model Context Protocol (MCP) 服务与工具接口</h3>
          <div style="font-size:11.5px;color:var(--text-muted);">支持 Cursor、Cherry Studio、Claude Desktop、Cline 等 AI 客户端实时读写 Obsidian 笔记</div>
        </div>
      </div>
      <button class="modal-close ghost">✕</button>
    </div>

    <div class="mcp-nav-tabs">
      <button type="button" class="mcp-nav-tab active" id="mcp-tab-config-btn">⚙️ 客户端连接配置</button>
      <button type="button" class="mcp-nav-tab" id="mcp-tab-tools-btn">🛠️ MCP 工具清单 (${toolsData.length})</button>
    </div>

    <div class="modal-body" style="max-height:65vh;overflow-y:auto;padding:16px 20px;">
      <!-- TAB 1: Config View -->
      <div id="mcp-tab-config-view">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:13px;color:var(--text-secondary);font-weight:500;">选择绑定的默认笔记库：</div>
          <select id="mcp-vault-select" style="padding:5px 12px;font-size:12.5px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);">
            ${(state.vaults || []).map((v) => `<option value="${escapeHtml(v.name)}" ${v.name === currentVaultName ? 'selected' : ''}>📓 ${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <pre class="code-snippet" id="mcp-config-code" style="max-height:220px;overflow-x:auto;">${escapeHtml(currentConfigText)}</pre>
        
        <div style="margin-top:14px;background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
          <div style="font-weight:600;margin-bottom:6px;color:var(--text);display:flex;align-items:center;gap:6px;">
            <span>💡 接入步骤指引：</span>
          </div>
          <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;">
            <li>点击下方「<b>📋 复制当前 MCP 配置</b>」按钮复制完整 JSON 结构。</li>
            <li>打开 <b>Cursor</b> ➔ <code>Settings</code> ➔ <code>Features</code> ➔ <code>MCP Servers</code> ➔ 粘贴保存，或编辑 <code>~/.cursor/mcp.json</code>。</li>
            <li>若使用 <b>Claude Desktop</b>，将配置粘贴至其 <code>claude_desktop_config.json</code> 的 <code>mcpServers</code> 字段中。</li>
            <li>配置完成后，AI 客户端将直接具备全部 <b>${toolsData.length} 个 MCP 工具</b>，支持实时读写、智能追加、全文检索与 Git 远端备份！</li>
          </ol>
        </div>
      </div>

      <!-- TAB 2: Tools View -->
      <div id="mcp-tab-tools-view" style="display:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
          <div style="position:relative;flex:1;min-width:220px;">
            <input type="text" id="mcp-tools-search" placeholder="🔍 快速搜索工具名称、分类或功能说明..." style="width:100%;padding:6px 12px;font-size:12.5px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
          </div>
          <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;" id="mcp-tools-count-badge">
            共计 <b style="color:var(--primary);">${toolsData.length}</b> 个标准工具
          </div>
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;" id="mcp-tools-category-filters">
          <button type="button" class="btn-xs primary mcp-category-pill" data-category="all" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid var(--border);cursor:pointer;">全部 (${toolsData.length})</button>
          ${categories.map((c) => `<button type="button" class="btn-xs secondary mcp-category-pill" data-category="${escapeHtml(c.toLowerCase())}" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid var(--border);cursor:pointer;">${escapeHtml(c)}</button>`).join('')}
        </div>

        <div id="mcp-tools-list-container" style="display:flex;flex-direction:column;gap:10px;">
          ${toolsHtml}
        </div>
      </div>
    </div>

    <div class="modal-footer" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:11.5px;color:var(--text-muted);">
        ✨ 支持 Cursor / Claude Desktop / Cherry Studio / Cline
      </div>
      <div style="display:flex;gap:8px;">
        <button id="copy-mcp-btn" class="btn-primary">📋 复制当前 MCP 配置</button>
        <button class="modal-close secondary">关闭</button>
      </div>
    </div>
  `;

  showModal(html, (dialog) => {
    const configTabBtn = dialog.querySelector('#mcp-tab-config-btn');
    const toolsTabBtn = dialog.querySelector('#mcp-tab-tools-btn');
    const configView = dialog.querySelector('#mcp-tab-config-view');
    const toolsView = dialog.querySelector('#mcp-tab-tools-view');
    const copyBtn = dialog.querySelector('#copy-mcp-btn');
    const vaultSelect = dialog.querySelector('#mcp-vault-select');
    const codeElem = dialog.querySelector('#mcp-config-code');
    const searchInput = dialog.querySelector('#mcp-tools-search');
    const countBadge = dialog.querySelector('#mcp-tools-count-badge');
    const categoryPills = dialog.querySelectorAll('.mcp-category-pill');
    let activeCategory = 'all';

    // Tab switching
    if (configTabBtn && toolsTabBtn) {
      configTabBtn.onclick = () => {
        configTabBtn.classList.add('active');
        toolsTabBtn.classList.remove('active');
        if (configView) configView.style.display = 'block';
        if (toolsView) toolsView.style.display = 'none';
        if (copyBtn) {
          copyBtn.textContent = '📋 复制当前 MCP 配置';
        }
      };

      toolsTabBtn.onclick = () => {
        toolsTabBtn.classList.add('active');
        configTabBtn.classList.remove('active');
        if (configView) configView.style.display = 'none';
        if (toolsView) toolsView.style.display = 'block';
        if (copyBtn) {
          copyBtn.textContent = `📋 复制全部 ${toolsData.length} 个工具清单 (JSON)`;
        }
      };
    }

    // Vault select change
    if (vaultSelect && codeElem) {
      vaultSelect.onchange = () => {
        currentVaultName = vaultSelect.value;
        currentConfigText = JSON.stringify(generateConfig(currentVaultName), null, 2);
        codeElem.textContent = currentConfigText;
      };
    }

    // Filter tools
    function filterTools() {
      const q = (searchInput?.value || '').trim().toLowerCase();
      const cards = dialog.querySelectorAll('.mcp-tool-card');
      let visible = 0;
      cards.forEach((card) => {
        const name = card.dataset.name || '';
        const cat = card.dataset.category || '';
        const desc = card.dataset.desc || '';
        const matchesCategory = activeCategory === 'all' || cat === activeCategory;
        const matchesQuery = !q || name.includes(q) || cat.includes(q) || desc.includes(q);
        const show = matchesCategory && matchesQuery;
        card.style.display = show ? 'block' : 'none';
        if (show) visible++;
      });
      if (countBadge) {
        countBadge.innerHTML = (q || activeCategory !== 'all')
          ? `筛选出 <b style="color:var(--primary);">${visible}</b> / ${toolsData.length} 个工具`
          : `共计 <b style="color:var(--primary);">${toolsData.length}</b> 个标准工具`;
      }
    }

    if (searchInput) {
      searchInput.oninput = filterTools;
    }

    categoryPills.forEach((pill) => {
      pill.onclick = () => {
        categoryPills.forEach((p) => {
          p.className = 'btn-xs secondary mcp-category-pill';
        });
        pill.className = 'btn-xs primary mcp-category-pill';
        activeCategory = pill.dataset.category || 'all';
        filterTools();
      };
    });

    // Copy individual tool name
    dialog.querySelectorAll('.copy-tool-name-btn').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const toolName = btn.dataset.tool;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(toolName).then(() => toast(`已复制工具名「${toolName}」`));
        }
      };
    });

    // Main Copy button
    if (copyBtn) {
      copyBtn.onclick = () => {
        const isToolsTab = toolsTabBtn?.classList.contains('active');
        const textToCopy = isToolsTab
          ? JSON.stringify(toolsData, null, 2)
          : currentConfigText;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(textToCopy).then(() => {
            toast(isToolsTab ? `已复制全部 ${toolsData.length} 个 MCP 工具接口定义 (JSON)` : 'MCP JSON 配置已复制到剪贴板');
          });
        }
      };
    }
  });
}
