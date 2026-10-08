// --------------------------- Database Management Panel & Subtab ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm } from '../core/dialogs.js';

export async function renderDatabasePanel(containerEl = null) {
  const mainPanel = containerEl || $('#main-panel');
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">加载数据库配置中…</div>';
  try {
    const res = await api('/api/admin/database/status');
    const data = await res.json();
    const activeType = data.type || 'json';

    mainPanel.innerHTML = `
      <div class="panel-header">
        <h2>🗄️ 多数据库配置与管理</h2>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:16px;margin-bottom:24px;">
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px;">
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">当前激活引擎</div>
          <div style="font-size:20px;font-weight:700;display:flex;align-items:center;gap:8px;">
            <span>${getEngineIcon(activeType)}</span>
            <span>${data.activeEngine || activeType.toUpperCase()}</span>
            <span class="badge" style="background:rgba(46,204,113,0.15);color:#2ecc71;border-color:rgba(46,204,113,0.3)">运行中</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:8px;">
            支持热切换至 SQLite / PostgreSQL / MySQL，数据可一键迁移。
          </div>
        </div>

        <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px;">
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">已持久化实体统计</div>
          <div style="display:flex;gap:16px;margin-top:10px;">
            <div><span style="font-size:18px;font-weight:700;">${data.stats?.usersCount || 0}</span> <span style="font-size:12px;color:var(--text-secondary)">用户</span></div>
            <div><span style="font-size:18px;font-weight:700;">${data.stats?.vaultsCount || 0}</span> <span style="font-size:12px;color:var(--text-secondary)">Vaults</span></div>
            <div><span style="font-size:18px;font-weight:700;">${data.stats?.sharesCount || 0}</span> <span style="font-size:12px;color:var(--text-secondary)">分享链接</span></div>
          </div>
        </div>
      </div>

      <!-- Database Engine Switcher -->
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:24px;">
        <h3 style="margin:0 0 16px;font-size:16px;">切换或配置数据库引擎</h3>
        
        <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">
          <button class="db-type-btn ${activeType === 'sqlite' ? 'active' : ''}" data-type="sqlite" style="padding:10px 16px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;display:flex;align-items:center;gap:8px;">
            <span>💾</span> <b>SQLite</b> (单文件极简推荐)
          </button>
          <button class="db-type-btn ${activeType === 'postgres' ? 'active' : ''}" data-type="postgres" style="padding:10px 16px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;display:flex;align-items:center;gap:8px;">
            <span>🐘</span> <b>PostgreSQL</b> (企业级关系数据库)
          </button>
          <button class="db-type-btn ${activeType === 'mysql' ? 'active' : ''}" data-type="mysql" style="padding:10px 16px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;display:flex;align-items:center;gap:8px;">
            <span>🐬</span> <b>MySQL</b> (标准生产数据库)
          </button>
          <button class="db-type-btn ${activeType === 'json' ? 'active' : ''}" data-type="json" style="padding:10px 16px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;display:flex;align-items:center;gap:8px;">
            <span>📄</span> <b>JSON 文件</b> (基础轻量)
          </button>
        </div>

        <!-- Dynamic Config Forms -->
        <div id="db-form-container"></div>
      </div>

      <!-- System Architecture Documentation -->
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;">
        <h4 style="margin:0 0 10px;font-size:14px;">📖 数据库支持说明</h4>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0 0 10px;">
          Nimbus 现已内置对 <b>SQLite</b>、<b>PostgreSQL</b>、<b>MySQL</b> 三种主流数据库及本地 JSON 存储引擎的完整抽象支持：
        </p>
        <ul style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0;padding-left:20px;">
          <li><b>用户数据 (Users)</b>：账号、权限、密码哈希与创建时间均完整保存在选定数据库中。</li>
          <li><b>配置数据 (Sync Rules & Metadata)</b>：黑名单规则、同步策略、分片配置自动持久化到数据库。</li>
          <li><b>Vault 与外链元数据 (Vaults & Shares)</b>：Vault 归属权、公开分享链接与访问密码完整同步。</li>
          <li><b>环境变量支持</b>：也可直接在 <code>.env</code> 中配置 <code>DB_TYPE=sqlite|postgres|mysql</code> 启动自动连接。</li>
        </ul>
      </div>
    `;

    setupDbForm(activeType, data.config, mainPanel);
  } catch (err) {
    if (mainPanel) {
      mainPanel.innerHTML = `<div class="error-msg">加载数据库信息失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function getEngineIcon(type) {
  if (type === 'sqlite') return '💾';
  if (type === 'postgres') return '🐘';
  if (type === 'mysql') return '🐬';
  return '📄';
}

function setupDbForm(selectedType, currentConfig = {}, mainPanel = null) {
  const container = (mainPanel || document).querySelector('#db-form-container');
  if (!container) return;

  const buttons = (mainPanel || document).querySelectorAll('.db-type-btn');
  buttons.forEach((btn) => {
    btn.onclick = () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setupDbForm(btn.dataset.type, currentConfig, mainPanel);
    };
  });

  if (selectedType === 'sqlite') {
    container.innerHTML = `
      <div class="settings-form-grid" style="margin-bottom:16px;">
        <label>
          <span>SQLite 文件路径</span>
          <input type="text" id="cfg-sqlite-path" value="${escapeHtml(currentConfig.path || 'data/nimbus.sqlite')}" />
          <div class="settings-help">嵌入式单文件，极速轻量无需安装数据库服务端</div>
        </label>
      </div>
    `;
  } else if (selectedType === 'postgres') {
    container.innerHTML = `
      <div class="settings-form-grid" style="margin-bottom:16px;">
        <label>
          <span>主机地址 (Host)</span>
          <input type="text" id="cfg-pg-host" value="${escapeHtml(currentConfig.host || 'localhost')}" />
        </label>
        <label>
          <span>端口 (Port)</span>
          <input type="number" id="cfg-pg-port" value="${currentConfig.port || 5432}" />
        </label>
        <label>
          <span>数据库名 (Database)</span>
          <input type="text" id="cfg-pg-database" value="${escapeHtml(currentConfig.database || 'nimbus_sync')}" />
        </label>
        <label>
          <span>用户名 (User)</span>
          <input type="text" id="cfg-pg-user" value="${escapeHtml(currentConfig.user || 'postgres')}" />
        </label>
        <label>
          <span>密码 (Password)</span>
          <input type="password" id="cfg-pg-password" value="${escapeHtml(currentConfig.password || '')}" />
        </label>
        <label style="display:flex;align-items:center;gap:8px;padding-top:20px;">
          <input type="checkbox" id="cfg-pg-ssl" ${currentConfig.ssl ? 'checked' : ''} />
          <span>启用 SSL 加密连接 (云数据库必须)</span>
        </label>
        <div id="cfg-pg-ssl-options" style="display:${currentConfig.ssl ? 'block' : 'none'};padding:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);margin-top:10px;">
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <input type="checkbox" id="cfg-pg-ssl-strict" ${currentConfig.sslRejectUnauthorized !== false ? 'checked' : ''} />
            <span style="font-size:13px;font-weight:600;">严格校验 CA 证书有效性 (推荐，防范中间人攻击)</span>
          </label>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">
            取消勾选将允许自签名证书（存在中间人嗅探风险）。生产环境建议保持开启。
          </div>
          <label style="display:block;">
            <span style="font-size:12px;color:var(--text-secondary);">自定义 CA 证书内容 (可选 PEM 证书字符串):</span>
            <textarea id="cfg-pg-ssl-ca" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" style="width:100%;font-family:monospace;font-size:12px;margin-top:4px;box-sizing:border-box;">${escapeHtml(currentConfig.sslCa || '')}</textarea>
          </label>
        </div>
      </div>
    `;
  } else if (selectedType === 'mysql') {
    container.innerHTML = `
      <div class="settings-form-grid" style="margin-bottom:16px;">
        <label>
          <span>主机地址 (Host)</span>
          <input type="text" id="cfg-mysql-host" value="${escapeHtml(currentConfig.host || 'localhost')}" />
        </label>
        <label>
          <span>端口 (Port)</span>
          <input type="number" id="cfg-mysql-port" value="${currentConfig.port || 3306}" />
        </label>
        <label>
          <span>数据库名 (Database)</span>
          <input type="text" id="cfg-mysql-database" value="${escapeHtml(currentConfig.database || 'nimbus_sync')}" />
        </label>
        <label>
          <span>用户名 (User)</span>
          <input type="text" id="cfg-mysql-user" value="${escapeHtml(currentConfig.user || 'root')}" />
        </label>
        <label>
          <span>密码 (Password)</span>
          <input type="password" id="cfg-mysql-password" value="${escapeHtml(currentConfig.password || '')}" />
        </label>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div style="padding:16px;background:var(--panel-2);border-radius:var(--radius);border:1px solid var(--border);color:var(--text-secondary);font-size:13px;margin-bottom:16px;">
        JSON 模式下数据自动保存在本地 <code>data/</code> 目录下的各个 .json 数据持久化文件中。无需任何网络端口配置。
      </div>
    `;
  }

  container.innerHTML += `
    <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:16px;">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
        <input type="checkbox" id="db-migrate-check" checked />
        <span style="font-weight:600;font-size:13px;">在保存切换时自动迁移现有数据 (推荐)</span>
      </label>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;padding-left:24px;">
        系统将当前活动的全部用户、Vault 索引与分享配置平滑导入至新目标数据库中，确保数据不丢失。
      </div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button id="db-test-btn" class="secondary">🔍 测试数据库连通性</button>
      <button id="db-save-btn" class="btn-primary">💾 保存并应用配置</button>
      <div id="db-action-result"></div>
    </div>
  `;

  const pgSslCheck = container.querySelector('#cfg-pg-ssl');
  if (pgSslCheck) {
    pgSslCheck.addEventListener('change', () => {
      const opts = container.querySelector('#cfg-pg-ssl-options');
      if (opts) opts.style.display = pgSslCheck.checked ? 'block' : 'none';
    });
  }

  function collectFormConfig() {
    if (selectedType === 'sqlite') {
      return {
        type: 'sqlite',
        path: container.querySelector('#cfg-sqlite-path')?.value.trim() || 'data/nimbus.sqlite',
      };
    }
    if (selectedType === 'postgres') {
      const sslChecked = Boolean(container.querySelector('#cfg-pg-ssl')?.checked);
      return {
        type: 'postgres',
        host: container.querySelector('#cfg-pg-host')?.value.trim(),
        port: parseInt(container.querySelector('#cfg-pg-port')?.value, 10) || 5432,
        database: container.querySelector('#cfg-pg-database')?.value.trim(),
        user: container.querySelector('#cfg-pg-user')?.value.trim(),
        password: container.querySelector('#cfg-pg-password')?.value || '',
        ssl: sslChecked,
        sslRejectUnauthorized: container.querySelector('#cfg-pg-ssl-strict')?.checked !== false,
        sslCa: container.querySelector('#cfg-pg-ssl-ca')?.value.trim() || undefined,
      };
    }
    if (selectedType === 'mysql') {
      return {
        type: 'mysql',
        host: container.querySelector('#cfg-mysql-host')?.value.trim(),
        port: parseInt(container.querySelector('#cfg-mysql-port')?.value, 10) || 3306,
        database: container.querySelector('#cfg-mysql-database')?.value.trim(),
        user: container.querySelector('#cfg-mysql-user')?.value.trim(),
        password: container.querySelector('#cfg-mysql-password')?.value || '',
      };
    }
    return { type: 'json' };
  }

  const testBtn = container.querySelector('#db-test-btn');
  if (testBtn) {
    testBtn.onclick = async () => {
      const config = collectFormConfig();
      const resDiv = container.querySelector('#db-action-result');
      resDiv.innerHTML = '<span style="color:var(--text-secondary);font-size:13px;">正在测试连接…</span>';
      try {
        const res = await api('/api/admin/database/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        const body = await res.json();
        if (body.ok) {
          resDiv.innerHTML = `<span style="color:#2ecc71;font-size:13px;">✓ ${escapeHtml(body.message || '连接测试成功')}</span>`;
        } else {
          resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 连接失败: ${escapeHtml(body.error || '未知错误')}</span>`;
        }
      } catch (e) {
        resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 连接失败: ${escapeHtml(e.message)}</span>`;
      }
    };
  }

  const saveBtn = container.querySelector('#db-save-btn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const config = collectFormConfig();
      const migrateCheck = container.querySelector('#db-migrate-check');
      const migrateExisting = migrateCheck ? migrateCheck.checked : false;
      const resDiv = container.querySelector('#db-action-result');
      resDiv.innerHTML = '<span style="color:var(--text-secondary);font-size:13px;">正在应用数据库设置并初始化表结构…</span>';
      try {
        const res = await api('/api/admin/database/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...config, migrateExisting }),
        });
        const body = await res.json();
        if (body.ok) {
          toast(body.message || '数据库切换成功');
          renderDatabasePanel(mainPanel);
        } else {
          resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 失败: ${escapeHtml(body.error)}</span>`;
        }
      } catch (e) {
        resDiv.innerHTML = `<span style="color:#e74c3c;font-size:13px;">✕ 保存失败: ${escapeHtml(e.message)}</span>`;
      }
    };
  }
}

