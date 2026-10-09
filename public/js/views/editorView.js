// --------------------------- Note Editor, Markdown Preview & Media Viewer ---------------------------
import { state, escapeHtml, translate, encodeURIComponentPath, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showModal } from '../core/dialogs.js';
import { showCreateShareModal } from './sharesSubtab.js';
import { showHistoryModal } from './diffView.js';

const CALLOUT_CONFIGS = {
  note: { icon: 'ℹ️', label: 'Note', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.08)', border: '#3b82f6' },
  info: { icon: 'ℹ️', label: 'Info', color: '#0284c7', bg: 'rgba(2, 132, 199, 0.08)', border: '#0284c7' },
  tip: { icon: '💡', label: 'Tip', color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981' },
  hint: { icon: '💡', label: 'Hint', color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981' },
  important: { icon: '🔥', label: 'Important', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.08)', border: '#8b5cf6' },
  warning: { icon: '⚠️', label: 'Warning', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', border: '#f59e0b' },
  caution: { icon: '⚠️', label: 'Caution', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', border: '#f59e0b' },
  danger: { icon: '🛑', label: 'Danger', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', border: '#ef4444' },
  error: { icon: '🛑', label: 'Error', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', border: '#ef4444' },
  success: { icon: '✅', label: 'Success', color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981' },
  check: { icon: '✅', label: 'Check', color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981' },
  done: { icon: '✅', label: 'Done', color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981' },
  question: { icon: '❓', label: 'Question', color: '#eab308', bg: 'rgba(234, 179, 8, 0.08)', border: '#eab308' },
  help: { icon: '❓', label: 'Help', color: '#eab308', bg: 'rgba(234, 179, 8, 0.08)', border: '#eab308' },
  faq: { icon: '❓', label: 'FAQ', color: '#eab308', bg: 'rgba(234, 179, 8, 0.08)', border: '#eab308' },
  failure: { icon: '❌', label: 'Failure', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.08)', border: '#f43f5e' },
  fail: { icon: '❌', label: 'Fail', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.08)', border: '#f43f5e' },
  bug: { icon: '🐛', label: 'Bug', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.08)', border: '#f43f5e' },
  example: { icon: '🧪', label: 'Example', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.08)', border: '#a855f7' },
  quote: { icon: '💬', label: 'Quote', color: '#64748b', bg: 'rgba(100, 116, 139, 0.08)', border: '#64748b' },
  abstract: { icon: '📋', label: 'Abstract', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.08)', border: '#06b6d4' },
  summary: { icon: '📋', label: 'Summary', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.08)', border: '#06b6d4' },
  tldr: { icon: '📋', label: 'TL;DR', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.08)', border: '#06b6d4' },
  todo: { icon: '☑️', label: 'Todo', color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.08)', border: '#0ea5e9' },
};

/**
 * Parses and renders Markdown with Obsidian-specific features:
 * Callouts, LaTeX math ($ and $$), Wikilinks [[target|alias]], tags #tag, and task checklists.
 */
export function renderObsidianMarkdown(markdown, vaultId) {
  if (!markdown) return '';

  // 1. Process Obsidian Callout blocks:
  // > [!NOTE] Optional Title
  // > line 1
  // > line 2
  const lines = markdown.split(/\r?\n/);
  const processedLines = [];
  let inCallout = false;
  let calloutType = 'note';
  let calloutTitle = '';
  let calloutFoldable = false;
  let calloutDefaultCollapsed = false;
  let calloutBodyLines = [];

  function flushCallout() {
    if (!inCallout) return;
    const cfg = CALLOUT_CONFIGS[calloutType.toLowerCase()] || CALLOUT_CONFIGS.note;
    const titleText = calloutTitle.trim() || cfg.label;
    const bodyContent = calloutBodyLines.join('\n');
    const parsedBody = (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function')
      ? marked.parse(bodyContent)
      : `<p>${escapeHtml(bodyContent)}</p>`;

    const calloutHtml = `
      <div class="obsidian-callout" style="border-left: 4px solid ${cfg.border}; background: ${cfg.bg}; border-radius: 6px; margin: 14px 0; overflow: hidden; padding: 0;">
        <div class="obsidian-callout-title" style="display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13.5px; color: ${cfg.color}; padding: 10px 14px; background: rgba(0,0,0,0.03); cursor: ${calloutFoldable ? 'pointer' : 'default'};">
          <span style="font-size: 15px;">${cfg.icon}</span>
          <span style="flex: 1;">${escapeHtml(titleText)}</span>
          ${calloutFoldable ? `<span class="obsidian-callout-fold-icon" style="font-size: 11px; opacity: 0.7;">${calloutDefaultCollapsed ? '▶' : '▼'}</span>` : ''}
        </div>
        <div class="obsidian-callout-content" style="padding: 10px 14px 12px 14px; font-size: 13.5px; line-height: 1.65; display: ${calloutDefaultCollapsed ? 'none' : 'block'};">
          ${parsedBody}
        </div>
      </div>
    `;
    processedLines.push(calloutHtml);
    inCallout = false;
    calloutBodyLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const calloutHeaderMatch = line.match(/^>\s*\[!([a-zA-Z\-_]+)\]([+-]?)\s*(.*)$/);

    if (calloutHeaderMatch) {
      if (inCallout) flushCallout();
      inCallout = true;
      calloutType = calloutHeaderMatch[1];
      const foldModifier = calloutHeaderMatch[2];
      calloutFoldable = foldModifier === '+' || foldModifier === '-';
      calloutDefaultCollapsed = foldModifier === '-';
      calloutTitle = calloutHeaderMatch[3] || '';
      continue;
    }

    if (inCallout) {
      if (line.startsWith('>')) {
        calloutBodyLines.push(line.replace(/^>\s?/, ''));
        continue;
      } else if (line.trim() === '') {
        // Lookahead if next line is callout body
        if (i + 1 < lines.length && lines[i + 1].startsWith('>')) {
          calloutBodyLines.push('');
          continue;
        } else {
          flushCallout();
          processedLines.push(line);
          continue;
        }
      } else {
        flushCallout();
        processedLines.push(line);
        continue;
      }
    }

    processedLines.push(line);
  }
  if (inCallout) flushCallout();

  let intermediate = processedLines.join('\n');

  // 2. Base marked parse
  let html = (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function')
    ? marked.parse(intermediate)
    : `<pre style="white-space:pre-wrap;">${escapeHtml(intermediate)}</pre>`;

  // 3. LaTeX Math Formula rendering
  // Block Math: $$formula$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
    return `<div class="obsidian-math-block" style="text-align:center;padding:12px;margin:12px 0;background:var(--panel-2);border-radius:6px;border:1px solid var(--border);font-family:KaTeX_Math,'Times New Roman',serif;font-size:15px;color:var(--text);overflow-x:auto;">$$\\displaystyle ${escapeHtml(formula.trim())}$$</div>`;
  });

  // Inline Math: $formula$
  html = html.replace(/(^|[^\\])\$([^\$\n]+?)\$/g, (match, prefix, formula) => {
    return `${prefix}<span class="obsidian-math-inline" style="padding:2px 5px;margin:0 2px;background:var(--panel-2);border-radius:4px;border:1px solid var(--border);font-family:KaTeX_Math,'Times New Roman',serif;font-size:13.5px;color:var(--primary);">${escapeHtml(formula.trim())}</span>`;
  });

  // 4. Obsidian Wikilinks: [[target|alias]] and [[target]]
  html = html.replace(/\[\[([^\|\]]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
    const displayText = alias || target;
    const cleanTarget = target.trim();
    return `<a href="javascript:void(0)" class="obsidian-wikilink" data-vault="${vaultId || ''}" data-target="${escapeHtml(cleanTarget)}" style="color:var(--primary);font-weight:600;text-decoration:none;border-bottom:1px dashed var(--primary);padding:0 2px;">🔗 ${escapeHtml(displayText)}</a>`;
  });

  // 5. Obsidian Inline Tags: #tag and #parent/child
  html = html.replace(/(^|\s)#([a-zA-Z\u4e00-\u9fa5_][\w\u4e00-\u9fa5_\-/]*)/g, (match, prefix, tag) => {
    if (/^h[1-6]$/i.test(tag) || /^[0-9a-fA-F]{3,8}$/i.test(tag)) return match;
    return `${prefix}<span class="obsidian-tag-pill" data-tag="${escapeHtml(tag.toLowerCase())}" style="display:inline-flex;align-items:center;background:rgba(88,166,255,0.12);color:#58a6ff;font-size:12px;font-weight:600;padding:2px 8px;border-radius:12px;margin:0 2px;cursor:pointer;">#${escapeHtml(tag)}</span>`;
  });

  return html;
}

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

// Navigation history stack for editor workspace
let editorHistoryStack = [];
let currentEditorState = null;

export function resetEditorHistory() {
  editorHistoryStack = [];
  currentEditorState = null;
}

/**
 * Opens and loads a file from the vault into the comprehensive editor workspace.
 */
export async function openFile(vaultId, path, callbacks = {}) {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;

  // Determine base origin callback if not explicitly provided
  let originBack = callbacks.onBack;
  if (!originBack) {
    const prevTab = state.activeTab;
    const prevVaultId = state.activeVaultId;
    const prevSubtab = state.activeSubtab || 'files';

    if (prevTab === 'dashboard') {
      originBack = () => {
        resetEditorHistory();
        if (window.Nimbus?.showTab) {
          window.Nimbus.showTab('dashboard');
        }
      };
    } else if (prevTab) {
      originBack = () => {
        resetEditorHistory();
        if (window.Nimbus?.showTab) {
          window.Nimbus.showTab(prevTab);
        }
      };
    } else if (prevVaultId) {
      originBack = () => {
        resetEditorHistory();
        if (window.Nimbus?.openVault) {
          window.Nimbus.openVault(prevVaultId, prevSubtab);
        }
      };
    } else {
      originBack = () => {
        resetEditorHistory();
        if (window.Nimbus?.openVault) {
          window.Nimbus.openVault(vaultId, 'files');
        } else if (window.Nimbus?.showTab) {
          window.Nimbus.showTab('dashboard');
        }
      };
    }
  }

  // Handle nested navigation history (e.g. Wikilink navigation inside editor)
  if (currentEditorState && currentEditorState.path !== path && !callbacks.fromHistory) {
    editorHistoryStack.push({
      vaultId: currentEditorState.vaultId,
      path: currentEditorState.path,
      onBack: currentEditorState.onBack,
    });
  } else if (!callbacks.fromHistory && !currentEditorState) {
    editorHistoryStack = [];
  }

  const handleBack = () => {
    if (editorHistoryStack.length > 0) {
      const prev = editorHistoryStack.pop();
      currentEditorState = null;
      openFile(prev.vaultId, prev.path, { onBack: prev.onBack, fromHistory: true });
    } else {
      resetEditorHistory();
      originBack();
    }
  };

  const onBack = handleBack;
  currentEditorState = {
    vaultId,
    path,
    onBack: originBack,
  };

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

    function updatePreview() {
      previewPane.innerHTML = renderObsidianMarkdown(textarea.value, vaultId);

      // Attach foldable callout interactions
      previewPane.querySelectorAll('.obsidian-callout-title').forEach((titleEl) => {
        titleEl.onclick = () => {
          const contentEl = titleEl.nextElementSibling;
          const foldIcon = titleEl.querySelector('.obsidian-callout-fold-icon');
          if (contentEl) {
            const isHidden = contentEl.style.display === 'none';
            contentEl.style.display = isHidden ? 'block' : 'none';
            if (foldIcon) foldIcon.textContent = isHidden ? '▼' : '▶';
          }
        };
      });

      // Attach Wikilink navigation
      previewPane.querySelectorAll('.obsidian-wikilink').forEach((linkEl) => {
        linkEl.onclick = (e) => {
          e.preventDefault();
          let target = linkEl.getAttribute('data-target') || '';
          if (!target) return;
          if (!target.toLowerCase().endsWith('.md')) target = target + '.md';
          openFile(vaultId, target, { onBack });
        };
      });
    }

    updatePreview();

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

    let debounceTimer = null;
    textarea.oninput = () => {
      if (showPreview) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          updatePreview();
        }, 150);
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
