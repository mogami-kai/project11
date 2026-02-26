import { fetchWithRetry } from '../lib/fetch.js';
import { safeLog } from '../util/redact.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GOOGLE_API_TIMEOUT_MS = 15000;

const TOKEN_CACHE = new Map();

function normalizePrivateKey(raw) {
  let key = String(raw || '').trim();
  if (!key) return '';
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n').trim();
}

function hasGoogleCredentials(env) {
  const email = String(env?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(env?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  return Boolean(email && privateKey);
}

export function validateGoogleEnv(env, required = []) {
  const keys = Array.isArray(required) ? required.slice() : [];
  const missing = [];

  for (const key of keys) {
    if (!String(env?.[key] || '').trim()) missing.push(key);
  }

  if (!hasGoogleCredentials(env)) {
    if (!missing.includes('GOOGLE_SERVICE_ACCOUNT_EMAIL')) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    if (!missing.includes('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')) missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || ''));
}

function pemToArrayBuffer(pem) {
  const clean = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  if (!clean) return null;
  const raw = atob(clean);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out.buffer;
}

async function createServiceAccountJwt(email, privateKeyPem, scopes) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    sub: email,
    aud: GOOGLE_TOKEN_URL,
    scope: scopes.join(' '),
    iat: nowSec - 30,
    exp: nowSec + 3600
  };

  const encodedHeader = toBase64Url(utf8Bytes(JSON.stringify(header)));
  const encodedPayload = toBase64Url(utf8Bytes(JSON.stringify(payload)));
  const toSign = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  if (!keyData) {
    throw new Error('GOOGLE_PRIVATE_KEY_PARSE_FAILED');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, utf8Bytes(toSign));
  const encodedSig = toBase64Url(new Uint8Array(sig));
  return `${toSign}.${encodedSig}`;
}

