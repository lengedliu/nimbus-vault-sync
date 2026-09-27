// --------------------------- Dynamic Themes & Font Size & Date Helpers ---------------------------
import { $, $$, escapeHtml } from './state.js';
import { toast } from './dialogs.js';

export const THEMES = [
  // ⭐ 2026 全新设计工坊 (New 4 Design Archetypes · 8 Variants)
  // 1. 🖋️ 人文纸本 · 书卷学者风 (Editorial Monograph & Warm Parchment)
  {
    id: 'editorial-paper',
    legacyKey: null,
    name: '人文纸本 (Light)',
    archetypeId: 'editorial-paper',
    archetypeName: '人文纸本 · 书卷学者风',
    subtitle: '暖象牙纸质基底，温润琥珀与沉木墨黑，极具人文书卷气，深度长文思考沉浸首选',
    primaryColor: '#b45309',
    secondaryColor: '#d97706',
    primaryRgb: '180, 83, 9',
    bgColor: '#fcfbf7',
    topbarBg: 'rgba(252, 251, 247, 0.98)',
    sidebarBg: '#f5f2e9',
    cardBg: '#ffffff',
    cardHover: '#faf8f2',
    cardSubtle: '#ede7d8',
    cardBorder: '#e7e2d4',
    cardBorderHover: '#d4c7ac',
    bgAccent: 'rgba(180, 83, 9, 0.08)',
    borderAccent: 'rgba(180, 83, 9, 0.3)',
    textTitle: '#26221d',
    textBody: '#544d42',
    textMuted: '#5e574d',
    fontHeading: '"Charter", "Georgia", "Songti SC", "SimSun", serif',
    radius: '6px',
    radiusLg: '10px',
    isLight: true,
    isFeatured: true,
  },
  {
    id: 'editorial-paper-dark',
    legacyKey: null,
    name: '人文纸本 (Dark)',
    archetypeId: 'editorial-paper',
    archetypeName: '人文纸本 · 书卷学者风',
    subtitle: '深墨夜间书斋画布，暖琥珀流光与温润古雅炭黑，深夜沉浸式学术思绪流动',
    primaryColor: '#f59e0b',
    secondaryColor: '#fbbf24',
    primaryRgb: '245, 158, 11',
    bgColor: '#181715',
    topbarBg: 'rgba(24, 23, 21, 0.98)',
    sidebarBg: '#1f1d19',
    cardBg: '#24221e',
    cardHover: '#2c2924',
    cardSubtle: '#1f1d19',
    cardBorder: '#38342d',
    cardBorderHover: 'rgba(217, 119, 6, 0.4)',
    bgAccent: 'rgba(217, 119, 6, 0.15)',
    borderAccent: 'rgba(217, 119, 6, 0.4)',
    textTitle: '#f0ebe1',
    textBody: '#aba294',
    textMuted: '#aba294',
    fontHeading: '"Charter", "Georgia", "Songti SC", "SimSun", serif',
    radius: '6px',
    radiusLg: '10px',
    isLight: false,
    isFeatured: true,
  },

  // 2. 📐 瑞士理性 · 极简网格风 (Swiss International Modernism)
  {
    id: 'swiss-grid',
    legacyKey: null,
    name: '瑞士理性 (Dark)',
    archetypeId: 'swiss-grid',
    archetypeName: '瑞士理性 · 极简网格风',
    subtitle: '冷调岩灰与纯粹无衬线排版，经典包豪斯朱砂红点睛，克制高效，突出绝对功能主义',
    primaryColor: '#f43f5e',
    secondaryColor: '#fb7185',
    primaryRgb: '244, 63, 94',
    bgColor: '#0c0d10',
    topbarBg: 'rgba(12, 13, 15, 0.98)',
    sidebarBg: '#121418',
    cardBg: '#181a20',
    cardHover: '#20232b',
    cardSubtle: '#121318',
    cardBorder: '#262933',
    cardBorderHover: '#f43f5e',
    bgAccent: 'rgba(225, 29, 72, 0.15)',
    borderAccent: '#f43f5e',
    textTitle: '#f4f4f5',
    textBody: '#a1a1aa',
    textMuted: '#a1a1aa',
    fontHeading: '"Helvetica Neue", "Arial", "PingFang SC", sans-serif',
    radius: '2px',
    radiusLg: '4px',
    isLight: false,
    isFeatured: true,
  },
  {
    id: 'swiss-grid-light',
    legacyKey: null,
    name: '瑞士理性 (Light)',
    archetypeId: 'swiss-grid',
    archetypeName: '瑞士理性 · 极简网格风',
    subtitle: '严谨包豪斯白昼网格，克制灰调与高纯度红宝石色点睛，极致清爽的现代主义排版',
    primaryColor: '#e11d48',
    secondaryColor: '#be123c',
    primaryRgb: '225, 29, 72',
    bgColor: '#f4f4f5',
    topbarBg: 'rgba(244, 244, 245, 0.98)',
    sidebarBg: '#eaeaea',
    cardBg: '#ffffff',
    cardHover: '#f9f9fb',
    cardSubtle: '#eaeaea',
    cardBorder: '#d4d4d8',
    cardBorderHover: '#e11d48',
    bgAccent: 'rgba(225, 29, 72, 0.08)',
    borderAccent: '#e11d48',
    textTitle: '#09090b',
    textBody: '#52525b',
    textMuted: '#52525b',
    fontHeading: '"Helvetica Neue", "Arial", "PingFang SC", sans-serif',
    radius: '2px',
    radiusLg: '4px',
    isLight: true,
    isFeatured: true,
  },

  // 3. 🌲 深林苔原 · 极客侘寂风 (Kyoto Forest & Zen Moss)
  {
    id: 'kyoto-forest',
    legacyKey: null,
    name: '深林苔原 (Dark)',
    archetypeId: 'kyoto-forest',
    archetypeName: '深林苔原 · 极客侘寂风',
    subtitle: '玄武岩深灰绿与柔和苔藓竹青，自然舒缓无蓝光刺眼，静水流深，夜间专注写作',
    primaryColor: '#2dd4bf',
    secondaryColor: '#14b8a6',
    primaryRgb: '45, 212, 191',
    bgColor: '#080d0b',
    topbarBg: 'rgba(10, 15, 13, 0.98)',
    sidebarBg: '#101815',
    cardBg: '#15201c',
    cardHover: '#1b2924',
    cardSubtle: '#0b120f',
    cardBorder: '#22332c',
    cardBorderHover: 'rgba(45, 212, 191, 0.45)',
    bgAccent: 'rgba(45, 212, 191, 0.12)',
    borderAccent: 'rgba(45, 212, 191, 0.4)',
    textTitle: '#e6f3ee',
    textBody: '#9bbdb1',
    textMuted: '#8caaa0',
    fontHeading: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    radius: '10px',
    radiusLg: '14px',
    isLight: false,
    isFeatured: true,
  },
  {
    id: 'kyoto-forest-light',
    legacyKey: null,
    name: '深林清泉 (Light)',
    archetypeId: 'kyoto-forest',
    archetypeName: '深林苔原 · 极客侘寂风',
    subtitle: '雨后青苔与林间晨雾浅绿，清澈柔和如森林清泉，护眼静谧且生机盎然',
    primaryColor: '#0d9488',
    secondaryColor: '#0f766e',
    primaryRgb: '13, 148, 136',
    bgColor: '#f2f6f4',
    topbarBg: 'rgba(242, 246, 244, 0.98)',
    sidebarBg: '#e5ece8',
    cardBg: '#ffffff',
    cardHover: '#f7faf8',
    cardSubtle: '#e5ece8',
    cardBorder: '#ccd8d1',
    cardBorderHover: 'rgba(13, 148, 136, 0.35)',
    bgAccent: 'rgba(13, 148, 136, 0.08)',
    borderAccent: 'rgba(13, 148, 136, 0.35)',
    textTitle: '#13241e',
    textBody: '#415951',
    textMuted: '#415951',
    fontHeading: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    radius: '10px',
    radiusLg: '14px',
    isLight: true,
    isFeatured: true,
  },

  // 4. ⚡ 先锋工坊 · 极速开发者风 (Modern DevStudio)
  {
    id: 'dev-studio',
    legacyKey: null,
    name: '先锋工坊 (Dark)',
    archetypeId: 'dev-studio',
    archetypeName: '先锋工坊 · 极速开发者风',
    subtitle: '天鹅绒深炭灰与电光紫/靛蓝，致敬 Linear、Zed 与 Vercel，高信息密度与极致生产力',
    primaryColor: '#818cf8',
    secondaryColor: '#6366f1',
    primaryRgb: '129, 140, 248',
    bgColor: '#0d1117',
    topbarBg: 'rgba(13, 17, 23, 0.98)',
    sidebarBg: '#131821',
    cardBg: '#18202c',
    cardHover: '#1f2937',
    cardSubtle: '#090d13',
    cardBorder: '#283344',
    cardBorderHover: 'rgba(129, 140, 248, 0.42)',
    bgAccent: 'rgba(99, 102, 241, 0.15)',
    borderAccent: 'rgba(129, 140, 248, 0.4)',
    textTitle: '#f0f6fc',
    textBody: '#c9d1d9',
    textMuted: '#94a3b8',
    fontHeading: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    radius: '8px',
    radiusLg: '12px',
    isLight: false,
    isFeatured: true,
  },
  {
    id: 'dev-studio-light',
    legacyKey: null,
    name: '先锋工坊 (Light)',
    archetypeId: 'dev-studio',
    archetypeName: '先锋工坊 · 极速开发者风',
    subtitle: '高信息密度白昼工程面板，电光靛蓝高亮，现代工程团队追求的高效与纯粹',
    primaryColor: '#4f46e5',
    secondaryColor: '#4338ca',
    primaryRgb: '79, 70, 229',
    bgColor: '#f8fafc',
    topbarBg: 'rgba(248, 250, 252, 0.98)',
    sidebarBg: '#f1f5f9',
    cardBg: '#ffffff',
    cardHover: '#f8fafc',
    cardSubtle: '#f1f5f9',
    cardBorder: '#e2e8f0',
    cardBorderHover: 'rgba(99, 102, 241, 0.35)',
    bgAccent: 'rgba(99, 102, 241, 0.08)',
    borderAccent: 'rgba(99, 102, 241, 0.35)',
    textTitle: '#0f172a',
    textBody: '#475569',
    textMuted: '#475569',
    fontHeading: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    radius: '8px',
    radiusLg: '12px',
    isLight: true,
    isFeatured: true,
  },

  // 🌙 经典暗夜极客主题 (Classic Dark Geek Themes)
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

  // ☀️ 经典日间清爽主题 (Classic Daylight Fresh Themes)
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
  const themeObj = THEMES.find((t) => t.id === activeId) || THEMES[0];

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
  rootStyle.setProperty('--bg-sidebar', themeObj.sidebarBg || themeObj.cardSubtle || themeObj.bgColor);
  rootStyle.setProperty('--bg-topbar', themeObj.topbarBg || themeObj.cardBg || themeObj.bgColor);
  rootStyle.setProperty('--bg-card', themeObj.cardBg);
  rootStyle.setProperty('--bg-card-hover', themeObj.cardHover);
  rootStyle.setProperty('--bg-accent', themeObj.bgAccent || `rgba(${themeObj.primaryRgb}, 0.12)`);
  rootStyle.setProperty('--border-accent', themeObj.borderAccent || themeObj.cardBorderHover);

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

  if (themeObj.fontHeading) {
    rootStyle.setProperty('--font-heading', themeObj.fontHeading);
  } else {
    rootStyle.removeProperty('--font-heading');
  }

  if (themeObj.radius) {
    rootStyle.setProperty('--radius', themeObj.radius);
    rootStyle.setProperty('--radius-lg', themeObj.radiusLg || themeObj.radius);
  } else {
    rootStyle.removeProperty('--radius');
    rootStyle.removeProperty('--radius-lg');
  }

  localStorage.setItem('nimbus_theme', activeId);
  updateThemeUI(activeId);
}

