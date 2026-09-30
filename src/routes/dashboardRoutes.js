const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireReadAccess, requireWriteAccess, isAdminUser } = require('../permissions');
const vaultsStore = require('../vaults');
const storage = require('../storage');
const devicesStore = require('../devices');
const syncLogger = require('../syncLogger');
const conflictsStore = require('../conflicts');
const gitSync = require('../gitSync');
const dbManager = require('../db');
const { VERSION } = require('../config');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/dashboard/overview
 * 返回聚合看板核心数据：概览指标、各 Vault 状态与健康度、活跃设备、最近同步动态流
 */
router.get('/overview', asyncHandler(async (req, res) => {
  const isAdmin = isAdminUser(req.user);
  const userVaults = vaultsStore.listForUser(req.user.id, isAdmin);
  const fnsHub = req.app.get('fnsHub');

  let totalFiles = 0;
  let totalNotes = 0;
  let totalAttachments = 0;
  let totalBytes = 0;
  let totalConflicts = 0;
  let totalTrash = 0;
  let totalHistory = 0;

  const vaultItems = [];

  for (const v of userVaults) {
    let stats = {
      totalFiles: 0,
      notesCount: 0,
      attachmentsCount: 0,
      configsCount: 0,
      totalBytes: 0,
      trashCount: 0,
      historyCount: 0,
    };

    try {
      stats = storage.getVaultStats(v.id);
    } catch {
      // safe fallback if storage read encounters issue
    }

    totalFiles += stats.totalFiles;
    totalNotes += stats.notesCount;
    totalAttachments += stats.attachmentsCount;
    totalBytes += stats.totalBytes;
    totalTrash += stats.trashCount;
    totalHistory += stats.historyCount;

    let conflictsCount = 0;
    try {
      conflictsCount = conflictsStore.listConflicts(v.id).length;
    } catch {}
    totalConflicts += conflictsCount;

    const isGit = gitSync.isGitRepo(v.id);
    const gitConfig = gitSync.loadConfig(v.id);
    const clientCount = fnsHub ? fnsHub.getClientCount(v.id) : 0;

    vaultItems.push({
      id: v.id,
      name: v.name,
      ownerId: v.ownerId,
      isOwner: v.isOwner,
      myPermission: v.myPermission,
      createdAt: v.createdAt,
      stats,
      conflictsCount,
      isGit,
      gitEnabled: !!gitConfig.enabled,
      clientCount,
    });
  }

  // 接入设备统计
  const userDevices = isAdmin ? devicesStore.listAll() : devicesStore.listForUser(req.user.id);
  let onlineClientCount = 0;
  if (fnsHub && fnsHub.rooms) {
    for (const [vId, room] of fnsHub.rooms.entries()) {
      if (userVaults.some((v) => v.id === vId)) {
        onlineClientCount += room.size;
      }
    }
  }

  // 最近同步动态日志
  let recentLogs = [];
  try {
    const result = syncLogger.getLogs ? syncLogger.getLogs({ limit: 15 }) : null;
    recentLogs = (result && Array.isArray(result.logs)) ? result.logs : [];
  } catch {
    recentLogs = [];
  }

  res.json({
    ok: true,
    version: VERSION,
    stats: {
      version: VERSION,
      totalVaults: userVaults.length,
      totalFiles,
      totalNotes,
      totalAttachments,
      totalBytes,
      totalConflicts,
      totalTrash,
      totalHistory,
      totalDevices: userDevices.length,
      onlineClients: onlineClientCount,
      dbType: dbManager.type || 'sqlite',
      serverTime: new Date().toISOString(),
    },
    vaults: vaultItems,
    recentLogs,
  });
}));

/**
 * GET /api/dashboard/kanban/:vaultId
 * 获取指定 Vault 的看板卡片与泳道配置（存储于 .nimbus-kanban.json）
 */
router.get('/kanban/:vaultId', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireReadAccess(req, res)) return;

  const defaultBoard = {
    columns: [
      { id: 'todo', title: '📌 待办 (To Do)', color: '#58a6ff' },
      { id: 'in_progress', title: '🚀 进行中 (In Progress)', color: '#e3b341' },
      { id: 'review', title: '🔍 归纳复盘 (Review)', color: '#a371f7' },
      { id: 'done', title: '✅ 已完成 (Done)', color: '#3fb950' },
    ],
    cards: [],
  };

  try {
    const raw = storage.readFile(vaultId, '.nimbus-kanban.json');
    if (!raw) {
      return res.json({ ok: true, board: defaultBoard });
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed.columns || !Array.isArray(parsed.columns)) {
      parsed.columns = defaultBoard.columns;
    }
    if (!parsed.cards || !Array.isArray(parsed.cards)) {
      parsed.cards = defaultBoard.cards;
    }
    return res.json({ ok: true, board: parsed });
  } catch {
    return res.json({ ok: true, board: defaultBoard });
  }
}));

