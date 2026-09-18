// --------------------------- View: Webhooks & Alarm Triggers ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';

export async function renderWebhooksPanel(containerEl = null) {
  const container = containerEl || $('#main-panel');
  if (!container) return;

  container.innerHTML = '<div class="empty-state">正在加载 Webhook 告警与通知规则…</div>';

  try {
    const res = await api('/api/webhooks');
    const data = await res.json();
    const webhooks = data.webhooks || [];

    container.innerHTML = `
      <div class="webhooks-container" style="max-width:960px;margin:0 auto;padding:16px 20px;">
        <div class="webhooks-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:8px;">
              <span>🔔</span>
              <span>Webhook 告警与即时通知</span>
            </h2>
            <p style="margin:0;font-size:13px;color:var(--muted)">
              当同步冲突发生、Git 自动备份完成或 Vault 出现异常写入时，向飞书、企业微信、钉钉或自定义端点推送事件通知
            </p>
          </div>
          <button class="btn-primary" id="btn-add-webhook" style="padding:6px 14px;font-size:12.5px;">+ 新增 Webhook</button>
        </div>

        <div class="webhooks-list" style="display:flex;flex-direction:column;gap:12px;">
          ${
            webhooks.length > 0
              ? webhooks
                  .map((wh) => `
                <div class="webhook-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                      <strong style="font-size:14.5px;color:var(--text);">${escapeHtml(wh.name || 'Webhook')}</strong>
                      <span class="badge" style="font-size:11px;background:var(--accent-bg);color:var(--accent);">${escapeHtml(wh.targetType || 'custom')}</span>
                      <span class="badge" style="font-size:11px;background:${wh.enabled ? 'rgba(63,185,80,0.15)' : 'rgba(139,148,158,0.15)'};color:${wh.enabled ? '#3fb950' : 'var(--muted)'};">
                        ${wh.enabled ? '已启用' : '已暂停'}
                      </span>
                    </div>
                    <div style="font-size:12px;color:var(--muted);font-family:monospace;margin-bottom:4px;">
                      端点: ${escapeHtml(wh.url || '')}
                    </div>
                    <div style="font-size:11.5px;color:var(--muted);">
                      订阅事件: ${(wh.events || ['conflict', 'backup']).join(', ')}
                    </div>
                  </div>

                  <div style="display:flex;gap:8px;">
                    <button class="secondary btn-test-webhook" data-id="${escapeHtml(wh.id)}" style="padding:4px 10px;font-size:12px;">⚡ 发送测试</button>
                    <button class="secondary btn-del-webhook" data-id="${escapeHtml(wh.id)}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:var(--danger);">删除</button>
                  </div>
                </div>
              `)
                  .join('')
              : `
              <div class="empty-state" style="padding:48px 16px;">
                <div style="font-size:36px;margin-bottom:8px;">🔔</div>
                <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">暂无配置 Webhook</div>
                <div style="font-size:12px;color:var(--muted);">点击右上角按钮即可接入飞书群机器人或企业微信机器人</div>
              </div>
            `
          }
        </div>
      </div>
    `;

    container.querySelector('#btn-add-webhook')?.addEventListener('click', () => {
      showModal(`
        <div class="modal-header">
          <h3>🔔 配置新 Webhook 机器人</h3>
          <button class="modal-close ghost">✕</button>
        </div>
        <div class="modal-body">
          <form id="add-webhook-form" onsubmit="return false;">
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">机器人名称 *</label>
              <input type="text" id="wh-m-name" placeholder="如 运维告警群" required style="width:100%;" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">Webhook URL *</label>
              <input type="url" id="wh-m-url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." required style="width:100%;font-family:monospace;font-size:12px;" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">平台类型</label>
              <select id="wh-m-type" style="width:100%;">
                <option value="feishu">飞书 / Lark 自定义机器人</option>
                <option value="wechat_work">企业微信群机器人</option>
                <option value="dingtalk">钉钉群自定义机器人</option>
                <option value="custom">通用 HTTP POST JSON</option>
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="secondary modal-close">取消</button>
          <button class="btn-primary" id="wh-m-save-btn">确认添加</button>
        </div>
      `, (modal) => {
        modal.querySelector('#wh-m-save-btn').onclick = async () => {
          const name = modal.querySelector('#wh-m-name').value.trim();
          const url = modal.querySelector('#wh-m-url').value.trim();
          const targetType = modal.querySelector('#wh-m-type').value;
          if (!name || !url) {
            toast('请完整填写名称与 URL');
            return;
          }
          try {
            const r = await api('/api/webhooks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                url,
                targetType,
                events: ['conflict_detected', 'backup_created', 'git_sync_failed'],
                enabled: true,
              }),
            });
            const resData = await r.json();
            if (resData.ok) {
              closeModal();
              toast('Webhook 添加成功！');
              renderWebhooksPanel(container);
            } else {
              toast('添加失败: ' + (resData.error || '未知错误'));
            }
          } catch (err) {
            toast('操作失败: ' + err.message);
          }
        };
      });
    });

    container.querySelectorAll('.btn-test-webhook').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        toast('正在向该端点发送测试消息…');
        try {
          const r = await api(`/api/webhooks/${id}/test`, { method: 'POST' });
          const d = await r.json();
          if (d.ok) {
            toast('测试通知发送成功！');
          } else {
            toast('发送失败: ' + (d.error || '远端拒绝连接'));
          }
        } catch (err) {
          toast('发送异常: ' + err.message);
        }
      };
    });

    container.querySelectorAll('.btn-del-webhook').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const ok = await showConfirm({
          title: '删除 Webhook',
          message: '确定移除此 Webhook 推送端点吗？',
          confirmText: '确认删除',
          type: 'danger',
        });
        if (!ok) return;
        try {
          const r = await api(`/api/webhooks/${id}`, { method: 'DELETE' });
          const d = await r.json();
          if (d.ok) {
            toast('已删除 Webhook');
            renderWebhooksPanel(container);
          }
        } catch (err) {
          toast('删除失败: ' + err.message);
        }
      };
    });

    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载 Webhook 失败: ${escapeHtml(err.message)}</div>`;
  }
}
