require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

const APP_VERSION = process.env.APP_VERSION || pkg.version || '1.3.2';
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
const INSECURE_DEFAULT_SECRET = 'dev-only-insecure-secret';

function resolveJwtSecret() {
  const envSecret = (process.env.JWT_SECRET || '').trim();
  // 1. If user explicitly provided a valid non-placeholder secret in environment, use it
  if (envSecret && envSecret !== INSECURE_DEFAULT_SECRET) {
    return { secret: envSecret, source: 'env' };
  }

  // 2. Otherwise, check or create a persisted strong random secret file in DATA_DIR
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const secretFilePath = path.join(DATA_DIR, '.jwt_secret');
    if (fs.existsSync(secretFilePath)) {
      const persisted = fs.readFileSync(secretFilePath, 'utf8').trim();
      if (persisted && persisted.length >= 32) {
        return { secret: persisted, source: 'file' };
      }
    }

    // Generate new 256-bit (64 hex chars) cryptographically secure random secret
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFilePath, generated, { encoding: 'utf8', mode: 0o600 });
    return { secret: generated, source: 'generated' };
  } catch {
    // Fallback for read-only filesystem: generate in-memory random secret
    const memSecret = crypto.randomBytes(32).toString('hex');
    return { secret: memSecret, source: 'memory' };
  }
}

const { secret: JWT_SECRET, source: JWT_SECRET_SOURCE } = resolveJwtSecret();

module.exports = {
  VERSION: APP_VERSION,
  APP_VERSION,
  PORT: 3000,
  JWT_SECRET,
  JWT_SECRET_SOURCE,
  TOKEN_TTL: process.env.TOKEN_TTL || '30d',
  DATA_DIR,
  VAULTS_DIR: path.join(DATA_DIR, 'vaults'),
  USERS_FILE: path.join(DATA_DIR, 'users.json'),
  VAULTS_FILE: path.join(DATA_DIR, 'vaults.json'),
  // Optional: set both paths to serve HTTPS/WSS directly; setting only one is an error.
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || '',
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || '',
  // 反向代理部署时显式设置 TRUST_PROXY=true；默认不信任客户端提供的转发头。
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
};