async function fetchGoogleAccessToken(env, scopes, requestId = '') {
  const email = String(env?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(env?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const sortedScopes = Array.from(new Set(scopes)).sort();
  const cacheKey = `${email}::${sortedScopes.join(' ')}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAtMs > now + 60000) {
    return { ok: true, accessToken: cached.accessToken };
  }

  let assertion = '';
  try {
    assertion = await createServiceAccountJwt(email, privateKey, sortedScopes);
  } catch (error) {
    safeLog('google.auth', {
      requestId,
      status: null,
      ok: false,
      reason: String(error?.message || error)
    });
    return { ok: false, code: 'GOOGLE_AUTH_JWT_FAILED', message: 'Failed to build Google JWT.' };
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  body.set('assertion', assertion);

  const { response, error } = await fetchWithRetry(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    {
      timeoutMs: GOOGLE_API_TIMEOUT_MS,
      retries: 1,
      retryDelayMs: 250
    }
  );

  if (error || !response) {
    safeLog('google.auth', {
      requestId,
      status: response?.status || null,
      ok: false,
      reason: error ? String(error?.name || 'fetch_error') : 'token_fetch_failed'
    });
    return { ok: false, code: 'GOOGLE_AUTH_FAILED', message: 'Google auth token fetch failed.' };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.access_token) {
    safeLog('google.auth', {
      requestId,
      status: response.status,
      ok: false,
      reason: payload?.error || payload?.error_description || 'token_rejected'
    });
    return {
      ok: false,
      code: 'GOOGLE_AUTH_REJECTED',
      message: 'Google auth token rejected.',
      status: response.status,
      details: payload || {}
    };
  }

  const expiresInSec = Number(payload.expires_in || 3600);
  TOKEN_CACHE.set(cacheKey, {
    accessToken: String(payload.access_token),
    expiresAtMs: now + Math.max(300, expiresInSec) * 1000
  });

  safeLog('google.auth', {
    requestId,
    status: response.status,
    ok: true,
    reason: ''
  });

  return {
    ok: true,
    accessToken: String(payload.access_token)
  };
}

async function googleJsonRequest(env, options = {}) {
  const {
    method = 'GET',
    url,
    body,
    requestId = '',
    scopes = [GOOGLE_SHEETS_SCOPE],
    retries = 1,
    timeoutMs = GOOGLE_API_TIMEOUT_MS
  } = options;

  const auth = await fetchGoogleAccessToken(env, scopes, requestId);
  if (!auth.ok) {
    return {
      ok: false,
      code: auth.code || 'GOOGLE_AUTH_FAILED',
      message: auth.message || 'Google auth failed.',
      status: auth.status || 502,
      details: auth.details || {}
    };
  }

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const { response, error } = await fetchWithRetry(
    url,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    {
      timeoutMs,
      retries,
      retryDelayMs: 250,
      shouldRetry: (res, err) => {
        if (err) return true;
        if (!res) return true;
        return res.status === 429 || res.status >= 500;
      }
    }
  );

  if (error || !response) {
    safeLog('google.api', {
      requestId,
      method,
      url,
      status: response?.status || null,
      ok: false,
      reason: error ? String(error?.name || 'fetch_error') : 'upstream_failed'
    });
    return {
      ok: false,
      code: 'GOOGLE_API_FAILED',
      message: 'Google API request failed.',
      status: 502,
      details: { reason: error ? String(error?.name || 'fetch_error') : 'upstream_failed' }
    };
  }

  let jsonData = null;
  try {
    jsonData = await response.json();
  } catch {
    jsonData = null;
  }

  safeLog('google.api', {
    requestId,
    method,
    url,
    status: response.status,
    ok: response.ok,
    reason: response.ok ? '' : (jsonData?.error?.message || 'request_failed')
  });

  if (!response.ok) {
    return {
      ok: false,
      code: 'GOOGLE_API_REJECTED',
      message: 'Google API rejected request.',
      status: response.status,
      details: jsonData || {}
    };
  }

  return {
    ok: true,
    status: response.status,
    data: jsonData || {}
  };
}

function escapeSheetName(sheetName) {
  const raw = String(sheetName || '').trim();
  const escaped = raw.replace(/'/g, "''");
  return `'${escaped}'`;
}

function rangeA1(sheetName, cellRange) {
  return `${escapeSheetName(sheetName)}!${cellRange}`;
}

function colToA1(colNumber) {
  let n = Number(colNumber);
  if (!Number.isFinite(n) || n < 1) return 'A';
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function getGoogleSpreadsheetId(env) {
  const fromGoogle = String(env.GOOGLE_SPREADSHEET_ID || '').trim();
  if (fromGoogle) return fromGoogle;
  return String(env.SPREADSHEET_ID || '').trim();
}

export function parseUpdatedRangeRowNumber(updatedRange) {
  const text = String(updatedRange || '').trim();
  const m = text.match(/!(?:[A-Z]+)(\d+):/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

export async function getSpreadsheetMetadata(env, spreadsheetId, requestId = '') {
  const fields = encodeURIComponent('spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${fields}`;
  return googleJsonRequest(env, {
    method: 'GET',
    url,
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE]
  });
}

export async function readSheetValues(env, spreadsheetId, sheetName, a1Range = 'A:ZZ', requestId = '') {
  const range = encodeURIComponent(rangeA1(sheetName, a1Range));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS`;
  return googleJsonRequest(env, {
    method: 'GET',
    url,
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE]
  });
}

export async function updateSheetValues(env, spreadsheetId, sheetName, startCell, values, requestId = '') {
  const range = encodeURIComponent(rangeA1(sheetName, startCell));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`;
  return googleJsonRequest(env, {
    method: 'PUT',
    url,
    body: {
      range: rangeA1(sheetName, startCell),
      majorDimension: 'ROWS',
      values: Array.isArray(values) ? values : []
    },
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE]
  });
}

