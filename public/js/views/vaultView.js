// --------------------------- Vault Main Container & Subtab Routing ---------------------------
import { state, escapeHtml, translate, $ } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';
import { showObsidianConnectModal } from './connectModal.js';
import { renderFilesSubtab, renderFileList, createNewNotePrompt, triggerFileUpload } from './filesSubtab.js';
import { showFilePreviewModal } from './editorView.js';
import { renderConflictsSubtab } from './conflictsSubtab.js';
import { renderBackupsSubtab } from './backupsSubtab.js';
import { renderGitSubtab } from './gitSubtab.js';
import { renderPermissionsSubtab } from './permissionsSubtab.js';
import { renderStatsSubtab } from './statsSubtab.js';
import { renderVaultSyncLogsSubtab } from './syncLogsView.js';
import { renderSharesSubtab } from './sharesSubtab.js';
import { renderRulesSubtab } from './rulesSubtab.js';
import { renderTrashSubtab } from './trashSubtab.js';
import { renderTagsSubtab } from './tagsSubtab.js';
import { renderCloudBackupSubtab } from './cloudBackupSubtab.js';

export function scheduleDebouncedViewUpdate(vaultId) {
  if (state.activeVaultId !== vaultId) return;
  if (state.wsDebounceTimer) clearTimeout(state.wsDebounceTimer);
  state.wsDebounceTimer = setTimeout(() => {
    const countBadge = document.querySelector('.vault-title .badge');
    if (countBadge && state.manifest) {
      countBadge.textContent = `${Object.keys(state.manifest).length} 个文件`;
    }
    if (state.activeSubtab === 'files') {
      const fileViewWrap = document.getElementById('files-list-wrapper');
      if (fileViewWrap) {
        renderFileList(vaultId, fileViewWrap);
      }
    }
  }, 200);
}

export async function syncVaultDelta(vaultId) {
  if (!state.token || !vaultId || !state.manifest) return false;
  try {
    const since = state.vaultCursor || 0;
    const res = await api(`/api/vaults/${vaultId}/changes?since=${since}&limit=500`);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.full || data.fullSyncRequired) {
      state.manifest = data.manifest;
      state.vaultCursor = data.cursor || data.latestCursor || 0;
      scheduleDebouncedViewUpdate(vaultId);
      return true;
    }
    if (data.changesCount > 0) {
      if (Array.isArray(data.updates)) {
        for (const u of data.updates) {
          state.manifest[u.path] = {
            size: u.size || 0,
            mtime: u.mtime || Date.now(),
            ctime: u.mtime || Date.now(),
            hash: u.hash || '',
          };
        }
      }
      if (Array.isArray(data.deletes)) {
        for (const d of data.deletes) {
          delete state.manifest[d.path];
        }
      }
      state.vaultCursor = data.cursor || state.vaultCursor;
      scheduleDebouncedViewUpdate(vaultId);
      return true;
    }
  } catch {}
  return false;
}

