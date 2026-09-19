// --------------------------- Sponsor & Project Support Panel ---------------------------
import { $, escapeHtml, translate, state } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';

const sponsorState = {
  data: null,
  sort: 'default',
  amountFilter: 'all',
  timeFilter: 'all',
};

export async function renderSponsorPanel() {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;
  mainPanel.innerHTML = '<div class="empty-state">正在读取赞助与支持清单…</div>';

  try {
    const res = await api('/api/sponsors');
    const data = await res.json();
    sponsorState.data = data;
    renderSponsorUI();
  } catch (err) {
    if (mainPanel) {
      mainPanel.innerHTML = `<div class="empty-state" style="color:var(--danger)">读取赞助信息失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}

export function renderSponsorUI() {
  const mainPanel = $('#main-panel');
  if (!mainPanel) return;
  const data = sponsorState.data || { config: {}, sponsors: [] };
  const config = data.config || {};
  let sponsors = [...(data.sponsors || [])];
  const isAdmin = state.user?.role === 'admin';

  // Apply amount filter
  if (sponsorState.amountFilter === 'ge50') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) >= 50);
  } else if (sponsorState.amountFilter === 'ge30') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) >= 30);
  } else if (sponsorState.amountFilter === 'lt30') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) < 30);
  }

  // Apply time filter
  const now = Date.now();
  if (sponsorState.timeFilter === '7d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 7 * 86400000);
  } else if (sponsorState.timeFilter === '30d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 30 * 86400000);
  } else if (sponsorState.timeFilter === '90d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 90 * 86400000);
  }

  // Apply sort
  if (sponsorState.sort === 'amount_desc') {
    sponsors.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
  } else if (sponsorState.sort === 'amount_asc') {
    sponsors.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  }

  mainPanel.innerHTML = `
    <div class="sponsor-page-container">
      <!-- Top Title Bar -->
      <div class="sponsor-page-header">
        <div class="sponsor-title-left">
          <h2 class="sponsor-page-title">
            <span class="heart-icon">❤️</span>
            <span>支持该项目</span>
          </h2>
        </div>
        <div class="sponsor-title-right">
          <button class="icon-btn-ghost" id="sp-refresh-btn" title="刷新列表">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Description Subheader -->
      <div class="sponsor-intro-box">
        <p class="sponsor-intro-text">
          ${escapeHtml(config.descriptionText || '如果这个项目帮助到您，并且想要它继续开发，请在以下方式支持我们，感谢您对开源软件的支持！')}
        </p>
      </div>

      <!-- Donation Cards (2 Columns) -->
      <div class="sponsor-cards-grid">
        <!-- Card 1: Ko-fi -->
        <div class="sponsor-card">
          <div class="sponsor-card-header">
            <span class="sponsor-card-icon">☕</span>
            <span class="sponsor-card-title">${escapeHtml(config.kofiLabel || '请作者喝杯咖啡')}</span>
          </div>
          <div class="sponsor-card-body">
            <a href="${escapeHtml(config.kofiUrl || 'https://ko-fi.com/lengedliu')}" target="_blank" rel="noopener noreferrer" class="kofi-btn-link" title="点击在 Ko-fi 上赞助作者">
              <div class="kofi-badge-box">
                <span class="kofi-text">Support me on</span>
                <div class="kofi-logo-wrap">
                  <span class="kofi-cup">☕</span>
                  <span class="kofi-brand">Ko-fi</span>
                </div>
              </div>
            </a>
          </div>
        </div>

        <!-- Card 2: WeChat Pay -->
        <div class="sponsor-card">
          <div class="sponsor-card-header">
            <span class="sponsor-card-icon">🧧</span>
            <span class="sponsor-card-title">${escapeHtml(config.wechatLabel || '微信打赏支持')}</span>
          </div>
          <div class="sponsor-card-body">
            <div class="wechat-qr-wrapper">
              <div class="wechat-qr-frame">
                ${
                  (config.wechatQrUrl || '/wechat-reward.jpg')
                    ? `<img src="${escapeHtml(config.wechatQrUrl || '/wechat-reward.jpg')}" alt="微信赞赏码" class="wechat-qr-img" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/wechat-reward.jpg';" />`
                    : `
                  <!-- Default Stylized QR Graphic -->
                  <div class="wechat-qr-graphic">
                    <svg viewBox="0 0 120 120" width="108" height="108" class="qr-svg">
                      <rect x="6" y="6" width="30" height="30" rx="3" fill="#1b1b1f" />
                      <rect x="11" y="11" width="20" height="20" rx="2" fill="#ffffff" />
                      <rect x="15" y="15" width="12" height="12" rx="1.5" fill="#1b1b1f" />
                      <rect x="84" y="6" width="30" height="30" rx="3" fill="#1b1b1f" />
                      <rect x="89" y="11" width="20" height="20" rx="2" fill="#ffffff" />
                      <rect x="93" y="15" width="12" height="12" rx="1.5" fill="#1b1b1f" />
                      <rect x="6" y="84" width="30" height="30" rx="3" fill="#1b1b1f" />
                      <rect x="11" y="89" width="20" height="20" rx="2" fill="#ffffff" />
                      <rect x="15" y="93" width="12" height="12" rx="1.5" fill="#1b1b1f" />
                      <rect x="42" y="8" width="6" height="6" fill="#1b1b1f" />
                      <rect x="52" y="8" width="6" height="6" fill="#1b1b1f" />
                      <rect x="68" y="8" width="6" height="6" fill="#1b1b1f" />
                      <rect x="42" y="20" width="6" height="6" fill="#1b1b1f" />
                      <rect x="60" y="20" width="6" height="6" fill="#1b1b1f" />
                      <rect x="72" y="20" width="6" height="6" fill="#1b1b1f" />
                      <rect x="48" y="30" width="6" height="6" fill="#1b1b1f" />
                      <rect x="64" y="30" width="6" height="6" fill="#1b1b1f" />
                      <rect x="8" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="20" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="32" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="44" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="56" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="72" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="88" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="104" y="44" width="6" height="6" fill="#1b1b1f" />
                      <rect x="14" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="28" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="42" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="70" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="84" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="98" y="56" width="6" height="6" fill="#1b1b1f" />
                      <rect x="8" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="24" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="36" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="52" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="64" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="80" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="96" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="108" y="68" width="6" height="6" fill="#1b1b1f" />
                      <rect x="44" y="80" width="6" height="6" fill="#1b1b1f" />
                      <rect x="60" y="80" width="6" height="6" fill="#1b1b1f" />
                      <rect x="76" y="80" width="6" height="6" fill="#1b1b1f" />
                      <rect x="92" y="80" width="6" height="6" fill="#1b1b1f" />
                      <rect x="44" y="94" width="6" height="6" fill="#1b1b1f" />
                      <rect x="56" y="94" width="6" height="6" fill="#1b1b1f" />
                      <rect x="72" y="94" width="6" height="6" fill="#1b1b1f" />
                      <rect x="88" y="94" width="6" height="6" fill="#1b1b1f" />
                      <rect x="104" y="94" width="6" height="6" fill="#1b1b1f" />
                      <rect x="48" y="106" width="6" height="6" fill="#1b1b1f" />
                      <rect x="64" y="106" width="6" height="6" fill="#1b1b1f" />
                      <rect x="80" y="106" width="6" height="6" fill="#1b1b1f" />
                      <rect x="96" y="106" width="6" height="6" fill="#1b1b1f" />
                      <circle cx="60" cy="60" r="14" fill="#07c160" />
                      <text x="60" y="65" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="bold">¥</text>
                    </svg>
                  </div>
                `
                }
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Supporter List Section -->
      <div class="sponsor-list-section">
        <!-- Section Bar -->
        <div class="sponsor-list-header-bar">
          <div class="sponsor-list-title-wrap">
            <span class="trophy-icon">🏆</span>
            <span class="sponsor-list-title">已支持清单</span>
            <span class="sponsor-time-hint">(三个月以内)</span>
          </div>

          <!-- Filter Tabs on Right -->
          <div class="sponsor-filter-tabs">
            <button class="sp-filter-btn ${sponsorState.sort === 'default' ? 'active' : ''}" id="sp-sort-default-btn">默认排序</button>
            <div class="sp-filter-divider">|</div>
            <div class="sp-dropdown-wrap">
              <button class="sp-filter-btn ${sponsorState.amountFilter !== 'all' ? 'active' : ''}" id="sp-amount-filter-btn">
                ${sponsorState.amountFilter === 'ge50' ? '≥50元' : sponsorState.amountFilter === 'ge30' ? '≥30元' : sponsorState.amountFilter === 'lt30' ? '<30元' : '全部金额'} ▾
              </button>
              <div class="sp-dropdown-menu hidden" id="sp-amount-dropdown">
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'all' ? 'selected' : ''}" data-val="all">全部金额</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'ge50' ? 'selected' : ''}" data-val="ge50">¥50.00 以上</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'ge30' ? 'selected' : ''}" data-val="ge30">¥30.00 以上</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'lt30' ? 'selected' : ''}" data-val="lt30">¥30.00 以下</div>
              </div>
            </div>
            <div class="sp-filter-divider">|</div>
            <div class="sp-dropdown-wrap">
              <button class="sp-filter-btn ${sponsorState.timeFilter !== 'all' ? 'active' : ''}" id="sp-time-filter-btn">
                ${sponsorState.timeFilter === '7d' ? '近7天' : sponsorState.timeFilter === '30d' ? '近30天' : sponsorState.timeFilter === '90d' ? '近3个月' : '全部时间'} ▾
              </button>
              <div class="sp-dropdown-menu hidden" id="sp-time-dropdown">
                <div class="sp-dropdown-item ${sponsorState.timeFilter === 'all' ? 'selected' : ''}" data-val="all">全部时间</div>
                <div class="sp-dropdown-item ${sponsorState.timeFilter === '7d' ? 'selected' : ''}" data-val="7d">近 7 天</div>
                <div class="sp-dropdown-item ${sponsorState.timeFilter === '30d' ? 'selected' : ''}" data-val="30d">近 30 天</div>
                <div class="sp-dropdown-item ${sponsorState.timeFilter === '90d' ? 'selected' : ''}" data-val="90d">近 3 个月</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Supporter Rows -->
        <div class="sponsor-rows-wrapper">
          ${
            sponsors.length > 0
              ? sponsors
                  .map((s) => {
                    const initial = (s.name || '?').trim().charAt(0);
                    const bg = s.color || '#ea580c';
                    return `
                  <div class="sponsor-item-row" data-id="${escapeHtml(s.id)}">
                    <div class="sponsor-col-date">${escapeHtml(s.date || '')}</div>
                    <div class="sponsor-col-avatar" style="background-color:${escapeHtml(bg)};">
                      ${escapeHtml(initial)}
                    </div>
                    <div class="sponsor-col-info">
                      <span class="sponsor-name">${escapeHtml(s.name)}</span>
                      ${s.message ? `<span class="sponsor-pipe">|</span><span class="sponsor-message">${escapeHtml(s.message)}</span>` : ''}
                    </div>
                    <div class="sponsor-col-amount">
                      <span class="sponsor-amount-badge">${escapeHtml(s.amount)} ${escapeHtml(s.currency || '¥')}</span>
                      ${
                        isAdmin
                          ? `<button class="sp-delete-btn" data-del-id="${escapeHtml(s.id)}" title="删除此记录">✕</button>`
                          : ''
                      }
                    </div>
                  </div>
                `;
                  })
                  .join('')
              : `
              <div class="empty-state" style="padding:48px 16px;">
                <div style="font-size:36px;margin-bottom:8px;">☕</div>
                <div style="font-weight:600;font-size:14px;color:var(--text);margin-bottom:4px;">暂无匹配的赞助记录</div>
                <div style="font-size:12px;color:var(--muted);">感谢所有支持开源项目的开发者与创作者</div>
              </div>
            `
          }
        </div>
      </div>
    </div>
  `;

  // Bind event handlers
  const refreshBtn = mainPanel.querySelector('#sp-refresh-btn');
  if (refreshBtn) refreshBtn.onclick = () => renderSponsorPanel();

  const sortDefaultBtn = mainPanel.querySelector('#sp-sort-default-btn');
  if (sortDefaultBtn) {
    sortDefaultBtn.onclick = () => {
      sponsorState.sort = sponsorState.sort === 'default' ? 'amount_desc' : 'default';
      renderSponsorUI();
    };
  }

  // Amount dropdown
  const amountBtn = mainPanel.querySelector('#sp-amount-filter-btn');
  const amountDropdown = mainPanel.querySelector('#sp-amount-dropdown');
  const timeDropdown = mainPanel.querySelector('#sp-time-dropdown');

  if (amountBtn && amountDropdown) {
    amountBtn.onclick = (e) => {
      e.stopPropagation();
      amountDropdown.classList.toggle('hidden');
      if (timeDropdown) timeDropdown.classList.add('hidden');
    };
    amountDropdown.querySelectorAll('.sp-dropdown-item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        sponsorState.amountFilter = item.dataset.val;
        amountDropdown.classList.add('hidden');
        renderSponsorUI();
      };
    });
  }

  // Time dropdown
  const timeBtn = mainPanel.querySelector('#sp-time-filter-btn');
  if (timeBtn && timeDropdown) {
    timeBtn.onclick = (e) => {
      e.stopPropagation();
      timeDropdown.classList.toggle('hidden');
      if (amountDropdown) amountDropdown.classList.add('hidden');
    };
    timeDropdown.querySelectorAll('.sp-dropdown-item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        sponsorState.timeFilter = item.dataset.val;
        timeDropdown.classList.add('hidden');
        renderSponsorUI();
      };
    });
  }

  document.addEventListener(
    'click',
    () => {
      if (amountDropdown) amountDropdown.classList.add('hidden');
      if (timeDropdown) timeDropdown.classList.add('hidden');
    },
    { once: true }
  );

  // Admin delete
  if (isAdmin) {
    mainPanel.querySelectorAll('.sp-delete-btn').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.delId;
        const ok = await showConfirm({
          title: '删除赞助记录',
          message: '确定删除该条赞助记录吗？删除后将不再统计于赞助名单中。',
          confirmText: '确认删除',
          type: 'danger',
          icon: '🗑️',
        });
        if (!ok) return;
        try {
          const r = await api(`/api/sponsors/record/${id}`, { method: 'DELETE' });
          const resData = await r.json();
          if (resData.ok) {
            toast('已删除赞助记录');
            renderSponsorPanel();
          }
        } catch (err) {
          toast('删除失败: ' + err.message);
        }
      };
    });

    // Admin add record modal
    const addRecordBtn = mainPanel.querySelector('#sp-add-record-btn');
    if (addRecordBtn) {
      addRecordBtn.onclick = () => openAddSponsorModal();
    }

    // Admin config modal
    const editConfigBtn = mainPanel.querySelector('#sp-edit-config-btn');
    if (editConfigBtn) {
      editConfigBtn.onclick = () => openEditSponsorConfigModal(config);
    }
  }
  translate(mainPanel);
}

export function openAddSponsorModal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultDate = `${String(now.getFullYear()).slice(-2)}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;

  showModal(`
    <div class="modal-header">
      <h3>➕ 录入赞助支持记录</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <form id="add-sponsor-form" onsubmit="return false;">
        <div class="form-group" style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">支持者昵称 *</label>
          <input type="text" id="sp-m-name" placeholder="如 i_orange" required style="width:100%;" />
        </div>
        <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">赞助金额 (元) *</label>
            <input type="number" step="0.01" id="sp-m-amount" placeholder="30.00" value="30.00" required style="width:100%;" />
          </div>
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">日期 (YY/MM/DD)</label>
            <input type="text" id="sp-m-date" value="${defaultDate}" style="width:100%;" />
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">留言 / 寄语</label>
          <input type="text" id="sp-m-message" placeholder="如 感谢开发出这么好的插件，希望能越做越好！" style="width:100%;" />
        </div>
        <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">支持渠道</label>
            <select id="sp-m-platform" style="width:100%;">
              <option value="wechat">微信打赏</option>
              <option value="kofi">Ko-fi</option>
              <option value="alipay">支付宝</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">头像标识颜色</label>
            <input type="color" id="sp-m-color" value="#ea580c" style="width:100%;height:38px;padding:2px;cursor:pointer;" />
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" class="secondary modal-close">取消</button>
          <button type="submit" class="btn-primary" id="sp-m-submit-btn">确认录入</button>
        </div>
      </form>
    </div>
  `, (modal) => {
    modal.querySelector('#add-sponsor-form').onsubmit = async () => {
      const payload = {
        name: modal.querySelector('#sp-m-name').value.trim(),
        amount: modal.querySelector('#sp-m-amount').value.trim(),
        date: modal.querySelector('#sp-m-date').value.trim(),
        message: modal.querySelector('#sp-m-message').value.trim(),
        platform: modal.querySelector('#sp-m-platform').value,
        color: modal.querySelector('#sp-m-color').value,
      };

      if (!payload.name) {
        toast('请输入支持者昵称');
        return;
      }

      try {
        const res = await api('/api/sponsors/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (body.ok) {
          toast('录入赞助记录成功！');
          closeModal();
          renderSponsorPanel();
        } else {
          toast('录入失败: ' + (body.error || '未知错误'));
        }
      } catch (err) {
        toast('请求异常: ' + err.message);
      }
    };
  });
}

