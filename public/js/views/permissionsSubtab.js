// --------------------------- Subtab: Permissions & Members ---------------------------
import { escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { showConfirm, toast } from '../core/dialogs.js';

export async function renderPermissionsSubtab(vaultId, container) {
  container.innerHTML = '<div class="empty-state">加载成员与权限信息中…</div>';
  try {
    const res = await api(`/api/vaults/${vaultId}/permissions`);
    const data = await res.json();

    const { vault, myPermission, isOwner, isAdmin, members, allUsers } = data;
    const canManage = isOwner || isAdmin;

    const existingUserIds = new Set([vault.ownerId, ...members.map((m) => m.userId)]);
    const candidateUsers = (allUsers || []).filter((u) => !existingUserIds.has(u.id));

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom:16px;">
        <div>
          <h3 style="margin:0;font-size:16px;display:flex;align-items:center;gap:8px;">
            <span>👥</span>
            <span>笔记库权限与成员管理</span>
          </h3>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
            当前 Vault: <b>${escapeHtml(vault.name)}</b> · 创建者: <b>${escapeHtml(vault.ownerUsername)}</b>
            ${isOwner ? ' <span class="badge primary" style="font-size:11px">您是所有者</span>' : ''}
            ${!isOwner ? ` <span class="badge ${myPermission === 'read-only' ? 'warning' : 'success'}" style="font-size:11px">您的权限: ${myPermission === 'read-only' ? '只读' : '读写'}</span>` : ''}
          </div>
        </div>
      </div>

      ${canManage ? `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;">
            <span>➕</span> 授权/添加协作成员
          </h4>
          <div style="display:grid;grid-template-columns:minmax(180px, 1fr) 180px auto;gap:12px;align-items:end;">
            <label style="margin:0;">
              <span style="font-size:12.5px;color:var(--text-secondary);display:block;margin-bottom:4px;">选择用户</span>
              ${candidateUsers.length > 0 ? `
                <select id="perm-user-select" style="margin:0;">
                  <option value="">-- 请选择要授权的用户 --</option>
                  ${candidateUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.username)} (${u.role === 'admin' ? '管理员' : '普通用户'})</option>`).join('')}
                </select>
              ` : `
                <input id="perm-username-input" placeholder="输入已存在的用户名" style="margin:0;" />
              `}
            </label>
            <label style="margin:0;">
              <span style="font-size:12.5px;color:var(--text-secondary);display:block;margin-bottom:4px;">赋予权限</span>
              <select id="perm-type-select" style="margin:0;">
                <option value="read-write">读写 (Read & Write) - 允许同步修改</option>
                <option value="read-only">只读 (Read Only) - 仅允许拉取与查看</option>
              </select>
            </label>
            <button id="add-member-btn" class="btn-primary" style="margin:0;height:38px;">＋ 确认授权</button>
          </div>
        </div>
      ` : `
        <div style="background:rgba(88,166,255,0.08);border:1px solid rgba(88,166,255,0.2);border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:13px;color:var(--text-secondary);">
          ℹ️ 您当前作为协作成员访问此 Vault。只有该 Vault 的创建者 (<b>${escapeHtml(vault.ownerUsername)}</b>) 或系统管理员可以修改成员权限。
        </div>
      `}

      <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:600;font-size:13.5px;display:flex;align-items:center;justify-content:space-between;">
          <span>当前成员列表 (${members.length + 1} 人)</span>
          <span style="font-size:12px;color:var(--muted);font-weight:normal;">所有者享有最高管理与删除权限</span>
        </div>
        <table class="data-table" style="width:100%;margin:0;">
          <thead>
            <tr>
              <th>用户名</th>
              <th>系统角色</th>
              <th>Vault 权限级别</th>
              <th>授权时间</th>
              ${canManage ? '<th style="text-align:right">操作</th>' : ''}
            </tr>
          </thead>
          <tbody id="perm-members-tbody">
            <tr style="background:rgba(255,255,255,0.02);">
              <td>
                <b style="display:inline-flex;align-items:center;gap:6px;">
                  <span>👑</span>
                  <span>${escapeHtml(vault.ownerUsername)}</span>
                </b>
                <span class="badge primary" style="font-size:10px;margin-left:6px;">所有者 (Owner)</span>
              </td>
              <td><span class="badge">所有者</span></td>
              <td>
                <span class="badge primary" style="font-size:11px;">全部权限 (所有者)</span>
              </td>
              <td class="meta">${new Date(vault.createdAt).toLocaleString()}</td>
              ${canManage ? '<td style="text-align:right;color:var(--muted);font-size:12px;">创建者 (不可撤销)</td>' : ''}
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const tbody = container.querySelector('#perm-members-tbody');

    for (const m of members) {
      const tr = document.createElement('tr');
      const isRw = m.permission === 'read-write';
      const permBadge = isRw
        ? '<span class="badge success" style="font-size:11px;">✏️ 读写 (Read-Write)</span>'
        : '<span class="badge warning" style="font-size:11px;">👁️ 只读 (Read-Only)</span>';

      tr.innerHTML = `
        <td>
          <b>👤 ${escapeHtml(m.username)}</b>
        </td>
        <td><span class="badge">${m.role}</span></td>
        <td>
          ${canManage ? `
            <select class="member-perm-change-select" data-user-id="${m.userId}" style="padding:3px 8px;font-size:12px;border-radius:4px;margin:0;width:auto;">
              <option value="read-write" ${isRw ? 'selected' : ''}>✏️ 读写 (可同步修改)</option>
              <option value="read-only" ${!isRw ? 'selected' : ''}>👁️ 只读 (仅查看拉取)</option>
            </select>
          ` : permBadge}
        </td>
        <td class="meta">${new Date(m.createdAt).toLocaleString()}</td>
        ${canManage ? `
          <td class="actions" style="text-align:right">
            <button class="danger revoke-member-btn" data-user-id="${m.userId}" data-username="${escapeHtml(m.username)}" style="font-size:12px;padding:4px 10px;">移除权限</button>
          </td>
        ` : ''}
      `;
      tbody.appendChild(tr);
    }

    if (canManage) {
      const addBtn = container.querySelector('#add-member-btn');
      if (addBtn) {
        addBtn.onclick = async () => {
          const userSelect = container.querySelector('#perm-user-select');
          const usernameInput = container.querySelector('#perm-username-input');
          const permSelect = container.querySelector('#perm-type-select');

          const userId = userSelect ? userSelect.value : undefined;
          const username = usernameInput ? usernameInput.value.trim() : undefined;
          const permission = permSelect.value;

          if (!userId && !username) {
            toast('请选择或输入要授权的用户');
            return;
          }

          try {
            await api(`/api/vaults/${vaultId}/permissions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, username, permission }),
            });
            toast('成员权限授权成功');
            renderPermissionsSubtab(vaultId, container);
          } catch (e) {
            toast('授权失败: ' + e.message);
          }
        };
      }

      container.querySelectorAll('.member-perm-change-select').forEach((sel) => {
        sel.onchange = async () => {
          const targetUserId = sel.dataset.userId;
          const newPerm = sel.value;
          try {
            await api(`/api/vaults/${vaultId}/permissions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: targetUserId, permission: newPerm }),
            });
            toast('已更新成员权限');
          } catch (e) {
            toast('更新失败: ' + e.message);
            renderPermissionsSubtab(vaultId, container);
          }
        };
      });

      container.querySelectorAll('.revoke-member-btn').forEach((btn) => {
        btn.onclick = async () => {
          const targetUserId = btn.dataset.userId;
          const targetUsername = btn.dataset.username;
          const ok = await showConfirm({
            title: '撤销成员访问权限',
            message: `确定撤销用户「${targetUsername}」对该笔记库的访问权限吗？`,
            confirmText: '撤销权限',
            type: 'danger',
            icon: '👤',
          });
          if (!ok) return;
          try {
            await api(`/api/vaults/${vaultId}/permissions/${targetUserId}`, {
              method: 'DELETE',
            });
            toast(`已撤销 "${targetUsername}" 的权限`);
            renderPermissionsSubtab(vaultId, container);
          } catch (e) {
            toast('撤销失败: ' + e.message);
          }
        };
      });
    }
    translate(container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">加载权限配置失败: ${escapeHtml(err.message)}</div>`;
    translate(container);
  }
}
