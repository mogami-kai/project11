import { fetchWithRetry } from '../lib/fetch.js';
import { buildError, fail } from '../lib/response.js';
import { safeLog } from '../lib/redact.js';

const GAS_TIMEOUT_MS = 15000;

function normalizeGasPayload(payload, meta) {
  const action = String(payload?.action || '').trim();
  const token = String(payload?.token || '').trim();
  const requestId = String(payload?.requestId || meta?.requestId || '').trim();
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};

  return {
    action,
    token,
    requestId,
    data
  };
}

export async function callGas(env, payload, meta, options = {}) {
  const startedAtMs = Date.now();
  const normalizedPayload = normalizeGasPayload(payload, meta);
  const telemetry = {
    requestId: meta?.requestId || '',
    action: normalizedPayload.action,
    endpointConfigured: Boolean(env.GAS_ENDPOINT),
    tokenConfigured: Boolean(normalizedPayload.token),
    reachable: false,
    timeout: false,
    status: null,
    attempts: 0,
    elapsedMs: 0
  };

  if (!env.GAS_ENDPOINT) {
    safeLog('gas.call', { ...telemetry, reason: 'missing_endpoint' });
    return {
      ok: false,
      response: fail(buildError('E_CONFIG', 'GAS_ENDPOINT is missing.', {}, false), meta, { status: 500 }),
      telemetry
    };
  }

  if (!normalizedPayload.token) {
    safeLog('gas.call', { ...telemetry, reason: 'missing_token' });
    return {
      ok: false,
      response: fail(buildError('E_CONFIG', 'STAFF_TOKEN_FOR_GAS is missing.', {}, false), meta, { status: 500 }),
      telemetry
    };
  }

  const { response, error, attempts } = await fetchWithRetry(
    env.GAS_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedPayload)
    },
    {
      timeoutMs: Number(options.timeoutMs || GAS_TIMEOUT_MS),
      retries: Number(options.retries ?? 1),
      retryDelayMs: 300,
      shouldRetry: (res, err) => {
        if (err) return true;
        if (!res) return true;
        return res.status >= 500;
      }
    }
  );

  telemetry.attempts = attempts;
  telemetry.elapsedMs = Date.now() - startedAtMs;

  if (error || !response) {
    telemetry.timeout = String(error?.name || '') === 'AbortError';
    safeLog('gas.call', {
      ...telemetry,
      reason: telemetry.timeout ? 'timeout' : 'fetch_failed'
    });
    return {
      ok: false,
      response: fail(buildError('E_GAS_ERROR', 'GAS call failed.', { reason: 'fetch_failed' }, true), meta, { status: 502 }),
      telemetry
    };
  }

  telemetry.reachable = true;
  telemetry.status = response.status;

  let gasJson;
  try {
    gasJson = await response.json();
  } catch {
    safeLog('gas.call', { ...telemetry, reason: 'json_parse_failed' });
    return {
      ok: false,
      response: fail(buildError('E_GAS_INVALID', 'Invalid GAS response.', { reason: 'json_parse_failed' }, true), meta, { status: 502 }),
      telemetry
    };
  }

  safeLog('gas.call', {
    ...telemetry,
    gasOk: Boolean(gasJson?.ok),
    gasErrorCode: gasJson?.error?.code || null
  });

  return { ok: true, gasJson, telemetry };
}

export async function getSiteProfile(env, input, meta) {
  const payload = {
    action: 'site.profile.get',
    token: env.STAFF_TOKEN_FOR_GAS,
    requestId: String(input?.requestId || meta?.requestId || ''),
    data: {
      userId: String(input?.userId || '').trim(),
      workDate: String(input?.workDate || '').trim(),
      projectId: String(input?.projectId || '').trim()
    }
  };

  return callGas(env, payload, meta);
}
