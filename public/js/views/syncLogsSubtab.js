// --------------------------- Subtab: Vault Sync Logs ---------------------------
import { escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderVaultSyncLogsSubtab(vaultId, container) {
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

    const clearBtn = container.querySelector('#sync-logs-clear-btn');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const ok = await showConfirm({
          title: '清空同步日志',
          message: '确定清空此笔记库的全部同步记录吗？清空后不可恢复。',
          confirmText: '清空日志',
          type: 'danger',
          icon: '📋',
        });
        if (!ok) return;
        try {
          await api(`/api/vaults/${vaultId}/sync-logs`, { method: 'DELETE' });
          toast('同步日志已清空');
          currentPage = 1;
          loadLogs();
        } catch (e) {
          toast('清空失败: ' + e.message);
        }
      };
    }

    container.querySelector('#log-prev-btn').onclick = () => {
      if (currentPage > 1) {
        currentPage--;
        loadLogs();
      }
    };
    container.querySelector('#log-next-btn').onclick = () => {
      if (currentPage < totalPages) {
        currentPage++;
        loadLogs();
      }
    };

    const tbody = container.querySelector('#sync-logs-tbody');
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted)">暂无符合条件的同步日志</td></tr>';
      return;
    }

    for (const log of logs) {
      const tr = document.createElement('tr');
      const actionBadge = `<span class="badge log-act-${log.action}">${escapeHtml(log.action || 'sync')}</span>`;
      const statusBadge = `<span class="badge log-status-${log.status}">${escapeHtml(log.status || 'ok')}</span>`;
      tr.innerHTML = `
        <td class="meta" style="font-size:11.5px;">${new Date(log.timestamp).toLocaleString()}</td>
        <td>${actionBadge}</td>
        <td><code style="font-size:12px;">${escapeHtml(log.path || '-')}</code></td>
        <td class="meta">${log.size ? formatBytes(log.size) : '-'}</td>
        <td style="font-size:12px;">
          <div><b>${escapeHtml(log.deviceName || 'Client')}</b></div>
          <div class="meta" style="font-size:11px;">${escapeHtml(log.ip || '-')}</div>
        </td>
        <td>${statusBadge}</td>
        <td style="font-size:12px;color:var(--text-secondary);">${escapeHtml(log.detail || '-')}</td>
      `;
      tbody.appendChild(tr);
    }
    translate(container);
  }

  loadLogs();
}
