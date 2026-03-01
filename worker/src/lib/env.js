const GAS_REQUIRED_PATHS = new Set([
  '/api/status',
  '/api/dashboard/month',
  '/api/register/status',
  '/api/register/upsert',
  '/api/unsubmitted',
  '/api/my/week/assignments',
  '/api/traffic/create',
  '/api/expense/create',
  '/api/traffic/ocr-auto',
  '/api/hotel/push',
  '/api/reminder/push',
  '/api/shift/raw/ingest',
  '/api/shift/parse/run',
  '/api/shift/parse/stats',
  '/api/admin/broadcast/preview',
  '/api/admin/broadcast/send',
  '/api/admin/broadcast/retry-failed',
  '/api/slack/command',
  '/api/slack/interactive',
  '/api/admin/shift/raw/recent',
  '/api/_debug/gas'
]);

const ROUTE_ENV_REQUIREMENTS = [
  {
    match: (path) => GAS_REQUIRED_PATHS.has(path),
    required: ['GAS_ENDPOINT', 'STAFF_TOKEN_FOR_GAS']
  },
  {
    match: (path, method) => path === '/webhook' && method === 'POST',
    required: ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'GAS_ENDPOINT', 'STAFF_TOKEN_FOR_GAS']
  },
  {
    match: (path) => path === '/api/hotel/push' || path === '/api/reminder/push',
    required: ['LINE_CHANNEL_ACCESS_TOKEN']
  },
  {
    match: (path) =>
      path === '/api/admin/broadcast/send' ||
      path === '/api/admin/broadcast/retry-failed' ||
      path === '/api/slack/interactive',
    required: ['LINE_CHANNEL_ACCESS_TOKEN']
  },
  {
    match: (path) => path === '/api/slack/command' || path === '/api/slack/events' || path === '/api/slack/interactive',
    required: ['SLACK_SIGNING_SECRET']
  },
  {
    // Gate0.9: CF Access is required for all /api/admin/* routes
    match: (path) => path.startsWith('/api/admin/'),
    required: ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD']
  }
];

const SCHEDULED_ENV_REQUIREMENTS = [
  'GAS_ENDPOINT',
  'STAFF_TOKEN_FOR_GAS',
  'LINE_CHANNEL_ACCESS_TOKEN'
];

function hasValue(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

function firstNonEmptyEnvValue(env, keys) {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const value = String(env?.[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function hasGasToken(env) {
  return hasValue(env?.STAFF_TOKEN_FOR_GAS) || hasValue(env?.STAFF_TOKEN);
}

export function parseAllowedOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function collectMissingEnv(env, requiredKeys) {
  const keys = Array.isArray(requiredKeys) ? requiredKeys : [];
  return keys.filter((key) => !hasValue(env?.[key]));
}

export function validateEnvForRequest(env, path, method) {
  const missing = collectMissingEnv(env, ['ALLOWED_ORIGINS']);
  if (parseAllowedOrigins(env?.ALLOWED_ORIGINS).length === 0 && !missing.includes('ALLOWED_ORIGINS')) {
    missing.push('ALLOWED_ORIGINS');
  }

  for (const rule of ROUTE_ENV_REQUIREMENTS) {
    try {
      if (rule.match(path, method)) {
        missing.push(...collectMissingEnv(env, rule.required));
      }
    } catch {
      // ignore rule evaluation failures
    }
  }

  if (hasGasToken(env)) {
    const idx = missing.indexOf('STAFF_TOKEN_FOR_GAS');
    if (idx >= 0) missing.splice(idx, 1);
  }

  return {
    ok: missing.length === 0,
    missing: Array.from(new Set(missing))
  };
}

export function validateEnvForScheduled(env) {
  const missing = collectMissingEnv(env, SCHEDULED_ENV_REQUIREMENTS);
  if (hasGasToken(env)) {
    const idx = missing.indexOf('STAFF_TOKEN_FOR_GAS');
    if (idx >= 0) missing.splice(idx, 1);
  }
  return {
    ok: missing.length === 0,
    missing
  };
}

// === LIFF env adapter (SoT-first) ===

function pickFirst_(env, keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * screen: "register" | "traffic" | "expense" | "status"
 * SoT-first: LIFF_ID_* then legacy LIFF_ID
 */
export function getLiffId(env, screen) {
  switch (screen) {
    case "register":
      return pickFirst_(env, ["LIFF_ID_REGISTER", "LIFF_ID"]);
    case "traffic":
      return pickFirst_(env, ["LIFF_ID_TRAFFIC", "LIFF_ID"]);
    case "expense":
      return pickFirst_(env, ["LIFF_ID_EXPENSE", "LIFF_ID"]);
    case "status":
      return pickFirst_(env, ["LIFF_ID_STATUS", "LIFF_ID"]);
    default:
      return pickFirst_(env, ["LIFF_ID", "LIFF_ID_TRAFFIC", "LIFF_ID_REGISTER", "LIFF_ID_EXPENSE", "LIFF_ID_STATUS"]);
  }
}

/**
 * SoT-first: LIFF_URL_* then legacy LIFF_*_URL then legacy LIFF_URL
 */
export function getLiffUrl(env, screen) {
  switch (screen) {
    case "register":
      return pickFirst_(env, ["LIFF_URL_REGISTER", "LIFF_REGISTER_URL", "LIFF_URL"]);
    case "traffic":
      return pickFirst_(env, ["LIFF_URL_TRAFFIC", "LIFF_TRAFFIC_URL", "LIFF_URL"]);
    case "expense":
      return pickFirst_(env, ["LIFF_URL_EXPENSE", "LIFF_EXPENSE_URL", "LIFF_URL"]);
    case "status":
      return pickFirst_(env, ["LIFF_URL_STATUS", "LIFF_STATUS_URL", "LIFF_URL"]);
    default:
      return pickFirst_(env, ["LIFF_URL"]);
  }
}

export function getLiffUrls(env) {
  return {
    registerUrl: getLiffUrl(env, "register"),
    trafficUrl: getLiffUrl(env, "traffic"),
    expenseUrl: getLiffUrl(env, "expense"),
    statusUrl: getLiffUrl(env, "status"),
  };
}

/**
 * 互換：既存コードが resolveLiffEnv を呼んでいる場合用
 */
export function resolveLiffEnv(env, screen = "traffic") {
  const liffId = getLiffId(env, screen);
  const urls = getLiffUrls(env);
  const baseUrl = pickFirst_(env, ["LIFF_URL"]); // legacy base

  return { liffId, baseUrl, ...urls };
}