export function openEditSponsorConfigModal(cfg) {
  let currentQr = cfg.wechatQrUrl || '';

  showModal(`
    <div class="modal-header">
      <h3>⚙️ 配置赞助方式与收款信息</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <form id="edit-sponsor-config-form" onsubmit="return false;">
        <div class="form-group" style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">顶部说明副标题</label>
          <textarea id="sp-cfg-desc" rows="2" style="width:100%;font-size:12px;">${escapeHtml(cfg.descriptionText || '')}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Ko-fi 赞助主页链接 (可留空)</label>
          <input type="text" id="sp-cfg-kofi-url" value="${escapeHtml(cfg.kofiUrl || '')}" placeholder="如 https://ko-fi.com/username (留空则仅展示徽标)" style="width:100%;font-size:12px;" />
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;">微信赞赏码 / 收款码图片</label>
          
          <!-- Upload & Preview Box -->
          <div style="display:grid;grid-template-columns:120px 1fr;gap:14px;align-items:start;background:var(--panel-2);border:1px dashed var(--border);border-radius:8px;padding:12px;">
            <!-- Live Thumbnail Preview -->
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
              <div id="sp-modal-qr-preview-box" style="width:100px;height:100px;background:#fff;border:2px solid #22c55e;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 2px 8px rgba(34,197,94,0.15);">
                ${
                  currentQr
                    ? `<img id="sp-modal-qr-img" src="${escapeHtml(currentQr)}" alt="微信赞赏码" style="width:100%;height:100%;object-fit:contain;" />`
                    : `<div id="sp-modal-qr-placeholder" style="font-size:11px;color:#999;text-align:center;padding:4px;">默认矢量图</div>`
                }
              </div>
              <button type="button" class="secondary" id="sp-modal-clear-qr-btn" style="font-size:11px;padding:2px 8px;width:100%;">还原默认</button>
            </div>

            <!-- Upload actions -->
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <label class="btn-primary" style="font-size:12px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
                  <span>📁 选择收款码图片</span>
                  <input type="file" id="sp-cfg-wechat-file" accept="image/*" style="display:none;" />
                </label>
                <span style="font-size:11px;color:var(--muted);">支持点击上传、直接拖拽或粘贴图片</span>
              </div>
              <div style="margin-top:2px;">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:2px;">或直接填入图片链接 / Base64 数据：</label>
                <textarea id="sp-cfg-wechat-qr" rows="2" placeholder="https://... 或 data:image/..." style="width:100%;font-size:11px;font-family:monospace;">${escapeHtml(currentQr)}</textarea>
              </div>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button type="button" class="secondary modal-close">取消</button>
          <button type="submit" class="btn-primary" id="sp-cfg-save-btn">保存配置</button>
        </div>
      </form>
    </div>
  `, (modal) => {
    const fileInput = modal.querySelector('#sp-cfg-wechat-file');
    const textInput = modal.querySelector('#sp-cfg-wechat-qr');
    const previewBox = modal.querySelector('#sp-modal-qr-preview-box');
    const clearBtn = modal.querySelector('#sp-modal-clear-qr-btn');

    function updatePreview(dataUri) {
      currentQr = dataUri || '';
      textInput.value = currentQr;
      if (currentQr) {
        previewBox.innerHTML = `<img id="sp-modal-qr-img" src="${escapeHtml(currentQr)}" alt="微信赞赏码" style="width:100%;height:100%;object-fit:contain;" />`;
      } else {
        previewBox.innerHTML = `<div id="sp-modal-qr-placeholder" style="font-size:11px;color:#999;text-align:center;padding:4px;">默认矢量图</div>`;
      }
    }

    function processImageFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const rawData = e.target.result;
        const img = new Image();
        img.onload = () => {
          const maxDim = 800;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const optimized = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
          updatePreview(optimized);
        };
        img.src = rawData;
      };
      reader.readAsDataURL(file);
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          processImageFile(e.target.files[0]);
        }
      });
    }

    if (textInput) {
      textInput.addEventListener('input', (e) => {
        updatePreview(e.target.value.trim());
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        updatePreview('');
      });
    }

    modal.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    modal.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        processImageFile(e.dataTransfer.files[0]);
      }
    });

    modal.addEventListener('paste', (e) => {
      if (e.clipboardData && e.clipboardData.items) {
        for (let i = 0; i < e.clipboardData.items.length; i++) {
          const item = e.clipboardData.items[i];
          if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            processImageFile(file);
            break;
          }
        }
      }
    });

    modal.querySelector('#edit-sponsor-config-form').onsubmit = async () => {
      const payload = {
        descriptionText: modal.querySelector('#sp-cfg-desc').value.trim(),
        kofiUrl: modal.querySelector('#sp-cfg-kofi-url').value.trim(),
        wechatQrUrl: currentQr.trim(),
      };

      const saveBtn = modal.querySelector('#sp-cfg-save-btn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '正在保存…';
      }

      try {
        const res = await api('/api/sponsors/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (body.ok) {
          toast('赞助配置已更新！');
          closeModal();
          renderSponsorPanel();
        } else {
          toast('保存失败: ' + (body.error || '未知错误'));
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存配置';
          }
        }
      } catch (err) {
        toast('保存失败: ' + err.message);
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '保存配置';
        }
      }
    };
  });
}
