import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { callGas } from '../clients/gas.js';
import { verifySlackSignature } from '../clients/slack.js';
import { pushLineMessage } from '../clients/line.js';
import { buildError, fail, json } from '../lib/response.js';
import { sanitizeMonth, sanitizeRequestId } from '../lib/validate.js';
import { buildBroadcastFlexMessage, executeBroadcastDelivery } from '../lib/broadcastMessage.js';

export async function handleAdminBroadcastPreview(request, env, meta, requestId) {
  const gasToken = String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
  const parsed = await parseAdminRequest(request, env, meta);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const targetMonth = sanitizeMonth(body?.targetMonth);
  const rawText = String(body?.rawText || body?.messageText || '').trim();
  const operationId = sanitizeRequestId(body?.operationId);

  const fields = [];
  if (!targetMonth) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const routeKey = '/api/admin/broadcast/preview';
  const idemKey = resolveIdempotencyKey(request, body, operationId);
  const payloadHash = idemKey
    ? await resolvePayloadHash({ targetMonth, rawText, actorSlackUserId: parsed.actorSlackUserId, actorType: parsed.actorType })
    : '';

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
    if (cached) return json(cached, { status: 200 });
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const gas = await callGas(
      env,
      {
        action: 'admin.broadcast.preview',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          rawText,
          operationId,
          actorSlackUserId: parsed.actorSlackUserId,
          actorType: parsed.actorType
        }
      },
      meta,
      { retries: 0 }
    );

    if (!gas.ok) return gas.response;

    const result = gas.gasJson?.ok
      ? { ok: true, data: gas.gasJson.data || {}, meta }
      : { ok: false, error: gas.gasJson.error || {}, meta };

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

export async function handleAdminBroadcastSend(request, env, meta, requestId) {
  const gasToken = String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
  const parsed = await parseAdminRequest(request, env, meta);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const targetMonth = sanitizeMonth(body?.targetMonth);
  const rawText = String(body?.rawText || body?.messageText || '').trim();
  const operationId = sanitizeRequestId(body?.operationId);

  const fields = [];
  if (!targetMonth) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const routeKey = '/api/admin/broadcast/send';
  const idemKey = resolveIdempotencyKey(request, body, operationId);
  const payloadHash = idemKey
    ? await resolvePayloadHash({ targetMonth, rawText, actorSlackUserId: parsed.actorSlackUserId, actorType: parsed.actorType })
    : '';

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
    if (cached) return json(cached, { status: 200 });
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const prepare = await callGas(
      env,
      {
        action: 'admin.broadcast.send.prepare',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          rawText,
          operationId,
          actorSlackUserId: parsed.actorSlackUserId,
          actorType: parsed.actorType
        }
      },
      meta,
      { retries: 0 }
    );
    if (!prepare.ok) return prepare.response;
    if (!prepare.gasJson?.ok) {
      return json({ ok: false, error: prepare.gasJson.error || {}, meta }, { status: 400 });
    }

    const preparedData = prepare.gasJson.data || {};
    const preparedStatus = String(preparedData.status || '').trim().toUpperCase();
    if (preparedData.alreadyProcessed && preparedStatus !== 'PREPARED') {
      const idempotent = { ok: true, data: preparedData, meta };
      if (idemKey) await setIdempotentResponse(env, routeKey, idemKey, idempotent);
      return json(idempotent, { status: 200 });
    }

    const recipients = Array.isArray(preparedData.recipients) ? preparedData.recipients : [];

    // [P0-1] check KV for recipients already sent in a previous run of this operation
    const alreadySentIds = new Set();
    const kv = env?.IDEMPOTENCY_KV;
    if (operationId && kv) {
      for (const rec of recipients) {
        const recId = String(rec?.recipientId || '').trim();
        if (!recId) continue;
        try {
          const val = await kv.get(`broadcast:sent:${operationId}:${recId}`);
          if (val) alreadySentIds.add(recId);
        } catch { /* ignore */ }
      }
    }

    const { pushed, failed, alreadySent, deliveries } = await executeBroadcastDelivery(env, recipients, requestId, {
      includeRecipientMeta: true,
      operationId, // [P0-1]
      alreadySentIds // [P0-1]
    });
    let skipped = 0;

    if (recipients.length === 0) {
      skipped = Number(preparedData.preview?.totalAssignments || 0);
    }

    const finalize = await callGas(
      env,
      {
        action: 'admin.broadcast.send.finalize',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          broadcastId: String(preparedData.broadcastId || '').trim(),
          operationId,
          actorSlackUserId: parsed.actorSlackUserId,
          actorType: parsed.actorType,
          delivery: {
            pushed,
            failed,
            skipped,
            alreadySent, // [P0-1]
            deliveries
          }
        }
      },
      meta,
      { retries: 0 }
    );

    if (!finalize.ok) return finalize.response;

    const result = finalize.gasJson?.ok
      ? {
        ok: true,
        data: {
          ...preparedData,
          delivery: { pushed, failed, skipped },
          finalized: finalize.gasJson.data || {}
        },
        meta
      }
      : { ok: false, error: finalize.gasJson.error || {}, meta };

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

