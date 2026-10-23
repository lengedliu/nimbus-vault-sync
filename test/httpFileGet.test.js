const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');

// 独立 DATA_DIR：每个测试文件以子进程运行
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-httpget-'));

const vaults = require('../src/vaults');
const storage = require('../src/storage');
// 在 fileRoutes 解构 requireAuth 之前短路鉴权（require-cache 同对象）
const auth = require('../src/auth');
auth.requireAuth = (req, res, next) => next();

/**
 * H-1 回归：GET /:vaultId/files/* 曾引用未定义变量 vaultId（fileRoutes.js:72，
 * 随 c7059108 引入）→ 每次拉取 500 ReferenceError、先记「拉取成功」日志、
 * 读流句柄泄漏。修复为路由内声明 vaultId；本测试用真实 HTTP 请求固化。
 */
test('HTTP GET 文件：返回 200、带 X-File-Hash/X-File-Mtime 头、内容正确；缺失文件 404', async () => {
  const vault = await vaults.create('u1', 'HttpGetProbe');
  const payload = Buffer.from('hello http get probe', 'utf8');
  storage.writeFile(vault.id, 'probe.md', payload);

  const router = require('../src/routes/fileRoutes');
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'u1', username: 'u1', role: 'admin' }; next(); });
  app.use('/api/vaults', router);

  await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${vault.id}/files/probe.md`);
        assert.equal(res.status, 200, 'GET 文件必须成功（旧代码此处 ReferenceError → 500）');
        const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
        assert.equal(res.headers.get('x-file-hash'), expectedHash, 'X-File-Hash 必须与内容 sha256 一致');
        const mtimeHeader = res.headers.get('x-file-mtime');
        assert.ok(mtimeHeader && Number(mtimeHeader) > 0, 'X-File-Mtime 头应存在且为合法时间戳');
        assert.equal(await res.text(), 'hello http get probe');

        const missing = await fetch(`http://127.0.0.1:${port}/api/vaults/${vault.id}/files/nope.md`);
        assert.equal(missing.status, 404);
      } catch (err) {
        assert.fail(`HTTP 探测失败: ${err.message}`);
      } finally {
        srv.close(resolve);
      }
    });
  });
});