export function connectVaultWs(vaultId) {
  if (state.wsClient) {
    try {
      state.wsClient.onclose = null;
      state.wsClient.onerror = null;
      state.wsClient.close();
    } catch {}
    state.wsClient = null;
  }
  if (!state.token || !vaultId) return;

  try {
    const cleanToken = (state.token || '').replace(/^Bearer\s+/i, '').trim();
    const loc = window.location;
    const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = state.serverBase ? state.serverBase.replace(/^https?:\/\//i, '').replace(/\/$/, '') : loc.host;
    const wsUrl = `${wsProto}//${wsHost}/ws?vaultId=${encodeURIComponent(vaultId)}&token=${encodeURIComponent(cleanToken)}&deviceName=Web+Client`;
    const ws = new WebSocket(wsUrl);
    state.wsClient = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_revoked' || msg.type === 'force_logout') {
          toast(msg.message || 'WebSocket 身份凭证已失效或被撤销，请重新登录', 'error');
          return;
        }
        if (msg.type === 'permission_updated') {
          toast(msg.message || '笔记库访问权限已变更', 'info');
          if (window.Nimbus?.loadVaults) window.Nimbus.loadVaults();
          return;
        }
        if (msg.type === 'conflict') {
          toast(`检测到并发冲突，已创建分支副本: ${msg.conflictPath}`, 'warning');
          return;
        }
        if (msg.cursor) {
          state.vaultCursor = Math.max(state.vaultCursor || 0, msg.cursor);
        }
        if (msg.type === 'init' && msg.manifest) {
          state.manifest = msg.manifest;
          if (msg.cursor) state.vaultCursor = msg.cursor;
          scheduleDebouncedViewUpdate(vaultId);
        } else if (msg.type === 'change') {
          if (!state.manifest) state.manifest = {};
          state.manifest[msg.path] = {
            size: msg.size || 0,
            mtime: msg.mtime || Date.now(),
            ctime: msg.ctime || Date.now(),
            hash: msg.hash || '',
          };
          scheduleDebouncedViewUpdate(vaultId);
        } else if (msg.type === 'deleted') {
          if (state.manifest && state.manifest[msg.path]) {
            delete state.manifest[msg.path];
            scheduleDebouncedViewUpdate(vaultId);
          }
        } else if (msg.type === 'batch_file_change' && Array.isArray(msg.changes)) {
          if (!state.manifest) state.manifest = {};
          for (const c of msg.changes) {
            if (c.action === 'delete') {
              delete state.manifest[c.path];
            } else {
              state.manifest[c.path] = {
                size: c.size || 0,
                mtime: c.mtime || Date.now(),
                ctime: c.ctime || Date.now(),
                hash: c.hash || '',
              };
            }
          }
          scheduleDebouncedViewUpdate(vaultId);
        }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = (event) => {
      if (event && (event.code === 4001 || event.code === 4003)) {
        return;
      }
      if (state.activeVaultId === vaultId) {
        setTimeout(() => {
          if (state.activeVaultId === vaultId) {
            syncVaultDelta(vaultId);
            connectVaultWs(vaultId);
          }
        }, 5000);
      }
    };
  } catch {}
}

export async function openVault(vaultId, subtab = 'files') {
  if (window.Nimbus?.resetEditorHistory) window.Nimbus.resetEditorHistory();
  if (window.innerWidth <= 768 && window.Nimbus?.closeMobileSidebar) {
    window.Nimbus.closeMobileSidebar();
  }
  if (state.activeVaultId !== vaultId) {
    state.treeFoldersInitialized = false;
    state.flatListPage = 1;
  }
  state.activeVaultId = vaultId;
  state.activeSubtab = subtab;
  state.activeTab = null;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.activity-icon-btn').forEach((b) => b.classList.remove('active'));
  const actVaultBtn = document.getElementById('act-btn-vaults');
  if (actVaultBtn) actVaultBtn.classList.add('active');
  if (window.Nimbus?.updateInspectorTelemetry) {
    window.Nimbus.updateInspectorTelemetry();
  }
  if (window.Nimbus?.renderVaultList) {
    window.Nimbus.renderVaultList();
  }

  try {
    const res = await api(`/api/vaults/${vaultId}/manifest`);
    const body = await res.json();
    state.manifest = body.manifest || {};
    state.vaultCursor = body.cursor || body.latestCursor || 0;
  } catch (e) {
    console.warn('[Nimbus] Failed to fetch manifest:', e);
  }

  connectVaultWs(vaultId);
  renderVaultContainer(vaultId);
}

