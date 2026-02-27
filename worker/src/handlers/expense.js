// Spec: data-boundary.md §2 / action-contracts §4.2
// PR-A: Worker は EXPENSE_LOG に直接書き込まず、GAS action 'expense.create' 経由に統一。
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
import { processAndStoreReceipt } from '../lib/receipt.js';
import { sanitizeDateYmd, sanitizeRequestId, sanitizeUserId } from '../lib/validate.js';

export async function handleExpenseCreate(request, env, meta, requestId) {
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

  const normalized = normalizeExpensePayload(body);
  if (auth.mode === 'liff-id-token') {
    if (normalized.userId && normalized.userId !== auth.userId) {
      return fail(buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: normalized.userId }, false), meta, { status: 403 });
    }
    normalized.userId = auth.userId;
  }

  const validation = validateExpensePayload(normalized);
  if (validation.length > 0) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields: validation }, false), meta, { status: 400 });
  }

  const routeKey = '/api/expense/create';
  const idemKey = resolveIdempotencyKey(request, normalized);

  const payloadForHash = {
    ...normalized,
    receiptImageBase64: '',
    receiptFingerprint: normalized.receiptImageBase64
      ? await resolvePayloadHash(normalized.receiptImageBase64)
      : ''
  };
  const payloadHash = idemKey ? await resolvePayloadHash(payloadForHash) : '';

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

  // Spec: api_schema 2 Gate / registration_spec 3 Gating Rules
  const registerGate = await requireRegistered(env, meta, requestId, { userId: normalized.userId });
  if (!registerGate.ok) return registerGate.response;

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const expenseId = resolveExpenseId(normalized.userId, normalized.requestId || requestId, idemKey);

    // Spec: v5_spec 2.2 Images Policy / ops_rules 4 — 領収書はWorkerでリサイズしてストレージ保存、DBにはURLのみ
    let receiptUrl = null;
    let resized = false;
    if (normalized.receiptImageBase64) {
      const receiptStored = await processAndStoreReceipt(env, requestId, {
        expenseId,
        imageBase64: normalized.receiptImageBase64,
        mimeType: normalized.receiptMimeType,
        originalFilename: normalized.receiptOriginalFilename
      });

      if (!receiptStored.ok) {
        return fail(receiptStored.error, meta, { status: receiptStored.status || 400 });
      }

      receiptUrl = receiptStored.receiptUrl;
      resized = Boolean(receiptStored.resized);
    }

    // Spec: data-boundary.md §2 — 永続化は GAS action 経由に統一（Worker は Sheets に直接書かない）
    const { ok: gasOk, response: gasResponse, gasJson } = await callGas(
      env,
      {
        action: 'expense.create',
        token: env.STAFF_TOKEN_FOR_GAS,
        requestId,
        data: {
          userId: normalized.userId,
          name: normalized.name,
          project: normalized.project,
          workDate: normalized.workDate,
          category: normalized.category,
          amount: normalized.amount,
          paymentMethod: normalized.paymentMethod,
          memo: normalized.memo,
          receiptUrl: receiptUrl || '',
          status: 'submitted',
          requestId: normalized.requestId || requestId
        }
      },
      meta,
      { retries: 1 }
    );

    if (!gasOk) return gasResponse;
    if (!gasJson?.ok) {
      return fail(
        buildError('E_UPSTREAM', 'GAS expense.create failed.', { gasError: gasJson?.error || {} }, true),
        meta,
        { status: 502 }
      );
    }

    const row = gasJson?.data?.row || null;
    const dedup = Boolean(gasJson?.data?.dedup);
    const result = {
      ok: true,
      data: {
        expenseId,
        row,
        requestId: normalized.requestId || requestId,
        receiptUrl,
        resized,
        dedup
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

function normalizeExpensePayload(body) {
  const work = body?.work && typeof body.work === 'object' ? body.work : {};
  const expense = body?.expense && typeof body.expense === 'object' ? body.expense : {};
  const receipt = body?.receipt && typeof body.receipt === 'object' ? body.receipt : {};

  return {
    userId: sanitizeUserId(body?.userId),
    workDate: sanitizeDateYmd(work?.workDate || body?.workDate),
    category: String(expense?.category || body?.category || '').trim(),
    amount: Number(expense?.amount ?? body?.amount ?? 0),
    paymentMethod: String(body?.paymentMethod || 'advance').trim(),
    memo: String(expense?.note || expense?.memo || body?.memo || body?.description || '').trim(),
    project: String(work?.site || body?.project || '').trim(),
    name: String(body?.name || '').trim(),
    requestId: sanitizeRequestId(body?.requestId),
    idempotencyKey: String(body?.idempotencyKey || '').trim(),
    receiptImageBase64: String(receipt?.image_base64 || receipt?.imageBase64 || '').trim(),
    receiptMimeType: String(receipt?.mimeType || '').trim(),
    receiptOriginalFilename: String(receipt?.originalFilename || '').trim()
  };
}

function validateExpensePayload(payload) {
  const fields = [];
  if (!payload.userId) fields.push({ field: 'userId', reason: 'required' });
  if (!payload.workDate) fields.push({ field: 'work.workDate', reason: 'must be YYYY-MM-DD' });
  if (!payload.category) fields.push({ field: 'expense.category', reason: 'required' });
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    fields.push({ field: 'expense.amount', reason: 'must be number > 0' });
  }
  return fields;
}

function resolveIdempotencyKey(request, payload) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  if (payload?.idempotencyKey) {
    return String(payload.idempotencyKey).slice(0, 120);
  }

  const bodyRequestId = sanitizeRequestId(payload?.requestId);
  if (!bodyRequestId) return '';
  return `requestId:${bodyRequestId}`;
}

function resolveExpenseId(userId, requestId, idemKey) {
  const uid = String(userId || '').trim() || 'unknown';
  const source = String(requestId || idemKey || crypto.randomUUID()).trim();
  const normalized = source.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `exp-${uid}-${normalized}`;
}
