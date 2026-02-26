function sanitizeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function isValidDateYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeRoundTrip(value) {
  const raw = sanitizeString(value);
  if (raw === '片道' || raw === '往復') return raw;
  if (raw === 'oneway') return '片道';
  if (raw === 'roundtrip') return '往復';
  return raw;
}

function normalizeSubmitMethod(value) {
  const raw = sanitizeString(value).toLowerCase();
  if (!raw) return 'normal';
  if (raw === 'normal' || raw === '通常入力') return 'normal';
  if (raw === 'ic' || raw === 'ic_history' || raw === 'ic履歴') return 'ic_history';
  if (raw === 'bulk' || raw === 'summary' || raw === 'まとめ入力') return 'summary';
  return 'normal';
}

function appendMethodMemo(memo, submitMethod) {
  const cleanMemo = sanitizeString(memo);
  const prefix = `[method:${submitMethod}]`;
  if (!cleanMemo) return prefix;
  if (cleanMemo.includes('[method:')) return cleanMemo;
  return `${prefix} ${cleanMemo}`;
}

export function normalizeTrafficPayload(input) {
  const submitMethod = normalizeSubmitMethod(input?.submitMethod);
  const data = {
    name: sanitizeString(input?.name),
    project: sanitizeString(input?.project),
    workDate: sanitizeString(input?.workDate),
    fromStation: sanitizeString(input?.fromStation),
    toStation: sanitizeString(input?.toStation),
    amount: Number(input?.amount),
    roundTrip: normalizeRoundTrip(input?.roundTrip),
    memo: appendMethodMemo(input?.memo, submitMethod),
    userId: sanitizeString(input?.userId),
    submitMethod
  };

  if (submitMethod === 'summary') {
    if (!data.fromStation) data.fromStation = '複数区間';
    if (!data.toStation) data.toStation = '複数区間';
    if (!data.roundTrip) data.roundTrip = '片道';
  }

  return data;
}

export function validateTrafficPayload(data) {
  const fields = [];

  if (!data.userId) {
    fields.push({ field: 'userId', reason: 'required' });
  }

  if (!data.workDate) {
    fields.push({ field: 'workDate', reason: 'required' });
  } else if (!isValidDateYmd(data.workDate)) {
    fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  }

  if (!data.fromStation) {
    fields.push({ field: 'fromStation', reason: 'required' });
  }

  if (!data.toStation) {
    fields.push({ field: 'toStation', reason: 'required' });
  }

  if (!Number.isFinite(data.amount) || data.amount <= 0) {
    fields.push({ field: 'amount', reason: 'must be number > 0' });
  }

  if (data.roundTrip !== '片道' && data.roundTrip !== '往復') {
    fields.push({ field: 'roundTrip', reason: 'must be "片道" or "往復"' });
  }

  return {
    ok: fields.length === 0,
    details: { fields }
  };
}

export function validateApiKeyAuth(request, env) {
  const apiKey = request.headers.get('x-api-key') || '';
  const ok = Boolean(env.WORKER_API_KEY) && apiKey === env.WORKER_API_KEY;

  return ok
    ? { ok: true, mode: 'api-key' }
    : { ok: false, mode: 'none' };
}

export function sanitizeUserId(userId) {
  return sanitizeString(userId);
}

export function sanitizeRequestId(value) {
  const v = sanitizeString(value);
  if (!v) return '';
  return v.slice(0, 120);
}

export function sanitizeMonth(value) {
  const month = sanitizeString(value);
  if (!/^\d{4}-\d{2}$/.test(month)) return '';
  return month;
}

export function sanitizeDateYmd(value) {
  const ymd = sanitizeString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return ymd;
}
