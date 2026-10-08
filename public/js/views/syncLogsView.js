// --------------------------- View: Sync Logs (Admin Global & Vault Subtab) ---------------------------
import { $, escapeHtml, formatBytes, translate, state } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderAdminSyncLogsPanel() {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">加载全局同步日志中…</div>';

  let currentAction = '';
  let currentStatus = '';
  let currentSearch = '';
  let currentVaultFilter = '';
  let currentPage = 1;
  const pageSize = 50;

  async function loadLogs() {
    const q = new URLSearchParams();
    if (currentAction) q.set('action', currentAction);
    if (currentStatus) q.set('status', currentStatus);
    if (currentSearch) q.set('search', currentSearch);
    if (currentVaultFilter) q.set('vaultId', currentVaultFilter);
    q.set('limit', String(pageSize));
    q.set('offset', String((currentPage - 1) * pageSize));

    const res = await api(`/api/admin/sync-logs?${q.toString()}`);
    const data = await res.json();
    renderUI(data);
  }

  function renderUI(data) {
    const logs = data.logs || [];
    const total = data.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const vaultOptions = state.vaults.map((v) => `<option value="${v.id}" ${v.id === currentVaultFilter ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');

    mainPanel.innerHTML = `
      <div class="panel-header" style="margin-bottom:12px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px;">
            <span>📋</span>
            <span>全局笔记同步日志 (Global Sync Logs)</span>
          </h2>
          <div style="font-size:13px;color:var(--muted)">监控审计所有客户端在所有 Vault 上的实时同步活动记录 (共 ${total} 条)</div>
        </div>
        <div class="sync-logs-actions">
          <button class="secondary" id="admin-logs-refresh-btn">🔄 刷新数据</button>
        </div>
      </div>

      <div class="sync-logs-controls">
        <div class="sync-logs-filters">
          <select id="admin-log-filter-vault">
            <option value="">全部 Vault (All Vaults)</option>
            ${vaultOptions}
          </select>

          <select id="admin-log-filter-action">
            <option value="">全部同步动作 (All Actions)</option>
            <option value="update" ${currentAction === 'update' ? 'selected' : ''}>📝 更新 / 推送 (Push/Update)</option>
            <option value="pull" ${currentAction === 'pull' ? 'selected' : ''}>📥 读取 / 拉取 (Pull)</option>
            <option value="conflict" ${currentAction === 'conflict' ? 'selected' : ''}>⚠️ 冲突副本 (Conflict)</option>
            <option value="delete" ${currentAction === 'delete' ? 'selected' : ''}>🗑️ 删除文件 (Delete)</option>
            <option value="ignore" ${currentAction === 'ignore' ? 'selected' : ''}>🚫 规则忽略 (Ignored)</option>
            <option value="error" ${currentAction === 'error' ? 'selected' : ''}>❌ 异常错误 (Error)</option>
          </select>

          <select id="admin-log-filter-status">
            <option value="">全部状态 (All Status)</option>
            <option value="success" ${currentStatus === 'success' ? 'selected' : ''}>✓ 成功 (Success)</option>
            <option value="conflict" ${currentStatus === 'conflict' ? 'selected' : ''}>⚠️ 冲突 (Conflict)</option>
            <option value="error" ${currentStatus === 'error' ? 'selected' : ''}>✕ 错误 (Error)</option>
            <option value="ignored" ${currentStatus === 'ignored' ? 'selected' : ''}>- 忽略 (Ignored)</option>
          </select>

          <input type="text" id="admin-log-filter-search" placeholder="搜索文件名、路径或设备…" value="${escapeHtml(currentSearch)}" style="width:200px;" />
          <button class="secondary" id="admin-log-search-btn">🔍 筛选</button>
        </div>
      </div>

      <div class="sync-logs-table-wrap">
        <table class="data-table" style="width:100%;">
          <thead>
            <tr>
              <th style="width:140px;">时间</th>
              <th style="width:85px;">动作</th>
              <th>文件路径</th>
              <th style="width:80px;">大小</th>
              <th style="width:120px;">用户 / 设备</th>
              <th style="width:80px;">状态</th>
              <th>详细说明</th>
            </tr>
          </thead>
          <tbody id="admin-logs-tbody"></tbody>
        </table>
      </div>

      <div class="sync-logs-pagination" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:8px 4px;font-size:13px;color:var(--text-secondary);">
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="secondary" id="admin-log-prev-btn" style="padding:4px 10px;font-size:12px;" ${currentPage <= 1 ? 'disabled' : ''}>◀ 上一页</button>
          <span style="margin:0 6px;">第 <b>${currentPage}</b> / <b>${totalPages}</b> 页 (共 ${total} 条)</span>
          <button class="secondary" id="admin-log-next-btn" style="padding:4px 10px;font-size:12px;" ${currentPage >= totalPages ? 'disabled' : ''}>下一页 ▶</button>
        </div>
        <div style="font-size:12px;color:var(--muted);">每页显示 ${pageSize} 条记录</div>
      </div>
    `;

    // Event bindings
    mainPanel.querySelector('#admin-logs-refresh-btn').onclick = () => loadLogs();
    mainPanel.querySelector('#admin-log-search-btn').onclick = () => {
      currentVaultFilter = mainPanel.querySelector('#admin-log-filter-vault').value;
      currentAction = mainPanel.querySelector('#admin-log-filter-action').value;
      currentStatus = mainPanel.querySelector('#admin-log-filter-status').value;
      currentSearch = mainPanel.querySelector('#admin-log-filter-search').value.trim();
      currentPage = 1;
      loadLogs();
    };
    mainPanel.querySelector('#admin-log-filter-vault').onchange = () => {
      currentVaultFilter = mainPanel.querySelector('#admin-log-filter-vault').value;
      currentPage = 1;
      loadLogs();
    };
    mainPanel.querySelector('#admin-log-filter-action').onchange = () => {
      currentAction = mainPanel.querySelector('#admin-log-filter-action').value;
      currentPage = 1;
      loadLogs();
    };
    mainPanel.querySelector('#admin-log-filter-status').onchange = () => {
      currentStatus = mainPanel.querySelector('#admin-log-filter-status').value;
      currentPage = 1;
      loadLogs();
    };
    mainPanel.querySelector('#admin-log-filter-search').onkeydown = (e) => {
      if (e.key === 'Enter') {
        currentSearch = mainPanel.querySelector('#admin-log-filter-search').value.trim();
        currentPage = 1;
        loadLogs();
      }
    };

    const prevBtn = mainPanel.querySelector('#admin-log-prev-btn');
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (currentPage > 1) {
          currentPage--;
          loadLogs();
        }
      };
    }
    const nextBtn = mainPanel.querySelector('#admin-log-next-btn');
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (currentPage < totalPages) {
          currentPage++;
          loadLogs();
        }
      };
    }

    const tbody = mainPanel.querySelector('#admin-logs-tbody');
    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">暂无符合条件的全局同步日志</td></tr>`;
      translate(mainPanel);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of logs) {
      const tr = document.createElement('tr');
      const actionMap = {
        update: { label: '更新', cls: 'update' },
        pull: { label: '拉取', cls: 'pull' },
        delete: { label: '删除', cls: 'delete' },
        conflict: { label: '冲突', cls: 'conflict' },
        ignore: { label: '忽略', cls: 'ignore' },
        error: { label: '错误', cls: 'error' },
      };
      const actInfo = actionMap[item.action] || { label: item.action, cls: 'pull' };

      const statusIcon = item.status === 'success' ? '✓ 成功' : item.status === 'conflict' ? '⚠️ 冲突' : item.status === 'error' ? '✕ 失败' : '- 忽略';
      const statusClass = item.status || 'success';

      tr.innerHTML = `
        <td class="meta" style="font-size:12px;">${new Date(item.timestamp).toLocaleString()}</td>
        <td><span class="sync-log-badge ${actInfo.cls}">${actInfo.label}</span></td>
        <td><b style="font-family:ui-monospace,monospace;font-size:12.5px;">${escapeHtml(item.path)}</b></td>
        <td class="meta" style="font-size:12px;">${item.size ? formatBytes(item.size) : '-'}</td>
        <td class="meta" style="font-size:12px;">
          <div><b>👤 ${escapeHtml(item.username || 'user')}</b></div>
          <div style="color:var(--muted)">💻 ${escapeHtml(item.deviceName || 'Client')}</div>
        </td>
        <td><span class="sync-log-status ${statusClass}">${statusIcon}</span></td>
        <td style="font-size:12px;color:var(--text-secondary);">${escapeHtml(item.detail || '')}</td>
      `;
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
    translate(mainPanel);
  }

  loadLogs().catch((err) => {
    mainPanel.innerHTML = `<div class="empty-state">加载全局日志失败: ${escapeHtml(err.message)}</div>`;
  });
}

export async function renderVaultSyncLogsSubtab(vaultId, container) {
  if (!container) return;
  container.innerHTML = '<div class="empty-state">加载同步日志中…</div>';

  let currentAction = '';
  let currentStatus = '';
  let currentSearch = '';
  let currentPage = 1;
  const pageSize = 40;

  async function loadLogs() {
    const q = new URLSearchParams();
    if (currentAction) q.set('action', currentAction);
    if (currentStatus) q.set('status', currentStatus);
    if (currentSearch) q.set('search', currentSearch);
    q.set('limit', String(pageSize));
    q.set('offset', String((currentPage - 1) * pageSize));

    const res = await api(`/api/vaults/${vaultId}/sync-logs?${q.toString()}`);
    const data = await res.json();
    renderUI(data);
  }

  function renderUI(data) {
    const logs = data.logs || [];
    const total = data.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom:12px;">
        <div>
          <h3 style="margin:0;font-size:16px;">📋 笔记同步日志 (Sync Logs)</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">实时追踪与审计所有设备客户端的推送、拉取、冲突、删除等同步记录 (共 ${total} 条)</div>
        </div>
        <div class="sync-logs-actions">
          <button class="secondary" id="sync-logs-refresh-btn">🔄 刷新</button>
          ${total > 0 ? `<button class="danger" id="sync-logs-clear-btn">🗑️ 清空此库日志</button>` : ''}
        </div>
      </div>

      <div class="sync-logs-controls">
        <div class="sync-logs-filters">
          <select id="log-filter-action">
            <option value="">全部同步动作 (All Actions)</option>
            <option value="update" ${currentAction === 'update' ? 'selected' : ''}>📝 更新 / 推送 (Push/Update)</option>
            <option value="pull" ${currentAction === 'pull' ? 'selected' : ''}>📥 读取 / 拉取 (Pull)</option>
            <option value="conflict" ${currentAction === 'conflict' ? 'selected' : ''}>⚠️ 冲突副本 (Conflict)</option>
            <option value="delete" ${currentAction === 'delete' ? 'selected' : ''}>🗑️ 删除文件 (Delete)</option>
            <option value="ignore" ${currentAction === 'ignore' ? 'selected' : ''}>🚫 规则忽略 (Ignored)</option>
            <option value="error" ${currentAction === 'error' ? 'selected' : ''}>❌ 异常错误 (Error)</option>
          </select>

          <select id="log-filter-status">
            <option value="">全部状态 (All Status)</option>
            <option value="success" ${currentStatus === 'success' ? 'selected' : ''}>✓ 成功 (Success)</option>
            <option value="conflict" ${currentStatus === 'conflict' ? 'selected' : ''}>⚠️ 冲突 (Conflict)</option>
            <option value="error" ${currentStatus === 'error' ? 'selected' : ''}>✕ 错误 (Error)</option>
            <option value="ignored" ${currentStatus === 'ignored' ? 'selected' : ''}>- 忽略 (Ignored)</option>
          </select>

          <input type="text" id="log-filter-search" placeholder="搜索文件名、路径或设备名…" value="${escapeHtml(currentSearch)}" style="width:200px;" />
          <button class="secondary" id="log-search-btn">🔍 筛选</button>
        </div>
      </div>

      <div class="sync-logs-table-wrap">
        <table class="data-table" style="width:100%;">
          <thead>
            <tr>
              <th style="width:140px;">时间戳</th>
              <th style="width:90px;">动作</th>
              <th>笔记 / 文件路径</th>
              <th style="width:80px;">大小</th>
              <th style="width:130px;">客户端设备 / IP</th>
              <th style="width:80px;">状态</th>
              <th>详细说明</th>
            </tr>
          </thead>
          <tbody id="sync-logs-tbody"></tbody>
        </table>
      </div>

      <div class="sync-logs-pagination" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:8px 4px;font-size:13px;color:var(--text-secondary);">
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="secondary" id="log-prev-btn" style="padding:4px 10px;font-size:12px;" ${currentPage <= 1 ? 'disabled' : ''}>◀ 上一页</button>
          <span style="margin:0 6px;">第 <b>${currentPage}</b> / <b>${totalPages}</b> 页 (共 ${total} 条)</span>
          <button class="secondary" id="log-next-btn" style="padding:4px 10px;font-size:12px;" ${currentPage >= totalPages ? 'disabled' : ''}>下一页 ▶</button>
        </div>
        <div style="font-size:12px;color:var(--muted);">每页显示 ${pageSize} 条记录</div>
      </div>
    `;

    container.querySelector('#sync-logs-refresh-btn').onclick = () => loadLogs();
    container.querySelector('#log-search-btn').onclick = () => {
      currentAction = container.querySelector('#log-filter-action').value;
      currentStatus = container.querySelector('#log-filter-status').value;
      currentSearch = container.querySelector('#log-filter-search').value.trim();
      currentPage = 1;
      loadLogs();
    };
    container.querySelector('#log-filter-action').onchange = () => {
      currentAction = container.querySelector('#log-filter-action').value;
      currentPage = 1;
      loadLogs();
    };
    container.querySelector('#log-filter-status').onchange = () => {
      currentStatus = container.querySelector('#log-filter-status').value;
      currentPage = 1;
      loadLogs();
    };
    container.querySelector('#log-filter-search').onkeydown = (e) => {
      if (e.key === 'Enter') {
        currentSearch = container.querySelector('#log-filter-search').value.trim();
        currentPage = 1;
        loadLogs();
      }
    };

    const clearBtn = container.querySelector('#sync-logs-clear-btn');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const ok = await showConfirm({
          title: '清空同步日志',
          message: '确定清空此 Vault 的所有同步历史记录吗？清空后不可恢复。',
          confirmText: '清空日志',
          type: 'danger',
        });
        if (!ok) return;
        try {
          await api(`/api/vaults/${vaultId}/sync-logs`, { method: 'DELETE' });
          toast('同步日志已清空');
          loadLogs();
        } catch (e) {
          toast('清空失败: ' + e.message);
        }
      };
    }

    const prevBtn = container.querySelector('#log-prev-btn');
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (currentPage > 1) {
          currentPage--;
          loadLogs();
        }
      };
    }
    const nextBtn = container.querySelector('#log-next-btn');
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (currentPage < totalPages) {
          currentPage++;
          loadLogs();
        }
      };
    }

    const tbody = container.querySelector('#sync-logs-tbody');
    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">暂无同步日志记录</td></tr>`;
      translate(container);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of logs) {
      const tr = document.createElement('tr');
      const actionMap = {
        update: { label: '更新', cls: 'update' },
        pull: { label: '拉取', cls: 'pull' },
        delete: { label: '删除', cls: 'delete' },
        conflict: { label: '冲突', cls: 'conflict' },
        ignore: { label: '忽略', cls: 'ignore' },
        error: { label: '错误', cls: 'error' },
      };
      const actInfo = actionMap[item.action] || { label: item.action, cls: 'pull' };
      const statusIcon = item.status === 'success' ? '✓ 成功' : item.status === 'conflict' ? '⚠️ 冲突' : item.status === 'error' ? '✕ 失败' : '- 忽略';
      const statusClass = item.status || 'success';

      tr.innerHTML = `
        <td class="meta" style="font-size:12px;">${new Date(item.timestamp).toLocaleString()}</td>
        <td><span class="sync-log-badge ${actInfo.cls}">${actInfo.label}</span></td>
        <td><b style="font-family:ui-monospace,monospace;font-size:12.5px;">${escapeHtml(item.path)}</b></td>
        <td class="meta" style="font-size:12px;">${item.size ? formatBytes(item.size) : '-'}</td>
        <td class="meta" style="font-size:12px;">
          <div>💻 ${escapeHtml(item.deviceName || 'Client')}</div>
          <div style="font-size:11px;color:var(--muted);">${escapeHtml(item.clientIp || '')}</div>
        </td>
        <td><span class="sync-log-status ${statusClass}">${statusIcon}</span></td>
        <td style="font-size:12px;color:var(--text-secondary);">${escapeHtml(item.detail || '')}</td>
      `;
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
    translate(container);
  }

  loadLogs().catch((err) => {
    container.innerHTML = `<div class="empty-state">加载同步日志失败: ${escapeHtml(err.message)}</div>`;
  });
}
