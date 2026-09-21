const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-wstoken-'));
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config');
const users = require('../src/users');
const vaults = require('../src/vaults');
const wsHub = require('../src/wsHub');
const devicesStore = require('../src/devices');

test('WebSocket Token: 验证 token 提取、前缀清洗、authToken 引用兼容及撤销断开', async (t) => {
  // Setup user and vault
  const username = 'wstest_' + Date.now();
  const user = await users.createUser(username, 'password123');
  const vault = vaults.create(user.id, 'WS_Test_Vault_' + Date.now());

  const testServer = http.createServer();
  wsHub.init(testServer);

  await new Promise((resolve) => testServer.listen(0, resolve));
  const port = testServer.address().port;

  t.after(async () => {
    wsHub.close();
    await new Promise((resolve) => testServer.close(resolve));
    try { await vaults.remove(vault.id); } catch {}
    try { users.remove(user.id); } catch {}
  });

  const validToken = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

  await t.test('1. 通过标准 query token 连接 WebSocket 成功', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${validToken}&vaultId=${vault.id}`);
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  await t.test('2. 支持 Bearer 前缀格式的 query token 自动清洗', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent('Bearer ' + validToken)}&vaultId=${vault.id}`);
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  await t.test('3. 支持 authToken 参数名称兼容引用', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=${validToken}&vaultId=${vault.id}`);
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  await t.test('4. 支持 Authorization 请求头传递 Bearer token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?vaultId=${vault.id}`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  await t.test('5. 缺失或无效 token 连接被拒绝 (401 Unauthorized)', async () => {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?vaultId=${vault.id}&token=invalid_token`);
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('unexpected-response', (req, res) => {
          assert.equal(res.statusCode, 401);
          reject(new Error(`HTTP ${res.statusCode}`));
        });
        ws.on('error', reject);
      }),
      /HTTP 401/
    );
  });

  await t.test('6. 撤销的设备 token 升级连接被拦截 (401 Unauthorized)', async () => {
    const dev = devicesStore.generateDeviceToken(user, 'Test Device For Revoke', 'desktop', 1);
    const deviceToken = dev.token;
    devicesStore.revokeDevice(dev.id, user.id);

    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${deviceToken}&vaultId=${vault.id}`);
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('unexpected-response', (req, res) => {
          assert.equal(res.statusCode, 401);
          reject(new Error(`HTTP ${res.statusCode}`));
        });
        ws.on('error', reject);
      }),
      /HTTP 401/
    );
  });

  await t.test('7. 在线连接触发 disconnectToken 时收到 auth_revoked 并断开 (code 4001)', async () => {
    const dev = devicesStore.generateDeviceToken(user, 'Test Online Device', 'desktop', 1);
    const activeToken = dev.token;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${activeToken}&vaultId=${vault.id}`);

    let receivedAuthRevoked = false;
    let closedWith4001 = false;

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        setTimeout(() => {
          wsHub.disconnectToken(activeToken, 'token_revoked');
        }, 50);
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'auth_revoked') {
            receivedAuthRevoked = true;
          }
        } catch {}
      });

      ws.on('close', (code) => {
        if (code === 4001) {
          closedWith4001 = true;
        }
        resolve();
      });

      ws.on('error', reject);
    });

    assert.equal(receivedAuthRevoked, true, '应当接收到 auth_revoked 消息');
    assert.equal(closedWith4001, true, '应当以 4001 状态码关闭连接');
  });
});