/**
 * PUT /api/dashboard/kanban/:vaultId
 * 保存指定 Vault 的看板配置与任务卡片
 */
router.put('/kanban/:vaultId', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireWriteAccess(req, res)) return;

  const { columns, cards } = req.body || {};
  if (!Array.isArray(columns) || !Array.isArray(cards)) {
    return res.status(400).json({ error: 'Invalid board data: columns and cards arrays required' });
  }

  const cleanBoard = {
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.username,
    columns: columns.map((c) => ({
      id: String(c.id || '').trim() || 'todo',
      title: String(c.title || '').trim() || '未命名列',
      color: String(c.color || '#58a6ff'),
    })),
    cards: cards.map((card, idx) => ({
      id: card.id || `card-${Date.now()}-${idx}`,
      columnId: card.columnId || 'todo',
      title: String(card.title || '').trim() || '未命名任务',
      description: String(card.description || '').trim(),
      priority: ['high', 'medium', 'low'].includes(card.priority) ? card.priority : 'medium',
      tags: Array.isArray(card.tags) ? card.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      notePath: card.notePath ? String(card.notePath).trim() : null,
      dueDate: card.dueDate ? String(card.dueDate).trim() : null,
      createdAt: card.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  };

  const buffer = Buffer.from(JSON.stringify(cleanBoard, null, 2), 'utf8');
  storage.writeFile(vaultId, '.nimbus-kanban.json', buffer);

  res.json({ ok: true, message: '看板已保存', board: cleanBoard });
}));

/**
 * GET /api/dashboard/kanban/:vaultId/scan-tasks
 * 扫描指定 Vault 中的所有 Markdown 笔记，提取 `- [ ]` 与 `- [x]` 待办任务
 */
router.get('/kanban/:vaultId/scan-tasks', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireReadAccess(req, res)) return;

  const manifest = storage.getManifest(vaultId);
  const mdPaths = Object.keys(manifest).filter((p) => p.toLowerCase().endsWith('.md'));

  const tasks = [];
  const taskRegex = /^[ \t]*- \[( |x|X)\][ \t]+(.*)$/gm;

  // 扫描前 100 篇 markdown 笔记以保证极速响应
  const targetPaths = mdPaths.slice(0, 100);

  // 复用 storage.js 里搜索/统计功能共享的那份内容缓存（getTextContent），
  // 命中缓存就不用重新读盘；并且每处理一批文件就让出一次事件循环
  // （storage.yieldToEventLoop），避免笔记很大时这个接口把整个进程卡住——
  // 这是之前 get_vault_stats/search_notes/list_tags 三个地方都踩过的同一个坑，
  // 看板这个新功能不应该再踩第四次。
  let processed = 0;
  for (const relPath of targetPaths) {
    const meta = manifest[relPath];
    const content = storage.getTextContent(vaultId, relPath, meta);
    if (!content) continue;
    let match;
    taskRegex.lastIndex = 0;
    while ((match = taskRegex.exec(content)) !== null) {
      const isDone = match[1].toLowerCase() === 'x';
      const text = match[2].trim();
      if (!text) continue;

      tasks.push({
        id: `scanned-${Buffer.from(relPath + ':' + text).toString('base64').slice(0, 16)}`,
        title: text,
        notePath: relPath,
        completed: isDone,
        suggestedColumn: isDone ? 'done' : 'todo',
      });
      if (tasks.length >= 150) break;
    }
    if (tasks.length >= 150) break;

    processed++;
    if (processed % storage.SEARCH_YIELD_BATCH_SIZE === 0) {
      await storage.yieldToEventLoop();
    }
  }

  res.json({ ok: true, count: tasks.length, tasks });
}));

/**
 * GET /api/dashboard/review/:vaultId
 * 获取知识复习与灵感热力图数据：
 * 1. 365 天知识沉淀热力图 (Contribution Grid)
 * 2. 历史上的今天 (On This Day)
 * 3. 随机漫游卡片 (Random Note)
 */
