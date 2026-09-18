// --------------------------- Subtab: Git Auto-Backup ---------------------------
import { state, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showPrompt, showAlert, toast } from '../core/dialogs.js';

export async function renderGitSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">正在读取 Git 版本控制与远端同步状态…</div>';

  try {
    const [statusRes, configRes, logsRes] = await Promise.all([
      api(`/api/vaults/${vaultId}/git/status`),
      api(`/api/vaults/${vaultId}/git/config`),
      api(`/api/vaults/${vaultId}/git/logs?limit=20`),
    ]);

    const status = await statusRes.json();
    const config = await configRes.json();
    const logsData = await logsRes.json();
    const logs = logsData.logs || [];

    container.innerHTML = `
      <div class="git-subtab-container">
        <div class="git-header-card">
          <div class="git-header-main">
            <div class="git-status-badge-wrap">
              <span class="git-status-dot ${status.initialized ? (status.uncommittedCount > 0 ? 'warning' : 'success') : 'inactive'}"></span>
              <span class="git-status-title">${status.initialized ? 'Git 仓库就绪' : 'Git 仓库未初始化'}</span>
              ${status.branch ? `<span class="badge primary" style="font-family:monospace;font-size:11px;">🌿 ${escapeHtml(status.branch)}</span>` : ''}
            </div>
            <div class="git-remote-info">
              ${
                status.remoteUrl
                  ? `<span class="git-remote-url" title="${escapeHtml(status.remoteUrl)}">🔗 远端仓库：<code>${escapeHtml(status.remoteUrl)}</code></span>`
                  : '<span class="git-remote-url muted">🔗 暂未配置远端 Git 仓库地址</span>'
              }
            </div>
          </div>

          <div class="git-header-metrics">
            <div class="git-metric-item">
              <div class="metric-label">未提交变更</div>
              <div class="metric-val ${status.uncommittedCount > 0 ? 'highlight-warn' : ''}">${status.uncommittedCount || 0} 个文件</div>
            </div>
            <div class="git-metric-item">
              <div class="metric-label">待推送提交</div>
              <div class="metric-val ${status.unpushedCommits > 0 ? 'highlight-info' : ''}">${status.unpushedCommits || 0} 个 Commit</div>
            </div>
            <div class="git-metric-item" style="max-width:240px;">
              <div class="metric-label">最近一次提交</div>
              <div class="metric-val text-ellipsis" style="font-size:12px;">
                ${status.lastCommit ? `<code>${escapeHtml(status.lastCommit.shortHash)}</code> ${escapeHtml(status.lastCommit.message)}` : '<span class="muted">无提交记录</span>'}
              </div>
            </div>
            <div class="git-metric-item">
              <div class="metric-label">上次远端推送</div>
              <div class="metric-val" style="font-size:12px;">
                ${
                  status.lastPush
                    ? status.lastPush.success
                      ? `<span style="color:var(--success);">✅ 成功 (${new Date(status.lastPush.time).toLocaleTimeString()})</span>`
                      : `<span style="color:var(--danger);" title="${escapeHtml(status.lastPush.error || '')}">❌ 失败</span>`
                    : '<span class="muted">暂无推送记录</span>'
                }
              </div>
            </div>
          </div>

          <div class="git-header-actions">
            <button class="btn-primary" id="git-commit-push-btn">🚀 立即提交并推送</button>
            <button class="secondary" id="git-pull-btn">📥 拉取远端更新</button>
            <button class="secondary" id="git-test-btn">🔍 测试连通性</button>
            ${!status.initialized ? '<button class="secondary" id="git-init-btn">⚡ 初始化本地 Git 仓库</button>' : ''}
          </div>
        </div>

        <div class="git-main-grid">
          <div class="git-col-left">
            <div class="content-card" style="margin-bottom:16px;">
              <div class="card-header-bar">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="font-weight:600;font-size:14px;color:var(--text);">📝 本地工作区变更</span>
                  <span class="badge ${status.uncommittedCount > 0 ? 'warning' : ''}" style="font-size:11px;">${status.uncommittedCount || 0}</span>
                </div>
                ${
                  status.uncommittedCount > 0
                    ? '<button class="btn-secondary" id="git-quick-commit-btn" style="font-size:11px;padding:3px 8px;">提交这批变更</button>'
                    : ''
                }
              </div>
              <div class="card-inner" style="padding:12px;">
                ${
                  status.uncommittedCount > 0
                    ? `
                  <div class="git-changed-list">
                    ${(status.changedFiles || [])
                      .map(
                        (f) => `
                      <div class="git-changed-row">
                        <span class="git-code-badge ${f.code.includes('M') ? 'mod' : f.code.includes('A') || f.code.includes('?') ? 'add' : 'del'}">${escapeHtml(f.code)}</span>
                        <span class="git-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                `
                    : `
                  <div class="empty-state" style="padding:24px 12px;">
                    <div style="font-size:28px;margin-bottom:6px;">✨</div>
                    <div style="font-weight:600;font-size:13px;color:var(--text);">工作区干净</div>
                    <div style="font-size:12px;color:var(--muted);">当前笔记库所有文件均已保存并纳入 Git 版本控制</div>
                  </div>
                `
                }
              </div>
            </div>

            <div class="content-card">
              <div class="card-header-bar">
                <span style="font-weight:600;font-size:14px;color:var(--text);">📜 Git 提交历史 (最近 20 条)</span>
              </div>
              <div class="card-inner" style="padding:0;">
                ${
                  logs.length > 0
                    ? `
                  <div class="git-logs-list">
                    ${logs
                      .map(
                        (l) => `
                      <div class="git-log-item">
                        <div class="git-log-meta">
                          <code>${escapeHtml(l.shortHash)}</code>
                          <span class="git-log-author">${escapeHtml(l.author)}</span>
                          <span class="git-log-time" title="${escapeHtml(l.date)}">${escapeHtml(l.relativeTime)}</span>
                        </div>
                        <div class="git-log-msg">${escapeHtml(l.message)}</div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                `
                    : `
                  <div class="empty-state" style="padding:32px 16px;">
                    <div style="font-size:28px;margin-bottom:6px;">📜</div>
                    <div style="font-size:13px;color:var(--muted);">暂无 Git 提交历史，点击上方「立即提交并推送」创建首个提交快照</div>
                  </div>
                `
                }
              </div>
            </div>
          </div>

          <div class="git-col-right">
            <div class="content-card">
              <div class="card-header-bar">
                <span style="font-weight:600;font-size:14px;color:var(--text);">⚙️ Git 仓库与自动推送设置</span>
                <label class="switch-wrap" style="font-size:12px;">
                  <input type="checkbox" id="git-cfg-enabled" ${config.enabled ? 'checked' : ''} />
                  <span>启用 Git 备份</span>
                </label>
              </div>
              <div class="card-inner" style="padding:16px;">
                <form id="git-config-form" onsubmit="return false;">
                  <div class="form-group" style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">远端 Git 仓库地址 (Remote URL)</label>
                    <input type="text" id="git-cfg-url" placeholder="https://github.com/用户名/仓库名.git" value="${escapeHtml(config.remoteUrl || '')}" style="width:100%;font-size:12px;" />
                    <div style="font-size:11px;color:var(--muted);margin-top:3px;">支持 GitHub、Gitee、GitLab、Coding 或私有 Git 仓库</div>
                  </div>

                  <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                    <div class="form-group">
                      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">目标分支 (Branch)</label>
                      <input type="text" id="git-cfg-branch" placeholder="main" value="${escapeHtml(config.branch || 'main')}" style="width:100%;font-size:12px;" />
                    </div>
                    <div class="form-group">
                      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">认证用户名 (Username)</label>
                      <input type="text" id="git-cfg-username" placeholder="如 github-username" value="${escapeHtml(config.username || '')}" style="width:100%;font-size:12px;" />
                    </div>
                  </div>

                  <div class="form-group" style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">
                      访问令牌 / 密码 (Personal Access Token)
                      ${config.hasToken ? '<span class="badge success" style="font-size:10px;margin-left:4px;">已配置</span>' : ''}
                    </label>
                    <div style="display:flex;gap:6px;">
                      <input type="password" id="git-cfg-token" placeholder="${config.hasToken ? '******** (留空表示不修改)' : 'ghp_xxxxxxxxxxxxxx'}" style="flex:1;font-size:12px;" />
                      <button type="button" class="secondary" id="git-toggle-token-btn" style="font-size:11px;padding:3px 8px;">显示</button>
                    </div>
                  </div>

                  <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                    <div class="form-group">
                      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">Committer 姓名</label>
                      <input type="text" id="git-cfg-author-name" value="${escapeHtml(config.authorName || 'Nimbus Sync')}" style="width:100%;font-size:12px;" />
                    </div>
                    <div class="form-group">
                      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">Committer 邮箱</label>
                      <input type="text" id="git-cfg-author-email" value="${escapeHtml(config.authorEmail || 'sync@nimbus.local')}" style="width:100%;font-size:12px;" />
                    </div>
                  </div>

                  <div class="form-group" style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text);">提交说明模板 (Commit Template)</label>
                    <input type="text" id="git-cfg-template" value="${escapeHtml(config.commitMsgTemplate || 'Auto sync: {files_count} files changed [{datetime}]')}" style="width:100%;font-size:12px;" />
                  </div>

                  <div class="form-group" style="margin-bottom:14px;background:var(--panel-2);padding:10px;border-radius:6px;border:1px solid var(--border);">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px;cursor:pointer;">
                      <input type="checkbox" id="git-cfg-autopush" ${config.autoPushOnChange ? 'checked' : ''} />
                      <span>笔记修改后自动提交并推送 (实时防抖)</span>
                    </label>
                    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);padding-left:22px;">
                      <span>防抖延迟：</span>
                      <input type="number" id="git-cfg-debounce" value="${config.debounceSeconds || 15}" min="3" max="300" style="width:65px;padding:2px 6px;font-size:12px;" />
                      <span>秒</span>
                    </div>
                  </div>

                  <div class="form-group" style="margin-bottom:16px;">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text);cursor:pointer;">
                      <input type="checkbox" id="git-cfg-pull-before" ${config.pullBeforePush !== false ? 'checked' : ''} />
                      <span>推送前自动执行 <code>git pull --rebase</code> 合并远端</span>
                    </label>
                  </div>

                  <div style="display:flex;gap:8px;">
                    <button type="submit" class="btn-primary" id="git-save-config-btn" style="flex:1;">💾 保存 Git 设置</button>
                    <button type="button" class="secondary" id="git-test-config-btn">🔍 测试连接</button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const toggleTokenBtn = container.querySelector('#git-toggle-token-btn');
    const tokenInput = container.querySelector('#git-cfg-token');
    if (toggleTokenBtn && tokenInput) {
      toggleTokenBtn.onclick = () => {
        if (tokenInput.type === 'password') {
          tokenInput.type = 'text';
          toggleTokenBtn.textContent = '隐藏';
        } else {
          tokenInput.type = 'password';
          toggleTokenBtn.textContent = '显示';
        }
      };
    }

    container.querySelector('#git-save-config-btn').onclick = async () => {
      const payload = {
        enabled: container.querySelector('#git-cfg-enabled').checked,
        remoteUrl: container.querySelector('#git-cfg-url').value.trim(),
        branch: container.querySelector('#git-cfg-branch').value.trim() || 'main',
        username: container.querySelector('#git-cfg-username').value.trim(),
        token: tokenInput.value.trim() || (config.hasToken ? '********' : ''),
        authorName: container.querySelector('#git-cfg-author-name').value.trim() || 'Nimbus Sync',
        authorEmail: container.querySelector('#git-cfg-author-email').value.trim() || 'sync@nimbus.local',
        commitMsgTemplate: container.querySelector('#git-cfg-template').value.trim(),
        autoPushOnChange: container.querySelector('#git-cfg-autopush').checked,
        debounceSeconds: parseInt(container.querySelector('#git-cfg-debounce').value, 10) || 15,
        pullBeforePush: container.querySelector('#git-cfg-pull-before').checked,
      };

      try {
        const res = await api(`/api/vaults/${vaultId}/git/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.ok) {
          toast('Git 配置保存成功！');
          renderGitSubtab(vaultId, container);
        } else {
          toast('保存失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        toast('保存异常: ' + e.message);
      }
    };

    const runTestConnection = async () => {
      const testPayload = {
        remoteUrl: container.querySelector('#git-cfg-url').value.trim(),
        branch: container.querySelector('#git-cfg-branch').value.trim() || 'main',
        username: container.querySelector('#git-cfg-username').value.trim(),
        token: tokenInput.value.trim() || (config.hasToken ? '********' : ''),
      };

      toast('正在测试远端 Git 仓库连通性…');
      try {
        const res = await api(`/api/vaults/${vaultId}/git/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testPayload),
        });
        const data = await res.json();
        if (data.ok) {
          await showAlert({
            title: '🎉 连通性测试成功',
            message: data.message,
            type: 'primary',
            icon: '🎉',
          });
        } else {
          await showAlert({
            title: '❌ 连通性测试失败',
            message: data.error || '无法连接远端',
            type: 'danger',
            icon: '❌',
          });
        }
      } catch (e) {
        await showAlert({
          title: '❌ 连接请求异常',
          message: e.message,
          type: 'danger',
          icon: '❌',
        });
      }
    };

    container.querySelector('#git-test-btn').onclick = runTestConnection;
    container.querySelector('#git-test-config-btn').onclick = runTestConnection;

    const triggerCommitAndPush = async (customMsg) => {
      toast('正在执行 Git 提交与远端推送…');
      try {
        const res = await api(`/api/vaults/${vaultId}/git/commit-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: customMsg }),
        });
        const data = await res.json();
        if (data.ok) {
          toast('🎉 ' + (data.message || 'Git 提交并推送成功！'));
          renderGitSubtab(vaultId, container);
        } else {
          await showAlert({
            title: '❌ Git 操作失败',
            message: data.error || '请检查远端 URL 与权限配置',
            type: 'danger',
            icon: '❌',
          });
          renderGitSubtab(vaultId, container);
        }
      } catch (e) {
        toast('提交异常: ' + e.message);
      }
    };

    container.querySelector('#git-commit-push-btn').onclick = async () => {
      const msg = await showPrompt({
        title: '🚀 提交并推送至 Git 远端',
        message: '请输入本次 Git 提交说明（留空则自动使用默认模板）：',
        placeholder: '例如：更新会议纪要与阶段计划',
        icon: '🚀',
        confirmText: '确认并推送',
      });
      if (msg === null) return;
      triggerCommitAndPush(msg || undefined);
    };

    const quickCommitBtn = container.querySelector('#git-quick-commit-btn');
    if (quickCommitBtn) {
      quickCommitBtn.onclick = () => triggerCommitAndPush();
    }

    container.querySelector('#git-pull-btn').onclick = async () => {
      toast('正在从远端 Git 仓库拉取更新…');
      try {
        const res = await api(`/api/vaults/${vaultId}/git/pull`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          toast('🎉 ' + data.message);
          renderGitSubtab(vaultId, container);
        } else {
          await showAlert({
            title: '❌ Git 拉取失败',
            message: data.error || '未知错误',
            type: 'danger',
            icon: '❌',
          });
        }
      } catch (e) {
        toast('拉取异常: ' + e.message);
      }
    };

    const initBtn = container.querySelector('#git-init-btn');
    if (initBtn) {
      initBtn.onclick = async () => {
        try {
          await api(`/api/vaults/${vaultId}/git/init`, { method: 'POST' });
          toast('本地 Git 仓库初始化成功！');
          renderGitSubtab(vaultId, container);
        } catch (e) {
          toast('初始化失败: ' + e.message);
        }
      };
    }
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger);">读取 Git 状态失败: ${escapeHtml(err.message)}</div>`;
    translate(container);
  }
}
