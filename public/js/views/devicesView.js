// --------------------------- Devices Management Panel ---------------------------
import { $, escapeHtml, translate, state } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';
import { showObsidianConnectModal } from './connectModal.js';

export async function renderDevicesPanel() {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">加载接入设备列表中…</div>';
  try {
    const res = await api('/api/devices');
    const data = await res.json();
    const devices = data.devices || [];
    const isAdmin = state.user?.role === 'admin';
    const onlineCount = devices.filter((d) => d.isOnline).length;

    mainPanel.innerHTML = `
      <div class="panel-header" style="margin-bottom:16px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px;">
            <span>📱</span>
            <span>接入设备与多端令牌管理</span>
            <span class="badge ${onlineCount > 0 ? 'success' : 'primary'}" style="font-size:11.5px;font-weight:600;">
              ${onlineCount} 台在线 / 共 ${devices.length} 台设备
            </span>
          </h2>
          <div style="font-size:13px;color:var(--muted)">
            监控与管理连接至 Obsidian Nimbus 同步服务的客户端设备、在线状态、专用授权 Token 及最后活动记录
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-primary" id="add-device-btn">➕ 生成新设备令牌</button>
          <button class="secondary" id="refresh-devices-btn">🔄 刷新列表</button>
        </div>
      </div>

      <div id="devices-list-grid" class="devices-grid"></div>
    `;

    mainPanel.querySelector('#refresh-devices-btn').onclick = () => renderDevicesPanel();
    mainPanel.querySelector('#add-device-btn').onclick = () => openCreateDeviceModal();

    const grid = mainPanel.querySelector('#devices-list-grid');
    if (devices.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 16px;">
          <div style="font-size:40px;margin-bottom:10px;">📱</div>
          <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:4px;">暂无登记的客户端设备</div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">点击下方按钮为您的终端快速生成连接令牌与同步配置</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button class="secondary quick-seed-btn" data-name="MacBook Pro" data-plat="macos">🍏 添加 Mac 设备</button>
            <button class="secondary quick-seed-btn" data-name="Windows 台式机" data-plat="windows">🪟 添加 Windows 设备</button>
            <button class="secondary quick-seed-btn" data-name="iPhone" data-plat="ios">🍎 添加 iPhone 设备</button>
            <button class="secondary quick-seed-btn" data-name="Android 手机" data-plat="android">🤖 添加 Android 设备</button>
            <button class="secondary quick-seed-btn" data-name="应用客户端" data-plat="app">📦 添加应用终端</button>
          </div>
        </div>
      `;

      grid.querySelectorAll('.quick-seed-btn').forEach((b) => {
        b.onclick = async () => {
          try {
            const res = await api('/api/devices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: b.dataset.name, platform: b.dataset.plat }),
            });
            const body = await res.json();
            toast(`已快速添加 ${b.dataset.name}`);
            renderDevicesPanel();
            if (body.device) {
              showDeviceTokenCreatedModal(body.device);
            }
          } catch (e) {
            toast('添加失败: ' + e.message);
          }
        };
      });
      translate(mainPanel);
      return;
    }

    for (const dev of devices) {
      const card = document.createElement('div');
      card.className = `device-card ${dev.isOnline ? 'online' : ''}`;
      
      const platform = (dev.platform || '').toLowerCase();
      const platformIcon = platform.includes('ios') ? '🍎' : platform.includes('android') ? '🤖' : platform.includes('win') ? '🪟' : platform.includes('mac') ? '🍏' : platform.includes('linux') ? '🐧' : (platform.includes('app') || platform.includes('应用')) ? '📦' : '💻';
      const lastActiveText = dev.lastActiveAt ? new Date(dev.lastActiveAt).toLocaleString() : '刚刚活跃';
      const devName = dev.name || dev.deviceName || dev.deviceId || 'Obsidian Client';

      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
            <span style="font-size:26px;flex-shrink:0;">${platformIcon}</span>
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;font-size:14.5px;color:var(--text);display:flex;align-items:center;gap:6px;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="${escapeHtml(devName)}">${escapeHtml(devName)}</span>
                ${dev.isOnline ? '<span class="badge success" style="font-size:10.5px;white-space:nowrap;flex-shrink:0;">🟢 在线活跃</span>' : '<span class="badge" style="font-size:10.5px;color:var(--muted);white-space:nowrap;flex-shrink:0;">⚪ 离线就绪</span>'}
              </div>
              <div style="font-size:11.5px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                设备 ID: <code>${escapeHtml(dev.id || dev.deviceId)}</code>
              </div>
            </div>
          </div>
          ${isAdmin && dev.username ? `<span class="badge primary" style="font-size:10.5px;white-space:nowrap;flex-shrink:0;">👤 ${escapeHtml(dev.username)}</span>` : ''}
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-size:12.5px;margin-bottom:14px;display:flex;flex-direction:column;gap:7px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="color:var(--muted);white-space:nowrap;flex-shrink:0;">最后同步活跃:</span>
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;" title="${lastActiveText}">${lastActiveText}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="color:var(--muted);white-space:nowrap;flex-shrink:0;">客户端 IP:</span>
            <code style="font-size:11.5px;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;text-align:right;" title="${escapeHtml(dev.lastIp || dev.clientIp || '127.0.0.1')}">${escapeHtml(dev.lastIp || dev.clientIp || '127.0.0.1')}</code>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="color:var(--muted);white-space:nowrap;flex-shrink:0;">专属 Token:</span>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap;">
              <code style="font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap;">${escapeHtml(dev.tokenPreview || (dev.token ? dev.token.slice(0, 10) + '...' : '••••••••••••'))}</code>
              <button class="secondary copy-token-btn" style="padding:2px 8px;font-size:11px;white-space:nowrap;flex-shrink:0;cursor:pointer;">📋 复制 Token</button>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <button class="secondary get-config-btn" style="font-size:12px;padding:6px 10px;flex:1;white-space:nowrap;cursor:pointer;">⚡ 查看连接配置</button>
          <button class="danger revoke-dev-btn" data-id="${dev.id || dev.deviceId}" style="font-size:12px;padding:6px 12px;white-space:nowrap;flex-shrink:0;cursor:pointer;">🚫 撤销令牌</button>
        </div>
      `;

      card.querySelector('.copy-token-btn')?.addEventListener('click', () => {
        const t = dev.token || state.token;
        if (t) {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(t).then(() => toast('✓ 设备专属 Token 已复制到剪贴板！'));
          } else {
            prompt('复制设备 Token：', t);
          }
        } else {
          toast('当前设备未记录原始明文');
        }
      });

      card.querySelector('.get-config-btn')?.addEventListener('click', () => {
        const currentVault = state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0];
        showObsidianConnectModal(currentVault?.id || '', dev.token, devName);
      });

      card.querySelector('.revoke-dev-btn')?.addEventListener('click', async () => {
        const ok = await showConfirm({
          title: '撤销设备访问授权',
          message: `确定撤销设备「${devName}」的访问授权吗？该设备将被立即踢下线并停止同步。`,
          confirmText: '撤销授权',
          type: 'danger',
          icon: '💻',
        });
        if (!ok) return;
        try {
          await api(`/api/devices/${dev.id || dev.deviceId}`, { method: 'DELETE' });
          toast('设备授权已撤销');
          renderDevicesPanel();
        } catch (e) {
          toast('操作失败: ' + e.message);
        }
      });

      grid.appendChild(card);
    }
    translate(mainPanel);
  } catch (err) {
    if (mainPanel) {
      mainPanel.innerHTML = `<div class="empty-state" style="color:#e74c3c;">加载设备管理失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}

export function showDeviceTokenCreatedModal(device, vault) {
  const currentVault = vault || state.vaults.find((v) => v.id === state.activeVaultId) || state.vaults[0];
  const serverUrl = state.serverBase.replace(/\/$/, '');
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  const vaultId = currentVault ? currentVault.id : 'YOUR_VAULT_ID';
  const vaultName = currentVault ? currentVault.name : 'Vault';
  const deviceName = device.deviceName || device.name || 'Obsidian Device';
  const token = device.token || state.token;

  const pluginConfig = {
    serverUrl,
    wsUrl: `${wsUrl}?vaultId=${vaultId}&token=${token}&deviceId=${encodeURIComponent(deviceName)}`,
    vaultId,
    vaultName,
    token,
    authToken: token,
    deviceName,
    autoSyncOnStartup: true,
  };

  const platform = (device.platform || '').toLowerCase();
  const platformIcon = platform.includes('ios') ? '🍎' : platform.includes('android') ? '🤖' : platform.includes('win') ? '🪟' : platform.includes('mac') ? '🍏' : platform.includes('linux') ? '🐧' : (platform.includes('app') || platform.includes('应用')) ? '📦' : '💻';

  const html = `
    <div class="modal-header">
      <h3 style="display:flex;align-items:center;gap:8px;">
        <span>🎉</span>
        <span>设备「${escapeHtml(deviceName)}」令牌生成成功</span>
      </h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <div style="background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:var(--radius);padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">${platformIcon}</span>
        <div>
          <div style="font-weight:600;font-size:14px;color:var(--text)">
            已成功为 <b>${escapeHtml(deviceName)}</b> 签发专属独立访问令牌！
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">
            设备 ID: <code>${escapeHtml(device.id || device.deviceId)}</code> · 平台: <b>${escapeHtml(device.platform || '通用')}</b>
          </div>
        </div>
      </div>

      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--text);">🔑 专属访问令牌 (Auth Token)</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="password" id="dev-modal-token-input" readonly value="${escapeHtml(token)}" style="margin:0;padding:6px 10px;font-size:12px;font-family:ui-monospace,monospace;flex:1;background:var(--bg);" />
          <button id="dev-modal-token-toggle-btn" class="token-act-btn secondary" style="padding:6px 10px;font-size:12px;">👁️ 查看</button>
          <button id="dev-modal-token-copy-btn" class="btn-primary" style="padding:6px 12px;font-size:12px;">📋 复制 Token</button>
        </div>
      </div>

      <div class="nav-section-title" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span>⚡ Obsidian 插件一键配置文件 (<code>data.json</code>)</span>
        <span style="font-size:11.5px;color:var(--muted)">直接复制覆盖至 <code>.obsidian/plugins/nimbus/data.json</code></span>
      </div>
      <pre id="dev-modal-json-snippet" class="code-snippet" style="max-height:180px;font-size:12px;">${escapeHtml(JSON.stringify(pluginConfig, null, 2))}</pre>

      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6;">
        <b>📱 移动端与客户端配置提示：</b><br/>
        • <b>桌面端</b>：复制上方 JSON 配置文件，保存至对应笔记库的 <code>.obsidian/plugins/nimbus/data.json</code> 文件中重启插件即可。<br/>
        • <b>手机/平板 (iOS / Android)</b>：在 Obsidian 设置中的 Nimbus 插件界面填入 <b>Server URL</b> (<code>${escapeHtml(serverUrl)}</code>)、<b>Vault ID</b> (<code>${escapeHtml(vaultId)}</code>) 与上方 <b>Token</b>。<br/>
        • <b>应用终端 (App / 扩展)</b>：可直接将专属 Token 填入第三方应用、客户端或脚本的 Bearer 鉴权中。
      </div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border);">
      <button id="dev-modal-copy-all-btn" class="btn-primary">📋 一键复制完整 data.json 配置</button>
      <button class="modal-close secondary">完成</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const tokenInput = dialog.querySelector('#dev-modal-token-input');
    const toggleBtn = dialog.querySelector('#dev-modal-token-toggle-btn');
    const copyTokenBtn = dialog.querySelector('#dev-modal-token-copy-btn');
    const copyAllBtn = dialog.querySelector('#dev-modal-copy-all-btn');

    toggleBtn.onclick = () => {
      if (tokenInput.type === 'password') {
        tokenInput.type = 'text';
        toggleBtn.textContent = '🙈 隐藏';
      } else {
        tokenInput.type = 'password';
        toggleBtn.textContent = '👁️ 查看';
      }
    };

    copyTokenBtn.onclick = () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(token).then(() => toast('✓ 专属 Token 已复制到剪贴板！'));
      } else {
        prompt('复制 Token：', token);
      }
    };

    copyAllBtn.onclick = () => {
      const text = JSON.stringify(pluginConfig, null, 2);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('✓ data.json 连接配置已复制到剪贴板！'));
      } else {
        prompt('复制以下配置：', text);
      }
    };
  });
}