export function updateThemeUI(themeKey) {
  const rawKey = themeKey || localStorage.getItem('nimbus_theme') || 'cyber-blue';
  const key = resolveThemeId(rawKey);
  const themeObj = THEMES.find((t) => t.id === key) || THEMES[0];
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
  const koWeekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
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

  $$('.fontsize-opt-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.sizeVal === activeId);
  });
}

export function initFontSizeSwitcher() {
  const setupSwitcher = (btnId, menuId, resetBtnId) => {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;

    btn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
      const themeMenu = document.getElementById('theme-dropdown-menu');
      if (themeMenu) themeMenu.classList.add('hidden');
      const langMenu = document.getElementById('lang-dropdown-menu');
      if (langMenu) langMenu.classList.add('hidden');
      const loginLangMenu = document.getElementById('login-lang-dropdown');
      if (loginLangMenu) loginLangMenu.classList.add('hidden');
    };

    const resetBtn = document.getElementById(resetBtnId);
    if (resetBtn) {
      resetBtn.onclick = (e) => {
        e.stopPropagation();
        applyFontSize('normal');
        menu.classList.add('hidden');
        toast(window.t ? window.t('fontsize.reset_success', '已恢复标准字号大小 (100%)') : '已恢复标准字号大小 (100%)');
      };
    }

    menu.querySelectorAll('.fontsize-opt-item').forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        const val = item.dataset.sizeVal;
        applyFontSize(val);
        menu.classList.add('hidden');
        const labels = {
          sm: '紧凑小号 (88%)',
          normal: '标准适中 (100%)',
          md: '舒适中号 (112%)',
          lg: '清晰大号 (125%)',
        };
        const name = (window.t ? window.t(`fontsize.${val}`) : null) || labels[val] || val;
        toast(`已切换字号至「${name}」`);
      };
    });

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.classList.add('hidden');
      }
    });
  };

  setupSwitcher('fontsize-menu-btn', 'fontsize-dropdown-menu', 'fontsize-reset-btn');
  setupSwitcher('login-fontsize-btn', 'login-fontsize-dropdown', 'login-fontsize-reset-btn');

  updateFontSizeUI();
}

