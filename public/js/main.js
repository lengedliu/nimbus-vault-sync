// --------------------------- Nimbus Web Dashboard Main Entry ---------------------------
import { state, $, $$, setAppVersion, translate, escapeHtml, formatBytes } from './core/state.js';
import { api, fetchServerVersion } from './core/api.js';
import { toast, showConfirm, showAlert, showPrompt, showModal, closeModal } from './core/dialogs.js';
import { THEMES, applyTheme, updateThemeUI, updateDateDisplays, formatCurrentDate, applyFontSize, initThemeSwitcher } from './core/themes.js';
import { connectWebSocket, disconnectWebSocket } from './core/wsClient.js';
import { showObsidianConnectModal, showMcpModal } from './views/connectModal.js';
import { renderTrashSubtab } from './views/trashSubtab.js';
import { renderConflictsSubtab } from './views/conflictsSubtab.js';
import { renderStatsSubtab } from './views/statsSubtab.js';
import { renderSharesSubtab, showCreateShareModal, showShareSuccessModal } from './views/sharesSubtab.js';
import { renderPermissionsSubtab } from './views/permissionsSubtab.js';
import { renderRulesSubtab } from './views/rulesSubtab.js';
import { renderBackupsSubtab } from './views/backupsSubtab.js';
import { renderGitSubtab } from './views/gitSubtab.js';
import { renderVaultSyncLogsSubtab } from './views/syncLogsSubtab.js';
import { renderDashboardPanel, renderKanbanSubView } from './views/kanbanSubtab.js';
import { renderSettingsPanel } from './views/settingsTab.js';
import { renderDevicesPanel } from './views/devicesTab.js';
import { renderWebhooksPanel } from './views/webhooksTab.js';
import { renderUsersPanel } from './views/usersTab.js';

// Expose on window for backward-compatibility with classic event handlers & i18n
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
  showObsidianConnectModal,
  showMcpModal,
  connectWebSocket,
  disconnectWebSocket,
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
  renderDashboardPanel,
  renderKanbanSubView,
  renderSettingsPanel,
  renderDevicesPanel,
  renderWebhooksPanel,
  renderUsersPanel,
};

// Auto-run version check & date updates
document.addEventListener('DOMContentLoaded', () => {
  fetchServerVersion();
  updateDateDisplays();
  setInterval(updateDateDisplays, 60000);
  applyTheme(localStorage.getItem('nimbus_theme') || 'cyber-blue');
  applyFontSize(localStorage.getItem('nimbus_font_size') || 'normal');
});

