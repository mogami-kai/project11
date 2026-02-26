import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, json } from '../http/response.js';
import { requireRegistered } from '../lib/access.js';
import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { sanitizeRequestId } from '../util/validate.js';

function resolveGasToken(env) {
  return String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
}

async function parseJsonBody(request, meta) {
  try {
    const body = await request.json();
    return { ok: true, body: body && typeof body === 'object' ? body : {} };
  } catch {
    return {
      ok: false,
      response: fail(buildError('E_BAD_REQUEST', 'Invalid JSON.', {}, false), meta, { status: 400 })
    };
  }
}

async function relayGasAction(request, env, meta, requestId, action, data) {
  const gasToken = resolveGasToken(env);
  if (!gasToken) {
    return fail(
      buildError('E_CONFIG', 'Missing GAS token.', { missing: ['STAFF_TOKEN_FOR_GAS|STAFF_TOKEN'] }, false),
      meta,
      { status: 500 }
    );
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action, token: gasToken, requestId, data: data || {} },
    meta
  );
  if (!gasOk) return response;

  const result = gasJson?.ok
    ? { ok: true, data: gasJson.data || {}, meta }
    : { ok: false, error: gasJson.error || {}, meta };

  return json(result, { status: result.ok ? 200 : 400 });
}

export async function handleShiftRawIngest(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody(request, meta);
  if (!parsed.ok) return parsed.response;

  const data = parsed.body || {};
  const rawMessageId = String(data.rawMessageId || '').trim();
  const rawText = String(data.rawText || '').trim();
  const lineUserId = String(data.lineUserId || '').trim();
  const lineGroupId = String(data.lineGroupId || '').trim();
  const fields = [];
  if (!rawMessageId) fields.push({ field: 'rawMessageId', reason: 'required' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  // Spec: api_schema 2 Gate (shift submission routes)
  const registerGate = await requireRegistered(env, meta, requestId, { lineUserId });
  if (!registerGate.ok) return registerGate.response;

  const routeKey = '/api/shift/raw/ingest';
  const idemKey = resolveIdempotencyKey(request, data, rawMessageId);
  const gasPayload = {
    rawMessageId,
    rawText,
    lineUserId,
    lineGroupId
  };

  const payloadHash = idemKey ? await resolvePayloadHash(gasPayload) : '';
  // Spec: ops_rules 1 Idempotency / v5_spec 2.3 Idempotency
  if (idemKey) {
    const payloadMatched = await ensureIdempotencyPayloadMatch(env, routeKey, idemKey, payloadHash);
    if (!payloadMatched) {
      return fail(
        buildError('E_IDEMPOTENCY_MISMATCH', 'Idempotency key payload mismatch.', {}, false),
        meta,
        { status: 409 }
      );
    }

    const cached = await getIdempotentResponse(env, routeKey, idemKey);
    if (cached) {
      return json(cached, { status: 200 });
    }
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const response = await relayGasAction(request, env, meta, requestId, 'shift.raw.ingest', gasPayload);

    if (idemKey && response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.ok) {
        await setIdempotentResponse(env, routeKey, idemKey, payload);
      }
    }

    return response;
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

export async function handleShiftParseRun(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody(request, meta);
  if (!parsed.ok) return parsed.response;

  const data = parsed.body || {};
  const out = {};
  if (data.rawMessageId !== undefined) out.rawMessageId = String(data.rawMessageId || '').trim();
  if (data.limit !== undefined) out.limit = Number(data.limit);
  if (data.includeErrors !== undefined) out.includeErrors = data.includeErrors;
  const routeKey = '/api/shift/parse/run';
  const idemKey = resolveIdempotencyKey(request, data, out.rawMessageId);
  const payloadHash = idemKey ? await resolvePayloadHash(out) : '';

  if (idemKey) {
    const payloadMatched = await ensureIdempotencyPayloadMatch(env, routeKey, idemKey, payloadHash);
    if (!payloadMatched) {
      return fail(
        buildError('E_IDEMPOTENCY_MISMATCH', 'Idempotency key payload mismatch.', {}, false),
        meta,
        { status: 409 }
      );
    }

    const cached = await getIdempotentResponse(env, routeKey, idemKey);
    if (cached) {
      return json(cached, { status: 200 });
    }
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const response = await relayGasAction(request, env, meta, requestId, 'shift.parse.run', out);

    if (idemKey && response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.ok) {
        await setIdempotentResponse(env, routeKey, idemKey, payload);
      }
    }

    return response;
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

export async function handleShiftParseStats(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  return relayGasAction(request, env, meta, requestId, 'shift.parse.stats', {});
}

function resolveIdempotencyKey(request, body, rawMessageId) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyIdempotencyKey = String(body?.idempotencyKey || '').trim();
  if (bodyIdempotencyKey) return bodyIdempotencyKey.slice(0, 120);

  const requestId = sanitizeRequestId(body?.requestId);
  if (requestId) return `requestId:${requestId}`;

  const rawId = String(rawMessageId || '').trim();
  if (rawId) return `rawMessageId:${rawId.slice(0, 100)}`;
  return '';
}
