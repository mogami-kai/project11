import { fetchWithRetry } from './lib/fetch.js';
import { getLiffId } from './lib/env.js';
import { buildError, fail } from './lib/response.js';
import { sha256Hex } from './util/hash.js';
import { safeLog } from './lib/redact.js';
import { sanitizeUserId, validateApiKeyAuth } from './lib/validate.js';

const TOKEN_VERIFY_CACHE = new Map();

function getBearerToken(request) {
  const auth = String(request.headers.get('authorization') || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

async function verifyLineIdToken(idToken, liffId, requestId, env) {
  const token = String(idToken || '').trim();
  if (!token || !liffId) return { ok: false, userId: '' };

  const now = Date.now();
  for (const [k, v] of TOKEN_VERIFY_CACHE.entries()) {
    if (!v || Number(v.expiresAtMs || 0) <= now) {
      TOKEN_VERIFY_CACHE.delete(k);
    }
  }

  const cacheKey = await sha256Hex(`line-id-token:${token}`);
  const cached = TOKEN_VERIFY_CACHE.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return { ok: true, userId: cached.userId };
  }

  const body = new URLSearchParams();
  body.set('id_token', token);
  body.set('client_id', liffId);

  const { response, error } = await fetchWithRetry(
    'https://api.line.me/oauth2/v2.1/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    { timeoutMs: 8000, retries: 1, retryDelayMs: 200 }
  );

  if (error || !response || !response.ok) {
    return { ok: false, userId: '' };
  }

  let payload;
  try { payload = await response.json(); } catch { return { ok: false, userId: '' }; }

  const sub = sanitizeUserId(payload?.sub);
  const expSec = Number(payload?.exp || 0);
  if (!sub || !Number.isFinite(expSec) || expSec <= 0) return { ok: false, userId: '' };

  const expiresAtMs = expSec * 1000;
  TOKEN_VERIFY_CACHE.set(cacheKey, { userId: sub, expiresAtMs });

  return { ok: true, userId: sub };
}

export async function authenticateRequest(request, env, meta, options = {}) {
  const { allowApiKey = true, allowLiffIdToken = true, liffScreen } = options;

  if (allowApiKey) {
    const keyAuth = validateApiKeyAuth(request, env);
    if (keyAuth.ok) return { ok: true, mode: 'api-key', userId: '' };
  }

  const bearer = getBearerToken(request);

  // STAFF_BEARER_TOKEN: 共有スタッフトークン（API keyの代替、dev/test用）
  if (bearer) {
    const staffBearer = String(env.STAFF_BEARER_TOKEN || '').trim();
    if (staffBearer && bearer === staffBearer) {
      return { ok: true, mode: 'staff-bearer', userId: '' };
    }
  }

  if (allowLiffIdToken && bearer) {
    const liffId = getLiffId(env, liffScreen);
    if (!liffId) {
      return { ok: false, response: fail(buildError('E_CONFIG', 'LIFF_ID is missing.', {}, false), meta, { status: 500 }) };
    }
    const verified = await verifyLineIdToken(bearer, liffId, meta.requestId, env);
    if (verified.ok) return { ok: true, mode: 'liff-id-token', userId: sanitizeUserId(verified.userId) };
  }

  return { ok: false, response: fail(buildError('E_UNAUTHORIZED', 'Unauthorized.', {}, false), meta, { status: 401 }) };
}
