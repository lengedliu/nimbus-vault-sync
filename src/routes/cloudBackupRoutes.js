const express = require('express');
const { requireAuth } = require('../auth');
const cloudBackup = require('../cloudBackup');
const vaultsStore = require('../vaults');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router({ mergeParams: true });

function redactSecrets(config) {
  return {
    ...config,
    s3: { ...(config.s3 || {}), secretAccessKey: '', secretAccessKeyConfigured: Boolean(config.s3 && config.s3.secretAccessKey) },
    webdav: { ...(config.webdav || {}), password: '', passwordConfigured: Boolean(config.webdav && config.webdav.password) },
  };
}

// Check permission helper
function checkVaultWrite(req, res, vaultId) {
  const vault = vaultsStore.getById(vaultId);
  if (!vault) {
    res.status(404).json({ error: 'Vault 不存在' });
    return false;
  }
  if (vault.ownerId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: '只有 Vault 所有者或系统管理员可以管理云备份' });
    return false;
  }
  return true;
}

// GET /api/vaults/:vaultId/cloud-backup/config
router.get('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const config = cloudBackup.getVaultCloudConfig(vaultId);
  res.json({ ok: true, config: redactSecrets(config) });
});

// POST /api/vaults/:vaultId/cloud-backup/config
router.post('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const config = req.body || {};
  const saved = cloudBackup.saveVaultCloudConfig(vaultId, config);
  res.json({ ok: true, config: redactSecrets(saved) });
});

// POST /api/vaults/:vaultId/cloud-backup/test
router.post('/test', requireAuth, asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const { provider } = req.body || {};
  const stored = cloudBackup.getVaultCloudConfig(vaultId);
  const s3 = { ...stored.s3, ...((req.body || {}).s3 || {}) };
  if (!s3.secretAccessKey) s3.secretAccessKey = stored.s3.secretAccessKey;
  const webdav = { ...stored.webdav, ...((req.body || {}).webdav || {}) };
  if (!webdav.password) webdav.password = stored.webdav.password;
  try {
    if (provider === 's3') {
      const result = await cloudBackup.testS3Config(s3 || {});
      return res.json(result);
    } else if (provider === 'webdav') {
      const result = await cloudBackup.testWebDAVConfig(webdav || {});
      return res.json(result);
    } else {
      return res.status(400).json({ error: '不支持的存储类型，请选择 S3 或 WebDAV' });
    }
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
}));

// POST /api/vaults/:vaultId/cloud-backup/run
router.post('/run', requireAuth, asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const { label } = req.body || {};
  try {
    const result = await cloudBackup.runVaultCloudBackup(vaultId, label || '手动触发多云容灾备份');
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}));

module.exports = router;
