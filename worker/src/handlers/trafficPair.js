import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { extractReceiptWithGemini, normalizeStationsWithGemini } from '../clients/gemini.js';
import { buildError, fail, json, ok } from '../lib/response.js';
import { requireRegistered } from '../lib/access.js';
import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { sanitizeDateYmd, sanitizeRequestId, sanitizeUserId } from '../lib/validate.js';

const EARLY_MORNING_MAX_HOUR = 5;

export async function handleTrafficOcrAuto(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return failWithReview(meta, 'E_BAD_REQUEST', 'Invalid JSON.', {}, false, 400);
  }

  const imageBase64 = String(body?.imageBase64 || '').trim();
  const mimeType = String(body?.mimeType || 'image/jpeg').trim();

  if (!imageBase64) {
    return failWithReview(
      meta,
      'E_VALIDATION',
      'Validation failed.',
      { fields: [{ field: 'imageBase64', reason: 'required' }] },
      false,
      400
    );
  }

  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mimeType)) {
    return failWithReview(
      meta,
      'E_VALIDATION',
      'Validation failed.',
      { fields: [{ field: 'mimeType', reason: 'unsupported image type' }] },
      false,
      400
    );
  }

  const approximateBytes = Math.floor((imageBase64.length * 3) / 4);
  if (approximateBytes > 4 * 1024 * 1024) {
    return failWithReview(
      meta,
      'E_VALIDATION',
      'Validation failed.',
      { fields: [{ field: 'imageBase64', reason: 'image too large' }] },
      false,
      400
    );
  }

  if (!env.GEMINI_API_KEY) {
    return failWithReview(
      meta,
      'E_OCR_DISABLED',
      'Gemini OCR is not configured.',
      { reason: 'missing GEMINI_API_KEY' },
      false,
      503
    );
  }

  const bodyUserId = sanitizeUserId(body?.userId);
  if (auth.mode === 'liff-id-token' && bodyUserId && bodyUserId !== auth.userId) {
    return failWithReview(meta, 'E_FORBIDDEN', 'Forbidden userId.', { userId: bodyUserId }, false, 403);
  }

  const userId = auth.mode === 'liff-id-token' ? auth.userId : bodyUserId;
  if (!userId) {
    return failWithReview(
      meta,
      'E_VALIDATION',
      'Validation failed.',
      { fields: [{ field: 'userId', reason: 'required' }] },
      false,
      400
    );
  }

  // Spec: v5_spec 1.2 Rich Menu Gating / api_schema 2 Gate
  const registerGate = await requireRegistered(env, meta, requestId, { userId });
  if (!registerGate.ok) return registerGate.response;

  const routeKey = '/api/traffic/ocr-auto';
  const idemKey = resolveIdempotencyKey(request, body);
  const payloadHashInput = {
    userId,
    mimeType,
    workDate: sanitizeDateYmd(body?.workDate) || '',
    ocrDate: String(body?.ocrDate || '').trim(),
    ocrDateTime: String(body?.ocrDateTime || '').trim(),
    imageFingerprint: imageBase64 ? await resolvePayloadHash(imageBase64) : ''
  };
  const payloadHash = idemKey ? await resolvePayloadHash(payloadHashInput) : '';

  if (idemKey) {
    const payloadMatched = await ensureIdempotencyPayloadMatch(env, routeKey, idemKey, payloadHash);
    if (!payloadMatched) {
      return failWithReview(
        meta,
        'E_IDEMPOTENCY_MISMATCH',
        'Idempotency key payload mismatch.',
        {},
        false,
        409
      );
    }

    const cached = await getIdempotentResponse(env, routeKey, idemKey);
    if (cached) {
      return json(cached, { status: 200 });
    }
  }

  let lockAcquired = false;
  const cacheOkResponse = async (response) => {
    if (!idemKey || !response?.ok) return response;
    const payload = await response.clone().json().catch(() => null);
    if (payload?.ok) {
      await setIdempotentResponse(env, routeKey, idemKey, payload);
    }
    return response;
  };

  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return failWithReview(meta, 'E_CONFLICT', 'Request in progress.', {}, true, 409);
      }
    }

    const extraction = await extractReceiptWithGemini(env, {
      imageBase64,
      mimeType,
      requestId
    });

    if (!extraction.ok) {
      return failWithReview(meta, 'E_OCR_FAILED', 'OCR extraction failed.', extraction.details, true, 502);
    }

    const extracted = extraction.data || {};
    const rawOcrDateInput = String(body?.ocrDateTime || body?.ocrDate || extracted.workDate || '').trim();

    const fallbackWorkDate = extractDatePart(rawOcrDateInput);
    const requestedWorkDate = sanitizeDateYmd(body?.workDate);
    const extractedWorkDate = sanitizeDateYmd(extracted?.workDate);
    const workDate = requestedWorkDate || extractedWorkDate || fallbackWorkDate;
    if (!workDate) {
      return failWithReview(
        meta,
        'E_VALIDATION',
        'Validation failed.',
        { fields: [{ field: 'workDate', reason: 'required(ocrDate/workDate)' }] },
        false,
        400
      );
    }

    const siteLookup = await callGas(
      env,
      {
        action: 'site.getByDate',
        token: env.STAFF_TOKEN_FOR_GAS,
        requestId,
        data: { userId, workDate }
      },
      meta
    );

    if (!siteLookup.ok) {
      return failWithReview(
        meta,
        'E_GAS_ERROR',
        'Failed to fetch site info.',
        { step: 'site.getByDate' },
        true,
        siteLookup.response?.status || 502
      );
    }

    if (!siteLookup.gasJson?.ok) {
      return failWithReview(
        meta,
        'E_SITE_LOOKUP_FAILED',
        'Site lookup failed.',
        {
          step: 'site.getByDate',
          gasErrorCode: siteLookup.gasJson?.error?.code || '',
          gasErrorMessage: siteLookup.gasJson?.error?.message || ''
        },
        false,
        400
      );
    }

    const siteData = siteLookup.gasJson?.data || {};
    const ocrStations = [
      String(extracted?.fromStation || '').trim(),
      String(extracted?.toStation || '').trim()
    ].filter(Boolean);

    if (ocrStations.length === 0) {
      return await cacheOkResponse(ok(
        {
          needsReview: true,
          reason: 'station_missing_from_ocr',
          extracted,
          site: siteData,
          workDate,
          userId
        },
        meta
      ));
    }

    const stationNormalize = await normalizeStationsWithGemini(env, {
      requestId,
      siteAddress: siteData.siteAddress,
      siteNearestStation: siteData.siteNearestStation,
      ocrStations
    });

    if (!stationNormalize.ok) {
      return failWithReview(
        meta,
        'E_STATION_NORMALIZE_FAILED',
        'Station normalization failed.',
        stationNormalize.details,
        true,
        502
      );
    }

    const normalizedStations = stationNormalize.data?.normalizedStations || [];
    const fromStation = pickNormalizedStation(String(extracted?.fromStation || '').trim(), normalizedStations, 0);
    const toStation = pickNormalizedStation(String(extracted?.toStation || '').trim(), normalizedStations, 1);
    const siteStation = resolveSiteStation(siteData, normalizedStations);

    const trip = determineTripType({
      fromStation,
      toStation,
      siteStation,
      ocrDate: rawOcrDateInput || extracted?.workDate,
      workDate
    });

    if (!trip.type) {
      return await cacheOkResponse(ok(
        {
          needsReview: true,
          reason: trip.reason || 'trip_type_undetermined',
          extracted,
          normalizedStations,
          site: siteData,
          workDate,
          effectiveDate: trip.effectiveDate,
          userId
        },
        meta
      ));
    }

    const amount = Number(extracted?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return await cacheOkResponse(ok(
        {
          needsReview: true,
          reason: 'invalid_amount',
          extracted,
          normalizedStations,
          site: siteData,
          workDate,
          effectiveDate: trip.effectiveDate,
          userId
        },
        meta
      ));
    }

    const effectiveDate = sanitizeDateYmd(trip.effectiveDate) || workDate;
    const rawDate = extractDatePart(rawOcrDateInput) || extractedWorkDate || workDate;
    const workKey = `${effectiveDate.replace(/-/g, '')}-${userId}`;

    const setPair = await callGas(
      env,
      {
        action: 'traffic.setPair',
        token: env.STAFF_TOKEN_FOR_GAS,
        requestId,
        data: {
          workKey,
          workDate: effectiveDate,
          userId,
          siteId: String(siteData?.siteId || '').trim(),
          type: trip.type,
          fromStation,
          toStation,
          amount,
          rawDate
        }
      },
      meta
    );

    if (!setPair.ok) {
      return failWithReview(
        meta,
        'E_GAS_ERROR',
        'Failed to register pair traffic.',
        { step: 'traffic.setPair' },
        true,
        setPair.response?.status || 502
      );
    }

    if (!setPair.gasJson?.ok) {
      return failWithReview(
        meta,
        'E_TRAFFIC_PAIR_SET_FAILED',
        'traffic.setPair failed.',
        {
          step: 'traffic.setPair',
          gasErrorCode: setPair.gasJson?.error?.code || '',
          gasErrorMessage: setPair.gasJson?.error?.message || ''
        },
        false,
        400
      );
    }

    return await cacheOkResponse(ok(
      {
        needsReview: false,
        workKey,
        workDate: effectiveDate,
        rawDate,
        type: trip.type,
        userId,
        site: {
          siteId: String(siteData?.siteId || '').trim(),
          siteName: String(siteData?.siteName || '').trim(),
          siteAddress: String(siteData?.siteAddress || '').trim(),
          siteNearestStation: String(siteData?.siteNearestStation || '').trim()
        },
        extracted,
        normalizedStations,
        registration: setPair.gasJson?.data || {}
      },
      meta
    ));
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

