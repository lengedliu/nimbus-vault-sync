// --------------------------- Nimbus Web Dashboard Main Entry (ES Module Architecture) ---------------------------
import { state, normalizeServerUrl, setAppVersion, translate, escapeHtml, formatBytes, encodeURIComponentPath, $ } from './core/state.js';
import { api, fetchServerVersion } from './core/api.js';
import { toast, showConfirm, showAlert, showPrompt, showModal, closeModal } from './core/dialogs.js';
import { THEMES, applyTheme, updateThemeUI, updateDateDisplays, formatCurrentDate, applyFontSize, initThemeSwitcher, initFontSizeSwitcher } from './core/themes.js';
import { connectWebSocket, disconnectWebSocket } from './core/wsClient.js';
import {
  checkAuthStatus,
  fillAdminCredentials,
  initAuthForm,
  enterApp,
  loadVaults,
  renderVaultList,
  showTab,
  initMobileNavigation,
  closeMobileSidebar,
  toggleMobileSidebar,
  setupCollapsibleSections,
  initLanguageDropdowns,
} from './core/appShell.js';

import { showObsidianConnectModal, showMcpModal } from './views/connectModal.js';
import { showDocsModal } from './views/docsModal.js';
import { setupGlobalSearch, openGlobalSearchModal } from './views/searchModal.js';
import { openFile, renderMediaViewer, saveFile, showFilePreviewModal } from './views/editorView.js';
import { renderDiff, showHistoryModal } from './views/diffView.js';
import {
  renderFilesSubtab,
  renderFileList,
  buildFileTree,
  renderTreeFileList,
  renderFlatFileList,
  getVaultFolderList,
  showMoveFileModal,
  showBatchMoveModal,
  createNewNotePrompt,
  triggerFileUpload,
  setupDragDrop,
} from './views/filesSubtab.js';
import {
  renderVaultContainer,
  openVault,
  syncVaultDelta,
  connectVaultWs,
  scheduleDebouncedViewUpdate,
} from './views/vaultView.js';

import { renderTrashSubtab } from './views/trashSubtab.js';
import { renderConflictsSubtab } from './views/conflictsSubtab.js';
import { renderStatsSubtab } from './views/statsSubtab.js';
import { renderSharesSubtab, showCreateShareModal, showShareSuccessModal } from './views/sharesSubtab.js';
import { renderPermissionsSubtab } from './views/permissionsSubtab.js';
import { renderRulesSubtab } from './views/rulesSubtab.js';
import { renderBackupsSubtab } from './views/backupsSubtab.js';
import { renderGitSubtab } from './views/gitSubtab.js';
import { renderVaultSyncLogsSubtab, renderAdminSyncLogsPanel } from './views/syncLogsView.js';
import { renderDashboardPanel, renderKanbanSubView } from './views/kanbanSubtab.js';
import { renderSettingsPanel } from './views/settingsView.js';
import { renderDevicesPanel } from './views/devicesView.js';
import { renderWebhooksPanel } from './views/webhooksView.js';
import { renderUsersPanel } from './views/usersView.js';
import { renderDatabasePanel, renderDatabaseSettingsSubtab } from './views/databaseView.js';
import { renderSponsorPanel } from './views/sponsorView.js';
import { renderAllVaultsPanel } from './views/allVaultsView.js';

// Expose on window for compatibility with inline handlers & global access
window.Nimbus = {
  state,
  api,
  toast,
  showConfirm,
  showAlert,
  showPrompt,
  showModal,
  closeModal,
  applyTheme,
  applyFontSize,
  initThemeSwitcher,
  initFontSizeSwitcher,
  showObsidianConnectModal,
  showMcpModal,
  showDocsModal,
  setupGlobalSearch,
  openGlobalSearchModal,
  connectWebSocket,
  disconnectWebSocket,
  // Core Shell
  checkAuthStatus,
  fillAdminCredentials,
  enterApp,
  loadVaults,
  renderVaultList,
  showTab,
  closeMobileSidebar,
  toggleMobileSidebar,
  // Editor & Preview & Diff
  openFile,
  renderMediaViewer,
  saveFile,
  showFilePreviewModal,
  renderDiff,
  showHistoryModal,
  // Files Subtab & Tree
  renderFilesSubtab,
  renderFileList,
  buildFileTree,
  renderTreeFileList,
  renderFlatFileList,
  getVaultFolderList,
  showMoveFileModal,
  showBatchMoveModal,
  createNewNotePrompt,
  triggerFileUpload,
  setupDragDrop,
  // Vault Container & Navigation
  renderVaultContainer,
  openVault,
  syncVaultDelta,
  connectVaultWs,
  scheduleDebouncedViewUpdate,
  // Views
  renderTrashSubtab,
  renderConflictsSubtab,
  renderStatsSubtab,
  renderSharesSubtab,
  showCreateShareModal,
  showShareSuccessModal,
  renderPermissionsSubtab,
  renderRulesSubtab,
  renderBackupsSubtab,
  renderGitSubtab,
  renderVaultSyncLogsSubtab,
  renderAdminSyncLogsPanel,
  renderDashboardPanel,
  renderKanbanSubView,
  renderSettingsPanel,
  renderDevicesPanel,
  renderWebhooksPanel,
  renderUsersPanel,
  renderDatabasePanel,
  renderDatabaseSettingsSubtab,
  renderSponsorPanel,
  renderAllVaultsPanel,
};

// Global helper for opening notes from search tables or inline actions
window.nimbusOpenFile = (vaultId, encPath) => {
  openFile(vaultId, decodeURIComponent(encPath));
};

// --------------------------- Application Bootstrap ---------------------------
initLanguageDropdowns();
initAuthForm();
initFontSizeSwitcher();
applyTheme(localStorage.getItem('nimbus_theme') || 'cyber-blue');
applyFontSize(localStorage.getItem('nimbus_font_size') || 'normal');
updateDateDisplays();
setInterval(updateDateDisplays, 10000);

if (state.token && state.user) {
  enterApp().catch(() => {
    localStorage.removeItem('nimbus_token');
    localStorage.removeItem('nimbus_user');
    location.reload();
  });
} else {
  const loginServerInput = $('#login-server');
  if (loginServerInput) {
    loginServerInput.value = state.serverBase === window.location.origin ? '' : state.serverBase;
    checkAuthStatus();
    loginServerInput.addEventListener('change', () => {
      state.serverBase = normalizeServerUrl(loginServerInput.value.trim());
      checkAuthStatus();
    });
  }
}
