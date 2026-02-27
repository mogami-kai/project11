import { fetchWithRetry } from '../lib/fetch.js';
import { safeLog } from '../lib/redact.js';

const SLACK_TIMEOUT_MS = 10000;
const SLACK_SIGNATURE_PREFIX = 'v0=';

export async function verifySlackSignature(rawBody, headers, signingSecret, options = {}) {
  const bodyText = typeof rawBody === 'string' ? rawBody : '';
  const secret = String(signingSecret || '').trim();
  if (!bodyText || !secret) {
    return { ok: false, reason: 'missing_body_or_secret' };
  }

  const timestamp = String(headers.get('x-slack-request-timestamp') || '').trim();
  const signature = String(headers.get('x-slack-signature') || '').trim();
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing_signature_headers' };
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const nowSec = Number(options.nowSec || Math.floor(Date.now() / 1000));
  const maxSkewSec = Number(options.maxSkewSec || 300);
  if (Math.abs(nowSec - tsNum) > maxSkewSec) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const basestring = `v0:${timestamp}:${bodyText}`;
  const digest = await computeSlackSignature(basestring, secret);
  const expected = `${SLACK_SIGNATURE_PREFIX}${digest}`;

  if (!safeEqualString(expected, signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

export async function openSlackModal(env, triggerId, view, requestId = '') {
  const payload = {
    trigger_id: String(triggerId || '').trim(),
    view
  };
  return callSlackApi(env, '/api/views.open', payload, requestId);
}

export async function postSlackMessage(env, channel, text, blocks, requestId = '') {
  const payload = {
    channel: String(channel || '').trim(),
    text: String(text || '').trim() || 'Project1',
    blocks: Array.isArray(blocks) ? blocks : undefined
  };
  return callSlackApi(env, '/api/chat.postMessage', payload, requestId);
}

async function callSlackApi(env, path, payload, requestId) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  if (!token) {
    return {
      ok: false,
      status: 500,
      errorCode: 'SLACK_TOKEN_MISSING',
      response: null
    };
  }

  const endpoint = `https://slack.com${path}`;
  const { response, error } = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload || {})
    },
    {
      timeoutMs: SLACK_TIMEOUT_MS,
      retries: 1,
      retryDelayMs: 250,
      shouldRetry: (res, errObj) => {
        if (errObj) return true;
        if (!res) return true;
        return res.status === 429 || res.status >= 500;
      }
    }
  );

  if (error || !response) {
    return {
      ok: false,
      status: 502,
      errorCode: String(error?.name || 'SLACK_FETCH_FAILED'),
      response: null
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const apiOk = Boolean(body?.ok);
  if (!apiOk) {
    safeLog('slack.api.failed', {
      requestId,
      endpoint: path,
      status: response.status,
      error: String(body?.error || '')
    });
  }

  return {
    ok: response.ok && apiOk,
    status: response.status,
    errorCode: String(body?.error || ''),
    response: body
  };
}

async function computeSlackSignature(baseString, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const bytes = new Uint8Array(sigBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
