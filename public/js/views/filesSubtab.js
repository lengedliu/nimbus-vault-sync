// --------------------------- Vault Files Subtab, File Tree & Flat List ---------------------------
import { state, escapeHtml, formatBytes, translate, encodeURIComponentPath, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showModal, closeModal, showConfirm, showPrompt } from '../core/dialogs.js';
import { openFile, saveFile, showFilePreviewModal } from './editorView.js';
import { showCreateShareModal } from './sharesSubtab.js';
import { showHistoryModal } from './diffView.js';

/**
 * Builds an in-memory directory tree representation from a flat list of vault file paths.
 */
export function buildFileTree(paths, manifest) {
  const root = { name: '', path: '', type: 'folder', children: {}, fileCount: 0, totalSize: 0 };
  const allFolderPaths = [];

  for (const p of paths) {
    const parts = p.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const subPath = parts.slice(0, i + 1).join('/');

      if (isFile) {
        const meta = manifest[p] || { size: 0, mtime: Date.now(), ctime: Date.now() };
        current.children[part] = {
          name: part,
          path: subPath,
          type: 'file',
          meta,
        };
      } else {
        if (!current.children[part]) {
          allFolderPaths.push(subPath);
          current.children[part] = {
            name: part,
            path: subPath,
            type: 'folder',
            children: {},
            fileCount: 0,
            totalSize: 0,
          };
        }
        current = current.children[part];
      }
    }
  }

  function computeStats(node) {
    if (node.type === 'file') {
      return { count: 1, size: node.meta?.size || 0 };
    }
    let count = 0;
    let size = 0;
    for (const key of Object.keys(node.children)) {
      const res = computeStats(node.children[key]);
      count += res.count;
      size += res.size;
    }
    node.fileCount = count;
    node.totalSize = size;
    return { count, size };
  }
  computeStats(root);

  return { root, allFolderPaths };
}

/**
 * Extracts a deduplicated and sorted list of directories across the vault.
 */
export function getVaultFolderList(manifest) {
  const folders = new Set();
  folders.add(''); // Root directory
  for (const p of Object.keys(manifest || {})) {
    const parts = p.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    }
  }
  return Array.from(folders).sort();
}

/**
 * Displays modal to move or rename an individual file.
 */
