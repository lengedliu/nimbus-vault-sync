// --------------------------- Dynamic Themes & Font Size & Date Helpers ---------------------------
import { $, $$, escapeHtml } from './state.js';

export const THEMES = [
  // 🌙 Dark Geek Themes (7)
  {
    id: 'xiaomi-orange',
    legacyKey: null,
    name: '米橙经典 (Dark)',
    subtitle: '小米官方极客风，深邃石墨黑搭配经典米橙高亮，温润沉稳',
    primaryColor: '#FF6700',
    secondaryColor: '#f97316',
    primaryRgb: '255, 103, 0',
    bgColor: '#0e0e11',
    cardBg: '#17181c',
    cardHover: '#1f2026',
    cardSubtle: '#111215',
    cardBorder: 'rgba(255, 103, 0, 0.18)',
    cardBorderHover: 'rgba(255, 103, 0, 0.4)',
    textTitle: '#ffffff',
    textBody: '#e4e4e7',
    textMuted: '#9ca3af',
    isLight: false,
  },
  {
    id: 'cyber-blue',
    legacyKey: 'default',
    name: '赛博深蓝 (Dark)',
    subtitle: '深海暗夜与电光青蓝，深钢蓝卡片与赛博光效，科技感拉满',
    primaryColor: '#06b6d4',
    secondaryColor: '#3b82f6',
    primaryRgb: '6, 182, 212',
    bgColor: '#060c18',
    cardBg: '#0d182b',
    cardHover: '#13233e',
    cardSubtle: '#091020',
    cardBorder: 'rgba(6, 182, 212, 0.2)',
    cardBorderHover: 'rgba(6, 182, 212, 0.45)',
    textTitle: '#f0f9ff',
    textBody: '#cbd5e1',
    textMuted: '#64748b',
    isLight: false,
  },
  {
    id: 'emerald-forest',
    legacyKey: 'emerald',
    name: '翡翠幽境 (Dark)',
    subtitle: '幽深松绿暗夜，深苔卡片与清澈翡翠薄荷荧光，护眼静心',
    primaryColor: '#10b981',
    secondaryColor: '#34d399',
    primaryRgb: '16, 185, 129',
    bgColor: '#05140e',
    cardBg: '#0c2219',
    cardHover: '#123023',
    cardSubtle: '#071811',
    cardBorder: 'rgba(16, 185, 129, 0.2)',
    cardBorderHover: 'rgba(16, 185, 129, 0.42)',
    textTitle: '#ecfdf5',
    textBody: '#cbd5e1',
    textMuted: '#6ee7b7',
    isLight: false,
  },
  {
    id: 'amethyst-purple',
    legacyKey: 'obsidian',
    name: '星云紫晶 (Dark)',
    subtitle: '深邃宇宙天鹅绒紫，紫晶矿石卡片与霓虹星芒，神秘沉浸',
    primaryColor: '#a855f7',
    secondaryColor: '#ec4899',
    primaryRgb: '168, 85, 247',
    bgColor: '#0e0719',
    cardBg: '#180e2b',
    cardHover: '#23153d',
    cardSubtle: '#110920',
    cardBorder: 'rgba(168, 85, 247, 0.22)',
    cardBorderHover: 'rgba(168, 85, 247, 0.45)',
    textTitle: '#faf5ff',
    textBody: '#e9d5ff',
    textMuted: '#c084fc',
    isLight: false,
  },
  {
    id: 'sunset-crimson',
    legacyKey: 'rose',
    name: '落日晚霞 (Dark)',
    subtitle: '深黑红宝石底色，晚霞绯红与落日流金，热情浪漫',
    primaryColor: '#f43f5e',
    secondaryColor: '#fb923c',
    primaryRgb: '244, 63, 94',
    bgColor: '#15070c',
    cardBg: '#230c14',
    cardHover: '#30121c',
    cardSubtle: '#19080e',
    cardBorder: 'rgba(244, 63, 94, 0.22)',
    cardBorderHover: 'rgba(244, 63, 94, 0.45)',
    textTitle: '#fff1f2',
    textBody: '#fecdd3',
    textMuted: '#fb7185',
    isLight: false,
  },
  {
    id: 'titanium-slate',
    legacyKey: null,
    name: '钛金极客 (Dark)',
    subtitle: '拉丝钛金与冷钢灰蓝，工业级冷峻极简，专业发烧质感',
    primaryColor: '#38bdf8',
    secondaryColor: '#94a3b8',
    primaryRgb: '56, 189, 248',
    bgColor: '#0a0e17',
    cardBg: '#141c2c',
    cardHover: '#1c273d',
    cardSubtle: '#0e1422',
    cardBorder: 'rgba(148, 163, 184, 0.2)',
    cardBorderHover: 'rgba(56, 189, 248, 0.38)',
    textTitle: '#f8fafc',
    textBody: '#cbd5e1',
    textMuted: '#94a3b8',
    isLight: false,
  },
  {
    id: 'obsidian-oled',
    legacyKey: 'mono',
    name: '黑胶OLED (Dark)',
    subtitle: '纯黑无限深邃画布，高对比度黑胶炭黑卡片与明澈浅绿荧光',
    primaryColor: '#22c55e',
    secondaryColor: '#a3e635',
    primaryRgb: '34, 197, 94',
    bgColor: '#000000',
    cardBg: '#0c0c0e',
    cardHover: '#161619',
    cardSubtle: '#060608',
    cardBorder: 'rgba(255, 255, 255, 0.12)',
    cardBorderHover: 'rgba(34, 197, 94, 0.42)',
    textTitle: '#ffffff',
    textBody: '#e4e4e7',
    textMuted: '#71717a',
    isLight: false,
  },

  // ☀️ Daylight Fresh Themes (6)
  {
    id: 'bright-day',
    legacyKey: 'light',
    name: '明亮白昼 (Light)',
    subtitle: '高保真白昼面板，纯白高光卡片结合经典湛蓝高亮，高辨识度与极佳视效',
    primaryColor: '#2563eb',
    secondaryColor: '#3b82f6',
    primaryRgb: '37, 99, 235',
    bgColor: '#f1f5f9',
    cardBg: '#ffffff',
    cardHover: '#f8fafc',
    cardSubtle: '#e2e8f0',
    cardBorder: '#e2e8f0',
    cardBorderHover: '#cbd5e1',
    textTitle: '#0f172a',
    textBody: '#334155',
    textMuted: '#64748b',
    isLight: true,
  },
  {
    id: 'pure-light',
    legacyKey: null,
    name: '明亮米橙 (Light)',
    subtitle: '温暖纯净米白画布，活力米橙点缀，温和通透',
    primaryColor: '#FF6700',
    secondaryColor: '#f97316',
    primaryRgb: '255, 103, 0',
    bgColor: '#fcf8f4',
    cardBg: '#ffffff',
    cardHover: '#fffaf5',
    cardSubtle: '#f5ebe1',
    cardBorder: '#f0dfd2',
    cardBorderHover: '#fdba74',
    textTitle: '#1c1917',
    textBody: '#44403c',
    textMuted: '#78716c',
    isLight: true,
  },
  {
    id: 'pearl-light',
    legacyKey: null,
    name: '暖白珍珠 (Light)',
    subtitle: '温润舒适的暖白珍珠质感与香槟金光泽，清晰易读全天不累眼',
    primaryColor: '#ea580c',
    secondaryColor: '#d97706',
    primaryRgb: '234, 88, 12',
    bgColor: '#f7f5f0',
    cardBg: '#ffffff',
    cardHover: '#faf8f3',
    cardSubtle: '#eae6db',
    cardBorder: '#e5e0d3',
    cardBorderHover: '#d6cdbd',
    textTitle: '#292524',
    textBody: '#44403c',
    textMuted: '#78716c',
    isLight: true,
  },
  {
    id: 'nordic-sky',
    legacyKey: null,
    name: '北欧晴空 (Light)',
    subtitle: '淡蓝晴空与峡湾冰川晨雾，清新凉爽，视野通透澄净',
    primaryColor: '#0284c7',
    secondaryColor: '#06b6d4',
    primaryRgb: '2, 132, 199',
    bgColor: '#eef5fc',
    cardBg: '#ffffff',
    cardHover: '#f4f9fd',
    cardSubtle: '#dbeafe',
    cardBorder: '#cfe0f2',
    cardBorderHover: '#93c5fd',
    textTitle: '#0c2340',
    textBody: '#1e3a5f',
    textMuted: '#476788',
    isLight: true,
  },
  {
    id: 'matcha-light',
    legacyKey: null,
    name: '抹茶清爽 (Light)',
    subtitle: '清澈宜人的抹茶浅绿与草木清香，自然舒缓，宛如置身庭院',
    primaryColor: '#16a34a',
    secondaryColor: '#10b981',
    primaryRgb: '22, 163, 74',
    bgColor: '#eff7f1',
    cardBg: '#ffffff',
    cardHover: '#f4faf5',
    cardSubtle: '#dcfce7',
    cardBorder: '#d0e8d5',
    cardBorderHover: '#86efac',
    textTitle: '#143521',
    textBody: '#1f4e30',
    textMuted: '#437d57',
    isLight: true,
  },
  {
    id: 'rose-blush',
    legacyKey: null,
    name: '柔霞樱粉 (Light)',
    subtitle: '柔美优雅的樱花粉白暖调，轻盈明快，温馨精致',
    primaryColor: '#e11d48',
    secondaryColor: '#db2777',
    primaryRgb: '225, 29, 72',
    bgColor: '#fdf2f4',
    cardBg: '#ffffff',
    cardHover: '#fff5f7',
    cardSubtle: '#ffe4e6',
    cardBorder: '#fbcfe8',
    cardBorderHover: '#f472b6',
    textTitle: '#3f1523',
    textBody: '#5c1d34',
    textMuted: '#8b3855',
    isLight: true,
  },
];

