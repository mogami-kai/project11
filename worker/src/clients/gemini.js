import { fetchWithRetry } from '../lib/fetch.js';
import { safeLog } from '../lib/redact.js';
import { sanitizeDateYmd } from '../lib/validate.js';
import { applyTransportRules, normalizeItemType } from '../lib/receiptRules.js';
import { prepareImageForOcr } from '../lib/imagePrep.js';

const OCR_TIMEOUT_MS = 18000;
const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash-8b';

function resolveGeminiModel(env) {
  return String(env.GEMINI_MODEL || env.GEMINI_OCR_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

function buildGenerationConfig() {
  return {
    temperature: 0,
    topP: 1,
    topK: 1,
    candidateCount: 1,
    responseMimeType: 'application/json'
  };
}

function geminiEndpoint(env) {
  const model = resolveGeminiModel(env);
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(String(env.GEMINI_API_KEY))}`;
}

async function generateWithGemini(env, payload, logLabel, requestId) {
  const { response, error } = await fetchWithRetry(
    geminiEndpoint(env),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    },
    {
      timeoutMs: OCR_TIMEOUT_MS,
      retries: 1,
      retryDelayMs: 250
    }
  );

  safeLog(logLabel, {
    requestId: String(requestId || ''),
    status: response?.status || null,
    ok: Boolean(response?.ok),
    errorName: error ? String(error?.name || 'fetch_error') : ''
  });

  if (error || !response || !response.ok) {
    return {
      ok: false,
      details: {
        reason: error ? String(error?.name || 'fetch_error') : 'upstream_error',
        status: response?.status || null
      }
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, details: { reason: 'invalid_json' } };
  }

  const text = String(
    raw?.candidates?.[0]?.content?.parts?.[0]?.text ||
    raw?.candidates?.[0]?.output ||
    ''
  ).trim();

  const parsed = parseJsonFromText(text);
  if (!parsed) {
    return { ok: false, details: { reason: 'json_parse_failed' } };
  }

  return { ok: true, data: parsed };
}

export async function extractReceiptWithGemini(env, input) {
  const prompt = [
    'あなたは交通費OCR専用抽出器です。出力はJSONのみ、説明文は禁止。',
    '対象画像は「交通費検索結果」「ICカード履歴」「領収書」「足場現場シフト画像（交代矢印あり）」です。',
    '次のJSON形式のみ出力すること（他のキーは出力しない）:',
    '{"items":[{"from":"","to":"","amount":0,"type":"train|bus|mixed|other|unknown","confidence":0.9,"rawLine":""}],"issuedAtCandidate":"","workDate":"","rawText":""}',
    '',
    'itemsの抽出ルール（画像内の全明細行を配列で返す）:',
    '- from/to は交通文脈（運賃, 乗換, IC, 切符, 円, 経路, 発, 着）がある行のみ抽出',
    '- 矢印記号（→, ⇒, ➡, ⇄, ↔, ->）は経路候補として参照する',
    '- 人名/班名/職種の交代矢印（例: A班→B班, 職長→手元）は駅名として扱わない',
    '- amount は該当行の支払額（整数円）。不明は0',
    '- type は train|bus|mixed|other|unknown のいずれか（other は物販・食事・宿泊等の非交通費）',
    '- confidence は 0〜1（その行が交通費と確信できる度合い）',
    '- rawLine は判定に使った文字（100文字以内）',
    '- issuedAtCandidate/workDate は YYYY-MM-DD もしくは YYYY-MM-DD HH:mm。不明は空文字',
    '- rawText は判定に使った文字のみを150文字以内',
    '- 推測で補完しない。不明は空文字または0'
  ].join('\n');

  // Preprocess: EXIF rotation + resize to 1600px long-edge
  // Falls back to original image if runtime Canvas APIs are unavailable.
  const prep = await prepareImageForOcr(input.imageBase64, input.mimeType);

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: prep.mimeType,
              data: prep.base64
            }
          }
        ]
      }
    ],
    generationConfig: buildGenerationConfig()
  };

  const generated = await generateWithGemini(env, payload, 'ocr.gemini', input?.requestId);
  if (!generated.ok) return generated;

  const normalized = normalizeOcrExtractionResult(generated.data);
  return { ok: true, data: normalized };
}

/**
 * Exported wrapper around normalizeOcrExtractionResult for unit testing.
 * Consumers should use extractReceiptWithGemini; this is test-only.
 */
export function normalizeOcrExtraction(rawGeminiData) {
  return normalizeOcrExtractionResult(rawGeminiData);
}

export async function extractHotelConfirmationWithGemini(env, input) {
  const prompt = [
    'ホテル予約確認スクリーンショットのOCR抽出です。次のJSONのみ返してください。',
    '{"name":"","hotel":"","date":"","rawText":""}',
    'nameは利用者名、hotelはホテル名、dateは宿泊日(YYYY-MM-DD)。',
    'dateが特定できない場合は空文字。',
    'JSON以外の文字は返さない。'
  ].join('\n');

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: input.mimeType,
              data: input.imageBase64
            }
          }
        ]
      }
    ],
    generationConfig: buildGenerationConfig()
  };

  const generated = await generateWithGemini(env, payload, 'hotel.screenshot.ocr', input?.requestId);
  if (!generated.ok) return generated;

  return {
    ok: true,
    data: normalizeHotelConfirmationResult(generated.data)
  };
}

export async function inferDirectionWithGemini(env, input) {
  const prompt = buildDirectionInferencePrompt(input);
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: buildGenerationConfig()
  };

  const generated = await generateWithGemini(env, payload, 'ocr.direction.infer', input?.requestId);
  if (!generated.ok) return generated;

  return {
    ok: true,
    data: normalizeDirectionResult(generated.data)
  };
}

export async function normalizeStationsWithGemini(env, input) {
  const siteAddress = String(input?.siteAddress || '').trim();
  const siteNearestStation = String(input?.siteNearestStation || '').trim();
  const ocrStations = Array.isArray(input?.ocrStations)
    ? input.ocrStations.map((s) => String(s || '').trim()).filter(Boolean)
    : [];

  const prompt = [
    '現場住所とOCR駅候補から駅名正規化を行う。出力はJSONのみ。',
    '{"normalizedStations":[{"raw":"","normalized":"","isSite":true}]}',
    'isSiteは現場最寄り駅と判断した駅のみtrue。',
    '入力には足場シフトの交代矢印文字列が混在する可能性がある。人名/班名は駅名として採用しない。',
    '駅名正規化は表記ゆれ吸収（駅/支線/括弧補足の除去）を優先し、外部知識で補完しない。',
    `siteAddress: ${siteAddress || '(unknown)'}`,
    `siteNearestStation: ${siteNearestStation || '(unknown)'}`,
    `ocrStations: ${JSON.stringify(ocrStations)}`
  ].join('\n');

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: buildGenerationConfig()
  };

  const generated = await generateWithGemini(env, payload, 'ocr.station.normalize', input?.requestId);
  if (!generated.ok) return generated;

  const list = Array.isArray(generated?.data?.normalizedStations)
    ? generated.data.normalizedStations
    : [];

  return {
    ok: true,
    data: {
      normalizedStations: list.map((item) => ({
        raw: String(item?.raw || '').trim(),
        normalized: String(item?.normalized || '').trim(),
        isSite: Boolean(item?.isSite)
      }))
    }
  };
}

function normalizeOcrExtractionResult(data) {
  const issuedAtCandidate = String(data?.issuedAtCandidate || data?.issuedAt || '').trim();
  const rawText = String(data?.rawText || '').trim().slice(0, 150);

  // New items[] path: Gemini returns items array
  const { items, totals } = applyTransportRules(data?.items);

  // Primary item (first transport item with route info) drives backward-compat fields
  const primary = items.find((it) => it.from || it.to) || items[0] || null;

  // Backward-compat: if no items[], fall back to old flat fields for safe migration
  const fromCandidate = primary
    ? String(primary.from || '').trim()
    : String(data?.fromCandidate || data?.fromStation || '').trim();
  const toCandidate = primary
    ? String(primary.to || '').trim()
    : String(data?.toCandidate || data?.toStation || '').trim();
  const amount = primary
    ? Number(primary.amount || 0)
    : Math.max(0, Number(data?.amount || 0));
  const transportTypeCandidate = primary
    ? normalizeItemType(String(primary.type || ''))
    : normalizeTransportType(String(data?.transportTypeCandidate || data?.transportType || '').trim());

  return {
    // New structured fields
    items,
    totals,
    // Backward-compatible flat fields (consumed by trafficPair.js, ocr.js)
    fromCandidate,
    toCandidate,
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    issuedAtCandidate,
    transportTypeCandidate,
    rawText,
    workDate: sanitizeDateYmd(data?.workDate) || '',
    fromStation: fromCandidate,
    toStation: toCandidate,
    roundTrip: '片道',
    memo: ''
  };
}

function normalizeTransportType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'train' || v === 'bus' || v === 'mixed' || v === 'unknown') return v;

  if (/電車|jr|私鉄|地下鉄|train/.test(v)) return 'train';
  if (/バス|bus/.test(v)) return 'bus';
  if (/混在|mixed|both/.test(v)) return 'mixed';
  return 'unknown';
}

function buildDirectionInferencePrompt(input) {
  const payload = {
    workDate: String(input?.workDate || '').trim(),
    issuedAtCandidate: String(input?.issuedAtCandidate || '').trim(),
    fromCandidate: String(input?.fromCandidate || '').trim(),
    toCandidate: String(input?.toCandidate || '').trim(),
    amount: Number(input?.amount || 0),
    site: {
      siteName: String(input?.site?.siteName || '').trim(),
      siteAddress: String(input?.site?.siteAddress || '').trim(),
      nearestStations: Array.isArray(input?.site?.nearestStations)
        ? input.site.nearestStations.map((v) => String(v || '').trim()).filter(Boolean)
        : []
    },
    home: {
      nearestStation: String(input?.home?.nearestStation || '').trim()
    }
  };

  return [
    'あなたは通勤・交通費精算の補助AIです。地図APIは禁止。与えられた文字情報だけで推定してください。',
    '出力は必ずJSONのみ。余計な文章は禁止。',
    '',
    '# 入力（JSON）',
    JSON.stringify(payload, null, 2),
    '',
    '# ルール',
    '- 地図・距離・所要時間などは推測しない（外部知識の地理推定をしない）',
    '- 足場シフトの交代矢印（例: A班→B班, 職長→手元）は交通方向判定に使わない',
    '- 文字列の一致/部分一致/同義（例: "新宿" と "新宿駅"）/よくある表記ゆれ（西口/東口/三丁目 など）を考慮して',
    '  「site側」「home側」「不明」を判定する',
    '- 判定に迷う場合は unknown を返す（無理に断定しない）',
    '- confidenceは 0〜1',
    '- reasonsは短い箇条書き文字列配列',
    '',
    '# 出力（JSONのみ）',
    '{"fromSide":"site|home|other|unknown","toSide":"site|home|other|unknown","direction":"going|returning|unknown","confidence":0.0,"reasons":["..."]}',
    '',
    '# directionの決定',
    '- fromSide=home かつ toSide=site → going',
    '- fromSide=site かつ toSide=home → returning',
    '- それ以外 → unknown'
  ].join('\n');
}

function normalizeDirectionResult(data) {
  const normalizeSide = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'site' || raw === 'home' || raw === 'other' || raw === 'unknown') return raw;
    return 'unknown';
  };
  const normalizeDirection = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'going' || raw === 'returning' || raw === 'unknown') return raw;
    return 'unknown';
  };

  const reasons = Array.isArray(data?.reasons)
    ? data.reasons.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  const confidenceNumber = Number(data?.confidence);
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.max(0, Math.min(1, confidenceNumber))
    : 0;

  return {
    fromSide: normalizeSide(data?.fromSide),
    toSide: normalizeSide(data?.toSide),
    direction: normalizeDirection(data?.direction),
    confidence,
    reasons
  };
}

function normalizeHotelConfirmationResult(data) {
  const rawDate = String(data?.date || data?.stayDate || data?.checkinDate || '').trim();
  const normalizedDate = sanitizeDateYmd(rawDate) || normalizeDateFromText(rawDate);

  return {
    name: String(data?.name || data?.guestName || '').trim(),
    hotel: String(data?.hotel || data?.hotelName || '').trim(),
    date: normalizedDate,
    rawText: String(data?.rawText || '').trim()
  };
}

function normalizeDateFromText(rawDate) {
  const text = String(rawDate || '').trim();
  if (!text) return '';

  const m = text.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return '';

  const yyyy = m[1];
  const mm = String(Number(m[2])).padStart(2, '0');
  const dd = String(Number(m[3])).padStart(2, '0');
  const ymd = `${yyyy}-${mm}-${dd}`;
  return sanitizeDateYmd(ymd) || '';
}

function parseJsonFromText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
