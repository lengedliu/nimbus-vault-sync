const express = require('express');
const { requireAuth } = require('../auth');
const cloudBackup = require('../cloudBackup');
const vaultsStore = require('../vaults');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router({ mergeParams: true });

// Check permission helper
function checkVaultWrite(req, res, vaultId) {
  const vault = vaultsStore.getById(vaultId);
  if (!vault) {
    res.status(404).json({ error: 'Vault 不存在' });
    return false;
  }
  const hasAccess = vaultsStore.hasWriteAccess(req.user.id, vaultId, req.user.role === 'admin');
  if (!hasAccess) {
    res.status(403).json({ error: '您没有该 Vault 的管理权限' });
    return false;
  }
  return true;
}

// GET /api/vaults/:vaultId/cloud-backup/config
router.get('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const config = cloudBackup.getVaultCloudConfig(vaultId);
  res.json({ ok: true, config });
});

// POST /api/vaults/:vaultId/cloud-backup/config
router.post('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const config = req.body || {};
  const saved = cloudBackup.saveVaultCloudConfig(vaultId, config);
  res.json({ ok: true, config: saved });
});

// POST /api/vaults/:vaultId/cloud-backup/test
router.post('/test', requireAuth, asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!checkVaultWrite(req, res, vaultId)) return;

  const { provider, s3, webdav } = req.body || {};
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
