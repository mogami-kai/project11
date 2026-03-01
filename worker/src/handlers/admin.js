import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { fetchLineBotInfo, mapLineErrorCode } from '../clients/line.js';
import { buildError, fail, json, ok } from '../lib/response.js';
import { parseAllowedOrigins } from '../lib/env.js';
import { sha256Hex, stableStringify } from '../util/hash.js';
import { sanitizeMonth, sanitizeUserId } from '../lib/validate.js';
import { safeLog } from '../lib/redact.js';

export async function handleDebugEnv(request, env, meta, origin, allowedOrigin) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  return ok(buildEnvDebugSnapshot(env, origin, allowedOrigin), meta);
}

export async function handleDebugAuth(request, env, meta) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });

  if (!auth.ok) return auth.response;

  return ok(
    {
      mode: auth.mode,
      valid: true,
      userId: auth.userId || ''
    },
    meta
  );
}

export async function handleDebugGas(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const userId = sanitizeUserId(url.searchParams.get('userId')) || 'DEBUG_USER';
  const month = sanitizeMonth(url.searchParams.get('month')) || '2099-01';

  const { ok: gasOk, response, gasJson, telemetry } = await callGas(
    env,
    { action: 'status.get', token: env.STAFF_TOKEN_FOR_GAS, requestId, data: { userId, month } },
    meta,
    { retries: 1 }
  );

  if (!gasOk) {
    return json(
      {
        ok: false,
        error: {
          code: 'E_GAS_ERROR',
          message: 'GAS debug call failed.',
          details: telemetry,
          retryable: true
        },
        meta
      },
      { status: response.status || 502 }
    );
  }

  return ok(
    {
      reachable: telemetry.reachable,
      timeout: telemetry.timeout,
      status: telemetry.status,
      elapsedMs: telemetry.elapsedMs,
      attempts: telemetry.attempts,
      gasOk: Boolean(gasJson?.ok),
      gasErrorCode: gasJson?.error?.code || null
    },
    meta
  );
}

export async function handleDebugLineBotInfo(request, env, meta) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return fail(buildError('E_CONFIG', 'LINE_CHANNEL_ACCESS_TOKEN is missing.', {}, false), meta, { status: 500 });
  }

  const { response, error, elapsedMs } = await fetchLineBotInfo(env);

  if (error || !response) {
    return fail(
      buildError(
        String(error?.name || '') === 'AbortError' ? 'LINE_TIMEOUT' : 'LINE_FETCH_FAILED',
        'LINE Bot info fetch failed.',
        { status: 502, elapsedMs },
        true
      ),
      meta,
      { status: 502 }
    );
  }

  let lineJson = null;
  try {
    lineJson = await response.json();
  } catch {
    lineJson = null;
  }

  if (!response.ok) {
    return fail(
      buildError(
        mapLineErrorCode(response.status),
        'LINE Bot info request failed.',
        { status: response.status, elapsedMs },
        response.status >= 500
      ),
      meta,
      { status: response.status }
    );
  }

  return ok(
    {
      status: response.status,
      bot: {
        basicId: lineJson?.basicId || '',
        displayName: lineJson?.displayName || '',
        pictureUrl: lineJson?.pictureUrl || ''
      },
      elapsedMs
    },
    meta,
    { status: 200 }
  );
}

export async function handleDebugRoutes(request, env, meta, debugRouteList) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  return ok({ routes: debugRouteList }, meta);
}

export async function handleDebugFingerprint(request, env, meta, origin, allowedOrigin) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const snapshot = buildEnvDebugSnapshot(env, origin, allowedOrigin);
  const fingerprint = await sha256Hex(stableStringify(snapshot));

  return ok({ fingerprint, ...snapshot }, meta);
}

export async function handleAdminShiftRawRecent(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  if (!isAdminIpAllowed(request, env)) {
    return fail(buildError('E_FORBIDDEN', 'IP not allowed.', {}, false), meta, { status: 403 });
  }

  const gasToken = resolveGasToken(env);
  if (!gasToken) {
    return fail(buildError('E_CONFIG', 'Missing GAS token.', { missing: ['STAFF_TOKEN_FOR_GAS|STAFF_TOKEN'] }, false), meta, { status: 500 });
  }

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action: 'shift.raw.recent', token: gasToken, requestId, data: { limit } },
    meta,
    { retries: 0 }
  );
  if (!gasOk) {
    safeLog('admin.shift.raw.recent.failed', { requestId, limit, reachable: false });
    return response;
  }

  if (!gasJson?.ok) {
    return json({ ok: false, error: gasJson.error || {}, meta }, { status: 400 });
  }

  return ok(gasJson.data || { items: [], limit }, meta);
}

function buildEnvDebugSnapshot(env, origin, allowedOrigin) {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const invalidOrigins = allowedOrigins.filter((o) => !isValidUrl(o));

  const present = {
    GAS_ENDPOINT: Boolean(env.GAS_ENDPOINT),
    WORKER_API_KEY: Boolean(env.WORKER_API_KEY),
    STAFF_TOKEN_FOR_GAS: Boolean(env.STAFF_TOKEN_FOR_GAS),
    LINE_CHANNEL_ACCESS_TOKEN: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
    LINE_CHANNEL_SECRET: Boolean(env.LINE_CHANNEL_SECRET),
    ALLOWED_ORIGINS: Boolean(String(env.ALLOWED_ORIGINS || '').trim()),
    LIFF_URL: Boolean(env.LIFF_URL),
    LIFF_ID: Boolean(env.LIFF_ID),
    GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY)
  };

  const format = {
    gasEndpointEndsWithExec: String(env.GAS_ENDPOINT || '').endsWith('/exec'),
    gasEndpointIsUrl: isValidUrl(String(env.GAS_ENDPOINT || '')),
    allowedOriginsCount: allowedOrigins.length,
    allowedOriginsAllValidUrls: invalidOrigins.length === 0,
    originProvided: Boolean(origin),
    originMatched: Boolean(origin && allowedOrigin && origin === allowedOrigin)
  };

  return { present, format };
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isAdminIpAllowed(request, env) {
  const allowRaw = String(env.ADMIN_ALLOWED_IPS || '').trim();
  // Gate0.9: ADMIN_ALLOWED_IPS is optional defense-in-depth; CF Access is primary
  if (!allowRaw) return true;

  const currentIp = String(request.headers.get('cf-connecting-ip') || '').trim();
  if (!currentIp) return false;

  const allowed = allowRaw.split(',').map((v) => v.trim()).filter(Boolean);
  return allowed.includes(currentIp);
}

function resolveGasToken(env) {
  return String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
}
