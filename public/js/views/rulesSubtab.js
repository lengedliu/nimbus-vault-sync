// --------------------------- Subtab: Sync Rules ---------------------------
import { escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';

export async function renderRulesSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">加载同步规则中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/rules`);
    const { rules } = await res.json();

    container.innerHTML = `
      <div class="panel-header">
        <h3 style="margin:0;font-size:16px;">⚙️ 忽略规则与同步策略</h3>
        <button class="btn-primary" id="save-rules-btn">💾 保存规则</button>
      </div>
      <div style="max-width:680px">
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px">
          匹配以下通配符的文件将不会上传到服务器或下发到客户端，避免同步无意义的临时文件：
        </p>
        <label>忽略路径规则 (每行一条匹配表达式，支持 * 与 **):
          <textarea id="ignore-patterns-textarea" rows="14" style="font-family:monospace;font-size:13px;min-height:260px;height:280px;">${(rules.ignorePatterns || []).join('\n')}</textarea>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">
          <label>单文件最大同步限制 (MB)
            <input type="number" id="max-file-size-input" value="${rules.maxFileSizeMb || 100}" />
          </label>
        </div>
      </div>
    `;

    container.querySelector('#save-rules-btn').onclick = async () => {
      const rawText = container.querySelector('#ignore-patterns-textarea').value;
      const patterns = rawText.split('\n').map((s) => s.trim()).filter(Boolean);
      const maxMb = parseInt(container.querySelector('#max-file-size-input').value, 10) || 100;

      try {
        await api(`/api/vaults/${vaultId}/rules`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ignorePatterns: patterns, maxFileSizeMb: maxMb }),
        });
        toast('同步规则已更新');
      } catch (e) {
        toast('保存失败: ' + e.message);
      }
    };
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载规则失败: ${escapeHtml(err.message || '网络错误')}</div>`;
  }
}