export function showMoveFileModal(vaultId, currentPath, callbacks = {}) {
  const onMoved = callbacks.onMoved || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  const parts = currentPath.split('/');
  const fileName = parts.pop();
  const currentFolder = parts.join('/');
  const folders = getVaultFolderList(state.manifest);

  let folderOptions = '';
  for (const f of folders) {
    const label = f === '' ? '📁 [根目录] /' : `📁 /${f}`;
    folderOptions += `<option value="${escapeHtml(f)}" ${f === currentFolder ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }

  const html = `
    <div class="modal-header">
      <h3>📁 移动或重命名文件</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">当前路径</label>
        <div style="font-family:monospace;font-size:13px;padding:8px 12px;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;word-break:break-all;">${escapeHtml(currentPath)}</div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text);">目标目录 (可选择或输入新目录)</label>
        <div style="display:flex;gap:8px;">
          <select id="move-folder-select" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-size:13px;">
            ${folderOptions}
            <option value="__CUSTOM__">➕ 输入其他新目录路径...</option>
          </select>
        </div>
        <input type="text" id="move-custom-folder-input" placeholder="例如: projects/2026/notes" style="display:none;margin-top:8px;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-size:13px;" />
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text);">文件名</label>
        <input type="text" id="move-filename-input" value="${escapeHtml(fileName)}" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-size:13px;" />
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-close secondary">取消</button>
      <button class="btn-primary" id="confirm-move-btn">确认移动</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const folderSelect = dialog.querySelector('#move-folder-select');
    const customInput = dialog.querySelector('#move-custom-folder-input');
    const filenameInput = dialog.querySelector('#move-filename-input');
    const confirmBtn = dialog.querySelector('#confirm-move-btn');

    folderSelect.onchange = () => {
      if (folderSelect.value === '__CUSTOM__') {
        customInput.style.display = 'block';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
      }
    };

    confirmBtn.onclick = async () => {
      const newName = filenameInput.value.trim();
      if (!newName) {
        toast('请输入有效的文件名', 'error');
        return;
      }
      let targetDir = folderSelect.value === '__CUSTOM__' ? customInput.value.trim() : folderSelect.value;
      targetDir = targetDir.replace(/^\/+|\/+$/g, '');
      const newFullPath = targetDir ? `${targetDir}/${newName}` : newName;

      if (newFullPath === currentPath) {
        closeModal();
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = '移动中...';
      try {
        const res = await api(`/api/vaults/${vaultId}/batch/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [currentPath], targetFolder: targetDir }),
        });
        const data = await res.json();
        if (data.results && data.results[0] && !data.results[0].success) {
          throw new Error(data.results[0].error || '移动失败');
        }
        toast(`文件已成功移动至 /${newFullPath}`);
        closeModal();
        const manRes = await api(`/api/vaults/${vaultId}/manifest`);
        const manData = await manRes.json();
        state.manifest = manData.manifest;
        onMoved();
      } catch (err) {
        toast('移动失败: ' + err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认移动';
      }
    };
  });
}

/**
 * Displays modal to batch-move multiple selected files.
 */
export function showBatchMoveModal(vaultId, paths, callbacks = {}) {
  if (!paths || paths.length === 0) return;
  const onMoved = callbacks.onMoved || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  const folders = getVaultFolderList(state.manifest);
  let folderOptions = '';
  for (const f of folders) {
    const label = f === '' ? '📁 [根目录] /' : `📁 /${f}`;
    folderOptions += `<option value="${escapeHtml(f)}">${escapeHtml(label)}</option>`;
  }

  const html = `
    <div class="modal-header">
      <h3>📁 批量移动文件 (${paths.length} 项)</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">
      <div style="font-size:13px;color:var(--text-secondary);">
        即将把选中的 <b>${paths.length}</b> 个文件统一移动到指定目录：
      </div>
      <div style="max-height:120px;overflow-y:auto;padding:8px 12px;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:monospace;display:flex;flex-direction:column;gap:4px;">
        ${paths.map((p) => `<div>📄 ${escapeHtml(p)}</div>`).join('')}
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text);">目标目录 (可选择或输入新目录)</label>
        <select id="batch-move-folder-select" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-size:13px;">
          ${folderOptions}
          <option value="__CUSTOM__">➕ 输入其他新目录路径...</option>
        </select>
        <input type="text" id="batch-move-custom-input" placeholder="例如: archive/2026" style="display:none;margin-top:8px;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-size:13px;" />
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-close secondary">取消</button>
      <button class="btn-primary" id="confirm-batch-move-btn">确认批量移动</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const folderSelect = dialog.querySelector('#batch-move-folder-select');
    const customInput = dialog.querySelector('#batch-move-custom-input');
    const confirmBtn = dialog.querySelector('#confirm-batch-move-btn');

    folderSelect.onchange = () => {
      if (folderSelect.value === '__CUSTOM__') {
        customInput.style.display = 'block';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
      }
    };

    confirmBtn.onclick = async () => {
      let targetDir = folderSelect.value === '__CUSTOM__' ? customInput.value.trim() : folderSelect.value;
      targetDir = targetDir.replace(/^\/+|\/+$/g, '');

      confirmBtn.disabled = true;
      confirmBtn.textContent = '移动中...';
      try {
        const res = await api(`/api/vaults/${vaultId}/batch/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths, targetFolder: targetDir }),
        });
        const data = await res.json();
        toast(`已成功批量移动 ${data.count || paths.length} 个文件至 /${targetDir || ''}`);
        state.selectedFiles.clear();
        closeModal();
        const manRes = await api(`/api/vaults/${vaultId}/manifest`);
        const manData = await manRes.json();
        state.manifest = manData.manifest;
        onMoved();
      } catch (err) {
        toast('批量移动失败: ' + err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认批量移动';
      }
    };
  });
}

/**
 * Prompts user for a note path and creates a starter markdown note.
 */
export async function createNewNotePrompt(vaultId, callbacks = {}) {
  const onCreated = callbacks.onCreated || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  const p = await showPrompt({
    title: '📝 新建 Markdown 笔记',
    message: '请输入新文件相对路径（例如：Notes/Daily.md 或 Work/Project.md）：',
    placeholder: 'Notes/NewNote.md',
    icon: '📝',
    confirmText: '确认创建',
  });
  if (!p || !p.trim()) return;
  const cleanPath = p.trim().replace(/^\/+/, '');
  try {
    await saveFile(vaultId, cleanPath, '# ' + cleanPath.split('/').pop().replace(/\.md$/, '') + '\n\n', undefined);
    toast('已创建文件');
    onCreated();
  } catch (err) {
    toast('创建文件失败: ' + err.message, 'error');
  }
}

/**
 * Triggers native system file picker to upload files into vault root.
 */
export function triggerFileUpload(vaultId, callbacks = {}) {
  const onDone = callbacks.onDone || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return;
    try {
      for (const file of input.files) {
        const buffer = await file.arrayBuffer();
        await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(file.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer,
        });
      }
      toast(`已上传 ${input.files.length} 个文件`);
      onDone();
    } catch (err) {
      toast('上传文件失败: ' + err.message, 'error');
    }
  };
  input.click();
}

/**
 * Attaches drag-and-drop file upload listeners to a target DOM container.
 */
export function setupDragDrop(zone, vaultId, callbacks = {}) {
  if (!zone) return;
  const onDone = callbacks.onDone || (() => {
    if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
  });

  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    try {
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(file.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer,
        });
      }
      toast(`已上传 ${files.length} 个文件`);
      onDone();
    } catch (err) {
      toast('拖拽上传失败: ' + err.message, 'error');
    }
  };
}

/**
 * Displays full-text search results in an interactive table.
 */
export function renderSearchResultsTable(vaultId, container, results) {
  if (!container) return;
  if (results.length === 0) {
    container.innerHTML = '<div class="empty-state">未找到包含此关键词的笔记</div>';
    translate(container);
    return;
  }

  const table = document.createElement('table');
  table.className = 'file-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>匹配文件与内容片段</th>
        <th style="width:120px">大小</th>
        <th style="width:180px">修改时间</th>
        <th style="width:140px;text-align:right">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const r of results) {
    const tr = document.createElement('tr');
    const snippetHtml = r.snippet
      ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;background:var(--bg);padding:4px 8px;border-radius:4px;">${escapeHtml(r.snippet)}</div>`
      : '';

    tr.innerHTML = `
      <td>
        <div class="file-name"><span>📄</span> <b>${escapeHtml(r.path)}</b></div>
        ${snippetHtml}
      </td>
      <td class="meta">${formatBytes(r.size)}</td>
      <td class="meta">${new Date(r.mtime).toLocaleString()}</td>
      <td class="actions">
        <button class="btn-primary" id="open-res-${encodeURIComponent(r.path)}">打开</button>
      </td>
    `;
    const openBtn = tr.querySelector(`#open-res-${encodeURIComponent(r.path)}`);
    if (openBtn) {
      openBtn.onclick = () => openFile(vaultId, r.path);
    }
    tbody.appendChild(tr);
  }
  container.appendChild(table);
  translate(container);
}

/**
 * Virtualized tree-view file renderer with smooth scrolling and dynamic auto-fill height.
 */
export function renderTreeFileList(vaultId, listWrapper, paths, manifest) {
  const { root, allFolderPaths } = buildFileTree(paths, manifest);

  if (!state.treeFoldersInitialized) {
    state.treeFoldersInitialized = true;
    state.expandedFolders.clear();
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-view-wrapper';

  const bar = document.createElement('div');
  bar.className = 'tree-toolbar-bar';
  bar.innerHTML = `
    <div>
      <span>📁 <strong>原始目录结构</strong> · 共 ${allFolderPaths.length} 个文件夹 · ${paths.length} 个文件</span>
    </div>
    <div class="tree-toolbar-controls">
      <label class="tree-sort-label">
        <span style="white-space:nowrap;flex-shrink:0;">排序:</span>
        <select class="tree-sort-select" id="tree-sort-select" title="选择目录内笔记文件的排序规则">
          <option value="ctime-desc" ${state.treeSortOrder === 'ctime-desc' ? 'selected' : ''}>⏳ 创建时间 (最新优先)</option>
          <option value="ctime-asc" ${state.treeSortOrder === 'ctime-asc' ? 'selected' : ''}>⌛ 创建时间 (最旧优先)</option>
          <option value="mtime-desc" ${state.treeSortOrder === 'mtime-desc' ? 'selected' : ''}>📝 修改时间 (最新优先)</option>
          <option value="name-asc" ${state.treeSortOrder === 'name-asc' ? 'selected' : ''}>🔤 文件名称 (A-Z)</option>
        </select>
      </label>
      <button class="tree-ctrl-btn" id="tree-expand-all-btn">➕ 全部展开</button>
      <button class="tree-ctrl-btn" id="tree-collapse-all-btn">➖ 全部折叠</button>
      <button class="tree-ctrl-btn" id="tree-refresh-btn" title="重新从服务端刷新文件列表">🔄 刷新</button>
    </div>
  `;
  wrapper.appendChild(bar);

  const sortSelect = bar.querySelector('#tree-sort-select');
  if (sortSelect) {
    sortSelect.onchange = () => {
      state.treeSortOrder = sortSelect.value;
      localStorage.setItem('nimbus_tree_sort_order', state.treeSortOrder);
      refreshVirtualTree(false);
    };
  }

  const refreshBtn = bar.querySelector('#tree-refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = '⏳ 刷新中...';
      try {
        const res = await api(`/api/vaults/${vaultId}/manifest`);
        const body = await res.json();
        state.manifest = body.manifest;
        toast('文件列表已刷新');
        renderFileList(vaultId, listWrapper);
      } catch (err) {
        toast('刷新失败: ' + (err.message || '网络异常'), 'error');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = '🔄 刷新';
      }
    };
  }

  const header = document.createElement('div');
  header.className = 'tree-header-row';
  header.innerHTML = `
    <div>名称 / 目录层级</div>
    <div>大小</div>
    <div>创建时间</div>
    <div>修改时间</div>
    <div style="text-align:right">操作</div>
  `;
  wrapper.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tree-body';

  const phantom = document.createElement('div');
  phantom.className = 'tree-virtual-phantom';
  body.appendChild(phantom);

  const content = document.createElement('div');
  content.className = 'tree-virtual-content';
  body.appendChild(content);

  const ROW_HEIGHT = 38;
  const OVERSCAN = 6;
  let visibleItems = [];
  let rafId = null;

  function flattenVisibleTree(node, depth = 0, sortOrder = 'ctime-desc', expandedSet = state.expandedFolders) {
    const result = [];
    const keys = Object.keys(node.children).sort((a, b) => {
      const itemA = node.children[a];
      const itemB = node.children[b];
      if (itemA.type !== itemB.type) {
        return itemA.type === 'folder' ? -1 : 1;
      }
      if (itemA.type === 'folder') {
        return itemA.name.localeCompare(itemB.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      }
      const ctimeA = itemA.meta?.ctime || itemA.meta?.mtime || 0;
      const ctimeB = itemB.meta?.ctime || itemB.meta?.mtime || 0;
      const mtimeA = itemA.meta?.mtime || 0;
      const mtimeB = itemB.meta?.mtime || 0;

      if (sortOrder === 'ctime-desc') {
        if (ctimeB !== ctimeA) return ctimeB - ctimeA;
        return itemA.name.localeCompare(itemB.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      } else if (sortOrder === 'ctime-asc') {
        if (ctimeA !== ctimeB) return ctimeA - ctimeB;
        return itemA.name.localeCompare(itemB.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      } else if (sortOrder === 'mtime-desc') {
        if (mtimeB !== mtimeA) return mtimeB - mtimeA;
        return itemA.name.localeCompare(itemB.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      } else {
        return itemA.name.localeCompare(itemB.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      }
    });

    for (const key of keys) {
      const item = node.children[key];
      if (item.type === 'folder') {
        const isExpanded = expandedSet.has(item.path);
        result.push({
          type: 'folder',
          name: item.name,
          path: item.path,
          depth,
          isExpanded,
          fileCount: item.fileCount,
          totalSize: item.totalSize,
          children: item.children,
        });
        if (isExpanded) {
          const childItems = flattenVisibleTree(item, depth + 1, sortOrder, expandedSet);
          for (let i = 0; i < childItems.length; i++) {
            result.push(childItems[i]);
          }
        }
      } else {
        result.push({
          type: 'file',
          name: item.name,
          path: item.path,
          depth,
          meta: item.meta || {},
        });
      }
    }
    return result;
  }

  function createRowElement(item) {
    if (item.type === 'folder') {
      const row = document.createElement('div');
      row.className = 'tree-node-row folder-row';

      let indentHtml = '';
      for (let d = 0; d < item.depth; d++) {
        indentHtml += '<span class="tree-indent-spacer"></span>';
      }

      row.innerHTML = `
        <div class="tree-name-col">
          ${indentHtml}
          <span class="tree-toggle-arrow ${item.isExpanded ? 'open' : ''}">▶</span>
          <span class="tree-icon">${item.isExpanded ? '📂' : '📁'}</span>
          <span class="tree-name-text">${escapeHtml(item.name)}</span>
          <span class="tree-badge">${item.fileCount} 项</span>
        </div>
        <div class="tree-meta-col">${formatBytes(item.totalSize)}</div>
        <div class="tree-meta-col" style="color:var(--text-muted);font-size:12px;">-</div>
        <div class="tree-meta-col" style="color:var(--text-muted);font-size:12px;">-</div>
        <div class="tree-actions-col"></div>
      `;

      row.onclick = () => {
        if (state.expandedFolders.has(item.path)) {
          state.expandedFolders.delete(item.path);
        } else {
          state.expandedFolders.add(item.path);
        }
        refreshVirtualTree(false);
      };

      return row;
    }

    const p = item.path;
    const meta = item.meta || {};
    const isMd = p.toLowerCase().endsWith('.md');
    const isHtml = /\.(html|htm)$/i.test(p);
    const isImg = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(p);
    const isPdf = /\.pdf$/i.test(p);
    const icon = isMd ? '📄' : isHtml ? '🌐' : isImg ? '🖼️' : isPdf ? '📕' : p.startsWith('.obsidian/') ? '⚙️' : '📎';

    const ctimeVal = meta.ctime || meta.mtime || Date.now();
    const mtimeVal = meta.mtime || Date.now();
    const ctimeStr = new Date(ctimeVal).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const mtimeStr = new Date(mtimeVal).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const row = document.createElement('div');
    row.className = 'tree-node-row file-row';

    let indentHtml = '';
    for (let d = 0; d < item.depth; d++) {
      indentHtml += '<span class="tree-indent-spacer"></span>';
    }

    row.innerHTML = `
      <div class="tree-name-col">
        ${indentHtml}
        <span class="tree-indent-spacer" style="width:18px;"></span>
        <span class="tree-icon">${icon}</span>
        <span class="tree-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      </div>
      <div class="tree-meta-col">${formatBytes(meta.size)}</div>
      <div class="tree-meta-col" title="创建时间: ${ctimeStr}">${ctimeStr}</div>
      <div class="tree-meta-col" title="修改时间: ${mtimeStr}">${mtimeStr}</div>
      <div class="tree-actions-col"></div>
    `;

    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      openFile(vaultId, p);
    };

    const actionsCol = row.querySelector('.tree-actions-col');

    if (isMd || isHtml) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'secondary';
      shareBtn.textContent = '🔗 分享';
      shareBtn.onclick = (e) => {
        e.stopPropagation();
        showCreateShareModal(vaultId, p);
      };
      actionsCol.appendChild(shareBtn);
    }

    const moveBtn = document.createElement('button');
    moveBtn.className = 'secondary';
    moveBtn.textContent = '📁 移动';
    moveBtn.title = '移动或重命名文件';
    moveBtn.onclick = (e) => {
      e.stopPropagation();
      showMoveFileModal(vaultId, p);
    };
    actionsCol.appendChild(moveBtn);

    const histBtn = document.createElement('button');
    histBtn.className = 'secondary';
    histBtn.textContent = '⏱️ 历史';
    histBtn.onclick = (e) => {
      e.stopPropagation();
      showHistoryModal(vaultId, p);
    };
    actionsCol.appendChild(histBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '🗑️';
    delBtn.title = '移至回收站';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await showConfirm({
        title: '移入回收站确认',
        message: `确定要将笔记「${p}」移入回收站吗？可在回收站中随时恢复。`,
        confirmText: '移至回收站',
        type: 'danger',
        icon: '🗑️',
      });
      if (!ok) return;
      try {
        await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(p)}`, { method: 'DELETE' });
        toast('已移至回收站');
        if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
      } catch (err) {
        toast('删除失败: ' + err.message, 'error');
      }
    };
    actionsCol.appendChild(delBtn);

    return row;
  }

  function renderVirtualWindow() {
    const total = visibleItems.length;
    phantom.style.height = `${total * ROW_HEIGHT}px`;

    if (total === 0) {
      content.innerHTML = '<div class="empty-state" style="padding:24px;">目录为空</div>';
      content.style.transform = 'translateY(0px)';
      return;
    }

    const scrollTop = body.scrollTop || 0;
    const clientHeight = body.clientHeight || 500;

    let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    if (startIndex < 0) startIndex = 0;

    let endIndex = Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN;
    if (endIndex > total) endIndex = total;

    const offsetY = startIndex * ROW_HEIGHT;
    content.style.transform = `translateY(${offsetY}px)`;

    const frag = document.createDocumentFragment();
    for (let i = startIndex; i < endIndex; i++) {
      frag.appendChild(createRowElement(visibleItems[i]));
    }
    content.innerHTML = '';
    content.appendChild(frag);
  }

  function updateTreeHeight() {
    if (!body || !body.isConnected) return;
    const mainPanel = document.getElementById('main-panel');
    if (!mainPanel) return;

    const mainRect = mainPanel.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const topOffset = (bodyRect.top - mainRect.top) + mainPanel.scrollTop;
    const available = Math.max(120, Math.floor(mainPanel.clientHeight - topOffset - 32));

    if (body.style.height !== `${available}px`) {
      body.style.height = `${available}px`;
      renderVirtualWindow();
    }
  }

  function refreshVirtualTree(resetScroll = false) {
    const sortOrder = state.treeSortOrder || 'ctime-desc';
    visibleItems = flattenVisibleTree(root, 0, sortOrder, state.expandedFolders);
    updateTreeHeight();
    if (resetScroll) {
      body.scrollTop = 0;
    }
    renderVirtualWindow();
  }

  body.addEventListener('scroll', () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(renderVirtualWindow);
  }, { passive: true });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!body || !body.isConnected) {
        ro.disconnect();
        return;
      }
      renderVirtualWindow();
    });
    ro.observe(body);
  }

  bar.querySelector('#tree-expand-all-btn').onclick = () => {
    allFolderPaths.forEach((fp) => state.expandedFolders.add(fp));
    refreshVirtualTree(false);
  };

  bar.querySelector('#tree-collapse-all-btn').onclick = () => {
    state.expandedFolders.clear();
    refreshVirtualTree(true);
  };

  refreshVirtualTree(true);

  wrapper.appendChild(body);
  listWrapper.appendChild(wrapper);

  updateTreeHeight();
  requestAnimationFrame(updateTreeHeight);
  setTimeout(updateTreeHeight, 60);
  setTimeout(updateTreeHeight, 180);

  const onResize = () => {
    if (!body || !body.isConnected) {
      window.removeEventListener('resize', onResize);
      return;
    }
    updateTreeHeight();
  };
  window.addEventListener('resize', onResize);
}

/**
 * Renders the flat, paginated table list of vault files with multi-select batch actions.
 */
export function renderFlatFileList(vaultId, listWrapper, paths, manifest) {
  const sortOrder = state.treeSortOrder || 'ctime-desc';
  const sortedPaths = [...paths].sort((a, b) => {
    const metaA = manifest[a] || {};
    const metaB = manifest[b] || {};
    const ctimeA = metaA.ctime || metaA.mtime || 0;
    const ctimeB = metaB.ctime || metaB.mtime || 0;
    const mtimeA = metaA.mtime || 0;
    const mtimeB = metaB.mtime || 0;

    if (sortOrder === 'ctime-desc') {
      if (ctimeB !== ctimeA) return ctimeB - ctimeA;
      return a.localeCompare(b, 'zh-CN', { numeric: true });
    } else if (sortOrder === 'ctime-asc') {
      if (ctimeA !== ctimeB) return ctimeA - ctimeB;
      return a.localeCompare(b, 'zh-CN', { numeric: true });
    } else if (sortOrder === 'mtime-desc') {
      if (mtimeB !== mtimeA) return mtimeB - mtimeA;
      return a.localeCompare(b, 'zh-CN', { numeric: true });
    } else {
      return a.localeCompare(b, 'zh-CN', { numeric: true });
    }
  });

  const total = sortedPaths.length;
  const pageSize = state.flatListPageSize || 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.flatListPage > totalPages) state.flatListPage = totalPages;
  if (state.flatListPage < 1) state.flatListPage = 1;
  const currentPage = state.flatListPage;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(total, startIndex + pageSize);
  const pageItems = sortedPaths.slice(startIndex, endIndex);

  const wrapper = document.createElement('div');
  wrapper.className = 'flat-list-wrapper';

  const toolbar = document.createElement('div');
  toolbar.className = 'flat-list-toolbar';
  toolbar.innerHTML = `
    <div>
      <span>📋 <strong>平铺文件列表</strong> · 共 ${total} 个文件 · 当前显示第 ${total === 0 ? 0 : startIndex + 1} - ${endIndex} 项</span>
    </div>
    <div class="flat-list-toolbar-controls">
      <label class="tree-sort-label">
        <span style="white-space:nowrap;flex-shrink:0;">排序:</span>
        <select class="tree-sort-select" id="flat-sort-select" title="选择文件排序规则">
          <option value="ctime-desc" ${sortOrder === 'ctime-desc' ? 'selected' : ''}>⏳ 创建时间 (最新优先)</option>
          <option value="ctime-asc" ${sortOrder === 'ctime-asc' ? 'selected' : ''}>⌛ 创建时间 (最旧优先)</option>
          <option value="mtime-desc" ${sortOrder === 'mtime-desc' ? 'selected' : ''}>📝 修改时间 (最新优先)</option>
          <option value="name-asc" ${sortOrder === 'name-asc' ? 'selected' : ''}>🔤 文件名称 (A-Z)</option>
        </select>
      </label>
      <label class="tree-sort-label">
        <span style="white-space:nowrap;flex-shrink:0;">每页:</span>
        <select class="pagination-page-size-select" id="flat-page-size-select" title="选择每页显示的文件数量">
          <option value="10" ${pageSize === 10 ? 'selected' : ''}>10 条</option>
          <option value="25" ${pageSize === 25 ? 'selected' : ''}>25 条</option>
          <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条</option>
          <option value="100" ${pageSize === 100 ? 'selected' : ''}>100 条</option>
          <option value="200" ${pageSize === 200 ? 'selected' : ''}>200 条</option>
        </select>
      </label>
    </div>
  `;
  wrapper.appendChild(toolbar);

  if (state.selectedFiles && state.selectedFiles.size > 0) {
    const batchBar = document.createElement('div');
    batchBar.className = 'batch-actions-bar';
    batchBar.innerHTML = `
      <div class="batch-bar-left">
        <span class="batch-badge">已选中 <b>${state.selectedFiles.size}</b> 项</span>
        <button class="batch-btn batch-btn-secondary" id="batch-select-all-paths-btn">全选所有 (${total})</button>
        <button class="batch-btn batch-btn-ghost" id="batch-clear-selection-btn">✕ 取消全选</button>
      </div>
      <div class="batch-bar-right">
        <button class="batch-btn" id="batch-zip-btn">📦 打包下载 (ZIP)</button>
        <button class="batch-btn" id="batch-move-btn">📁 批量移动</button>
        <button class="batch-btn batch-btn-danger" id="batch-del-btn">🗑️ 批量删除</button>
      </div>
    `;
    wrapper.appendChild(batchBar);

    batchBar.querySelector('#batch-select-all-paths-btn').onclick = () => {
      sortedPaths.forEach((p) => state.selectedFiles.add(p));
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };

    batchBar.querySelector('#batch-clear-selection-btn').onclick = () => {
      state.selectedFiles.clear();
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };

    batchBar.querySelector('#batch-zip-btn').onclick = () => {
      const fileList = Array.from(state.selectedFiles);
      if (fileList.length === 0) return;
      const q = encodeURIComponent(JSON.stringify(fileList));
      window.open(`${state.serverBase.replace(/\/$/, '')}/api/vaults/${vaultId}/batch/download?paths=${q}&token=${encodeURIComponent(state.token)}`, '_blank');
    };

    batchBar.querySelector('#batch-move-btn').onclick = () => {
      const fileList = Array.from(state.selectedFiles);
      if (fileList.length === 0) return;
      showBatchMoveModal(vaultId, fileList);
    };

    batchBar.querySelector('#batch-del-btn').onclick = async () => {
      const fileList = Array.from(state.selectedFiles);
      if (fileList.length === 0) return;
      const ok = await showConfirm({
        title: '批量移入回收站确认',
        message: `确定要将选中的 ${fileList.length} 个文件移入回收站吗？可在回收站中随时恢复。`,
        confirmText: '全部移至回收站',
        type: 'danger',
        icon: '🗑️',
      });
      if (!ok) return;
      try {
        const res = await api(`/api/vaults/${vaultId}/batch/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: fileList }),
        });
        const data = await res.json();
        toast(`已成功将 ${data.count || fileList.length} 个文件移至回收站`);
        state.selectedFiles.clear();
        const manRes = await api(`/api/vaults/${vaultId}/manifest`);
        const manData = await manRes.json();
        state.manifest = manData.manifest;
        if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
      } catch (err) {
        toast('批量删除失败: ' + err.message, 'error');
      }
    };
  }

  const sortSelect = toolbar.querySelector('#flat-sort-select');
  if (sortSelect) {
    sortSelect.onchange = () => {
      state.treeSortOrder = sortSelect.value;
      localStorage.setItem('nimbus_tree_sort_order', state.treeSortOrder);
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };
  }

  const pageSizeSelect = toolbar.querySelector('#flat-page-size-select');
  if (pageSizeSelect) {
    pageSizeSelect.onchange = () => {
      state.flatListPageSize = parseInt(pageSizeSelect.value, 10) || 50;
      localStorage.setItem('nimbus_flat_page_size', state.flatListPageSize);
      state.flatListPage = 1;
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };
  }

  const isAllPageSelected = pageItems.length > 0 && pageItems.every((p) => state.selectedFiles.has(p));

  const table = document.createElement('table');
  table.className = 'file-table';
  table.style.border = 'none';
  table.style.borderRadius = '0';
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:36px;text-align:center;"><input type="checkbox" id="flat-select-all-chk" ${isAllPageSelected ? 'checked' : ''} title="全选/取消全选本页" /></th>
        <th>文件路径</th>
        <th style="width:100px">大小</th>
        <th style="width:160px">创建时间</th>
        <th style="width:160px">修改时间</th>
        <th style="width:230px;text-align:right">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const selectAllChk = table.querySelector('#flat-select-all-chk');
  if (selectAllChk) {
    selectAllChk.onclick = (e) => {
      const checked = e.target.checked;
      pageItems.forEach((p) => {
        if (checked) state.selectedFiles.add(p);
        else state.selectedFiles.delete(p);
      });
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };
  }

  const tbody = table.querySelector('tbody');

  for (const p of pageItems) {
    const meta = manifest[p] || { size: 0, mtime: Date.now(), ctime: Date.now() };
    const isMd = p.toLowerCase().endsWith('.md');
    const isHtml = /\.(html|htm)$/i.test(p);
    const isImg = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(p);
    const isPdf = /\.pdf$/i.test(p);
    const icon = isMd ? '📄' : isHtml ? '🌐' : isImg ? '🖼️' : isPdf ? '📕' : p.startsWith('.obsidian/') ? '⚙️' : '📎';

    const ctimeVal = meta.ctime || meta.mtime || Date.now();
    const mtimeVal = meta.mtime || Date.now();
    const ctimeStr = new Date(ctimeVal).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const mtimeStr = new Date(mtimeVal).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    const isSelected = state.selectedFiles.has(p);
    const tr = document.createElement('tr');
    if (isSelected) tr.classList.add('selected-row');

    tr.innerHTML = `
      <td style="text-align:center;" class="chk-cell">
        <input type="checkbox" class="flat-row-chk" data-path="${escapeHtml(p)}" ${isSelected ? 'checked' : ''} />
      </td>
      <td><div class="file-name"><span>${icon}</span> <span>${escapeHtml(p)}</span></div></td>
      <td class="meta">${formatBytes(meta.size)}</td>
      <td class="meta">${ctimeStr}</td>
      <td class="meta">${mtimeStr}</td>
      <td class="actions"></td>
    `;

    const rowChk = tr.querySelector('.flat-row-chk');
    rowChk.onclick = (e) => {
      e.stopPropagation();
      if (rowChk.checked) {
        state.selectedFiles.add(p);
      } else {
        state.selectedFiles.delete(p);
      }
      renderFlatFileList(vaultId, listWrapper, paths, manifest);
    };

    tr.onclick = (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      openFile(vaultId, p);
    };

    const actionsCell = tr.querySelector('.actions');

    if (isMd || isHtml) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'secondary';
      shareBtn.textContent = '🔗 分享';
      shareBtn.onclick = (e) => {
        e.stopPropagation();
        showCreateShareModal(vaultId, p);
      };
      actionsCell.appendChild(shareBtn);
    }

    const moveBtn = document.createElement('button');
    moveBtn.className = 'secondary';
    moveBtn.textContent = '📁 移动';
    moveBtn.title = '移动或重命名文件';
    moveBtn.onclick = (e) => {
      e.stopPropagation();
      showMoveFileModal(vaultId, p);
    };
    actionsCell.appendChild(moveBtn);

    const histBtn = document.createElement('button');
    histBtn.className = 'secondary';
    histBtn.textContent = '⏱️ 历史';
    histBtn.onclick = (e) => {
      e.stopPropagation();
      showHistoryModal(vaultId, p);
    };
    actionsCell.appendChild(histBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '🗑️';
    delBtn.title = '移至回收站';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await showConfirm({
        title: '移入回收站确认',
        message: `确定要将笔记「${p}」移入回收站吗？可在回收站中随时恢复。`,
        confirmText: '移至回收站',
        type: 'danger',
        icon: '🗑️',
      });
      if (!ok) return;
      try {
        await api(`/api/vaults/${vaultId}/files/${encodeURIComponentPath(p)}`, { method: 'DELETE' });
        toast('已移至回收站');
        state.selectedFiles.delete(p);
        if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'files');
      } catch (err) {
        toast('删除失败: ' + err.message, 'error');
      }
    };
    actionsCell.appendChild(delBtn);

    tbody.appendChild(tr);
  }

  wrapper.appendChild(table);

  const pagination = document.createElement('div');
  pagination.className = 'flat-list-pagination';

  function getPageNumbers(cur, tot) {
    if (tot <= 7) {
      return Array.from({ length: tot }, (_, i) => i + 1);
    }
    if (cur <= 4) {
      return [1, 2, 3, 4, 5, '...', tot];
    }
    if (cur >= tot - 3) {
      return [1, '...', tot - 4, tot - 3, tot - 2, tot - 1, tot];
    }
    return [1, '...', cur - 1, cur, cur + 1, '...', tot];
  }

  const pageNumbers = getPageNumbers(currentPage, totalPages);
  let pageChipsHtml = '';
  for (const item of pageNumbers) {
    if (item === '...') {
      pageChipsHtml += `<span class="pagination-ellipsis">…</span>`;
    } else {
      pageChipsHtml += `<button class="pagination-btn ${item === currentPage ? 'active' : ''}" data-page="${item}">${item}</button>`;
    }
  }

  pagination.innerHTML = `
    <div>
      <span>第 <b>${currentPage}</b> / <b>${totalPages}</b> 页 (共 ${total} 个文件)</span>
    </div>
    <div class="pagination-controls">
      <button class="pagination-btn" id="flat-first-page-btn" ${currentPage <= 1 ? 'disabled' : ''} title="首页">⏮️ 首页</button>
      <button class="pagination-btn" id="flat-prev-page-btn" ${currentPage <= 1 ? 'disabled' : ''} title="上一页">◀ 上一页</button>
      <div class="pagination-pages" style="display:inline-flex;gap:4px;align-items:center;">
        ${pageChipsHtml}
      </div>
      <button class="pagination-btn" id="flat-next-page-btn" ${currentPage >= totalPages ? 'disabled' : ''} title="下一页">下一页 ▶</button>
      <button class="pagination-btn" id="flat-last-page-btn" ${currentPage >= totalPages ? 'disabled' : ''} title="末页">末页 ⏭️</button>
      <div class="pagination-jump">
        <span>跳至</span>
        <input type="number" min="1" max="${totalPages}" value="${currentPage}" id="flat-jump-input" />
        <span>页</span>
        <button class="pagination-btn" id="flat-jump-btn">前往</button>
      </div>
    </div>
  `;
  wrapper.appendChild(pagination);

  function goToPage(target) {
    const p = Math.max(1, Math.min(totalPages, target));
    if (p === state.flatListPage) return;
    state.flatListPage = p;
    renderFlatFileList(vaultId, listWrapper, paths, manifest);
    const mainPanel = document.getElementById('main-panel');
    if (mainPanel) mainPanel.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const firstBtn = pagination.querySelector('#flat-first-page-btn');
  if (firstBtn) firstBtn.onclick = () => goToPage(1);

  const prevBtn = pagination.querySelector('#flat-prev-page-btn');
  if (prevBtn) prevBtn.onclick = () => goToPage(currentPage - 1);

  const nextBtn = pagination.querySelector('#flat-next-page-btn');
  if (nextBtn) nextBtn.onclick = () => goToPage(currentPage + 1);

  const lastBtn = pagination.querySelector('#flat-last-page-btn');
  if (lastBtn) lastBtn.onclick = () => goToPage(totalPages);

  pagination.querySelectorAll('.pagination-pages button[data-page]').forEach((btn) => {
    btn.onclick = () => {
      const p = parseInt(btn.dataset.page, 10);
      if (!isNaN(p)) goToPage(p);
    };
  });

  const jumpInput = pagination.querySelector('#flat-jump-input');
  const jumpBtn = pagination.querySelector('#flat-jump-btn');
  if (jumpBtn && jumpInput) {
    jumpBtn.onclick = () => {
      const val = parseInt(jumpInput.value, 10);
      if (!isNaN(val)) goToPage(val);
    };
    jumpInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const val = parseInt(jumpInput.value, 10);
        if (!isNaN(val)) goToPage(val);
      }
    };
  }

  listWrapper.innerHTML = '';
  listWrapper.appendChild(wrapper);
}

