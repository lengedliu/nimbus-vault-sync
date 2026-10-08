// --------------------------- Vault Tags Explorer & Tag Cloud Subtab ---------------------------
import { state, escapeHtml, formatBytes, translate, encodeURIComponentPath, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';
import { openFile } from './editorView.js';

export async function renderTagsSubtab(vaultId, container) {
  if (!container) return;
  container.innerHTML = `
    <div style="padding: 24px 0; text-align: center; color: var(--muted); font-size: 13.5px;">
      ⏳ 正在索引全库标签数据...
    </div>
  `;

  let tagsData = [];
  try {
    const res = await api(`/api/vaults/${vaultId}/tags`);
    const data = await res.json();
    tagsData = data.tags || [];
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 30px;">
        <div style="font-size: 28px; margin-bottom: 8px;">⚠️</div>
        <div style="font-weight: 600; margin-bottom: 4px;">获取标签索引失败</div>
        <div style="font-size: 12.5px; color: var(--text-muted);">${escapeHtml(err.message)}</div>
      </div>
    `;
    return;
  }

  if (tagsData.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 40px; text-align: center; background: var(--panel); border: 1px dashed var(--border); border-radius: var(--radius);">
        <div style="font-size: 32px; margin-bottom: 10px;">🏷️</div>
        <div style="font-weight: 700; font-size: 15px; margin-bottom: 6px; color: var(--text);">库中暂无标签</div>
        <div style="font-size: 13px; color: var(--muted); max-width: 420px; margin: 0 auto 16px; line-height: 1.6;">
          在任何 Markdown 笔记中输入 <code>#标签名</code> 或 YAML 前置属性 <code>tags: [工作, 想法]</code>，系统将自动聚合至此。
        </div>
      </div>
    `;
    translate(container);
    return;
  }

  let selectedTag = tagsData[0]?.tag || null;
  let searchQuery = '';

  function renderLayout() {
    const totalTagsCount = tagsData.length;
    const totalTaggedRefs = tagsData.reduce((acc, cur) => acc + cur.count, 0);

    const filteredTags = searchQuery.trim()
      ? tagsData.filter((t) => t.tag.toLowerCase().includes(searchQuery.toLowerCase()))
      : tagsData;

    const maxCount = Math.max(...tagsData.map((t) => t.count), 1);

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;">
        <!-- Top Stats & Search Bar -->
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;background:var(--panel-2);border:1px solid var(--border);padding:12px 18px;border-radius:var(--radius);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">🏷️</span>
            <div>
              <div style="font-weight:700;font-size:14.5px;color:var(--text);">标签聚合中心 (Tag Cloud)</div>
              <div style="font-size:12px;color:var(--text-muted);">已发现 <b>${totalTagsCount}</b> 个独特标签 · 共 <b>${totalTaggedRefs}</b> 次笔记引用</div>
            </div>
          </div>
          <div style="position:relative;min-width:240px;">
            <input type="text" id="tag-search-input" value="${escapeHtml(searchQuery)}" placeholder="🔍 快速过滤标签..." style="width:100%;box-sizing:border-box;padding:6px 12px;font-size:12.5px;border-radius:20px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns: minmax(280px, 360px) 1fr;gap:16px;align-items:start;">
          <!-- Left: Tag Cloud & List -->
          <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;max-height:65vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
            <div style="font-weight:600;font-size:12.5px;color:var(--text-secondary);display:flex;align-items:center;justify-content:space-between;">
              <span>标签云聚类 (${filteredTags.length})</span>
              <span style="font-size:11px;color:var(--text-muted);">按引用频次排序</span>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--border);" id="tag-pills-cloud">
              ${filteredTags.map((t) => {
                const isSelected = t.tag === selectedTag;
                // Calculate font weight / scale
                const weightRatio = t.count / maxCount;
                const scaleClass = weightRatio > 0.6 ? 'font-weight:700;' : weightRatio > 0.3 ? 'font-weight:600;' : 'font-weight:500;';
                const bgStyle = isSelected
                  ? 'background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:0 2px 6px rgba(0,0,0,0.15);'
                  : 'background:var(--panel-2);color:var(--text);border-color:var(--border);';

                return `
                  <button type="button" class="tag-cloud-pill" data-tag="${escapeHtml(t.tag)}" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:16px;border:1px solid var(--border);cursor:pointer;font-size:12px;transition:all 0.15s;${scaleClass}${bgStyle}">
                    <span>#${escapeHtml(t.tag)}</span>
                    <span style="font-size:10.5px;padding:1px 6px;border-radius:10px;background:${isSelected ? 'rgba(255,255,255,0.25)' : 'var(--bg)'};color:${isSelected ? '#fff' : 'var(--text-secondary)'};font-weight:700;">${t.count}</span>
                  </button>
                `;
              }).join('')}
            </div>

            <!-- Hierarchical List -->
            <div style="display:flex;flex-direction:column;gap:4px;">
              ${filteredTags.map((t) => {
                const isSelected = t.tag === selectedTag;
                return `
                  <div class="tag-row-item" data-tag="${escapeHtml(t.tag)}" style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:6px;cursor:pointer;background:${isSelected ? 'rgba(59,130,246,0.1)' : 'transparent'};color:${isSelected ? 'var(--primary)' : 'var(--text)'};transition:background 0.15s;">
                    <div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:${isSelected ? '700' : '500'};">
                      <span style="opacity:0.7;">🏷️</span>
                      <span>#${escapeHtml(t.tag)}</span>
                    </div>
                    <span style="font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--panel-2);color:var(--text-muted);">${t.count} 篇</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Right: Notes with selected tag -->
          <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;min-height:360px;" id="tag-notes-pane">
            ${renderSelectedTagNotes(vaultId, selectedTag, tagsData)}
          </div>
        </div>
      </div>
    `;

    // Event Listeners
    const searchInput = container.querySelector('#tag-search-input');
    if (searchInput) {
      searchInput.oninput = () => {
        searchQuery = searchInput.value;
        const cloudPills = container.querySelector('#tag-pills-cloud');
        renderLayout();
        const reInput = container.querySelector('#tag-search-input');
        if (reInput) {
          reInput.focus();
          reInput.setSelectionRange(reInput.value.length, reInput.value.length);
        }
      };
    }

    container.querySelectorAll('.tag-cloud-pill, .tag-row-item').forEach((el) => {
      el.onclick = () => {
        const tag = el.getAttribute('data-tag');
        if (tag) {
          selectedTag = tag;
          renderLayout();
        }
      };
    });

    const notesPane = container.querySelector('#tag-notes-pane');
    if (notesPane) {
      notesPane.querySelectorAll('.tag-note-card').forEach((card) => {
        card.onclick = () => {
          const path = card.getAttribute('data-path');
          if (path) openFile(vaultId, path);
        };
      });
    }

    translate(container);
  }

  function renderSelectedTagNotes(vId, curTag, allTags) {
    if (!curTag) {
      return `<div class="empty-state" style="padding:40px;">请在左侧选择一个标签以查看关联笔记</div>`;
    }

    const currentObj = allTags.find((t) => t.tag === curTag);
    if (!currentObj || currentObj.files.length === 0) {
      return `<div class="empty-state" style="padding:40px;">未找到包含标签 #${escapeHtml(curTag)} 的笔记</div>`;
    }

    return `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;">📑</span>
            <h3 style="margin:0;font-size:15px;color:var(--text);">包含 <span style="color:var(--primary);">#${escapeHtml(curTag)}</span> 的笔记 (${currentObj.files.length})</h3>
          </div>
          <span style="font-size:12px;color:var(--text-muted);">点击任意卡片即可直接打开编辑与预览</span>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          ${currentObj.files.map((filePath) => {
            const meta = (state.manifest && state.manifest[filePath]) || {};
            const mtimeStr = meta.mtime ? new Date(meta.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
            const fileName = filePath.split('/').pop();
            const folderPath = filePath.split('/').slice(0, -1).join('/');

            return `
              <div class="tag-note-card" data-path="${escapeHtml(filePath)}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all 0.15s;gap:12px;">
                <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                  <span style="font-size:18px;">📄</span>
                  <div style="min-width:0;flex:1;">
                    <div style="font-weight:600;font-size:13.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(fileName)}</div>
                    <div style="font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace;">/${escapeHtml(folderPath || '')}</div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:14px;font-size:12px;color:var(--text-secondary);white-space:nowrap;">
                  <span>${formatBytes(meta.size || 0)}</span>
                  <span title="修改时间">${mtimeStr}</span>
                  <button type="button" class="token-act-btn primary" style="padding:3px 10px;font-size:11.5px;">打开 ➔</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderLayout();
}