router.get('/review/:vaultId', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireReadAccess(req, res)) return;

  const manifest = storage.getManifest(vaultId);
  const mdPaths = Object.keys(manifest).filter((p) => p.toLowerCase().endsWith('.md'));

  // 1. Calculate 365 days Heatmap
  const today = new Date();
  const heatmap = {}; // "YYYY-MM-DD" -> count

  for (const relPath of Object.keys(manifest)) {
    const meta = manifest[relPath];
    if (meta && meta.mtime) {
      const dateStr = new Date(meta.mtime).toISOString().slice(0, 10);
      heatmap[dateStr] = (heatmap[dateStr] || 0) + 1;
    }
  }

  // 2. On This Day (历史上的今天)
  const currentMMDD = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const onThisDay = [];

  for (const relPath of mdPaths) {
    const meta = manifest[relPath];
    if (!meta || !meta.mtime) continue;

    const fileDate = new Date(meta.mtime);
    const fileMMDD = `${String(fileDate.getMonth() + 1).padStart(2, '0')}-${String(fileDate.getDate()).padStart(2, '0')}`;

    if (fileMMDD === currentMMDD) {
      const yearsAgo = today.getFullYear() - fileDate.getFullYear();
      let excerpt = '';
      try {
        const text = storage.getTextContent(vaultId, relPath, meta);
        if (text) {
          excerpt = text.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 150);
        }
      } catch {}

      onThisDay.push({
        path: relPath,
        title: path.basename(relPath, '.md'),
        mtime: meta.mtime,
        size: meta.size,
        yearsAgo,
        excerpt,
      });
    }
  }

  // Sort onThisDay by mtime desc
  onThisDay.sort((a, b) => b.mtime - a.mtime);

  // 3. Random Notes (随机漫游：最多随机抽选 3 篇不重复笔记)
  const randomNotes = [];
  if (mdPaths.length > 0) {
    const shuffled = [...mdPaths].sort(() => Math.random() - 0.5);
    const sampledPaths = shuffled.slice(0, Math.min(3, shuffled.length));

    for (const randomPath of sampledPaths) {
      const meta = manifest[randomPath];
      let excerpt = '';
      try {
        const text = storage.getTextContent(vaultId, randomPath, meta);
        if (text) {
          excerpt = text.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);
        }
      } catch {}

      randomNotes.push({
        path: randomPath,
        title: path.basename(randomPath, '.md'),
        mtime: meta ? meta.mtime : Date.now(),
        size: meta ? meta.size : 0,
        excerpt,
      });
    }
  }

  const randomNote = randomNotes.length > 0 ? randomNotes[0] : null;

  res.json({
    ok: true,
    totalNotes: mdPaths.length,
    heatmap,
    onThisDay,
    randomNote,
    randomNotes,
  });
}));

/**
 * GET /api/dashboard/review/:vaultId/random
 * 获取下一批随机漫游笔记 (最多3篇)
 */
router.get('/review/:vaultId/random', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireReadAccess(req, res)) return;

  const manifest = storage.getManifest(vaultId);
  const mdPaths = Object.keys(manifest).filter((p) => p.toLowerCase().endsWith('.md'));

  if (mdPaths.length === 0) {
    return res.json({ ok: true, randomNote: null, randomNotes: [] });
  }

  const shuffled = [...mdPaths].sort(() => Math.random() - 0.5);
  const sampledPaths = shuffled.slice(0, Math.min(3, shuffled.length));
  const randomNotes = [];

  for (const randomPath of sampledPaths) {
    const meta = manifest[randomPath];
    let excerpt = '';
    try {
      const text = storage.getTextContent(vaultId, randomPath, meta);
      if (text) {
        excerpt = text.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);
      }
    } catch {}

    randomNotes.push({
      path: randomPath,
      title: path.basename(randomPath, '.md'),
      mtime: meta ? meta.mtime : Date.now(),
      size: meta ? meta.size : 0,
      excerpt,
    });
  }

  const randomNote = randomNotes.length > 0 ? randomNotes[0] : null;

  res.json({
    ok: true,
    randomNote,
    randomNotes,
  });
}));

/**
 * GET /api/dashboard/review/:vaultId/date?date=YYYY-MM-DD
 * 获取指定日期在 Vault 中修改/产出的笔记列表
 */
router.get('/review/:vaultId/date', asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  const { date } = req.query;
  if (!requireReadAccess(req, res)) return;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: '日期格式无效，应为 YYYY-MM-DD' });
  }

  const manifest = storage.getManifest(vaultId);
  const mdPaths = Object.keys(manifest).filter((p) => p.toLowerCase().endsWith('.md'));

  const matchedNotes = [];
  for (const relPath of mdPaths) {
    const meta = manifest[relPath];
    if (!meta || !meta.mtime) continue;

    const fileDateStr = new Date(meta.mtime).toISOString().slice(0, 10);
    if (fileDateStr === date) {
      let excerpt = '';
      try {
        const text = storage.getTextContent(vaultId, relPath, meta);
        if (text) {
          excerpt = text.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);
        }
      } catch {}

      matchedNotes.push({
        path: relPath,
        title: path.basename(relPath, '.md'),
        mtime: meta.mtime,
        size: meta.size,
        excerpt,
      });
    }
  }

  matchedNotes.sort((a, b) => b.mtime - a.mtime);

  res.json({
    ok: true,
    date,
    total: matchedNotes.length,
    notes: matchedNotes,
  });
}));

module.exports = router;
