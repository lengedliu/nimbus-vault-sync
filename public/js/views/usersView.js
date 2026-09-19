// --------------------------- View: User Accounts Management ---------------------------
import { state, $, escapeHtml, translate } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';

export async function renderUsersPanel(containerEl = null) {
  const container = containerEl || $('#main-panel');
  if (!container) return;

  container.innerHTML = '<div class="empty-state">正在加载用户列表…</div>';

  try {
    const res = await api('/api/users');
    const data = await res.json();
    const users = data.users || [];

    container.innerHTML = `
      <div class="users-container" style="max-width:960px;margin:0 auto;padding:16px 20px;">
        <div class="users-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:8px;">
              <span>👥</span>
              <span>系统用户与账号权限</span>
            </h2>
            <p style="margin:0;font-size:13px;color:var(--muted)">
              管理服务端所有用户账号、角色权限分配及密码重置
            </p>
          </div>
          <button class="btn-primary" id="btn-create-user" style="padding:6px 14px;font-size:12.5px;">+ 新建用户</button>
        </div>

        <div class="users-table-card" style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;text-align:left;">
            <thead>
              <tr style="background:var(--panel);border-bottom:1px solid var(--border);color:var(--muted);">
                <th style="padding:12px 16px;">用户名</th>
                <th style="padding:12px 16px;">角色</th>
                <th style="padding:12px 16px;">注册时间</th>
                <th style="padding:12px 16px;text-align:right;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                users
                  .map((u) => {
                    const isSelf = u.id === state.user?.id;
                    const isAdmin = u.role === 'admin';
                    return `
                      <tr style="border-bottom:1px solid var(--border);">
                        <td style="padding:12px 16px;font-weight:600;color:var(--text);">
                          ${escapeHtml(u.username)}
                          ${isSelf ? '<span class="badge" style="margin-left:6px;font-size:10.5px;background:var(--accent-bg);color:var(--accent);">当前登录</span>' : ''}
                        </td>
                        <td style="padding:12px 16px;">
                          <span class="badge" style="font-size:11px;background:${isAdmin ? 'rgba(234,88,12,0.15)' : 'rgba(88,166,255,0.15)'};color:${isAdmin ? '#ea580c' : '#58a6ff'};">
                            ${isAdmin ? '👑 管理员' : '👤 普通用户'}
                          </span>
                        </td>
                        <td style="padding:12px 16px;color:var(--muted);">
                          ${new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td style="padding:12px 16px;text-align:right;">
                          <button class="secondary btn-reset-user-pwd" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}" style="padding:3px 8px;font-size:11.5px;margin-right:6px;">重置密码</button>
                          ${
                            !isSelf
                              ? `<button class="secondary btn-del-user" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}" style="padding:3px 8px;font-size:11.5px;color:var(--danger);border-color:var(--danger);">删除</button>`
                              : ''
                          }
                        </td>
                      </tr>
                    `;
                  })
                  .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Add User Modal
    container.querySelector('#btn-create-user')?.addEventListener('click', () => {
      showModal(`
        <div class="modal-header">
          <h3>➕ 新建系统用户</h3>
          <button class="modal-close ghost">✕</button>
        </div>
        <div class="modal-body">
          <form id="add-user-form" onsubmit="return false;">
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">用户名 *</label>
              <input type="text" id="u-m-username" placeholder="请输入字母或数字" required style="width:100%;" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">密码 *</label>
              <input type="password" id="u-m-pwd" placeholder="至少 6 位字符" required style="width:100%;" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">系统角色</label>
              <select id="u-m-role" style="width:100%;">
                <option value="user">普通用户 (可管理自己所有的 Vault 与协作者)</option>
                <option value="admin">系统管理员 (拥有全局所有数据与设置控制权)</option>
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="secondary modal-close">取消</button>
          <button class="btn-primary" id="u-m-save-btn">创建用户</button>
        </div>
      `, (modal) => {
        modal.querySelector('#u-m-save-btn').onclick = async () => {
          const username = modal.querySelector('#u-m-username').value.trim();
          const password = modal.querySelector('#u-m-pwd').value;
          const role = modal.querySelector('#u-m-role').value;
          if (!username || !password) {
            toast('请完整填写用户名与密码');
            return;
          }
          try {
            const r = await api('/api/users', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password, role }),
            });
            const resData = await r.json();
            if (resData.ok) {
              closeModal();
              toast('用户创建成功！');
              renderUsersPanel(container);
            } else {
              toast('创建失败: ' + (resData.error || '未知错误'));
            }
          } catch (err) {
            toast('操作失败: ' + err.message);
          }
        };
      });
    });

    // Reset Password
    container.querySelectorAll('.btn-reset-user-pwd').forEach((btn) => {
      btn.onclick = () => {
        const userId = btn.dataset.userId;
        const uname = btn.dataset.username;
        showModal(`
          <div class="modal-header">
            <h3>🔑 重置用户密码 (${escapeHtml(uname)})</h3>
            <button class="modal-close ghost">✕</button>
          </div>
          <div class="modal-body">
            <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:4px;">新密码 *</label>
            <input type="password" id="u-m-new-pwd" placeholder="请输入新密码" style="width:100%;margin-bottom:12px;" />
          </div>
          <div class="modal-footer">
            <button class="secondary modal-close">取消</button>
            <button class="btn-primary" id="u-m-save-pwd-btn">保存新密码</button>
          </div>
        `, (modal) => {
          modal.querySelector('#u-m-save-pwd-btn').onclick = async () => {
            const newPassword = modal.querySelector('#u-m-new-pwd').value;
            if (!newPassword || newPassword.length < 6) {
              toast('密码长度不得少于 6 位');
              return;
            }
            try {
              const r = await api(`/api/users/${userId}/password`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: newPassword }),
              });
              const d = await r.json();
              if (d.ok) {
                closeModal();
                toast('密码重置成功！');
              } else {
                toast('重置失败: ' + (d.error || '未知错误'));
              }
            } catch (err) {
              toast('操作失败: ' + err.message);
            }
          };
        });
      };
    });

    // Delete User
    container.querySelectorAll('.btn-del-user').forEach((btn) => {
      btn.onclick = async () => {
        const userId = btn.dataset.userId;
        const uname = btn.dataset.username;
        const ok = await showConfirm({
          title: '删除用户账号',
          message: `确定彻底删除用户「${uname}」吗？此操作将同时吊销其名下所有的设备与权限。`,
          confirmText: '确认删除',
          type: 'danger',
        });
        if (!ok) return;
        try {
          const r = await api(`/api/users/${userId}`, { method: 'DELETE' });
          const d = await r.json();
          if (d.ok) {
            toast('用户已删除');
            renderUsersPanel(container);
          } else {
            toast('删除失败: ' + (d.error || '未知错误'));
          }
        } catch (err) {
          toast('删除失败: ' + err.message);
        }
      };
    });

    translate(container);
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="empty-state">加载用户列表失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}