// 🎨 Visual Theme Gallery Modal
export function openThemeSelectorModal() {
  const currentThemeId = resolveThemeId(localStorage.getItem('nimbus_theme'));
  let activeFilter = 'all'; // 'featured', 'all', 'dark', 'light'

  function renderModalContent() {
    const featuredThemes = THEMES.filter((th) => th.isFeatured);
    const darkThemes = THEMES.filter((th) => !th.isLight);
    const lightThemes = THEMES.filter((th) => th.isLight);

    const filteredThemes = THEMES.filter((th) => {
      if (activeFilter === 'featured') return th.isFeatured;
      if (activeFilter === 'dark') return !th.isLight;
      if (activeFilter === 'light') return th.isLight;
      return true;
    });

    return `
      <div class="theme-gallery-modal">
        <div class="theme-gallery-header">
          <div class="theme-gallery-title-group">
            <h3>🎨 ${window.t ? window.t('theme.gallery_title', '主题画廊与视觉风格') : '主题画廊与视觉风格'}</h3>
            <p class="theme-gallery-subtitle">包含 4 套 2026 全新设计工坊方案（人文纸本、瑞士理性、深林苔原、先锋工坊）与多款经典双色调极客主题，共 ${THEMES.length} 款自由随心切换</p>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <a href="/ui-demo.html" target="_blank" class="theme-dropdown-gallery-btn" style="text-decoration:none;font-size:12px;padding:4px 12px;border:1px solid var(--accent);" title="在新标签页中打开静态高保真对比 Demo">
              👁️ 静态对比 Demo
            </a>
            <button class="btn btn-icon btn-close-modal" id="btn-close-theme-modal" title="关闭" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 8px;">✕</button>
          </div>
        </div>

        <div class="theme-filter-nav">
          <button class="theme-filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">全部风格 (${THEMES.length})</button>
          <button class="theme-filter-pill ${activeFilter === 'featured' ? 'active' : ''}" data-filter="featured" style="font-weight:600;">⭐ 4套全新设计 (${featuredThemes.length})</button>
          <button class="theme-filter-pill ${activeFilter === 'dark' ? 'active' : ''}" data-filter="dark">🌙 暗夜深色 (${darkThemes.length})</button>
          <button class="theme-filter-pill ${activeFilter === 'light' ? 'active' : ''}" data-filter="light">☀️ 日间清爽 (${lightThemes.length})</button>
        </div>

        <div class="theme-gallery-body">
          <div class="theme-cards-grid">
            ${filteredThemes
              .map((th) => {
                const isActive = th.id === currentThemeId;
                const localizedName = (window.t ? window.t(`theme.${th.id}`) : null) || th.name;
                return `
                  <div class="theme-card-box ${isActive ? 'active' : ''} ${th.isFeatured ? 'featured-theme-card' : ''}" data-theme-id="${th.id}" style="${th.isFeatured ? 'border-color:rgba(' + th.primaryRgb + ', 0.35);' : ''}">
                    <div class="theme-card-box-header">
                      <div class="theme-card-box-title">
                        <span class="theme-card-box-dot" style="background-color:${th.primaryColor};box-shadow:0 0 8px ${th.primaryColor};"></span>
                        <span style="${th.fontHeading ? 'font-family:' + th.fontHeading + ';' : ''}">${escapeHtml(localizedName)}</span>
                      </div>
                      <div style="display:flex;align-items:center;gap:4px;">
                        ${th.isFeatured ? `<span class="theme-badge" style="background:rgba(${th.primaryRgb}, 0.15);color:${th.primaryColor};border:1px solid rgba(${th.primaryRgb}, 0.3);font-size:10.5px;">⭐ 全新</span>` : ''}
                        <span class="theme-badge ${isActive ? 'active-badge' : 'type-badge'}">
                          ${isActive ? (window.t ? window.t('theme.active_badge', '使用中 ✓') : '使用中 ✓') : th.isLight ? 'Light' : 'Dark'}
                        </span>
                      </div>
                    </div>

                    ${th.archetypeName ? `<div style="font-size:11px;font-weight:600;color:${th.primaryColor};margin-bottom:4px;">✦ ${escapeHtml(th.archetypeName)}</div>` : ''}
                    <div class="theme-card-desc">${escapeHtml(th.subtitle)}</div>

                    <div class="theme-preview-simulation" style="background:${th.bgColor};border:1px solid ${th.cardBorder};border-radius:${th.radius || '6px'};padding:8px 10px;margin:8px 0;display:flex;flex-direction:column;gap:6px;">
                      <div class="theme-sim-row" style="display:flex;justify-content:space-between;align-items:center;">
                        <span style="display:inline-flex;align-items:center;gap:4px;color:${th.textTitle};font-weight:600;font-size:11px;${th.fontHeading ? 'font-family:' + th.fontHeading + ';' : ''}">
                          📓 Vault 同步大盘
                        </span>
                        <span class="theme-sim-badge" style="font-size:10px;padding:1px 6px;border-radius:${th.radius || '4px'};color:${th.primaryColor};background:rgba(${th.primaryRgb},0.15);border:1px solid ${th.cardBorder};">
                          ${th.radius ? 'Radius ' + th.radius : 'AES-256'}
                        </span>
                      </div>
                      <div class="theme-sim-bar" style="height:4px;width:100%;border-radius:2px;background:${th.cardSubtle};overflow:hidden;">
                        <div class="theme-sim-progress" style="height:100%;width:80%;background:${th.primaryColor};border-radius:2px;"></div>
                      </div>
                    </div>

                    <div class="theme-card-footer">
                      <div class="theme-palette-swatches">
                        <span class="theme-swatch-circle" style="background:${th.primaryColor}" title="Primary: ${th.primaryColor}"></span>
                        <span class="theme-swatch-circle" style="background:${th.secondaryColor}" title="Secondary: ${th.secondaryColor}"></span>
                        <span class="theme-swatch-circle" style="background:${th.bgColor}" title="Canvas: ${th.bgColor}"></span>
                        <span style="font-size:11px;color:var(--muted);margin-left:4px;font-family:monospace;">${th.primaryColor}</span>
                      </div>
                      <button class="theme-apply-action-btn" style="color:${th.primaryColor};background:transparent;border:none;font-size:12px;font-weight:600;cursor:pointer;">
                        ${isActive ? (window.t ? window.t('theme.applied', '当前生效') : '当前生效') : (window.t ? window.t('theme.apply_btn', '点击应用 →') : '点击应用 →')}
                      </button>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>

        <div class="theme-gallery-footer">
          <div class="theme-gallery-footer-info">
            <span>✨</span>
            <span>点击任意卡片即可无刷新全局热切换，字体、圆角与色彩系统会自动同步并持久保存</span>
          </div>
          <button class="btn btn-primary" id="btn-theme-modal-done" style="padding:6px 20px;">
            ${window.t ? window.t('theme.close_modal', '完成并关闭') : '完成并关闭'}
          </button>
        </div>
      </div>
    `;
  }

  const backdrop = $('#modal-backdrop');
  const container = $('#modal-container');
  if (!backdrop || !container) return;

  container.innerHTML = renderModalContent();
  backdrop.classList.remove('hidden');

  function bindModalEvents() {
    container.querySelectorAll('.theme-filter-pill').forEach((pill) => {
      pill.onclick = () => {
        activeFilter = pill.dataset.filter;
        container.innerHTML = renderModalContent();
        bindModalEvents();
      };
    });

    const closeBtn = container.querySelector('#btn-close-theme-modal');
    const doneBtn = container.querySelector('#btn-theme-modal-done');
    const closeModal = () => {
      backdrop.classList.add('hidden');
      container.innerHTML = '';
    };
    if (closeBtn) closeBtn.onclick = closeModal;
    if (doneBtn) doneBtn.onclick = closeModal;

    container.querySelectorAll('.theme-card-box').forEach((card) => {
      card.onclick = () => {
        const selectedId = card.dataset.themeId;
        applyTheme(selectedId);
        toast(`已成功应用「${(window.t ? window.t('theme.' + selectedId) : null) || selectedId}」主题`);
        container.innerHTML = renderModalContent();
        bindModalEvents();
      };
    });
  }

  bindModalEvents();
}

export function initThemeSwitcher() {
  const menuBtn = $('#theme-menu-btn');
  const menu = $('#theme-dropdown-menu');
  if (!menuBtn || !menu) return;

  const featuredThemes = THEMES.filter((t) => t.isFeatured);
  const classicDarkThemes = THEMES.filter((t) => !t.isFeatured && !t.isLight);
  const classicLightThemes = THEMES.filter((t) => !t.isFeatured && t.isLight);
  const currentTheme = resolveThemeId(localStorage.getItem('nimbus_theme'));

  menu.innerHTML = `
    <div class="theme-dropdown-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--panel-2);">
      <span style="font-size:11.5px;font-weight:700;color:var(--text);">视觉风格 (${THEMES.length}款)</span>
      <button id="topbar-open-gallery-btn" class="theme-dropdown-gallery-btn" style="padding:2px 8px;font-size:11px;border-radius:12px;background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent);cursor:pointer;">🎨 画廊展厅</button>
    </div>

    <div style="padding:4px 0;max-height:420px;overflow-y:auto;">
      <!-- ⭐ 4套全新设计方案 -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px 3px 12px;">
        <span style="font-size:10.5px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;">⭐ 2026 全新设计 (4套/8款)</span>
        <a href="/ui-demo.html" target="_blank" style="font-size:10px;color:var(--muted);text-decoration:none;" title="查看独立对比 Demo">对比 Demo ↗</a>
      </div>
      ${featuredThemes
        .map((th) => {
          const isActive = th.id === currentTheme;
          const localizedName = (window.t ? window.t(`theme.${th.id}`) : null) || th.name;
          return `
            <button class="theme-opt-item ${isActive ? 'active' : ''}" data-theme-val="${th.id}" style="display:flex;align-items:center;gap:8px;width:100%;padding:5px 12px;background:transparent;border:none;cursor:pointer;color:var(--text);font-size:12px;text-align:left;">
              <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${th.primaryColor};box-shadow:0 0 6px ${th.primaryColor};flex-shrink:0;"></span>
              <span style="flex:1;${th.fontHeading ? 'font-family:' + th.fontHeading + ';' : ''}">${escapeHtml(localizedName)}</span>
              ${isActive ? '<span style="color:var(--accent);font-size:11px;">✓</span>' : `<span style="font-size:9.5px;color:var(--muted);padding:1px 4px;border-radius:3px;background:var(--panel-3);">${th.isLight ? 'Light' : 'Dark'}</span>`}
            </button>
          `;
        })
        .join('')}

      <!-- 🌙 经典暗夜深色 -->
      <div style="padding:8px 12px 3px 12px;font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;border-top:1px solid var(--border);margin-top:6px;">🌙 经典暗夜深色 (${classicDarkThemes.length})</div>
      ${classicDarkThemes
        .map((th) => {
          const isActive = th.id === currentTheme;
          const localizedName = (window.t ? window.t(`theme.${th.id}`) : null) || th.name;
          return `
            <button class="theme-opt-item ${isActive ? 'active' : ''}" data-theme-val="${th.id}" style="display:flex;align-items:center;gap:8px;width:100%;padding:5px 12px;background:transparent;border:none;cursor:pointer;color:var(--text);font-size:12px;text-align:left;">
              <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${th.primaryColor};box-shadow:0 0 6px ${th.primaryColor};flex-shrink:0;"></span>
              <span style="flex:1;">${escapeHtml(localizedName)}</span>
              ${isActive ? '<span style="color:var(--accent);font-size:11px;">✓</span>' : ''}
            </button>
          `;
        })
        .join('')}

      <!-- ☀️ 经典日间明亮 -->
      <div style="padding:8px 12px 3px 12px;font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;border-top:1px solid var(--border);margin-top:6px;">☀️ 经典日间清爽 (${classicLightThemes.length})</div>
      ${classicLightThemes
        .map((th) => {
          const isActive = th.id === currentTheme;
          const localizedName = (window.t ? window.t(`theme.${th.id}`) : null) || th.name;
          return `
            <button class="theme-opt-item ${isActive ? 'active' : ''}" data-theme-val="${th.id}" style="display:flex;align-items:center;gap:8px;width:100%;padding:5px 12px;background:transparent;border:none;cursor:pointer;color:var(--text);font-size:12px;text-align:left;">
              <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${th.primaryColor};box-shadow:0 0 6px ${th.primaryColor};flex-shrink:0;"></span>
              <span style="flex:1;">${escapeHtml(localizedName)}</span>
              ${isActive ? '<span style="color:var(--accent);font-size:11px;">✓</span>' : ''}
            </button>
          `;
        })
        .join('')}
    </div>

    <div style="padding:6px 12px;border-top:1px solid var(--border);background:var(--panel-2);display:flex;justify-content:space-between;align-items:center;">
      <a href="/ui-demo.html" target="_blank" style="font-size:11px;color:var(--muted);text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
        <span>👁️</span> 打开静态对比工作台
      </a>
      <span style="font-size:10.5px;color:var(--muted);">共 ${THEMES.length} 款</span>
    </div>
  `;

  menuBtn.onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
    const langMenu = document.getElementById('lang-dropdown-menu');
    if (langMenu) langMenu.classList.add('hidden');
    const fontMenu = document.getElementById('fontsize-dropdown-menu');
    if (fontMenu) fontMenu.classList.add('hidden');
  };

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== menuBtn) {
      menu.classList.add('hidden');
    }
  });

  const galleryBtn = menu.querySelector('#topbar-open-gallery-btn');
  if (galleryBtn) {
    galleryBtn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      openThemeSelectorModal();
    };
  }

  menu.querySelectorAll('.theme-opt-item').forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      const val = item.dataset.themeVal;
      applyTheme(val);
      menu.classList.add('hidden');
      const name = (window.t ? window.t(`theme.${val}`) : null) || THEME_LABELS[val];
      toast(`已切换至「${name}」风格`);
      initThemeSwitcher();
    };
  });

  applyTheme(localStorage.getItem('nimbus_theme') || 'cyber-blue');
}
