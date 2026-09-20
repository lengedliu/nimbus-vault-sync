// --------------------------- Application Shell, Auth & Topbar Navigation ---------------------------
import { state, normalizeServerUrl, escapeHtml, translate, setAppVersion, $, $$ } from './state.js';
import { api, fetchServerVersion } from './api.js';
import { showConfirm, showPrompt } from './dialogs.js';
import { initThemeSwitcher, initFontSizeSwitcher, updateThemeUI, updateFontSizeUI, updateDateDisplays, applyTheme } from './themes.js';
import { showObsidianConnectModal, showMcpModal } from '../views/connectModal.js';
import { showDocsModal } from '../views/docsModal.js';
import { setupGlobalSearch } from '../views/searchModal.js';
import { openVault, renderVaultContainer } from '../views/vaultView.js';
import { renderDashboardPanel } from '../views/kanbanSubtab.js';
import { renderSettingsPanel } from '../views/settingsView.js';
import { renderDevicesPanel } from '../views/devicesView.js';
import { renderWebhooksPanel } from '../views/webhooksView.js';
import { renderAdminSyncLogsPanel } from '../views/syncLogsView.js';
import { renderUsersPanel } from '../views/usersView.js';
import { renderAllVaultsPanel } from '../views/allVaultsView.js';
import { renderDatabasePanel } from '../views/databaseView.js';
import { renderSponsorPanel } from '../views/sponsorView.js';

let isBootstrap = false;

export async function checkAuthStatus() {
  fetchServerVersion();
  try {
    const res = await fetch(state.serverBase.replace(/\/$/, '') + '/api/auth/status');
    if (res.ok) {
      const body = await res.json();
      isBootstrap = !body.hasUsers;
      const sub = $('#login-form .subtitle');
      const btn = $('#login-form button[type="submit"]');
      if (isBootstrap) {
        if (sub) sub.textContent = '首次启动 · 创建管理员账号';
        if (btn) btn.textContent = '创建管理员并登录';
      } else {
        if (sub) sub.textContent = 'Obsidian 高速实时同步服务 · 管理后台';
        if (btn) btn.textContent = '登录';
      }
      const hintBadge = $('#login-hint-badge-box') || $('.login-hint-badge');
      if (hintBadge) {
        hintBadge.style.display = body.isDefaultAdminPassword ? 'flex' : 'none';
      }
    }
  } catch (err) {
    console.warn('[Nimbus] Failed to check auth status on serverBase:', state.serverBase, err);
    if (state.serverBase !== window.location.origin) {
      state.serverBase = window.location.origin;
      checkAuthStatus();
    }
  }
}

export function fillAdminCredentials() {
  const userInp = $('#login-username');
  const passInp = $('#login-password');
  if (userInp) userInp.value = 'admin';
  if (passInp) passInp.value = 'admin123';
}

export function initAuthForm() {
  const loginForm = $('#login-form');
  if (!loginForm) return;

  const quickFillBtn = $('#btn-quick-fill-admin');
  if (quickFillBtn) {
    quickFillBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fillAdminCredentials();
    });
  }

  const defaultHint = $('#login-default-hint');
  if (defaultHint) {
    defaultHint.addEventListener('click', (e) => {
      e.preventDefault();
      fillAdminCredentials();
    });
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const serverInput = $('#login-server')?.value?.trim() || '';
    state.serverBase = normalizeServerUrl(serverInput);
    const username = $('#login-username')?.value?.trim() || '';
    const password = $('#login-password')?.value || '';
    const errorEl = $('#login-error');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    const submitBtn = $('#login-form button[type="submit"]');
    const originalBtnText = submitBtn ? submitBtn.textContent : '登录';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '正在连接...';
    }

    const endpoint = isBootstrap ? '/api/auth/register' : '/api/auth/login';
    try {
      const res = await fetch(state.serverBase.replace(/\/$/, '') + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || (isBootstrap ? '注册失败' : '账号或密码不正确'));
      state.token = body.token;
      state.user = body.user;
      localStorage.setItem('nimbus_server', state.serverBase);
      localStorage.setItem('nimbus_token', state.token);
      localStorage.setItem('nimbus_user', JSON.stringify(state.user));
      enterApp();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || '网络连接失败，请检查服务器地址';
        errorEl.style.display = 'block';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
      }
    }
  });

  const logoutBtn = $('#logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const ok = await showConfirm({
        title: '退出登录确认',
        message: `确定要退出登录当前账号「${state.user?.username || '当前用户'}」吗？退出后需重新输入密码登录。`,
        confirmText: '退出登录',
        cancelText: '取消',
        type: 'danger',
        icon: '🚪',
      });
      if (!ok) return;
      localStorage.removeItem('nimbus_token');
      localStorage.removeItem('nimbus_user');
      state.token = '';
      state.user = null;
      location.reload();
    });
  }
}

