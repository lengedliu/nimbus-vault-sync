// --------------------------- REST API Developer Docs Modal ---------------------------
import { state, escapeHtml } from '../core/state.js';
import { api } from '../core/api.js';
import { showModal, toast } from '../core/dialogs.js';

export async function showDocsModal() {
  let spec = null;
  try {
    const res = await api('/api/docs/spec');
    if (res.ok) {
      spec = await res.json();
    }
  } catch {
    spec = null;
  }

  const categories = spec?.categories || [];
  const baseUrl = (state.serverBase || window.location.origin).replace(/\/$/, '');
  const currentToken = state.token || '<YOUR_JWT_TOKEN>';
  const sampleVaultId = state.activeVaultId || (state.vaults && state.vaults[0] ? state.vaults[0].id : 'vlt_sample');

  function buildCurl(ep) {
    const fullUrl = baseUrl + ep.path.replace(':vaultId', sampleVaultId).replace('*', 'Daily/2026-08-29.md').replace(':versionId', 'ver_01').replace(':trashId', 'tsh_01').replace(':shareId', 'shr_01');
    let lines = [`curl -X ${ep.method} "${fullUrl}"`];

    if (ep.auth && ep.auth.includes('Bearer')) {
      lines.push(`  -H "Authorization: Bearer ${currentToken}"`);
    }
    if (ep.headers) {
      for (const [k, v] of Object.entries(ep.headers)) {
        if (k.toLowerCase() !== 'authorization') {
          lines.push(`  -H "${k}: ${v}"`);
        }
      }
    }
    if (ep.body && (ep.method === 'POST' || ep.method === 'PUT')) {
      if (typeof ep.body === 'object') {
        lines.push(`  -d '${JSON.stringify(ep.body)}'`);
      } else {
        lines.push(`  --data-binary "@example.md"`);
      }
    }
    return lines.join(' \\\n');
  }

  const html = `
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">📖</span>
        <div>
          <h3 style="margin:0;font-size:16px;">REST API 开发者集成文档</h3>
          <div style="font-size:11.5px;color:var(--muted)">支持外部系统、CLI 脚本、自动化工作流调用 Nimbus 后端服务</div>
        </div>
      </div>
      <button class="modal-close ghost">✕</button>
    </div>

    <div class="modal-body" style="max-height:72vh;overflow-y:auto;padding:16px 20px;">
      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:16px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="font-size:12.5px;">
            <b>基础地址 (Base URL)：</b> <code style="color:var(--primary);font-weight:600;">${escapeHtml(baseUrl)}</code>
          </div>
          <div style="font-size:11.5px;color:var(--muted)">
            当前登录凭证已自动带入以下 cURL 示例
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">
          Nimbus API 遵循标准 REST 规范。除公开分享接口外，所有请求均需在请求头携带 <code>Authorization: Bearer &lt;Token&gt;</code>。
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <input type="text" id="api-docs-search" placeholder="🔍 快速搜索 API 路径、方法或说明（例如：/files, backup, search）..." style="width:100%;box-sizing:border-box;padding:7px 12px;font-size:12.5px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
      </div>

      <div id="api-docs-content">
        ${categories.map((cat) => `
          <div class="api-category-block" style="margin-bottom:20px;">
            <div style="font-weight:600;font-size:13.5px;color:var(--text);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;">
              <span>📁</span>
              <span>${escapeHtml(cat.name)}</span>
              <span style="font-size:11px;color:var(--muted);font-weight:normal;">(${cat.endpoints?.length || 0} 个端点)</span>
            </div>
            ${(cat.endpoints || []).map((ep) => {
              const curlText = buildCurl(ep);
              const methodColor = ep.method === 'GET' ? '#2ecc71' : ep.method === 'POST' ? '#3498db' : ep.method === 'PUT' ? '#e67e22' : '#e74c3c';
              return `
                <div class="api-endpoint-card" data-method="${escapeHtml(ep.method.toLowerCase())}" data-path="${escapeHtml(ep.path.toLowerCase())}" data-summary="${escapeHtml((ep.summary || '').toLowerCase())}" data-desc="${escapeHtml((ep.description || '').toLowerCase())}">
                  <div class="api-endpoint-header">
                    <span class="api-method-badge" style="background:${methodColor};">${escapeHtml(ep.method)}</span>
                    <span class="api-path">${escapeHtml(ep.path)}</span>
                    <span class="api-summary">${escapeHtml(ep.summary || '')}</span>
                  </div>
                  ${ep.description ? `<div class="api-desc">${escapeHtml(ep.description)}</div>` : ''}
                  <div class="api-curl-box">
                    <button class="api-copy-curl-btn" data-curl="${escapeHtml(curlText)}">📋 复制 cURL</button>
                    <pre style="margin:0;background:none;border:none;padding:0;color:var(--text);font-size:11px;">${escapeHtml(curlText)}</pre>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-close secondary">关闭文档</button>
    </div>
  `;

  showModal(html, (dialog) => {
    const searchInput = dialog.querySelector('#api-docs-search');
    if (searchInput) {
      searchInput.oninput = (e) => {
        const q = e.target.value.toLowerCase().trim();
        dialog.querySelectorAll('.api-category-block').forEach((catBlock) => {
          let catHasMatch = false;
          catBlock.querySelectorAll('.api-endpoint-card').forEach((card) => {
            const method = card.getAttribute('data-method') || '';
            const path = card.getAttribute('data-path') || '';
            const summary = card.getAttribute('data-summary') || '';
            const desc = card.getAttribute('data-desc') || '';
            const match = !q || method.includes(q) || path.includes(q) || summary.includes(q) || desc.includes(q);
            card.style.display = match ? 'block' : 'none';
            if (match) catHasMatch = true;
          });
          catBlock.style.display = catHasMatch ? 'block' : 'none';
        });
      };
    }

    dialog.querySelectorAll('.api-copy-curl-btn').forEach((btn) => {
      btn.onclick = () => {
        const curl = btn.getAttribute('data-curl');
        if (curl && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(curl).then(() => toast('cURL 命令已复制'));
        } else if (curl) {
          prompt('复制 cURL 命令：', curl);
        }
      };
    });
  });
}