/**
 * Filter and route file rendering to tree view or flat list.
 */
export async function renderFileList(vaultId, container) {
  const listWrapper = container.id === 'files-list-wrapper' ? container : container.querySelector('#files-list-wrapper');
  if (!listWrapper) return;
  listWrapper.innerHTML = '';

  let paths = Object.keys(state.manifest || {}).sort();

  if (state.fileFilter === 'md') {
    paths = paths.filter((p) => p.toLowerCase().endsWith('.md'));
  } else if (state.fileFilter === 'html') {
    paths = paths.filter((p) => /\.(html|htm)$/i.test(p));
  } else if (state.fileFilter === 'media') {
    paths = paths.filter((p) => /\.(png|jpg|jpeg|gif|webp|svg|pdf|mp3|mp4|mov|wav|zip)$/i.test(p));
  } else if (state.fileFilter === 'code') {
    paths = paths.filter((p) => /\.(json|js|ts|css|py|sh|yml|yaml|csv|sql|xml|txt)$/i.test(p) && !p.startsWith('.obsidian/'));
  } else if (state.fileFilter === 'config') {
    paths = paths.filter((p) => p.startsWith('.obsidian/'));
  }

  if (state.searchQuery && state.searchQuery.trim()) {
    const q = state.searchQuery.trim().toLowerCase();
    try {
      const res = await api(`/api/vaults/${vaultId}/search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      const searchResults = body.results || [];
      renderSearchResultsTable(vaultId, listWrapper, searchResults);
      return;
    } catch {
      paths = paths.filter((p) => p.toLowerCase().includes(q));
    }
  }

  if (paths.length === 0) {
    listWrapper.innerHTML = '<div class="empty-state">没有符合条件的文件</div>';
    translate(listWrapper);
    return;
  }

  if (state.fileViewMode === 'tree') {
    renderTreeFileList(vaultId, listWrapper, paths, state.manifest);
  } else {
    renderFlatFileList(vaultId, listWrapper, paths, state.manifest);
  }
  translate(listWrapper);
}

/**
 * Main entrance for the vault's "Files" subtab.
 */
export function renderFilesSubtab(vaultId, container) {
  const allPaths = Object.keys(state.manifest || {});
  const mdCount = allPaths.filter((p) => p.toLowerCase().endsWith('.md')).length;
  const htmlCount = allPaths.filter((p) => /\.(html|htm)$/i.test(p)).length;
  const mediaCount = allPaths.filter((p) => /\.(png|jpg|jpeg|gif|webp|svg|pdf|mp3|mp4|mov|wav|zip)$/i.test(p)).length;
  const codeCount = allPaths.filter((p) => /\.(json|js|ts|css|py|sh|yml|yaml|csv|sql|xml|txt)$/i.test(p) && !p.startsWith('.obsidian/')).length;
  const configCount = allPaths.filter((p) => p.startsWith('.obsidian/')).length;

  const toolbar = document.createElement('div');
  toolbar.className = 'vault-toolbar';
  toolbar.innerHTML = `
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" id="file-search-input" placeholder="搜索文件名或全文内容..." value="${escapeHtml(state.searchQuery)}" />
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <div class="filter-pills">
        <span class="filter-pill ${state.fileFilter === 'all' ? 'active' : ''}" data-filter="all">全部 (${allPaths.length})</span>
        <span class="filter-pill ${state.fileFilter === 'md' ? 'active' : ''}" data-filter="md">Markdown (${mdCount})</span>
        <span class="filter-pill ${state.fileFilter === 'html' ? 'active' : ''}" data-filter="html">HTML (${htmlCount})</span>
        <span class="filter-pill ${state.fileFilter === 'media' ? 'active' : ''}" data-filter="media">媒体/附件 (${mediaCount})</span>
        <span class="filter-pill ${state.fileFilter === 'code' ? 'active' : ''}" data-filter="code">代码/数据 (${codeCount})</span>
        <span class="filter-pill ${state.fileFilter === 'config' ? 'active' : ''}" data-filter="config">配置 (${configCount})</span>
      </div>
      <div class="view-mode-group">
        <button class="view-mode-btn ${state.fileViewMode === 'tree' ? 'active' : ''}" data-mode="tree" title="按库的原始树状目录结构层级显示">
          <span>🌲</span> 树状目录
        </button>
        <button class="view-mode-btn ${state.fileViewMode === 'flat' ? 'active' : ''}" data-mode="flat" title="平铺文件路径列表显示">
          <span>📋</span> 平铺列表
        </button>
        <button class="view-mode-btn" id="files-toolbar-refresh-btn" title="从服务端重新加载文件清单">
          <span>🔄</span> 刷新
        </button>
      </div>
    </div>
  `;
  container.appendChild(toolbar);

  const toolbarRefreshBtn = toolbar.querySelector('#files-toolbar-refresh-btn');
  if (toolbarRefreshBtn) {
    toolbarRefreshBtn.onclick = async () => {
      toolbarRefreshBtn.disabled = true;
      toolbarRefreshBtn.innerHTML = '<span>⏳</span> 刷新中...';
      try {
        const res = await api(`/api/vaults/${vaultId}/manifest`);
        const body = await res.json();
        state.manifest = body.manifest;
        toast('文件列表已刷新');
        renderFileList(vaultId, container);
      } catch (err) {
        toast('刷新失败: ' + (err.message || '网络异常'), 'error');
      } finally {
        toolbarRefreshBtn.disabled = false;
        toolbarRefreshBtn.innerHTML = '<span>🔄</span> 刷新';
      }
    };
  }

  toolbar.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.onclick = () => {
      state.fileFilter = pill.dataset.filter;
      state.flatListPage = 1;
      if (window.Nimbus?.renderVaultContainer) {
        window.Nimbus.renderVaultContainer(vaultId);
      }
    };
  });

  toolbar.querySelectorAll('.view-mode-btn').forEach((btn) => {
    btn.onclick = () => {
      state.fileViewMode = btn.dataset.mode;
      state.flatListPage = 1;
      localStorage.setItem('nimbus_file_view_mode', state.fileViewMode);
      toolbar.querySelectorAll('.view-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.fileViewMode));
      renderFileList(vaultId, container);
    };
  });

  let debounceTimer;
  const searchInput = toolbar.querySelector('#file-search-input');
  searchInput.oninput = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = searchInput.value;
      state.flatListPage = 1;
      renderFileList(vaultId, container);
    }, 250);
  };

  const dropZone = document.createElement('div');
  dropZone.className = 'drop-zone';
  dropZone.innerHTML = `<span>📥 拖拽文件到此处，或点击右上角「上传文件」快速存入 Vault</span>`;
  setupDragDrop(dropZone, vaultId);
  container.appendChild(dropZone);

  const listContainer = document.createElement('div');
  listContainer.id = 'files-list-wrapper';
  container.appendChild(listContainer);

  renderFileList(vaultId, listContainer);
  translate(container);
}
