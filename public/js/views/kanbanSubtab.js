// --------------------------- Dashboard & Kanban Subtab ---------------------------
import { state, escapeHtml, formatBytes } from '../core/state.js';
import { formatCurrentDate } from '../core/themes.js';
import { api } from '../core/api.js';
import { showModal, closeModal, showConfirm, toast } from '../core/dialogs.js';
import { showObsidianConnectModal, showMcpModal } from './connectModal.js';

let currentDashboardSubtab = 'overview';
let currentKanbanVaultId = null;
let currentKanbanBoard = null;
let kanbanFilterQuery = '';

export async function renderDashboardPanel(mainPanel, { openVault, showTab, setAppVersion }) {
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">正在加载看板数据…</div>';

  let overviewData = null;
  try {
    const res = await api('/api/dashboard/overview');
    if (res.ok) {
      overviewData = await res.json();
    }
  } catch (err) {
    console.error('[Dashboard] Error loading overview:', err);
  }

  if (!overviewData || !overviewData.ok) {
    mainPanel.innerHTML = `
      <div class="empty-state">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;font-size:16px;">获取看板数据失败</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px;">请检查服务连接或网络状态</div>
        <button class="primary" style="margin-top:14px;" id="dash-retry-btn">重新加载</button>
      </div>
    `;
    mainPanel.querySelector('#dash-retry-btn')?.addEventListener('click', () => renderDashboardPanel(mainPanel, { openVault, showTab, setAppVersion }));
    return;
  }

  const { stats, vaults } = overviewData;
  if (overviewData.version && setAppVersion) setAppVersion(overviewData.version);
  if (!currentKanbanVaultId && vaults && vaults.length > 0) {
    currentKanbanVaultId = vaults[0].id;
  }

  const t = window.t || ((k, f) => f || k);
  const displayVersion = 'v' + (state.appVersion || overviewData.version || overviewData.stats?.version || '1.3.0').replace(/^v/i, '');

  mainPanel.innerHTML = `
    <div class="dashboard-container">
      <div class="dashboard-header-card">
        <div class="dashboard-title-group">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <h2 style="margin:0;">
              <span>📊</span>
              <span>${escapeHtml(t('dashboard.title', 'Nimbus 看板总览'))}</span>
              <span id="dashboard-version-badge" class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:11.5px;font-weight:600;">${escapeHtml(displayVersion)}</span>
            </h2>
            <div class="dashboard-date-chip" id="dashboard-date-badge" title="当前系统日期">
              <span style="font-size:13px;">📅</span>
              <span id="dashboard-date-text" style="font-weight:600;">${escapeHtml(formatCurrentDate())}</span>
            </div>
          </div>
          <p style="margin-top:6px;">实时监控 Obsidian 多端同步状态、各笔记库存储指标与任务便签看板</p>
        </div>

        <div class="dashboard-view-switcher">
          <button class="dashboard-view-btn ${currentDashboardSubtab === 'overview' ? 'active' : ''}" id="dash-btn-overview">
            <span>📊</span>
            <span>${escapeHtml(t('dashboard.tab_overview', '运行与同步大盘'))}</span>
          </button>
          <button class="dashboard-view-btn ${currentDashboardSubtab === 'kanban' ? 'active' : ''}" id="dash-btn-kanban">
            <span>📋</span>
            <span>${escapeHtml(t('dashboard.tab_kanban', '任务便签看板'))}</span>
          </button>
          <button class="btn-icon" id="dash-refresh-btn" title="刷新看板数据" style="margin-left:4px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;">🔄</button>
        </div>
      </div>

      <div id="dashboard-content-area"></div>
    </div>
  `;

  mainPanel.querySelector('#dash-btn-overview')?.addEventListener('click', () => {
    currentDashboardSubtab = 'overview';
    mainPanel.querySelector('#dash-btn-overview')?.classList.add('active');
    mainPanel.querySelector('#dash-btn-kanban')?.classList.remove('active');
    renderDashboardSubView(overviewData, mainPanel, { openVault, showTab });
  });

  mainPanel.querySelector('#dash-btn-kanban')?.addEventListener('click', () => {
    currentDashboardSubtab = 'kanban';
    mainPanel.querySelector('#dash-btn-kanban')?.classList.add('active');
    mainPanel.querySelector('#dash-btn-overview')?.classList.remove('active');
    renderDashboardSubView(overviewData, mainPanel, { openVault, showTab });
  });

  mainPanel.querySelector('#dash-refresh-btn')?.addEventListener('click', () => {
    renderDashboardPanel(mainPanel, { openVault, showTab, setAppVersion });
  });

  renderDashboardSubView(overviewData, mainPanel, { openVault, showTab });
}