const THEME_LEGACY_MAP = {
  default: 'cyber-blue',
  azure: 'cyber-blue',
  obsidian: 'amethyst-purple',
  emerald: 'emerald-forest',
  rose: 'sunset-crimson',
  mono: 'obsidian-oled',
  light: 'bright-day',
};

export function resolveThemeId(key) {
  if (!key) return 'cyber-blue';
  if (THEME_LEGACY_MAP[key]) return THEME_LEGACY_MAP[key];
  const found = THEMES.find((t) => t.id === key);
  return found ? found.id : 'cyber-blue';
}

export const THEME_LABELS = THEMES.reduce((acc, t) => {
  acc[t.id] = t.name;
  return acc;
}, {});

export function applyTheme(themeKey) {
  const rawKey = themeKey || localStorage.getItem('nimbus_theme') || 'cyber-blue';
  const activeId = resolveThemeId(rawKey);
  const themeObj = THEMES.find((t) => t.id === activeId) || THEMES[1];

  document.documentElement.setAttribute('data-theme', activeId);
  document.documentElement.setAttribute('data-theme-mode', themeObj.isLight ? 'light' : 'dark');
  if (themeObj.isLight) {
    document.documentElement.classList.add('theme-light');
    document.documentElement.classList.remove('theme-dark');
  } else {
    document.documentElement.classList.remove('theme-light');
    document.documentElement.classList.add('theme-dark');
  }

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--theme-primary', themeObj.primaryColor);
  rootStyle.setProperty('--theme-primary-rgb', themeObj.primaryRgb);
  rootStyle.setProperty('--theme-secondary', themeObj.secondaryColor);
  rootStyle.setProperty('--theme-bg', themeObj.bgColor);
  rootStyle.setProperty('--theme-card-bg', themeObj.cardBg);
  rootStyle.setProperty('--theme-card-hover', themeObj.cardHover);
  rootStyle.setProperty('--theme-card-subtle', themeObj.cardSubtle);
  rootStyle.setProperty('--theme-card-border', themeObj.cardBorder);
  rootStyle.setProperty('--theme-card-border-hover', themeObj.cardBorderHover);
  rootStyle.setProperty('--theme-text-title', themeObj.textTitle);
  rootStyle.setProperty('--theme-text-body', themeObj.textBody);
  rootStyle.setProperty('--theme-text-muted', themeObj.textMuted);

  rootStyle.setProperty('--bg', themeObj.bgColor);
  rootStyle.setProperty('--panel', themeObj.cardBg);
  rootStyle.setProperty('--panel-2', themeObj.cardHover);
  rootStyle.setProperty('--panel-3', themeObj.cardSubtle);
  rootStyle.setProperty('--border', themeObj.cardBorder);
  rootStyle.setProperty('--border-light', themeObj.cardBorderHover);
  rootStyle.setProperty('--text', themeObj.textTitle);
  rootStyle.setProperty('--text-secondary', themeObj.textBody);
  rootStyle.setProperty('--muted', themeObj.textMuted);
  rootStyle.setProperty('--accent', themeObj.primaryColor);
  rootStyle.setProperty('--accent-hover', themeObj.secondaryColor);
  rootStyle.setProperty('--accent-bg', `rgba(${themeObj.primaryRgb}, 0.16)`);

  localStorage.setItem('nimbus_theme', activeId);
  updateThemeUI(activeId);
}

