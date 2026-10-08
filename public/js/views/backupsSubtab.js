// --------------------------- Subtab: Backups & Snapshots ---------------------------
import { state, escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showPrompt, showConfirm, toast } from '../core/dialogs.js';

export async function renderBackupsSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">加载快照与备份中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/backups`);
    const { backups } = await res.json();

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom:14px;">
        <div>
          <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:6px;">
            <span>💾</span>
            <span>全库快照与归档备份</span>
          </h3>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
            创建当前 Vault 的全量 ZIP 打包快照，支持按需一键下载或历史版本归档恢复
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-primary" id="create-snapshot-btn">📸 立即创建全库快照</button>
          <button class="secondary" id="export-live-zip-btn">📦 实时导出 ZIP</button>
        </div>
      </div>
      <div id="backups-list-wrap"></div>
    `;

    container.querySelector('#create-snapshot-btn').onclick = async () => {
      const label = await showPrompt({
        title: '📸 创建全库快照',
        message: '请输入快照备注名称 (例如：版本发布前备份、每月归档):',
        defaultValue: '手动快照',
        placeholder: '例：版本发布前备份',
        icon: '📸',
        confirmText: '确认创建',
      });
      if (label === null) return;
      try {
        toast('正在生成全库 ZIP 快照，请稍候…');
        const r = await api(`/api/vaults/${vaultId}/backups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim() || '手动快照' }),
        });
        const body = await r.json();
        if (body.ok) {
          toast('全库快照创建成功！');
          renderBackupsSubtab(vaultId, container);
        }
      } catch (e) {
        toast('快照创建失败: ' + e.message);
      }
    };

    container.querySelector('#export-live-zip-btn').onclick = () => {
      window.open(`${state.serverBase.replace(/\/$/, '')}/api/vaults/${vaultId}/export?token=${state.token}`, '_blank');
    };

    const wrap = container.querySelector('#backups-list-wrap');
    if (backups.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state" style="padding:48px 16px;">
          <div style="font-size:40px;margin-bottom:10px;">📦</div>
          <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:4px;">暂无历史快照备份</div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">点击右上角「立即创建全库快照」即可一键将当前 Vault 打包存档</div>
        </div>
      `;
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>快照文件名</th>
          <th>备注说明</th>
          <th>大小</th>
          <th>创建时间</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    for (const b of backups) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div style="font-weight:600;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px;">
            <span>📦</span>
            <code>${escapeHtml(b.filename)}</code>
          </div>
        </td>
        <td><span class="badge primary" style="font-size:11px;">${escapeHtml(b.label || '全库快照')}</span></td>
        <td class="meta">${formatBytes(b.size)}</td>
        <td class="meta">${new Date(b.createdAt).toLocaleString()}</td>
        <td class="actions" style="text-align:right">
          <button class="secondary dl-backup-btn" data-id="${b.id}" style="font-size:12px;padding:3px 10px;">⬇️ 下载 ZIP</button>
          <button class="danger del-backup-btn" data-id="${b.id}" style="font-size:12px;padding:3px 8px;margin-left:4px;">🗑️ 删除</button>
        </td>
      `;

      tr.querySelector('.dl-backup-btn').onclick = () => {
        window.open(`${state.serverBase.replace(/\/$/, '')}/api/vaults/${vaultId}/backups/${b.id}/download?token=${state.token}`, '_blank');
      };

      tr.querySelector('.del-backup-btn').onclick = async () => {
        const ok = await showConfirm({
          title: '删除快照备份',
          message: `确定删除快照备份文件「${b.filename}」吗？删除后不可恢复。`,
          confirmText: '确认删除',
          type: 'danger',
          icon: '📦',
        });
        if (!ok) return;
        try {
          await api(`/api/vaults/${vaultId}/backups/${b.id}`, { method: 'DELETE' });
          toast('快照备份已删除');
          renderBackupsSubtab(vaultId, container);
        } catch (e) {
          toast('删除失败: ' + e.message);
        }
      };

      tbody.appendChild(tr);
    }

    wrap.appendChild(table);
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:#e74c3c;">加载快照列表失败: ${escapeHtml(err.message)}</div>`;
    translate(container);
  }
}
