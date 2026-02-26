import { authenticateRequest } from '../auth.js';
import { getSiteProfile } from '../clients/gas.js';
import { extractReceiptWithGemini, inferDirectionWithGemini } from '../clients/gemini.js';
import { buildError, fail, ok } from '../http/response.js';
import { sanitizeDateYmd, sanitizeUserId } from '../util/validate.js';

const EARLY_MORNING_ABSORB_MAX_HOUR = 4;

export async function handleOcrExtract(request, env, meta, requestId) {
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

  const imageBase64 = String(body?.imageBase64 || '').trim();
  const mimeType = String(body?.mimeType || 'image/jpeg').trim();
  const requestedProjectId = String(body?.projectId || body?.project || '').trim();
  const requestedName = String(body?.name || body?.profileName || '').trim();

  const bodyUserId = sanitizeUserId(body?.userId);
  if (auth.mode === 'liff-id-token' && bodyUserId && bodyUserId !== auth.userId) {
    return fail(buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: bodyUserId }, false), meta, { status: 403 });
  }
  const userId = auth.mode === 'liff-id-token' ? auth.userId : bodyUserId;
  const workDate = sanitizeDateYmd(body?.workDate);

  if (!imageBase64) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'imageBase64', reason: 'required' }] }, false),
      meta,
      { status: 400 }
    );
  }

  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mimeType)) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'mimeType', reason: 'unsupported image type' }] }, false),
      meta,
      { status: 400 }
    );
  }

  const approximateBytes = Math.floor((imageBase64.length * 3) / 4);
  if (approximateBytes > 4 * 1024 * 1024) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'imageBase64', reason: 'image too large' }] }, false),
      meta,
      { status: 400 }
    );
  }

  if (!env.GEMINI_API_KEY) {
    return fail(
      buildError('E_OCR_DISABLED', 'Gemini OCR is not configured.', { reason: 'missing GEMINI_API_KEY' }, false),
      meta,
      { status: 503 }
    );
  }

  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (!workDate) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const siteLookup = await getSiteProfile(
    env,
    {
      userId,
      workDate,
      projectId: requestedProjectId,
      requestId
    },
    meta
  );

  if (!siteLookup.ok) return siteLookup.response;
  if (!siteLookup.gasJson?.ok) {
    const gasError = siteLookup.gasJson?.error || {};
    const gasCode = String(gasError.code || '');
    if (gasCode === 'E_SITE_PROFILE_MISSING') {
      return fail(
        buildError(
          'E_SITE_PROFILE_MISSING',
          'Site profile is missing.',
          {
            gasErrorCode: gasCode,
            gasErrorMessage: String(gasError.message || ''),
            workDate,
            userId
          },
          false
        ),
        meta,
        { status: 400 }
      );
    }

    return fail(
      buildError(
        'E_SITE_PROFILE_LOOKUP_FAILED',
        'Site profile lookup failed.',
        {
          gasErrorCode: gasCode || 'E_UNKNOWN',
          gasErrorMessage: String(gasError.message || '')
        },
        true
      ),
      meta,
      { status: 502 }
    );
  }

  const siteProfile = normalizeSiteProfile(siteLookup.gasJson?.data || {});

  const extraction = await extractReceiptWithGemini(env, {
    imageBase64,
    mimeType,
    requestId
  });

  if (!extraction.ok) {
    return fail(
      buildError('E_OCR_FAILED', 'OCR extraction failed.', extraction.details, true),
      meta,
      { status: 502 }
    );
  }

  const extracted = extraction.data || {};
  const binding = resolveWorkDateBound(workDate, extracted.issuedAtCandidate);

  const inference = await inferDirectionWithGemini(env, {
    requestId,
    workDate,
    issuedAtCandidate: extracted.issuedAtCandidate,
    fromCandidate: extracted.fromCandidate,
    toCandidate: extracted.toCandidate,
    amount: extracted.amount,
    site: {
      siteName: siteProfile.siteName,
      siteAddress: siteProfile.siteAddress,
      nearestStations: siteProfile.nearestStations
    },
    home: {
      nearestStation: siteProfile.homeNearestStation
    }
  });

  const inferred = {
    direction: 'unknown',
    workDateBound: binding.workDateBound,
    confidence: 0,
    reasons: binding.reasons.slice()
  };
  if (inference.ok) {
    inferred.direction = inference.data?.direction || 'unknown';
    inferred.confidence = Number.isFinite(Number(inference.data?.confidence)) ? Number(inference.data.confidence) : 0;
    const mergedReasons = []
      .concat(Array.isArray(inference.data?.reasons) ? inference.data.reasons : [])
      .concat(binding.reasons);
    inferred.reasons = uniqStrings(mergedReasons);
  } else {
    inferred.reasons = uniqStrings(inferred.reasons.concat('direction_inference_failed'));
  }

  const fromStation = String(extracted.fromCandidate || '').trim();
  const toStation = String(extracted.toCandidate || '').trim();
  const amount = Number(extracted.amount || 0);
  const normalizedClaimDraft = {
    userId,
    name: requestedName,
    project: requestedProjectId || siteProfile.projectId || '',
    workDate: inferred.workDateBound,
    fromStation,
    toStation,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    roundTrip: '片道',
    memo: buildDraftMemo(inferred)
  };

  return ok(
    {
      extracted,
      inferred,
      normalizedClaimDraft,
      source: 'gemini',
      meta: {
        issuedAtCandidate: String(extracted.issuedAtCandidate || ''),
        siteProfile: {
          siteId: siteProfile.siteId,
          siteName: siteProfile.siteName,
          projectId: siteProfile.projectId,
          workDate: siteProfile.workDate
        }
      }
    },
    meta
  );
}

