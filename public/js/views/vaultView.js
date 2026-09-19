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

  // Subtabs bar
  const subtabsBar = document.createElement('div');
  subtabsBar.className = 'subtabs-bar';
  subtabsBar.innerHTML = `
    <button class="subtab-btn ${state.activeSubtab === 'files' ? 'active' : ''}" data-sub="files">📄 笔记与文件</button>
    <button class="subtab-btn ${state.activeSubtab === 'conflicts' ? 'active' : ''}" data-sub="conflicts" id="subtab-conflicts-btn">⚔️ 冲突解决中心</button>
    <button class="subtab-btn ${state.activeSubtab === 'backups' ? 'active' : ''}" data-sub="backups">💾 快照与备份</button>
    <button class="subtab-btn ${state.activeSubtab === 'git' ? 'active' : ''}" data-sub="git">🚀 Git 自动备份</button>
    <button class="subtab-btn ${state.activeSubtab === 'permissions' ? 'active' : ''}" data-sub="permissions">👥 成员与权限</button>
    <button class="subtab-btn ${state.activeSubtab === 'stats' ? 'active' : ''}" data-sub="stats">📊 统计与监控</button>
    <button class="subtab-btn ${state.activeSubtab === 'synclogs' ? 'active' : ''}" data-sub="synclogs">📋 同步日志</button>
    <button class="subtab-btn ${state.activeSubtab === 'shares' ? 'active' : ''}" data-sub="shares">🔗 公开分享</button>
    <button class="subtab-btn ${state.activeSubtab === 'rules' ? 'active' : ''}" data-sub="rules">⚙️ 同步规则</button>
    <button class="subtab-btn ${state.activeSubtab === 'trash' ? 'active' : ''}" data-sub="trash">🗑️ 回收站</button>
  `;
  mainPanel.appendChild(subtabsBar);

  api(`/api/vaults/${vaultId}/conflicts`).then((res) => res.json()).then((data) => {
    const count = (data.conflicts || []).length;
    const btn = subtabsBar.querySelector('#subtab-conflicts-btn');
    if (btn && count > 0) {
      btn.innerHTML = `⚔️ 冲突解决中心 <span class="conflict-badge">${count}</span>`;
    }
  }).catch(() => {});

  subtabsBar.querySelectorAll('.subtab-btn').forEach((btn) => {
    btn.onclick = () => {
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
  else if (state.activeSubtab === 'conflicts') renderConflictsSubtab(vaultId, contentBox, { openVault });
  else if (state.activeSubtab === 'backups') renderBackupsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'git') renderGitSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'permissions') renderPermissionsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'stats') renderStatsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'synclogs') renderVaultSyncLogsSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'shares') renderSharesSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'rules') renderRulesSubtab(vaultId, contentBox);
  else if (state.activeSubtab === 'trash') renderTrashSubtab(vaultId, contentBox, { showFilePreviewModal, openVault });

  translate(mainPanel);
}