export async function handleAdminBroadcastRetryFailed(request, env, meta, requestId) {
  const gasToken = String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
  const parsed = await parseAdminRequest(request, env, meta);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const targetMonth = sanitizeMonth(body?.targetMonth);
  const broadcastId = String(body?.broadcastId || '').trim();
  const operationId = sanitizeRequestId(body?.operationId);

  const fields = [];
  if (!targetMonth) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!broadcastId) fields.push({ field: 'broadcastId', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const routeKey = '/api/admin/broadcast/retry-failed';
  const idemKey = resolveIdempotencyKey(request, body, operationId);
  const payloadHash = idemKey
    ? await resolvePayloadHash({ targetMonth, broadcastId, actorSlackUserId: parsed.actorSlackUserId, actorType: parsed.actorType })
    : '';

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
    if (cached) return json(cached, { status: 200 });
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const prepare = await callGas(
      env,
      {
        action: 'admin.broadcast.retryFailed.prepare',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          broadcastId,
          operationId,
          actorSlackUserId: parsed.actorSlackUserId,
          actorType: parsed.actorType
        }
      },
      meta,
      { retries: 0 }
    );

    if (!prepare.ok) return prepare.response;
    if (!prepare.gasJson?.ok) {
      return json({ ok: false, error: prepare.gasJson.error || {}, meta }, { status: 400 });
    }

    const preparedData = prepare.gasJson.data || {};
    const jobs = Array.isArray(preparedData.failedJobs) ? preparedData.failedJobs : [];
    let pushed = 0;
    let failed = 0;

    const deliveries = [];
    for (const job of jobs) {
      const lineUserId = String(job?.lineUserId || '').trim();
      const message = buildBroadcastFlexMessage(job?.recipient || {}, env);
      const push = lineUserId ? await pushLineMessage(env, lineUserId, [message], requestId) : { ok: false, errorCode: 'LINE_USER_MISSING' };

      if (push.ok) {
        pushed += 1;
        deliveries.push({ failedJobId: String(job?.failedJobId || ''), status: 'sent', errorCode: '' });
      } else {
        failed += 1;
        deliveries.push({
          failedJobId: String(job?.failedJobId || ''),
          status: 'failed',
          errorCode: String(push.errorCode || 'LINE_PUSH_FAILED')
        });
      }
    }

    const finalize = await callGas(
      env,
      {
        action: 'admin.broadcast.retryFailed.finalize',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          broadcastId,
          operationId,
          actorSlackUserId: parsed.actorSlackUserId,
          actorType: parsed.actorType,
          delivery: {
            pushed,
            failed,
            deliveries
          }
        }
      },
      meta,
      { retries: 0 }
    );

    if (!finalize.ok) return finalize.response;

    const result = finalize.gasJson?.ok
      ? { ok: true, data: { ...finalize.gasJson.data, retry: { pushed, failed } }, meta }
      : { ok: false, error: finalize.gasJson.error || {}, meta };

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

async function parseAdminRequest(request, env, meta) {
  const rawBody = await request.text();

  const verified = await verifySlackSignature(rawBody, request.headers, env.SLACK_SIGNING_SECRET);
  if (!verified.ok) {
    return {
      ok: false,
      response: fail(
        buildError('E_UNAUTHORIZED', 'Slack signature required.', { reason: verified.reason }, false),
        meta,
        { status: 401 }
      )
    };
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {
      ok: false,
      response: fail(buildError('E_BAD_REQUEST', 'Invalid JSON.', {}, false), meta, { status: 400 })
    };
  }

  const actorSlackUserId = String(body?.actorSlackUserId || request.headers.get('x-slack-user-id') || '').trim();
  return {
    ok: true,
    body,
    actorSlackUserId,
    actorType: 'slack',
    defaultOperationId: deriveSlackOperationId(request, body)
  };
}

function deriveSlackOperationId(request, body) {
  const explicit = sanitizeRequestId(body?.operationId);
  if (explicit) return explicit;

  const actionTs = sanitizeRequestId(request.headers.get('x-slack-action-ts'));
  if (actionTs) return `slack-action:${actionTs}`;

  const triggerId = sanitizeRequestId(body?.trigger_id || body?.triggerId);
  if (triggerId) return `slack-trigger:${triggerId}`;

  return '';
}

function resolveIdempotencyKey(request, body, operationId = '') {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyKey = String(body?.idempotencyKey || '').trim();
  if (bodyKey) return bodyKey.slice(0, 120);

  const op = sanitizeRequestId(operationId || body?.operationId);
  if (op) return `operation:${op}`;

  const reqId = sanitizeRequestId(body?.requestId);
  if (reqId) return `requestId:${reqId}`;

  return '';
}
