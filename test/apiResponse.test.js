const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const {
  createSuccessPayload,
  createErrorPayload,
  apiResponseMiddleware,
} = require('../src/utils/apiResponse');

test('createSuccessPayload: 规范化空数据', () => {
  const result = createSuccessPayload(null);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.ok(typeof result.timestamp === 'string');
});

test('createSuccessPayload: 规范化数组与基础类型', () => {
  const arrayResult = createSuccessPayload([1, 2, 3]);
  assert.equal(arrayResult.ok, true);
  assert.equal(arrayResult.code, 0);
  assert.deepEqual(arrayResult.data, [1, 2, 3]);

  const stringResult = createSuccessPayload('hello', { message: 'Greeting' });
  assert.equal(stringResult.ok, true);
  assert.equal(stringResult.data, 'hello');
  assert.equal(stringResult.message, 'Greeting');
});

test('createSuccessPayload: 规范化对象并保留根字段零破坏兼容', () => {
  const payload = { vaults: [{ id: 'v1', name: 'Notes' }] };
  const result = createSuccessPayload(payload);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  // 保留旧版消费方式
  assert.deepEqual(result.vaults, [{ id: 'v1', name: 'Notes' }]);
  // 支持新版 data 信封规范
  assert.deepEqual(result.data, { vaults: [{ id: 'v1', name: 'Notes' }] });
  assert.ok(typeof result.timestamp === 'string');
});

test('createErrorPayload: 规范化错误信息', () => {
  const errResult = createErrorPayload('Vault not found', 404);
  assert.equal(errResult.ok, false);
  assert.equal(errResult.error, 'Vault not found');
  assert.equal(errResult.message, 'Vault not found');
  assert.equal(errResult.code, 404);
  assert.equal(errResult.status, 404);
  assert.ok(typeof errResult.timestamp === 'string');

  const objErrResult = createErrorPayload(new Error('Permission denied'), 403);
  assert.equal(objErrResult.ok, false);
  assert.equal(objErrResult.error, 'Permission denied');
  assert.equal(objErrResult.message, 'Permission denied');
  assert.equal(objErrResult.status, 403);
});

test('apiResponseMiddleware: 集成 Express 拦截并统一包装返回契约', async () => {
  const app = express();
  app.use('/api', apiResponseMiddleware);

  // 1. 测试旧版直接返回对象: { vaults: [...] }
  app.get('/api/test-vaults', (req, res) => {
    res.json({ vaults: [{ id: 'v1', name: 'Vault 1' }] });
  });

  // 2. 测试 404 错误
  app.get('/api/test-404', (req, res) => {
    res.status(404).json({ error: 'Item not found' });
  });

  // 3. 测试 400 附带业务 code 错误
  app.get('/api/test-400', (req, res) => {
    res.status(400).json({ error: 'Invalid input', code: 'INVALID_PARAM' });
  });

  // 4. 测试 MCP JSON-RPC 2.0 规范直通保护 (不得篡改)
  app.post('/api/mcp-rpc', (req, res) => {
    res.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 验证 1: 成功返回自动包含 ok: true, code: 0, data, timestamp 以及根属性
    const res1 = await fetch(`http://127.0.0.1:${port}/api/test-vaults`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.ok, true);
    assert.equal(body1.code, 0);
    assert.ok(Array.isArray(body1.vaults));
    assert.deepEqual(body1.data.vaults, body1.vaults);
    assert.ok(typeof body1.timestamp === 'string');

    // 验证 2: 404 错误响应自动对齐 ok: false, error, message, status, code, timestamp
    const res2 = await fetch(`http://127.0.0.1:${port}/api/test-404`);
    assert.equal(res2.status, 404);
    const body2 = await res2.json();
    assert.equal(body2.ok, false);
    assert.equal(body2.error, 'Item not found');
    assert.equal(body2.message, 'Item not found');
    assert.equal(body2.status, 404);
    assert.equal(body2.code, 404);
    assert.ok(typeof body2.timestamp === 'string');

    // 验证 3: 自定义 code 错误
    const res3 = await fetch(`http://127.0.0.1:${port}/api/test-400`);
    assert.equal(res3.status, 400);
    const body3 = await res3.json();
    assert.equal(body3.ok, false);
    assert.equal(body3.error, 'Invalid input');
    assert.equal(body3.code, 'INVALID_PARAM');

    // 验证 4: MCP JSON-RPC 2.0 协议透传保护
    const res4 = await fetch(`http://127.0.0.1:${port}/api/mcp-rpc`, { method: 'POST' });
    const body4 = await res4.json();
    assert.equal(body4.jsonrpc, '2.0');
    assert.equal(body4.id, 1);
    assert.equal(body4.ok, undefined); // 未被篡改
  } finally {
    server.close();
  }
});
