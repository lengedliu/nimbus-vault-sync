// --------------------------- Subtab: Trash Bin ---------------------------
import { escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault } = {}) {
  container.innerHTML = '<div class="empty-state">加载回收站中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/trash`);
    const { trash } = await res.json();

    container.innerHTML = `
      <div class="panel-header">
        <h3 style="margin:0;font-size:16px;">🗑️ 回收站</h3>
        ${trash.length > 0 ? `<button class="danger" id="purge-all-trash-btn">清空回收站 (${trash.length})</button>` : ''}
      </div>
      <div id="trash-table-wrap"></div>
    `;

    if (trash.length > 0) {
      container.querySelector('#purge-all-trash-btn').onclick = async () => {
        const ok = await showConfirm({
          title: '清空回收站确认',
          message: `确定彻底清空回收站中的所有文件（共 ${trash.length} 个）吗？此操作无法撤销。`,
          confirmText: '彻底清空',
          type: 'danger',
          icon: '🗑️',
        });
        if (!ok) return;
        await api(`/api/vaults/${vaultId}/trash/purge-all`, { method: 'POST' });
        toast('回收站已清空');
        renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault });
      };
    }

    const wrap = container.querySelector('#trash-table-wrap');
    if (trash.length === 0) {
      wrap.innerHTML = '<div class="empty-state">回收站是空的</div>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>原始路径</th>
          <th>删除时间</th>
          <th>大小</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    for (const t of trash) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${escapeHtml(t.path)}</b></td>
        <td class="meta">${new Date(t.deletedAt).toLocaleString()}</td>
        <td class="meta">${formatBytes(t.size)}</td>
        <td class="actions">
          <button class="secondary" id="preview-trash-${t.id}">预览</button>
          <button class="btn-primary" id="restore-trash-${t.id}">恢复</button>
          <button class="danger" id="purge-trash-${t.id}">彻底删除</button>
        </td>
      `;

      tr.querySelector(`#preview-trash-${t.id}`).onclick = async () => {
        try {
          const r = await api(`/api/vaults/${vaultId}/trash/${t.id}`);
          const text = await r.text();
          if (showFilePreviewModal) {
            showFilePreviewModal(t.path, text);
          } else if (window.Nimbus?.showFilePreviewModal) {
            window.Nimbus.showFilePreviewModal(t.path, text);
          }
        } catch {
          toast('该文件无法作为纯文本预览');
        }
      };

      tr.querySelector(`#restore-trash-${t.id}`).onclick = async () => {
        await api(`/api/vaults/${vaultId}/trash/${t.id}/restore`, { method: 'POST' });
        toast(`已恢复 "${t.path}"`);
        if (openVault) {
          openVault(vaultId, 'trash');
        } else if (window.Nimbus?.openVault) {
          window.Nimbus.openVault(vaultId, 'trash');
        } else {
          renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault });
        }
      };

      tr.querySelector(`#purge-trash-${t.id}`).onclick = async () => {
        const ok = await showConfirm({
          title: '彻底删除文件确认',
          message: `确定彻底删除回收站中的「${t.path}」吗？此操作无法撤销。`,
          confirmText: '彻底删除',
          type: 'danger',
          icon: '🗑️',
        });
        if (!ok) return;
        await api(`/api/vaults/${vaultId}/trash/${t.id}`, { method: 'DELETE' });
        renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault });
      };

      tbody.appendChild(tr);
    }
    wrap.appendChild(table);
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载回收站失败: ${escapeHtml(err.message || '网络错误')}</div>`;
  }
}
