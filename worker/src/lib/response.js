const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8'
};

export function createMeta(requestId) {
  return {
    requestId,
    timestamp: new Date().toISOString(),
    warnings: []
  };
}

export function ok(data, meta, init = {}) {
  return json(
    {
      ok: true,
      data,
      meta
    },
    { status: 200, ...init }
  );
}

export function fail(error, meta, init = {}) {
  return json(
    {
      ok: false,
      error,
      meta
    },
    { status: init.status || 400, ...init }
  );
}

export function json(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  Object.entries(JSON_HEADERS).forEach(([key, value]) => {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  });
  return new Response(JSON.stringify(payload), {
    ...init,
    headers
  });
}

export function withCorsHeaders(response, origin, allowedOrigin, requestId = '') {
  const headers = new Headers(response.headers);
  if (allowedOrigin && origin === allowedOrigin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  headers.set('access-control-allow-methods', 'POST, OPTIONS, GET');
  headers.set(
    'access-control-allow-headers',
    'Authorization, Content-Type, x-api-key, x-idempotency-key, x-request-id, x-slack-signature, x-slack-request-timestamp, x-slack-action-ts, x-slack-user-id'
  );
  headers.set('access-control-max-age', '86400');
  if (requestId) {
    headers.set('x-request-id', String(requestId));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function createResponder(requestId, origin, allowedOrigin) {
  const meta = createMeta(requestId);
  return {
    meta,
    ok(data, init = {}) {
      return withCorsHeaders(ok(data, meta, init), origin, allowedOrigin, requestId);
    },
    fail(error, init = {}) {
      return withCorsHeaders(fail(error, meta, init), origin, allowedOrigin, requestId);
    },
    json(payload, init = {}) {
      return withCorsHeaders(json(payload, init), origin, allowedOrigin, requestId);
    },
    withCors(response) {
      return withCorsHeaders(response, origin, allowedOrigin, requestId);
    }
  };
}

export function buildError(code, message, details = {}, retryable = false) {
  return {
    code,
    message,
    details,
    retryable
  };
}