export function openCreateDeviceModal() {
  const modalHtml = `
    <div class="modal-header">
      <h3>➕ 生成新设备独立授权令牌</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px;">
        为每个终端（例如办公室电脑、个人笔记本、手机、第三方应用）分配独立的连接令牌，可随时单独撤销或审计活动状态。
      </p>

      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--muted);align-self:center;margin-right:2px;">快捷预设:</span>
        <button class="secondary preset-btn" data-name="MacBook Pro" data-plat="macos" style="padding:2px 8px;font-size:11.5px;">🍏 MacBook</button>
        <button class="secondary preset-btn" data-name="Windows 台式机" data-plat="windows" style="padding:2px 8px;font-size:11.5px;">🪟 Windows PC</button>
        <button class="secondary preset-btn" data-name="iPhone 15" data-plat="ios" style="padding:2px 8px;font-size:11.5px;">🍎 iPhone</button>
        <button class="secondary preset-btn" data-name="Android 手机" data-plat="android" style="padding:2px 8px;font-size:11.5px;">🤖 Android</button>
        <button class="secondary preset-btn" data-name="Linux 工作站" data-plat="linux" style="padding:2px 8px;font-size:11.5px;">🐧 Linux</button>
        <button class="secondary preset-btn" data-name="应用客户端" data-plat="app" style="padding:2px 8px;font-size:11.5px;">📦 应用</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;">
        <label>设备名称 / 备注 (例如: MacBook Pro M3, 办公台式机, iPhone 15, 同步应用)
          <input type="text" id="nd-name" placeholder="请输入设备或应用名称" />
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <label>终端平台类型
            <select id="nd-platform">
              <option value="macos">🍏 macOS</option>
              <option value="windows">🪟 Windows</option>
              <option value="linux">🐧 Linux</option>
              <option value="ios">🍎 iOS (iPhone / iPad)</option>
              <option value="android">🤖 Android</option>
              <option value="app">📦 应用</option>
            </select>
          </label>
          <label>令牌有效期
            <select id="nd-expiry">
              <option value="365" selected>1 年 (推荐)</option>
              <option value="3650">永久有效 (10 年)</option>
              <option value="90">90 天</option>
              <option value="30">30 天</option>
            </select>
          </label>
        </div>
      </div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border);">
      <button class="secondary modal-close">取消</button>
      <button class="btn-primary" id="nd-submit-btn">立即生成令牌</button>
    </div>
  `;

  showModal(modalHtml, (container) => {
    container.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.onclick = () => {
        container.querySelector('#nd-name').value = btn.dataset.name;
        container.querySelector('#nd-platform').value = btn.dataset.plat;
      };
    });

    container.querySelector('#nd-submit-btn').onclick = async () => {
      const name = container.querySelector('#nd-name').value.trim();
      const platform = container.querySelector('#nd-platform').value;
      const expiresInDays = container.querySelector('#nd-expiry')?.value || '365';
      if (!name) {
        toast('请输入设备名称');
        return;
      }

      try {
        const res = await api('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, deviceName: name, platform, expiresInDays }),
        });
        const body = await res.json();
        closeModal();
        toast(`已成功为 ${name} 生成独立令牌！`);
        renderDevicesPanel();
        if (body.device) {
          showDeviceTokenCreatedModal(body.device);
        }
      } catch (e) {
        toast('生成失败: ' + e.message);
      }
    };
  });
}
