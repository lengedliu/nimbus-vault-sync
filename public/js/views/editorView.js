// --------------------------- Note Editor, Markdown Preview & Media Viewer ---------------------------
import { state, escapeHtml, translate, encodeURIComponentPath, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showModal } from '../core/dialogs.js';
import { showCreateShareModal } from './sharesSubtab.js';
import { showHistoryModal } from './diffView.js';

/**
 * Persists updated file content to the vault via PUT request.
 */
export async function saveFile(vaultId, path, content, baseHash) {
  const headers = { 'Content-Type': 'text/plain', 'X-Mtime': String(Date.now()) };
  if (baseHash) headers['X-Base-Hash'] = baseHash;
  return await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(path)}`, {
    method: 'PUT',
    headers,
    body: content,
  });
}

/**
 * Opens and renders media files (images, diagrams, audio, etc.).
 */
export function renderMediaViewer(vaultId, path, fileUrl, callbacks = {}) {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;

  const onBack = callbacks.onBack || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  mainPanel.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'editor-layout';

  layout.innerHTML = `
    <div class="editor-header">
      <div class="editor-title">
        <button class="secondary" id="media-back-btn">← 返回</button>
        <span>🖼️ ${escapeHtml(path)}</span>
      </div>
      <div>
        <a class="btn secondary" href="${fileUrl}" download="${path.split('/').pop()}" style="text-decoration:none">⬇️ 下载原图</a>
      </div>
    </div>
    <div class="media-preview-container">
      <img src="${fileUrl}" alt="${escapeHtml(path)}" />
    </div>
  `;

  layout.querySelector('#media-back-btn').onclick = () => onBack();
  mainPanel.appendChild(layout);
  translate(mainPanel);
}

/**
 * Displays a lightweight quick preview modal of a file's raw content.
 */
export function showFilePreviewModal(path, text) {
  const html = `
    <div class="modal-header">
      <h3>📄 预览文件 · ${escapeHtml(path)}</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <pre class="code-snippet" style="max-height:400px;overflow-y:auto;">${escapeHtml(text)}</pre>
    </div>
    <div class="modal-footer">
      <button class="modal-close secondary">关闭</button>
    </div>
  `;
  showModal(html);
}

/**
 * Opens and loads a file from the vault into the comprehensive editor workspace.
 */
export async function openFile(vaultId, path, callbacks = {}) {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;

  const onBack = callbacks.onBack || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(path);
  const isHtml = /\.(html|htm)$/i.test(path);
  const fileUrl = `${state.serverBase.replace(/\/$/, '')}/api/vaults/${vaultId}/files/${encodeURIComponentPath(path)}`;

  if (isImage) {
    renderMediaViewer(vaultId, path, fileUrl, { onBack });
    return;
  }

  try {
    const res = await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(path)}`);
    const text = await res.text();
    const baseHash = (state.manifest && state.manifest[path]) ? state.manifest[path].hash : undefined;

    mainPanel.innerHTML = '';
    const layout = document.createElement('div');
    layout.className = 'editor-layout';

    if (isHtml) {
      // ---------------- Dedicated HTML viewer and editor ----------------
      const header = document.createElement('div');
      header.className = 'editor-header';
      header.innerHTML = `
        <div class="editor-title">
          <button class="secondary" id="ed-back-btn">← 返回</button>
          <span>🌐 ${escapeHtml(path)}</span>
          <span class="badge primary" style="font-size:11px;">HTML 网页</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="editor-mode-btn-group">
            <button class="editor-mode-btn active" id="html-mode-page" title="完整渲染网页视图">🌐 网页视图</button>
            <button class="editor-mode-btn" id="html-mode-split" title="左侧源码、右侧实时渲染">👁️ 实时双栏</button>
            <button class="editor-mode-btn" id="html-mode-code" title="仅查看与编辑 HTML 源代码">📝 源码编辑</button>
          </div>
          <button class="secondary" id="ed-open-tab-btn" title="在新标签页全屏独立打开此网页">🚀 新窗口打开</button>
          <button class="secondary" id="ed-share-btn">🔗 分享</button>
          <button class="secondary" id="ed-history-btn">⏱️ 历史版本</button>
          <button class="btn-primary" id="ed-save-btn">💾 保存</button>
        </div>
      `;
      layout.appendChild(header);

      const body = document.createElement('div');
      body.className = 'editor-body';

      const editorPane = document.createElement('div');
      editorPane.className = 'editor-pane';
      editorPane.style.display = 'none'; // Hidden in default "page" mode

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.spellcheck = false;
      editorPane.appendChild(textarea);

      const previewPane = document.createElement('div');
      previewPane.className = 'html-preview-pane full-page';

      const iframe = document.createElement('iframe');
      iframe.className = 'html-preview-iframe';
      iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals');
      previewPane.appendChild(iframe);

      body.appendChild(editorPane);
      body.appendChild(previewPane);
      layout.appendChild(body);
      mainPanel.appendChild(layout);

      function renderHtmlInIframe(htmlContent) {
        iframe.srcdoc = htmlContent;
      }
      renderHtmlInIframe(text);

      let currentMode = 'page';
      function setHtmlViewMode(mode) {
        currentMode = mode;
        header.querySelector('#html-mode-page').classList.toggle('active', mode === 'page');
        header.querySelector('#html-mode-split').classList.toggle('active', mode === 'split');
        header.querySelector('#html-mode-code').classList.toggle('active', mode === 'code');

        if (mode === 'page') {
          editorPane.style.display = 'none';
          previewPane.style.display = 'flex';
          previewPane.classList.add('full-page');
        } else if (mode === 'split') {
          editorPane.style.display = 'flex';
          previewPane.style.display = 'flex';
          previewPane.classList.remove('full-page');
          renderHtmlInIframe(textarea.value);
        } else if (mode === 'code') {
          editorPane.style.display = 'flex';
          previewPane.style.display = 'none';
        }
      }

      header.querySelector('#html-mode-page').onclick = () => setHtmlViewMode('page');
      header.querySelector('#html-mode-split').onclick = () => setHtmlViewMode('split');
      header.querySelector('#html-mode-code').onclick = () => setHtmlViewMode('code');

      let liveUpdateTimer;
      textarea.oninput = () => {
        if (currentMode === 'split' || currentMode === 'page') {
          clearTimeout(liveUpdateTimer);
          liveUpdateTimer = setTimeout(() => {
            renderHtmlInIframe(textarea.value);
          }, 200);
        }
      };

      header.querySelector('#ed-open-tab-btn').onclick = () => {
        const blob = new Blob([textarea.value], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank');
      };

      header.querySelector('#ed-back-btn').onclick = () => onBack();
      header.querySelector('#ed-share-btn').onclick = () => showCreateShareModal(vaultId, path);
      header.querySelector('#ed-history-btn').onclick = () => showHistoryModal(vaultId, path, { onRollback: onBack });

      header.querySelector('#ed-save-btn').onclick = async () => {
        try {
          await saveFile(vaultId, path, textarea.value, baseHash);
          toast('HTML 笔记已保存并已广播同步');
          onBack();
        } catch (e) {
          toast('保存失败: ' + e.message, 'error');
        }
      };
      translate(mainPanel);
      return;
    }

    // ---------------- Markdown & General Text file editor ----------------
    const header = document.createElement('div');
    header.className = 'editor-header';
    header.innerHTML = `
      <div class="editor-title">
        <button class="secondary" id="ed-back-btn">← 返回</button>
        <span>📄 ${escapeHtml(path)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="secondary" id="ed-toggle-preview-btn">👁️ 切换双栏预览</button>
        <button class="secondary" id="ed-share-btn">🔗 分享</button>
        <button class="secondary" id="ed-history-btn">⏱️ 历史版本</button>
        <button class="btn-primary" id="ed-save-btn">💾 保存</button>
      </div>
    `;
    layout.appendChild(header);

    const body = document.createElement('div');
    body.className = 'editor-body';

    const editorPane = document.createElement('div');
    editorPane.className = 'editor-pane';
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.spellcheck = false;
    editorPane.appendChild(textarea);

    const previewPane = document.createElement('div');
    previewPane.className = 'preview-pane';
    const parsedHtml = (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function')
      ? marked.parse(text)
      : `<pre style="white-space:pre-wrap;">${escapeHtml(text)}</pre>`;
    previewPane.innerHTML = parsedHtml;

    body.appendChild(editorPane);
    body.appendChild(previewPane);
    layout.appendChild(body);
    mainPanel.appendChild(layout);
    translate(mainPanel);

    let showPreview = true;
    header.querySelector('#ed-toggle-preview-btn').onclick = () => {
      showPreview = !showPreview;
      previewPane.classList.toggle('hidden', !showPreview);
    };

    textarea.oninput = () => {
      if (showPreview) {
        if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
          previewPane.innerHTML = marked.parse(textarea.value);
        } else {
          previewPane.innerHTML = `<pre style="white-space:pre-wrap;">${escapeHtml(textarea.value)}</pre>`;
        }
      }
    };

    header.querySelector('#ed-back-btn').onclick = () => onBack();
    header.querySelector('#ed-share-btn').onclick = () => showCreateShareModal(vaultId, path);
    header.querySelector('#ed-history-btn').onclick = () => showHistoryModal(vaultId, path, { onRollback: onBack });

    header.querySelector('#ed-save-btn').onclick = async () => {
      try {
        await saveFile(vaultId, path, textarea.value, baseHash);
        toast('保存成功并已广播同步');
        onBack();
      } catch (e) {
        toast('保存失败: ' + e.message, 'error');
      }
    };
  } catch (e) {
    toast('无法打开笔记内容: ' + e.message, 'error');
    console.error('[Nimbus] Failed to open file:', path, e);
  }
}
