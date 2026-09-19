// --------------------------- Modal, Alert, Confirm, Prompt & Toast Dialogs ---------------------------
import { $, escapeHtml, translate } from './state.js';

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function showConfirm(options) {
  return new Promise((resolve) => {
    let title = '操作确认';
    let message = '确定要执行此操作吗？';
    let confirmText = '确定';
    let cancelText = '取消';
    let type = 'danger';
    let icon = '⚠️';

    if (typeof options === 'string') {
      message = options;
      if (options.includes('退出') || options.includes('注销登录')) {
        icon = '🚪';
        title = '退出登录确认';
        confirmText = '确认退出';
        type = 'danger';
      } else if (options.includes('回收站')) {
        icon = '🗑️';
        title = '移入回收站确认';
        confirmText = '移至回收站';
        type = 'danger';
      } else if (options.includes('令牌') || options.includes('Token')) {
        icon = '🔑';
        title = '注销令牌确认';
        confirmText = '确认注销';
        type = 'danger';
      } else if (options.includes('数据库') || options.includes('迁移') || options.includes('存储引擎')) {
        icon = '🔄';
        title = '切换存储引擎确认';
        confirmText = '确认切换';
        type = 'warning';
      } else if (options.includes('删除') || options.includes('废除') || options.includes('清空') || options.includes('丢弃') || options.includes('撤销')) {
        icon = '🗑️';
        title = '操作确认';
        confirmText = '确认执行';
        type = 'danger';
      } else if (options.includes('回滚') || options.includes('恢复')) {
        icon = '⏱️';
        title = '版本回滚确认';
        confirmText = '确认回滚';
        type = 'warning';
      }
    } else if (options && typeof options === 'object') {
      if (options.title) title = options.title;
      if (options.message) message = options.message;
      if (options.confirmText) confirmText = options.confirmText;
      if (options.cancelText) cancelText = options.cancelText;
      if (options.type) type = options.type;
      if (options.icon) icon = options.icon;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-dialog-card" role="dialog" aria-modal="true">
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-icon ${type}">${icon}</div>
          <div class="confirm-dialog-title-wrap">
            <h4 class="confirm-dialog-title">${escapeHtml(title)}</h4>
            <div class="confirm-dialog-msg">${typeof message === 'string' ? escapeHtml(message).replace(/\n/g, '<br>') : message}</div>
          </div>
        </div>
        <div class="confirm-dialog-footer">
          <button type="button" class="btn-cancel secondary" style="min-width:70px;">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn-confirm ${type === 'danger' ? 'danger' : type === 'warning' ? 'btn-primary' : 'btn-primary'}" style="${type === 'warning' ? 'background:#d29922;border-color:#bb8009;' : ''} min-width:85px;">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    translate(backdrop);
    document.body.appendChild(backdrop);

    let closed = false;
    const cleanup = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keyHandler);
      backdrop.style.opacity = '0';
      backdrop.style.transition = 'opacity 0.12s ease';
      setTimeout(() => backdrop.remove(), 130);
      resolve(result);
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(true);
      }
    };
    document.addEventListener('keydown', keyHandler);

    backdrop.querySelector('.btn-cancel').onclick = (e) => {
      e.stopPropagation();
      cleanup(false);
    };
    backdrop.querySelector('.btn-confirm').onclick = (e) => {
      e.stopPropagation();
      cleanup(true);
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) cleanup(false);
    };

    setTimeout(() => {
      const btn = backdrop.querySelector('.btn-confirm');
      if (btn) btn.focus();
    }, 40);
  });
}

export function showAlert(options) {
  return new Promise((resolve) => {
    let title = '提示';
    let message = '';
    let confirmText = '确定';
    let type = 'primary';
    let icon = 'ℹ️';

    if (typeof options === 'string') {
      message = options;
      if (options.includes('❌') || options.includes('失败') || options.includes('错误')) {
        icon = '❌';
        type = 'danger';
        title = '操作失败';
      } else if (options.includes('🎉') || options.includes('成功') || options.includes('✅')) {
        icon = '🎉';
        type = 'primary';
        title = '操作成功';
      } else if (options.includes('⚠️') || options.includes('警告')) {
        icon = '⚠️';
        type = 'warning';
        title = '警告提示';
      }
    } else if (options && typeof options === 'object') {
      if (options.title) title = options.title;
      if (options.message) message = options.message;
      if (options.confirmText) confirmText = options.confirmText;
      if (options.type) type = options.type;
      if (options.icon) icon = options.icon;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-dialog-card" role="dialog" aria-modal="true">
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-icon ${type}">${icon}</div>
          <div class="confirm-dialog-title-wrap">
            <h4 class="confirm-dialog-title">${escapeHtml(title)}</h4>
            <div class="confirm-dialog-msg">${typeof message === 'string' ? escapeHtml(message).replace(/\n/g, '<br>') : message}</div>
          </div>
        </div>
        <div class="confirm-dialog-footer">
          <button type="button" class="btn-confirm btn-primary" style="min-width:85px;">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    translate(backdrop);
    document.body.appendChild(backdrop);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keyHandler);
      backdrop.style.opacity = '0';
      backdrop.style.transition = 'opacity 0.12s ease';
      setTimeout(() => backdrop.remove(), 130);
      resolve(true);
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        cleanup();
      }
    };
    document.addEventListener('keydown', keyHandler);

    backdrop.querySelector('.btn-confirm').onclick = (e) => {
      e.stopPropagation();
      cleanup();
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) cleanup();
    };

    setTimeout(() => {
      const btn = backdrop.querySelector('.btn-confirm');
      if (btn) btn.focus();
    }, 40);
  });
}

