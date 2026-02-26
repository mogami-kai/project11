// Spec: data-boundary.md §2 / action-contracts §4.2
// PR-A: Worker は OCR（Gemini）のみ担当し、名寄せ・永続化は GAS action 'hotel.screenshot.process' に委譲する。
// Worker は Sheets（STAFF_MASTER / SHIFT_ASSIGNMENTS / HOTEL_CONFIRMED_LOG / HOTEL_SCREENSHOT_RAW）に直接アクセスしない。
import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { extractHotelConfirmationWithGemini } from '../clients/gemini.js';
import { downloadLineMessageContent } from '../clients/line.js';
import { requireAdmin } from '../lib/access.js';
import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { buildError, fail, json, ok } from '../http/response.js';
import { sanitizeRequestId, sanitizeUserId } from '../util/validate.js';

export async function handleHotelScreenshotProcess(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const adminLineUserId = auth.mode === 'liff-id-token'
    ? auth.userId
    : String(body?.lineUserId || body?.adminLineUserId || '').trim();

  const adminCheck = requireAdmin(request, env, meta, {
    requireAdminUser: true,
    userId: adminLineUserId
  });
  if (!adminCheck.ok) return adminCheck.response;

  const routeKey = '/api/hotel/screenshot/process';
  const idemKey = resolveIdempotencyKey(request, body);
  // Spec: ops_rules 1 Idempotency / v5_spec 2.3 Idempotency
  const payloadHashInput = {
    adminLineUserId,
    messageId: String(body?.messageId || '').trim(),
    targetUserId: sanitizeUserId(body?.targetUserId || body?.userId),
    imageFingerprint: body?.imageBase64
      ? await resolvePayloadHash(String(body.imageBase64))
      : ''
  };
  const payloadHash = idemKey ? await resolvePayloadHash(payloadHashInput) : '';

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

  if (!env.GEMINI_API_KEY) {
    return fail(
      buildError('E_OCR_DISABLED', 'Gemini OCR is not configured.', { missing: ['GEMINI_API_KEY'] }, false),
      meta,
      { status: 503 }
    );
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    // Worker 責務: 画像取得 + OCR（Gemini）
    // Spec: v5_spec 2.2 Images Policy — ホテル予約スクショは保存しない（名寄せ処理後に破棄）
    const image = await resolveImageInput(env, requestId, {
      imageBase64: String(body?.imageBase64 || '').trim(),
      mimeType: String(body?.mimeType || 'image/jpeg').trim(),
      messageId: String(body?.messageId || '').trim()
    });
    if (!image.ok) {
      return fail(
        buildError(image.code || 'E_UPSTREAM', image.message || 'Image retrieval failed.', image.details || {}, Boolean(image.retryable)),
        meta,
        { status: image.status || 502 }
      );
    }

    const ocr = await extractHotelConfirmationWithGemini(env, {
      requestId,
      imageBase64: image.base64,
      mimeType: image.mimeType
    });
    if (!ocr.ok) {
      return fail(
        buildError('E_OCR_FAILED', 'Failed to extract hotel confirmation details.', ocr.details || {}, true),
        meta,
        { status: 502 }
      );
    }

    const extracted = {
      name: String(ocr.data?.name || '').trim(),
      hotel: String(ocr.data?.hotel || '').trim(),
      date: String(ocr.data?.date || '').trim()
    };

    // Spec: data-boundary.md §2 — 名寄せ・永続化は GAS に委譲する
    const { ok: gasOk, response: gasResponse, gasJson } = await callGas(
      env,
      {
        action: 'hotel.screenshot.process',
        token: env.STAFF_TOKEN_FOR_GAS,
        requestId,
        data: {
          adminLineUserId,
          messageId: String(body?.messageId || '').trim(),
          ocrName: extracted.name,
          ocrHotel: extracted.hotel,
          ocrDate: extracted.date,
          mimeType: image.mimeType,
          bytes: image.bytes,
          targetUserId: sanitizeUserId(body?.targetUserId || body?.userId)
        }
      },
      meta,
      { retries: 0 }
    );

    if (!gasOk) return gasResponse;
    if (!gasJson?.ok) {
      return fail(
        buildError('E_UPSTREAM', 'GAS hotel.screenshot.process failed.', { gasError: gasJson?.error || {} }, true),
        meta,
        { status: 502 }
      );
    }

    const responseMeta = {
      ...meta,
      warnings: Array.isArray(gasJson?.data?.warnings) ? gasJson.data.warnings : []
    };
    const successPayload = {
      ok: true,
      data: gasJson.data,
      meta: responseMeta
    };

    if (idemKey) {
      await setIdempotentResponse(env, routeKey, idemKey, successPayload);
    }

    return ok(gasJson.data, responseMeta);
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

async function resolveImageInput(env, requestId, input) {
  const inlineBase64 = String(input?.imageBase64 || '').trim();
  const inlineMime = String(input?.mimeType || 'image/jpeg').trim();
  if (inlineBase64) {
    const bytes = estimateBytesFromBase64(inlineBase64);
    return { ok: true, base64: inlineBase64, mimeType: inlineMime, bytes };
  }

  const messageId = String(input?.messageId || '').trim();
  if (!messageId) {
    return {
      ok: false, status: 400, code: 'E_VALIDATION',
      message: 'messageId or imageBase64 is required.',
      details: { fields: [{ field: 'messageId', reason: 'required(messageId or imageBase64)' }] },
      retryable: false
    };
  }

  const downloaded = await downloadLineMessageContent(env, messageId, requestId);
  if (!downloaded.ok) {
    return {
      ok: false, status: downloaded.status || 502,
      code: downloaded.errorCode || 'E_UPSTREAM',
      message: 'Failed to download LINE image content.',
      details: { status: downloaded.status || null },
      retryable: true
    };
  }

  return {
    ok: true,
    base64: arrayBufferToBase64(downloaded.arrayBuffer),
    mimeType: String(downloaded.mimeType || 'image/jpeg').trim(),
    bytes: Number(downloaded.bytes || 0)
  };
}

function estimateBytesFromBase64(base64Text) {
  const text = String(base64Text || '').trim();
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
  return Math.floor((text.length * 3) / 4) - padding;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function resolveIdempotencyKey(request, body) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyIdempotencyKey = String(body?.idempotencyKey || '').trim();
  if (bodyIdempotencyKey) return bodyIdempotencyKey.slice(0, 120);

  const messageId = String(body?.messageId || '').trim();
  if (messageId) return `messageId:${messageId.slice(0, 100)}`;

  const bodyRequestId = sanitizeRequestId(body?.requestId);
  if (!bodyRequestId) return '';
  return `requestId:${bodyRequestId}`;
}
