// --------------------------- Subtab: Stats & Online Devices ---------------------------
import { escapeHtml, formatBytes, translate } from '../core/state.js';
import { api } from '../core/api.js';

export async function renderStatsSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">统计数据加载中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/stats`);
    const { stats, connectedDevices, activity } = await res.json();

    const devices = connectedDevices || [];

    let devicesHtml = '';
    if (devices.length === 0) {
      devicesHtml = `
        <div class="empty-state" style="padding:24px;background:var(--panel);border:1px dashed var(--border);border-radius:var(--radius);">
          <div style="font-size:28px;margin-bottom:6px;">📡</div>
          <div style="font-weight:600;color:var(--text);">当前暂无在线连接的客户端设备</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:4px;">
            在 Obsidian 中打开并配置 <strong>Nimbus Sync</strong> 插件后，连接成功的设备将实时显示在此处。
          </div>
        </div>
      `;
    } else {
      devicesHtml = `
        <div class="device-grid">
          ${devices.map((d) => `
            <div class="device-card">
              <div class="device-card-header">
                <div class="device-icon">💻</div>
                <div class="device-info">
                  <div class="device-name">${escapeHtml(d.deviceName || 'Obsidian Client')}</div>
                  <div class="device-user">用户: ${escapeHtml(d.username || '当前用户')}</div>
                </div>
                <span class="device-status-badge online"><span class="pulse-dot"></span> 在线</span>
              </div>
              <div class="device-meta">
                <span>⏱️ 已连接: ${new Date(d.connectedAt).toLocaleTimeString()}</span>
                <span>⚡ 实时 WebSocket 双向同步</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">总文件数</div>
          <div class="stat-value">${stats.totalFiles}</div>
          <div class="stat-desc">Markdown: ${stats.notesCount} 篇 · 附件: ${stats.attachmentsCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">存储空间</div>
          <div class="stat-value">${formatBytes(stats.totalBytes)}</div>
          <div class="stat-desc">配置占用: ${stats.configsCount} 项</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">在线同步设备</div>
          <div class="stat-value" style="color:var(--success)">${stats.activeClients} <span style="font-size:14px">台</span></div>
          <div class="stat-desc">实时 WebSocket 同步中</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">版本与回收站</div>
          <div class="stat-value">${stats.historyCount} <span style="font-size:14px">版本</span></div>
          <div class="stat-desc">回收站 ${stats.trashCount} 个待清理</div>
        </div>
      </div>

      <div class="panel-header" style="margin-top:20px;margin-bottom:12px;">
        <div>
          <h3 style="margin:0;font-size:16px;">📱 当前在线同步设备 (${devices.length})</h3>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">实时追踪已接入此 Vault 的 Obsidian 客户端与编辑节点</div>
        </div>
        <button class="secondary" id="refresh-devices-btn">🔄 刷新设备与状态</button>
      </div>

      ${devicesHtml}

      <div class="panel-header" style="margin-top:28px">
        <h3 style="margin:0;font-size:16px;">⚡ 实时同步活动流</h3>
      </div>

      <ul class="activity-list" id="stats-activity-list"></ul>
    `;

    container.querySelector('#refresh-devices-btn').onclick = () => renderStatsSubtab(vaultId, container);

    const listEl = container.querySelector('#stats-activity-list');
    if (!activity || activity.length === 0) {
      listEl.innerHTML = '<li style="color:var(--muted);text-align:center;padding:20px;">暂无近期同步活动</li>';
      return;
    }

    for (const act of activity) {
      const li = document.createElement('li');
      li.className = 'activity-item';
      const typeClass = act.type;
      const typeLabel = act.type === 'change' ? '更新/推送' : act.type === 'delete' ? '删除' : '产生冲突';
      li.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="activity-type ${typeClass}">${typeLabel}</span>
          <span style="font-weight:500;">${escapeHtml(act.path)}</span>
          ${act.conflictPath ? `<span style="font-size:12px;color:var(--warning)">→ ${escapeHtml(act.conflictPath)}</span>` : ''}
        </div>
        <span class="meta">${new Date(act.timestamp).toLocaleTimeString()}</span>
      `;
      listEl.appendChild(li);
    }
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载统计数据失败: ${escapeHtml(err.message || '网络错误')}</div>`;
  }
}
