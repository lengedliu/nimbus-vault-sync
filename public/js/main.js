// --------------------------- Nimbus Web Dashboard Main Entry ---------------------------
import { state, $, $$, setAppVersion, translate } from './core/state.js';
import { api, fetchServerVersion } from './core/api.js';
import { toast, showConfirm, showAlert, showPrompt, showModal, closeModal } from './core/dialogs.js';
import { THEMES, applyTheme, updateThemeUI, updateDateDisplays, applyFontSize, initThemeSwitcher } from './core/themes.js';
import { connectWebSocket, disconnectWebSocket } from './core/wsClient.js';
import { showObsidianConnectModal, showMcpModal } from './views/connectModal.js';

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
  showObsidianConnectModal,
  showMcpModal,
  connectWebSocket,
  disconnectWebSocket,
};

// Auto-run version check & date updates
document.addEventListener('DOMContentLoaded', () => {
  fetchServerVersion();
  updateDateDisplays();
  setInterval(updateDateDisplays, 60000);
  applyTheme(localStorage.getItem('nimbus_theme') || 'cyber-blue');
  applyFontSize(localStorage.getItem('nimbus_font_size') || 'normal');
});
