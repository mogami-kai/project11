import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, json } from '../lib/response.js';
import { requireAdmin } from '../lib/access.js';
import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { safeLog } from '../lib/redact.js';
import { getLiffUrls } from '../lib/env.js';
import { ymdJstFromEpoch } from '../util/time.js';
import { sanitizeDateYmd, sanitizeRequestId, sanitizeUserId } from '../lib/validate.js';
import { pushLineMessage } from '../clients/line.js';

export async function handleReminderPush(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const adminCheck = requireAdmin(request, env, meta);
  if (!adminCheck.ok) return adminCheck.response;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const date = sanitizeDateYmd(body?.date) || ymdJstFromEpoch(Date.now());
  const routeKey = '/api/reminder/push';
  const idemKey = resolveIdempotencyKey(request, body);
  const payloadHash = idemKey ? await resolvePayloadHash({ date }) : '';

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

    const res = await dispatchReminder(env, meta, requestId, { date });
    if (idemKey && res.status === 200 && res.payload?.ok) {
      await setIdempotentResponse(env, routeKey, idemKey, res.payload);
    }

    return json(res.payload, { status: res.status });
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

export async function runScheduledReminder(env, meta, requestId, options = {}) {
  const date = sanitizeDateYmd(options?.date) || ymdJstFromEpoch(Date.now());
  try {
    const res = await dispatchReminder(env, meta, requestId, { date });
    const counts = {
      pushed: Number(res?.payload?.data?.pushed || 0),
      failed: Number(res?.payload?.data?.failed || 0),
      skipped: Number(res?.payload?.data?.skipped || 0)
    };
    safeLog('cron.dispatch.summary', {
      requestId,
      action: 'reminder.push',
      date,
      status: Number(res?.status || 0),
      ok: Boolean(res?.payload?.ok),
      ...counts
    });
    return res;
  } catch (error) {
    safeLog('cron.dispatch.summary', {
      requestId,
      action: 'reminder.push',
      date,
      status: 500,
      ok: false,
      pushed: 0,
      failed: 0,
      skipped: 0,
      errorMessage: String(error?.message || error)
    });
    throw error;
  }
}

export async function dispatchReminder(env, meta, requestId, options = {}) {
  const date = sanitizeDateYmd(options?.date) || ymdJstFromEpoch(Date.now());

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    {
      action: 'reminder.targets',
      token: env.STAFF_TOKEN_FOR_GAS,
      requestId,
      data: { date }
    },
    meta,
    { retries: 1 }
  );

  if (!gasOk) {
    let status = 502;
    try {
      status = response.status;
    } catch {
      status = 502;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = {
        ok: false,
        error: buildError('E_REMINDER_DISPATCH', 'Reminder dispatch failed.', {}, true),
        meta
      };
    }

    return { status, payload };
  }

  if (!gasJson?.ok) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: gasJson.error || buildError('E_GAS_ERROR', 'GAS error.', {}, true),
        meta
      }
    };
  }

  const targets = Array.isArray(gasJson?.data?.targets) ? gasJson.data.targets : [];
  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  const { trafficUrl: liffUrl } = getLiffUrls(env);

  for (const target of targets) {
    const userId = sanitizeUserId(target?.userId);
    const lineUserId = String(target?.lineUserId || '').trim();
    const missingDates = Array.isArray(target?.missingDates) ? target.missingDates : [];

    if (!userId || !lineUserId || missingDates.length === 0) {
      skipped += 1;
      continue;
    }

    const guard = await reserveSendGuard(env, meta, requestId, {
      action: 'reminder.sendGuard',
      data: {
        date,
        lineUserId,
        kind: 'reminder'
      }
    });
    if (!guard.ok) {
      failed += 1;
      safeLog('reminder.push.guard.error', { requestId, date, userId, lineUserId });
      continue;
    }

    if (!guard.allowed) {
      skipped += 1;
      safeLog('reminder.push.skipped', {
        requestId,
        date,
        userId,
        lineUserId,
        reason: 'guard_duplicate',
        guardToken: guard.guardToken
      });
      continue;
    }

    const textLines = [
      '【交通費リマインド】',
      `${date}時点で未提出日があります。`,
      `未提出: ${missingDates.join(', ')}`,
      liffUrl ? `提出はこちら: ${liffUrl}` : '提出URL（LIFF_TRAFFIC_URL/LIFF_URL）が未設定です。運用担当へ連絡してください。'
    ];

    const pushResult = await pushLineMessage(env, lineUserId, [{ type: 'text', text: textLines.join('\n') }], requestId);
    const deliveryStatus = pushResult.ok ? 'pushed' : 'failed';

    await finalizeSendGuard(env, meta, requestId, {
      action: 'reminder.sendGuard',
      data: {
        date,
        lineUserId,
        kind: 'reminder'
      },
      guardToken: guard.guardToken,
      status: deliveryStatus
    });

    safeLog('reminder.push.delivery', {
      requestId,
      date,
      userId,
      lineUserId,
      status: deliveryStatus,
      lineStatus: pushResult.status || null,
      lineErrorCode: pushResult.errorCode || ''
    });

    if (!pushResult.ok) {
      failed += 1;
      continue;
    }

    pushed += 1;
  }

  return {
    status: 200,
    payload: {
      ok: true,
      data: {
        date,
        targetCount: targets.length,
        pushed,
        failed,
        skipped
      },
      meta
    }
  };
}