function failWithReview(meta, code, message, details = {}, retryable = false, status = 400) {
  return fail(buildError(code, message, { ...details, needsReview: true }, retryable), meta, { status });
}

function pickNormalizedStation(rawStation, normalizedStations, fallbackIndex) {
  const raw = String(rawStation || '').trim();
  const list = Array.isArray(normalizedStations) ? normalizedStations : [];
  const byRaw = list.find((item) => String(item?.raw || '').trim() === raw);
  if (byRaw && String(byRaw?.normalized || '').trim()) {
    return String(byRaw.normalized).trim();
  }

  const byIndex = list[fallbackIndex];
  if (byIndex && String(byIndex?.normalized || '').trim()) {
    return String(byIndex.normalized).trim();
  }

  return raw;
}

function resolveSiteStation(siteData, normalizedStations) {
  const list = Array.isArray(normalizedStations) ? normalizedStations : [];
  const stationFromGemini = list.find((item) => item && item.isSite && String(item.normalized || '').trim());
  if (stationFromGemini) return String(stationFromGemini.normalized || '').trim();
  return String(siteData?.siteNearestStation || '').trim();
}

export function determineTripType({ fromStation, toStation, siteStation, ocrDate, workDate }) {
  const fromKey = normalizeStationKey(fromStation);
  const toKey = normalizeStationKey(toStation);
  const siteKey = normalizeStationKey(siteStation);
  const effectiveDate = resolveEffectiveDate(ocrDate, workDate);

  if (!fromKey || !toKey || !siteKey) {
    return { type: '', effectiveDate, reason: 'station_missing' };
  }

  const fromIsSite = fromKey === siteKey;
  const toIsSite = toKey === siteKey;

  // パターンA: [自宅/ホテル] -> [現場最寄り] なら「行き」
  if (!fromIsSite && toIsSite) {
    return { type: '行き', effectiveDate };
  }

  // パターンB: [現場最寄り] -> [自宅/ホテル] なら「帰り」
  if (fromIsSite && !toIsSite) {
    return { type: '帰り', effectiveDate };
  }

  return { type: '', effectiveDate, reason: 'ambiguous' };
}

