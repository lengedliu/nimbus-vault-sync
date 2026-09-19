// --------------------------- Subtab: Trash Bin ---------------------------
import { escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault } = {}) {
  container.innerHTML = '<div class="empty-state">加载回收站中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/trash`);
    const { trash = [] } = await res.json();

    container.innerHTML = `
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:6px;">
            <span>🗑️</span>
            <span>回收站</span>
          </h3>
          ${trash.length > 0 ? `<span class="badge" style="font-size:12px;padding:2px 8px;border-radius:10px;background:var(--panel-3);color:var(--muted);">${trash.length}</span>` : ''}
        </div>
        ${
          trash.length > 0
            ? `<div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
                <button class="btn-primary" id="restore-all-trash-btn" style="padding:6px 14px;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;">♻️ 恢复全部 (${trash.length})</button>
                <button class="danger" id="purge-all-trash-btn" style="padding:6px 14px;font-size:12.5px;">清空回收站 (${trash.length})</button>
              </div>`
            : ''
        }
      </div>

      ${
        trash.length > 0
          ? `<div id="trash-batch-bar" class="batch-actions-bar" style="display:none;margin-bottom:12px;border-radius:var(--radius);border:1px solid var(--border);">
              <div class="batch-bar-left">
                <span class="batch-badge" id="trash-batch-count">已选择 0 项</span>
              </div>
              <div class="batch-bar-right">
                <button class="batch-btn btn-primary" id="batch-restore-btn">♻️ 恢复所选</button>
                <button class="batch-btn danger" id="batch-purge-btn">🗑️ 彻底删除所选</button>
                <button class="batch-btn secondary" id="batch-clear-btn">取消选择</button>
              </div>
            </div>`
          : ''
      }

      <div id="trash-table-wrap"></div>
    `;

    const refreshTrash = () => {
      if (openVault) {
        openVault(vaultId, 'trash');
      } else if (window.Nimbus?.openVault) {
        window.Nimbus.openVault(vaultId, 'trash');
      } else {
        renderTrashSubtab(vaultId, container, { showFilePreviewModal, openVault });
      }
    };

    if (trash.length > 0) {
      // 恢复全部按钮
      const restoreAllBtn = container.querySelector('#restore-all-trash-btn');
      if (restoreAllBtn) {
        restoreAllBtn.onclick = async () => {
          const ok = await showConfirm({
            title: '恢复全部文件确认',
            message: `确定恢复回收站中的所有文件（共 ${trash.length} 个）吗？\n如果目标路径已存在同名文件，系统将自动创建副本备份。`,
            confirmText: '恢复全部',
            type: 'primary',
            icon: '♻️',
          });
          if (!ok) return;
          try {
            const resp = await api(`/api/vaults/${vaultId}/trash/restore-all`, { method: 'POST' });
            const data = await resp.json();
            toast(`已成功恢复 ${data.restoredCount || trash.length} 个文件`);
            refreshTrash();
          } catch (e) {
            toast(`恢复全部失败: ${e.message}`);
          }
        };
      }

      // 清空回收站按钮
      const purgeAllBtn = container.querySelector('#purge-all-trash-btn');
      if (purgeAllBtn) {
        purgeAllBtn.onclick = async () => {
          const ok = await showConfirm({
            title: '清空回收站确认',
            message: `确定彻底清空回收站中的所有文件（共 ${trash.length} 个）吗？此操作无法撤销。`,
            confirmText: '彻底清空',
            type: 'danger',
            icon: '🗑️',
          });
          if (!ok) return;
          try {
            await api(`/api/vaults/${vaultId}/trash/purge-all`, { method: 'POST' });
            toast('回收站已彻底清空');
            refreshTrash();
          } catch (e) {
            toast(`清空回收站失败: ${e.message}`);
          }
        };
      }
    }

    const wrap = container.querySelector('#trash-table-wrap');
    if (trash.length === 0) {
      wrap.innerHTML = '<div class="empty-state">回收站是空的</div>';
      translate(container);
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width:38px;text-align:center;">
            <input type="checkbox" id="trash-select-all" title="全选 / 取消全选" style="cursor:pointer;" />
          </th>
          <th>原始路径</th>
          <th>删除时间</th>
          <th>大小</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    const selectedIds = new Set();
    const batchBar = container.querySelector('#trash-batch-bar');
    const batchCount = container.querySelector('#trash-batch-count');
    const selectAllCb = table.querySelector('#trash-select-all');

    const updateBatchBar = () => {
      const count = selectedIds.size;
      if (count > 0) {
        if (batchBar) batchBar.style.display = 'flex';
        if (batchCount) batchCount.textContent = `已选择 ${count} 项`;
      } else {
        if (batchBar) batchBar.style.display = 'none';
      }

      if (selectAllCb) {
        selectAllCb.checked = count === trash.length && trash.length > 0;
        selectAllCb.indeterminate = count > 0 && count < trash.length;
      }
    };

    if (selectAllCb) {
      selectAllCb.onchange = () => {
        const checked = selectAllCb.checked;
        const itemCbs = tbody.querySelectorAll('.trash-item-cb');
        if (checked) {
          trash.forEach((t) => selectedIds.add(t.id));
          itemCbs.forEach((cb) => (cb.checked = true));
        } else {
          selectedIds.clear();
          itemCbs.forEach((cb) => (cb.checked = false));
        }
        updateBatchBar();
      };
    }

    // 批量操作栏事件绑定
    if (batchBar) {
      const batchRestoreBtn = container.querySelector('#batch-restore-btn');
      if (batchRestoreBtn) {
        batchRestoreBtn.onclick = async () => {
          if (selectedIds.size === 0) return;
          const ok = await showConfirm({
            title: '批量恢复文件确认',
            message: `确定恢复选中的 ${selectedIds.size} 个文件吗？\n如果目标路径已存在同名文件，系统将自动创建副本备份。`,
            confirmText: '恢复所选',
            type: 'primary',
            icon: '♻️',
          });
          if (!ok) return;
          try {
            const resp = await api(`/api/vaults/${vaultId}/trash/restore-batch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: Array.from(selectedIds) }),
            });
            const data = await resp.json();
            toast(`已成功恢复 ${data.restoredCount || selectedIds.size} 个文件`);
            refreshTrash();
          } catch (e) {
            toast(`批量恢复失败: ${e.message}`);
          }
        };
      }

      const batchPurgeBtn = container.querySelector('#batch-purge-btn');
      if (batchPurgeBtn) {
        batchPurgeBtn.onclick = async () => {
          if (selectedIds.size === 0) return;
          const ok = await showConfirm({
            title: '批量彻底删除确认',
            message: `确定彻底删除选中的 ${selectedIds.size} 个文件吗？此操作无法撤销。`,
            confirmText: '彻底删除',
            type: 'danger',
            icon: '🗑️',
          });
          if (!ok) return;
          try {
            await api(`/api/vaults/${vaultId}/trash/purge-batch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: Array.from(selectedIds) }),
            });
            toast(`已彻底删除 ${selectedIds.size} 个文件`);
            refreshTrash();
          } catch (e) {
            toast(`批量删除失败: ${e.message}`);
          }
        };
      }

      const batchClearBtn = container.querySelector('#batch-clear-btn');
      if (batchClearBtn) {
        batchClearBtn.onclick = () => {
          selectedIds.clear();
          tbody.querySelectorAll('.trash-item-cb').forEach((cb) => (cb.checked = false));
          updateBatchBar();
        };
      }
    }

    for (const t of trash) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="text-align:center;">
          <input type="checkbox" class="trash-item-cb" data-id="${escapeHtml(t.id)}" style="cursor:pointer;" />
        </td>
        <td><b>${escapeHtml(t.path)}</b></td>
        <td class="meta">${new Date(t.deletedAt).toLocaleString()}</td>
        <td class="meta">${formatBytes(t.size)}</td>
        <td class="actions">
          <button class="secondary" id="preview-trash-${t.id}">预览</button>
          <button class="btn-primary" id="restore-trash-${t.id}">恢复</button>
          <button class="danger" id="purge-trash-${t.id}">彻底删除</button>
        </td>
      `;

      const rowCb = tr.querySelector('.trash-item-cb');
      rowCb.onchange = () => {
        if (rowCb.checked) {
          selectedIds.add(t.id);
        } else {
          selectedIds.delete(t.id);
        }
        updateBatchBar();
      };

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
        try {
          await api(`/api/vaults/${vaultId}/trash/${t.id}/restore`, { method: 'POST' });
          toast(`已恢复 "${t.path}"`);
          refreshTrash();
        } catch (e) {
          toast(`恢复失败: ${e.message}`);
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
        try {
          await api(`/api/vaults/${vaultId}/trash/${t.id}`, { method: 'DELETE' });
          toast(`已删除 "${t.path}"`);
          refreshTrash();
        } catch (e) {
          toast(`彻底删除失败: ${e.message}`);
        }
      };

      tbody.appendChild(tr);
    }
    wrap.appendChild(table);
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载回收站失败: ${escapeHtml(err.message || '网络错误')}</div>`;
  }
}

