// --------------------------- Sponsor & Project Support Panel ---------------------------
// Inspired by tinglan-music-server modern sponsor design
import { $, escapeHtml, translate, state } from '../core/state.js';
import { api } from '../core/api.js';
import { toast, showConfirm, showModal, closeModal } from '../core/dialogs.js';

const sponsorState = {
  data: null,
  activePaymentMethod: 'wechat', // 'wechat' | 'alipay' | 'kofi' | 'usdt'
  selectedTier: null,
  viewMode: 'grid', // 'grid' | 'list'
  searchQuery: '',
  sort: 'default', // 'default' | 'amount_desc' | 'amount_asc'
  amountFilter: 'all', // 'all' | 'ge50' | 'ge30' | 'lt30'
  timeFilter: 'all', // 'all' | '7d' | '30d' | '90d'
  copiedKey: null,
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

  const totalAmount = data.totalAmount || sponsors.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0).toFixed(2);
  const totalCount = sponsors.length;

  // Search filter
  if (sponsorState.searchQuery.trim()) {
    const q = sponsorState.searchQuery.trim().toLowerCase();
    sponsors = sponsors.filter((s) => 
      (s.name && s.name.toLowerCase().includes(q)) || 
      (s.message && s.message.toLowerCase().includes(q))
    );
  }

  // Amount filter
  if (sponsorState.amountFilter === 'ge50') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) >= 50);
  } else if (sponsorState.amountFilter === 'ge30') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) >= 30);
  } else if (sponsorState.amountFilter === 'lt30') {
    sponsors = sponsors.filter((s) => parseFloat(s.amount) < 30);
  }

  // Time filter
  const now = Date.now();
  if (sponsorState.timeFilter === '7d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 7 * 86400000);
  } else if (sponsorState.timeFilter === '30d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 30 * 86400000);
  } else if (sponsorState.timeFilter === '90d') {
    sponsors = sponsors.filter((s) => !s.timestamp || now - s.timestamp <= 90 * 86400000);
  }

  // Sort
  if (sponsorState.sort === 'amount_desc') {
    sponsors.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
  } else if (sponsorState.sort === 'amount_asc') {
    sponsors.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  }

  // Tier presets
  const tiers = [
    {
      id: 1,
      title: '一杯香浓咖啡',
      amount: '¥ 9.9',
      unit: '随心赞助',
      icon: '☕',
      color: '#f59e0b',
      badge: '爱心投喂',
      desc: '为深夜编码与维护 Obsidian 多端增量同步的作者续上一杯热咖啡，注入满满活力！',
      benefits: [
        '出现在项目鸣谢赞助列表中',
        '感谢您对开源与知识库同步的认可'
      ]
    },
    {
      id: 2,
      title: '极客能量补给',
      amount: '¥ 29.9',
      unit: '推荐支持',
      icon: '⚡',
      color: '#6366f1',
      badge: '热门赞助',
      popular: true,
      desc: '支持 Nimbus Vault Sync 持续迭代与全平台适配（覆盖 Obsidian 桌面/移动端与多数据库拓展）。',
      benefits: [
        '优先解答与协助分析增量同步/冲突日志',
        '鸣谢墙金色徽章与高亮展示',
        '优先测试体验最新实验性功能特性'
      ]
    },
    {
      id: 3,
      title: '超级布道赞助',
      amount: '¥ 99',
      unit: '核心贡献',
      icon: '🏆',
      color: '#ec4899',
      badge: '至尊感谢',
      desc: '助力搭建长期多端压测与高可用集群架构，推动知识库生态扩展。',
      benefits: [
        '1 对 1 专属架构咨询与私有化多端多 Vault 部署指导',
        '专属 VIP 赞助者群聊与新功能投票权',
        '永久保留项目 README 与关于页至尊赞助者席位'
      ]
    }
  ];

  const wechatQr = config.wechatQrUrl || '/wechat-reward.jpg';
  const alipayQr = config.alipayQrUrl || '/alipay.png';
  const alipayAccount = config.alipayAccount || 'lenged.liu@gmail.com';
  const kofiUrl = config.kofiUrl || 'https://ko-fi.com/lengedliu';

  mainPanel.innerHTML = `
    <div class="sponsor-page-container">
      
      <!-- Top Hero Banner (Inspired by Tinglan Music Server) -->
      <div class="sp-hero-banner">
        <div class="sp-hero-glow"></div>
        <div class="sp-hero-content">
          <div class="sp-hero-left">
            <div class="sp-hero-badge">
              <span class="sp-badge-sparkle">✨</span>
              <span>开源独立开发 · 纯粹无广告 · 感谢有你</span>
            </div>
            <h1 class="sp-hero-title">
              支持 <span class="sp-hero-highlight">Nimbus Vault Sync</span> 的持续发展
            </h1>
            <p class="sp-hero-desc">
              ${escapeHtml(config.descriptionText || '如果您觉得 Nimbus Vault Sync 为您的 Obsidian 笔记多端同步与版本管理带来了便利与价值，欢迎请作者喝杯咖啡或提供赞助支持！您的每一份善意都是项目持续打磨与前行的最大动力。')}
            </p>
            <div class="sp-hero-features">
              <div class="sp-feature-pill">
                <span class="sp-pill-icon">🛡️</span>
                <span>100% 永久免费开源</span>
              </div>
              <div class="sp-feature-pill">
                <span class="sp-pill-icon">❤️</span>
                <span>无强制门槛 · 自愿鼓励</span>
              </div>
              <div class="sp-feature-pill">
                <span class="sp-pill-icon">👥</span>
                <span>社区共同建设</span>
              </div>
            </div>
          </div>
          
          <div class="sp-hero-right">
            <div class="sp-stat-card">
              <div class="sp-stat-icon-wrap">
                <span class="sp-heart-big">💖</span>
              </div>
              <div class="sp-stat-label">用爱发电 · 感谢陪伴</div>
              <div class="sp-stat-sub">已有 <strong class="sp-stat-num">${totalCount}</strong> 位支持者</div>
              <div class="sp-stat-amount-pill">累计获赠 ¥${totalAmount}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Main Grid: Payment QR Codes & Tier Cards -->
      <div class="sp-main-grid">
        
        <!-- Left Column: Payment QR & Methods (5 cols) -->
        <div class="sp-payment-col">
          <div class="sp-payment-card">
            
            <div class="sp-payment-header">
              <div class="sp-payment-title-group">
                <div class="sp-payment-icon-box">
                  <span>📱</span>
                </div>
                <div>
                  <h3 class="sp-payment-title">赞赏码投喂</h3>
                  <p class="sp-payment-subtitle">支持微信支付、支付宝与 Ko-fi 赞助</p>
                </div>
              </div>
            </div>

            <!-- Payment Method Tabs -->
            <div class="sp-method-tabs">
              <button class="sp-method-tab ${sponsorState.activePaymentMethod === 'wechat' ? 'active' : ''}" data-method="wechat">
                <span class="sp-tab-dot green"></span>
                <span>微信支付</span>
              </button>
              <button class="sp-method-tab ${sponsorState.activePaymentMethod === 'alipay' ? 'active' : ''}" data-method="alipay">
                <span class="sp-tab-dot blue"></span>
                <span>支付宝</span>
              </button>
              <button class="sp-method-tab ${sponsorState.activePaymentMethod === 'kofi' ? 'active' : ''}" data-method="kofi">
                <span class="sp-tab-dot red"></span>
                <span>Ko-fi</span>
              </button>
            </div>

            <!-- Dynamic Payment Content -->
            <div class="sp-qr-display-container">
              
              ${sponsorState.activePaymentMethod === 'wechat' ? `
                <div class="sp-qr-method-view animate-fade">
                  <div class="sp-qr-box">
                    <img src="${escapeHtml(wechatQr)}" alt="微信赞赏码" class="sp-qr-image" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/wechat-reward.jpg';" />
                  </div>
                  <div class="sp-qr-tip-box">
                    <span class="sp-qr-tip-icon">💚</span>
                    <span class="sp-qr-tip-text">微信扫描上方赞赏码，附言请留下您的【昵称】与【留言】，将同步载入鸣谢芳名录！</span>
                  </div>
                </div>
              ` : ''}

              ${sponsorState.activePaymentMethod === 'alipay' ? `
                <div class="sp-qr-method-view animate-fade">
                  <div class="sp-qr-box">
                    <img src="${escapeHtml(alipayQr)}" alt="支付宝赞赏码" class="sp-qr-image" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/alipay.png';" />
                  </div>
                  <div class="sp-copy-action-row">
                    <button class="sp-action-btn primary" id="sp-copy-alipay-btn">
                      <span>📋</span>
                      <span>${sponsorState.copiedKey === 'alipay' ? '已复制账号 ✅' : '复制支付宝账号 (' + escapeHtml(alipayAccount) + ')'}</span>
                    </button>
                  </div>
                  <div class="sp-qr-tip-box">
                    <span class="sp-qr-tip-icon">💙</span>
                    <span class="sp-qr-tip-text">支付宝扫码或转账时请备注【Nimbus 赞助 + 您的昵称】，感谢您的认可与支持！</span>
                  </div>
                </div>
              ` : ''}

              ${sponsorState.activePaymentMethod === 'kofi' ? `
                <div class="sp-qr-method-view animate-fade">
                  <div class="sp-kofi-display-box">
                    <div class="sp-kofi-icon">☕</div>
                    <div class="sp-kofi-title">Ko-fi 国际赞助渠道</div>
                    <div class="sp-kofi-desc">支持国际信用卡、PayPal、Apple Pay 等多种快捷支付方式</div>
                    <a href="${escapeHtml(kofiUrl)}" target="_blank" rel="noopener noreferrer" class="kofi-btn-link" title="点击在 Ko-fi 上赞助作者">
                      <div class="kofi-badge-box">
                        <span class="kofi-text">Support me on</span>
                        <div class="kofi-logo-wrap">
                          <span class="kofi-cup">☕</span>
                          <span class="kofi-brand">Ko-fi</span>
                        </div>
                      </div>
                    </a>
                  </div>
                  <div class="sp-qr-tip-box">
                    <span class="sp-qr-tip-icon">🌍</span>
                    <span class="sp-qr-tip-text">适合海外或非人民币用户，感谢跨越山海的开源支持！</span>
                  </div>
                </div>
              ` : ''}

              ${sponsorState.activePaymentMethod === 'usdt' ? `
                <div class="sp-qr-method-view animate-fade">
                  <div class="sp-crypto-box">
                    <div class="sp-crypto-badge">💎 ${escapeHtml(usdtNetwork)}</div>
                    <div class="sp-crypto-address-box">
                      <code>${escapeHtml(usdtAddress)}</code>
                    </div>
                  </div>
                  <div class="sp-copy-action-row">
                    <button class="sp-action-btn primary" id="sp-copy-usdt-btn">
                      <span>📋</span>
                      <span>${sponsorState.copiedKey === 'usdt' ? '已复制地址 ✅' : '复制 USDT 钱包地址'}</span>
                    </button>
                  </div>
                  <div class="sp-qr-tip-box">
                    <span class="sp-qr-tip-icon">🔒</span>
                    <span class="sp-qr-tip-text">仅支持 ${escapeHtml(usdtNetwork)} 链上充值，转账完成后可联系作者登记鸣谢。</span>
                  </div>
                </div>
              ` : ''}

            </div>
          </div>
        </div>

        <!-- Right Column: Tiers & Perks (7 cols) -->
        <div class="sp-tiers-col">
          <div class="sp-tiers-header">
            <div>
              <h3 class="sp-tiers-title">
                <span>赞助档位与回馈</span>
                <span class="sp-tier-badge-pill">自选心意</span>
              </h3>
              <p class="sp-tiers-sub">金额不限，每一份支持都弥足珍贵</p>
            </div>
          </div>

          <div class="sp-tiers-list">
            ${tiers.map((tier) => {
              const isSelected = sponsorState.selectedTier === tier.id;
              return `
                <div class="sp-tier-card ${isSelected || tier.popular ? 'popular' : ''} ${isSelected ? 'selected' : ''}" data-tier-id="${tier.id}">
                  ${tier.popular ? `<div class="sp-tier-ribbon" style="background-color:${tier.color};">${tier.badge}</div>` : ''}
                  <div class="sp-tier-main">
                    <div class="sp-tier-icon-wrap" style="color:${tier.color};border-color:${tier.color}40;background-color:${tier.color}15;">
                      <span class="sp-tier-icon">${tier.icon}</span>
                    </div>
                    <div class="sp-tier-info">
                      <div class="sp-tier-name-row">
                        <h4 class="sp-tier-title">${tier.title}</h4>
                        <span class="sp-tier-amount-badge" style="color:${tier.color};background-color:${tier.color}15;">
                          ${tier.amount}
                        </span>
                      </div>
                      <p class="sp-tier-desc">${tier.desc}</p>
                      <div class="sp-tier-benefits">
                        ${tier.benefits.map((b) => `
                          <div class="sp-benefit-item">
                            <span class="sp-benefit-check">✓</span>
                            <span>${b}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  </div>
                  <div class="sp-tier-action">
                    <button class="sp-tier-btn" data-go-tier="${tier.id}" data-amount="${tier.amount}" style="${tier.popular ? `background:var(--primary);color:#fff;` : ''}">
                      <span>去赞助</span>
                      <span class="sp-tier-arrow">➔</span>
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

      </div>

      <!-- Sponsor Wall / Hall of Fame -->
      <div class="sp-wall-section">
        
        <div class="sp-wall-header-bar">
          <div class="sp-wall-title-group">
            <div class="sp-wall-icon-box">💖</div>
            <div>
              <h3 class="sp-wall-title">
                <span>爱心赞助芳名录</span>
                <span class="sp-wall-badge">Sponsors Hall</span>
              </h3>
              <p class="sp-wall-subtitle">排名不分先后，感谢每一位支持者的慷慨相助</p>
            </div>
          </div>

          <!-- Actions & Admin Toolbar -->
          <div class="sp-wall-actions-bar">
            ${isAdmin ? `
              <button class="btn-primary-sm" id="sp-add-record-btn" title="登记赞助记录">
                <span>➕</span> 登记赞助
              </button>
              <button class="btn-secondary-sm" id="sp-edit-config-btn" title="配置收款信息与链接">
                <span>⚙️</span> 赞助配置
              </button>
            ` : ''}
            
            <button class="icon-btn-ghost" id="sp-refresh-btn" title="刷新芳名录">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Filter Controls Row -->
        <div class="sp-filter-controls-row">
          
          <!-- Search Bar -->
          <div class="sp-search-box">
            <span class="sp-search-icon">🔍</span>
            <input type="text" id="sp-search-input" placeholder="搜索赞助者昵称或寄语…" value="${escapeHtml(sponsorState.searchQuery)}" />
            ${sponsorState.searchQuery ? `<button class="sp-search-clear" id="sp-search-clear-btn">✕</button>` : ''}
          </div>

          <!-- Filter Pills -->
          <div class="sp-filter-pills-wrap">
            
            <!-- View Mode Switcher -->
            <div class="sp-view-switcher">
              <button class="sp-view-btn ${sponsorState.viewMode === 'grid' ? 'active' : ''}" id="sp-view-grid-btn" title="网格卡片视图">
                ⊞ 卡片
              </button>
              <button class="sp-view-btn ${sponsorState.viewMode === 'list' ? 'active' : ''}" id="sp-view-list-btn" title="列表视图">
                ☰ 列表
              </button>
            </div>

            <!-- Sort Toggle -->
            <button class="sp-filter-pill-btn ${sponsorState.sort !== 'default' ? 'active' : ''}" id="sp-sort-toggle-btn">
              ${sponsorState.sort === 'amount_desc' ? '💰 金额最高' : sponsorState.sort === 'amount_asc' ? '💰 金额最低' : '⏱️ 默认排序'}
            </button>

            <!-- Amount Dropdown -->
            <div class="sp-dropdown-wrap">
              <button class="sp-filter-pill-btn ${sponsorState.amountFilter !== 'all' ? 'active' : ''}" id="sp-amount-filter-btn">
                ${sponsorState.amountFilter === 'ge50' ? '≥50元' : sponsorState.amountFilter === 'ge30' ? '≥30元' : sponsorState.amountFilter === 'lt30' ? '<30元' : '全部金额'} ▾
              </button>
              <div class="sp-dropdown-menu hidden" id="sp-amount-dropdown">
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'all' ? 'selected' : ''}" data-val="all">全部金额</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'ge50' ? 'selected' : ''}" data-val="ge50">¥50.00 以上</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'ge30' ? 'selected' : ''}" data-val="ge30">¥30.00 以上</div>
                <div class="sp-dropdown-item ${sponsorState.amountFilter === 'lt30' ? 'selected' : ''}" data-val="lt30">¥30.00 以下</div>
              </div>
            </div>

            <!-- Time Dropdown -->
            <div class="sp-dropdown-wrap">
              <button class="sp-filter-pill-btn ${sponsorState.timeFilter !== 'all' ? 'active' : ''}" id="sp-time-filter-btn">
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

        <!-- Supporters Content (Grid or List) -->
        ${sponsors.length > 0 ? `
          ${sponsorState.viewMode === 'grid' ? `
            <div class="sp-wall-grid">
              ${sponsors.map((s) => {
                const initial = (s.name || '?').trim().charAt(0);
                const bg = s.color || '#ea580c';
                const platformBadge = s.platform === 'wechat' ? '💚 微信' : s.platform === 'alipay' ? '💙 支付宝' : s.platform === 'kofi' ? '☕ Ko-fi' : s.platform === 'usdt' ? '💎 USDT' : '❤️ 赞助';
                return `
                  <div class="sp-hall-card" data-id="${escapeHtml(s.id)}">
                    <div class="sp-hall-card-top">
                      <div class="sp-hall-user">
                        <div class="sp-hall-avatar" style="background-color:${escapeHtml(bg)};">
                          ${escapeHtml(initial)}
                        </div>
                        <div class="sp-hall-name-wrap">
                          <span class="sp-hall-name">${escapeHtml(s.name)}</span>
                          <span class="sp-hall-platform">${platformBadge}</span>
                        </div>
                      </div>
                      <div class="sp-hall-amount">
                        <span>${escapeHtml(s.amount)} ${escapeHtml(s.currency || '¥')}</span>
                      </div>
                    </div>
                    
                    <div class="sp-hall-message-box">
                      <span class="sp-quote-mark">“</span>
                      <p class="sp-hall-message">${escapeHtml(s.message || '支持开源项目，加油！')}</p>
                    </div>

                    <div class="sp-hall-card-footer">
                      <span class="sp-hall-date">📅 ${escapeHtml(s.date || '')}</span>
                      ${isAdmin ? `
                        <button class="sp-delete-btn" data-del-id="${escapeHtml(s.id)}" title="删除此记录">🗑️ 删除</button>
                      ` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="sponsor-rows-wrapper">
              ${sponsors.map((s) => {
                const initial = (s.name || '?').trim().charAt(0);
                const bg = s.color || '#ea580c';
                const platformBadge = s.platform === 'wechat' ? '微信' : s.platform === 'alipay' ? '支付宝' : s.platform === 'kofi' ? 'Ko-fi' : s.platform === 'usdt' ? 'USDT' : '赞助';
                return `
                  <div class="sponsor-item-row" data-id="${escapeHtml(s.id)}">
                    <div class="sponsor-col-date">${escapeHtml(s.date || '')}</div>
                    <div class="sponsor-col-avatar" style="background-color:${escapeHtml(bg)};">
                      ${escapeHtml(initial)}
                    </div>
                    <div class="sponsor-col-info">
                      <span class="sponsor-name">${escapeHtml(s.name)}</span>
                      <span class="sp-channel-tag">${platformBadge}</span>
                      ${s.message ? `<span class="sponsor-pipe">|</span><span class="sponsor-message">${escapeHtml(s.message)}</span>` : ''}
                    </div>
                    <div class="sponsor-col-amount">
                      <span class="sponsor-amount-badge">${escapeHtml(s.amount)} ${escapeHtml(s.currency || '¥')}</span>
                      ${isAdmin ? `
                        <button class="sp-delete-btn" data-del-id="${escapeHtml(s.id)}" title="删除此记录">✕</button>
                      ` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        ` : `
          <div class="sp-empty-wall">
            <div class="sp-empty-icon">☕</div>
            <div class="sp-empty-title">暂无匹配的赞助记录</div>
            <div class="sp-empty-sub">感谢所有支持开源项目的开发者与创作者</div>
          </div>
        `}

      </div>

      <!-- FAQ Section (Frequently Asked Questions) -->
      <div class="sp-faq-section">
        <div class="sp-faq-header">
          <span class="sp-faq-icon">💡</span>
          <h3 class="sp-faq-title">常见赞助问题解答 (FAQ)</h3>
        </div>
        <div class="sp-faq-grid">
          
          <div class="sp-faq-card">
            <h4 class="sp-faq-q">
              <span class="sp-faq-dot"></span>
              <span>为什么需要赞助支持？</span>
            </h4>
            <p class="sp-faq-a">
              Nimbus Vault Sync 是一款完全免费、无广告、纯粹面向 Obsidian 生态的开源项目。您的每一份鼓励与赞助，都将直接用于自费云测试服务器构建、多端真机（iOS / Android / macOS / Windows / Linux）增量同步联调测试与长期迭代维护。
            </p>
          </div>

          <div class="sp-faq-card">
            <h4 class="sp-faq-q">
              <span class="sp-faq-dot"></span>
              <span>赞助后会有功能限制或专属特权吗？</span>
            </h4>
            <p class="sp-faq-a">
              不会！Nimbus 的全部核心代码与功能对所有用户 100% 永久免费开源，绝无任何强制付费门槛或功能阉割。赞助纯属自愿的爱心支持，是对作者在业余时间维护项目的一份温暖激励。
            </p>
          </div>

          <div class="sp-faq-card">
            <h4 class="sp-faq-q">
              <span class="sp-faq-dot"></span>
              <span>赞助后如何登上鸣谢芳名录？</span>
            </h4>
            <p class="sp-faq-a">
              您在扫码赞助时可在转账附言中留下您的【昵称】及【留言寄语】，我们将定期在项目主页与关于赞助墙中同步更新！若未显示亦可联系作者手动录入。
            </p>
          </div>

        </div>
      </div>

    </div>
  `;

  // Bind Event Handlers
  bindEvents(mainPanel, config, isAdmin);
  translate(mainPanel);
}

function bindEvents(mainPanel, config, isAdmin) {
  // Refresh
  const refreshBtn = mainPanel.querySelector('#sp-refresh-btn');
  if (refreshBtn) refreshBtn.onclick = () => renderSponsorPanel();

  // Payment method switch
  mainPanel.querySelectorAll('.sp-method-tab').forEach((tab) => {
    tab.onclick = () => {
      sponsorState.activePaymentMethod = tab.dataset.method;
      renderSponsorUI();
    };
  });

  // Copy Alipay account
  const copyAlipayBtn = mainPanel.querySelector('#sp-copy-alipay-btn');
  if (copyAlipayBtn) {
    copyAlipayBtn.onclick = () => {
      const acc = config.alipayAccount || 'lenged.liu@gmail.com';
      try {
        navigator.clipboard.writeText(acc);
        sponsorState.copiedKey = 'alipay';
        toast('支付宝账号已复制到剪贴板！');
        renderSponsorUI();
        setTimeout(() => {
          sponsorState.copiedKey = null;
          renderSponsorUI();
        }, 2500);
      } catch {
        toast('复制失败，请手动复制：' + acc);
      }
    };
  }

  // Copy USDT address
  const copyUsdtBtn = mainPanel.querySelector('#sp-copy-usdt-btn');
  if (copyUsdtBtn) {
    copyUsdtBtn.onclick = () => {
      const addr = config.usdtAddress || 'TXD8aYw9fK9vM1L3xP7qR4tB6sQ2zU5eWn';
      try {
        navigator.clipboard.writeText(addr);
        sponsorState.copiedKey = 'usdt';
        toast('USDT 地址已复制到剪贴板！');
        renderSponsorUI();
        setTimeout(() => {
          sponsorState.copiedKey = null;
          renderSponsorUI();
        }, 2500);
      } catch {
        toast('复制失败，请手动复制：' + addr);
      }
    };
  }

  // Tier Card selection & go sponsor
  mainPanel.querySelectorAll('.sp-tier-card').forEach((card) => {
    card.onclick = () => {
      const id = parseInt(card.dataset.tierId, 10);
      sponsorState.selectedTier = id;
      renderSponsorUI();
    };
  });

  mainPanel.querySelectorAll('.sp-tier-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.goTier, 10);
      const amount = btn.dataset.amount;
      sponsorState.selectedTier = id;
      toast(`已选择档位：请使用左侧二维码或渠道支付 ${amount}`);
      // Smooth scroll to payment section on mobile
      const payCol = mainPanel.querySelector('.sp-payment-col');
      if (payCol && window.innerWidth < 1024) {
        payCol.scrollIntoView({ behavior: 'smooth' });
      }
      renderSponsorUI();
    };
  });

  // Search input
  const searchInput = mainPanel.querySelector('#sp-search-input');
  if (searchInput) {
    searchInput.oninput = (e) => {
      sponsorState.searchQuery = e.target.value;
      renderSponsorUI();
      // Keep focus
      const updatedInput = mainPanel.querySelector('#sp-search-input');
      if (updatedInput) {
        updatedInput.focus();
        updatedInput.setSelectionRange(updatedInput.value.length, updatedInput.value.length);
      }
    };
  }

  const searchClearBtn = mainPanel.querySelector('#sp-search-clear-btn');
  if (searchClearBtn) {
    searchClearBtn.onclick = () => {
      sponsorState.searchQuery = '';
      renderSponsorUI();
    };
  }

  // View Mode Switcher
  const viewGridBtn = mainPanel.querySelector('#sp-view-grid-btn');
  const viewListBtn = mainPanel.querySelector('#sp-view-list-btn');
  if (viewGridBtn) viewGridBtn.onclick = () => { sponsorState.viewMode = 'grid'; renderSponsorUI(); };
  if (viewListBtn) viewListBtn.onclick = () => { sponsorState.viewMode = 'list'; renderSponsorUI(); };

  // Sort toggle
  const sortToggleBtn = mainPanel.querySelector('#sp-sort-toggle-btn');
  if (sortToggleBtn) {
    sortToggleBtn.onclick = () => {
      if (sponsorState.sort === 'default') sponsorState.sort = 'amount_desc';
      else if (sponsorState.sort === 'amount_desc') sponsorState.sort = 'amount_asc';
      else sponsorState.sort = 'default';
      renderSponsorUI();
    };
  }

  // Amount dropdown
  const amountBtn = mainPanel.querySelector('#sp-amount-filter-btn');
  const amountDropdown = mainPanel.querySelector('#sp-amount-dropdown');
  const timeBtn = mainPanel.querySelector('#sp-time-filter-btn');
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

  // Admin Delete Sponsor
  if (isAdmin) {
    mainPanel.querySelectorAll('.sp-delete-btn').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.delId;
        const ok = await showConfirm({
          title: '删除赞助记录',
          message: '确定删除该条赞助记录吗？删除后将不再统计于赞助芳名录中。',
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

    // Admin Add Record Modal
    const addRecordBtn = mainPanel.querySelector('#sp-add-record-btn');
    if (addRecordBtn) {
      addRecordBtn.onclick = () => openAddSponsorModal();
    }

    // Admin Config Modal
    const editConfigBtn = mainPanel.querySelector('#sp-edit-config-btn');
    if (editConfigBtn) {
      editConfigBtn.onclick = () => openEditSponsorConfigModal(config);
    }
  }
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
          <input type="text" id="sp-m-message" placeholder="如 感谢开发出这么好的同步工具，希望能越做越好！" style="width:100%;" />
        </div>
        <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">支持渠道</label>
            <select id="sp-m-platform" style="width:100%;">
              <option value="wechat">微信支付</option>
              <option value="alipay">支付宝</option>
              <option value="kofi">Ko-fi</option>
              <option value="usdt">USDT</option>
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

export function openEditSponsorConfigModal(config) {
  showModal(`
    <div class="modal-header">
      <h3>⚙️ 配置赞助方式与收款信息</h3>
      <button class="modal-close ghost">✕</button>
    </div>
    <div class="modal-body">
      <form id="edit-sponsor-config-form" onsubmit="return false;">
        <div class="form-group" style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">顶部宣传介绍文案</label>
          <textarea id="sp-cfg-desc" rows="3" style="width:100%;font-size:13px;">${escapeHtml(config.descriptionText || '')}</textarea>
        </div>
        
        <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">微信赞赏码图片路径/URL</label>
            <input type="text" id="sp-cfg-wechat-qr" value="${escapeHtml(config.wechatQrUrl || '/wechat-reward.jpg')}" placeholder="/wechat-reward.jpg 或 URL" style="width:100%;" />
          </div>
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">支付宝赞赏码图片路径/URL</label>
            <input type="text" id="sp-cfg-alipay-qr" value="${escapeHtml(config.alipayQrUrl || '/alipay.png')}" placeholder="/alipay.png 或 URL" style="width:100%;" />
          </div>
        </div>

        <div class="form-row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">支付宝收款账号 / 邮箱</label>
            <input type="text" id="sp-cfg-alipay-acc" value="${escapeHtml(config.alipayAccount || 'lenged.liu@gmail.com')}" placeholder="lenged.liu@gmail.com" style="width:100%;" />
          </div>
          <div class="form-group">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Ko-fi 赞助主页链接</label>
            <input type="text" id="sp-cfg-kofi-url" value="${escapeHtml(config.kofiUrl || 'https://ko-fi.com/lengedliu')}" placeholder="https://ko-fi.com/..." style="width:100%;" />
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button type="button" class="secondary modal-close">取消</button>
          <button type="submit" class="btn-primary">保存配置</button>
        </div>
      </form>
    </div>
  `, (modal) => {
    modal.querySelector('#edit-sponsor-config-form').onsubmit = async () => {
      const payload = {
        descriptionText: modal.querySelector('#sp-cfg-desc').value.trim(),
        wechatQrUrl: modal.querySelector('#sp-cfg-wechat-qr').value.trim(),
        alipayQrUrl: modal.querySelector('#sp-cfg-alipay-qr').value.trim(),
        alipayAccount: modal.querySelector('#sp-cfg-alipay-acc').value.trim(),
        kofiUrl: modal.querySelector('#sp-cfg-kofi-url').value.trim(),
      };

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
        }
      } catch (err) {
        toast('请求异常: ' + err.message);
      }
    };
  });
}
