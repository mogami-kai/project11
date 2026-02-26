import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, json } from '../http/response.js';
import { sanitizeMonth, sanitizeUserId } from '../util/validate.js';

function isValidMonthYm(value) {
  return /^\d{4}-\d{2}$/.test(value);
}

export async function handleStatusGet(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  const queryUserId = sanitizeUserId(url.searchParams.get('userId'));
  const userId = auth.mode === 'liff-id-token' ? auth.userId : queryUserId;

  if (!userId) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required' }] }, false),
      meta,
      { status: 400 }
    );
  }

  if (auth.mode === 'liff-id-token' && queryUserId && queryUserId !== auth.userId) {
    return fail(
      buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: queryUserId }, false),
      meta,
      { status: 403 }
    );
  }

  const month = sanitizeMonth(url.searchParams.get('month'));
  if (!month || !isValidMonthYm(month)) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, false),
      meta,
      { status: 400 }
    );
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action: 'status.get', token: env.STAFF_TOKEN_FOR_GAS, requestId, data: { userId, month } },
    meta
  );
  if (!gasOk) return response;

  const result = gasJson?.ok
    ? { ok: true, data: gasJson.data || {}, meta }
    : { ok: false, error: gasJson.error || {}, meta };

  return json(result, { status: result.ok ? 200 : 400 });
}

export async function handleRegisterStatus(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  const queryUserId = sanitizeUserId(url.searchParams.get('userId'));
  const queryLineUserId = sanitizeUserId(url.searchParams.get('lineUserId'));

  const data = {};
  if (auth.mode === 'liff-id-token') {
    if (queryUserId && queryUserId !== auth.userId) {
      return fail(
        buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: queryUserId }, false),
        meta,
        { status: 403 }
      );
    }
    if (queryLineUserId && queryLineUserId !== auth.userId) {
      return fail(
        buildError('E_FORBIDDEN', 'Forbidden lineUserId.', { lineUserId: queryLineUserId }, false),
        meta,
        { status: 403 }
      );
    }
    data.userId = auth.userId;
  } else {
    if (queryUserId) {
      data.userId = queryUserId;
    } else if (queryLineUserId) {
      data.lineUserId = queryLineUserId;
    }
  }

  if (!data.userId && !data.lineUserId) {
    return fail(
      buildError(
        'E_VALIDATION',
        'Validation failed.',
        { fields: [{ field: 'userId', reason: 'required(userId or lineUserId)' }] },
        false
      ),
      meta,
      { status: 400 }
    );
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action: 'staff.register.status', token: env.STAFF_TOKEN_FOR_GAS, requestId, data },
    meta
  );
  if (!gasOk) return response;

  const result = gasJson?.ok
    ? { ok: true, data: gasJson.data || {}, meta }
    : { ok: false, error: gasJson.error || {}, meta };

  return json(result, { status: result.ok ? 200 : 400 });
}

export async function handleUnsubmittedList(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const month = sanitizeMonth(url.searchParams.get('month'));
  const project = String(url.searchParams.get('project') || '').trim();

  if (!month || !isValidMonthYm(month)) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, false),
      meta,
      { status: 400 }
    );
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    { action: 'unsubmitted.list', token: env.STAFF_TOKEN_FOR_GAS, requestId, data: { month, project } },
    meta
  );
  if (!gasOk) return response;

  const result = gasJson?.ok
    ? { ok: true, data: gasJson.data || {}, meta }
    : { ok: false, error: gasJson.error || {}, meta };

  return json(result, { status: result.ok ? 200 : 400 });
}
