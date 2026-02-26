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
import { linkUserRichMenu, pushLineMessage } from '../clients/line.js';
import { buildError, fail, json } from '../http/response.js';
import { safeLog } from '../util/redact.js';
import { tryWriteOpsLogAlert } from '../util/ops.js';
import { sanitizeRequestId, sanitizeUserId } from '../util/validate.js';

export async function handleRegisterUpsert(request, env, meta, requestId) {
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

  const input = body && typeof body === 'object' ? body : {};
  const staffInput = input.staff && typeof input.staff === 'object' ? input.staff : input;
  const providedUserId = sanitizeUserId(input.userId || input.lineUserId || staffInput.userId || staffInput.lineUserId);
  const userId = auth.mode === 'liff-id-token' ? auth.userId : providedUserId;

  if (auth.mode === 'liff-id-token' && providedUserId && providedUserId !== auth.userId) {
    return fail(
      buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: providedUserId }, false),
      meta,
      { status: 403 }
    );
  }

  if (!userId) {
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

  // Spec: registration_spec 1 Required Fields / registration_spec 2 Validation Rules
  const fullNameKanji = String(staffInput.nameKanji ?? staffInput.fullNameKanji ?? staffInput.name ?? '').trim();
  const fullNameKana = String(staffInput.nameKana ?? staffInput.fullNameKana ?? staffInput.nameKana ?? staffInput.kana ?? '').trim();
  const birthDate = String(staffInput.birthDate ?? '').trim();
  const nearestStation = String(staffInput.nearestStation ?? staffInput.station ?? '').trim();
  const phone = normalizeDigits(staffInput.phone ?? staffInput.tel ?? '');
  const emergencyRelation = String(staffInput.emergencyRelation ?? '').trim();
  const emergencyPhone = normalizeDigits(staffInput.emergencyPhone ?? '');
  const postalCode = normalizeDigits(staffInput.postalCode ?? '');
  const address = String(staffInput.address ?? '').trim();
  const fields = [];
  if (!fullNameKanji) fields.push({ field: 'nameKanji', reason: 'required' });
  if (!fullNameKana) fields.push({ field: 'nameKana', reason: 'required' });
  if (!birthDate) fields.push({ field: 'birthDate', reason: 'required' });
  if (!nearestStation) fields.push({ field: 'nearestStation', reason: 'required(station)' });
  if (!phone) fields.push({ field: 'phone', reason: 'required' });
  if (!emergencyRelation) fields.push({ field: 'emergencyRelation', reason: 'required' });
  if (!emergencyPhone) fields.push({ field: 'emergencyPhone', reason: 'required' });
  if (!postalCode) fields.push({ field: 'postalCode', reason: 'required' });
  if (!address) fields.push({ field: 'address', reason: 'required' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const data = {
    userId,
    lineUserId: sanitizeUserId(input.lineUserId || staffInput.lineUserId) || userId,
    fullNameKanji,
    fullNameKana,
    birthDate,
    phone,
    nearestStation,
    emergencyRelation,
    emergencyPhone,
    postalCode,
    address,
    name: String(staffInput.name ?? '').trim(),
    nameKana: String(staffInput.nameKana ?? '').trim(),
    kana: String(staffInput.kana ?? '').trim(),
    tel: String(staffInput.tel ?? '').trim(),
    station: String(staffInput.station ?? '').trim()
  };

  const routeKey = '/api/register/upsert';
  const idemKey = resolveIdempotencyKey(request, input);
  const payloadHash = idemKey ? await resolvePayloadHash(data) : '';
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
      { action: 'staff.register.upsert', token: env.STAFF_TOKEN_FOR_GAS, requestId, data },
      meta
    );
    if (!gasOk) return response;

    if (!gasJson?.ok) {
      const result = { ok: false, error: gasJson.error || {}, meta };
      return json(result, { status: 400 });
    }

    const menuTransition = await linkRegisteredMenuAfterRegistration(env, requestId, userId);
    const result = {
      ok: true,
      data: {
        ...(gasJson.data || {}),
        richMenuLinked: Boolean(menuTransition.linked),
        richMenuId: String(menuTransition.richMenuId || ''),
        menuSwitchStatus: String(menuTransition.status || ''),
        notice: String(menuTransition.notice || '')
      },
      meta
    };

    if (idemKey) {
      await setIdempotentResponse(env, routeKey, idemKey, result);
    }

    return json(result, { status: 200 });
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

function normalizeDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

async function linkRegisteredMenuAfterRegistration(env, requestId, userId) {
  const richMenuId = String(env.LINE_RICHMENU_ID_REGISTERED || '').trim();
  if (!richMenuId) {
    safeLog('register.richmenu.skip', {
      requestId,
      status: 'skipped',
      reason: 'missing_registered_menu_id'
    });
    return {
      linked: false,
      richMenuId: '',
      status: 'skipped',
      notice: 'registered_without_menu_switch'
    };
  }

  const linkResult = await linkUserRichMenu(env, userId, richMenuId, requestId);
  if (linkResult.ok) {
    return {
      linked: true,
      richMenuId,
      status: 'linked',
      notice: ''
    };
  }

  safeLog('register.richmenu.link.failed', {
    requestId,
    richMenuId,
    lineStatus: linkResult.status || null,
    lineErrorCode: linkResult.errorCode || ''
  });

  await tryWriteOpsLogAlert(env, requestId, {
    source: 'worker.register.upsert',
    event: 'line.richmenu.link.failed',
    message: 'Registration completed but richmenu switch failed.',
    payload: {
      richMenuId,
      lineStatus: linkResult.status || null,
      lineErrorCode: linkResult.errorCode || ''
    }
  });

  const noticeText = '登録は完了しましたが、メニュー切替に失敗しました。時間をおいて再度お試しください。';
  const noticePush = await pushLineMessage(env, userId, [{ type: 'text', text: noticeText }], requestId);
  if (!noticePush.ok) {
    safeLog('register.richmenu.notice.push.failed', {
      requestId,
      lineStatus: noticePush.status || null,
      lineErrorCode: noticePush.errorCode || ''
    });
  }

  return {
    linked: false,
    richMenuId,
    status: 'failed',
    notice: 'registered_but_menu_switch_failed'
  };
}
