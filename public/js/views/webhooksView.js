// --------------------------- Webhooks Management Panel ---------------------------
import { $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';

export async function renderWebhooksPanel() {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">加载 Webhook 配置中…</div>';
  try {
    const res = await api('/api/settings/webhooks');
    const data = await res.json();
    const config = data.config || data.webhooks || {
      enabled: false,
      platform: 'custom',
      url: '',
      secret: '',
      events: ['conflict.detected', 'conflict.resolved', 'backup.created'],
    };

    mainPanel.innerHTML = `
      <div class="panel-header" style="margin-bottom:16px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px;">
            <span>🔔</span>
            <span>Webhook 告警与实时第三方推送</span>
          </h2>
          <div style="font-size:13px;color:var(--muted)">
            当多端发生并发冲突、全库快照备份完成、新设备上线或文件变动时，实时推送告警消息至飞书、钉钉、企业微信、Discord 或自定义 HTTP 终端
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="secondary" id="wh-test-btn">🧪 发送测试通知</button>
          <button class="btn-primary" id="wh-save-btn">💾 保存 Webhook 配置</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:20px;">
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;">
          <h3 style="margin:0 0 16px;font-size:15px;display:flex;align-items:center;gap:8px;">
            <span>⚙️</span> Webhook 推送端点配置
          </h3>

          <div style="display:flex;flex-direction:column;gap:14px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin:0;">
              <input type="checkbox" id="wh-enabled" ${config.enabled ? 'checked' : ''} style="width:auto;margin:0;" />
              <span style="font-weight:600;font-size:13.5px;">启用 Webhook 告警通知功能</span>
            </label>

            <label>
              <span style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">推送目标平台</span>
              <select id="wh-platform" style="margin:0;">
                <option value="feishu" ${config.platform === 'feishu' ? 'selected' : ''}>🕊️ 飞书群机器人 (Feishu Webhook)</option>
                <option value="dingtalk" ${config.platform === 'dingtalk' ? 'selected' : ''}>🎯 钉钉自定义机器人 (DingTalk Webhook)</option>
                <option value="wecom" ${config.platform === 'wecom' ? 'selected' : ''}>💬 企业微信群机器人 (WeCom Webhook)</option>
                <option value="discord" ${config.platform === 'discord' ? 'selected' : ''}>🎮 Discord Webhook</option>
                <option value="custom" ${config.platform === 'custom' ? 'selected' : ''}>🌐 自定义 HTTP POST JSON 终端</option>
              </select>
            </label>

            <label>
              <span style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">Webhook 回调 URL 地址</span>
              <input type="text" id="wh-url" value="${escapeHtml(config.url || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" style="margin:0;" />
              <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">接收 Nimbus 发送 POST 请求的完整 Webhook 链接</div>
            </label>

            <label>
              <span style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">签名校验密钥 (Secret / 签名密钥, 可选)</span>
              <input type="password" id="wh-secret" value="${escapeHtml(config.secret || '')}" placeholder="若机器人启用了安全加签校验请输入" style="margin:0;" />
            </label>
          </div>
        </div>

        <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;">
          <h3 style="margin:0 0 16px;font-size:15px;display:flex;align-items:center;gap:8px;">
            <span>📡</span> 订阅触发事件 (Event Subscriptions)
          </h3>

          <div style="display:flex;flex-direction:column;gap:12px;" id="wh-events-container">
            <label class="form-checkbox-label" style="display:flex;align-items:flex-start;gap:10px;margin:0;cursor:pointer;">
              <input type="checkbox" class="wh-event-chk" value="conflict.detected" ${config.events?.includes('conflict.detected') ? 'checked' : ''} />
              <div>
                <div style="font-weight:500;font-size:13px;">⚔️ conflict.detected (检测到多设备并发冲突)</div>
                <div style="font-size:11.5px;color:var(--muted)">当两台设备同时编辑同一笔记并在同步中产生冲突副本时触发</div>
              </div>
            </label>

            <label class="form-checkbox-label" style="display:flex;align-items:flex-start;gap:10px;margin:0;cursor:pointer;">
              <input type="checkbox" class="wh-event-chk" value="conflict.resolved" ${config.events?.includes('conflict.resolved') ? 'checked' : ''} />
              <div>
                <div style="font-weight:500;font-size:13px;">✓ conflict.resolved (冲突已成功解决)</div>
                <div style="font-size:11.5px;color:var(--muted)">当管理员或用户在控制台手动合并或采纳冲突版本后触发</div>
              </div>
            </label>

            <label class="form-checkbox-label" style="display:flex;align-items:flex-start;gap:10px;margin:0;cursor:pointer;">
              <input type="checkbox" class="wh-event-chk" value="backup.created" ${config.events?.includes('backup.created') ? 'checked' : ''} />
              <div>
                <div style="font-weight:500;font-size:13px;">💾 backup.created (全库快照备份完成)</div>
                <div style="font-size:11.5px;color:var(--muted)">当系统或用户完成全库 ZIP 归档快照创建时触发</div>
              </div>
            </label>

            <label class="form-checkbox-label" style="display:flex;align-items:flex-start;gap:10px;margin:0;cursor:pointer;">
              <input type="checkbox" class="wh-event-chk" value="device.connected" ${config.events?.includes('device.connected') ? 'checked' : ''} />
              <div>
                <div style="font-weight:500;font-size:13px;">📱 device.connected (新设备接入与上线)</div>
                <div style="font-size:11.5px;color:var(--muted)">当有新客户端设备首次接入或发起全量同步时触发</div>
              </div>
            </label>

            <label class="form-checkbox-label" style="display:flex;align-items:flex-start;gap:10px;margin:0;cursor:pointer;">
              <input type="checkbox" class="wh-event-chk" value="file.deleted" ${config.events?.includes('file.deleted') ? 'checked' : ''} />
              <div>
                <div style="font-weight:500;font-size:13px;">🗑️ file.deleted (文件移入回收站)</div>
                <div style="font-size:11.5px;color:var(--muted)">当客户端同步删除文件或用户从控制台删除笔记时触发</div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div id="wh-test-result" style="margin-top:16px;"></div>
    `;

    mainPanel.querySelector('#wh-test-btn').onclick = async () => {
      const url = mainPanel.querySelector('#wh-url').value.trim();
      const platform = mainPanel.querySelector('#wh-platform').value;
      const secret = mainPanel.querySelector('#wh-secret').value.trim();
      const resDiv = mainPanel.querySelector('#wh-test-result');

      if (!url) {
        toast('请先填写 Webhook 回调 URL 地址');
        return;
      }

      resDiv.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在发送测试通知消息…</span>';
      try {
        const r = await api('/api/settings/webhooks/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, platform, secret }),
        });
        const b = await r.json();
        if (b.ok) {
          resDiv.innerHTML = `<div style="padding:10px 14px;background:rgba(46,204,113,0.15);border:1px solid rgba(46,204,113,0.3);border-radius:6px;color:#2ecc71;font-size:13px;">✓ 测试通知发送成功！响应状态: ${b.status}</div>`;
          toast('测试通知发送成功');
        } else {
          resDiv.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 推送失败: ${escapeHtml(b.error || '无法投递')}</div>`;
        }
      } catch (e) {
        resDiv.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 请求错误: ${escapeHtml(e.message)}</div>`;
      }
    };

    mainPanel.querySelector('#wh-save-btn').onclick = async () => {
      const enabled = mainPanel.querySelector('#wh-enabled').checked;
      const platform = mainPanel.querySelector('#wh-platform').value;
      const url = mainPanel.querySelector('#wh-url').value.trim();
      const secret = mainPanel.querySelector('#wh-secret').value.trim();
      const events = [];
      mainPanel.querySelectorAll('.wh-event-chk:checked').forEach((c) => events.push(c.value));

      try {
        await api('/api/settings/webhooks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, platform, url, secret, events }),
        });
        toast('Webhook 配置已保存');
        renderWebhooksPanel();
      } catch (e) {
        toast('保存失败: ' + e.message);
      }
    };
    translate(mainPanel);
  } catch (err) {
    if (mainPanel) {
      mainPanel.innerHTML = `<div class="empty-state" style="color:#e74c3c;">加载 Webhook 配置失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}
