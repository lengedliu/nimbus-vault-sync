const express = require('express');
const fs = require('fs');
const { pipeline, Transform } = require('stream');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const storage = require('../storage');
const syncLogger = require('../syncLogger');
const syncRules = require('../syncRules');
const webhooks = require('../webhooks');
const { requireReadAccess, requireWriteAccess } = require('../permissions');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

// 单次上传大小上限（字节），可用 MAX_UPLOAD_MB 环境变量覆盖。
// 流式写入之后，这个上限只是"防止无限占用磁盘"的安全阀，不再等价于"这么大都要先进内存"。
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '500', 10) * 1024 * 1024;

// GET file content — 流式下载，不再把整个文件先读进内存。
router.get('/:vaultId/files/*', (req, res) => {
  if (!requireReadAccess(req, res)) return;
  let relPath = req.params[0] || '';
  try {
    relPath = decodeURIComponent(relPath);
  } catch (e) {}
  relPath = relPath.replace(/\\/g, '/');

  let fileInfo;
  try {
    fileInfo = storage.readFileStream(req.params.vaultId, relPath);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (fileInfo === null) return res.status(404).json({ error: 'File not found' });

  syncLogger.recordLog({
    vaultId: req.params.vaultId,
    userId: req.user.id,
    username: req.user.username,
    deviceName: req.headers['x-device-name'] || 'REST / Web',
    clientIp: req.ip || req.connection.remoteAddress,
    action: 'pull',
    path: relPath,
    size: fileInfo.size,
    status: 'success',
    detail: '读取笔记文件',
  });

  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(fileInfo.size));
  fileInfo.stream.on('error', (err) => {
    console.error('[FileRoutes] read stream error:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  fileInfo.stream.pipe(res);
});

// PUT (create/update) file content. Body = raw bytes, streamed straight to disk.
// Headers: X-Mtime (ms since epoch, optional), X-Base-Hash (hash client last knew, optional — used for conflict detection)
router.put('/:vaultId/files/*', (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  let relPath = req.params[0] || '';
  try {
    relPath = decodeURIComponent(relPath);
  } catch (e) {}
  relPath = relPath.replace(/\\/g, '/');

  const vaultId = req.params.vaultId;
  const mtime = req.headers['x-mtime'] ? parseInt(req.headers['x-mtime'], 10) : undefined;
  const baseHash = req.headers['x-base-hash'] || undefined;
  const deviceName = req.headers['x-device-name'] || 'REST / Web Client';
  const declaredLength = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : null;

  // 校验同步黑名单/忽略规则：防止黑名单规则被 REST 上传接口绕过
  if (syncRules.isPathIgnored(vaultId, relPath)) {
    syncLogger.recordLog({
      vaultId,
      userId: req.user.id,
      username: req.user.username,
      deviceName,
      clientIp: req.ip || req.connection.remoteAddress,
      action: 'ignore',
      path: relPath,
      status: 'ignored',
      detail: '命中同步黑名单/忽略规则，已拦截',
    });
    return res.status(200).json({
      written: false,
      ignored: true,
      conflict: null,
      message: '文件命中该笔记库的同步黑名单或忽略规则，已跳过写入',
      path: relPath,
    });
  }

  if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `文件超过单次上传上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）` });
  }

  let tempPath;
  try {
    tempPath = storage.createUploadTempPath(vaultId);
  } catch (e) {
    return res.status(500).json({ error: `无法创建临时文件: ${e.message}` });
  }

  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  let aborted = false;

  const cleanupTemp = () => {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  };

  // 边接收边写盘、边算哈希，而不是等 body-parser 把整份请求体先攒成一个 Buffer。
  const hashingPass = new Transform({
    transform(chunk, enc, cb) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        return cb(new Error(`文件超过单次上传上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  const writeStream = fs.createWriteStream(tempPath);

  pipeline(req, hashingPass, writeStream, async (err) => {
    if (err) {
      cleanupTemp();
      const status = aborted ? 413 : 400;
      const message = err.message || '上传失败';
      syncLogger.recordLog({
        vaultId,
        userId: req.user.id,
        username: req.user.username,
        deviceName,
        clientIp: req.ip || req.connection.remoteAddress,
        action: 'update',
        path: relPath,
        size: totalBytes,
        status: 'error',
        detail: `写入失败: ${message}`,
      });
      if (!res.headersSent) res.status(status).json({ error: message });
      return;
    }

    try {
      const incomingHash = hash.digest('hex');
      const result = await storage.withFileLock(vaultId, relPath, async () => {
        return storage.writeFileFromPath(vaultId, relPath, tempPath, incomingHash, { mtime, baseHash });
      });
      const clientDeviceId = req.headers['x-device-id'] || req.headers['x-client-id'] || null;
      
      if (!result.written && result.conflict) {
        // Broadcast the newly created conflict file to all connected clients
        req.app.get('fnsHub').broadcastFileChange(vaultId, result.conflict, { currentHash: result.conflictHash || incomingHash }, req.user.id, clientDeviceId);
        
        syncLogger.recordLog({
          vaultId,
          userId: req.user.id,
          username: req.user.username,
          deviceName,
          clientIp: req.ip || req.connection.remoteAddress,
          action: 'conflict',
          path: relPath,
          size: totalBytes,
          hash: result.currentHash,
          status: 'conflict',
          detail: `版本冲突，已自动生成冲突副本: ${result.conflict}`,
        });
      } else {
        req.app.get('fnsHub').broadcastFileChange(vaultId, relPath, result, req.user.id, clientDeviceId);

        syncLogger.recordLog({
          vaultId,
          userId: req.user.id,
          username: req.user.username,
          deviceName,
          clientIp: req.ip || req.connection.remoteAddress,
          action: 'update',
          path: relPath,
          size: totalBytes,
          hash: result.currentHash,
          status: 'success',
          detail: '成功写入并同步文件',
        });
      }

      res.json({
        ...result,
        hash: result.currentHash,
      });
    } catch (e) {
      cleanupTemp();
      syncLogger.recordLog({
        vaultId,
        userId: req.user.id,
        username: req.user.username,
        deviceName,
        clientIp: req.ip || req.connection.remoteAddress,
        action: 'update',
        path: relPath,
        size: totalBytes,
        status: 'error',
        detail: `写入失败: ${e.message}`,
      });
      res.status(400).json({ error: e.message });
    }
  });
});

// DELETE file
router.delete('/:vaultId/files/*', asyncHandler(async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  let relPath = req.params[0] || '';
  try {
    relPath = decodeURIComponent(relPath);
  } catch (e) {}
  relPath = relPath.replace(/\\/g, '/');

  const vaultId = req.params.vaultId;
  const deviceName = req.headers['x-device-name'] || 'REST / Web Client';
  const clientDeviceId = req.headers['x-device-id'] || req.headers['x-client-id'] || null;
  const ok = await storage.withFileLock(vaultId, relPath, async () => {
    return storage.deleteFile(vaultId, relPath);
  });
  req.app.get('fnsHub').broadcastFileDelete(vaultId, relPath, req.user.id, clientDeviceId);

  if (ok) {
    webhooks.trigger('file.deleted', {
      vaultId,
      path: relPath,
      userId: req.user.id,
      username: req.user.username,
    }).catch(() => {});
  }

  syncLogger.recordLog({
    vaultId,
    userId: req.user.id,
    username: req.user.username,
    deviceName,
    clientIp: req.ip || req.connection.remoteAddress,
    action: 'delete',
    path: relPath,
    status: ok ? 'success' : 'error',
    detail: ok ? '移入回收站 (软删除)' : '文件不存在或删除失败',
  });

  res.json({ deleted: ok });
}));

// POST batch delete files into trash
router.post('/:vaultId/batch/delete', express.json(), asyncHandler(async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: '请提供要删除的文件路径列表' });
  }

  const { vaultId } = req.params;
  const fnsHub = req.app.get('fnsHub');
  const deviceName = req.headers['x-device-name'] || 'Web Client (Batch)';
  const results = [];
  const deletedChanges = [];
  let successCount = 0;

  for (const rawPath of paths) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    const relPath = rawPath.replace(/\\/g, '/');
    const ok = await storage.withFileLock(vaultId, relPath, async () => {
      return storage.deleteFile(vaultId, relPath);
    });
    if (ok) {
      successCount++;
      deletedChanges.push({ action: 'delete', path: relPath });
      webhooks.trigger('file.deleted', {
        vaultId,
        path: relPath,
        userId: req.user.id,
        username: req.user.username,
      }).catch(() => {});
    }
    results.push({ path: relPath, success: ok });
  }

  if (fnsHub && deletedChanges.length > 0) {
    if (deletedChanges.length === 1) {
      fnsHub.broadcastFileDelete(vaultId, deletedChanges[0].path, req.user.id);
    } else {
      fnsHub.broadcastBatchChanges(vaultId, deletedChanges, req.user.id);
    }
  }

  syncLogger.recordLog({
    vaultId,
    userId: req.user.id,
    username: req.user.username,
    deviceName,
    clientIp: req.ip || req.connection.remoteAddress,
    action: 'delete',
    path: `批量删除 (${successCount}/${paths.length} 项)`,
    status: successCount > 0 ? 'success' : 'error',
    detail: `批量移入回收站: ${successCount} 个文件成功`,
  });

  res.json({ success: true, count: successCount, results });
}));

// POST batch move files to target folder
router.post('/:vaultId/batch/move', express.json(), (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  const { paths, targetFolder } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: '请提供要移动的文件列表' });
  }

  const { vaultId } = req.params;
  const fnsHub = req.app.get('fnsHub');
  const targetDir = (targetFolder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const results = [];
  const batchChanges = [];
  let successCount = 0;

  for (const rawPath of paths) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    const relPath = rawPath.replace(/\\/g, '/');
    const filename = relPath.split('/').pop();
    const newRelPath = targetDir ? `${targetDir}/${filename}` : filename;
    if (newRelPath === relPath) {
      results.push({ path: relPath, newPath: newRelPath, success: true, unchanged: true });
      continue;
    }

    if (syncRules.isPathIgnored(vaultId, newRelPath)) {
      results.push({ path: relPath, newPath: newRelPath, success: false, error: '目标路径命中黑名单忽略规则' });
      continue;
    }

    const moveRes = storage.moveVaultFile(vaultId, relPath, newRelPath);
    if (moveRes.ok) {
      successCount++;
      batchChanges.push({ action: 'delete', path: relPath });
      const newMeta = storage.getManifestEntry(vaultId, newRelPath);
      batchChanges.push({ action: 'update', path: newRelPath, ...newMeta });
    }
    results.push({ path: relPath, newPath: newRelPath, success: moveRes.ok, error: moveRes.error });
  }

  if (fnsHub && batchChanges.length > 0) {
    fnsHub.broadcastBatchChanges(vaultId, batchChanges, req.user.id);
  }

  syncLogger.recordLog({
    vaultId,
    userId: req.user.id,
    username: req.user.username,
    deviceName: req.headers['x-device-name'] || 'Web Client (Batch)',
    clientIp: req.ip || req.connection.remoteAddress,
    action: 'update',
    path: `批量移动 (${successCount} 项 -> /${targetDir})`,
    status: successCount > 0 ? 'success' : 'error',
    detail: `批量移动至目录「/${targetDir}」: ${successCount} 个文件成功`,
  });

  res.json({ success: true, count: successCount, results });
});

// GET / POST batch download selected files as ZIP
router.get('/:vaultId/batch/download', (req, res) => {
  if (!requireReadAccess(req, res)) return;
  const { vaultId } = req.params;
  let paths = [];
  try {
    if (req.query.paths) {
      paths = JSON.parse(req.query.paths);
    }
  } catch {
    paths = (req.query.paths || '').split(',').map((p) => decodeURIComponent(p.trim())).filter(Boolean);
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: '请提供要下载的文件列表' });
  }

  const filename = `vault-selected-${paths.length}-files-${new Date().toISOString().slice(0, 10)}.zip`;
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
  });

  storage.exportFilesZip(vaultId, paths, res).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

module.exports = router;
