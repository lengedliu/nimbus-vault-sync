// --------------------------- View: Server & Client Settings ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';

let currentSettingsSubTab = 'plugin';

export async function renderSettingsPanel(subTab = null, containerEl = null) {
  const container = containerEl || $('#main-panel');
  if (!container) return;
  if (subTab) currentSettingsSubTab = subTab;

  container.innerHTML = '<div class="empty-state">正在加载系统配置与令牌列表…</div>';

  let settingsData = null;
  let tokensList = [];
  try {
    const [resSettings, resTokens] = await Promise.all([
      api('/api/settings'),
      api('/api/settings/tokens'),
    ]);
    if (resSettings.ok) {
      const body = await resSettings.json();
      settingsData = body.settings;
    }
    if (resTokens.ok) {
      const body = await resTokens.json();
      tokensList = body.tokens || [];
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  }

  const settings = settingsData || {
    serverName: 'Nimbus Vault Sync',
    publicUrl: '',
    wsHeartbeatInterval: 30,
    conflictStrategy: 'conflict_copy',
    maxFileSizeMb: 100,
    chunkSizeMb: 5,
    versionRetentionCount: 30,
    versionRetentionDays: 30,
    trashRetentionDays: 30,
    syncHiddenConfig: true,
    syncAttachments: true,
    autoPurgeTrash: false,
    defaultIgnorePatterns: [
      '.obsidian/workspace.json',
      '.obsidian/workspace-mobile.json',
      '**/*.tmp',
      '**/.DS_Store',
      '**/Thumbs.db',
      '**/.git/**',
    ],
  };

  const isAdmin = state.user?.role === 'admin';
  const serverOrigin = window.location.origin;
  const currentVault =
    state.vaults.find((v) => v.id === state.activeVaultId) ||
    state.vaults[0] || { id: 'default', name: 'Default Vault' };

  container.innerHTML = `
    <div class="settings-container" style="max-width:960px;margin:0 auto;padding:16px 20px;">
      <div class="settings-header" style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <h2 style="margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:8px;">
              <span>⚙️</span>
              <span>系统设置与同步策略</span>
            </h2>
            <p style="margin:0;font-size:13px;color:var(--muted)">
              配置 Obsidian 同步参数、冲突裁决机制、多端专属令牌与数据保留策略
            </p>
          </div>
          <span class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:12px;padding:4px 10px;border-radius:12px;">
            ${isAdmin ? '👑 管理员权限' : '👤 普通用户'}
          </span>
        </div>
      </div>

      <!-- Settings Sub Navigation -->
      <div class="subtabs-bar" style="margin-bottom:20px;">
        <button class="subtab-btn ${currentSettingsSubTab === 'plugin' ? 'active' : ''}" id="st-tab-plugin">⚡ 客户端同步接入</button>
        <button class="subtab-btn ${currentSettingsSubTab === 'retention' ? 'active' : ''}" id="st-tab-retention">📦 数据保留与冲突策略</button>
        <button class="subtab-btn ${currentSettingsSubTab === 'tokens' ? 'active' : ''}" id="st-tab-tokens">🔑 个人 Access Token</button>
      </div>

      <div id="settings-tab-content"></div>
    </div>
  `;

  const contentBox = container.querySelector('#settings-tab-content');

  // Subtab 1: Plugin Configuration
  if (currentSettingsSubTab === 'plugin') {
    contentBox.innerHTML = `
      <div class="settings-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
        <h3 style="margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:6px;">
          <span>📱</span>
          <span>Obsidian 插件一键连接参数</span>
        </h3>
        <p style="font-size:13px;color:var(--muted);margin-bottom:16px;">
          在移动端或电脑端 Obsidian 安装 <strong>Nimbus Sync</strong> 社区插件后，输入以下参数即可开启双向高速同步：
        </p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
          <div>
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">服务器地址 (Server URL):</label>
            <div style="display:flex;gap:6px;">
              <input type="text" id="cfg-server-url" value="${escapeHtml(settings.publicUrl || serverOrigin)}" readonly style="font-family:monospace;font-size:12px;flex:1;" />
              <button class="secondary btn-copy" data-target="cfg-server-url" style="padding:4px 10px;font-size:12px;">复制</button>
            </div>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">当前 Vault ID:</label>
            <div style="display:flex;gap:6px;">
              <input type="text" id="cfg-vault-id" value="${escapeHtml(currentVault.id)}" readonly style="font-family:monospace;font-size:12px;flex:1;" />
              <button class="secondary btn-copy" data-target="cfg-vault-id" style="padding:4px 10px;font-size:12px;">复制</button>
            </div>
          </div>
        </div>

        <div style="padding:12px;background:rgba(88,166,255,0.08);border:1px solid var(--accent);border-radius:6px;font-size:12px;color:var(--text);">
          💡 <strong>提示：</strong> 支持 WebSocket 秒级实时增量同步，多台设备同时编辑同一笔记时会自动进行毫秒级冲突检测。
        </div>
      </div>
    `;
  }

  // Subtab 2: Retention & Conflict
  if (currentSettingsSubTab === 'retention') {
    contentBox.innerHTML = `
      <form id="settings-form" onsubmit="return false;">
        <div class="settings-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
          <h3 style="margin:0 0 12px;font-size:15px;">⚔️ 冲突解决机制</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div>
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">多端写入冲突默认处理动作:</label>
              <select id="cfg-conflict-strategy" style="width:100%;font-size:13px;" ${!isAdmin ? 'disabled' : ''}>
                <option value="conflict_copy" ${settings.conflictStrategy === 'conflict_copy' ? 'selected' : ''}>保留双方内容并自动生成 .conflict 副本 (推荐)</option>
                <option value="server_wins" ${settings.conflictStrategy === 'server_wins' ? 'selected' : ''}>以服务端已有版本为准 (覆盖客户端)</option>
                <option value="client_wins" ${settings.conflictStrategy === 'client_wins' ? 'selected' : ''}>以客户端最新上传为准 (覆盖服务端)</option>
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">单文件上传体积上限 (MB):</label>
              <input type="number" id="cfg-max-file-size" value="${settings.maxFileSizeMb || 100}" min="1" max="1024" style="width:100%;font-size:13px;" ${!isAdmin ? 'disabled' : ''} />
            </div>
          </div>
        </div>

        <div class="settings-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
          <h3 style="margin:0 0 12px;font-size:15px;">📦 版本历史与回收站生命周期</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px;">
            <div>
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">单文件最多保留历史版本数:</label>
              <input type="number" id="cfg-retention-count" value="${settings.versionRetentionCount || 30}" min="5" max="200" style="width:100%;font-size:13px;" ${!isAdmin ? 'disabled' : ''} />
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">历史版本最长保留天数 (天):</label>
              <input type="number" id="cfg-retention-days" value="${settings.versionRetentionDays || 30}" min="1" max="365" style="width:100%;font-size:13px;" ${!isAdmin ? 'disabled' : ''} />
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">回收站清理周期 (天):</label>
              <input type="number" id="cfg-trash-days" value="${settings.trashRetentionDays || 30}" min="1" max="180" style="width:100%;font-size:13px;" ${!isAdmin ? 'disabled' : ''} />
            </div>
          </div>

          ${isAdmin ? '<button type="submit" class="btn-primary" id="save-server-settings-btn" style="padding:8px 24px;">💾 保存全局策略设置</button>' : '<p style="font-size:12px;color:var(--muted);margin:0;">* 当前为普通用户，全局策略由系统管理员配置。</p>'}
        </div>
      </form>
    `;

    if (isAdmin) {
      const saveBtn = contentBox.querySelector('#save-server-settings-btn');
      if (saveBtn) {
        saveBtn.onclick = async () => {
          const payload = {
            conflictStrategy: contentBox.querySelector('#cfg-conflict-strategy').value,
            maxFileSizeMb: parseInt(contentBox.querySelector('#cfg-max-file-size').value, 10) || 100,
            versionRetentionCount: parseInt(contentBox.querySelector('#cfg-retention-count').value, 10) || 30,
            versionRetentionDays: parseInt(contentBox.querySelector('#cfg-retention-days').value, 10) || 30,
            trashRetentionDays: parseInt(contentBox.querySelector('#cfg-trash-days').value, 10) || 30,
          };
          try {
            const res = await api('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.ok) {
              toast('系统配置已成功保存！');
            } else {
              toast('保存失败: ' + (data.error || '未知错误'));
            }
          } catch (err) {
            toast('网络保存错误: ' + err.message);
          }
        };
      }
    }
  }

  // Subtab 3: Personal Access Tokens
  if (currentSettingsSubTab === 'tokens') {
    contentBox.innerHTML = `
      <div class="settings-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <h3 style="margin:0 0 4px;font-size:15px;">🔑 专属 Access Token 管理</h3>
            <p style="margin:0;font-size:12.5px;color:var(--muted);">
              用于 Obsidian 移动端无密码扫码接入、MCP 工具集成或自动化同步脚本认证。
            </p>
          </div>
          <button class="btn-primary" id="btn-create-new-token" style="padding:6px 14px;font-size:12.5px;">+ 创建新 Token</button>
        </div>

        <div class="tokens-list-box">
          ${
            tokensList.length > 0
              ? tokensList
                  .map(
                    (tok) => `
                <div class="token-item-row" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--panel);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;">
                  <div>
                    <div style="font-weight:600;font-size:13px;color:var(--text);">${escapeHtml(tok.label || 'API Token')}</div>
                    <div style="font-size:11.5px;color:var(--muted);font-family:monospace;margin-top:2px;">
                      前缀: ${escapeHtml((tok.token || '').slice(0, 10))}... | 创建时间: ${new Date(tok.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;">
                    <button class="secondary btn-del-token" data-token-id="${escapeHtml(tok.id)}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:var(--danger);">吊销</button>
                  </div>
                </div>
              `
                  )
                  .join('')
              : '<div class="empty-state" style="padding:24px 0;font-size:13px;">暂未创建专属 Token，可点击右上角即刻生成</div>'
          }
        </div>
      </div>
    `;

    const createTokenBtn = contentBox.querySelector('#btn-create-new-token');
    if (createTokenBtn) {
      createTokenBtn.onclick = () => {
        showModal(`
          <div class="modal-header">
            <h3>🔑 创建个人 Access Token</h3>
            <button class="modal-close ghost">✕</button>
          </div>
          <div class="modal-body">
            <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;">Token 标签 / 设备用途名称 *</label>
            <input type="text" id="m-token-label" placeholder="如 iPhone 15 Pro / Claude MCP" required style="width:100%;margin-bottom:12px;" />
          </div>
          <div class="modal-footer">
            <button class="secondary modal-close">取消</button>
            <button class="btn-primary" id="m-btn-save-token">立即创建</button>
          </div>
        `, (modal) => {
          modal.querySelector('#m-btn-save-token').onclick = async () => {
            const label = modal.querySelector('#m-token-label').value.trim();
            if (!label) {
              toast('请输入 Token 标签名称');
              return;
            }
            try {
              const res = await api('/api/settings/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label }),
              });
              const data = await res.json();
              if (data.ok) {
                closeModal();
                toast('Token 创建成功！');
                renderSettingsPanel('tokens', container);
              } else {
                toast('创建失败: ' + (data.error || '未知错误'));
              }
            } catch (err) {
              toast('创建失败: ' + err.message);
            }
          };
        });
      };
    }

    contentBox.querySelectorAll('.btn-del-token').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.tokenId;
        const ok = await showConfirm({
          title: '吊销 Access Token',
          message: '确定吊销该 Token 吗？已使用该 Token 的设备或脚本将无法继续同步。',
          confirmText: '确认吊销',
          type: 'danger',
        });
        if (!ok) return;
        try {
          const res = await api(`/api/settings/tokens/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.ok) {
            toast('Token 已吊销');
            renderSettingsPanel('tokens', container);
          }
        } catch (err) {
          toast('操作失败: ' + err.message);
        }
      };
    });
  }

  // Bind Subtab Switching
  container.querySelector('#st-tab-plugin')?.addEventListener('click', () => {
    currentSettingsSubTab = 'plugin';
    renderSettingsPanel('plugin', container);
  });
  container.querySelector('#st-tab-retention')?.addEventListener('click', () => {
    currentSettingsSubTab = 'retention';
    renderSettingsPanel('retention', container);
  });
  container.querySelector('#st-tab-tokens')?.addEventListener('click', () => {
    currentSettingsSubTab = 'tokens';
    renderSettingsPanel('tokens', container);
  });

  // Copy Buttons
  container.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.onclick = () => {
      const targetId = btn.dataset.target;
      const targetInput = container.querySelector('#' + targetId);
      if (targetInput) {
        navigator.clipboard.writeText(targetInput.value).then(() => {
          toast('已复制到剪贴板！');
        });
      }
    };
  });

  translate(container);
}
