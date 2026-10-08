// --------------------------- Global Search Modal (Ctrl+K) ---------------------------
import { escapeHtml, formatBytes, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { showModal, closeModal } from '../core/dialogs.js';
import { openFile } from './editorView.js';

/**
 * Opens full-text and path search modal across all accessible vaults.
 */
export function openGlobalSearchModal(callbacks = {}) {
  const onOpenFile = callbacks.onOpenFile || (async (vaultId, path) => {
    if (window.Nimbus?.openVault) {
      await window.Nimbus.openVault(vaultId, 'files');
    }
    await openFile(vaultId, path);
  });

  const modalHtml = `
    <div class="global-search-modal" style="display:flex;flex-direction:column;max-height:85vh;">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);">
        <span style="font-size:20px;">🔍</span>
        <input type="text" id="gs-input" placeholder="输入关键词检索笔记标题、路径或正文内容… (支持实时多库检索)" autofocus style="flex:1;border:none;background:transparent;font-size:15px;outline:none;margin:0;color:var(--text);" />
        <span class="modal-close" style="font-size:11px;color:var(--muted);background:var(--panel-2);padding:3px 8px;border-radius:4px;border:1px solid var(--border);cursor:pointer;">ESC 退出</span>
      </div>
      <div id="gs-results" style="flex:1;overflow-y:auto;max-height:520px;padding:12px 16px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:13px;color:var(--muted);text-align:center;padding:36px 0;">
          <div style="font-size:32px;margin-bottom:8px;">🔎</div>
          <div>输入关键词开始在所有 Vault 中检索标题及笔记内容…</div>
        </div>
      </div>
    </div>
  `;

  showModal(modalHtml, (container) => {
    const input = container.querySelector('#gs-input');
    const resultsContainer = container.querySelector('#gs-results');
    if (input) input.focus();

    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = input.value.trim();
        if (!query) {
          resultsContainer.innerHTML = `
            <div style="font-size:13px;color:var(--muted);text-align:center;padding:36px 0;">
              <div style="font-size:32px;margin-bottom:8px;">🔎</div>
              <div>输入关键词开始在所有 Vault 中检索标题及笔记内容…</div>
            </div>
          `;
          return;
        }

        resultsContainer.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:24px 0;">正在检索全库笔记与正文…</div>';

        try {
          const res = await api(`/api/vaults/search?q=${encodeURIComponent(query)}`);
          const data = await res.json();
          const matches = data.results || [];

          if (matches.length === 0) {
            resultsContainer.innerHTML = `<div style="font-size:13px;color:var(--muted);text-align:center;padding:36px 0;">未找到包含 "${escapeHtml(query)}" 的笔记或正文内容</div>`;
            return;
          }

          resultsContainer.innerHTML = '';
          for (const m of matches) {
            const item = document.createElement('div');
            item.className = 'global-search-item';
            item.style.cssText = 'padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:all 0.15s;';

            const highlightedPath = escapeHtml(m.path).replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark style="background:rgba(255,200,0,0.35);color:inherit;padding:0 2px;border-radius:2px;">$1</mark>');

            let snippetHtml = '';
            if (m.snippet) {
              const highlightedSnippet = escapeHtml(m.snippet).replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark style="background:rgba(255,200,0,0.35);color:inherit;padding:0 2px;border-radius:2px;">$1</mark>');
              snippetHtml = `<div style="font-size:12px;color:var(--text-secondary);background:var(--panel-2);padding:6px 8px;border-radius:4px;font-family:var(--font-mono);line-height:1.4;word-break:break-all;">${highlightedSnippet}</div>`;
            }

            item.innerHTML = `
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <div style="font-weight:600;font-size:14px;color:var(--text);display:flex;align-items:center;gap:6px;overflow:hidden;">
                  <span>📄</span>
                  <span style="text-overflow:ellipsis;white-space:nowrap;overflow:hidden;">${highlightedPath}</span>
                  ${m.matchesCount > 0 ? `<span class="badge primary" style="font-size:10.5px;padding:1px 5px;">${m.matchesCount} 处正文匹配</span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                  <span class="badge" style="font-size:11px;">${escapeHtml(m.vaultName)}</span>
                  <button class="secondary" style="font-size:11px;padding:3px 8px;">打开 →</button>
                </div>
              </div>
              ${snippetHtml}
              <div style="font-size:11px;color:var(--muted);display:flex;gap:12px;">
                <span>大小: ${formatBytes(m.size)}</span>
                <span>修改时间: ${new Date(m.mtime).toLocaleString()}</span>
              </div>
            `;

            item.onclick = async () => {
              closeModal();
              await onOpenFile(m.vaultId, m.path);
            };

            item.onmouseenter = () => { item.style.borderColor = 'var(--primary)'; item.style.background = 'var(--panel)'; };
            item.onmouseleave = () => { item.style.borderColor = 'var(--border)'; item.style.background = 'var(--bg)'; };

            resultsContainer.appendChild(item);
          }
        } catch (e) {
          resultsContainer.innerHTML = `<div style="color:#e74c3c;font-size:12.5px;text-align:center;padding:16px 0;">检索失败: ${escapeHtml(e.message)}</div>`;
        }
      }, 180);
    });
  }, 'global-search-modal-container');
}

/**
 * Sets up global search button in topbar and Ctrl/Cmd+K keyboard listener.
 */
export function setupGlobalSearch(callbacks = {}) {
  const searchBtn = $('#topbar-search-btn');
  if (searchBtn) {
    searchBtn.onclick = () => openGlobalSearchModal(callbacks);
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearchModal(callbacks);
    }
  });
}
