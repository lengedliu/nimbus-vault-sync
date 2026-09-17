require('dotenv').config();
const path = require('path');
const pkg = require('../package.json');

const APP_VERSION = process.env.APP_VERSION || pkg.version || '1.2.0';
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || './data');

module.exports = {
  VERSION: APP_VERSION,
  APP_VERSION,
  PORT: parseInt(process.env.PORT || '3000', 10),
  JWT_SECRET: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  TOKEN_TTL: process.env.TOKEN_TTL || '30d',
  DATA_DIR,
  VAULTS_DIR: path.join(DATA_DIR, 'vaults'),
  USERS_FILE: path.join(DATA_DIR, 'users.json'),
  VAULTS_FILE: path.join(DATA_DIR, 'vaults.json'),
  // Optional: if both are set, the server listens over HTTPS/WSS using these
  // files. If either is missing, it falls back to plain HTTP/WS.
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || '',
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || '',
  // 部署在 Nginx/Caddy/Traefik/Cloud Run 等反向代理或容器环境之后时，Express 应信任反向代理。
  // 默认启用 1 层反代信任（可通过 TRUST_PROXY=0 或 false 显式关闭）。
  TRUST_PROXY: process.env.TRUST_PROXY !== '0' && process.env.TRUST_PROXY !== 'false',
};
