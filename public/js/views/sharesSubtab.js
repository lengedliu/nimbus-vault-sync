// --------------------------- Subtab: Public Shares ---------------------------
import { state, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, showModal, closeModal, toast } from '../core/dialogs.js';

export async function renderSharesSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">加载分享列表中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/shares`);
    const { shares } = await res.json();

    container.innerHTML = `
      <div class="panel-header">
        <h3 style="margin:0;font-size:16px;">🔗 已公开分享的笔记</h3>
      </div>
      <div id="shares-table-wrap"></div>
    `;

    const wrap = container.querySelector('#shares-table-wrap');
    if (shares.length === 0) {
      wrap.innerHTML = '<div class="empty-state">尚未创建任何公开分享链接。在笔记列表中点击「🔗 分享」即可生成。</div>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>标题 / 路径</th>
          <th>保护状态</th>
          <th>阅读次数</th>
          <th>创建时间</th>
          <th>有效期</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    for (const s of shares) {
      const shareUrl = `${state.serverBase.replace(/\/$/, '')}/share/${s.id}`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div style="font-weight:600">${escapeHtml(s.title)}</div>
          <div class="meta">${escapeHtml(s.filePath)}</div>
        </td>
        <td>${s.hasPassword ? '🔒 密码保护' : '🌐 公开可读'}</td>
        <td class="meta">${s.viewCount} 次</td>
        <td class="meta">${new Date(s.createdAt).toLocaleDateString()}</td>
        <td class="meta">${s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '永久有效'}</td>
        <td class="actions">
          <button class="secondary" id="copy-share-url-${s.id}">复制链接</button>
          <a class="btn secondary" href="${shareUrl}" target="_blank" style="text-decoration:none">打开</a>
          <button class="danger" id="del-share-${s.id}">撤销</button>
        </td>
      `;

      tr.querySelector(`#copy-share-url-${s.id}`).onclick = () => {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(shareUrl).then(() => toast('分享链接已复制'));
        } else {
          prompt('复制分享链接：', shareUrl);
        }
      };

      tr.querySelector(`#del-share-${s.id}`).onclick = async () => {
        const ok = await showConfirm({
          title: '撤销公开分享',
          message: `确定撤销针对「${s.title}」的公开分享吗？撤销后该分享链接将立即失效。`,
          confirmText: '撤销分享',
          type: 'danger',
          icon: '🔗',
        });
        if (!ok) return;
        await api(`/api/vaults/${vaultId}/shares/${s.id}`, { method: 'DELETE' });
        toast('分享已撤销');
        renderSharesSubtab(vaultId, container);
      };

      tbody.appendChild(tr);
    }
    wrap.appendChild(table);
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载分享失败: ${escapeHtml(err.message || '网络错误')}</div>`;
  }
}

export function showCreateShareModal(vaultId, filePath) {
  const filename = filePath.split('/').pop().replace(/\.md$/, '');
  const html = `
    <div class="modal-header">
      <h3>🔗 分享笔记 · ${escapeHtml(filePath)}</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <label>分享标题
        <input id="share-title-input" type="text" value="${escapeHtml(filename)}" />
      </label>
      <label>访问密码 (选填，留空则免密访问)
        <input id="share-pwd-input" type="password" placeholder="设置访问密码" />
      </label>
      <label>有效期
        <select id="share-exp-select">
          <option value="0">永久有效</option>
          <option value="1">1 天后过期</option>
          <option value="7" selected>7 天后过期</option>
          <option value="30">30 天后过期</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:14px;">
        <input id="share-copy-checkbox" type="checkbox" checked style="width:auto;margin:0" />
        <span>允许访客一键复制全文正文</span>
      </label>
    </div>
    <div class="modal-footer">
      <button id="create-share-submit" class="btn-primary">生成分享链接</button>
      <button class="modal-close secondary">取消</button>
    </div>
  `;

  showModal(html, (dialog) => {
    dialog.querySelector('#create-share-submit').onclick = async () => {
      const title = dialog.querySelector('#share-title-input').value.trim() || filename;
      const password = dialog.querySelector('#share-pwd-input').value;
      const expiresDays = parseInt(dialog.querySelector('#share-exp-select').value, 10);
      const allowCopy = dialog.querySelector('#share-copy-checkbox').checked;

      try {
        const res = await api(`/api/vaults/${vaultId}/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, title, password, expiresDays, allowCopy }),
        });
        const { share } = await res.json();
        const shareUrl = `${state.serverBase.replace(/\/$/, '')}/share/${share.id}`;

        closeModal();
        showShareSuccessModal(shareUrl, title);
      } catch (e) {
        toast('生成失败: ' + e.message);
      }
    };
  });
}

export function showShareSuccessModal(shareUrl, title) {
  const html = `
    <div class="modal-header">
      <h3>🎉 分享链接已生成</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-secondary);margin-bottom:10px">
        笔记 <b>${escapeHtml(title)}</b> 的公开访问地址如下：
      </p>
      <input type="text" id="success-share-input" value="${escapeHtml(shareUrl)}" readonly style="background:var(--bg)" />
    </div>
    <div class="modal-footer">
      <button id="copy-success-share-btn" class="btn-primary">📋 复制链接</button>
      <a class="btn secondary" href="${shareUrl}" target="_blank" style="text-decoration:none">立即打开</a>
      <button class="modal-close secondary">完成</button>
    </div>
  `;
  showModal(html, (dialog) => {
    dialog.querySelector('#copy-success-share-btn').onclick = () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shareUrl).then(() => toast('链接已复制'));
      }
    };
  });
}
