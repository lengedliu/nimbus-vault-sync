// --------------------------- View: Devices & Connected Clients ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm } from '../core/dialogs.js';

export async function renderDevicesPanel(containerEl = null) {
  const container = containerEl || $('#main-panel');
  if (!container) return;

  container.innerHTML = '<div class="empty-state">正在加载全网接入设备列表…</div>';

  try {
    const res = await api('/api/devices');
    const data = await res.json();
    const devices = data.devices || [];

    container.innerHTML = `
      <div class="devices-container" style="max-width:960px;margin:0 auto;padding:16px 20px;">
        <div class="devices-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:8px;">
              <span>📱</span>
              <span>接入设备与多端管理</span>
            </h2>
            <p style="margin:0;font-size:13px;color:var(--muted)">
              监控当前已连接的 Obsidian 桌面端、移动端及自动化同步服务，支持远程吊销授权
            </p>
          </div>
          <button class="secondary" id="btn-refresh-devices" style="padding:6px 14px;font-size:12.5px;">🔄 刷新状态</button>
        </div>

        <div class="devices-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:16px;">
          ${
            devices.length > 0
              ? devices
                  .map((d) => {
                    const isOnline = Date.now() - new Date(d.lastSeenAt || 0).getTime() < 5 * 60 * 1000;
                    const platformIcon = (d.platform || '').toLowerCase().includes('ios') || (d.platform || '').toLowerCase().includes('iphone')
                      ? '📱'
                      : (d.platform || '').toLowerCase().includes('android')
                      ? '🤖'
                      : (d.platform || '').toLowerCase().includes('mac')
                      ? '💻'
                      : '🖥️';

                    return `
                      <div class="device-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:16px;position:relative;display:flex;flex-direction:column;justify-content:space-between;">
                        <div>
                          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                            <span style="font-size:22px;">${platformIcon}</span>
                            <span class="badge" style="font-size:11px;padding:2px 8px;border-radius:10px;background:${isOnline ? 'rgba(63,185,80,0.15)' : 'rgba(139,148,158,0.15)'};color:${isOnline ? '#3fb950' : 'var(--muted)'};">
                              ${isOnline ? '● 在线活跃' : '○ 离线'}
                            </span>
                          </div>
                          <h4 style="margin:0 0 4px;font-size:14.5px;color:var(--text);">${escapeHtml(d.name || 'Obsidian Client')}</h4>
                          <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">
                            <div>所属用户: <strong style="color:var(--text);">${escapeHtml(d.username || state.user?.username || 'user')}</strong></div>
                            <div>最近 IP: <span style="font-family:monospace;">${escapeHtml(d.ip || '127.0.0.1')}</span></div>
                            <div>同步版本: ${escapeHtml(d.clientVersion || 'v1.3.0')}</div>
                          </div>
                        </div>

                        <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
                          <span style="font-size:11px;color:var(--muted);">最后活跃: ${new Date(d.lastSeenAt || Date.now()).toLocaleDateString()}</span>
                          <button class="secondary btn-revoke-device" data-id="${escapeHtml(d.id)}" style="color:var(--danger);border-color:var(--danger);padding:3px 8px;font-size:11.5px;">吊销权限</button>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
              : `
              <div class="empty-state" style="grid-column:1/-1;padding:48px 16px;">
                <div style="font-size:36px;margin-bottom:8px;">📱</div>
                <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">暂无连接的设备</div>
                <div style="font-size:12px;color:var(--muted);">在 Obsidian 插件中配置服务器地址即可完成初次握手并展示于此处</div>
              </div>
            `
          }
        </div>
      </div>
    `;

    container.querySelector('#btn-refresh-devices')?.addEventListener('click', () => {
      renderDevicesPanel(container);
    });

    container.querySelectorAll('.btn-revoke-device').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const ok = await showConfirm({
          title: '吊销设备凭证',
          message: '确定吊销该设备的访问令牌吗？吊销后该设备必须重新扫描授权才能同步。',
          confirmText: '确认吊销',
          type: 'danger',
        });
        if (!ok) return;
        try {
          const r = await api(`/api/devices/${id}`, { method: 'DELETE' });
          const resBody = await r.json();
          if (resBody.ok) {
            toast('设备已成功断开并吊销凭证');
            renderDevicesPanel(container);
          } else {
            toast('吊销失败: ' + (resBody.error || '未知错误'));
          }
        } catch (err) {
          toast('操作失败: ' + err.message);
        }
      };
    });

    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载设备列表失败: ${escapeHtml(err.message)}</div>`;
  }
}