export function updateThemeUI(themeKey) {
  const rawKey = themeKey || localStorage.getItem('nimbus_theme') || 'cyber-blue';
  const key = resolveThemeId(rawKey);
  const themeObj = THEMES.find((t) => t.id === key) || THEMES[1];
  const label = $('#theme-label-name');
  const dot = $('#theme-color-dot');
  const themeName = (window.t ? window.t(`theme.${key}`) : null) || themeObj.name;
  if (label) label.textContent = themeName;
  if (dot) {
    dot.style.backgroundColor = themeObj.primaryColor;
    dot.style.boxShadow = `0 0 8px ${themeObj.primaryColor}`;
  }
  $$('.theme-opt-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeVal === key);
  });
}

export function formatCurrentDate(date = new Date()) {
  const currentLang = (window.i18n && window.i18n.currentLang) || 'zh-CN';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const day = date.getDay();

  const zhWeekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const jaWeekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const koWeekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토曜日'];
  const enWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (currentLang === 'en') {
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${enMonths[date.getMonth()]} ${d}, ${y}  ${enWeekdays[day]}`;
  } else if (currentLang === 'ja') {
    return `${y}年${m}月${d}日  ${jaWeekdays[day]}`;
  } else if (currentLang === 'ko') {
    return `${y}년 ${m}월 ${d}일  ${koWeekdays[day]}`;
  } else if (currentLang === 'zh-TW') {
    return `${y}年${m}月${d}日  ${zhWeekdays[day]}`;
  } else {
    return `${y}年${m}月${d}日  ${zhWeekdays[day]}`;
  }
}

export function updateDateDisplays() {
  const formatted = formatCurrentDate();
  const topbarDate = $('#topbar-date-text');
  if (topbarDate) topbarDate.textContent = formatted;
  const dashDate = $('#dashboard-date-text');
  if (dashDate) dashDate.textContent = formatted;
  const loginDate = $('#login-date-text');
  if (loginDate) loginDate.textContent = formatted;
}

export const FONT_SIZES = [
  { id: 'sm', scale: '88%', fontSize: '14px', badge: 'A⁻' },
  { id: 'normal', scale: '100%', fontSize: '16px', badge: 'A' },
  { id: 'md', scale: '112%', fontSize: '18px', badge: 'A⁺' },
  { id: 'lg', scale: '125%', fontSize: '20px', badge: 'A⁺⁺' },
];

export function resolveFontSizeId(id) {
  if (!id || !['sm', 'normal', 'md', 'lg'].includes(id)) {
    return 'normal';
  }
  return id;
}

export function applyFontSize(sizeKey) {
  const activeId = resolveFontSizeId(sizeKey);
  document.documentElement.setAttribute('data-font-size', activeId);
  try {
    localStorage.setItem('nimbus_font_size', activeId);
  } catch (e) {}
  updateFontSizeUI(activeId);
}

export function updateFontSizeUI(sizeKey) {
  const activeId = resolveFontSizeId(sizeKey || localStorage.getItem('nimbus_font_size'));
  const labels = {
    sm: '紧凑小号 (88%)',
    normal: '标准适中 (100%)',
    md: '舒适中号 (112%)',
    lg: '清晰大号 (125%)',
  };
  const localizedName = (window.t ? window.t(`fontsize.${activeId}`) : null) || labels[activeId];
  const labelEl = $('#fontsize-label-name');
  if (labelEl) labelEl.textContent = localizedName;
  const loginLabelEl = $('#login-fontsize-label');
  if (loginLabelEl) loginLabelEl.textContent = localizedName;
}