function renderDashboardSubView(overviewData, mainPanel, handlers) {
  const area = mainPanel.querySelector('#dashboard-content-area');
  if (!area) return;

  if (currentDashboardSubtab === 'overview') {
    renderOverviewSubView(overviewData, area, mainPanel, handlers);
  } else {
    renderKanbanSubView(overviewData, area);
  }
}

function renderOverviewSubView(overviewData, container, mainPanel, { openVault, showTab }) {
  const { stats, vaults, recentLogs } = overviewData;

  let vaultsHtml = '';
  if (!vaults || vaults.length === 0) {
    vaultsHtml = `
      <div class="empty-state" style="grid-column:1/-1;padding:32px;background:var(--panel);border:1px dashed var(--border);border-radius:var(--radius-lg);">
        <div style="font-size:32px;margin-bottom:8px;">📚</div>
        <div style="font-weight:600;font-size:15px;color:var(--text);">当前暂无任何 Vault 笔记库</div>
        <div style="font-size:12.5px;color:var(--muted);margin:6px 0 14px;">立即创建一个新的笔记库并与 Obsidian 开启双向同步</div>
        <button class="primary" id="dash-create-first-vault-btn">➕ 新建首个 Vault</button>
      </div>
    `;
  } else {
    vaultsHtml = vaults.map((v) => {
      const isOwner = v.isOwner;
      const tag = isOwner
        ? '<span class="badge" style="background:rgba(88,166,255,0.15);color:var(--accent);">所有者</span>'
        : v.myPermission === 'read-only'
        ? '<span class="badge" style="background:rgba(230,126,34,0.15);color:#e67e22;">只读</span>'
        : '<span class="badge" style="background:rgba(46,204,113,0.15);color:#2ecc71;">协作</span>';

      const gitBadge = v.isGit
        ? '<span class="badge" style="background:rgba(63,185,80,0.15);color:#3fb950;">Git 自动备份</span>'
        : '';

      const conflictBadge = v.conflictsCount > 0
        ? `<span class="badge" style="background:rgba(248,81,73,0.15);color:#f85149;">⚠️ ${v.conflictsCount} 冲突</span>`
        : '';

      const clientBadge = v.clientCount > 0
        ? `<span class="badge" style="background:rgba(46,160,67,0.15);color:#3fb950;"><span class="pulse-dot"></span> ${v.clientCount} 在线</span>`
        : '';

      return `
        <div class="vault-overview-card" data-id="${escapeHtml(v.id)}">
          <div class="voc-head">
            <div class="voc-title" title="${escapeHtml(v.name)}">
              <span>📓</span>
              <span>${escapeHtml(v.name)}</span>
            </div>
            <div class="voc-badges">
              ${tag}
              ${clientBadge}
              ${gitBadge}
              ${conflictBadge}
            </div>
          </div>

          <div class="voc-stats-row">
            <div class="voc-stat-item">
              <div class="voc-stat-num">${v.stats.totalFiles || 0}</div>
              <div class="voc-stat-name">总文件数</div>
            </div>
            <div class="voc-stat-item">
              <div class="voc-stat-num">${v.stats.notesCount || 0}</div>
              <div class="voc-stat-name">Markdown 笔记</div>
            </div>
            <div class="voc-stat-item">
              <div class="voc-stat-num">${formatBytes(v.stats.totalBytes || 0)}</div>
              <div class="voc-stat-name">存储空间</div>
            </div>
          </div>

          <div class="voc-footer">
            <div class="voc-meta">
              <span class="voc-meta-item">版本历史: <span class="voc-meta-num">${v.stats.historyCount || 0}</span></span>
              <span class="voc-meta-sep">|</span>
              <span class="voc-meta-item">回收站: <span class="voc-meta-num">${v.stats.trashCount || 0}</span></span>
            </div>
            <div class="voc-actions">
              <button class="secondary voc-kanban-btn" data-id="${escapeHtml(v.id)}" style="padding:4px 9px;font-size:12px;">📋 看板</button>
              <button class="primary voc-open-btn" data-id="${escapeHtml(v.id)}" style="padding:4px 10px;font-size:12px;">进入库 ➔</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  let activitiesHtml = '';
  if (!recentLogs || recentLogs.length === 0) {
    activitiesHtml = `
      <div class="empty-state" style="padding:28px;background:var(--panel-2);border-radius:8px;">
        <div style="font-size:24px;margin-bottom:6px;">📡</div>
        <div style="font-weight:600;font-size:13px;color:var(--text);">当前暂无实时同步动态</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">在 Obsidian 中编辑或保存笔记后，动态将实时显示在此处</div>
      </div>
    `;
  } else {
    activitiesHtml = recentLogs.map((log) => {
      let icon = '🔄';
      let actionColor = 'var(--accent)';
      const act = (log.action || '').toLowerCase();
      if (act.includes('push') || act.includes('write') || act.includes('create')) {
        icon = '⬆️';
        actionColor = '#3fb950';
      } else if (act.includes('pull') || act.includes('read') || act.includes('download')) {
        icon = '⬇️';
        actionColor = '#58a6ff';
      } else if (act.includes('delete') || act.includes('trash')) {
        icon = '🗑️';
        actionColor = '#f85149';
      } else if (act.includes('conflict')) {
        icon = '⚠️';
        actionColor = '#d29922';
      }

      const dateStr = log.createdAt || log.timestamp
        ? new Date(log.createdAt || log.timestamp).toLocaleTimeString()
        : '';

      return `
        <div class="activity-stream-item">
          <div class="asi-icon" style="background:rgba(88,166,255,0.1);color:${actionColor};">${icon}</div>
          <div class="asi-main">
            <div class="asi-top">
              <span class="asi-path" title="${escapeHtml(log.path || log.target || log.details || '同步操作')}">
                ${escapeHtml(log.path || log.target || log.details || '同步操作')}
              </span>
              <span class="asi-time">${escapeHtml(dateStr)}</span>
            </div>
            <div class="asi-sub">
              <span class="badge" style="font-size:10.5px;padding:1px 5px;">${escapeHtml(log.action || 'SYNC')}</span>
              <span>${escapeHtml(log.username || 'Client')}</span>
              <span>·</span>
              <span>${escapeHtml(log.deviceName || 'Obsidian')}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:24px;">
      <div class="metrics-row">
        <div class="metric-box">
          <div class="metric-icon-wrap" style="background:rgba(88,166,255,0.15);color:var(--accent);">📚</div>
          <div class="metric-content">
            <div class="metric-val">${stats.totalVaults || 0}</div>
            <div class="metric-lbl">笔记库总数 (Vaults)</div>
            <div class="metric-sub">多端隔离存储与独立配置</div>
          </div>
        </div>

        <div class="metric-box">
          <div class="metric-icon-wrap" style="background:rgba(63,185,80,0.15);color:#3fb950;">📄</div>
          <div class="metric-content">
            <div class="metric-val">${stats.totalNotes || 0}</div>
            <div class="metric-lbl">Markdown 笔记总计</div>
            <div class="metric-sub">文件总数 ${stats.totalFiles || 0} · ${formatBytes(stats.totalBytes || 0)}</div>
          </div>
        </div>

        <div class="metric-box">
          <div class="metric-icon-wrap" style="background:rgba(163,113,247,0.15);color:#a371f7;">📱</div>
          <div class="metric-content">
            <div class="metric-val">${stats.onlineClients || 0}</div>
            <div class="metric-lbl">当前在线客户端</div>
            <div class="metric-sub">已绑定接入设备 ${stats.totalDevices || 0} 台</div>
          </div>
        </div>

        <div class="metric-box">
          <div class="metric-icon-wrap" style="background:rgba(210,153,34,0.15);color:#d29922;">⚡</div>
          <div class="metric-content">
            <div class="metric-val">${stats.dbType ? stats.dbType.toUpperCase() : 'SQLITE'}</div>
            <div class="metric-lbl">数据库引擎状态</div>
            <div class="metric-sub">未决冲突 ${stats.totalConflicts || 0} · 历史快照 ${stats.totalHistory || 0}</div>
          </div>
        </div>
      </div>

      <div>
        <div class="dashboard-grid-title">
          <h3><span>📚</span><span>我的笔记库状态矩阵</span></h3>
          <button class="primary" id="dash-new-vault-quick-btn" style="padding:5px 12px;font-size:12.5px;">➕ 新建 Vault</button>
        </div>
        <div class="vault-cards-grid">
          ${vaultsHtml}
        </div>
      </div>

      <div class="dashboard-split-grid">
        <div class="dashboard-panel-card">
          <div class="dpc-header">
            <h3><span>📡</span><span>实时同步动态与审计</span></h3>
            <span class="badge" style="background:var(--panel-2);color:var(--muted);">${(recentLogs || []).length} 条最近记录</span>
          </div>
          <div class="activity-stream-list">
            ${activitiesHtml}
          </div>
        </div>

        <div class="dashboard-panel-card">
          <div class="dpc-header">
            <h3><span>⚡</span><span>快捷操作与服务中心</span></h3>
            <span class="badge" style="background:rgba(63,185,80,0.15);color:#3fb950;">就绪</span>
          </div>

          <div class="quick-actions-grid">
            <button class="quick-action-card" id="qa-connect-btn">
              <span class="quick-action-icon">⚡</span>
              <span class="quick-action-title">Obsidian 连接</span>
              <span class="quick-action-desc">获取插件一键 data.json</span>
            </button>

            <button class="quick-action-card" id="qa-kanban-btn">
              <span class="quick-action-icon">📋</span>
              <span class="quick-action-title">待办任务看板</span>
              <span class="quick-action-desc">管理卡片与扫描笔记待办</span>
            </button>

            <button class="quick-action-card" id="qa-mcp-btn">
              <span class="quick-action-icon">🤖</span>
              <span class="quick-action-title">AI / MCP 配置</span>
              <span class="quick-action-desc">连接 Claude / Cursor / GPT</span>
            </button>

            <button class="quick-action-card" id="qa-search-btn">
              <span class="quick-action-icon">🔍</span>
              <span class="quick-action-title">全局笔记检索</span>
              <span class="quick-action-desc">快捷键 Ctrl + K</span>
            </button>

            <button class="quick-action-card" id="qa-devices-btn">
              <span class="quick-action-icon">📱</span>
              <span class="quick-action-title">接入设备管理</span>
              <span class="quick-action-desc">管理授权专属 Token</span>
            </button>

            <button class="quick-action-card" id="qa-settings-btn">
              <span class="quick-action-icon">⚙️</span>
              <span class="quick-action-title">服务器偏好设置</span>
              <span class="quick-action-desc">版本保留与同步策略</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.querySelector('#dash-new-vault-quick-btn')?.addEventListener('click', () => {
    document.querySelector('#new-vault-btn')?.click();
  });
  document.querySelector('#dash-create-first-vault-btn')?.addEventListener('click', () => {
    document.querySelector('#new-vault-btn')?.click();
  });

  container.querySelectorAll('.voc-open-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openVault) openVault(btn.dataset.id);
    });
  });

  container.querySelectorAll('.voc-kanban-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentKanbanVaultId = btn.dataset.id;
      currentDashboardSubtab = 'kanban';
      mainPanel.querySelector('#dash-btn-kanban')?.click();
    });
  });

  container.querySelectorAll('.vault-overview-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (openVault) openVault(card.dataset.id);
    });
  });

  container.querySelector('#qa-connect-btn')?.addEventListener('click', () => {
    const v = vaults[0];
    showObsidianConnectModal(v);
  });
  container.querySelector('#qa-kanban-btn')?.addEventListener('click', () => {
    currentDashboardSubtab = 'kanban';
    mainPanel.querySelector('#dash-btn-kanban')?.click();
  });
  container.querySelector('#qa-mcp-btn')?.addEventListener('click', () => {
    const v = vaults[0];
    showMcpModal(v ? v.name : 'Default');
  });
  container.querySelector('#qa-search-btn')?.addEventListener('click', () => {
    document.querySelector('#topbar-search-btn')?.click();
  });
  container.querySelector('#qa-devices-btn')?.addEventListener('click', () => {
    if (showTab) showTab('devices');
  });
  container.querySelector('#qa-settings-btn')?.addEventListener('click', () => {
    if (showTab) showTab('settings');
  });
}

