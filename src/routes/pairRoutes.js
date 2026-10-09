const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { requireAuth } = require('../auth');
const pairing = require('../pairing');
const vaultsStore = require('../vaults');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/pair/qr - Public: Generate standard QR Code SVG from text query
router.get('/qr', asyncHandler(async (req, res) => {
  try {
    const text = req.query.text;
    if (!text) return res.status(400).send('Missing text parameter');
    const svg = await QRCode.toString(text, {
      type: 'svg',
      width: 164,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    res.status(500).send(err.message);
  }
}));

// POST /api/pair/create - Authenticated: generate short pair code and standard QR SVG
router.post('/create', requireAuth, asyncHandler(async (req, res) => {
  const { vaultId, token, deviceName, serverUrl } = req.body || {};
  const currentToken = token || req.headers.authorization?.replace(/^Bearer\s+/i, '');

  let vaultName = 'Vault';
  if (vaultId) {
    const v = vaultsStore.getById(vaultId);
    if (v) vaultName = v.name;
  }

  const baseServer = (serverUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const sessionData = {
    userId: req.user.id,
    username: req.user.username,
    vaultId: vaultId || 'default',
    vaultName,
    token: currentToken,
    deviceName: deviceName || 'Mobile-Client',
    serverUrl: baseServer,
  };

  const { code, expiresAt } = pairing.createPairSession(sessionData);
  const pairUrl = `${baseServer}/c/${code}`;

  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(pairUrl, {
      type: 'svg',
      width: 164,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
  } catch (e) {
    console.error('[QR] 生成配对二维码失败:', e);
  }

  res.json({
    ok: true,
    code,
    pairUrl,
    qrSvg,
    expiresAt,
  });
}));

// GET /api/pair/:code - Public (used by mobile landing page)
router.get('/:code', (req, res) => {
  const data = pairing.getPairSession(req.params.code);
  if (!data) {
    return res.status(404).json({ error: '配对二维码已过期或无效，请在电脑端重新生成' });
  }

  const deepLink = `obsidian://nimbus-sync?server=${encodeURIComponent(data.serverUrl)}&vaultId=${encodeURIComponent(data.vaultId)}&vaultName=${encodeURIComponent(data.vaultName)}&token=${encodeURIComponent(data.token)}&device=${encodeURIComponent(data.deviceName)}&autoSync=1`;

  res.json({
    ok: true,
    data: {
      ...data,
      deepLink,
    },
  });
});

module.exports = router;
