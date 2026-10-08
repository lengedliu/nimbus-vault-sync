/**
 * @deprecated Nimbus Vault Sync - app.js has been thoroughly de-monolithized and deprecated.
 * All modules have been split into clean, single-responsibility ES modules under /public/js/:
 *  - /public/js/core/state.js       (Global reactive state, DOM utilities, string formatters)
 *  - /public/js/core/api.js         (Centralized fetch client & error handling)
 *  - /public/js/core/dialogs.js     (Modal, Prompt, Confirm, and Toast notification systems)
 *  - /public/js/core/themes.js      (Theme switcher & responsive font size scaling)
 *  - /public/js/core/wsClient.js    (WebSocket real-time delta synchronization)
 *  - /public/js/core/appShell.js    (Auth form, topbar, mobile drawer, section toggles, vault list)
 *  - /public/js/views/editorView.js (Note editor, media viewer, raw/preview markdown toggle, modal)
 *  - /public/js/views/filesSubtab.js(File tree, flat file list, batch operations, drag-and-drop)
 *  - /public/js/views/diffView.js   (Side-by-side git-style diffing & history inspection)
 *  - /public/js/views/vaultView.js  (Vault subtab router, WS listener, header actions)
 *  - /public/js/views/searchModal.js(Full-text and path instant multi-vault search)
 *  - /public/js/views/docsModal.js  (Interactive REST API cURL documentation)
 *  - /public/js/views/connectModal.js (Obsidian BRAT/data.json & MCP connect modals)
 *
 * All functions and state are accessible via window.Nimbus.
 */

(() => {
  if (typeof window !== 'undefined') {
    window.__NIMBUS_DEPRECATED_APP_JS_LOADED = true;
    console.info('[Nimbus] Legacy app.js is deprecated and replaced by modular ES modules in /public/js/main.js.');
  }
})();