export async function renderKanbanSubView(overviewData, container) {
  const { vaults } = overviewData || {};

  if (!vaults || vaults.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:48px;background:var(--panel);border:1px dashed var(--border);border-radius:var(--radius-lg);">
        <div style="font-size:36px;margin-bottom:10px;">📋</div>
        <div style="font-weight:600;font-size:16px;color:var(--text);">暂无笔记库以创建看板</div>
        <div style="font-size:13px;color:var(--muted);margin:8px 0 16px;">看板任务依附于 Vault 笔记库进行持久化存储与同步</div>
        <button class="primary" onclick="document.querySelector('#new-vault-btn')?.click()">➕ 立即新建 Vault</button>
      </div>
    `;
    return;
  }

  if (!currentKanbanVaultId) {
    currentKanbanVaultId = vaults[0].id;
  }

  container.innerHTML = '<div class="empty-state">正在加载看板泳道与卡片…</div>';

  let boardData = null;
  try {
    const res = await api(`/api/dashboard/kanban/${currentKanbanVaultId}`);
    if (res.ok) {
      const body = await res.json();
      boardData = body.board;
    }
  } catch (err) {
    console.error('[Kanban] Error fetching board:', err);
  }

  if (!boardData) {
    boardData = {
      columns: [
        { id: 'todo', title: '📌 待办 (To Do)', color: '#58a6ff' },
        { id: 'in_progress', title: '🚀 进行中 (In Progress)', color: '#e3b341' },
        { id: 'review', title: '🔍 归纳复盘 (Review)', color: '#a371f7' },
        { id: 'done', title: '✅ 已完成 (Done)', color: '#3fb950' },
      ],
      cards: [],
    };
  }
  currentKanbanBoard = boardData;

  const q = (kanbanFilterQuery || '').toLowerCase().trim();
  const visibleCards = (boardData.cards || []).filter((c) => {
    if (!q) return true;
    return (
      (c.title && c.title.toLowerCase().includes(q)) ||
      (c.description && c.description.toLowerCase().includes(q)) ||
      (c.notePath && c.notePath.toLowerCase().includes(q)) ||
      (c.tags && c.tags.some((t) => t.toLowerCase().includes(q)))
    );
  });

  const columns = boardData.columns || [];

  const lanesHtml = columns.map((col) => {
    const colCards = visibleCards.filter((c) => c.columnId === col.id);

    const cardsHtml = colCards.length === 0
      ? `<div class="empty-state" style="padding:24px 12px;font-size:12.5px;color:var(--muted);">暂无卡片</div>`
      : colCards.map((card) => {
          const prioClass = card.priority === 'high'
            ? 'kc-priority-high'
            : card.priority === 'low'
            ? 'kc-priority-low'
            : 'kc-priority-medium';

          const prioLabel = card.priority === 'high'
            ? 'P1 高'
            : card.priority === 'low'
            ? 'P3 低'
            : 'P2 中';

          const tagsHtml = (card.tags || []).map((tg) => `<span class="kc-tag-pill">#${escapeHtml(tg)}</span>`).join('');
          const noteLinkHtml = card.notePath
            ? `<span class="kc-note-link" title="关联笔记: ${escapeHtml(card.notePath)}">📄 ${escapeHtml(card.notePath)}</span>`
            : '';

          return `
            <div class="kanban-card" draggable="true" data-card-id="${escapeHtml(card.id)}" data-col-id="${escapeHtml(col.id)}">
              <div class="kc-head">
                <span class="kc-priority-tag ${prioClass}">${prioLabel}</span>
                <div class="kc-actions">
                  <button class="kc-action-btn kc-move-left" title="移至上一列" data-id="${escapeHtml(card.id)}">◀</button>
                  <button class="kc-action-btn kc-move-right" title="移至下一列" data-id="${escapeHtml(card.id)}">▶</button>
                  <button class="kc-action-btn kc-toggle-done" title="完成/取消完成" data-id="${escapeHtml(card.id)}">✓</button>
                  <button class="kc-action-btn kc-edit" title="编辑卡片" data-id="${escapeHtml(card.id)}">✏️</button>
                  <button class="kc-action-btn del kc-del" title="删除卡片" data-id="${escapeHtml(card.id)}">🗑️</button>
                </div>
              </div>

              <div class="kc-title">${escapeHtml(card.title)}</div>
              ${card.description ? `<div class="kc-desc">${escapeHtml(card.description)}</div>` : ''}

              ${noteLinkHtml || tagsHtml ? `
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
                  ${noteLinkHtml}
                  ${tagsHtml}
                </div>
              ` : ''}

              <div class="kc-footer">
                <span style="font-size:11px;color:var(--muted);">
                  ${card.createdAt ? new Date(card.createdAt).toLocaleDateString() : ''}
                </span>
                ${card.dueDate ? `<span style="font-size:11px;color:var(--warning);">📅 ${escapeHtml(card.dueDate)}</span>` : ''}
              </div>
            </div>
          `;
        }).join('');

    return `
      <div class="kanban-column" data-col-id="${escapeHtml(col.id)}">
        <div class="kanban-column-header">
          <div class="kanban-column-title-wrap">
            <span class="kanban-column-dot" style="background:${escapeHtml(col.color || '#58a6ff')};"></span>
            <span class="kanban-column-title">${escapeHtml(col.title)}</span>
            <span class="kanban-column-count">${colCards.length}</span>
          </div>
          <button class="btn-icon col-add-card-btn" data-col-id="${escapeHtml(col.id)}" title="在当前列添加卡片" style="font-size:16px;width:24px;height:24px;">+</button>
        </div>
        <div class="kanban-cards-list" data-col-id="${escapeHtml(col.id)}">
          ${cardsHtml}
        </div>
        <button class="kanban-add-card-btn" data-col-id="${escapeHtml(col.id)}">
          <span>+</span>
          <span>添加任务卡片</span>
        </button>
      </div>
    `;
  }).join('');

  const vaultOptions = vaults.map((v) => `
    <option value="${escapeHtml(v.id)}" ${v.id === currentKanbanVaultId ? 'selected' : ''}>
      📓 ${escapeHtml(v.name)}
    </option>
  `).join('');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div class="kanban-toolbar">
        <div class="kanban-toolbar-left">
          <span style="font-weight:600;font-size:13.5px;color:var(--text);">目标笔记库:</span>
          <select id="kanban-vault-select" style="padding:6px 10px;font-size:13px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);margin:0;">
            ${vaultOptions}
          </select>

          <div class="search-box" style="width:220px;margin:0;">
            <span class="search-icon">🔍</span>
            <input type="text" id="kanban-filter-input" placeholder="筛选卡片..." value="${escapeHtml(kanbanFilterQuery)}" style="margin:0;padding:6px 10px 6px 28px;font-size:12.5px;" />
          </div>
        </div>

        <div class="kanban-toolbar-right">
          <button class="secondary" id="kanban-scan-btn" style="padding:6px 14px;font-size:13px;">
            <span>📥</span>
            <span>从笔记中扫描待办</span>
          </button>
          <button class="primary" id="kanban-new-card-btn" style="padding:6px 14px;font-size:13px;">
            <span>➕</span>
            <span>新建卡片</span>
          </button>
        </div>
      </div>

      <div class="kanban-lanes">
        ${lanesHtml}
      </div>
    </div>
  `;

  container.querySelector('#kanban-vault-select')?.addEventListener('change', (e) => {
    currentKanbanVaultId = e.target.value;
    renderKanbanSubView(overviewData, container);
  });

  container.querySelector('#kanban-filter-input')?.addEventListener('input', (e) => {
    kanbanFilterQuery = e.target.value;
    renderKanbanSubView(overviewData, container);
  });

  container.querySelector('#kanban-scan-btn')?.addEventListener('click', () => {
    showScanTasksModal(currentKanbanVaultId, boardData, () => {
      renderKanbanSubView(overviewData, container);
    });
  });

  container.querySelector('#kanban-new-card-btn')?.addEventListener('click', () => {
    showEditCardModal(null, 'todo', currentKanbanVaultId, boardData, () => {
      renderKanbanSubView(overviewData, container);
    });
  });

  container.querySelectorAll('.kanban-add-card-btn, .col-add-card-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const colId = btn.dataset.colId || 'todo';
      showEditCardModal(null, colId, currentKanbanVaultId, boardData, () => {
        renderKanbanSubView(overviewData, container);
      });
    });
  });

  container.querySelectorAll('.kc-move-left').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.id;
      const card = boardData.cards.find((c) => c.id === cardId);
      if (!card) return;
      const colIndex = columns.findIndex((col) => col.id === card.columnId);
      if (colIndex > 0) {
        card.columnId = columns[colIndex - 1].id;
        await saveKanbanBoard(currentKanbanVaultId, boardData);
        renderKanbanSubView(overviewData, container);
      }
    });
  });

  container.querySelectorAll('.kc-move-right').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.id;
      const card = boardData.cards.find((c) => c.id === cardId);
      if (!card) return;
      const colIndex = columns.findIndex((col) => col.id === card.columnId);
      if (colIndex < columns.length - 1) {
        card.columnId = columns[colIndex + 1].id;
        await saveKanbanBoard(currentKanbanVaultId, boardData);
        renderKanbanSubView(overviewData, container);
      }
    });
  });

  container.querySelectorAll('.kc-toggle-done').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.id;
      const card = boardData.cards.find((c) => c.id === cardId);
      if (!card) return;
      card.columnId = card.columnId === 'done' ? 'todo' : 'done';
      await saveKanbanBoard(currentKanbanVaultId, boardData);
      renderKanbanSubView(overviewData, container);
    });
  });

  container.querySelectorAll('.kc-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.id;
      const card = boardData.cards.find((c) => c.id === cardId);
      if (!card) return;
      showEditCardModal(card, card.columnId, currentKanbanVaultId, boardData, () => {
        renderKanbanSubView(overviewData, container);
      });
    });
  });

  container.querySelectorAll('.kc-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.id;
      const ok = await showConfirm({
        title: '删除任务卡片',
        message: '确定要删除此任务卡片吗？该操作不会修改笔记本身的内容。',
        confirmText: '删除卡片',
        type: 'danger',
        icon: '🗑️',
      });
      if (!ok) return;
      boardData.cards = boardData.cards.filter((c) => c.id !== cardId);
      await saveKanbanBoard(currentKanbanVaultId, boardData);
      toast('任务卡片已删除');
      renderKanbanSubView(overviewData, container);
    });
  });

  let draggedCardId = null;

  container.querySelectorAll('.kanban-card').forEach((cardElem) => {
    cardElem.addEventListener('dragstart', (e) => {
      draggedCardId = cardElem.dataset.cardId;
      cardElem.style.opacity = '0.5';
      e.dataTransfer.setData('text/plain', draggedCardId);
    });

    cardElem.addEventListener('dragend', () => {
      cardElem.style.opacity = '1';
    });
  });

  container.querySelectorAll('.kanban-column').forEach((colElem) => {
    colElem.addEventListener('dragover', (e) => {
      e.preventDefault();
      colElem.style.borderColor = 'var(--accent)';
    });

    colElem.addEventListener('dragleave', () => {
      colElem.style.borderColor = 'var(--border)';
    });

    colElem.addEventListener('drop', async (e) => {
      e.preventDefault();
      colElem.style.borderColor = 'var(--border)';
      const targetColId = colElem.dataset.colId;
      if (!draggedCardId || !targetColId) return;

      const card = boardData.cards.find((c) => c.id === draggedCardId);
      if (card && card.columnId !== targetColId) {
        card.columnId = targetColId;
        await saveKanbanBoard(currentKanbanVaultId, boardData);
        renderKanbanSubView(overviewData, container);
      }
    });
  });
}

async function saveKanbanBoard(vaultId, board) {
  try {
    const res = await api(`/api/dashboard/kanban/${vaultId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(board),
    });
    if (!res.ok) {
      const err = await res.json();
      toast('保存失败: ' + (err.error || '未知错误'));
    }
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