function normalizeSiteProfile(data) {
  return {
    siteId: String(data?.siteId || '').trim(),
    siteAddress: String(data?.siteAddress || '').trim(),
    nearestStations: Array.isArray(data?.nearestStations)
      ? data.nearestStations.map((v) => String(v || '').trim()).filter(Boolean)
      : [],
    siteName: String(data?.siteName || '').trim(),
    projectId: String(data?.projectId || '').trim(),
    workDate: sanitizeDateYmd(data?.workDate) || '',
    homeNearestStation: String(data?.homeNearestStation || '').trim()
  };
}

function resolveWorkDateBound(inputWorkDate, issuedAtCandidate) {
  const workDateBound = sanitizeDateYmd(inputWorkDate) || '';
  const parsed = parseDateTimeLike(issuedAtCandidate);
  const reasons = ['work_date_input_priority'];
  if (!workDateBound) {
    return { workDateBound: '', reasons };
  }
  if (!parsed.date || parsed.date === workDateBound) {
    return { workDateBound, reasons };
  }

  const nextDay = addDays(workDateBound, 1);
  const isEarlyMorning = Number.isInteger(parsed.hour) && parsed.hour >= 0 && parsed.hour <= EARLY_MORNING_ABSORB_MAX_HOUR;
  if (parsed.date === nextDay && isEarlyMorning) {
    reasons.push('midnight_crossing_absorbed');
    return { workDateBound, reasons };
  }

  reasons.push('issued_at_ignored_by_rule');
  return { workDateBound, reasons };
}

function parseDateTimeLike(input) {
  const text = String(input || '').trim();
  if (!text) return { date: '', hour: null };

  const directDate = sanitizeDateYmd(text);
  if (directDate) return { date: directDate, hour: null };

  const m = text.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})(?:[T\s](\d{2})(?::\d{2})?)?/);
  if (!m) return { date: '', hour: null };

  const date = sanitizeDateYmd(`${m[1]}-${m[2]}-${m[3]}`);
  const hour = Number(m[4]);
  return {
    date,
    hour: Number.isFinite(hour) ? hour : null
  };
}

function addDays(ymd, deltaDays) {
  if (!sanitizeDateYmd(ymd)) return '';
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function uniqStrings(values) {
  const set = new Set();
  for (const raw of values || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (!set.has(text)) set.add(text);
  }
  return Array.from(set);
}

function buildDraftMemo(inferred) {
  const direction = String(inferred?.direction || 'unknown');
  const confidence = Number(inferred?.confidence || 0);
  return `[ocr:auto] direction=${direction} confidence=${confidence.toFixed(2)}`;
}
