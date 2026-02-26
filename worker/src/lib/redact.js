const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-line-signature',
  'cookie',
  'set-cookie',
  'proxy-authorization'
]);

const SENSITIVE_KEY_RE = /(token|secret|authorization|api[-_]?key|cookie|signature|password|passwd|user[-_]?id|line[-_]?user[-_]?id|displayname|full.?name|namekana|kana|phone|tel|address)/i;
const PRESERVE_KEY_RE = /^(requestid|timestamp|status|code|message|path|method|action|event|reason|elapsedms|attempts|retryable|ok)$/i;

function toHeaderEntries(headers) {
  if (!headers) return [];

  if (typeof headers.entries === 'function') {
    return headers.entries();
  }

  if (typeof headers[Symbol.iterator] === 'function') {
    return headers;
  }

  if (typeof headers === 'object') {
    return Object.entries(headers);
  }

  return [];
}

function truncateText(value, maxLen = 200) {
  const text = String(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...[truncated]`;
}

function normalizeKey(key) {
  return String(key || '').replace(/[\s-]/g, '').toLowerCase();
}

function isSensitiveKey(key) {
  if (!key) return false;
  const raw = String(key);
  if (PRESERVE_KEY_RE.test(raw)) return false;
  return SENSITIVE_KEY_RE.test(raw) || SENSITIVE_KEY_RE.test(normalizeKey(raw));
}

function redactScalar(value, keyHint = '') {
  if (value === null || value === undefined) return value;

  if (isSensitiveKey(keyHint)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^bearer\s+/i.test(trimmed)) {
      return 'Bearer [REDACTED]';
    }
    if (trimmed.length > 96 && /^[A-Za-z0-9\-_=:.+/]+$/.test(trimmed)) {
      return '[REDACTED]';
    }
    return truncateText(trimmed);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return truncateText(String(value));
}

function deepRedact(value, keyHint = '', seen = new WeakSet(), depth = 0) {
  if (depth >= 6) return '[TRUNCATED]';

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => deepRedact(item, keyHint, seen, depth + 1));
  }

  if (typeof value !== 'object') {
    return redactScalar(value, keyHint);
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  const output = {};
  const entries = Object.entries(value).slice(0, 80);
  for (const [key, innerValue] of entries) {
    if (isSensitiveKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }

    if (key.toLowerCase() === 'headers') {
      output[key] = redactHeaders(innerValue);
      continue;
    }

    output[key] = deepRedact(innerValue, key, seen, depth + 1);
  }
  return output;
}

export function redactHeaders(headers) {
  const redacted = {};
  try {
    for (const [rawKey, rawValue] of toHeaderEntries(headers)) {
      const key = String(rawKey);
      if (SENSITIVE_HEADERS.has(key.toLowerCase()) || isSensitiveKey(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactScalar(rawValue, key);
      }
    }
  } catch {
    return redacted;
  }
  return redacted;
}

export function redactPayload(value) {
  return deepRedact(value);
}

export function safeLog(label, data) {
  const fallbackRequestId = (() => {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch {
      // ignore
    }
    return `rid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  })();

  const normalized = (!data || typeof data !== 'object' || Array.isArray(data))
    ? { value: data }
    : data;

  const requestId = String(normalized?.requestId || '').trim() || fallbackRequestId;
  const payload = redactPayload({ ...normalized, requestId });

  try {
    console.log(String(label || 'log'), JSON.stringify(payload));
  } catch {
    console.log(String(label || 'log'), '[UNSERIALIZABLE_LOG]');
  }
}