export async function enterApp() {
  fetchServerVersion();
  const loginView = $('#login-view');
  const appView = $('#app-view');
  if (loginView) loginView.classList.add('hidden');
  if (appView) appView.classList.remove('hidden');

  initThemeSwitcher();
  initFontSizeSwitcher();
  updateDateDisplays();

  if (state.user) {
    const userElem = $('#who-username');
    if (userElem) userElem.textContent = state.user.username;
    const roleText = state.user.role === 'admin'
      ? (window.t ? window.t('topbar.role_admin', '管理员') : '管理员')
      : (window.t ? window.t('topbar.role_user', '普通用户') : '普通用户');
    const roleElem = $('#who-role');
    if (roleElem) roleElem.textContent = roleText;
    if (state.user.role === 'admin') {
      const adminNav = $('#admin-nav');
      if (adminNav) adminNav.classList.remove('hidden');
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => showTab(btn.dataset.tab);
  });

  const settingsBtn = $('#global-settings-btn');
  if (settingsBtn) settingsBtn.onclick = () => showTab('settings');

  const dashboardBtn = $('#global-dashboard-btn');
  if (dashboardBtn) dashboardBtn.onclick = () => showTab('dashboard');

  const brandBtn = $('#brand-logo-btn');
  if (brandBtn) brandBtn.onclick = () => showTab('dashboard');

  const connectBtn = $('#global-connect-btn');
  if (connectBtn) {
    connectBtn.onclick = () => {
      const currentVault = state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0];
      showObsidianConnectModal(currentVault);
    };
  }

  const mcpBtn = $('#global-mcp-btn');
  if (mcpBtn) {
    mcpBtn.onclick = () => {
      const currentVault = state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0];
      showMcpModal(currentVault ? currentVault.name : 'Default');
    };
  }

  const docsBtn = $('#global-docs-btn');
  if (docsBtn) docsBtn.onclick = () => showDocsModal();

  const newVaultBtn = $('#new-vault-btn');
  if (newVaultBtn) {
    newVaultBtn.onclick = async () => {
      const name = await showPrompt({
        title: '📁 创建新 Vault 笔记库',
        message: '请输入新笔记库名称（例如：MyNotes 或 WorkVault）：',
        placeholder: 'MyNotes',
        icon: '📁',
        confirmText: '确认创建',
      });
      if (!name || !name.trim()) return;
      try {
        const res = await api('/api/vaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        const body = await res.json();
        await loadVaults();
        if (body.vault) openVault(body.vault.id);
      } catch (err) {
        console.error('[Nimbus] Failed to create vault:', err);
      }
    };
  }

  setupGlobalSearch();
  setupCollapsibleSections();
  initMobileNavigation();

  await loadVaults();

  // 🛡️ 高危安全防线：检测到管理员正在使用弱默认密码时展示全屏显式安全通告栏
  const existingAlert = $('#admin-security-alert-bar');
  if (existingAlert) existingAlert.remove();

  if (state.user && state.user.role === 'admin' && state.user.isDefaultAdminPassword) {
    const alertBar = document.createElement('div');
    alertBar.id = 'admin-security-alert-bar';
    alertBar.style.cssText = 'background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5; padding: 10px 16px; border-radius: 8px; margin: 12px 16px 0 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; font-weight: 500;';
    alertBar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 18px;">⚠️</span>
        <span><strong>安全警报：</strong>当前管理员账户正使用初始默认密码 (admin123)，极易遭受公网未授权访问与接管！请立即前往系统设置修改密码。</span>
      </div>
      <button type="button" id="btn-fix-admin-password" style="background: #ef4444; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;">
        立即修改密码
      </button>
    `;
    const appView = $('#app-view');
    const topbar = appView?.querySelector('.topbar');
    if (topbar && topbar.nextSibling) {
      topbar.parentNode.insertBefore(alertBar, topbar.nextSibling);
    } else if (appView) {
      appView.prepend(alertBar);
    }
    const fixBtn = alertBar.querySelector('#btn-fix-admin-password');
    if (fixBtn) {
      fixBtn.onclick = () => showTab('settings');
    }
  }
}

export function closeMobileSidebar() {
  const sidebar = $('#sidebar') || $('.sidebar');
  const backdrop = $('#sidebar-backdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('active');
  document.body.classList.remove('sidebar-open');
}

export function toggleMobileSidebar() {
  const sidebar = $('#sidebar') || $('.sidebar');
  const backdrop = $('#sidebar-backdrop');
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle('open');
  if (backdrop) backdrop.classList.toggle('active', isOpen);
  document.body.classList.toggle('sidebar-open', isOpen);
}

export function initMobileNavigation() {
  const toggleBtn = $('#sidebar-toggle-btn');
  const backdrop = $('#sidebar-backdrop');

  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMobileSidebar();
    };
  }

  if (backdrop) {
    backdrop.onclick = () => {
      closeMobileSidebar();
    };
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSidebar();
  });

  document.querySelectorAll('.tab-btn, .nav-item, #new-vault-btn, .sidebar-github-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeMobileSidebar();
    });
  });
}

export function setupCollapsibleSections() {
  function setupToggle(headerId, targetMenuId, storageKey, defaultCollapsed = false) {
    const header = document.getElementById(headerId);
    const menu = document.getElementById(targetMenuId);
    if (!header || !menu) return;

    const isCollapsed = localStorage.getItem(storageKey) !== null
      ? localStorage.getItem(storageKey) === 'true'
      : defaultCollapsed;

    if (isCollapsed) {
      header.classList.add('collapsed');
      menu.classList.add('collapsed');
    } else {
      header.classList.remove('collapsed');
      menu.classList.remove('collapsed');
    }

    header.onclick = (e) => {
      e.preventDefault();
      const collapsed = header.classList.toggle('collapsed');
      menu.classList.toggle('collapsed', collapsed);
      localStorage.setItem(storageKey, collapsed ? 'true' : 'false');
    };

    header.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    };
  }

  setupToggle('section-tools-header', 'tools-nav-menu', 'nimbus_sidebar_collapsed_tools', false);
  setupToggle('section-admin-header', 'admin-nav-menu', 'nimbus_sidebar_collapsed_admin', false);
}

export async function loadVaults() {
  try {
    const res = await api('/api/vaults');
    const body = await res.json();
    state.vaults = body.vaults || [];
    renderVaultList();
    if (!state.activeVaultId) {
      showTab('dashboard');
    }
  } catch (err) {
    console.error('[Nimbus] Failed to load vaults:', err);
  }
}

export function renderVaultList() {
  const ul = $('#vault-list');
  if (!ul) return;
  ul.innerHTML = '';
  const isAdmin = state.user?.role === 'admin';

  for (const v of state.vaults) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'vault-item' + (state.activeVaultId === v.id ? ' active' : '');
    const tag = v.isOwner ? '' : v.myPermission === 'read-only' ? ' <span style="font-size:10px;opacity:0.75;padding:1px 4px;border-radius:3px;background:rgba(230,126,34,0.2);color:#e67e22;">只读</span>' : ' <span style="font-size:10px;opacity:0.75;padding:1px 4px;border-radius:3px;background:rgba(46,204,113,0.2);color:#2ecc71;">协作</span>';
    btn.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📓 ${escapeHtml(v.name)}${tag}</span>`;
    btn.addEventListener('click', () => openVault(v.id));

    if (v.isOwner || isAdmin) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除 vault';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await showConfirm({
          title: '删除 Vault 笔记库',
          message: `确定删除 Vault「${v.name}」？服务器上的笔记数据不会自动清除，仅在当前账户中取消关联。`,
          confirmText: '确认删除',
          type: 'danger',
          icon: '🗑️',
        });
        if (!ok) return;
        try {
          await api(`/api/vaults/${v.id}`, { method: 'DELETE' });
          if (state.activeVaultId === v.id) {
            state.activeVaultId = null;
            showTab('dashboard');
          }
          loadVaults();
        } catch (err) {
          console.error('[Nimbus] Failed to delete vault:', err);
        }
      });
      btn.appendChild(del);
    }
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