export async function reserveSendGuard(env, meta, requestId, payload) {
  const action = String(payload?.action || '').trim();
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  if (!action) {
    return { ok: false, allowed: false, guardToken: '' };
  }

  const { ok: gasOk, gasJson } = await callGas(
    env,
    {
      action,
      token: env.STAFF_TOKEN_FOR_GAS,
      requestId,
      data: { ...data, mode: 'guard' }
    },
    meta,
    { retries: 0 }
  );

  if (!gasOk) {
    return { ok: false, allowed: false, guardToken: '' };
  }

  if (!gasJson?.ok) {
    safeLog('send.guard.reject', {
      requestId,
      action,
      gasErrorCode: gasJson?.error?.code || '',
      gasErrorMessage: gasJson?.error?.message || ''
    });
    return { ok: false, allowed: false, guardToken: '' };
  }

  return {
    ok: true,
    allowed: Boolean(gasJson?.data?.allowed),
    guardToken: String(gasJson?.data?.guardToken || ''),
    status: String(gasJson?.data?.status || '')
  };
}

export async function finalizeSendGuard(env, meta, requestId, payload) {
  const action = String(payload?.action || '').trim();
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const guardToken = String(payload?.guardToken || '').trim();
  const status = String(payload?.status || '').trim();

  if (!action || !guardToken || !status) return;

  const { ok: gasOk, gasJson } = await callGas(
    env,
    {
      action,
      token: env.STAFF_TOKEN_FOR_GAS,
      requestId,
      data: { ...data, mode: 'result', guardToken, status }
    },
    meta,
    { retries: 0 }
  );

  if (!gasOk) {
    safeLog('send.guard.finalize.error', { requestId, action, guardToken, status, reason: 'gas_unreachable' });
    return;
  }

  if (!gasJson?.ok) {
    safeLog('send.guard.finalize.error', {
      requestId,
      action,
      guardToken,
      status,
      gasErrorCode: gasJson?.error?.code || '',
      gasErrorMessage: gasJson?.error?.message || ''
    });
  }
}

function resolveIdempotencyKey(request, body) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyKey = String(body?.idempotencyKey || '').trim();
  if (bodyKey) return bodyKey.slice(0, 120);

  const bodyRequestId = sanitizeRequestId(body?.requestId);
  if (!bodyRequestId) return '';
  return `requestId:${bodyRequestId}`;
}
