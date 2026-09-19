// --------------------------- Global State & Theme/Font Managers ---------------------------

export function normalizeServerUrl(raw) {
  if (!raw || !raw.trim()) return window.location.origin;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = window.location.protocol + '//' + url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === window.location.hostname && !parsed.port && window.location.port) {
      parsed.port = window.location.port;
    }
    return parsed.origin;
  } catch {
    return window.location.origin;
  }
}

export const state = {
  serverBase: normalizeServerUrl(localStorage.getItem('nimbus_server') || window.location.origin),
  token: localStorage.getItem('nimbus_token') || '',
  user: JSON.parse(localStorage.getItem('nimbus_user') || 'null'),
  vaults: [],
  activeVaultId: null,
  activeSubtab: 'files',
  manifest: {},
  activeTab: null,
  fileFilter: 'all',
  fileViewMode: localStorage.getItem('nimbus_file_view_mode') || 'tree',
  treeSortOrder: localStorage.getItem('nimbus_tree_sort_order') || 'ctime-desc',
  expandedFolders: new Set(),
  treeFoldersInitialized: false,
  flatListPage: 1,
  flatListPageSize: parseInt(localStorage.getItem('nimbus_flat_page_size') || '50', 10),
  selectedFiles: new Set(),
  searchQuery: '',
  appVersion: '1.3.0',
  vaultCursor: 0,
  wsClient: null,
  wsDebounceTimer: null,
};

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

export const t = (key, fallback, params) => {
  if (window.i18n && window.i18n.t) {
    return window.i18n.t(key, fallback, params);
  }
  return fallback !== undefined ? fallback : key;
};

export const translate = (root) => {
  if (window.i18n && window.i18n.translateDOM) {
    window.i18n.translateDOM(root || $('#main-panel'));
  }
};

export function setAppVersion(ver) {
  if (!ver) return;
  const cleanVer = String(ver).replace(/^v/i, '');
  state.appVersion = cleanVer;
  const displayVer = `v${cleanVer}`;
  document.querySelectorAll('.sidebar-version-badge, #sidebar-version-badge').forEach((el) => {
    el.textContent = displayVer;
  });
  const dashBadge = $('#dashboard-version-badge');
  if (dashBadge) dashBadge.textContent = displayVer;
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function encodeURIComponentPath(p) {
  if (!p) return '';
  return String(p).split('/').map(encodeURIComponent).join('/');
}

export { formatCurrentDate } from './themes.js';