export async function appendSheetValues(env, spreadsheetId, sheetName, values, requestId = '') {
  const range = encodeURIComponent(rangeA1(sheetName, 'A1'));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=true`;
  return googleJsonRequest(env, {
    method: 'POST',
    url,
    body: {
      values: Array.isArray(values) ? values : []
    },
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE]
  });
}

export async function batchUpdateSpreadsheet(env, spreadsheetId, requests, requestId = '') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  return googleJsonRequest(env, {
    method: 'POST',
    url,
    body: {
      requests: Array.isArray(requests) ? requests : []
    },
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE]
  });
}

export async function ensureSheetWithHeaders(env, spreadsheetId, sheetName, headers, requestId = '') {
  const desiredHeaders = Array.isArray(headers)
    ? headers.map((h) => String(h || '').trim()).filter(Boolean)
    : [];

  if (desiredHeaders.length === 0) {
    return {
      ok: false,
      code: 'E_VALIDATION',
      message: 'Headers are required.',
      status: 400,
      details: { sheetName }
    };
  }

  const meta = await getSpreadsheetMetadata(env, spreadsheetId, requestId);
  if (!meta.ok) return meta;

  const sheets = Array.isArray(meta.data?.sheets) ? meta.data.sheets : [];
  const exists = sheets.some((sheet) => String(sheet?.properties?.title || '').trim() === sheetName);

  if (!exists) {
    const created = await batchUpdateSpreadsheet(env, spreadsheetId, [
      {
        addSheet: {
          properties: {
            title: sheetName
          }
        }
      }
    ], requestId);
    if (!created.ok) return created;
  }

  const firstRow = await readSheetValues(env, spreadsheetId, sheetName, '1:1', requestId);
  if (!firstRow.ok) return firstRow;

  const existing = Array.isArray(firstRow.data?.values?.[0])
    ? firstRow.data.values[0].map((v) => String(v || '').trim())
    : [];

  const nonEmptyCount = existing.filter(Boolean).length;
  if (nonEmptyCount === 0) {
    return updateSheetValues(env, spreadsheetId, sheetName, 'A1', [desiredHeaders], requestId);
  }

  const existingSet = new Set(existing.map((h) => h.toLowerCase()));
  const missing = desiredHeaders.filter((h) => !existingSet.has(h.toLowerCase()));
  if (missing.length === 0) {
    return {
      ok: true,
      status: 200,
      data: {
        ensured: true,
        appendedHeaders: 0
      }
    };
  }

  const startCol = existing.length + 1;
  const startCell = `${colToA1(startCol)}1`;
  return updateSheetValues(env, spreadsheetId, sheetName, startCell, [missing], requestId);
}

export async function createSpreadsheetWithTabs(env, title, tabNames, requestId = '') {
  const tabs = Array.isArray(tabNames) ? tabNames.map((t) => String(t || '').trim()).filter(Boolean) : [];
  const sheets = tabs.length > 0
    ? tabs.map((tab) => ({ properties: { title: tab } }))
    : [{ properties: { title: 'Sheet1' } }];

  const created = await googleJsonRequest(env, {
    method: 'POST',
    url: 'https://sheets.googleapis.com/v4/spreadsheets',
    body: {
      properties: { title: String(title || 'Monthly_Report') },
      sheets
    },
    requestId,
    scopes: [GOOGLE_SHEETS_SCOPE, GOOGLE_DRIVE_SCOPE]
  });

  if (!created.ok) return created;

  const spreadsheetId = String(created.data?.spreadsheetId || '').trim();
  const spreadsheetUrl = String(created.data?.spreadsheetUrl || '').trim();
  const folderId = String(env.GOOGLE_DRIVE_EXPORT_FOLDER_ID || '').trim();

  if (folderId && spreadsheetId) {
    const moved = await moveDriveFileToFolder(env, spreadsheetId, folderId, requestId);
    if (!moved.ok) {
      safeLog('google.drive.move', {
        requestId,
        ok: false,
        fileId: spreadsheetId,
        folderId,
        status: moved.status || null
      });
    }
  }

  return {
    ok: true,
    status: created.status,
    data: {
      spreadsheetId,
      spreadsheetUrl,
      raw: created.data
    }
  };
}

async function moveDriveFileToFolder(env, fileId, folderId, requestId = '') {
  const targetFileId = String(fileId || '').trim();
  const targetFolderId = String(folderId || '').trim();
  if (!targetFileId || !targetFolderId) {
    return { ok: false, status: 400, code: 'E_VALIDATION', message: 'fileId/folderId required.' };
  }

  const getFile = await googleJsonRequest(env, {
    method: 'GET',
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetFileId)}?fields=id,parents`,
    requestId,
    scopes: [GOOGLE_DRIVE_SCOPE]
  });
  if (!getFile.ok) return getFile;

  const parents = Array.isArray(getFile.data?.parents) ? getFile.data.parents : [];
  const removeParents = parents.filter(Boolean).join(',');
  const query = new URLSearchParams();
  query.set('addParents', targetFolderId);
  if (removeParents) query.set('removeParents', removeParents);
  query.set('fields', 'id,parents,webViewLink');

  return googleJsonRequest(env, {
    method: 'PATCH',
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetFileId)}?${query.toString()}`,
    body: {},
    requestId,
    scopes: [GOOGLE_DRIVE_SCOPE]
  });
}

export const GOOGLE_SCOPES = {
  SHEETS: GOOGLE_SHEETS_SCOPE,
  DRIVE: GOOGLE_DRIVE_SCOPE
};
