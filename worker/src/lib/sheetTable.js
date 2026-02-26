function toStringSafe(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function normalizeHeaderKey(value) {
  return toStringSafe(value).toLowerCase().replace(/[\s_\-]/g, '');
}

export function buildTable(values) {
  const matrix = Array.isArray(values) ? values : [];
  if (matrix.length === 0) {
    return {
      headers: [],
      normalizedHeaders: [],
      rows: []
    };
  }

  const headers = Array.isArray(matrix[0]) ? matrix[0].map((h) => toStringSafe(h)) : [];
  const normalizedHeaders = headers.map((h) => normalizeHeaderKey(h));
  const rows = [];

  for (let r = 1; r < matrix.length; r += 1) {
    const rowValues = Array.isArray(matrix[r]) ? matrix[r] : [];
    const row = {};
    for (let c = 0; c < normalizedHeaders.length; c += 1) {
      const key = normalizedHeaders[c];
      if (!key) continue;
      row[key] = rowValues[c];
    }
    rows.push(row);
  }

  return {
    headers,
    normalizedHeaders,
    rows
  };
}

export function getField(row, keys, fallback = '') {
  const rowObj = row && typeof row === 'object' ? row : {};
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    const normalized = normalizeHeaderKey(key);
    if (!normalized) continue;
    if (Object.prototype.hasOwnProperty.call(rowObj, normalized)) {
      const value = rowObj[normalized];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }
  }
  return fallback;
}

export function getStringField(row, keys, fallback = '') {
  const value = getField(row, keys, fallback);
  return toStringSafe(value);
}

export function getNumberField(row, keys, fallback = 0) {
  const raw = getField(row, keys, fallback);
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

export function toYmd(value) {
  const raw = toStringSafe(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isMonth(value) {
  return /^\d{4}-\d{2}$/.test(toStringSafe(value));
}

export function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(toStringSafe(value));
}

export function dayFromYmd(value) {
  const ymd = toYmd(value);
  if (!ymd) return 0;
  const n = Number(ymd.slice(8, 10));
  return Number.isFinite(n) ? n : 0;
}

export function monthFromYmd(value) {
  const ymd = toYmd(value);
  return ymd ? ymd.slice(0, 7) : '';
}

export function ymdFromMonthDay(month, day) {
  const monthText = toStringSafe(month);
  const d = Number(day);
  if (!/^\d{4}-\d{2}$/.test(monthText)) return '';
  if (!Number.isFinite(d) || d < 1 || d > 31) return '';
  return `${monthText}-${String(Math.floor(d)).padStart(2, '0')}`;
}