export function showPrompt(options) {
  return new Promise((resolve) => {
    let title = '请输入';
    let message = '';
    let defaultValue = '';
    let placeholder = '';
    let confirmText = '确定';
    let cancelText = '取消';
    let icon = '✏️';
    let type = 'primary';

    if (typeof options === 'string') {
      message = options;
    } else if (options && typeof options === 'object') {
      if (options.title) title = options.title;
      if (options.message) message = options.message;
      if (options.defaultValue !== undefined) defaultValue = options.defaultValue;
      if (options.placeholder) placeholder = options.placeholder;
      if (options.confirmText) confirmText = options.confirmText;
      if (options.cancelText) cancelText = options.cancelText;
      if (options.icon) icon = options.icon;
      if (options.type) type = options.type;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-dialog-card" role="dialog" aria-modal="true" style="max-width:480px;">
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-icon ${type}">${icon}</div>
          <div class="confirm-dialog-title-wrap">
            <h4 class="confirm-dialog-title">${escapeHtml(title)}</h4>
            ${message ? `<div class="confirm-dialog-msg">${typeof message === 'string' ? escapeHtml(message).replace(/\n/g, '<br>') : message}</div>` : ''}
            <input type="text" class="confirm-dialog-input" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}" />
          </div>
        </div>
        <div class="confirm-dialog-footer">
          <button type="button" class="btn-cancel secondary" style="min-width:70px;">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn-confirm btn-primary" style="min-width:85px;">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    translate(backdrop);
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('.confirm-dialog-input');

    let closed = false;
    const cleanup = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keyHandler);
      backdrop.style.opacity = '0';
      backdrop.style.transition = 'opacity 0.12s ease';
      setTimeout(() => backdrop.remove(), 130);
      resolve(result);
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(input ? input.value : null);
      }
    };
    document.addEventListener('keydown', keyHandler);

    backdrop.querySelector('.btn-cancel').onclick = (e) => {
      e.stopPropagation();
      cleanup(null);
    };
    backdrop.querySelector('.btn-confirm').onclick = (e) => {
      e.stopPropagation();
      cleanup(input ? input.value : null);
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) cleanup(null);
    };

    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  });
}

export function showModal(contentHtml, onMount, modalClass = '') {
  const modalContainer = $('#modal-container');
  const modalBackdrop = $('#modal-backdrop');
  if (!modalContainer || !modalBackdrop) return;

  modalContainer.className = 'modal-container' + (modalClass ? ' ' + modalClass : '');
  modalContainer.innerHTML = contentHtml;
  modalBackdrop.classList.remove('hidden');

  modalContainer.querySelectorAll('.modal-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      closeModal();
    };
  });

  modalBackdrop.onclick = (e) => {
    if (e.target === modalBackdrop) closeModal();
  };

  translate(modalContainer);

  if (onMount) onMount(modalContainer);
}

export function closeModal() {
  const modalContainer = $('#modal-container');
  const modalBackdrop = $('#modal-backdrop');
  if (modalBackdrop) modalBackdrop.classList.add('hidden');
  if (modalContainer) {
    modalContainer.innerHTML = '';
    modalContainer.className = 'modal-container';
  }
}

export function showOperationLoadingModal({ title, text, detailText }) {
  showModal(`
    <div class="modal-header" style="justify-content:center;border-bottom:1px solid var(--border, rgba(255,255,255,0.1));padding-bottom:12px;">
      <h3 style="margin:0;font-size:16px;font-weight:600;display:flex;align-items:center;gap:6px;">${escapeHtml(title)}</h3>
    </div>
    <div class="modal-body" style="text-align:center;padding:28px 20px;">
      <style>
        @keyframes nimbusSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
      <div style="display:inline-block;width:42px;height:42px;border:3.5px solid var(--border-light, rgba(255,255,255,0.15));border-top-color:var(--accent, #3b82f6);border-radius:50%;animation:nimbusSpin 0.8s linear infinite;margin-bottom:18px;"></div>
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:var(--text, #f8fafc);">
        ${escapeHtml(text || '正在处理中，请稍候...')}
      </div>
      <div style="font-size:12.5px;color:var(--muted, #94a3b8);line-height:1.6;max-width:380px;margin:0 auto;">
        ${escapeHtml(detailText || '数量较多时处理可能需要数秒时间，在此期间请勿刷新或关闭页面。')}
      </div>
    </div>
  `);
}