export function renderVaultContainer(vaultId) {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;

  const vault = state.vaults.find((v) => v.id === vaultId) || { name: 'Vault', id: vaultId };
  mainPanel.innerHTML = '';
  mainPanel.scrollTop = 0;

  const isReadOnly = vault.myPermission === 'read-only';
  const permBadgeText = vault.isOwner ? '所有者' : vault.myPermission === 'read-only' ? '只读' : '读写';
  const permBadgeClass = vault.isOwner ? 'primary' : vault.myPermission === 'read-only' ? 'warning' : 'success';

  // Header
  const header = document.createElement('div');
  header.className = 'vault-header';
  header.innerHTML = `
    <div class="vault-title">
      <h2>📓 ${escapeHtml(vault.name)}</h2>
      <span class="badge" style="font-size:11px">${Object.keys(state.manifest || {}).length} 个文件</span>
      <span class="badge ${permBadgeClass}" style="font-size:11px">权限: ${permBadgeText}</span>
    </div>
    <div class="vault-actions">
      ${!isReadOnly ? '<button class="btn-primary" id="v-new-note-btn">+ 新建笔记</button>' : ''}
      ${!isReadOnly ? '<button class="secondary" id="v-upload-btn">⬆️ 上传文件</button>' : ''}
      <button class="secondary" id="v-export-btn">📦 导出 ZIP</button>
      <button class="secondary" id="v-connect-btn">⚡ Obsidian 连接</button>
    </div>
  `;
  mainPanel.appendChild(header);

  // Subtabs navigation bar with horizontal scroll & left/right arrows
  const navWrapper = document.createElement('div');
  navWrapper.className = 'subtabs-nav-wrapper';
  navWrapper.innerHTML = `
    <div class="subtabs-scroll-container" id="vault-subtabs-scroll">
      <div class="subtabs-bar">
        <button class="subtab-btn ${state.activeSubtab === 'files' ? 'active' : ''}" data-sub="files">📄 笔记与文件</button>
        <button class="subtab-btn ${state.activeSubtab === 'tags' ? 'active' : ''}" data-sub="tags">🏷️ 标签聚合</button>
        <button class="subtab-btn ${state.activeSubtab === 'conflicts' ? 'active' : ''}" data-sub="conflicts" id="subtab-conflicts-btn">⚔️ 冲突解决中心</button>
        <button class="subtab-btn ${state.activeSubtab === 'backups' ? 'active' : ''}" data-sub="backups">💾 快照与备份</button>
        <button class="subtab-btn ${state.activeSubtab === 'git' ? 'active' : ''}" data-sub="git">🚀 Git 自动备份</button>
        <button class="subtab-btn ${state.activeSubtab === 'cloudbackup' ? 'active' : ''}" data-sub="cloudbackup">☁️ 多云异地容灾</button>
        <button class="subtab-btn ${state.activeSubtab === 'permissions' ? 'active' : ''}" data-sub="permissions">👥 成员与权限</button>
        <button class="subtab-btn ${state.activeSubtab === 'stats' ? 'active' : ''}" data-sub="stats">📊 统计与监控</button>
        <button class="subtab-btn ${state.activeSubtab === 'synclogs' ? 'active' : ''}" data-sub="synclogs">📋 同步日志</button>
        <button class="subtab-btn ${state.activeSubtab === 'shares' ? 'active' : ''}" data-sub="shares">🔗 公开分享</button>
        <button class="subtab-btn ${state.activeSubtab === 'rules' ? 'active' : ''}" data-sub="rules">⚙️ 同步规则</button>
        <button class="subtab-btn ${state.activeSubtab === 'trash' ? 'active' : ''}" data-sub="trash">🗑️ 回收站</button>
      </div>
    </div>
    <div class="subtabs-nav-actions">
      <div class="subtabs-nav-divider"></div>
      <button type="button" class="subtabs-arrow-btn" id="vault-subtabs-prev" title="向左滚动" aria-label="向左滚动">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <button type="button" class="subtabs-arrow-btn" id="vault-subtabs-next" title="向右滚动" aria-label="向右滚动">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
    </div>
  `;
  mainPanel.appendChild(navWrapper);

  const subtabsBar = navWrapper.querySelector('.subtabs-bar');
  setupSubtabsDraggableScroll(navWrapper);

  api(`/api/vaults/${vaultId}/conflicts`).then((res) => res.json()).then((data) => {
    const count = (data.conflicts || []).length;
    const btn = subtabsBar.querySelector('#subtab-conflicts-btn');
    if (btn && count > 0) {
      btn.innerHTML = `⚔️ 冲突解决中心 <span class="conflict-badge">${count}</span>`;
    }
  }).catch(() => {});

  subtabsBar.querySelectorAll('.subtab-btn').forEach((btn) => {
    btn.onclick = (e) => {
      const scrollEl = navWrapper.querySelector('.subtabs-scroll-container');
      if (scrollEl && scrollEl._suppressClickUntil && Date.now() < scrollEl._suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      state.activeSubtab = btn.dataset.sub;
      renderVaultContainer(vaultId);
    };
  });

  const contentBox = document.createElement('div');
  contentBox.id = 'vault-subtab-content';
  mainPanel.appendChild(contentBox);

  if (!isReadOnly) {
    const newNoteBtn = $('#v-new-note-btn');
    if (newNoteBtn) newNoteBtn.onclick = () => createNewNotePrompt(vaultId);
    const uploadBtn = $('#v-upload-btn');
    if (uploadBtn) uploadBtn.onclick = () => triggerFileUpload(vaultId);
  }
  const exportBtn = $('#v-export-btn');
  if (exportBtn) {
    exportBtn.onclick = () => {
      window.open(`${state.serverBase.replace(/\/$/, '')}/api/vaults/${vaultId}/export?token=${state.token}`, '_blank');
    };
  }
  const connectBtn = $('#v-connect-btn');
  if (connectBtn) {
    connectBtn.onclick = () => showObsidianConnectModal(vault);
  }

  if (state.activeSubtab === 'files') renderFilesSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'tags') renderTagsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'conflicts') renderConflictsSubtab(vaultId, contentBox, { openVault });
  else if (state.activeSubtab === 'backups') renderBackupsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'git') renderGitSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'cloudbackup') renderCloudBackupSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'permissions') renderPermissionsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'stats') renderStatsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'synclogs') renderVaultSyncLogsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'shares') renderSharesSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'rules') renderRulesSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'trash') renderTrashSubtab(vaultId, contentBox, { showFilePreviewModal, openVault });

  translate(mainPanel);
}

