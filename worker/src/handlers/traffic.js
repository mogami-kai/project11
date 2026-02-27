import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, json } from '../lib/response.js';
import { requireRegistered } from '../lib/access.js';
import {
  normalizeTrafficPayload,
  sanitizeRequestId,
  sanitizeUserId,
  validateTrafficPayload
} from '../lib/validate.js';

function normalizeTrafficCreateInput(body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  if (!Array.isArray(body.items) || body.items.length === 0 || typeof body.items[0] !== 'object') {
    return body;
  }

  const item = body.items[0] || {};
  const mappedRoundTrip = typeof item.roundTrip === 'boolean'
    ? (item.roundTrip ? '往復' : '片道')
    : (typeof body.roundTrip === 'boolean' ? (body.roundTrip ? '往復' : '片道') : body.roundTrip);

  return {
    ...body,
    workDate: body.workDate ?? body.date,
    fromStation: body.fromStation ?? item.from,
    toStation: body.toStation ?? item.to,
    amount: body.amount ?? item.amount,
    roundTrip: mappedRoundTrip,
    memo: body.memo ?? item.memo,
    project: body.project ?? item.project,
    name: body.name ?? item.name,
    submitMethod: body.submitMethod ?? item.submitMethod,
    requestId: body.requestId ?? item.requestId
  };
}

export async function handleTrafficCreate(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(buildError('E_BAD_REQUEST', 'Invalid JSON.', {}, false), meta, { status: 400 });
  }

  const trafficInput = normalizeTrafficCreateInput(body);
  const normalized = normalizeTrafficPayload(trafficInput);

  if (auth.mode === 'liff-id-token' && auth.userId) {
    normalized.userId = auth.userId;
  } else {
    normalized.userId = sanitizeUserId(trafficInput?.userId);
  }

  const validation = validateTrafficPayload(normalized);
  if (!validation.ok) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', validation.details, false), meta, { status: 400 });
  }

  // Spec: api_schema 2 Gate / registration_spec 3 Gating Rules
  const registerGate = await requireRegistered(env, meta, requestId, { userId: normalized.userId });
  if (!registerGate.ok) return registerGate.response;

  const routeKey = '/api/traffic/create';
  const idemKey = resolveIdempotencyKey(request, trafficInput);
  const payloadHash = idemKey ? await resolvePayloadHash(normalized) : '';
  // Reason: GAS側の重複排除キーを固定し、同一idempotency key再送でrequestIdが変わらないようにするため。
  const gasRequestId = resolveGasRequestId(requestId, idemKey);

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

    const { ok: gasOk, response, gasJson } = await callGas(
      env,
      { action: 'traffic.create', token: env.STAFF_TOKEN_FOR_GAS, requestId: gasRequestId, data: normalized },
      meta
    );

    if (!gasOk) return response;

    const result = gasJson?.ok
      ? { ok: true, data: gasJson.data || {}, meta }
      : { ok: false, error: gasJson.error || {}, meta };

    if (idemKey && result.ok) {
      await setIdempotentResponse(env, routeKey, idemKey, result);
    }

    return json(result, { status: result.ok ? 200 : 400 });
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

function resolveIdempotencyKey(request, body) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyIdempotencyKey = String(body?.idempotencyKey || '').trim();
  if (bodyIdempotencyKey) return bodyIdempotencyKey.slice(0, 120);

  const bodyRequestId = sanitizeRequestId(body?.requestId);
  if (!bodyRequestId) return '';
  return `requestId:${bodyRequestId}`;
}

function resolveGasRequestId(fallbackRequestId, idemKey) {
  // Reason: Worker再送時もGASへ同じrequestIdを渡し、GAS側idempotency判定を成立させるため。
  const idemRequestId = sanitizeRequestId(idemKey);
  if (idemRequestId) return idemRequestId;
  return sanitizeRequestId(fallbackRequestId) || fallbackRequestId;
}