function showEditCardModal(card, defaultColId, vaultId, boardData, onDone) {
  const isNew = !card;
  const currentCard = card || {
    id: `card-${Date.now()}`,
    columnId: defaultColId || 'todo',
    title: '',
    description: '',
    priority: 'medium',
    tags: [],
    notePath: '',
    dueDate: '',
  };

  const columns = boardData.columns || [];
  const colOptions = columns.map((col) => `
    <option value="${escapeHtml(col.id)}" ${col.id === currentCard.columnId ? 'selected' : ''}>
      ${escapeHtml(col.title)}
    </option>
  `).join('');

  const html = `
    <div class="modal-header">
      <h3>${isNew ? '➕ 新建任务卡片' : '✏️ 编辑任务卡片'}</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;">
      <div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">任务标题 *</label>
        <input type="text" id="card-title-input" value="${escapeHtml(currentCard.title)}" placeholder="请输入任务标题..." style="width:100%;margin:0;padding:8px 10px;" />
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">所属泳道列</label>
          <select id="card-col-select" style="width:100%;margin:0;padding:7px 10px;">
            ${colOptions}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">优先级</label>
          <select id="card-priority-select" style="width:100%;margin:0;padding:7px 10px;">
            <option value="high" ${currentCard.priority === 'high' ? 'selected' : ''}>🔴 P1 - 高优先级</option>
            <option value="medium" ${currentCard.priority === 'medium' ? 'selected' : ''}>🟡 P2 - 中优先级</option>
            <option value="low" ${currentCard.priority === 'low' ? 'selected' : ''}>🔵 P3 - 低优先级</option>
          </select>
        </div>
      </div>

      <div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">关联笔记路径 (可选)</label>
        <input type="text" id="card-notepath-input" value="${escapeHtml(currentCard.notePath || '')}" placeholder="例如: Projects/Website.md" style="width:100%;margin:0;padding:8px 10px;" />
      </div>

      <div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">截止日期 (可选)</label>
        <input type="date" id="card-duedate-input" value="${escapeHtml(currentCard.dueDate || '')}" style="width:100%;margin:0;padding:7px 10px;" />
      </div>

      <div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">任务详细描述</label>
        <textarea id="card-desc-input" rows="4" placeholder="任务详细背景、步骤或检查清单..." style="width:100%;margin:0;padding:8px 10px;resize:vertical;">${escapeHtml(currentCard.description || '')}</textarea>
      </div>

      <div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">标签 (逗号分隔)</label>
        <input type="text" id="card-tags-input" value="${escapeHtml((currentCard.tags || []).join(', '))}" placeholder="例如: feature, urgent, ui" style="width:100%;margin:0;padding:8px 10px;" />
      </div>
    </div>
    <div class="modal-footer">
      <button id="card-save-btn" class="primary">保存卡片</button>
      <button class="modal-close secondary">取消</button>
    </div>
  `;

  showModal(html, (dialog) => {
    dialog.querySelector('#card-save-btn').onclick = async () => {
      const title = dialog.querySelector('#card-title-input').value.trim();
      if (!title) {
        toast('请输入任务标题');
        return;
      }

      const columnId = dialog.querySelector('#card-col-select').value;
      const priority = dialog.querySelector('#card-priority-select').value;
      const notePath = dialog.querySelector('#card-notepath-input').value.trim();
      const dueDate = dialog.querySelector('#card-duedate-input').value;
      const description = dialog.querySelector('#card-desc-input').value.trim();
      const rawTags = dialog.querySelector('#card-tags-input').value;
      const tags = rawTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);

      if (isNew) {
        boardData.cards.push({
          id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          columnId,
          title,
          description,
          priority,
          tags,
          notePath,
          dueDate,
          createdAt: new Date().toISOString(),
        });
      } else {
        card.title = title;
        card.columnId = columnId;
        card.priority = priority;
        card.description = description;
        card.notePath = notePath;
        card.dueDate = dueDate;
        card.tags = tags;
        card.updatedAt = new Date().toISOString();
      }

      await saveKanbanBoard(vaultId, boardData);
      closeModal();
      toast(isNew ? '任务卡片已创建' : '任务卡片已更新');
      if (onDone) onDone();
    };
  });
}