export function showTab(tab) {
  if (window.innerWidth <= 768) closeMobileSidebar();
  state.activeVaultId = null;
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  const adminSpecificTabs = ['database', 'webhooks', 'synclogs', 'users', 'all-vaults'];
  if (adminSpecificTabs.includes(tab)) {
    const adminHeader = document.getElementById('section-admin-header');
    const adminMenu = document.getElementById('admin-nav-menu');
    if (adminHeader && adminHeader.classList.contains('collapsed')) {
      adminHeader.classList.remove('collapsed');
      if (adminMenu) adminMenu.classList.remove('collapsed');
      localStorage.setItem('nimbus_sidebar_collapsed_admin', 'false');
    }
  }

  const globalSettingsBtn = $('#global-settings-btn');
  if (globalSettingsBtn) globalSettingsBtn.classList.toggle('active', tab === 'settings');

  const globalDashboardBtn = $('#global-dashboard-btn');
  if (globalDashboardBtn) globalDashboardBtn.classList.toggle('active', tab === 'dashboard');

  renderVaultList();
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;

  if (tab === 'dashboard') renderDashboardPanel(mainPanel, { openVault, showTab, setAppVersion });
  else if (tab === 'settings') renderSettingsPanel(null, mainPanel);
  else if (tab === 'database') renderDatabasePanel();
  else if (tab === 'webhooks') renderWebhooksPanel(mainPanel);
  else if (tab === 'devices') renderDevicesPanel(mainPanel);
  else if (tab === 'synclogs') renderAdminSyncLogsPanel(mainPanel);
  else if (tab === 'users') renderUsersPanel(mainPanel);
  else if (tab === 'all-vaults') renderAllVaultsPanel(mainPanel, { openVault });
  else if (tab === 'sponsor') renderSponsorPanel();
}

