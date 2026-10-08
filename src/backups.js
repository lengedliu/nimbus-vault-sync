const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiverPkg = require('archiver');
const vaults = require('./vaults');
const storage = require('./storage');
const webhooks = require('./webhooks');

function createArchiver(format, options = {}) {
  if (typeof archiverPkg === 'function') {
    return archiverPkg(format, options);
  }
  if (format === 'zip') {
    return new archiverPkg.ZipArchive(options);
  }
  return new archiverPkg.TarArchive(options);
}

function backupsDir(vaultId) {
  const dir = path.join(vaults.vaultRoot(vaultId), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeBackupName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'vault';
  // 严格过滤路径分隔符、上级目录符号(..)、控制字符及非法文件名字符
  const cleaned = rawName
    .replace(/[/\\?%*:|"<>.\x00-\x1f\x7f]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '');
  return cleaned.slice(0, 64) || 'vault';
}

function assertSafeBackupFilename(dir, filename) {
  if (!filename || typeof filename !== 'string' || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('非法备份文件名，包含路径穿越危险字符');
  }
  const resolvedDir = path.resolve(dir);
  const resolvedPath = path.resolve(dir, filename);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error('备份文件路径超出安全目录范围');
  }
  return resolvedPath;
}

function backupsIndexPath(vaultId) {
  return path.join(vaults.vaultRoot(vaultId), 'backups-index.json');
}

function loadIndex(vaultId) {
  const p = backupsIndexPath(vaultId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function saveIndex(vaultId, list) {
  fs.writeFileSync(backupsIndexPath(vaultId), JSON.stringify(list, null, 2));
}

function listBackups(vaultId) {
  const dir = backupsDir(vaultId);
  const indexList = loadIndex(vaultId);
  const existingFiles = fs.readdirSync(dir);

  // Sync actual files
  const valid = indexList.filter((item) => existingFiles.includes(item.filename));

  // Add any unindexed zip files
  for (const f of existingFiles) {
    if (f.endsWith('.zip') && !valid.some((v) => v.filename === f)) {
      try {
        const full = assertSafeBackupFilename(dir, f);
        const stat = fs.statSync(full);
        valid.push({
          id: crypto.randomBytes(6).toString('hex'),
          filename: f,
          size: stat.size,
          createdAt: stat.mtimeMs,
          label: '自动快照',
        });
      } catch {}
    }
  }

  valid.sort((a, b) => b.createdAt - a.createdAt);
  saveIndex(vaultId, valid);
  return valid;
}

async function createBackup(vaultId, label = '手动快照') {
  const dir = backupsDir(vaultId);
  const vault = vaults.getById(vaultId);
  const rawVaultName = vault ? vault.name : vaultId;
  const safeName = sanitizeBackupName(rawVaultName);
  const id = crypto.randomBytes(6).toString('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${safeName}-snapshot-${stamp}-${id}.zip`;
  const fullPath = assertSafeBackupFilename(dir, filename);

  const stats = storage.getVaultStats(vaultId);
  const output = fs.createWriteStream(fullPath);
  const archive = createArchiver('zip', { zlib: { level: 6 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const root = vaults.vaultFilesRoot(vaultId);
    if (fs.existsSync(root)) {
      archive.directory(root, false);
    }
    archive.finalize();
  });

  const fileStat = fs.statSync(fullPath);
  const record = {
    id,
    filename,
    label: label || '手动快照',
    size: fileStat.size,
    notesCount: stats.notesCount,
    totalFiles: stats.totalFiles,
    createdAt: Date.now(),
  };

  const list = [record, ...loadIndex(vaultId)];
  saveIndex(vaultId, list);

  // Trigger webhook notification
  webhooks.trigger('backup.created', {
    vaultId,
    vaultName: rawVaultName,
    filename,
    size: fileStat.size,
  }).catch(() => {});

  return record;
}

function deleteBackup(vaultId, backupId) {
  const dir = backupsDir(vaultId);
  const list = loadIndex(vaultId);
  const item = list.find((b) => b.id === backupId || b.filename === backupId);
  if (!item) return false;

  try {
    const full = assertSafeBackupFilename(dir, item.filename);
    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
    }
  } catch (err) {
    console.error('[Backup Delete Error]', err.message);
    return false;
  }

  saveIndex(vaultId, list.filter((b) => b.id !== item.id));
  return true;
}

function getBackupFilePath(vaultId, backupId) {
  const dir = backupsDir(vaultId);
  const list = loadIndex(vaultId);
  const item = list.find((b) => b.id === backupId || b.filename === backupId);
  if (!item) return null;
  try {
    const full = assertSafeBackupFilename(dir, item.filename);
    if (!fs.existsSync(full)) return null;
    return { fullPath: full, filename: item.filename };
  } catch {
    return null;
  }
}

module.exports = {
  listBackups,
  createBackup,
  deleteBackup,
  getBackupFilePath,
};
