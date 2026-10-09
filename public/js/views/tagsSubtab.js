// --------------------------- Vault Tags Explorer & Tag Cloud Subtab ---------------------------
import { state, escapeHtml, formatBytes, translate, encodeURIComponentPath, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';
import { openFile } from './editorView.js';

// Global client-side memory cache for tags data
if (!state.vaultTagsCache) {
  state.vaultTagsCache = {};
}

export async function renderTagsSubtab(vaultId, container, options = {}) {
  if (!container) return;

  const forceRefresh = Boolean(options && options.force);
  const cached = state.vaultTagsCache[vaultId];

  // If already in client cache and not force refresh, use immediately for instant display
  let tagsData = cached && !forceRefresh ? cached.tags : null;

  if (!tagsData) {
    container.innerHTML = `
      <div style="padding: 32px 0; text-align: center; color: var(--text-muted); font-size: 13.5px; display: flex; flex-direction: column; align-items: center; gap: 10px;">
        <span style="font-size: 26px; animation: spin 1s linear infinite;">⏳</span>
        <div>正在极速加载全库标签索引...</div>
      </div>
    `;

    try {
      const url = forceRefresh ? `/api/vaults/${vaultId}/tags?refresh=1` : `/api/vaults/${vaultId}/tags`;
      const res = await api(url);
      const data = await res.json();
      tagsData = data.tags || [];
      state.vaultTagsCache[vaultId] = {
        tags: tagsData,
        timestamp: Date.now(),
      };
    } catch (err) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 36px;">
          <div style="font-size: 30px; margin-bottom: 8px;">⚠️</div>
          <div style="font-weight: 600; margin-bottom: 4px;">获取标签索引失败</div>
          <div style="font-size: 12.5px; color: var(--text-muted);">${escapeHtml(err.message)}</div>
          <button type="button" class="btn-primary" id="retry-tags-btn" style="margin-top: 14px; padding: 6px 14px; font-size: 12.5px;">重试加载</button>
        </div>
      `;
      const retryBtn = container.querySelector('#retry-tags-btn');
      if (retryBtn) retryBtn.onclick = () => renderTagsSubtab(vaultId, container, { force: true });
      return;
    }
  }

  if (tagsData.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 46px 20px; text-align: center; background: var(--panel); border: 1px dashed var(--border); border-radius: var(--radius);">
        <div style="font-size: 34px; margin-bottom: 12px;">🏷️</div>
        <div style="font-weight: 700; font-size: 15px; margin-bottom: 6px; color: var(--text);">库中暂无标签</div>
        <div style="font-size: 13px; color: var(--muted); max-width: 440px; margin: 0 auto 16px; line-height: 1.6;">
          在任何 Markdown 笔记中输入 <code>#标签名</code> 或 YAML 前置属性 <code>tags: [工作, 想法]</code>，系统将自动毫秒级索引并聚合至此。
        </div>
        <button type="button" class="token-act-btn" id="refresh-empty-tags-btn" style="padding: 6px 16px; font-size: 12.5px;">🔄 刷新标签索引</button>
      </div>
    `;
    const refreshBtn = container.querySelector('#refresh-empty-tags-btn');
    if (refreshBtn) refreshBtn.onclick = () => renderTagsSubtab(vaultId, container, { force: true });
    translate(container);
    return;
  }

  let selectedTag = tagsData[0]?.tag || null;
  let tagSearchQuery = '';
  let noteSearchQuery = '';
  let viewMode = 'cloud'; // 'cloud' | 'tree'
  let expandAllPills = false;
  let notesPageSize = 40;
  let notesDisplayedCount = 40;
  let searchDebounceTimer = null;

  const totalTagsCount = tagsData.length;
  const totalTaggedRefs = tagsData.reduce((acc, cur) => acc + cur.count, 0);

  // Render outer shell once (preserves inputs and avoids flickering)
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <!-- Top Stats & Search Bar -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;background:var(--panel-2);border:1px solid var(--border);padding:12px 18px;border-radius:var(--radius);">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">🏷️</span>
          <div>
            <div style="font-weight:700;font-size:14.5px;color:var(--text);display:flex;align-items:center;gap:8px;">
              <span>标签聚合中心</span>
              <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--panel);border:1px solid var(--border);color:var(--primary);">极速增量索引</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted);">
              已发现 <b>${totalTagsCount}</b> 个独特标签 · 共 <b>${totalTaggedRefs}</b> 次笔记引用
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="position:relative;min-width:240px;">
            <input type="text" id="tag-search-input" value="" placeholder="🔍 快速过滤标签..." style="width:100%;box-sizing:border-box;padding:6px 28px 6px 12px;font-size:12.5px;border-radius:20px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            <span id="clear-tag-search-btn" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:12px;color:var(--muted);display:none;">✕</span>
          </div>
          <button type="button" class="token-act-btn" id="refresh-tags-index-btn" title="强制重新扫描全库标签" style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;font-size:12px;border-radius:18px;">
            <span id="refresh-tags-spinner">🔄</span>
            <span>刷新索引</span>
          </button>
        </div>
      </div>

      <!-- Main Dual-Column Grid (Left: 350-450px, Right: 1fr) -->
      <div class="tags-layout-grid" style="display:grid;grid-template-columns: minmax(350px, 450px) 1fr;gap:16px;align-items:start;">
        <!-- Left Panel: Tags Cloud & Hierarchical Tree -->
        <div id="tags-left-pane" style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;max-height:72vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
        </div>

        <!-- Right Panel: Notes containing selected tag -->
        <div id="tag-notes-pane" style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;min-height:380px;">
        </div>
      </div>
    </div>
  `;

  // Bind top bar controls
  const searchInput = container.querySelector('#tag-search-input');
  const clearSearchBtn = container.querySelector('#clear-tag-search-btn');
  const refreshBtn = container.querySelector('#refresh-tags-index-btn');
  const refreshSpinner = container.querySelector('#refresh-tags-spinner');
  const leftPane = container.querySelector('#tags-left-pane');
  const rightPane = container.querySelector('#tag-notes-pane');

  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      if (refreshSpinner) refreshSpinner.style.display = 'inline-block';
      refreshBtn.disabled = true;
      toast('正在强制重新索引标签...', 'info');
      await renderTagsSubtab(vaultId, container, { force: true });
    };
  }

  if (searchInput) {
    searchInput.oninput = () => {
      tagSearchQuery = searchInput.value.trim();
      if (clearSearchBtn) {
        clearSearchBtn.style.display = tagSearchQuery ? 'inline-block' : 'none';
      }
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        updateLeftPane();
      }, 120);
    };
  }

  if (clearSearchBtn) {
    clearSearchBtn.onclick = () => {
      if (searchInput) {
        searchInput.value = '';
        tagSearchQuery = '';
        clearSearchBtn.style.display = 'none';
        updateLeftPane();
        searchInput.focus();
      }
    };
  }

  function getFilteredTags() {
    if (!tagSearchQuery) return tagsData;
    const q = tagSearchQuery.toLowerCase();
    return tagsData.filter((t) => t.tag.toLowerCase().includes(q));
  }

  function updateLeftPane() {
    const filtered = getFilteredTags();
    const maxCount = Math.max(...tagsData.map((t) => t.count), 1);

    // If currently selected tag is filtered out, select first filtered tag
    if (filtered.length > 0 && !filtered.some((t) => t.tag === selectedTag)) {
      selectedTag = filtered[0].tag;
      notesDisplayedCount = notesPageSize;
      updateRightPane();
    } else if (filtered.length === 0) {
      selectedTag = null;
      updateRightPane();
    }

    const pillsLimit = expandAllPills ? filtered.length : Math.min(filtered.length, 50);
    const pillsToRender = filtered.slice(0, pillsLimit);
    const hasMorePills = filtered.length > 50;

    leftPane.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:8px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="token-act-btn ${viewMode === 'cloud' ? 'primary' : ''}" id="mode-cloud-btn" style="padding:3px 10px;font-size:11.5px;border-radius:12px;">☁️ 标签云</button>
          <button type="button" class="token-act-btn ${viewMode === 'tree' ? 'primary' : ''}" id="mode-tree-btn" style="padding:3px 10px;font-size:11.5px;border-radius:12px;">🌲 层级树</button>
        </div>
        <span style="font-size:11px;color:var(--text-muted);">${filtered.length} 个匹配 · 频次排序</span>
      </div>

      ${viewMode === 'cloud' ? `
        <!-- Cloud Section -->
        <div style="display:flex;flex-wrap:wrap;gap:7px;padding-bottom:10px;border-bottom:1px solid var(--border);" id="tag-pills-cloud">
          ${pillsToRender.map((t) => {
            const isSelected = t.tag === selectedTag;
            const weightRatio = t.count / maxCount;
            const scaleWeight = weightRatio > 0.6 ? 'font-weight:700;' : weightRatio > 0.3 ? 'font-weight:600;' : 'font-weight:500;';
            const bgStyle = isSelected
              ? 'background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:0 2px 6px rgba(0,0,0,0.18);'
              : 'background:var(--panel-2);color:var(--text);border-color:var(--border);';

            return `
              <button type="button" class="tag-cloud-pill" data-tag="${escapeHtml(t.tag)}" style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:14px;border:1px solid var(--border);cursor:pointer;font-size:11.5px;transition:all 0.15s;${scaleWeight}${bgStyle}">
                <span>#${escapeHtml(t.tag)}</span>
                <span style="font-size:10px;padding:1px 5px;border-radius:8px;background:${isSelected ? 'rgba(255,255,255,0.25)' : 'var(--bg)'};color:${isSelected ? '#fff' : 'var(--text-secondary)'};font-weight:700;">${t.count}</span>
              </button>
            `;
          }).join('')}
        </div>
        ${hasMorePills ? `
          <div style="text-align:center;padding:4px 0;">
            <button type="button" class="token-act-btn" id="toggle-expand-pills-btn" style="font-size:11px;padding:3px 12px;border-radius:12px;">
              ${expandAllPills ? '▲ 收起标签云' : `▼ 显示全部 (${filtered.length} 个标签)`}
            </button>
          </div>
        ` : ''}

        <!-- List Section -->
        <div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;">
          ${filtered.map((t) => {
            const isSelected = t.tag === selectedTag;
            return `
              <div class="tag-row-item" data-tag="${escapeHtml(t.tag)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:6px;cursor:pointer;background:${isSelected ? 'rgba(59,130,246,0.12)' : 'transparent'};color:${isSelected ? 'var(--primary)' : 'var(--text)'};transition:background 0.15s;">
                <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:${isSelected ? '700' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  <span style="opacity:0.75;">🏷️</span>
                  <span style="overflow:hidden;text-overflow:ellipsis;">#${escapeHtml(t.tag)}</span>
                </div>
                <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;background:var(--panel-2);color:var(--text-muted);flex-shrink:0;">${t.count} 篇</span>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <!-- Hierarchical Tree Mode -->
        <div style="display:flex;flex-direction:column;gap:3px;" id="tag-tree-container">
          ${renderTagTreeHtml(filtered, selectedTag)}
        </div>
      `}
    `;

    // Bind mode switcher
    const cloudBtn = leftPane.querySelector('#mode-cloud-btn');
    const treeBtn = leftPane.querySelector('#mode-tree-btn');
    if (cloudBtn) {
      cloudBtn.onclick = () => {
        viewMode = 'cloud';
        updateLeftPane();
      };
    }
    if (treeBtn) {
      treeBtn.onclick = () => {
        viewMode = 'tree';
        updateLeftPane();
      };
    }

    const togglePillsBtn = leftPane.querySelector('#toggle-expand-pills-btn');
    if (togglePillsBtn) {
      togglePillsBtn.onclick = () => {
        expandAllPills = !expandAllPills;
        updateLeftPane();
      };
    }

    // Bind tag click events
    leftPane.querySelectorAll('.tag-cloud-pill, .tag-row-item, .tag-tree-item').forEach((el) => {
      el.onclick = () => {
        const tag = el.getAttribute('data-tag');
        if (tag && tag !== selectedTag) {
          selectedTag = tag;
          notesDisplayedCount = notesPageSize;
          noteSearchQuery = '';
          updateLeftPane();
          updateRightPane();
        }
      };
    });
  }

  function renderTagTreeHtml(tagsList, curSelected) {
    if (tagsList.length === 0) {
      return `<div style="text-align:center;padding:20px;font-size:12px;color:var(--muted);">无匹配标签</div>`;
    }

    return tagsList.map((t) => {
      const isSelected = t.tag === curSelected;
      const depth = t.tag.split('/').length - 1;
      const indentPx = Math.min(depth * 14, 42);
      const parts = t.tag.split('/');
      const leafName = parts[parts.length - 1];
      const isNested = parts.length > 1;

      return `
        <div class="tag-tree-item" data-tag="${escapeHtml(t.tag)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;margin-left:${indentPx}px;border-radius:6px;cursor:pointer;background:${isSelected ? 'rgba(59,130,246,0.12)' : 'transparent'};color:${isSelected ? 'var(--primary)' : 'var(--text)'};transition:background 0.15s;">
          <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:${isSelected ? '700' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            <span style="opacity:0.75;font-size:11px;">${isNested ? '↳' : '🏷️'}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;" title="#${escapeHtml(t.tag)}">
              ${isNested ? `<span style="opacity:0.5;font-size:11px;">${escapeHtml(parts.slice(0, -1).join('/'))}/</span>` : '#'}<b>${escapeHtml(leafName)}</b>
            </span>
          </div>
          <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;background:var(--panel-2);color:var(--text-muted);flex-shrink:0;">${t.count} 篇</span>
        </div>
      `;
    }).join('');
  }

  function updateRightPane() {
    if (!selectedTag) {
      rightPane.innerHTML = `
        <div class="empty-state" style="padding:48px 20px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">👈</div>
          <div style="font-weight:600;font-size:14px;color:var(--text);">请在左侧选择一个标签</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">选择后将毫秒级列出该标签关联的所有 Markdown 笔记</div>
        </div>
      `;
      return;
    }

    const currentObj = tagsData.find((t) => t.tag === selectedTag);
    if (!currentObj || currentObj.files.length === 0) {
      rightPane.innerHTML = `
        <div class="empty-state" style="padding:48px 20px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">🏷️</div>
          <div style="font-weight:600;font-size:14px;color:var(--text);">未找到包含 #${escapeHtml(selectedTag)} 的笔记</div>
        </div>
      `;
      return;
    }

    let allFiles = currentObj.files;
    if (noteSearchQuery.trim()) {
      const q = noteSearchQuery.toLowerCase();
      allFiles = allFiles.filter((p) => p.toLowerCase().includes(q));
    }

    const totalNotesForTag = allFiles.length;
    const filesToDisplay = allFiles.slice(0, notesDisplayedCount);
    const hasMoreNotes = totalNotesForTag > filesToDisplay.length;

    rightPane.innerHTML = `
      <div>
        <!-- Right Header with In-Tag Search -->
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:20px;">📑</span>
            <div>
              <h3 style="margin:0;font-size:14.5px;color:var(--text);display:flex;align-items:center;gap:6px;">
                <span>包含</span>
                <span style="color:var(--primary);font-weight:700;">#${escapeHtml(selectedTag)}</span>
                <span>的笔记 (${totalNotesForTag})</span>
              </h3>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="text" id="note-filter-input" value="${escapeHtml(noteSearchQuery)}" placeholder="🔍 检索关联笔记..." style="box-sizing:border-box;padding:5px 12px;font-size:12px;border-radius:16px;border:1px solid var(--border);background:var(--bg);color:var(--text);width:170px;" />
          </div>
        </div>

        <!-- Notes Card List -->
        ${filesToDisplay.length === 0 ? `
          <div style="text-align:center;padding:36px;font-size:12.5px;color:var(--muted);">
            当前标签下未找到匹配 “${escapeHtml(noteSearchQuery)}” 的笔记
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:8px;" id="tag-notes-list">
            ${filesToDisplay.map((filePath) => {
              const meta = (state.manifest && state.manifest[filePath]) || {};
              const mtimeStr = meta.mtime ? new Date(meta.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
              const parts = filePath.split('/');
              const fileName = parts.pop();
              const folderPath = parts.join('/');

              return `
                <div class="tag-note-card" data-path="${escapeHtml(filePath)}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all 0.15s;gap:12px;">
                  <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                    <span style="font-size:18px;opacity:0.85;">📄</span>
                    <div style="min-width:0;flex:1;">
                      <div style="font-weight:600;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(fileName)}</div>
                      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace;">/${escapeHtml(folderPath || '')}</div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:12px;font-size:11.5px;color:var(--text-secondary);white-space:nowrap;">
                    <span>${formatBytes(meta.size || 0)}</span>
                    <span title="修改时间">${mtimeStr}</span>
                    <button type="button" class="token-act-btn primary" style="padding:2px 8px;font-size:11px;">打开 ➔</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          ${hasMoreNotes ? `
            <div style="text-align:center;padding:14px 0 6px;">
              <button type="button" class="token-act-btn" id="load-more-notes-btn" style="padding:6px 18px;font-size:12px;border-radius:16px;">
                加载更多笔记 (已显示 ${filesToDisplay.length} / ${totalNotesForTag} 篇)
              </button>
            </div>
          ` : ''}
        `}
      </div>
    `;

    // Bind Note Filter Input
    const noteFilterInput = rightPane.querySelector('#note-filter-input');
    if (noteFilterInput) {
      noteFilterInput.oninput = () => {
        noteSearchQuery = noteFilterInput.value;
        notesDisplayedCount = notesPageSize;
        updateRightPane();
        const reInput = rightPane.querySelector('#note-filter-input');
        if (reInput) {
          reInput.focus();
          reInput.setSelectionRange(reInput.value.length, reInput.value.length);
        }
      };
    }

    // Bind Load More Button
    const loadMoreBtn = rightPane.querySelector('#load-more-notes-btn');
    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => {
        notesDisplayedCount += notesPageSize;
        updateRightPane();
      };
    }

    // Bind Card Click (Open Note)
    rightPane.querySelectorAll('.tag-note-card').forEach((card) => {
      card.onclick = () => {
        const path = card.getAttribute('data-path');
        if (path) {
          openFile(vaultId, path, {
            onBack: () => {
              if (window.Nimbus?.openVault) window.Nimbus.openVault(vaultId, 'tags');
            },
          });
        }
      };
    });
  }

  // Initial render of left and right panes
  updateLeftPane();
  updateRightPane();
  translate(container);
}

