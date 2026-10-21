const express = require('express');
const { requireAuth } = require('../auth');
const cloudBackup = require('../cloudBackup');
const { requireReadAccess, requireOwnerAccess } = require('../permissions');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router({ mergeParams: true });

function maskCloudConfig(config) {
  if (!config) return config;
  return {
    ...config,
    s3: {
      ...(config.s3 || {}),
      hasSecretKey: Boolean(config.s3?.secretAccessKey),
      secretAccessKey: config.s3?.secretAccessKey ? '********' : '',
    },
    webdav: {
      ...(config.webdav || {}),
      hasPassword: Boolean(config.webdav?.password),
      password: config.webdav?.password ? '********' : '',
    },
  };
}

// GET /api/vaults/:vaultId/cloud-backup/config
router.get('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!requireReadAccess(req, res, vaultId)) return;

  const config = cloudBackup.getVaultCloudConfig(vaultId);
  res.json({ ok: true, config: maskCloudConfig(config) });
});

// POST /api/vaults/:vaultId/cloud-backup/config
router.post('/config', requireAuth, (req, res) => {
  const { vaultId } = req.params;
  if (!requireOwnerAccess(req, res, vaultId)) return;

  const config = req.body || {};
  const saved = cloudBackup.saveVaultCloudConfig(vaultId, config);
  res.json({ ok: true, config: maskCloudConfig(saved) });
});

// POST /api/vaults/:vaultId/cloud-backup/test
router.post('/test', requireAuth, asyncHandler(async (req, res) => {
  const { vaultId } = req.params;
  if (!requireOwnerAccess(req, res, vaultId)) return;

  const current = cloudBackup.getVaultCloudConfig(vaultId);
  const { provider, s3, webdav } = req.body || {};
  try {
    if (provider === 's3') {
      const s3Input = { ...(current.s3 || {}), ...(s3 || {}) };
      if (s3Input.secretAccessKey === '********') {
        s3Input.secretAccessKey = current.s3?.secretAccessKey || '';
      }
      const result = await cloudBackup.testS3Config(s3Input);
      return res.json(result);
    } else if (provider === 'webdav') {
      const webdavInput = { ...(current.webdav || {}), ...(webdav || {}) };
      if (webdavInput.password === '********') {
        webdavInput.password = current.webdav?.password || '';
      }
      const result = await cloudBackup.testWebDAVConfig(webdavInput);
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
  if (!requireOwnerAccess(req, res, vaultId)) return;

  const { label } = req.body || {};
  try {
    const result = await cloudBackup.runVaultCloudBackup(vaultId, label || '手动触发多云容灾备份');
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}));

module.exports = router;

