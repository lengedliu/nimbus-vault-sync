import { state, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/dialogs.js';

export async function renderCloudBackupSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">正在读取多云容灾与异地备份配置…</div>';

  try {
    const res = await api(`/api/vaults/${vaultId}/cloud-backup/config`);
    const data = await res.json();
    const config = data.config || {
      enabled: false,
      provider: 's3',
      s3: { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', pathPrefix: 'nimbus-backups', region: 'us-east-1' },
      webdav: { url: '', username: '', password: '', pathPrefix: '/nimbus-backups' },
      lastBackupAt: null,
      lastBackupStatus: null,
    };

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom:14px;">
        <div>
          <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:6px;">
            <span>☁️</span>
            <span>多云异地容灾与对象存储备份 (Multi-Cloud Disaster Recovery)</span>
          </h3>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
            自动将本 Vault 的全量加密快照定时同步推送至 S3 / Aliyun OSS / Tencent COS / Cloudflare R2 / MinIO 或 WebDAV / NAS 异地存储，防止单点系统灾难。
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:16px;">
        <!-- Left Column: Config Panel -->
        <div class="content-card" style="padding:16px;">
          <div style="font-weight:700;font-size:14px;color:var(--text);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;">
            <span>⚙️ 异地容灾通道配置</span>
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;">
              <input type="checkbox" id="cloud-enabled-chk" ${config.enabled ? 'checked' : ''} />
              <b style="color:var(--primary)">开启多云异地容灾备份</b>
            </label>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">存储通道类型 (Storage Provider)</label>
            <select id="cloud-provider-sel" style="width:100%;padding:6px 10px;font-size:13px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);">
              <option value="s3" ${config.provider === 's3' ? 'selected' : ''}>☁️ S3 / 对象存储 (AWS, Aliyun OSS, COS, R2, MinIO)</option>
              <option value="webdav" ${config.provider === 'webdav' ? 'selected' : ''}>📁 WebDAV / 异地 NAS (Nextcloud, 坚果云, Synology)</option>
            </select>
          </div>

          <!-- S3 Fields -->
          <div id="s3-fields-box" style="display:${config.provider === 's3' ? 'block' : 'none'};border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">Endpoint 访问域名 (Endpoint)</label>
              <input type="text" id="s3-endpoint" value="${escapeHtml(config.s3.endpoint || '')}" placeholder="例如 https://oss-cn-hangzhou.aliyuncs.com 或 https://s3.us-east-1.amazonaws.com" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">存储桶名称 (Bucket)</label>
                <input type="text" id="s3-bucket" value="${escapeHtml(config.s3.bucket || '')}" placeholder="例: my-vault-backups" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
              </div>
              <div>
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">区域 (Region)</label>
                <input type="text" id="s3-region" value="${escapeHtml(config.s3.region || 'us-east-1')}" placeholder="例: us-east-1" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
              </div>
            </div>
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">Access Key ID</label>
              <input type="text" id="s3-ak" value="${escapeHtml(config.s3.accessKeyId || '')}" placeholder="LTAI5t..." style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">Secret Access Key</label>
              <input type="password" id="s3-sk" value="${escapeHtml(config.s3.secretAccessKey || '')}" placeholder="••••••••••••••••••••••••" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">云端保存前缀 (Path Prefix)</label>
              <input type="text" id="s3-prefix" value="${escapeHtml(config.s3.pathPrefix || 'nimbus-backups')}" placeholder="nimbus-backups" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
          </div>

          <!-- WebDAV Fields -->
          <div id="webdav-fields-box" style="display:${config.provider === 'webdav' ? 'block' : 'none'};border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">WebDAV 服务器 URL</label>
              <input type="text" id="webdav-url" value="${escapeHtml(config.webdav.url || '')}" placeholder="https://dav.jianguoyun.com/dav/ 或 https://nas.local:5006/dav/" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">账号 (Username)</label>
                <input type="text" id="webdav-user" value="${escapeHtml(config.webdav.username || '')}" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
              </div>
              <div>
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">密码 / 应用授权码</label>
                <input type="password" id="webdav-pass" value="${escapeHtml(config.webdav.password || '')}" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
              </div>
            </div>
            <div style="margin-bottom:10px;">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">远程目录前缀 (Path Prefix)</label>
              <input type="text" id="webdav-prefix" value="${escapeHtml(config.webdav.pathPrefix || '/nimbus-backups')}" placeholder="/nimbus-backups" style="width:100%;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);" />
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:16px;">
            <button class="btn-primary" id="save-cloud-config-btn" style="flex:1;">💾 保存容灾配置</button>
            <button class="secondary" id="test-cloud-config-btn">🔍 测试连通性</button>
          </div>
        </div>

        <!-- Right Column: Status & Run Panel -->
        <div class="content-card" style="padding:16px;display:flex;flex-direction:column;justify-space:between;">
          <div>
            <div style="font-weight:700;font-size:14px;color:var(--text);margin-bottom:12px;">📊 多云备份与灾难恢复状态</div>

            <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;font-size:12.5px;line-height:1.6;">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span style="color:var(--muted);">容灾通道状态:</span>
                <span style="font-weight:600;color:${config.enabled ? 'var(--success)' : 'var(--muted)'}">
                  ${config.enabled ? '🟢 已启用 (' + config.provider.toUpperCase() + ')' : '⚪ 未启用'}
                </span>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span style="color:var(--muted);">上次灾备时间:</span>
                <span style="font-weight:500;color:var(--text);">
                  ${config.lastBackupAt ? new Date(config.lastBackupAt).toLocaleString() : '暂无备份记录'}
                </span>
              </div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
                <span style="color:var(--muted);display:block;margin-bottom:4px;">最新灾备结果:</span>
                ${
                  config.lastBackupStatus
                    ? config.lastBackupStatus.success
                      ? `<div style="color:var(--success);font-weight:600;">✅ ${escapeHtml(config.lastBackupStatus.message)}</div>`
                      : `<div style="color:var(--danger);font-weight:600;">❌ ${escapeHtml(config.lastBackupStatus.message)}</div>`
                    : '<div style="color:var(--muted)">尚未执行异地容灾备份</div>'
                }
              </div>
            </div>

            <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:16px;">
              💡 <b>多云容灾建议</b>：建议结合本地物理备份与多云对象存储（如 Aliyun OSS、Cloudflare R2 或 NAS），实现 3-2-1 备份策略（3份副本、2种介质、1份异地备份）。
            </div>
          </div>

          <button class="btn-primary" id="run-cloud-backup-btn" style="padding:10px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;">
            <span>🚀 立即执行异地全库容灾备份</span>
          </button>
        </div>
      </div>
    `;

    // Event listeners
    const providerSel = container.querySelector('#cloud-provider-sel');
    const s3Box = container.querySelector('#s3-fields-box');
    const webdavBox = container.querySelector('#webdav-fields-box');

    providerSel.onchange = () => {
      const p = providerSel.value;
      s3Box.style.display = p === 's3' ? 'block' : 'none';
      webdavBox.style.display = p === 'webdav' ? 'block' : 'none';
    };

    function readFormConfig() {
      return {
        enabled: container.querySelector('#cloud-enabled-chk').checked,
        provider: providerSel.value,
        s3: {
          endpoint: container.querySelector('#s3-endpoint').value.trim(),
          bucket: container.querySelector('#s3-bucket').value.trim(),
          region: container.querySelector('#s3-region').value.trim() || 'us-east-1',
          accessKeyId: container.querySelector('#s3-ak').value.trim(),
          secretAccessKey: container.querySelector('#s3-sk').value.trim(),
          pathPrefix: container.querySelector('#s3-prefix').value.trim() || 'nimbus-backups',
        },
        webdav: {
          url: container.querySelector('#webdav-url').value.trim(),
          username: container.querySelector('#webdav-user').value.trim(),
          password: container.querySelector('#webdav-pass').value.trim(),
          pathPrefix: container.querySelector('#webdav-prefix').value.trim() || '/nimbus-backups',
        },
        lastBackupAt: config.lastBackupAt,
        lastBackupStatus: config.lastBackupStatus,
      };
    }

    container.querySelector('#save-cloud-config-btn').onclick = async () => {
      const newCfg = readFormConfig();
      try {
        const r = await api(`/api/vaults/${vaultId}/cloud-backup/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newCfg),
        });
        const body = await r.json();
        if (body.ok) {
          toast('✅ 多云异地容灾配置已保存！');
          renderCloudBackupSubtab(vaultId, container);
        }
      } catch (e) {
        toast('❌ 保存配置失败: ' + e.message, 'error');
      }
    };

    container.querySelector('#test-cloud-config-btn').onclick = async () => {
      const newCfg = readFormConfig();
      toast('正在测试连通性，请稍候…');
      try {
        const r = await api(`/api/vaults/${vaultId}/cloud-backup/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newCfg),
        });
        const body = await r.json();
        if (body.ok) {
          toast(`✅ ${body.message || '连通性测试通过！'}`);
        } else {
          toast(`❌ 连通性测试失败: ${body.error}`, 'error');
        }
      } catch (e) {
        toast(`❌ 连通性测试失败: ${e.message}`, 'error');
      }
    };

    container.querySelector('#run-cloud-backup-btn').onclick = async () => {
      const newCfg = readFormConfig();
      if (!newCfg.enabled) {
        toast('⚠️ 请先勾选「开启多云异地容灾备份」并保存配置', 'warn');
        return;
      }
      toast('🚀 正在生成快照并推送到异地存储，请稍候…');
      try {
        const r = await api(`/api/vaults/${vaultId}/cloud-backup/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: '手动多云容灾备份' }),
        });
        const body = await r.json();
        if (body.ok) {
          toast(`🎉 异地容灾备份推送到 ${body.provider.toUpperCase()} 成功！`);
          renderCloudBackupSubtab(vaultId, container);
        } else {
          toast(`❌ 容灾备份失败: ${body.error}`, 'error');
        }
      } catch (e) {
        toast(`❌ 容灾备份失败: ${e.message}`, 'error');
      }
    };

  } catch (err) {
    container.innerHTML = `<div class="empty-state error">加载异地容灾配置失败: ${escapeHtml(err.message)}</div>`;
  }
}
