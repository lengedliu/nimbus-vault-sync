// --------------------------- Diff Comparison & Version History ---------------------------
import { api } from '../core/api.js';
import { escapeHtml, formatBytes, translate, encodeURIComponentPath } from '../core/state.js';
import { showModal, closeModal, showConfirm, toast } from '../core/dialogs.js';

/**
 * Compares two strings line by line and renders highlighted additions, deletions, and line numbers.
 */
export function renderDiff(diffContainer, oldStr, newStr) {
  if (!diffContainer) return;
  const oldLines = String(oldStr || '').split('\n');
  const newLines = String(newStr || '').split('\n');
  diffContainer.innerHTML = '';

  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      const div = document.createElement('div');
      div.className = 'diff-line same';
      div.innerHTML = `<span class="diff-gutter">${i + 1}</span> <span>  ${escapeHtml(o || '')}</span>`;
      diffContainer.appendChild(div);
    } else {
      if (o !== undefined) {
        const del = document.createElement('div');
        del.className = 'diff-line del';
        del.innerHTML = `<span class="diff-gutter">-</span> <span>- ${escapeHtml(o)}</span>`;
        diffContainer.appendChild(del);
      }
      if (n !== undefined) {
        const add = document.createElement('div');
        add.className = 'diff-line add';
        add.innerHTML = `<span class="diff-gutter">+</span> <span>+ ${escapeHtml(n)}</span>`;
        diffContainer.appendChild(add);
      }
    }
  }
}

/**
 * Displays modal for viewing file version history, comparing diffs, and rolling back.
 */
export async function showHistoryModal(vaultId, filePath, callbacks = {}) {
  const onRollback = callbacks.onRollback || (() => {
    if (window.Nimbus?.openVault) {
      window.Nimbus.openVault(vaultId, 'files');
    }
  });

  try {
    const res = await api(`/api/vaults/${vaultId}/history?path=${encodeURIComponent(filePath)}`);
    const { history = [] } = await res.json();

    const html = `
      <div class="modal-header">
        <h3>⏱️ 版本历史与差异对比 · ${escapeHtml(filePath)}</h3>
        <button class="modal-close ghost">✕</button>
      </div>
      <div class="modal-body" id="history-modal-body">
        ${
          history.length === 0
            ? '<div class="empty-state">当前笔记尚未产生覆盖修改记录（文件被覆盖更新后会自动留痕）。</div>'
            : `
          <div style="display:flex;flex-direction:column;gap:12px;">
            <p style="color:var(--text-secondary);font-size:13px;">选择一个历史快照进行对比或一键回滚：</p>
            <div id="history-version-items"></div>
            <div id="diff-viewer-wrap" style="display:none;margin-top:16px;">
              <div class="panel-header">
                <h4 style="margin:0;font-size:14px;">📝 差异对比 (绿色为当前新增，红色为历史删除)</h4>
              </div>
              <div id="diff-box" class="diff-container"></div>
            </div>
          </div>
        `
        }
      </div>
      <div class="modal-footer">
        <button class="modal-close secondary">关闭</button>
      </div>
    `;

    showModal(html, (dialog) => {
      const itemsWrap = dialog.querySelector('#history-version-items');
      if (!itemsWrap || history.length === 0) return;

      for (const ver of history) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:var(--panel-2);padding:8px 12px;border-radius:6px;border:1px solid var(--border);';
        row.innerHTML = `
          <div>
            <div style="font-weight:600;font-size:13px">${new Date(ver.savedAt).toLocaleString()}</div>
            <div class="meta">${formatBytes(ver.size)}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="secondary" id="compare-ver-${ver.id}">🔍 对比差异</button>
            <button class="btn-primary" id="restore-ver-${ver.id}">回滚至此版本</button>
          </div>
        `;

        row.querySelector(`#compare-ver-${ver.id}`).onclick = async () => {
          try {
            const histRes = await api(`/api/vaults/${vaultId}/history/${ver.id}`);
            const oldText = await histRes.text();
            let currentText = '';
            try {
              const curRes = await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(filePath)}`);
              currentText = await curRes.text();
            } catch {}

            renderDiff(dialog.querySelector('#diff-box'), oldText, currentText);
            dialog.querySelector('#diff-viewer-wrap').style.display = 'block';
          } catch (err) {
            toast('获取历史快照失败: ' + err.message, 'error');
          }
        };

        row.querySelector(`#restore-ver-${ver.id}`).onclick = async () => {
          const ok = await showConfirm({
            title: '历史版本回滚确认',
            message: `确定将「${filePath}」回滚到 ${new Date(ver.savedAt).toLocaleString()} 的快照版本吗？当前版本会自动存入历史。`,
            confirmText: '确认回滚',
            type: 'warning',
            icon: '⏱️',
          });
          if (!ok) return;

          try {
            await api(`/api/vaults/${vaultId}/history/${ver.id}/restore`, { method: 'POST' });
            toast('已回滚至历史版本');
            closeModal();
            onRollback(vaultId, filePath);
          } catch (err) {
            toast('回滚失败: ' + err.message, 'error');
          }
        };

        itemsWrap.appendChild(row);
      }
      translate(dialog);
    });
  } catch (err) {
    toast('无法加载历史版本: ' + err.message, 'error');
  }
}
