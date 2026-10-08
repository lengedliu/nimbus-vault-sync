// --------------------------- View: All Vaults Overview ---------------------------
import { $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';

export async function renderAllVaultsPanel(containerEl = null, { openVault } = {}) {
  const mainPanel = containerEl || $('#main-panel');
  if (!mainPanel) return;

  mainPanel.innerHTML = '<div class="empty-state">加载 Vault 列表中…</div>';
  try {
    const res = await api('/api/admin/vaults');
    const body = await res.json();

    mainPanel.innerHTML = `
      <div class="panel-header">
        <h2>📚 全局 Vault 状态与管理</h2>
      </div>
      <div id="all-vaults-wrap"></div>
    `;

    const wrap = mainPanel.querySelector('#all-vaults-wrap');
    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Vault 名称</th>
          <th>所有者</th>
          <th>Vault ID</th>
          <th>创建时间</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    for (const v of body.vaults || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>📓 ${escapeHtml(v.name)}</b></td>
        <td><span class="badge">👤 ${escapeHtml(v.ownerUsername || 'admin')}</span></td>
        <td class="meta"><code>${escapeHtml(v.id)}</code></td>
        <td class="meta">${new Date(v.createdAt).toLocaleString()}</td>
        <td class="actions" style="text-align:right">
          <button class="secondary open-vault-btn" data-vault-id="${v.id}">打开浏览</button>
          <button class="btn-primary manage-perm-btn" data-vault-id="${v.id}">👥 权限设置</button>
        </td>
      `;
      tr.querySelector('.open-vault-btn').onclick = () => {
        if (openVault) {
          openVault(v.id, 'files');
        } else if (window.Nimbus?.openVault) {
          window.Nimbus.openVault(v.id, 'files');
        }
      };
      tr.querySelector('.manage-perm-btn').onclick = () => {
        if (openVault) {
          openVault(v.id, 'permissions');
        } else if (window.Nimbus?.openVault) {
          window.Nimbus.openVault(v.id, 'permissions');
        }
      };
      tbody.appendChild(tr);
    }
    wrap.appendChild(table);
    translate(mainPanel);
  } catch (err) {
    mainPanel.innerHTML = `<div class="empty-state" style="color:var(--danger)">加载 Vault 列表失败: ${escapeHtml(err.message)}</div>`;
  }
}