// --------------------------- Database Settings Subtab (Embedded in Settings) ---------------------------
export async function renderDatabaseSettingsSubtab(container) {
  if (!container) return;
  container.innerHTML = '<div class="empty-state">正在加载数据库引擎与存储状态…</div>';

  let dbInfo = null;
  try {
    const res = await api('/api/settings/database');
    if (res.ok) {
      dbInfo = await res.json();
    }
  } catch (e) {
    console.error('Fetch database info error:', e);
  }

  if (!dbInfo) {
    container.innerHTML = '<div class="empty-state" style="color:var(--danger)">获取数据库信息失败，请检查网络或后端状态</div>';
    return;
  }

  const activeEngine = (dbInfo.status?.type || 'json').toLowerCase();
  const cfg = dbInfo.status?.config || {};
  const stats = dbInfo.stats || { usersCount: 0, vaultsCount: 0, sharesCount: 0, tokensCount: 0, rulesCount: 0 };
  const isAdmin = state.user?.role === 'admin';

  const engineNames = {
    json: 'JSON 本地文件存储 (Local JSON Storage)',
    sqlite: 'SQLite 嵌入式单文件关系数据库 (Embedded SQLite3)',
    postgres: 'PostgreSQL 企业级关系数据库 (PostgreSQL 14+)',
    mysql: 'MySQL / MariaDB 关系数据库 (MySQL 8.0+)',
  };

  container.innerHTML = `
    <!-- Active Engine Hero Card -->
    <div class="db-hero-card">
      <div class="db-hero-header">
        <div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
            <h3 style="margin:0;font-size:16px;font-weight:700;">🗄️ 当前活动存储后端: ${escapeHtml(engineNames[activeEngine] || activeEngine.toUpperCase())}</h3>
            <span class="db-status-badge">
              <span class="db-status-dot"></span>
              <span>运行正常</span>
            </span>
          </div>
          <p style="margin:0;font-size:13px;color:var(--muted)">
            ${activeEngine === 'json' ? '数据持久化保存于服务端 <code>/data/*.json</code> 文件中' : ''}
            ${activeEngine === 'sqlite' ? `数据库文件路径: <code>${escapeHtml(cfg.sqlitePath || 'data/nimbus.sqlite')}</code> (已启用 WAL 高并发日志模式)` : ''}
            ${activeEngine === 'postgres' ? `数据库连接主机: <code>${escapeHtml(cfg.host || 'PostgreSQL Server')}</code>, 数据库名: <code>${escapeHtml(cfg.database || 'nimbus')}</code>` : ''}
            ${activeEngine === 'mysql' ? `数据库连接主机: <code>${escapeHtml(cfg.host || 'MySQL Server')}</code>, 数据库名: <code>${escapeHtml(cfg.database || 'nimbus')}</code>` : ''}
          </p>
        </div>
      </div>

      <!-- Stats Grid -->
      <div class="db-stats-grid">
        <div class="db-stat-item">
          <div class="db-stat-val">${stats.usersCount}</div>
          <div class="db-stat-lbl">👥 注册用户</div>
        </div>
        <div class="db-stat-item">
          <div class="db-stat-val">${stats.vaultsCount}</div>
          <div class="db-stat-lbl">📚 笔记库 (Vaults)</div>
        </div>
        <div class="db-stat-item">
          <div class="db-stat-val">${stats.sharesCount}</div>
          <div class="db-stat-lbl">🔗 公开分享链接</div>
        </div>
        <div class="db-stat-item">
          <div class="db-stat-val">${stats.tokensCount}</div>
          <div class="db-stat-lbl">🔑 设备专属令牌</div>
        </div>
        <div class="db-stat-item">
          <div class="db-stat-val">${stats.rulesCount}</div>
          <div class="db-stat-lbl">🛡️ 规则与过滤配置</div>
        </div>
      </div>
    </div>

    <!-- Switch & Configure Engine Card -->
    <div class="settings-card">
      <div class="settings-card-header">
        <h3><span>🔄</span> 切换并更新数据库引擎 (Database Switch & Migration)</h3>
        <p>Nimbus 支持在 <b>JSON 文件</b>、<b>SQLite</b>、<b>PostgreSQL</b>、<b>MySQL</b> 间任意无缝切换，并支持一键数据平滑迁移</p>
      </div>

      <div style="margin-bottom:16px;">
        <span style="display:block;font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-secondary);">
          选择目标数据库存储引擎：
        </span>
        <div class="db-engine-grid">
          <div class="db-engine-opt ${activeEngine === 'json' ? 'selected' : ''}" data-type="json">
            <div class="db-engine-title">
              <span>📄 JSON 文件存储</span>
              ${activeEngine === 'json' ? '<span class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:11px;">当前使用</span>' : ''}
            </div>
            <div class="db-engine-desc">零配置、无外部依赖，数据直接保存在 JSON 文件，适合个人单机快速运行。</div>
          </div>

          <div class="db-engine-opt ${activeEngine === 'sqlite' ? 'selected' : ''}" data-type="sqlite">
            <div class="db-engine-title">
              <span>🗃️ SQLite 单文件数据库</span>
              ${activeEngine === 'sqlite' ? '<span class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:11px;">当前使用</span>' : ''}
            </div>
            <div class="db-engine-desc">嵌入式关系数据库，具备完整 ACID 事务与 WAL 读写并发，零网络延迟。</div>
          </div>

          <div class="db-engine-opt ${activeEngine === 'postgres' ? 'selected' : ''}" data-type="postgres">
            <div class="db-engine-title">
              <span>🐘 PostgreSQL 企业级关系库</span>
              ${activeEngine === 'postgres' ? '<span class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:11px;">当前使用</span>' : ''}
            </div>
            <div class="db-engine-desc">支持云数据库（Supabase、Neon、RDS、Cloud SQL），高并发强一致性。</div>
          </div>

          <div class="db-engine-opt ${activeEngine === 'mysql' ? 'selected' : ''}" data-type="mysql">
            <div class="db-engine-title">
              <span>🐬 MySQL / MariaDB</span>
              ${activeEngine === 'mysql' ? '<span class="badge" style="background:var(--accent-bg);color:var(--accent);font-size:11px;">当前使用</span>' : ''}
            </div>
            <div class="db-engine-desc">经典开源关系型数据库，适合分布式集群、主从架构及企业级运维环境。</div>
          </div>
        </div>
      </div>

      <!-- Dynamic Params Configuration Container -->
      <div id="db-config-fields-wrap" style="background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:18px;"></div>

      <!-- Migration Toggle -->
      <div class="form-checkbox-group" style="margin-bottom:20px;">
        <label class="form-checkbox-label">
          <input type="checkbox" id="db-migrate-data-checkbox" checked />
          <span><b>自动平滑迁移现有数据</b>（将当前数据库中的全部用户、Vaults、分享链接、系统设置等完整复制导入到新数据库中）</span>
        </label>
      </div>

      <!-- Action Buttons -->
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <button id="db-test-conn-btn" class="btn-secondary">
          🔍 测试目标数据库连接
        </button>
        ${isAdmin ? `<button id="db-switch-save-btn" class="btn-primary">🚀 保存并切换数据库引擎</button>` : '<span style="font-size:13px;color:var(--muted)">只有管理员有权限切换数据库配置</span>'}
      </div>

      <div id="db-action-feedback" style="margin-top:14px;"></div>
    </div>
  `;

  let selectedTargetType = activeEngine;

  function renderFieldsForEngine(type) {
    const wrap = container.querySelector('#db-config-fields-wrap');
    if (!wrap) return;

    if (type === 'json') {
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--text-secondary);">
          <span>ℹ️</span>
          <span><b>JSON 文件存储模式无需额外配置参数</b>。系统将把数据自动持久化保存于服务端的 <code>data/</code> 目录。</span>
        </div>
      `;
    } else if (type === 'sqlite') {
      wrap.innerHTML = `
        <h4 style="margin:0 0 12px;font-size:14px;">⚙️ SQLite 数据库配置参数</h4>
        <div class="settings-form-grid">
          <label style="margin:0;">
            <span>SQLite 数据库文件存储路径 (Path)</span>
            <input id="db-input-sqlite-path" value="${escapeHtml(cfg.sqlitePath || 'data/nimbus.sqlite')}" placeholder="data/nimbus.sqlite" />
            <div class="settings-help">支持相对路径或绝对路径，如果目标目录不存在将自动创建</div>
          </label>
        </div>
      `;
    } else if (type === 'postgres') {
      wrap.innerHTML = `
        <h4 style="margin:0 0 12px;font-size:14px;">🐘 PostgreSQL 数据库连接参数</h4>
        <div style="margin-bottom:14px;">
          <label style="margin:0;">
            <span>PostgreSQL 连接 URI (DATABASE_URL) <span style="font-weight:400;color:var(--muted);font-size:12px;">（优先使用，留空则使用下方分项配置）</span></span>
            <input id="db-input-pg-url" placeholder="postgresql://user:password@localhost:5432/nimbus?sslmode=disable" />
            <div class="settings-help">例如 Supabase / Neon / RDS 提供的连接 URI</div>
          </label>
        </div>

        <div class="settings-form-grid">
          <label style="margin:0;">
            <span>主机地址 (Host)</span>
            <input id="db-input-pg-host" value="${escapeHtml(cfg.host || 'localhost')}" placeholder="localhost" />
          </label>
          <label style="margin:0;">
            <span>端口 (Port)</span>
            <input id="db-input-pg-port" type="number" value="${cfg.port || 5432}" placeholder="5432" />
          </label>
          <label style="margin:0;">
            <span>数据库名 (Database)</span>
            <input id="db-input-pg-db" value="${escapeHtml(cfg.database || 'nimbus')}" placeholder="nimbus" />
          </label>
          <label style="margin:0;">
            <span>用户名 (User)</span>
            <input id="db-input-pg-user" value="${escapeHtml(cfg.user || 'postgres')}" placeholder="postgres" />
          </label>
          <label style="margin:0;">
            <span>密码 (Password)</span>
            <input id="db-input-pg-pass" type="password" placeholder="请输入数据库访问密码" />
          </label>
          <div style="grid-column:1 / -1;margin-top:6px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);">
            <label class="form-checkbox-label" style="margin:0 0 8px;">
              <input type="checkbox" id="db-input-pg-ssl" ${cfg.ssl ? 'checked' : ''} />
              <span><b>启用 SSL 加密传输</b> (云数据库如 Supabase / Neon / RDS 必须开启)</span>
            </label>
            <div id="db-pg-ssl-suboptions" style="display:${cfg.ssl ? 'block' : 'none'};padding-top:8px;margin-top:8px;border-top:1px dashed var(--border);">
              <label class="form-checkbox-label" style="margin:0 0 6px;">
                <input type="checkbox" id="db-input-pg-ssl-strict" ${cfg.sslRejectUnauthorized !== false ? 'checked' : ''} />
                <span><b>严格校验 CA 证书有效性</b>（推荐默认开启，杜绝中间人劫持风险）</span>
              </label>
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">若连接自签名内网数据库，取消勾选将忽略证书校验（仅测试环境使用）。</div>
              <label style="display:block;margin:0;">
                <span style="font-size:12px;color:var(--text-secondary);">自定义 CA 证书内容 (可选 PEM 格式):</span>
                <textarea id="db-input-pg-ssl-ca" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" style="width:100%;font-family:monospace;font-size:12px;margin-top:4px;box-sizing:border-box;">${escapeHtml(cfg.sslCa || '')}</textarea>
              </label>
            </div>
          </div>
        </div>
      `;
    } else if (type === 'mysql') {
      wrap.innerHTML = `
        <h4 style="margin:0 0 12px;font-size:14px;">🐬 MySQL / MariaDB 数据库连接参数</h4>
        <div class="settings-form-grid">
          <label style="margin:0;">
            <span>主机地址 (Host)</span>
            <input id="db-input-mysql-host" value="${escapeHtml(cfg.host || 'localhost')}" placeholder="localhost" />
          </label>
          <label style="margin:0;">
            <span>端口 (Port)</span>
            <input id="db-input-mysql-port" type="number" value="${cfg.port || 3306}" placeholder="3306" />
          </label>
          <label style="margin:0;">
            <span>数据库名 (Database)</span>
            <input id="db-input-mysql-db" value="${escapeHtml(cfg.database || 'nimbus')}" placeholder="nimbus" />
          </label>
          <label style="margin:0;">
            <span>用户名 (User)</span>
            <input id="db-input-mysql-user" value="${escapeHtml(cfg.user || 'root')}" placeholder="root" />
          </label>
          <label style="margin:0;">
            <span>密码 (Password)</span>
            <input id="db-input-mysql-pass" type="password" placeholder="请输入数据库访问密码" />
          </label>
        </div>
      `;
    }

    if (type === 'postgres') {
      const pgSslToggle = wrap.querySelector('#db-input-pg-ssl');
      if (pgSslToggle) {
        pgSslToggle.addEventListener('change', () => {
          const subopts = wrap.querySelector('#db-pg-ssl-suboptions');
          if (subopts) subopts.style.display = pgSslToggle.checked ? 'block' : 'none';
        });
      }
    }
  }

  renderFieldsForEngine(selectedTargetType);

  // Bind engine option clicks
  container.querySelectorAll('.db-engine-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      container.querySelectorAll('.db-engine-opt').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedTargetType = opt.dataset.type;
      renderFieldsForEngine(selectedTargetType);
    });
  });

  function collectConfigFromUI() {
    const type = selectedTargetType;
    if (type === 'json') return { type: 'json' };
    if (type === 'sqlite') {
      return {
        type: 'sqlite',
        sqlitePath: container.querySelector('#db-input-sqlite-path')?.value.trim() || 'data/nimbus.sqlite',
      };
    }
    if (type === 'postgres') {
      const pgUrl = container.querySelector('#db-input-pg-url')?.value.trim();
      const sslChecked = Boolean(container.querySelector('#db-input-pg-ssl')?.checked);
      const sslRejectUnauthorized = container.querySelector('#db-input-pg-ssl-strict')?.checked !== false;
      const sslCa = container.querySelector('#db-input-pg-ssl-ca')?.value.trim() || undefined;

      if (pgUrl) {
        return {
          type: 'postgres',
          connectionString: pgUrl,
          ssl: sslChecked,
          sslRejectUnauthorized,
          sslCa,
        };
      }
      return {
        type: 'postgres',
        host: container.querySelector('#db-input-pg-host')?.value.trim() || 'localhost',
        port: parseInt(container.querySelector('#db-input-pg-port')?.value, 10) || 5432,
        database: container.querySelector('#db-input-pg-db')?.value.trim() || 'nimbus',
        user: container.querySelector('#db-input-pg-user')?.value.trim() || 'postgres',
        password: container.querySelector('#db-input-pg-pass')?.value || '',
        ssl: sslChecked,
        sslRejectUnauthorized,
        sslCa,
      };
    }
    if (type === 'mysql') {
      return {
        type: 'mysql',
        host: container.querySelector('#db-input-mysql-host')?.value.trim() || 'localhost',
        port: parseInt(container.querySelector('#db-input-mysql-port')?.value, 10) || 3306,
        database: container.querySelector('#db-input-mysql-db')?.value.trim() || 'nimbus',
        user: container.querySelector('#db-input-mysql-user')?.value.trim() || 'root',
        password: container.querySelector('#db-input-mysql-pass')?.value || '',
      };
    }
    return { type: 'json' };
  }

  // Test connection
  container.querySelector('#db-test-conn-btn')?.addEventListener('click', async () => {
    const targetCfg = collectConfigFromUI();
    const fb = container.querySelector('#db-action-feedback');
    fb.innerHTML = '<span style="color:var(--muted);font-size:13px;">正在测试数据库连接…</span>';

    try {
      const res = await api('/api/settings/database/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetCfg),
      });
      const body = await res.json();
      if (body.ok) {
        fb.innerHTML = `<div style="padding:10px 14px;background:rgba(46,204,113,0.1);border:1px solid rgba(46,204,113,0.3);border-radius:6px;color:#2ecc71;font-size:13px;">✓ 连接测试成功: ${escapeHtml(body.message)}</div>`;
      } else {
        fb.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 连接失败: ${escapeHtml(body.error)}</div>`;
      }
    } catch (e) {
      fb.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 请求错误: ${escapeHtml(e.message)}</div>`;
    }
  });

  // Switch and migrate database
  container.querySelector('#db-switch-save-btn')?.addEventListener('click', async () => {
    const targetCfg = collectConfigFromUI();
    const doMigrate = container.querySelector('#db-migrate-data-checkbox')?.checked;

    const engineDisplayName = engineNames[targetCfg.type] || targetCfg.type.toUpperCase();
    const ok = await showConfirm({
      title: '切换数据库存储引擎',
      message: `确定要将数据库存储引擎切换为「${engineDisplayName}」吗？\n\n${doMigrate ? '✓ 已开启全量数据自动迁移，系统将平滑搬移现有用户与笔记配置。' : '⚠️ 未开启数据迁移，新数据库将从空白状态启动。'}`,
      confirmText: '确认切换',
      type: 'warning',
      icon: '🔄',
    });
    if (!ok) return;

    const fb = container.querySelector('#db-action-feedback');
    fb.innerHTML = '<span style="color:var(--accent);font-size:13px;">正在执行数据库切换与数据平滑迁移，请稍候…</span>';

    try {
      const res = await api('/api/settings/database/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetConfig: targetCfg, migrate: doMigrate }),
      });
      const body = await res.json();
      if (body.ok) {
        const counts = body.result?.counts || {};
        toast('数据库引擎切换成功！');
        fb.innerHTML = `
          <div style="padding:12px 16px;background:rgba(46,204,113,0.15);border:1px solid rgba(46,204,113,0.4);border-radius:6px;color:#2ecc71;font-size:13.5px;">
            <b>✓ 数据库切换成功！当前活跃引擎: ${escapeHtml(body.result?.activeEngine || targetCfg.type.toUpperCase())}</b>
            ${doMigrate ? `<div style="font-size:12.5px;color:var(--text);margin-top:6px;">已成功平滑迁移: ${counts.users || 0} 个用户、${counts.vaults || 0} 个 Vault、${counts.shares || 0} 条分享、${counts.apiTokens || 0} 个专属令牌。</div>` : ''}
          </div>
        `;
        setTimeout(() => renderDatabaseSettingsSubtab(container), 1500);
      } else {
        fb.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 切换失败: ${escapeHtml(body.error)}</div>`;
      }
    } catch (e) {
      fb.innerHTML = `<div style="padding:10px 14px;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);border-radius:6px;color:#e74c3c;font-size:13px;">✕ 执行失败: ${escapeHtml(e.message)}</div>`;
    }
  });

  translate(container);
}
