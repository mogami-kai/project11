import { fetchWithRetry } from '../lib/fetch.js';
import { safeLog } from '../util/redact.js';

const LINE_TIMEOUT_MS = 10000;

export async function replyLineMessage(env, replyToken, messages, requestId = '') {
  return callLineApi(env, 'https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages
  }, requestId, { retries: 1 });
}

export async function pushLineMessage(env, to, messages, requestId = '') {
  return callLineApi(env, 'https://api.line.me/v2/bot/message/push', {
    to,
    messages
  }, requestId, { retries: 1 });
}

export async function linkUserRichMenu(env, userId, richMenuId, requestId = '') {
  const targetUserId = String(userId || '').trim();
  const targetRichMenuId = String(richMenuId || '').trim();
  if (!targetUserId || !targetRichMenuId) {
    return {
      ok: false,
      status: 400,
      errorCode: 'LINE_RICHMENU_INVALID',
      timeout: false,
      elapsedMs: 0,
      attempts: 0
    };
  }

  const endpoint =
    `https://api.line.me/v2/bot/user/${encodeURIComponent(targetUserId)}/richmenu/${encodeURIComponent(targetRichMenuId)}`;
  return callLineApi(env, endpoint, {}, requestId, { retries: 1 });
}

export async function fetchLineBotInfo(env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { response: null, error: new Error('LINE_TOKEN_MISSING'), elapsedMs: 0 };
  }

  const startedAtMs = Date.now();
  const { response, error } = await fetchWithRetry(
    'https://api.line.me/v2/bot/info',
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      }
    },
    {
      timeoutMs: LINE_TIMEOUT_MS,
      retries: 1,
      retryDelayMs: 250,
      shouldRetry: (res, err) => {
        if (err) return true;
        if (!res) return true;
        return res.status === 429 || res.status >= 500;
      }
    }
  );

  return { response, error, elapsedMs: Date.now() - startedAtMs };
}

export async function downloadLineMessageContent(env, messageId, requestId = '') {
  const targetMessageId = String(messageId || '').trim();
  if (!targetMessageId) {
    return {
      ok: false,
      status: 400,
      errorCode: 'LINE_REQUEST_FAILED',
      mimeType: '',
      bytes: 0,
      arrayBuffer: null
    };
  }

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return {
      ok: false,
      status: 500,
      errorCode: 'LINE_TOKEN_MISSING',
      mimeType: '',
      bytes: 0,
      arrayBuffer: null
    };
  }

  const endpoint = `https://api-data.line.me/v2/bot/message/${encodeURIComponent(targetMessageId)}/content`;
  const { response, error } = await fetchWithRetry(
    endpoint,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      }
    },
    {
      timeoutMs: LINE_TIMEOUT_MS,
      retries: 1,
      retryDelayMs: 250,
      shouldRetry: (res, err) => {
        if (err) return true;
        if (!res) return true;
        return res.status === 429 || res.status >= 500;
      }
    }
  );

  if (error || !response) {
    safeLog('line.content', {
      requestId,
      messageId: targetMessageId,
      status: response?.status || null,
      ok: false,
      errorName: error ? String(error?.name || 'fetch_error') : 'fetch_failed'
    });
    return {
      ok: false,
      status: 502,
      errorCode: 'LINE_FETCH_FAILED',
      mimeType: '',
      bytes: 0,
      arrayBuffer: null
    };
  }

  if (!response.ok) {
    safeLog('line.content', {
      requestId,
      messageId: targetMessageId,
      status: response.status,
      ok: false,
      errorName: mapLineErrorCode(response.status)
    });
    return {
      ok: false,
      status: response.status,
      errorCode: mapLineErrorCode(response.status),
      mimeType: String(response.headers.get('content-type') || '').trim(),
      bytes: 0,
      arrayBuffer: null
    };
  }

  const buffer = await response.arrayBuffer();
  const mimeType = String(response.headers.get('content-type') || 'image/jpeg').trim();

  safeLog('line.content', {
    requestId,
    messageId: targetMessageId,
    status: response.status,
    ok: true,
    errorName: ''
  });

  return {
    ok: true,
    status: response.status,
    errorCode: '',
    mimeType,
    bytes: Number(buffer?.byteLength || 0),
    arrayBuffer: buffer
  };
}

async function callLineApi(env, endpoint, payload, requestId = '', options = {}) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, status: 500, errorCode: 'LINE_TOKEN_MISSING', timeout: false, elapsedMs: 0, attempts: 0 };
  }

  const retries = Number(options?.retries ?? 1);
  const timeoutMs = Number(options?.timeoutMs || LINE_TIMEOUT_MS);
  const startedAtMs = Date.now();
  const { response, error, attempts } = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify(payload)
    },
    {
      timeoutMs,
      retries,
      retryDelayMs: 300,
      shouldRetry: (res, err) => {
        if (err) return true;
        if (!res) return true;
        return res.status === 429 || res.status >= 500;
      }
    }
  );

  const elapsedMs = Date.now() - startedAtMs;
  safeLog('line.botinfo', {
    requestId,
    status: response?.status || null,
    elapsedMs,
    errorName: error ? String(error?.name || 'fetch_error') : ''
  });

  if (error || !response) {
    const timeout = String(error?.name || '') === 'AbortError';
    safeLog('line.api', { requestId, endpoint, status: null, elapsedMs, timeout, attempts });
    return {
      ok: false,
      status: 502,
      errorCode: timeout ? 'LINE_TIMEOUT' : 'LINE_FETCH_FAILED',
      timeout,
      elapsedMs,
      attempts
    };
  }

  safeLog('line.api', { requestId, endpoint, status: response.status, elapsedMs, timeout: false, attempts });
  return {
    ok: response.ok,
    status: response.status,
    errorCode: response.ok ? '' : mapLineErrorCode(response.status),
    timeout: false,
    elapsedMs,
    attempts
  };
}

export function mapLineErrorCode(status) {
  if (status === 401 || status === 403) return 'LINE_TOKEN_INVALID';
  if (status >= 500) return 'LINE_UPSTREAM_ERROR';
  if (status >= 400) return 'LINE_REQUEST_FAILED';
  return 'LINE_UNKNOWN_ERROR';
}

export async function verifyLineWebhookSignature(rawBody, channelSecret, headerSignature) {
  if (!channelSecret || !headerSignature || !(rawBody instanceof ArrayBuffer)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', key, rawBody);
  const computed = base64FromArrayBuffer(sigBuffer);
  return safeEqualString(computed, headerSignature);
}

function base64FromArrayBuffer(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
