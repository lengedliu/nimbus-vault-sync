// --------------------------- Subtab: Conflicts Resolution Center ---------------------------
import { escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderConflictsSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">检测冲突文件中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/conflicts`);
    const { conflicts } = await res.json();

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom:14px;">
        <div>
          <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:6px;">
            <span>⚔️</span>
            <span>多设备并发冲突解决中心</span>
            ${conflicts.length > 0 ? `<span class="conflict-badge">${conflicts.length} 个未解决冲突</span>` : ''}
          </h3>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
            当多台 Obsidian 客户端离线编辑同一笔记后同时连网推送时，服务端会自动创建分支冲突副本并保留两端数据，在此可一键比对差异与智能合并
          </div>
        </div>
        <div>
          <button class="secondary" id="conflicts-refresh-btn">🔄 重新检测</button>
        </div>
      </div>
      <div id="conflicts-main-wrap"></div>
    `;

    container.querySelector('#conflicts-refresh-btn').onclick = () => renderConflictsSubtab(vaultId, container);

    const wrap = container.querySelector('#conflicts-main-wrap');
    if (conflicts.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state" style="padding:48px 16px;">
          <div style="font-size:40px;margin-bottom:10px;">✨</div>
          <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:4px;">笔记库暂无文件冲突</div>
          <div style="font-size:13px;color:var(--muted)">所有多端同步数据均已正常统一</div>
        </div>
      `;
      return;
    }

    for (const item of conflicts) {
      const card = document.createElement('div');
      card.className = 'conflict-card has-conflict';
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="font-weight:600;font-size:14px;color:var(--text);display:flex;align-items:center;gap:6px;">
              <span>⚠️ 冲突源文件:</span>
              <code>${escapeHtml(item.basePath || '未知文件')}</code>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
              <span>冲突副本: <code>${escapeHtml(item.conflictPath)}</code></span>
              <span style="margin-left:12px;color:var(--muted)">冲突时间: ${new Date(item.conflictMtime).toLocaleString()}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn-primary open-diff-btn" style="font-size:12.5px;padding:5px 12px;">🔍 查看差异与合并</button>
            <button class="danger delete-conflict-btn" style="font-size:12.5px;padding:5px 10px;">🗑️ 放弃此冲突副本</button>
          </div>
        </div>
        <div class="conflict-diff-area hidden" style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;"></div>
      `;

      card.querySelector('.delete-conflict-btn').onclick = async () => {
        const ok = await showConfirm({
          title: '丢弃冲突副本',
          message: `确定直接丢弃冲突副本「${item.conflictPath}」吗？`,
          confirmText: '丢弃副本',
          type: 'danger',
          icon: '⚔️',
        });
        if (!ok) return;
        try {
          await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'keep-current' }),
          });
          toast('已丢弃冲突副本');
          renderConflictsSubtab(vaultId, container);
        } catch (e) {
          toast('操作失败: ' + e.message);
        }
      };

      const diffArea = card.querySelector('.conflict-diff-area');
      const openDiffBtn = card.querySelector('.open-diff-btn');

      openDiffBtn.onclick = async () => {
        if (!diffArea.classList.contains('hidden')) {
          diffArea.classList.add('hidden');
          openDiffBtn.textContent = '🔍 查看差异与合并';
          return;
        }

        diffArea.classList.remove('hidden');
        diffArea.innerHTML = '<div class="empty-state" style="padding:16px;">加载差异比对中…</div>';
        openDiffBtn.textContent = '收起差异面板 ▲';

        try {
          const diffRes = await api(`/api/vaults/${vaultId}/conflicts/diff?conflictPath=${encodeURIComponent(item.conflictPath)}`);
          const diffData = await diffRes.json();

          if (!diffData.isText) {
            diffArea.innerHTML = `
              <div style="padding:12px;background:var(--panel-2);border-radius:6px;font-size:13px;">
                <p>该文件为二进制媒体或附件文件，无法进行纯文本差异比对。</p>
                <div style="display:flex;gap:8px;margin-top:10px;">
                  <button class="secondary act-keep-current">🛡️ 保留服务端当前版本</button>
                  <button class="btn-primary act-keep-conflict">⚡ 采用客户端冲突副本覆盖</button>
                </div>
              </div>
            `;
            diffArea.querySelector('.act-keep-current').onclick = async () => {
              await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'keep-current' }),
              });
              toast('已保留服务端当前版本');
              renderConflictsSubtab(vaultId, container);
            };
            diffArea.querySelector('.act-keep-conflict').onclick = async () => {
              await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'keep-conflict' }),
              });
              toast('已采用冲突版本覆盖');
              renderConflictsSubtab(vaultId, container);
            };
            return;
          }

          diffArea.innerHTML = `
            <div class="conflict-diff-container">
              <div class="diff-pane">
                <div class="diff-pane-header server">
                  <span>🖥️ 服务端当前版本 (Server Current)</span>
                  <span style="font-weight:normal;font-size:11px;opacity:0.8">${formatBytes(diffData.baseSize)}</span>
                </div>
                <div class="diff-pane-content">${escapeHtml(diffData.baseContent || '(空文件或未创建)')}</div>
              </div>
              <div class="diff-pane">
                <div class="diff-pane-header client">
                  <span>📱 客户端上传冲突版本 (Client Conflict)</span>
                  <span style="font-weight:normal;font-size:11px;opacity:0.8">${formatBytes(diffData.conflictSize)}</span>
                </div>
                <div class="diff-pane-content">${escapeHtml(diffData.conflictContent)}</div>
              </div>
            </div>

            <div class="conflict-actions-bar">
              <span style="font-size:12.5px;font-weight:600;color:var(--text);margin-right:4px;">⚡ 快速解决策略:</span>
              <button class="secondary act-keep-current" title="丢弃冲突副本，维持服务端现有文件">🛡️ 保留当前版本</button>
              <button class="secondary act-keep-conflict" title="使用客户端冲突副本覆盖现有文件">⚡ 采纳冲突版本</button>
              <button class="btn-primary act-merge-both" title="将两份笔记内容按标记合并至同一文件中">🔀 智能合并两者 (带标记)</button>
              <button class="secondary act-custom-edit" title="在网页上直接编辑最终合并内容">✍️ 手动编辑合并</button>
            </div>

            <div class="custom-edit-box hidden" style="margin-top:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:13px;font-weight:600;">自定义最终合并内容:</span>
                <button class="btn-primary act-save-custom" style="padding:4px 12px;font-size:12px;">💾 保存并解决冲突</button>
              </div>
              <textarea class="custom-merge-textarea" rows="12" style="width:100%;font-family:ui-monospace,monospace;font-size:12.5px;background:var(--panel-2);">${escapeHtml(diffData.mergedPreview)}</textarea>
            </div>
          `;

          diffArea.querySelector('.act-keep-current').onclick = async () => {
            await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'keep-current' }),
            });
            toast('已解决：保留当前版本');
            renderConflictsSubtab(vaultId, container);
          };

          diffArea.querySelector('.act-keep-conflict').onclick = async () => {
            await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'keep-conflict' }),
            });
            toast('已解决：采用冲突版本覆盖');
            renderConflictsSubtab(vaultId, container);
          };

          diffArea.querySelector('.act-merge-both').onclick = async () => {
            await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conflictPath: item.conflictPath, resolution: 'merge-both' }),
            });
            toast('已解决：已将两份笔记内容合并保存');
            renderConflictsSubtab(vaultId, container);
          };

          const customEditBox = diffArea.querySelector('.custom-edit-box');
          diffArea.querySelector('.act-custom-edit').onclick = () => {
            customEditBox.classList.toggle('hidden');
          };

          diffArea.querySelector('.act-save-custom').onclick = async () => {
            const text = customEditBox.querySelector('.custom-merge-textarea').value;
            await api(`/api/vaults/${vaultId}/conflicts/resolve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conflictPath: item.conflictPath,
                resolution: 'custom',
                customContent: text,
              }),
            });
            toast('已解决：已保存自定义合并内容');
            renderConflictsSubtab(vaultId, container);
          };
        } catch (err) {
          diffArea.innerHTML = `<div class="empty-state" style="color:#e74c3c;">获取差异比对失败: ${escapeHtml(err.message)}</div>`;
        }
      };

      wrap.appendChild(card);
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:#e74c3c;">加载冲突解决中心失败: ${escapeHtml(err.message)}</div>`;
  }
  translate(container);
}
