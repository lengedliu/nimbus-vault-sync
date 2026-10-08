/**
 * 统一 API 返回契约规范与中间件 (Unified API Response Contract)
 *
 * 契约规范说明：
 * 1. 成功响应 (HTTP 2xx):
 *    {
 *      ok: true,
 *      code: 0,
 *      data: <payload>,
 *      ...<payloadKeys>, // 平铺对象根属性，确保客户端与旧版插件（如 obsidian-plugin / app.js）零破坏兼容
 *      message: "success" | <customMessage>,
 *      timestamp: "2026-09-18T..."
 *    }
 *
 * 2. 失败响应 (HTTP 4xx / 5xx):
 *    {
 *      ok: false,
 *      error: <errorMessage>,
 *      message: <errorMessage>, // 兼容对齐 message 与 error 字段
 *      code: <statusCodeOrCustomCode>,
 *      status: <statusCode>,
 *      timestamp: "2026-09-18T..."
 *    }
 */

function createSuccessPayload(data, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const code = options.code !== undefined ? options.code : 0;
  const message = options.message;

  if (data === null || data === undefined) {
    return {
      ok: true,
      code,
      data: null,
      ...(message ? { message } : {}),
      timestamp,
    };
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: true,
      code,
      data,
      ...(message ? { message } : {}),
      timestamp,
    };
  }

  return {
    ok: true,
    code: data.code !== undefined ? data.code : code,
    data: data.data !== undefined ? data.data : data,
    ...data,
    ...(message ? { message } : (data.message ? { message: data.message } : {})),
    timestamp: data.timestamp || timestamp,
  };
}

function createErrorPayload(error, status = 400, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const errorMsg = typeof error === 'string'
    ? error
    : (error && (error.error || error.message)) || 'Request failed';
  const code = options.code !== undefined
    ? options.code
    : (error && error.code !== undefined ? error.code : status);

  const extra = (typeof error === 'object' && error !== null && !Array.isArray(error))
    ? Object.fromEntries(Object.entries(error).filter(([k]) => !['stack', 'name'].includes(k)))
    : {};

  return {
    ok: false,
    error: errorMsg,
    message: errorMsg,
    code,
    status,
    timestamp,
    ...extra,
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
}

/**
 * 统一 API 响应拦截与增强中间件
 * 自动规范化挂载在 /api 下的所有路由返回
 */
function apiResponseMiddleware(req, res, next) {
  // 注入快捷辅助响应方法
  res.apiSuccess = function (data, options) {
    const payload = createSuccessPayload(data, options);
    return res.status(options?.status || 200).json(payload);
  };

  res.apiError = function (error, status = 400, options) {
    const payload = createErrorPayload(error, status, options);
    return res.status(status).json(payload);
  };

  // 统一包装 res.json，保障契约 100% 一致性
  const originalJson = res.json.bind(res);
  res.json = function unifiedJson(body) {
    // 1. MCP Streamable / JSON-RPC 规范协议透传保护 (含 jsonrpc: '2.0')
    if (body && typeof body === 'object' && body.jsonrpc === '2.0') {
      return originalJson(body);
    }

    // 2. 错误响应统一包装 (HTTP 4xx, 5xx)
    if (res.statusCode >= 400) {
      if (body && typeof body === 'object' && body.ok === false) {
        const errorMsg = body.error || body.message || 'Request failed';
        const standardized = {
          ok: false,
          error: errorMsg,
          message: body.message || errorMsg,
          code: body.code !== undefined ? body.code : res.statusCode,
          status: res.statusCode,
          timestamp: body.timestamp || new Date().toISOString(),
          ...body,
        };
        return originalJson(standardized);
      }

      const errorMsg = (body && (body.error || body.message))
        || (typeof body === 'string' ? body : 'Request failed');
      const extra = (typeof body === 'object' && body !== null && !Array.isArray(body)) ? body : {};
      const standardized = {
        ok: false,
        error: errorMsg,
        message: errorMsg,
        code: res.statusCode,
        status: res.statusCode,
        timestamp: new Date().toISOString(),
        ...extra,
      };
      return originalJson(standardized);
    }

    // 3. 成功响应统一包装 (HTTP < 400)
    if (body && typeof body === 'object') {
      if (Array.isArray(body)) {
        const standardized = {
          ok: true,
          code: 0,
          data: body,
          timestamp: new Date().toISOString(),
        };
        return originalJson(standardized);
      }

      const standardized = {
        ok: true,
        code: body.code !== undefined ? body.code : 0,
        data: body.data !== undefined ? body.data : body,
        timestamp: body.timestamp || new Date().toISOString(),
        ...body,
      };
      return originalJson(standardized);
    }

    // 4. 基础类型（字符串、布尔、数字等）
    const standardized = {
      ok: true,
      code: 0,
      data: body,
      timestamp: new Date().toISOString(),
    };
    return originalJson(standardized);
  };

  next();
}

module.exports = {
  createSuccessPayload,
  createErrorPayload,
  apiResponseMiddleware,
};