async function showScanTasksModal(vaultId, boardData, onDone) {
  const loadingHtml = `
    <div class="modal-header">
      <h3>📥 正在扫描笔记待办…</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <div class="empty-state">正在深度扫描 Vault Markdown 笔记中的待办任务清单…</div>
    </div>
  `;
  showModal(loadingHtml);

  let tasks = [];
  try {
    const res = await api(`/api/dashboard/kanban/${vaultId}/scan-tasks`);
    if (res.ok) {
      const body = await res.json();
      tasks = body.tasks || [];
    }
  } catch (err) {
    toast('扫描失败: ' + err.message);
    closeModal();
    return;
  }

  if (tasks.length === 0) {
    const emptyHtml = `
      <div class="modal-header">
        <h3>📥 扫描笔记待办清单</h3>
        <button class="modal-close ghost">✕</button>
      </div>
      <div class="modal-body">
        <div class="empty-state" style="padding:28px;">
          <div style="font-size:32px;margin-bottom:8px;">🔍</div>
          <div style="font-weight:600;">未在笔记中发现待办任务</div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px;">
            在 Obsidian 笔记中使用 <code>- [ ] 任务内容</code> 格式记录的待办事项将自动被提取至此。
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="modal-close primary">知道了</button>
      </div>
    `;
    showModal(emptyHtml);
    return;
  }

  const itemsHtml = tasks.map((t, idx) => `
    <div class="scanned-task-item">
      <input type="checkbox" id="st-${idx}" class="scanned-task-check" data-idx="${idx}" checked />
      <label for="st-${idx}">
        <div class="scanned-task-title">${escapeHtml(t.title)}</div>
        <div class="scanned-task-path">📄 ${escapeHtml(t.notePath)} ${t.completed ? '<span class="badge" style="background:rgba(63,185,80,0.15);color:#3fb950;">已完成</span>' : ''}</div>
      </label>
    </div>
  `).join('');

  const scanResultHtml = `
    <div class="modal-header">
      <h3>📥 发现 ${tasks.length} 项笔记待办任务</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 10px;">
        勾选您需要导入到看板的任务，未完成的任务将加入「📌 待办」列，已勾选完成的任务将加入「✅ 已完成」列：
      </p>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <button id="st-toggle-all-btn" class="secondary" style="font-size:11.5px;padding:3px 8px;">全选 / 取消全选</button>
        <span style="font-size:11.5px;color:var(--muted);">支持直接双向关联原文路径</span>
      </div>

      <div class="scanned-tasks-list">
        ${itemsHtml}
      </div>
    </div>
    <div class="modal-footer">
      <button id="st-import-btn" class="primary">📥 导入所选待办到看板</button>
      <button class="modal-close secondary">取消</button>
    </div>
  `;

  showModal(scanResultHtml, (dialog) => {
    let allChecked = true;
    dialog.querySelector('#st-toggle-all-btn').onclick = () => {
      allChecked = !allChecked;
      dialog.querySelectorAll('.scanned-task-check').forEach((chk) => {
        chk.checked = allChecked;
      });
    };

    dialog.querySelector('#st-import-btn').onclick = async () => {
      const checkedIndexes = [];
      dialog.querySelectorAll('.scanned-task-check:checked').forEach((chk) => {
        checkedIndexes.push(Number(chk.dataset.idx));
      });

      if (checkedIndexes.length === 0) {
        toast('请至少勾选一项任务');
        return;
      }

      let importedCount = 0;
      for (const idx of checkedIndexes) {
        const t = tasks[idx];
        const exists = boardData.cards.some((c) => c.title === t.title && c.notePath === t.notePath);
        if (exists) continue;

        boardData.cards.push({
          id: `card-scanned-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          columnId: t.suggestedColumn || 'todo',
          title: t.title,
          description: `从笔记自动提取: ${t.notePath}`,
          priority: 'medium',
          tags: ['笔记任务'],
          notePath: t.notePath,
          dueDate: '',
          createdAt: new Date().toISOString(),
        });
        importedCount++;
      }

      await saveKanbanBoard(vaultId, boardData);
      closeModal();
      toast(`成功导入 ${importedCount} 条笔记待办到看板！`);
      if (onDone) onDone();
    };
  });
}