function setupSubtabsDraggableScroll(navWrapper) {
  const scrollContainer = navWrapper.querySelector('.subtabs-scroll-container');
  const prevBtn = navWrapper.querySelector('#vault-subtabs-prev');
  const nextBtn = navWrapper.querySelector('#vault-subtabs-next');
  if (!scrollContainer) return;

  const updateArrows = () => {
    if (!scrollContainer.isConnected) return;
    const maxScroll = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
    const sl = scrollContainer.scrollLeft;
    if (prevBtn) {
      const atStart = sl <= 2;
      prevBtn.disabled = atStart;
      prevBtn.classList.toggle('disabled', atStart);
    }
    if (nextBtn) {
      const atEnd = sl >= maxScroll - 2;
      nextBtn.disabled = atEnd;
      nextBtn.classList.toggle('disabled', atEnd);
    }
  };

  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      scrollContainer.scrollBy({ left: -260, behavior: 'smooth' });
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      scrollContainer.scrollBy({ left: 260, behavior: 'smooth' });
    });
  }

  // 鼠标滚轮横向滚动支持 (Mouse wheel horizontal scroll)
  scrollContainer.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scrollContainer.scrollWidth > scrollContainer.clientWidth) {
      scrollContainer.scrollLeft += e.deltaY;
      e.preventDefault();
      updateArrows();
    }
  }, { passive: false });

  // 鼠标按住拖动 (Mouse drag to scroll)
  let isDown = false;
  let startX = 0;
  let startScrollLeft = 0;
  let hasMoved = false;

  scrollContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 仅限鼠标主键
    isDown = true;
    hasMoved = false;
    startX = e.pageX;
    startScrollLeft = scrollContainer.scrollLeft;
  });

  const onMouseMove = (e) => {
    if (!scrollContainer.isConnected) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      return;
    }
    if (!isDown) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 4) {
      hasMoved = true;
      scrollContainer.classList.add('is-dragging');
      scrollContainer.scrollLeft = startScrollLeft - dx;
      updateArrows();
    }
  };

  const onMouseUp = () => {
    if (!scrollContainer.isConnected) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      return;
    }
    if (!isDown) return;
    isDown = false;
    scrollContainer.classList.remove('is-dragging');
    if (hasMoved) {
      scrollContainer._suppressClickUntil = Date.now() + 180;
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  scrollContainer.addEventListener('scroll', updateArrows, { passive: true });
  window.addEventListener('resize', updateArrows, { passive: true });

  // 初始加载或切换时，自动将激活的标签平滑对齐至可见视野
  requestAnimationFrame(() => {
    const activeBtn = scrollContainer.querySelector('.subtab-btn.active');
    if (activeBtn) {
      const cRect = scrollContainer.getBoundingClientRect();
      const bRect = activeBtn.getBoundingClientRect();
      if (bRect.left < cRect.left || bRect.right > cRect.right) {
        activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }
    updateArrows();
  });
}