function normalizeStationKey(value) {
  return String(value || '')
    .trim()
    .replace(/[\s　]+/g, '')
    .replace(/駅$/, '');
}

function resolveEffectiveDate(ocrDate, workDate) {
  const normalizedWorkDate = sanitizeDateYmd(workDate);
  const parsed = parseDateTimeLike(ocrDate);

  if (!normalizedWorkDate) {
    return parsed.date || '';
  }

  if (!parsed.date) {
    return normalizedWorkDate;
  }

  if (parsed.date === normalizedWorkDate) {
    return normalizedWorkDate;
  }

  const nextDate = addDays(normalizedWorkDate, 1);
  const isEarlyMorning = Number.isInteger(parsed.hour) && parsed.hour >= 0 && parsed.hour <= EARLY_MORNING_MAX_HOUR;
  if (parsed.date === nextDate && isEarlyMorning) {
    return normalizedWorkDate;
  }

  return parsed.date;
}

function extractDatePart(input) {
  return parseDateTimeLike(input).date;
}

function parseDateTimeLike(input) {
  const text = String(input || '').trim();
  if (!text) return { date: '', hour: null };

  const directYmd = sanitizeDateYmd(text);
  if (directYmd) return { date: directYmd, hour: null };

  const m = text.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})(?:[T\s](\d{2})(?::\d{2})?)?/);
  if (m) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const hour = m[4] ? Number(m[4]) : null;
    return { date: sanitizeDateYmd(date), hour: Number.isFinite(hour) ? hour : null };
  }

  return { date: '', hour: null };
}

function addDays(ymd, deltaDays) {
  if (!sanitizeDateYmd(ymd)) return '';
  const base = new Date(`${ymd}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