export function initLanguageDropdowns() {
  const langBtn = $('#lang-menu-btn');
  const langMenu = $('#lang-dropdown-menu');
  if (langBtn && langMenu) {
    langBtn.onclick = (e) => {
      e.stopPropagation();
      langMenu.classList.toggle('hidden');
      const themeMenu = $('#theme-dropdown-menu');
      if (themeMenu) themeMenu.classList.add('hidden');
      const fontMenu = $('#fontsize-dropdown-menu');
      if (fontMenu) fontMenu.classList.add('hidden');
    };

    document.querySelectorAll('#lang-dropdown-menu .lang-opt-item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        const val = item.dataset.langVal;
        if (window.i18n) window.i18n.setLanguage(val);
        langMenu.classList.add('hidden');
      };
    });
  }

  const loginLangBtn = $('#login-lang-btn');
  const loginLangMenu = $('#login-lang-dropdown');
  if (loginLangBtn && loginLangMenu) {
    loginLangBtn.onclick = (e) => {
      e.stopPropagation();
      loginLangMenu.classList.toggle('hidden');
      const loginFontMenu = $('#login-fontsize-dropdown');
      if (loginFontMenu) loginFontMenu.classList.add('hidden');
    };

    document.querySelectorAll('#login-lang-dropdown .lang-opt-item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        const val = item.dataset.langVal;
        if (window.i18n) window.i18n.setLanguage(val);
        loginLangMenu.classList.add('hidden');
      };
    });
  }

  document.addEventListener('click', (e) => {
    if (langMenu && !langMenu.contains(e.target) && e.target !== langBtn) {
      langMenu.classList.add('hidden');
    }
    if (loginLangMenu && !loginLangMenu.contains(e.target) && e.target !== loginLangBtn) {
      loginLangMenu.classList.add('hidden');
    }
  });

  window.addEventListener('languageChanged', () => {
    updateThemeUI();
    updateFontSizeUI();
    updateDateDisplays();
    if (state.user) {
      const roleText = state.user.role === 'admin'
        ? (window.t ? window.t('topbar.role_admin', '管理员') : '管理员')
        : (window.t ? window.t('topbar.role_user', '普通用户') : '普通用户');
      const roleElem = $('#who-role');
      if (roleElem) roleElem.textContent = roleText;
    }
    renderVaultList();
    if (state.activeVaultId) {
      renderVaultContainer(state.activeVaultId);
    } else if (state.activeTab) {
      showTab(state.activeTab);
    }
  });
}
