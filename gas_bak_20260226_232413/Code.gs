/**
 * Traffic v0 GAS endpoint (rev) — REVISED
 *
 * 改訂サマリ:
 * [P1] buildPlannedByUserFeatureFlagged_: N×シート読込→1回パスに変更
 * [P2] handleHotelIntentSummary_: JSON.parse アンチパターン解消、queryHotelIntentItems_ 抽出
 * [P3] handleShiftParseRun_: ループ内フルスキャン→事前セット構築に変更
 * [P4] トラフィックインデックス: ScriptProperties→CacheService (TTL付き) に移行
 * [P5] handleHotelUserUpsert_: withScriptLock_ 追加
 * [P6] handleTrafficCreate_: withScriptLock_ に統一（tryLock 廃止）
 * [P7] isSensitiveLogKey_: Set ベースに変更（過剰マッチ修正）
 * [P8] doPost: requestId スコープを try 外に移動
 * [P9] parseShiftAllRawText_: 矢印文字を NFKC 正規化してから split
 * [P10] ensureShiftAssignmentsSheet_: ensureHeaderColumnExists_ を一括処理に変更
 * [P11] TRAFFIC_MEMO_COL_: 動的ヘッダー解決ヘルパー追加（ハードコード依存を低減）
 * [P12] Date 書き込み: new Date() 直接渡しを廃止、フォーマット済み文字列に統一
 * [P13] getConfig_: リクエスト内ワンショットキャッシュ追加（PropertiesService 多重呼び出し防止）
 */

const TZ_ = 'Asia/Tokyo';
const SHEET_TRAFFIC_ = 'TRAFFIC_LOG';
const SHEET_TRAFFIC_PAIR_ = 'TRAFFIC_PAIR_LOG';
const SHEET_SHIFT_ = 'SHIFT';
const SHEET_STAFF_ = 'STAFF_MASTER';
const SHEET_SITE_MASTER_ = 'SITE_MASTER';
const SHEET_SHIFT_RAW_ = 'SHIFT_RAW';
const SHEET_HOTEL_INTENT_ = 'HOTEL_INTENT_LOG';
const SHEET_HOTEL_SENT_LOG_ = 'HOTEL_SENT_LOG';
const SHEET_REMINDER_SENT_LOG_ = 'REMINDER_SENT_LOG';
const SHIFT_RAW_PARSER_VERSION_ = 'shift_raw_v1';
const SHIFT_RAW_PARSE_STATUS_STORED_ = 'stored';
const SHIFT_RAW_SOURCE_LINE_WEBHOOK_ = 'line_webhook';
const SHEET_CANONICAL_ALIASES_ = {
  STAFF_MASTER: ['STAFF_MASTER'],
  SITE_MASTER: ['SITE_MASTER'],
  SHIFT_ASSIGNMENTS: ['SHIFT_ASSIGNMENTS', 'SHIFT'],
  HOTEL_REQUESTS: ['HOTEL_REQUESTS', 'HOTEL_INTENT_LOG'],
  TRAFFIC_CLAIMS: ['TRAFFIC_CLAIMS', 'TRAFFIC_LOG'],
  EXPENSE_CLAIMS: ['EXPENSE_CLAIMS'],
  LINE_MESSAGE_LOG: ['LINE_MESSAGE_LOG'],
  ADMIN_ALERTS: ['ADMIN_ALERTS'],
  SYSTEM_CONFIG: ['SYSTEM_CONFIG']
};
const SHEET_CANONICAL_HEADERS_ = {
  // Spec: registration_spec 4 Master Fields / v5_spec 3.1 Staff Master
  STAFF_MASTER: ['userId', 'name', 'project', 'lineUserId', 'status', 'updatedAt', 'fullNameKanji', 'fullNameKana', 'nameKana', 'kana', 'birthDate', 'phone', 'tel', 'emergencyRelation', 'emergencyPhone', 'postalCode', 'nearestStation', 'station', 'address', 'isActive', 'lineFollowStatus', 'updatedBy', 'dataHash', 'aliases'],
  SITE_MASTER: ['siteId', 'projectId', 'workDate', 'siteName', 'siteAddress', 'nearestStations', 'aliases', 'updatedAt'],
  LINE_MESSAGE_LOG: ['logId', 'timestamp', 'requestId', 'channel', 'event', 'lineUserId', 'userId', 'status', 'errorCode', 'payloadJson'],
  ADMIN_ALERTS: ['alertId', 'timestamp', 'requestId', 'severity', 'source', 'event', 'message', 'payloadJson', 'status'],
  SYSTEM_CONFIG: ['configKey', 'configValue', 'updatedAt']
};

// [P11] TRAFFIC_MEMO_COL_ のハードコードは残すが、動的解決ヘルパーで補完する
// 列順変更時は resolveTrafficMemoColIndex_ が優先される
const TRAFFIC_MEMO_COL_FALLBACK_ = 10;
const TRAFFIC_REQUEST_MEMO_PREFIX_ = '[requestId:';
const TRAFFIC_REQUEST_MEMO_SUFFIX_ = ']';
// [P4] CacheService 用プレフィックス（ScriptProperties から移行）
const TRAFFIC_REQUEST_CACHE_PREFIX_ = 'trc:';
const TRAFFIC_REQUEST_CACHE_TTL_SEC_ = 3600;

// [P13] リクエスト内キャッシュ（GAS は実行ごとに初期化されるのでリクエスト内のみ有効）
let CONFIG_REQUEST_CACHE_ = null;
const REGISTRATION_REQUIRED_FIELDS_ = ['nameKanji', 'nameKana', 'birthDate', 'nearestStation', 'phone', 'emergencyRelation', 'emergencyPhone', 'postalCode', 'address'];

/* =========================================================
 * Entry point
 * =======================================================*/

// [P8] requestId を try 外スコープへ移動
function doPost(e) {
  const fallbackRequestId = Utilities.getUuid();
  let requestId = fallbackRequestId; // ← スコープを外に出す
  try {
    const bodyText = getRequestBodyText_(e);
    if (!bodyText) {
      return errorResponse_('E_EMPTY_BODY', 'Request body is empty.', {}, requestId);
    }
    let req;
    try {
      req = JSON.parse(bodyText);
    } catch (err) {
      return errorResponse_('E_INVALID_JSON', 'Invalid JSON format.', { reason: String(err && err.message ? err.message : err) }, requestId);
    }
    // [P8] 確定した requestId を上書き
    requestId = sanitizeString_(req.requestId) || fallbackRequestId;
    const envVal = validateEnvelope_(req);
    if (!envVal.ok) {
      return errorResponse_(envVal.code, envVal.message, envVal.details || {}, requestId);
    }
    const cfg = getConfig_();
    if (!cfg.ok) {
      return errorResponse_(cfg.code, cfg.message, cfg.details || {}, requestId);
    }
    if (sanitizeString_(req.token) !== sanitizeString_(cfg.values.STAFF_TOKEN)) {
      return errorResponse_('E_UNAUTHORIZED', 'Invalid token.', {}, requestId);
    }
    const ss = SpreadsheetApp.openById(cfg.values.SPREADSHEET_ID);
    switch (req.action) {
      case 'traffic.create':        return handleTrafficCreate_(ss, req.data, requestId);
      case 'traffic.setPair':       return handleTrafficSetPair_(ss, req.data, requestId);
      case 'status.get':            return handleStatusGet_(ss, req.data, requestId);
      case 'site.getByDate':        return handleSiteGetByDate_(ss, req.data, requestId);
      case 'site.profile.get':      return handleSiteProfileGet_(ss, req.data, requestId);
      case 'unsubmitted.list':      return handleUnsubmittedList_(ss, req.data, requestId);
      case 'hotel.intent.submit':   return handleHotelIntentSubmit_(ss, req.data, requestId);
      case 'hotel.intent.list':     return handleHotelIntentList_(ss, req.data, requestId);
      case 'hotel.intent.summary':  return handleHotelIntentSummary_(ss, req.data, requestId);
      case 'hotel.intent.targets':  return handleHotelIntentTargets_(ss, req.data, requestId);
      case 'hotel.user.upsert':     return handleHotelUserUpsert_(ss, req.data, requestId);
      case 'reminder.targets':      return handleReminderTargets_(ss, req.data, requestId);
      case 'hotel.sendGuard':       return handleHotelSendGuard_(ss, req.data, requestId);
      case 'reminder.sendGuard':    return handleReminderSendGuard_(ss, req.data, requestId);
      case 'ops.log':               return handleOpsLog_(ss, req.data, requestId);
      case 'staff.register.lock':   return handleStaffRegisterLock_(ss, req.data, requestId);
      case 'staff.register.status': return handleStaffRegisterStatus_(ss, req.data, requestId);
      case 'staff.register.upsert': return handleStaffRegisterUpsert_(ss, req.data, requestId);
      case 'shift.raw.ingest':      return handleShiftRawIngest_(ss, req.data, requestId);
      case 'shift.raw.recent':      return handleShiftRawRecent_(ss, req.data, requestId);
      case 'shift.parse.run':       return handleShiftParseRun_(ss, req.data, requestId);
      case 'shift.parse.stats':     return handleShiftParseStats_(ss, requestId);
      default:
        return errorResponse_('E_UNSUPPORTED_ACTION', 'Unsupported action.', { action: req.action }, requestId);
    }
  } catch (errTop) {
    // [P8] requestId が確定済みならそれを使う
    return errorResponse_(
      'E_INTERNAL',
      'Internal server error.',
      { reason: String(errTop && errTop.message ? errTop.message : errTop) },
      requestId,
      true
    );
  }
}

/* =========================================================
 * Actions
 * =======================================================*/

// [P6] withScriptLock_ に統一（tryLock → waitLock）
function handleTrafficCreate_(ss, data, requestId) {
  const validation = validateTrafficData_(data);
  if (!validation.ok) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', validation.details, requestId);
  }
  return withScriptLock_(requestId, function() {
    try {
      const sheet = ss.getSheetByName(SHEET_TRAFFIC_);
      if (!sheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet TRAFFIC_LOG not found.', {}, requestId);

      // [P4] CacheService ベースのインデックスで高速dedup
      const indexedRow = getTrafficRowByRequestIndex_(sheet, requestId);
      if (indexedRow > 0) {
        Logger.log('traffic.create dedup hit(index): requestId=' + requestId + ', row=' + indexedRow);
        return okResponse_({ id: requestId, row: indexedRow, dedup: true }, requestId);
      }
      const existingRow = findTrafficRowByRequestId_(sheet, requestId);
      if (existingRow > 0) {
        setTrafficRequestIndex_(requestId, existingRow);
        Logger.log('traffic.create dedup hit(scan): requestId=' + requestId + ', row=' + existingRow);
        return okResponse_({ id: requestId, row: existingRow, dedup: true }, requestId);
      }

      const memoWithRequestId = buildTrafficMemoWithRequestId_(sanitizeString_(data.memo), requestId);
      // [P12] Date 書き込みはフォーマット済み文字列で
      const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
      const row = [
        nowStr,
        sanitizeString_(data.userId),
        sanitizeString_(data.name),
        sanitizeString_(data.project),
        sanitizeString_(data.workDate),
        sanitizeString_(data.fromStation),
        sanitizeString_(data.toStation),
        Number(data.amount),
        sanitizeString_(data.roundTrip),
        memoWithRequestId
      ];
      appendRowSanitized_(sheet, row);
      const appendedRow = sheet.getLastRow();
      setTrafficRequestIndex_(requestId, appendedRow);
      return okResponse_({ id: Utilities.getUuid(), row: appendedRow, dedup: false }, requestId);
    } catch (err) {
      return errorResponse_(
        'E_APPEND_FAILED',
        'Failed to append row.',
        { reason: String(err && err.message ? err.message : err) },
        requestId,
        true
      );
    }
  });
}

/**
 * shift.raw.ingest
 */
function handleShiftRawIngest_(ss, data, requestId) {
  const rawMessageId = sanitizeString_(data && data.rawMessageId);
  const rawText = sanitizeString_(data && data.rawText);
  const lineUserId = sanitizeString_(data && data.lineUserId);
  const lineGroupId = sanitizeString_(data && data.lineGroupId);
  const fields = [];
  if (!rawMessageId) fields.push({ field: 'rawMessageId', reason: 'required' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    try {
      const sheet = ensureShiftRawSheet_(ss);
      const existingRow = findShiftRawRowByMessageId_(sheet, rawMessageId);
      if (existingRow > 0) {
        return okResponse_({ stored: false, rawMessageId: rawMessageId, reason: 'duplicate' }, requestId);
      }
      // [P12] フォーマット済み文字列
      const timestamp = Utilities.formatDate(new Date(), TZ_, "yyyy-MM-dd'T'HH:mm:ss'+09:00'");
      appendRowSanitized_(sheet, [
        rawMessageId,
        timestamp,
        SHIFT_RAW_SOURCE_LINE_WEBHOOK_,
        lineGroupId,
        lineUserId,
        rawText,
        SHIFT_RAW_PARSER_VERSION_,
        SHIFT_RAW_PARSE_STATUS_STORED_,
        '',
        requestId
      ]);
      return okResponse_({ stored: true, rawMessageId: rawMessageId, reason: 'stored' }, requestId);
    } catch (err) {
      return errorResponse_(
        'E_SHIFT_RAW_INGEST_FAILED',
        'Failed to ingest shift raw text.',
        { reason: String(err && err.message ? err.message : err) },
        requestId,
        true
      );
    }
  });
}

/**
 * shift.raw.recent
 */
function handleShiftRawRecent_(ss, data, requestId) {
  const rawLimit = Number(data && data.limit);
  const limit = normalizeShiftRawRecentLimit_(rawLimit);
  const sheet = ensureShiftRawSheet_(ss);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) {
    return okResponse_({ items: [], limit: limit }, requestId);
  }
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxRawMessageId = indexOfHeader_(headers, ['rawmessageid', 'raw_message_id']);
  const idxTimestamp    = indexOfHeader_(headers, ['timestamp']);
  const idxLineGroupId  = indexOfHeader_(headers, ['linegroupid', 'line_group_id']);
  const idxLineUserId   = indexOfHeader_(headers, ['lineuserid', 'line_user_id']);
  const idxRawText      = indexOfHeader_(headers, ['rawtext', 'raw_text']);
  const idxParseStatus  = indexOfHeader_(headers, ['parsestatus', 'parse_status']);
  const idxError        = indexOfHeader_(headers, ['error']);
  const dataCount = lastRow - 1;
  const take = Math.min(limit, dataCount);
  const startRow = lastRow - take + 1;
  const tailValues = sheet.getRange(startRow, 1, take, lastCol).getValues();
  const items = [];
  for (let i = tailValues.length - 1; i >= 0; i--) {
    const row = tailValues[i];
    items.push({
      rawMessageId: idxRawMessageId >= 0 ? sanitizeString_(row[idxRawMessageId]) : '',
      timestamp:    idxTimestamp    >= 0 ? sanitizeString_(row[idxTimestamp])    : '',
      lineGroupId:  idxLineGroupId  >= 0 ? sanitizeString_(row[idxLineGroupId])  : '',
      lineUserId:   idxLineUserId   >= 0 ? sanitizeString_(row[idxLineUserId])   : '',
      parseStatus:  idxParseStatus  >= 0 ? sanitizeString_(row[idxParseStatus])  : '',
      error:        idxError        >= 0 ? sanitizeString_(row[idxError])        : '',
      textPreview:  buildShiftRawTextPreview_(idxRawText >= 0 ? row[idxRawText] : '')
    });
  }
  return okResponse_({ items: items, limit: limit }, requestId);
}

/**
 * shift.parse.run
 */
function handleShiftParseRun_(ss, data, requestId) {
  const rawMessageId  = sanitizeString_(data && data.rawMessageId);
  const limit         = normalizeShiftParseRunLimit_(Number(data && data.limit));
  const includeErrors = normalizeBooleanInput_(data && data.includeErrors);

  const rawSheet        = ensureShiftRawSheet_(ss);
  const assignmentSheet = ensureShiftAssignmentsSheet_(ss);
  const staffMasterIndex = buildStaffMasterIndex_(ss.getSheetByName(SHEET_STAFF_));
  const siteMasterIndex  = buildSiteMasterIndex_(ss.getSheetByName(SHEET_SITE_MASTER_));

  const idx = getShiftRawIndexMap_(rawSheet);
  if (!idx.ok) {
    return errorResponse_('E_VALIDATION', 'SHIFT_RAW headers are missing required fields.', { required: ['rawMessageId','rawText','parserVersion','parseStatus','error'] }, requestId);
  }

  const targets = listShiftRawParseTargets_(rawSheet, idx.map, rawMessageId, limit, includeErrors);

  // [P3] ループに入る前に既存 rawMessageId セットを一括構築
  const existingRawMessageIdSet = buildExistingRawMessageIdSet_(assignmentSheet);

  const summary = {
    requestedRawMessageId: rawMessageId || '',
    limit:                 limit,
    includeErrors:         includeErrors,
    targetCount:           targets.length,
    parsed:                0,
    skipped:               0,
    errored:               0,
    assignmentInserted:    0,
    details:               []
  };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const detail = { rawMessageId: t.rawMessageId, row: t.row, status: '', inserted: 0, reason: '' };
    try {
      // [P3] Set 参照（O(1)）
      if (existingRawMessageIdSet[t.rawMessageId]) {
        updateShiftRawParseState_(rawSheet, idx.map, t.row, 'parsed', '');
        detail.status = 'skipped';
        detail.reason = 'assignments_already_exist';
        summary.skipped += 1;
        summary.details.push(detail);
        continue;
      }
      const parsed  = parseShiftAllRawText_(t.rawText);
      const records = buildShiftAssignmentsFromParsed_(t, parsed, staffMasterIndex, siteMasterIndex);
      if (records.length === 0) {
        const reason = resolveParseFailureReason_(parsed);
        updateShiftRawParseState_(rawSheet, idx.map, t.row, 'error', reason);
        detail.status = 'error';
        detail.reason = reason;
        summary.errored += 1;
        summary.details.push(detail);
        continue;
      }
      appendShiftAssignmentsRows_(assignmentSheet, records);
      // 追加した分をセットに反映（同一バッチ内の重複を防ぐ）
      existingRawMessageIdSet[t.rawMessageId] = true;
      updateShiftRawParseState_(rawSheet, idx.map, t.row, 'parsed', '');
      detail.status = 'parsed';
      detail.inserted = records.length;
      summary.assignmentInserted += records.length;
      summary.parsed += 1;
      summary.details.push(detail);
    } catch (err) {
      const reason = String(err && err.message ? err.message : err);
      updateShiftRawParseState_(rawSheet, idx.map, t.row, 'error', reason);
      detail.status = 'error';
      detail.reason = reason;
      summary.errored += 1;
      summary.details.push(detail);
    }
  }
  return okResponse_(summary, requestId);
}

/**
 * [P3] SHIFT_ASSIGNMENTS に存在する rawMessageId を Set として返す
 */
function buildExistingRawMessageIdSet_(sheet) {
  const set = {};
  if (!sheet) return set;
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return set;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxRawMessageId = indexOfHeader_(headers, ['rawmessageid', 'raw_message_id']);
  if (idxRawMessageId < 0) return set;
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = sanitizeString_(values[i][idxRawMessageId]);
    if (v) set[v] = true;
  }
  return set;
}

/**
 * shift.parse.stats
 */
function handleShiftParseStats_(ss, requestId) {
  const sheet = ensureShiftRawSheet_(ss);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const stats = { total: 0, stored: 0, parsed: 0, error: 0 };
  if (lastRow <= 1 || lastCol <= 0) {
    return okResponse_(stats, requestId);
  }
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxParseStatus = indexOfHeader_(headers, ['parsestatus', 'parse_status']);
  if (idxParseStatus < 0) {
    return errorResponse_('E_VALIDATION', 'SHIFT_RAW headers are missing parseStatus.', { required: ['parseStatus'] }, requestId);
  }
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  stats.total = values.length;
  for (let i = 0; i < values.length; i++) {
    const status = sanitizeString_(values[i][idxParseStatus]).toLowerCase();
    if (status === 'stored')      stats.stored  += 1;
    else if (status === 'parsed') stats.parsed  += 1;
    else if (status === 'error')  stats.error   += 1;
  }
  return okResponse_(stats, requestId);
}

function normalizeShiftParseRunLimit_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

function normalizeBooleanInput_(value) {
  if (value === true || value === false) return value;
  const s = sanitizeString_(value).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function getShiftRawIndexMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) return { ok: false, map: {} };
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const map = {
    rawMessageId:  indexOfHeader_(headers, ['rawmessageid',  'raw_message_id']),
    rawText:       indexOfHeader_(headers, ['rawtext',       'raw_text']),
    parserVersion: indexOfHeader_(headers, ['parserversion', 'parser_version']),
    parseStatus:   indexOfHeader_(headers, ['parsestatus',   'parse_status']),
    error:         indexOfHeader_(headers, ['error'])
  };
  const ok = map.rawMessageId >= 0 && map.rawText >= 0 && map.parserVersion >= 0 && map.parseStatus >= 0 && map.error >= 0;
  return { ok: ok, map: map };
}

function listShiftRawParseTargets_(sheet, idx, rawMessageId, limit, includeErrors) {
  const out = [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return out;
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    const rowRawMessageId = sanitizeString_(row[idx.rawMessageId]);
    if (!rowRawMessageId) continue;
    if (rawMessageId && rowRawMessageId !== rawMessageId) continue;
    const rowStatus = sanitizeString_(row[idx.parseStatus]).toLowerCase();
    if (rowStatus !== 'stored' && !(includeErrors && rowStatus === 'error')) continue;
    out.push({
      row:           i + 2,
      rawMessageId:  rowRawMessageId,
      rawText:       sanitizeString_(row[idx.rawText]),
      parserVersion: sanitizeString_(row[idx.parserVersion]) || SHIFT_RAW_PARSER_VERSION_
    });
    if (!rawMessageId && out.length >= limit) break;
  }
  return out;
}

function updateShiftRawParseState_(sheet, idx, rowNumber, parseStatus, errorText) {
  setRangeValueSanitized_(sheet.getRange(rowNumber, idx.parseStatus + 1, 1, 1), parseStatus);
  setRangeValueSanitized_(sheet.getRange(rowNumber, idx.error + 1, 1, 1), sanitizeString_(errorText));
}

// [P3] hasShiftAssignmentsForRawMessage_ は buildExistingRawMessageIdSet_ に置き換えられたが
// 他から呼ばれる可能性に備えて残す（内部は Set ベースに変更）
function hasShiftAssignmentsForRawMessage_(sheet, rawMessageId) {
  const target = sanitizeString_(rawMessageId);
  if (!target) return false;
  return buildExistingRawMessageIdSet_(sheet)[target] === true;
}

function buildShiftAssignmentsFromParsed_(target, parsedResult, staffMasterIndex, siteMasterIndex) {
  const records = [];
  const blocks = Array.isArray(parsedResult && parsedResult.blocks) ? parsedResult.blocks : [];
  for (let b = 0; b < blocks.length; b++) {
    const block   = blocks[b];
    const siteRaw = sanitizeString_(block && block.siteRaw);
    const siteFrom = toDayOrNull_(block && block.periodFromDay);
    const siteTo   = toDayOrNull_(block && block.periodToDay);
    if (!siteRaw || siteFrom === null || siteTo === null) continue;
    const lines = Array.isArray(block && block.lines) ? block.lines : [];
    for (let l = 0; l < lines.length; l++) {
      const line    = lines[l];
      const rawLine = Number(line && line.rawLine ? line.rawLine : 0);
      const text    = String(line && line.lineText ? line.lineText : '').trim();
      if (!text) continue;
      const roleMatch = text.match(/^(DL|CL|CA)\s*[:：]\s*(.+)$/);
      if (!roleMatch) continue;
      const role = String(roleMatch[1] || '').trim();
      const body = String(roleMatch[2] || '').replace(/\s*→\s*/g, '→').trim();
      if (body.trim().includes('調整中')) {
        records.push(buildShiftAssignmentRecord_({
          rawMessageId: target.rawMessageId,
          rawLine, parserVersion: target.parserVersion,
          siteRaw, siteFrom, siteTo, role,
          segmentFromDay: siteFrom, segmentToDay: siteTo,
          staffNameRaw: '', staffKanaRaw: '', status: 'adjusting', index: 0,
          staffMasterIndex, siteMasterIndex
        }));
        continue;
      }
      // [P9] 矢印の正規化（→ U+2192 / →全角 U+FF1E などを統一）
      const normalizedBody = normalizeArrows_(body);
      const segments = normalizedBody.split('→').map(function(v) { return String(v || '').trim(); }).filter(Boolean);
      for (let s = 0; s < segments.length; s++) {
        const seg      = segments[s];
        const dayMatch = seg.match(/^\s*(\d{1,2})\s*日/);
        const segDay   = dayMatch ? toDayOrNull_(dayMatch[1]) : null;
        const segFrom  = segDay !== null ? segDay : siteFrom;
        const segTo    = segDay !== null ? segDay : siteTo;
        const nameBase = seg.replace(/(\d{1,2})日/g, '').replace(/^[\s　\-:：]+|[\s　\-:：]+$/g, '').trim();
        const nameParsed = parseStaffNameKana_(nameBase);
        records.push(buildShiftAssignmentRecord_({
          rawMessageId: target.rawMessageId,
          rawLine, parserVersion: target.parserVersion,
          siteRaw, siteFrom, siteTo, role,
          segmentFromDay: segFrom, segmentToDay: segTo,
          staffNameRaw: nameParsed.staffNameRaw, staffKanaRaw: nameParsed.staffKanaRaw,
          status: 'assigned', index: s,
          staffMasterIndex, siteMasterIndex
        }));
      }
    }
  }
  return records;
}

/**
 * [P9] 矢印文字の正規化
 */
function normalizeArrows_(text) {
  return sanitizeString_(text)
    .replace(/[→＞⇒➡►▶]/g, '→'); // 全角・その他矢印を U+2192 に統一
}

function buildShiftAssignmentRecord_(input) {
  const rawMessageId = sanitizeString_(input.rawMessageId);
  const rawLine      = Number(input.rawLine || 0);
  const role         = sanitizeString_(input.role);
  const segFrom      = toDayOrNull_(input.segmentFromDay);
  const segTo        = toDayOrNull_(input.segmentToDay);
  const index        = Number(input.index || 0);
  const assignmentId = [rawMessageId, rawLine, role, segFrom === null ? '' : segFrom, segTo === null ? '' : segTo, index].join(':');
  const staffNameRaw = sanitizeString_(input.staffNameRaw);
  const matchedUserId = matchStaffUserId_(staffNameRaw, input.staffMasterIndex);
  const siteRaw      = sanitizeString_(input.siteRaw);
  const siteMatched  = matchSiteId_(siteRaw, input.siteMasterIndex);
  return {
    assignmentId,
    rawMessageId,
    userId:           matchedUserId,
    rawLine,
    parserVersion:    sanitizeString_(input.parserVersion) || SHIFT_RAW_PARSER_VERSION_,
    siteId:           siteMatched.siteId,
    siteNameNorm:     siteMatched.siteNameNorm,
    siteRaw,
    sitePeriodFromDay: toDayOrNull_(input.siteFrom),
    sitePeriodToDay:   toDayOrNull_(input.siteTo),
    role,
    segmentFromDay:    segFrom,
    segmentToDay:      segTo,
    staffNameRaw,
    staffKanaRaw:      sanitizeString_(input.staffKanaRaw),
    status:            sanitizeString_(input.status) || 'assigned',
    createdAt:         Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss') // [P12]
  };
}

function appendShiftAssignmentsRows_(sheet, records) {
  if (!records || records.length === 0) return;
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const rows = records.map(function(r) {
    const row = new Array(lastCol).fill('');
    setValueByHeader_(row, headers, 'assignmentid',      r.assignmentId);
    setValueByHeader_(row, headers, 'rawmessageid',      r.rawMessageId);
    setValueByHeader_(row, headers, 'userid',            r.userId);
    setValueByHeader_(row, headers, 'rawline',           r.rawLine);
    setValueByHeader_(row, headers, 'parserversion',     r.parserVersion);
    setValueByHeader_(row, headers, 'siteid',            r.siteId);
    setValueByHeader_(row, headers, 'sitenamenorm',      r.siteNameNorm);
    setValueByHeader_(row, headers, 'siteraw',           r.siteRaw);
    setValueByHeader_(row, headers, 'siteperiodfromday', r.sitePeriodFromDay);
    setValueByHeader_(row, headers, 'siteperiodtoday',   r.sitePeriodToDay);
    setValueByHeader_(row, headers, 'role',              r.role);
    setValueByHeader_(row, headers, 'segmentfromday',    r.segmentFromDay);
    setValueByHeader_(row, headers, 'segmenttoday',      r.segmentToDay);
    setValueByHeader_(row, headers, 'staffnameraw',      r.staffNameRaw);
    setValueByHeader_(row, headers, 'staffkanaraw',      r.staffKanaRaw);
    setValueByHeader_(row, headers, 'status',            r.status);
    setValueByHeader_(row, headers, 'createdat',         r.createdAt);
    return row;
  });
  setRangeValuesSanitized_(sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, lastCol), rows);
}

function setValueByHeader_(row, headers, headerKey, value) {
  const idx = headers.indexOf(headerKey);
  if (idx < 0) return;
  row[idx] = value === null || value === undefined ? '' : value;
}

function buildStaffMasterIndex_(staffSheet) {
  const byName = {};
  if (!staffSheet) return { byName };
  const table = readTable_(staffSheet);
  if (!table.ok || !table.values || table.values.length <= 1) return { byName };
  if (table.idx.userid < 0) return { byName };
  const headers    = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxAliases = indexOfHeader_(headers, ['aliases', 'alias']);
  const idxFullNameKanji = indexOfHeader_(headers, ['fullnamekanji', 'full_name_kanji']);
  const idxFullNameKana  = indexOfHeader_(headers, ['fullnamekana', 'full_name_kana']);
  const idxNameKana      = indexOfHeader_(headers, ['namekana', 'kana']);
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row    = values[r];
    const userId = sanitizeString_(row[table.idx.userid]);
    if (!userId) continue;
    addStaffMasterIndexName_(byName, table.idx.name >= 0 ? sanitizeString_(row[table.idx.name]) : '', userId);
    if (idxFullNameKanji >= 0) addStaffMasterIndexName_(byName, sanitizeString_(row[idxFullNameKanji]), userId);
    if (idxFullNameKana  >= 0) addStaffMasterIndexName_(byName, sanitizeString_(row[idxFullNameKana]), userId);
    if (idxNameKana      >= 0) addStaffMasterIndexName_(byName, sanitizeString_(row[idxNameKana]), userId);
    if (idxAliases >= 0) {
      const aliasesRaw = sanitizeString_(row[idxAliases]);
      if (aliasesRaw) {
        aliasesRaw.split(/[|,]/).forEach(function(a) { addStaffMasterIndexName_(byName, a, userId); });
      }
    }
  }
  return { byName };
}

function addStaffMasterIndexName_(byName, rawName, userId) {
  const key = normalizeStaffNameForMatch_(rawName);
  if (!key) return;
  if (!byName[key]) byName[key] = sanitizeString_(userId);
}

function matchStaffUserId_(staffNameRaw, staffMasterIndex) {
  const key = normalizeStaffNameForMatch_(staffNameRaw);
  if (!key) return '';
  const index = staffMasterIndex && staffMasterIndex.byName ? staffMasterIndex.byName : {};
  return sanitizeString_(index[key]);
}

function normalizeStaffNameForMatch_(value) {
  let s = sanitizeString_(value);
  if (!s) return '';
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  // Spec: v5_spec 3.2 Hotel OCR normalization
  s = s.toLowerCase();
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, '').trim();
  s = s.replace(/[ぁぃぅぇぉっゃゅょゎゕゖ]/g, function(ch) {
    return ({ 'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お','っ':'つ','ゃ':'や','ゅ':'ゆ','ょ':'よ','ゎ':'わ','ゕ':'か','ゖ':'け' })[ch] || ch;
  });
  s = s.replace(/[ァィゥェォッャュョヮヵヶ]/g, function(ch) {
    return ({ 'ァ':'ア','ィ':'イ','ゥ':'ウ','ェ':'エ','ォ':'オ','ッ':'ツ','ャ':'ヤ','ュ':'ユ','ョ':'ヨ','ヮ':'ワ','ヵ':'カ','ヶ':'ケ' })[ch] || ch;
  });
  if (typeof s.normalize === 'function') {
    s = s.normalize('NFKD').replace(/[\u3099\u309A]/g, '').normalize('NFC');
  }
  return s;
}

function buildSiteMasterIndex_(siteSheet) {
  const byName = {};
  if (!siteSheet) return { byName };
  const table = readTable_(siteSheet);
  if (!table.ok || !table.values || table.values.length <= 1) return { byName };
  const headers    = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxSiteId  = indexOfHeader_(headers, ['siteid', 'site_id', 'sitecode']);
  const idxSiteNm  = indexOfHeader_(headers, ['sitename', 'site_name', 'name']);
  const idxAliases = indexOfHeader_(headers, ['aliases', 'alias']);
  if (idxSiteId < 0 || idxSiteNm < 0) return { byName };
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row         = values[r];
    const siteId      = sanitizeString_(row[idxSiteId]);
    const siteNameNorm = sanitizeString_(row[idxSiteNm]);
    if (!siteId || !siteNameNorm) continue;
    addSiteMasterIndexName_(byName, siteNameNorm, siteId, siteNameNorm);
    if (idxAliases >= 0) {
      const aliasesRaw = sanitizeString_(row[idxAliases]);
      if (aliasesRaw) {
        aliasesRaw.split('|').forEach(function(a) { addSiteMasterIndexName_(byName, a, siteId, siteNameNorm); });
      }
    }
  }
  return { byName };
}

function addSiteMasterIndexName_(byName, rawName, siteId, siteNameNorm) {
  const key = normalizeSiteNameForMatch_(rawName);
  if (!key) return;
  if (!byName[key]) byName[key] = { siteId: sanitizeString_(siteId), siteNameNorm: sanitizeString_(siteNameNorm) };
}

function normalizeSiteNameForMatch_(value) {
  let s = sanitizeString_(value);
  if (!s) return '';
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function matchSiteId_(siteRaw, siteMasterIndex) {
  const key = normalizeSiteNameForMatch_(siteRaw);
  if (!key) return { siteId: '', siteNameNorm: '' };
  const index = siteMasterIndex && siteMasterIndex.byName ? siteMasterIndex.byName : {};
  const hit   = index[key];
  if (!hit) return { siteId: '', siteNameNorm: '' };
  return { siteId: sanitizeString_(hit.siteId), siteNameNorm: sanitizeString_(hit.siteNameNorm) };
}

function parseStaffNameKana_(text) {
  const source = sanitizeString_(text);
  if (!source) return { staffNameRaw: '', staffKanaRaw: '' };
  const m = source.match(/^(.*?)\s*(?:[（(](.*?)[）)])?\s*$/);
  if (!m) return { staffNameRaw: source, staffKanaRaw: '' };
  return { staffNameRaw: sanitizeString_(m[1]), staffKanaRaw: sanitizeString_(m[2]) };
}

function toDayOrNull_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const day = Math.floor(n);
  if (day < 1 || day > 31) return null;
  return day;
}

function resolveParseFailureReason_(parsed) {
  const errs  = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];
  if (errs.length === 0) return 'no_assignment_generated';
  const first = errs[0] || {};
  return String(first.reason || first.code || 'parse_error');
}

/**
 * traffic.setPair
 */
function handleTrafficSetPair_(ss, data, requestId) {
  const workKey     = sanitizeString_(data && data.workKey);
  const workDate    = sanitizeString_(data && data.workDate);
  const userId      = sanitizeString_(data && data.userId);
  const siteId      = sanitizeString_(data && data.siteId);
  const type        = sanitizeString_(data && data.type);
  const fromStation = sanitizeString_(data && data.fromStation);
  const toStation   = sanitizeString_(data && data.toStation);
  const amount      = Number(data && data.amount);
  const rawDate     = sanitizeString_(data && data.rawDate);
  const fields = [];
  if (!workKey) fields.push({ field: 'workKey', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (type !== '行き' && type !== '帰り') fields.push({ field: 'type', reason: 'must be 行き or 帰り' });
  if (!fromStation) fields.push({ field: 'fromStation', reason: 'required' });
  if (!toStation) fields.push({ field: 'toStation', reason: 'required' });
  if (!Number.isFinite(amount) || amount <= 0) fields.push({ field: 'amount', reason: 'must be number > 0' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) fields.push({ field: 'rawDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    try {
      const sheet = ensureTrafficPairSheet_(ss);
      const table = readTable_(sheet);
      if (!table.ok || table.values.length === 0) {
        return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet TRAFFIC_PAIR_LOG not found.', {}, requestId);
      }
      const headers    = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
      const idxWorkKey = indexOfHeader_(headers, ['workkey']);
      const idxType    = indexOfHeader_(headers, ['type']);
      if (idxWorkKey < 0 || idxType < 0) {
        return errorResponse_('E_VALIDATION', 'TRAFFIC_PAIR_LOG headers are missing required fields.', { required: ['workKey','type'] }, requestId);
      }
      const existingTypes = {};
      for (let r = 1; r < table.values.length; r++) {
        const row = table.values[r];
        if (sanitizeString_(row[idxWorkKey]) !== workKey) continue;
        const rowType = sanitizeString_(row[idxType]);
        if (rowType) existingTypes[rowType] = true;
      }
      if (!existingTypes[type] && Object.keys(existingTypes).length >= 2) {
        return errorResponse_('E_PAIR_LIMIT', 'Pair limit exceeded for workKey.', { workKey, existingTypes: Object.keys(existingTypes).sort() }, requestId);
      }
      const pairKey = workKey + '|' + type;
      // [P12] フォーマット済み日時
      const nowIso = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
      const upsert = upsertSheetRowById_(sheet, 'pairKey', pairKey, {
        timestamp: nowIso,
        workKey, workDate, userId, siteId, type, fromStation, toStation, amount, rawDate, requestId
      });
      if (!upsert.ok) {
        return errorResponse_(upsert.code, upsert.message, upsert.details, requestId);
      }
      return okResponse_({ workKey, type, row: upsert.row, created: Boolean(upsert.created) }, requestId);
    } catch (err) {
      return errorResponse_('E_TRAFFIC_PAIR_SET_FAILED', 'Failed to set traffic pair.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
    }
  });
}

/**
 * site.getByDate
 */
function handleSiteGetByDate_(ss, data, requestId) {
  const userId   = sanitizeString_(data && data.userId);
  const workDate = sanitizeString_(data && data.workDate);
  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  // workDate を持つシートのみ採用する（SHIFT_ASSIGNMENTS の誤選択を防止）
  const sourceCandidates = [ss.getSheetByName(SHEET_SHIFT_), ss.getSheetByName('SHIFT_ASSIGNMENTS')];
  let table = null;
  let hasCandidateSheet = false;
  for (let i = 0; i < sourceCandidates.length; i++) {
    const candidate = sourceCandidates[i];
    if (!candidate) continue;
    hasCandidateSheet = true;
    const candidateTable = readTable_(candidate);
    if (!candidateTable.ok || !candidateTable.values || candidateTable.values.length === 0) continue;
    if (candidateTable.idx.userid < 0 || candidateTable.idx.workdate < 0) continue;
    table = candidateTable;
    break;
  }
  if (!table) {
    if (!hasCandidateSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT not found.', {}, requestId);
    return errorResponse_('E_VALIDATION', 'SHIFT headers are missing required fields.', { required: ['userId','workDate'] }, requestId);
  }
  if (!table.values || table.values.length === 0) {
    return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT is empty.', {}, requestId);
  }
  const idx = table.idx;
  const headers        = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxSiteId      = indexOfHeader_(headers, ['siteid','site_id','sitecode']);
  const idxSiteName    = indexOfHeader_(headers, ['sitename','site_name','sitelabel']);
  const idxSiteAddress = indexOfHeader_(headers, ['siteaddress','site_address','address']);
  const idxSiteNearest = indexOfHeader_(headers, ['siteneareststation','site_nearest_station','sitestation','neareststation','nearest_station']);
  let hit = null;
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    if (sanitizeString_(row[idx.userid]) !== userId) continue;
    if (normalizeYmd_(row[idx.workdate]) !== workDate) continue;
    hit = row;
  }
  if (!hit) {
    return errorResponse_('E_SITE_NOT_FOUND', 'Site not found for userId/workDate.', { userId, workDate }, requestId);
  }
  const projectFallback = idx.project >= 0 ? sanitizeString_(hit[idx.project]) : '';
  return okResponse_(
    {
      siteId:             idxSiteId      >= 0 ? sanitizeString_(hit[idxSiteId])      : projectFallback,
      siteName:           idxSiteName    >= 0 ? sanitizeString_(hit[idxSiteName])    : projectFallback,
      siteAddress:        idxSiteAddress >= 0 ? sanitizeString_(hit[idxSiteAddress]) : '',
      siteNearestStation: idxSiteNearest >= 0 ? sanitizeString_(hit[idxSiteNearest]) : ''
    },
    requestId
  );
}

/**
 * site.profile.get
 */
function handleSiteProfileGet_(ss, data, requestId) {
  const userId    = sanitizeString_(data && data.userId);
  const workDate  = sanitizeString_(data && data.workDate);
  const projectId = sanitizeString_(data && data.projectId);
  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const siteSheet = ensureSiteMasterSheet_(ss);
  const siteTable = readTable_(siteSheet);
  if (!siteTable.ok || !siteTable.values || siteTable.values.length <= 1) {
    return errorResponse_('E_SITE_PROFILE_MISSING', 'Site profile is missing.', { reason: 'site_master_empty', workDate, projectId: projectId || '' }, requestId);
  }
  const headers           = siteTable.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxSiteId         = indexOfHeader_(headers, ['siteid','site_id']);
  const idxProjectId      = indexOfHeader_(headers, ['projectid','project_id','project']);
  const idxWorkDate       = indexOfHeader_(headers, ['workdate','work_date','date']);
  const idxSiteName       = indexOfHeader_(headers, ['sitename','site_name']);
  const idxSiteAddress    = indexOfHeader_(headers, ['siteaddress','site_address','address']);
  const idxNearestStations= indexOfHeader_(headers, ['neareststations','nearest_stations','siteneareststations']);
  const idxAliases        = indexOfHeader_(headers, ['aliases','alias']);
  if (idxWorkDate < 0 || idxSiteName < 0 || idxNearestStations < 0) {
    return errorResponse_('E_VALIDATION', 'SITE_MASTER headers are missing required fields.', { required: ['workDate','siteName','nearestStations'] }, requestId);
  }
  let hit = null;
  for (let r = siteTable.values.length - 1; r >= 1; r--) {
    const row         = siteTable.values[r];
    const rowWorkDate = normalizeYmd_(row[idxWorkDate]);
    if (rowWorkDate !== workDate) continue;
    const rowProjectId = idxProjectId >= 0 ? sanitizeString_(row[idxProjectId]) : '';
    if (projectId && rowProjectId !== projectId) continue;
    hit = row;
    break;
  }
  if (!hit) {
    return errorResponse_('E_SITE_PROFILE_MISSING', 'Site profile is missing.', { reason: 'site_not_found', workDate, projectId: projectId || '' }, requestId);
  }
  const homeNearestStation  = getHomeNearestStation_(ss, userId);
  const nearestStations     = splitCsvLike_(idxNearestStations >= 0 ? hit[idxNearestStations] : '');
  const aliases             = splitCsvLike_(idxAliases >= 0 ? hit[idxAliases] : '');
  const resolvedProjectId   = idxProjectId >= 0 ? sanitizeString_(hit[idxProjectId]) : projectId;
  return okResponse_(
    {
      siteId:            idxSiteId      >= 0 ? sanitizeString_(hit[idxSiteId])      : '',
      siteAddress:       idxSiteAddress >= 0 ? sanitizeString_(hit[idxSiteAddress]) : '',
      nearestStations,
      siteName:          idxSiteName    >= 0 ? sanitizeString_(hit[idxSiteName])    : '',
      projectId:         resolvedProjectId,
      workDate,
      aliases,
      homeNearestStation
    },
    requestId
  );
}

/**
 * status.get
 */
function handleStatusGet_(ss, data, requestId) {
  const userId = sanitizeString_(data && data.userId);
  const month  = sanitizeString_(data && data.month);
  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (!month || !/^\d{4}-\d{2}$/.test(month)) fields.push({ field: 'month', reason: 'must be YYYY-MM' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const shiftSheet   = ss.getSheetByName(SHEET_SHIFT_);
  const trafficSheet = ss.getSheetByName(SHEET_TRAFFIC_);
  if (!shiftSheet)   return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT not found.', {}, requestId);
  if (!trafficSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet TRAFFIC_LOG not found.', {}, requestId);

  const plannedDates = listPlannedWorkDates_(ss, month, userId);
  const trafficAgg   = aggregateTrafficForUserMonth_(trafficSheet, userId, month);
  const submittedSet = (trafficAgg && trafficAgg.submittedSet) ? trafficAgg.submittedSet : {};
  const total        = (trafficAgg && typeof trafficAgg.total === 'number') ? trafficAgg.total : 0;
  const unsubmittedDates = plannedDates.filter(d => !submittedSet[d]);
  return okResponse_(
    { month, userId, plannedDates, submittedDates: Object.keys(submittedSet).sort(), unsubmittedDates, trafficTotal: total },
    requestId
  );
}

/**
 * unsubmitted.list
 */
function handleUnsubmittedList_(ss, data, requestId) {
  const month   = sanitizeString_(data && data.month);
  const project = sanitizeString_(data && data.project);
  const fields = [];
  if (!month || !/^\d{4}-\d{2}$/.test(month)) fields.push({ field: 'month', reason: 'must be YYYY-MM' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const shiftSheet   = ss.getSheetByName(SHEET_SHIFT_);
  const trafficSheet = ss.getSheetByName(SHEET_TRAFFIC_);
  const mode = getShiftSourceMode_();
  if (mode === 'SHIFT_FIRST' && !shiftSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT not found.', {}, requestId);
  if (!trafficSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet TRAFFIC_LOG not found.', {}, requestId);

  const staffSheet = ss.getSheetByName(SHEET_STAFF_);
  const staffMap   = staffSheet ? buildStaffMapFast_(staffSheet) : {};

  // [P1] plannedByUser を1パスで構築（N×シート読込を廃止）
  const plannedByUser  = buildPlannedByUserFeatureFlagged_(ss, month, project, '');
  const submittedIndex = buildSubmittedIndex_(trafficSheet, month);

  const out = Object.keys(plannedByUser)
    .map(uid => {
      const item         = plannedByUser[uid] || {};
      const subSet       = submittedIndex[uid] || {};
      const plannedDates = uniq_(item.plannedDates || []).sort();
      const missingDates = plannedDates.filter(d => !subSet[d]);
      const fallbackName = (staffMap[uid] && staffMap[uid].name) ? staffMap[uid].name : '';
      const name         = (item.name && String(item.name).trim()) ? item.name : fallbackName;
      const lineUserId   = (staffMap[uid] && staffMap[uid].lineUserId) ? String(staffMap[uid].lineUserId).trim() : '';
      const status       = (staffMap[uid] && staffMap[uid].status) ? String(staffMap[uid].status).trim() : '';
      return { userId: uid, lineUserId, status, name, missingDates };
    })
    .filter(x => x.missingDates && x.missingDates.length > 0)
    .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));

  return okResponse_({ month, project: project || '', unsubmitted: out }, requestId);
}

/**
 * reminder.targets
 */
function handleReminderTargets_(ss, data, requestId) {
  const date  = normalizeYmd_(data && data.date) || Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd');
  const month = date.slice(0, 7);

  const shiftSheet   = ss.getSheetByName(SHEET_SHIFT_);
  const trafficSheet = ss.getSheetByName(SHEET_TRAFFIC_);
  const mode = getShiftSourceMode_();
  if (mode === 'SHIFT_FIRST' && !shiftSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT not found.', {}, requestId);
  if (!trafficSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet TRAFFIC_LOG not found.', {}, requestId);

  const staffSheet = ss.getSheetByName(SHEET_STAFF_);
  const staffMap   = staffSheet ? buildStaffMapFast_(staffSheet) : {};

  // [P1] 1パス構築
  const plannedByUser  = buildPlannedByUserFeatureFlagged_(ss, month, '', date);
  const submittedIndex = buildSubmittedIndex_(trafficSheet, month);

  const targets = Object.keys(plannedByUser)
    .map(uid => {
      const item         = plannedByUser[uid] || {};
      const submittedSet = submittedIndex[uid] || {};
      const plannedDates = uniq_(item.plannedDates || []).sort();
      const missingDates = plannedDates.filter(d => !submittedSet[d]);
      if (missingDates.length === 0) return null;
      const staff      = staffMap[uid] || {};
      // Spec: v5_spec 3.1 Staff Master targeting filter
      if (!isStaffPushTarget_(staff)) return null;
      const lineUserId = sanitizeString_(staff.lineUserId) || uid;
      if (!lineUserId) return null;
      return { userId: uid, lineUserId, name: sanitizeString_(item.name) || sanitizeString_(staff.name), month, missingDates };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));

  return okResponse_({ date, month, targets }, requestId);
}

/**
 * hotel.sendGuard
 */
function handleHotelSendGuard_(ss, data, requestId) {
  const date       = normalizeYmd_(data && data.date);
  const projectId  = sanitizeString_(data && data.projectId);
  const lineUserId = sanitizeString_(data && (data.lineUserId || data.userId));
  const mode       = sanitizeString_(data && data.mode).toLowerCase() || 'guard';
  const status     = sanitizeString_(data && data.status).toLowerCase();
  const guardToken = sanitizeString_(data && data.guardToken);
  const dedupeKey  = buildHotelSendGuardKey_(date, projectId, lineUserId);
  const fields = [];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fields.push({ field: 'date', reason: 'must be YYYY-MM-DD' });
  if (!projectId)  fields.push({ field: 'projectId',  reason: 'required' });
  if (!lineUserId) fields.push({ field: 'lineUserId', reason: 'required' });
  if (mode !== 'guard' && mode !== 'result') fields.push({ field: 'mode', reason: 'must be guard/result' });
  if (mode === 'result') {
    if (!guardToken) fields.push({ field: 'guardToken', reason: 'required' });
    if (guardToken && dedupeKey && guardToken !== dedupeKey) fields.push({ field: 'guardToken', reason: 'does not match dedupe key' });
    if (!isSendGuardStatus_(status)) fields.push({ field: 'status', reason: 'must be pushed/failed' });
  }
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const sheet = ensureHotelSentLogSheet_(ss);
    const existingRow = findHotelSentLogRow_(sheet, date, projectId, lineUserId);
    if (mode === 'result') {
      if (existingRow < 2) {
        logSendGuard_('hotel.sendGuard.result.not_found', requestId, { date, projectId, lineUserId, status, guardToken });
        return okResponse_({ updated: false, guardToken, status }, requestId);
      }
      setRangeValuesSanitized_(sheet.getRange(existingRow, 4, 1, 2), [[status, requestId]]);
      logSendGuard_('hotel.sendGuard.result.updated', requestId, { row: existingRow, date, projectId, lineUserId, status, guardToken });
      return okResponse_({ updated: true, row: existingRow, guardToken, status }, requestId);
    }
    if (existingRow > 0) {
      const rowValues    = sheet.getRange(existingRow, 4, 1, 3).getValues()[0];
      const currentStatus = sanitizeString_(rowValues[0]).toLowerCase();
      const createdAtValue = rowValues[2];
      const ttlMs        = getSendGuardSendingTtlMs_();
      const staleState   = resolveSendGuardStaleState_(currentStatus, createdAtValue, ttlMs);
      if (staleState.stale) {
        setRangeValueSanitized_(sheet.getRange(existingRow, 4, 1, 1), 'stale');
        const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
        appendRowSanitized_(sheet, [date, projectId, lineUserId, 'sending', requestId, nowStr]);
        const newRow = sheet.getLastRow();
        logSendGuard_('hotel.sendGuard.stale_recovered', requestId, { dedupeKey, staleRow: existingRow, newRow });
        return okResponse_({ allowed: true, guardToken: dedupeKey, status: 'sending', row: newRow }, requestId);
      }
      logSendGuard_('hotel.sendGuard.duplicate', requestId, { row: existingRow, date, projectId, lineUserId, status: currentStatus });
      return okResponse_({ allowed: false, guardToken: dedupeKey, status: currentStatus, row: existingRow }, requestId);
    }
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
    appendRowSanitized_(sheet, [date, projectId, lineUserId, 'sending', requestId, nowStr]);
    const row = sheet.getLastRow();
    logSendGuard_('hotel.sendGuard.allowed', requestId, { row, date, projectId, lineUserId, guardToken: dedupeKey });
    return okResponse_({ allowed: true, guardToken: dedupeKey, status: 'sending', row }, requestId);
  });
}

/**
 * reminder.sendGuard
 */
function handleReminderSendGuard_(ss, data, requestId) {
  const date       = normalizeYmd_(data && data.date);
  const lineUserId = sanitizeString_(data && (data.lineUserId || data.userId));
  const mode       = sanitizeString_(data && data.mode).toLowerCase() || 'guard';
  const status     = sanitizeString_(data && data.status).toLowerCase();
  const guardToken = sanitizeString_(data && data.guardToken);
  const dedupeKey  = buildReminderSendGuardKey_(date, lineUserId);
  const fields = [];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fields.push({ field: 'date', reason: 'must be YYYY-MM-DD' });
  if (!lineUserId) fields.push({ field: 'lineUserId', reason: 'required' });
  if (mode !== 'guard' && mode !== 'result') fields.push({ field: 'mode', reason: 'must be guard/result' });
  if (mode === 'result') {
    if (!guardToken) fields.push({ field: 'guardToken', reason: 'required' });
    if (guardToken && dedupeKey && guardToken !== dedupeKey) fields.push({ field: 'guardToken', reason: 'does not match dedupe key' });
    if (!isSendGuardStatus_(status)) fields.push({ field: 'status', reason: 'must be pushed/failed' });
  }
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const sheet = ensureReminderSentLogSheet_(ss);
    const existingRow = findReminderSentLogRow_(sheet, date, lineUserId);
    if (mode === 'result') {
      if (existingRow < 2) {
        logSendGuard_('reminder.sendGuard.result.not_found', requestId, { date, lineUserId, status, guardToken });
        return okResponse_({ updated: false, guardToken, status }, requestId);
      }
      setRangeValuesSanitized_(sheet.getRange(existingRow, 3, 1, 2), [[status, requestId]]);
      logSendGuard_('reminder.sendGuard.result.updated', requestId, { row: existingRow, date, lineUserId, status, guardToken });
      return okResponse_({ updated: true, row: existingRow, guardToken, status }, requestId);
    }
    if (existingRow > 0) {
      const rowValues    = sheet.getRange(existingRow, 3, 1, 3).getValues()[0];
      const currentStatus = sanitizeString_(rowValues[0]).toLowerCase();
      const createdAtValue = rowValues[2];
      const ttlMs        = getSendGuardSendingTtlMs_();
      const staleState   = resolveSendGuardStaleState_(currentStatus, createdAtValue, ttlMs);
      if (staleState.stale) {
        setRangeValueSanitized_(sheet.getRange(existingRow, 3, 1, 1), 'stale');
        const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
        appendRowSanitized_(sheet, [date, lineUserId, 'sending', requestId, nowStr]);
        const newRow = sheet.getLastRow();
        logSendGuard_('reminder.sendGuard.stale_recovered', requestId, { dedupeKey, staleRow: existingRow, newRow });
        return okResponse_({ allowed: true, guardToken: dedupeKey, status: 'sending', row: newRow }, requestId);
      }
      logSendGuard_('reminder.sendGuard.duplicate', requestId, { row: existingRow, date, lineUserId, status: currentStatus });
      return okResponse_({ allowed: false, guardToken: dedupeKey, status: currentStatus, row: existingRow }, requestId);
    }
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
    appendRowSanitized_(sheet, [date, lineUserId, 'sending', requestId, nowStr]);
    const row = sheet.getLastRow();
    logSendGuard_('reminder.sendGuard.allowed', requestId, { row, date, lineUserId, guardToken: dedupeKey });
    return okResponse_({ allowed: true, guardToken: dedupeKey, status: 'sending', row }, requestId);
  });
}

/**
 * hotel.intent.submit
 */
function handleHotelIntentSubmit_(ss, data, requestId) {
  const userId       = sanitizeString_(data && data.userId);
  const projectId    = sanitizeString_(data && data.projectId);
  const workDate     = sanitizeString_(data && data.workDate);
  const source       = sanitizeString_(data && data.source) || 'line';
  const status       = sanitizeString_(data && data.status) || 'answered';
  const needHotelVal = parseNeedHotel_(data && data.needHotel);
  const smoking      = normalizeSmoking_(data && data.smoking);
  const fields = [];
  if (!userId)    fields.push({ field: 'userId',    reason: 'required' });
  if (!projectId) fields.push({ field: 'projectId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (needHotelVal === null) fields.push({ field: 'needHotel', reason: 'must be boolean' });
  if (smoking === '')        fields.push({ field: 'smoking',   reason: 'must be non/smoke/none' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const sheet  = ensureHotelIntentSheet_(ss);
  const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
  appendRowSanitized_(sheet, [nowStr, userId, projectId, workDate, needHotelVal, smoking, source, status]);
  return okResponse_({ row: sheet.getLastRow() }, requestId);
}

/**
 * [P2] hotel.intent.list — データ層を分離
 */
function queryHotelIntentItems_(ss, projectId, workDate) {
  const sheet = ensureHotelIntentSheet_(ss);
  const table = readTable_(sheet);
  const idx   = table.idx;
  const out   = [];
  for (let r = 1; r < table.values.length; r++) {
    const row      = table.values[r];
    const rowProj  = idx.project  >= 0 ? sanitizeString_(row[idx.project])  : '';
    const rowDate  = idx.workdate >= 0 ? normalizeYmd_(row[idx.workdate])   : '';
    if (rowProj !== projectId || rowDate !== workDate) continue;
    out.push({
      userId:    idx.userid   >= 0 ? sanitizeString_(row[idx.userid])          : '',
      projectId: rowProj,
      workDate:  rowDate,
      needHotel: idx.needhotel >= 0 ? parseNeedHotel_(row[idx.needhotel])     : null,
      smoking:   idx.smoking   >= 0 ? sanitizeString_(row[idx.smoking])        : '',
      source:    idx.source    >= 0 ? sanitizeString_(row[idx.source])         : '',
      status:    idx.status    >= 0 ? sanitizeString_(row[idx.status])         : ''
    });
  }
  return out;
}

function handleHotelIntentList_(ss, data, requestId) {
  const projectId = sanitizeString_(data && data.projectId);
  const workDate  = sanitizeString_(data && data.workDate);
  const fields = [];
  if (!projectId) fields.push({ field: 'projectId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);
  return okResponse_({ projectId, workDate, items: queryHotelIntentItems_(ss, projectId, workDate) }, requestId);
}

/**
 * [P2] hotel.intent.summary — 直接 queryHotelIntentItems_ を呼ぶ（JSON.parse 廃止）
 */
function handleHotelIntentSummary_(ss, data, requestId) {
  const projectId = sanitizeString_(data && data.projectId);
  const workDate  = sanitizeString_(data && data.workDate);
  const fields = [];
  if (!projectId) fields.push({ field: 'projectId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const items  = queryHotelIntentItems_(ss, projectId, workDate);
  const byUser = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.userId) continue;
    byUser[it.userId] = it;
  }
  const finalItems = Object.keys(byUser).map(function(uid) { return byUser[uid]; });
  let needYes = 0, needNo = 0, smokeNon = 0, smokeSmoke = 0, unknown = 0;
  for (let j = 0; j < finalItems.length; j++) {
    const row = finalItems[j];
    if (row.needHotel === true) {
      needYes += 1;
      if (row.smoking === 'non')   smokeNon   += 1;
      else if (row.smoking === 'smoke') smokeSmoke += 1;
      else unknown += 1;
    } else if (row.needHotel === false) {
      needNo += 1;
    } else {
      unknown += 1;
    }
  }
  return okResponse_(
    { projectId, workDate, totalUsers: finalItems.length, needHotel: needYes, noHotel: needNo, smokingNon: smokeNon, smokingSmoke: smokeSmoke, unknown },
    requestId
  );
}

/**
 * hotel.intent.targets
 */
function handleHotelIntentTargets_(ss, data, requestId) {
  const projectId = sanitizeString_(data && data.projectId);
  const workDate  = sanitizeString_(data && data.workDate);
  const fields = [];
  if (!projectId) fields.push({ field: 'projectId', reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const staffSheet = ss.getSheetByName(SHEET_STAFF_);
  const staffMap   = staffSheet ? buildStaffMapFast_(staffSheet) : {};
  const month      = workDate.slice(0, 7);
  const targets = buildHotelTargetsFeatureFlagged_(ss, month, {
    projectId, workDate, siteId: sanitizeString_(data && data.siteId), staffMap
  });
  if (targets === null) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet SHIFT not found.', {}, requestId);
  return okResponse_({ projectId, workDate, targets }, requestId);
}

function buildHotelTargetsFeatureFlagged_(ss, month, optionalFilter) {
  const filter    = optionalFilter || {};
  const projectId = sanitizeString_(filter.projectId);
  const workDate  = normalizeYmd_(filter.workDate);
  const siteId    = sanitizeString_(filter.siteId);
  const staffMap  = filter.staffMap || {};
  let userIds = [];
  const mode = getShiftSourceMode_();
  if (mode === 'ASSIGNMENTS_FIRST') {
    const assignmentSheet = ss.getSheetByName('SHIFT_ASSIGNMENTS');
    userIds = listHotelTargetUserIdsFromAssignments_(assignmentSheet, month, workDate, siteId);
    if (userIds.length === 0) {
      const shiftSheet = ss.getSheetByName(SHEET_SHIFT_);
      if (!shiftSheet) return null;
      userIds = listHotelTargetUserIdsFromShift_(shiftSheet, projectId, workDate);
    }
  } else {
    const shiftSheet = ss.getSheetByName(SHEET_SHIFT_);
    if (!shiftSheet) return null;
    userIds = listHotelTargetUserIdsFromShift_(shiftSheet, projectId, workDate);
  }
  return buildHotelTargetsFromUserIds_(userIds, staffMap, projectId, workDate);
}

function buildHotelTargetsFromUserIds_(userIds, staffMap, projectId, workDate) {
  const targets = [];
  const ids = Array.isArray(userIds) ? userIds : [];
  for (let i = 0; i < ids.length; i++) {
    const uid    = sanitizeString_(ids[i]);
    if (!uid) continue;
    const staff  = staffMap[uid] || {};
    // Spec: v5_spec 3.1 Staff Master targeting filter
    if (!isStaffPushTarget_(staff)) continue;
    const lineUserId = sanitizeString_(staff.lineUserId) || uid;
    if (!lineUserId) continue;
    targets.push({ userId: uid, lineUserId, name: sanitizeString_(staff.name), projectId, workDate });
  }
  return targets;
}

function listHotelTargetUserIdsFromShift_(shiftSheet, projectId, workDate) {
  if (!shiftSheet) return [];
  const shiftTable = readTable_(shiftSheet);
  if (!shiftTable.ok) return [];
  const idx = shiftTable.idx;
  if (idx.project < 0 || idx.workdate < 0 || idx.userid < 0) return [];
  const targetUids = {};
  for (let r = 1; r < shiftTable.values.length; r++) {
    const row = shiftTable.values[r];
    if (sanitizeString_(row[idx.project]) !== projectId) continue;
    if (normalizeYmd_(row[idx.workdate]) !== workDate) continue;
    const uid = sanitizeString_(row[idx.userid]);
    if (uid) targetUids[uid] = true;
  }
  return Object.keys(targetUids).sort();
}

function listHotelTargetUserIdsFromAssignments_(sheet, month, workDate, siteIdFilter) {
  if (!sheet) return [];
  if (!/^\d{4}-\d{2}$/.test(sanitizeString_(month))) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sanitizeString_(workDate))) return [];
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  if (table.idx.userid < 0) return [];
  const headers   = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxWorkDate = indexOfHeader_(headers, ['workdate','work_date','date']);
  const idxSiteId   = indexOfHeader_(headers, ['siteid','site_id','sitecode']);
  const idxSegFrom  = indexOfHeader_(headers, ['segmentfromday','segment_from_day']);
  const idxSegTo    = indexOfHeader_(headers, ['segmenttoday','segment_to_day']);
  const idxSiteFrom = indexOfHeader_(headers, ['siteperiodfromday','site_period_from_day']);
  const idxSiteTo   = indexOfHeader_(headers, ['siteperiodtoday','site_period_to_day']);
  if (siteIdFilter && idxSiteId < 0) return [];
  const targetDay = toDayOrNull_(workDate.slice(8, 10));
  if (targetDay === null) return [];
  const userSet = {};
  const values  = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const uid = sanitizeString_(row[table.idx.userid]);
    if (!uid) continue;
    if (siteIdFilter && sanitizeString_(row[idxSiteId]) !== siteIdFilter) continue;
    let matchedDate = false;
    if (idxWorkDate >= 0) {
      const ymd = normalizeYmd_(row[idxWorkDate]);
      if (ymd && ymd === workDate) matchedDate = true;
    }
    if (!matchedDate) {
      let fromDay = idxSegFrom >= 0 ? toDayOrNull_(row[idxSegFrom]) : null;
      let toDay   = idxSegTo   >= 0 ? toDayOrNull_(row[idxSegTo])   : null;
      if (fromDay === null && idxSiteFrom >= 0) fromDay = toDayOrNull_(row[idxSiteFrom]);
      if (toDay   === null && idxSiteTo   >= 0) toDay   = toDayOrNull_(row[idxSiteTo]);
      if (fromDay === null && toDay === null) continue;
      if (fromDay === null) fromDay = toDay;
      if (toDay   === null) toDay   = fromDay;
      let start = Number(fromDay), end = Number(toDay);
      if (start > end) { const tmp = start; start = end; end = tmp; }
      if (targetDay < start || targetDay > end) continue;
    }
    userSet[uid] = true;
  }
  return Object.keys(userSet).sort();
}

/**
 * [P5] hotel.user.upsert — withScriptLock_ 追加
 */
function handleHotelUserUpsert_(ss, data, requestId) {
  // Spec: v5_spec 3.1 Staff Master isActive/lineFollowStatus
  const userId      = sanitizeString_(data && data.userId);
  const lineUserId  = sanitizeString_(data && data.lineUserId) || userId;
  const statusInput = sanitizeString_(data && data.status);
  const displayName = sanitizeString_(data && data.displayName);
  if (!userId) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required' }] }, requestId);
  }
  return withScriptLock_(requestId, function() {
    try {
      const staffSheet = ensureStaffMasterSheet_(ss);
      const nowStr     = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
      const lineFollowStatus = normalizeLineFollowStatus_(sanitizeString_(data && data.lineFollowStatus) || statusInput || 'follow');
      const isActive = resolveIsActiveFromInput_(data && data.isActive, statusInput);
      const patch = {
        userId: userId,
        lineUserId: lineUserId,
        status: toLegacyStaffStatus_(isActive, lineFollowStatus),
        isActive: isActive ? 'true' : 'false',
        lineFollowStatus: lineFollowStatus,
        updatedAt: nowStr,
        updatedBy: sanitizeString_(data && data.source) || 'system'
      };
      if (displayName) patch.name = displayName;

      const upsert = upsertSheetRowById_(staffSheet, 'userId', userId, patch);
      if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details, requestId);
      return okResponse_({
        created: Boolean(upsert.created),
        row: upsert.row,
        userId: userId,
        lineUserId: lineUserId,
        isActive: isActive,
        lineFollowStatus: lineFollowStatus
      }, requestId);
    } catch (err) {
      return errorResponse_('E_STAFF_UPSERT_FAILED', 'Failed to upsert staff follow status.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
    }
  });
}

function handleOpsLog_(ss, data, requestId) {
  const kind = sanitizeString_(data && data.kind).toLowerCase();
  if (kind !== 'line_message' && kind !== 'admin_alert') {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'kind', reason: 'must be line_message/admin_alert' }] }, requestId);
  }
  return withScriptLock_(requestId, function() {
    try {
      const nowIso = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
      if (kind === 'line_message') {
        const sheet  = ensureSheetByCanonical_(ss, 'LINE_MESSAGE_LOG');
        const logId  = sanitizeString_(data && data.logId) || Utilities.getUuid();
        const upsert = upsertSheetRowById_(sheet, 'logId', logId, {
          timestamp: nowIso, requestId,
          channel:     sanitizeString_(data && data.channel),
          event:       sanitizeString_(data && data.event),
          lineUserId:  sanitizeString_(data && data.lineUserId),
          userId:      sanitizeString_(data && data.userId),
          status:      sanitizeString_(data && data.status),
          errorCode:   sanitizeString_(data && data.errorCode),
          payloadJson: safeJsonStringify_(data && data.payload ? data.payload : {})
        });
        if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details, requestId);
        return okResponse_({ kind: 'line_message', logId, row: upsert.row, created: Boolean(upsert.created) }, requestId);
      }
      const alertSheet = ensureSheetByCanonical_(ss, 'ADMIN_ALERTS');
      const alertId    = sanitizeString_(data && data.alertId) || Utilities.getUuid();
      const alertUpsert = upsertSheetRowById_(alertSheet, 'alertId', alertId, {
        timestamp: nowIso, requestId,
        severity:    sanitizeString_(data && data.severity) || 'warn',
        source:      sanitizeString_(data && data.source),
        event:       sanitizeString_(data && data.event),
        message:     sanitizeString_(data && data.message),
        payloadJson: safeJsonStringify_(data && data.payload ? data.payload : {}),
        status:      sanitizeString_(data && data.status) || 'open'
      });
      if (!alertUpsert.ok) return errorResponse_(alertUpsert.code, alertUpsert.message, alertUpsert.details, requestId);
      return okResponse_({ kind: 'admin_alert', alertId, row: alertUpsert.row, created: Boolean(alertUpsert.created) }, requestId);
    } catch (err) {
      return errorResponse_('E_OPS_LOG_FAILED', 'Failed to write ops log.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
    }
  });
}

function handleStaffRegisterStatus_(ss, data, requestId) {
  // Spec: api_schema 1 GET /api/register/status
  const inputUserId     = sanitizeString_(data && data.userId);
  const inputLineUserId = sanitizeString_(data && data.lineUserId);
  if (!inputUserId && !inputLineUserId) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required(userId or lineUserId)' }] }, requestId);
  }
  const fallbackUserId = inputUserId || inputLineUserId;
  const sheet = resolveStaffMasterSheetForRegistration_(ss);
  if (!sheet) return okResponse_(buildEmptyRegistrationState_(fallbackUserId, inputLineUserId || fallbackUserId), requestId);
  const table = readTable_(sheet);
  if (!table.ok || table.idx.userid < 0) return okResponse_(buildEmptyRegistrationState_(fallbackUserId, inputLineUserId || fallbackUserId), requestId);
  const idx = table.idx;
  let matchedUserId = fallbackUserId;
  let matchedLineUserId = inputLineUserId || fallbackUserId;
  let matchedRow = null;
  for (let r = 1; r < table.values.length; r++) {
    const row          = table.values[r];
    const rowUserId    = sanitizeString_(row[idx.userid]);
    const rowLineUserId = idx.lineuserid >= 0 ? sanitizeString_(row[idx.lineuserid]) : '';
    const hitByUserId     = inputUserId     && rowUserId     === inputUserId;
    const hitByLineUserId = inputLineUserId && (rowLineUserId === inputLineUserId || rowUserId === inputLineUserId);
    if (!hitByUserId && !hitByLineUserId) continue;
    matchedUserId      = rowUserId || fallbackUserId;
    matchedLineUserId  = rowLineUserId || matchedUserId;
    matchedRow         = row;
    break;
  }

  if (!matchedRow) {
    return okResponse_(buildEmptyRegistrationState_(matchedUserId, matchedLineUserId), requestId);
  }

  return okResponse_(buildRegistrationStateFromRow_(table.values[0], matchedRow, matchedUserId, matchedLineUserId), requestId);
}

function handleStaffRegisterLock_(ss, data, requestId) {
  // Spec: registration_spec 3 Gating Rules (follow時の未登録ロック)
  const userId = sanitizeString_(data && (data.userId || data.lineUserId));
  if (!userId) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required(userId or lineUserId)' }] }, requestId);
  }
  return withScriptLock_(requestId, function() {
    try {
      const staffSheet = resolveStaffMasterSheetForRegistration_(ss);
      if (!staffSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet STAFF_MASTER not found.', {}, requestId);
      const upsert = upsertSheetRowById_(staffSheet, 'userId', userId, {
        lineUserId: userId,
        status:     'unregistered',
        isActive:   'true',
        lineFollowStatus: 'follow',
        updatedBy:  'system',
        updatedAt:  Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss') // [P12]
      });
      if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details, requestId);
      return okResponse_({ userId, registered: false, registrationStatus: 'unregistered', missingFields: REGISTRATION_REQUIRED_FIELDS_, row: upsert.row, created: Boolean(upsert.created) }, requestId);
    } catch (err) {
      return errorResponse_('E_REGISTER_LOCK_FAILED', 'Failed to lock registration.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
    }
  });
}

function handleStaffRegisterUpsert_(ss, data, requestId) {
  // Spec: registration_spec 1 Required Fields / registration_spec 2 Validation Rules
  const input          = data && typeof data === 'object' ? data : {};
  const staffInput     = input.staff && typeof input.staff === 'object' ? input.staff : input;
  const userId         = sanitizeString_(staffInput.userId || input.userId || staffInput.lineUserId || input.lineUserId);
  const lineUserId     = sanitizeString_(staffInput.lineUserId || input.lineUserId) || userId;
  const fullNameKanji  = sanitizeString_(pick_(staffInput, ['nameKanji', 'fullNameKanji', 'name']));
  const fullNameKana   = sanitizeString_(pick_(staffInput, ['nameKana', 'fullNameKana', 'nameKana', 'kana']));
  const birthDate      = normalizeYmd_(staffInput.birthDate);
  const phone          = normalizePhoneDigits_(pick_(staffInput, ['phone', 'tel']));
  const emergencyRelation = sanitizeString_(staffInput.emergencyRelation);
  const emergencyPhone = normalizePhoneDigits_(staffInput.emergencyPhone);
  const postalCode     = normalizePostalCode_(staffInput.postalCode);
  const nearestStation = sanitizeString_(pick_(staffInput, ['nearestStation', 'station']));
  const address        = sanitizeString_(staffInput.address);
  const lineFollowStatus = normalizeLineFollowStatus_(sanitizeString_(staffInput.lineFollowStatus) || 'follow');
  const isActive       = resolveIsActiveFromInput_(staffInput.isActive, 'active');
  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required(userId or lineUserId)' });
  if (!isFullNameWithSpace_(fullNameKanji)) fields.push({ field: 'nameKanji', reason: 'must include surname and given name with space' });
  if (!isKanaNameWithSpace_(fullNameKana)) fields.push({ field: 'nameKana', reason: 'must be full-width katakana with space' });
  if (!birthDate) fields.push({ field: 'birthDate', reason: 'must be YYYY-MM-DD' });
  if (!nearestStation) fields.push({ field: 'nearestStation', reason: 'required' });
  if (!phone) fields.push({ field: 'phone', reason: 'required' });
  if (!emergencyRelation) fields.push({ field: 'emergencyRelation', reason: 'required' });
  if (!emergencyPhone) fields.push({ field: 'emergencyPhone', reason: 'required' });
  if (!postalCode) fields.push({ field: 'postalCode', reason: 'required' });
  if (!address) fields.push({ field: 'address', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    try {
      const staffSheet = resolveStaffMasterSheetForRegistration_(ss);
      if (!staffSheet) return errorResponse_('E_SHEET_NOT_FOUND', 'Sheet STAFF_MASTER not found.', {}, requestId);
      const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
      const patch = {
        userId,
        lineUserId: lineUserId,
        name: fullNameKanji,
        status: 'registered',
        updatedAt: nowStr,
        updatedBy: sanitizeString_(input.updatedBy) || 'self',
        fullNameKanji: fullNameKanji,
        fullNameKana: fullNameKana,
        nameKana: fullNameKana,
        kana: fullNameKana,
        birthDate: birthDate,
        phone: phone,
        tel: phone,
        emergencyRelation: emergencyRelation,
        emergencyPhone: emergencyPhone,
        postalCode: postalCode,
        nearestStation: nearestStation,
        station: nearestStation,
        address: address,
        isActive: isActive ? 'true' : 'false',
        lineFollowStatus: lineFollowStatus
      };
      patch.dataHash = buildStaffDataHash_({
        userId: userId,
        lineUserId: lineUserId,
        fullNameKanji: fullNameKanji,
        fullNameKana: fullNameKana,
        birthDate: birthDate,
        nearestStation: nearestStation,
        phone: phone,
        emergencyRelation: emergencyRelation,
        emergencyPhone: emergencyPhone,
        postalCode: postalCode,
        address: address,
        isActive: isActive ? 'true' : 'false',
        lineFollowStatus: lineFollowStatus
      });

      const upsert = upsertSheetRowById_(staffSheet, 'userId', userId, patch);
      if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details, requestId);
      return okResponse_({
        userId: userId,
        registered: true,
        registrationStatus: 'registered',
        missingFields: [],
        staff: {
          lineUserId: lineUserId,
          nameKanji: fullNameKanji,
          nameKana: fullNameKana,
          nearestStation: nearestStation,
          isActive: isActive,
          lineFollowStatus: lineFollowStatus
        },
        row: upsert.row,
        created: Boolean(upsert.created)
      }, requestId);
    } catch (err) {
      return errorResponse_('E_REGISTER_UPSERT_FAILED', 'Failed to upsert registration.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
    }
  });
}

/* =========================================================
 * Sheet readers
 * =======================================================*/

function listPlannedDatesFromShift_(sheet, userId, month) {
  const table = readTable_(sheet);
  if (!table.ok) return [];
  const idx = table.idx;
  if (idx.month < 0 || idx.workdate < 0 || idx.userid < 0) return [];
  const values  = table.values;
  const planned = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (sanitizeString_(row[idx.month]) !== month) continue;
    if (sanitizeString_(row[idx.userid]) !== userId) continue;
    const ymd = normalizeYmd_(row[idx.workdate]);
    if (ymd) planned.push(ymd);
  }
  return uniq_(planned).sort();
}

function listPlannedWorkDates_(ss, month, userId) {
  const mode = getShiftSourceMode_();
  if (mode === 'ASSIGNMENTS_FIRST') {
    const assignmentSheet = ss.getSheetByName('SHIFT_ASSIGNMENTS');
    const fromAssignments = listPlannedWorkDatesFromAssignments_(assignmentSheet, month, userId);
    if (fromAssignments.length > 0) return fromAssignments;
  }
  const shiftSheet = ss.getSheetByName(SHEET_SHIFT_);
  if (!shiftSheet) return [];
  return listPlannedDatesFromShift_(shiftSheet, userId, month);
}

function listPlannedWorkDatesFromAssignments_(sheet, month, userId) {
  if (!sheet) return [];
  if (!/^\d{4}-\d{2}$/.test(sanitizeString_(month))) return [];
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  if (table.idx.userid < 0) return [];
  const headers   = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxWorkDate = indexOfHeader_(headers, ['workdate','work_date','date']);
  const idxSegFrom  = indexOfHeader_(headers, ['segmentfromday','segment_from_day']);
  const idxSegTo    = indexOfHeader_(headers, ['segmenttoday','segment_to_day']);
  const idxSiteFrom = indexOfHeader_(headers, ['siteperiodfromday','site_period_from_day']);
  const idxSiteTo   = indexOfHeader_(headers, ['siteperiodtoday','site_period_to_day']);
  const maxDay  = daysInMonthFromYm_(month);
  const dates   = [];
  const values  = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (sanitizeString_(row[table.idx.userid]) !== userId) continue;
    if (idxWorkDate >= 0) {
      const ymd = normalizeYmd_(row[idxWorkDate]);
      if (ymd && ymd.slice(0, 7) === month) { dates.push(ymd); continue; }
    }
    let fromDay = idxSegFrom >= 0 ? toDayOrNull_(row[idxSegFrom]) : null;
    let toDay   = idxSegTo   >= 0 ? toDayOrNull_(row[idxSegTo])   : null;
    if (fromDay === null && idxSiteFrom >= 0) fromDay = toDayOrNull_(row[idxSiteFrom]);
    if (toDay   === null && idxSiteTo   >= 0) toDay   = toDayOrNull_(row[idxSiteTo]);
    if (fromDay === null && toDay === null) continue;
    if (fromDay === null) fromDay = toDay;
    if (toDay   === null) toDay   = fromDay;
    let start = Math.max(1, Math.min(maxDay, Number(fromDay)));
    let end   = Math.max(1, Math.min(maxDay, Number(toDay)));
    if (start > end) { const tmp = start; start = end; end = tmp; }
    for (let d = start; d <= end; d++) dates.push(buildYmdFromMonthDay_(month, d));
  }
  return uniq_(dates).sort();
}

function aggregateTrafficForUserMonth_(sheet, userId, month) {
  const table        = readTable_(sheet);
  const submittedSet = {};
  let total = 0;
  if (!table.ok) return { submittedSet, total };
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0 || idx.amount < 0) return { submittedSet, total };
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (sanitizeString_(row[idx.userid]) !== userId) continue;
    if (normalizeYm_(row[idx.workdate]) !== month) continue;
    const ymd = normalizeYmd_(row[idx.workdate]);
    if (ymd) submittedSet[ymd] = true;
    total += toNumber_(row[idx.amount]);
  }
  return { submittedSet, total };
}

function buildPlannedByUser_(shiftSheet, month, project) {
  const table = readTable_(shiftSheet);
  const plannedByUser = {};
  if (!table.ok) return plannedByUser;
  const idx = table.idx;
  if (idx.month < 0 || idx.workdate < 0 || idx.userid < 0) return plannedByUser;
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (sanitizeString_(row[idx.month]) !== month) continue;
    const p   = idx.project >= 0 ? sanitizeString_(row[idx.project]) : '';
    if (project && p !== project) continue;
    const uid = sanitizeString_(row[idx.userid]);
    if (!uid) continue;
    const ymd = normalizeYmd_(row[idx.workdate]);
    if (!ymd) continue;
    const name = idx.name >= 0 ? sanitizeString_(row[idx.name]) : '';
    if (!plannedByUser[uid]) plannedByUser[uid] = { userId: uid, name: '', plannedDates: [] };
    if (!plannedByUser[uid].name && name) plannedByUser[uid].name = name;
    plannedByUser[uid].plannedDates.push(ymd);
  }
  return plannedByUser;
}

function buildPlannedByUserUntil_(shiftSheet, month, untilDate) {
  const table = readTable_(shiftSheet);
  const plannedByUser = {};
  if (!table.ok) return plannedByUser;
  const idx = table.idx;
  if (idx.month < 0 || idx.workdate < 0 || idx.userid < 0) return plannedByUser;
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (sanitizeString_(row[idx.month]) !== month) continue;
    const ymd = normalizeYmd_(row[idx.workdate]);
    if (!ymd || ymd > untilDate) continue;
    const uid  = sanitizeString_(row[idx.userid]);
    if (!uid) continue;
    const name = idx.name >= 0 ? sanitizeString_(row[idx.name]) : '';
    if (!plannedByUser[uid]) plannedByUser[uid] = { userId: uid, name: '', plannedDates: [] };
    if (!plannedByUser[uid].name && name) plannedByUser[uid].name = name;
    plannedByUser[uid].plannedDates.push(ymd);
  }
  return plannedByUser;
}

/**
 * [P1] buildPlannedByUserFeatureFlagged_ — 全ユーザー分を1パスで構築
 * ユーザーごとに listPlannedWorkDates_ を呼ぶのをやめ、
 * buildAllPlannedDatesByUser_ で一括取得してから合算する。
 */
function buildPlannedByUserFeatureFlagged_(ss, month, project, untilDate) {
  // --- ベースユーザー一覧を取得 ---
  const baseByUser = {};
  const shiftSheet = ss.getSheetByName(SHEET_SHIFT_);
  if (shiftSheet) {
    const shiftBase = untilDate
      ? buildPlannedByUserUntil_(shiftSheet, month, untilDate)
      : buildPlannedByUser_(shiftSheet, month, project);
    Object.keys(shiftBase).forEach(function(uid) {
      baseByUser[uid] = { userId: uid, name: sanitizeString_(shiftBase[uid].name) };
    });
  }
  const mode = getShiftSourceMode_();
  if (mode === 'ASSIGNMENTS_FIRST' && !project) {
    const assignmentSheet = ss.getSheetByName('SHIFT_ASSIGNMENTS');
    listAssignmentUserIdsForMonth_(assignmentSheet, month, untilDate).forEach(function(uid) {
      if (!baseByUser[uid]) baseByUser[uid] = { userId: uid, name: '' };
    });
  }

  // --- 1パスで全ユーザーの plannedDates を構築（N×シート読込を廃止）---
  const allDatesByUser = buildAllPlannedDatesByUser_(ss, month, Object.keys(baseByUser), untilDate);

  const out = {};
  Object.keys(baseByUser).forEach(function(uid) {
    let plannedDates = allDatesByUser[uid] || [];
    if (untilDate) plannedDates = plannedDates.filter(function(d) { return d <= untilDate; });
    if (plannedDates.length === 0) return;
    out[uid] = { userId: uid, name: sanitizeString_(baseByUser[uid].name), plannedDates };
  });
  return out;
}

/**
 * [P1] 全ユーザー分の plannedDates を1回のシート読み込みで構築
 * 戻り値: { [userId]: string[] }
 */
function buildAllPlannedDatesByUser_(ss, month, userIds, untilDate) {
  const result   = {};
  const userSet  = {};
  userIds.forEach(function(uid) { if (uid) { userSet[uid] = true; result[uid] = []; } });

  const mode = getShiftSourceMode_();

  // SHIFT_ASSIGNMENTS から全ユーザー分を1パスで収集
  if (mode === 'ASSIGNMENTS_FIRST') {
    const assignmentSheet = ss.getSheetByName('SHIFT_ASSIGNMENTS');
    if (assignmentSheet) {
      const table = readTable_(assignmentSheet);
      if (table.ok && table.values && table.values.length > 1 && table.idx.userid >= 0) {
        const headers   = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
        const idxWorkDate = indexOfHeader_(headers, ['workdate','work_date','date']);
        const idxSegFrom  = indexOfHeader_(headers, ['segmentfromday','segment_from_day']);
        const idxSegTo    = indexOfHeader_(headers, ['segmenttoday','segment_to_day']);
        const idxSiteFrom = indexOfHeader_(headers, ['siteperiodfromday','site_period_from_day']);
        const idxSiteTo   = indexOfHeader_(headers, ['siteperiodtoday','site_period_to_day']);
        const maxDay      = daysInMonthFromYm_(month);
        const values      = table.values;
        for (let r = 1; r < values.length; r++) {
          const row = values[r];
          const uid = sanitizeString_(row[table.idx.userid]);
          if (!uid || !userSet[uid]) continue;
          if (!result[uid]) result[uid] = [];
          if (idxWorkDate >= 0) {
            const ymd = normalizeYmd_(row[idxWorkDate]);
            if (ymd && ymd.slice(0, 7) === month && (!untilDate || ymd <= untilDate)) {
              result[uid].push(ymd);
              continue;
            }
          }
          let fromDay = idxSegFrom >= 0 ? toDayOrNull_(row[idxSegFrom]) : null;
          let toDay   = idxSegTo   >= 0 ? toDayOrNull_(row[idxSegTo])   : null;
          if (fromDay === null && idxSiteFrom >= 0) fromDay = toDayOrNull_(row[idxSiteFrom]);
          if (toDay   === null && idxSiteTo   >= 0) toDay   = toDayOrNull_(row[idxSiteTo]);
          if (fromDay === null && toDay === null) continue;
          if (fromDay === null) fromDay = toDay;
          if (toDay   === null) toDay   = fromDay;
          let start = Math.max(1, Math.min(maxDay, Number(fromDay)));
          let end   = Math.max(1, Math.min(maxDay, Number(toDay)));
          if (start > end) { const tmp = start; start = end; end = tmp; }
          for (let d = start; d <= end; d++) {
            const ymd = buildYmdFromMonthDay_(month, d);
            if (!untilDate || ymd <= untilDate) result[uid].push(ymd);
          }
        }
        // ASSIGNMENTS_FIRST で全ユーザーに日付が入った場合はそのまま返す
        // 空のユーザーは SHIFT フォールバックへ
        const uidsWithDates = Object.keys(result).filter(function(u) { return result[u].length > 0; });
        if (uidsWithDates.length === userIds.length) {
          Object.keys(result).forEach(function(u) { result[u] = uniq_(result[u]).sort(); });
          return result;
        }
      }
    }
  }

  // SHIFT シートから全ユーザー分を1パスで補完
  const shiftSheet = ss.getSheetByName(SHEET_SHIFT_);
  if (shiftSheet) {
    const needsShiftFallback = {};
    const assignmentFirstMode = mode === 'ASSIGNMENTS_FIRST';
    userIds.forEach(function(uid) {
      needsShiftFallback[uid] = assignmentFirstMode ? ((result[uid] || []).length === 0) : true;
    });
    const table = readTable_(shiftSheet);
    if (table.ok && table.idx.month >= 0 && table.idx.workdate >= 0 && table.idx.userid >= 0) {
      const values = table.values;
      const idx    = table.idx;
      for (let r = 1; r < values.length; r++) {
        const row = values[r];
        if (sanitizeString_(row[idx.month]) !== month) continue;
        const uid = sanitizeString_(row[idx.userid]);
        if (!uid || !userSet[uid]) continue;
        if (!needsShiftFallback[uid]) continue;
        const ymd = normalizeYmd_(row[idx.workdate]);
        if (!ymd) continue;
        if (untilDate && ymd > untilDate) continue;
        if (!result[uid]) result[uid] = [];
        result[uid].push(ymd);
      }
    }
  }

  Object.keys(result).forEach(function(u) { result[u] = uniq_(result[u]).sort(); });
  return result;
}

function listAssignmentUserIdsForMonth_(sheet, month, untilDate) {
  if (!sheet) return [];
  if (!/^\d{4}-\d{2}$/.test(sanitizeString_(month))) return [];
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  if (table.idx.userid < 0) return [];
  const headers   = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxWorkDate = indexOfHeader_(headers, ['workdate','work_date','date']);
  const idxSegFrom  = indexOfHeader_(headers, ['segmentfromday','segment_from_day']);
  const idxSegTo    = indexOfHeader_(headers, ['segmenttoday','segment_to_day']);
  const idxSiteFrom = indexOfHeader_(headers, ['siteperiodfromday','site_period_from_day']);
  const idxSiteTo   = indexOfHeader_(headers, ['siteperiodtoday','site_period_to_day']);
  const maxDay  = daysInMonthFromYm_(month);
  const untilDay = (untilDate && untilDate.slice(0, 7) === month) ? toDayOrNull_(untilDate.slice(8, 10)) : null;
  const userSet = {};
  const values  = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const uid = sanitizeString_(row[table.idx.userid]);
    if (!uid) continue;
    if (idxWorkDate >= 0) {
      const ymd = normalizeYmd_(row[idxWorkDate]);
      if (ymd && ymd.slice(0, 7) === month && (!untilDate || ymd <= untilDate)) {
        userSet[uid] = true;
        continue;
      }
    }
    let fromDay = idxSegFrom >= 0 ? toDayOrNull_(row[idxSegFrom]) : null;
    let toDay   = idxSegTo   >= 0 ? toDayOrNull_(row[idxSegTo])   : null;
    if (fromDay === null && idxSiteFrom >= 0) fromDay = toDayOrNull_(row[idxSiteFrom]);
    if (toDay   === null && idxSiteTo   >= 0) toDay   = toDayOrNull_(row[idxSiteTo]);
    if (fromDay === null && toDay === null) continue;
    if (fromDay === null) fromDay = toDay;
    if (toDay   === null) toDay   = fromDay;
    let start = Math.max(1, Math.min(maxDay, Number(fromDay)));
    let end   = Math.max(1, Math.min(maxDay, Number(toDay)));
    if (start > end) { const tmp = start; start = end; end = tmp; }
    if (untilDay !== null && start > untilDay) continue;
    userSet[uid] = true;
  }
  return Object.keys(userSet).sort();
}

function buildSubmittedIndex_(trafficSheet, month) {
  const table          = readTable_(trafficSheet);
  const submittedIndex = {};
  if (!table.ok) return submittedIndex;
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0) return submittedIndex;
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const uid = sanitizeString_(row[idx.userid]);
    if (!uid) continue;
    if (normalizeYm_(row[idx.workdate]) !== month) continue;
    const ymd = normalizeYmd_(row[idx.workdate]);
    if (!ymd) continue;
    if (!submittedIndex[uid]) submittedIndex[uid] = {};
    submittedIndex[uid][ymd] = true;
  }
  return submittedIndex;
}

function buildStaffMapFast_(staffSheet) {
  const table = readTable_(staffSheet);
  const map   = {};
  if (!table.ok) return map;
  const idx    = table.idx;
  if (idx.userid < 0) return map;
  const values = table.values;
  for (let r = 1; r < values.length; r++) {
    const row    = values[r];
    const uid    = sanitizeString_(row[idx.userid]);
    if (!uid) continue;
    map[uid] = {
      name:       idx.name       >= 0 ? sanitizeString_(row[idx.name])       : '',
      project:    idx.project    >= 0 ? sanitizeString_(row[idx.project])    : '',
      lineUserId: idx.lineuserid >= 0 ? sanitizeString_(row[idx.lineuserid]) : '',
      status:     idx.status     >= 0 ? sanitizeString_(row[idx.status])     : '',
      isActive:   idx.isactive   >= 0 ? sanitizeString_(row[idx.isactive])   : '',
      lineFollowStatus: idx.linefollowstatus >= 0 ? sanitizeString_(row[idx.linefollowstatus]) : '',
      fullNameKanji: idx.fullnamekanji >= 0 ? sanitizeString_(row[idx.fullnamekanji]) : '',
      fullNameKana: idx.fullnamekana >= 0 ? sanitizeString_(row[idx.fullnamekana]) : '',
      birthDate: idx.birthdate >= 0 ? normalizeYmd_(row[idx.birthdate]) : '',
      nearestStation: idx.neareststation >= 0 ? sanitizeString_(row[idx.neareststation]) : '',
      phone: idx.phone >= 0 ? normalizePhoneDigits_(row[idx.phone]) : '',
      emergencyRelation: idx.emergencyrelation >= 0 ? sanitizeString_(row[idx.emergencyrelation]) : '',
      emergencyPhone: idx.emergencyphone >= 0 ? normalizePhoneDigits_(row[idx.emergencyphone]) : '',
      postalCode: idx.postalcode >= 0 ? normalizePostalCode_(row[idx.postalcode]) : '',
      address: idx.address >= 0 ? sanitizeString_(row[idx.address]) : ''
    };
  }
  return map;
}

function readTable_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { ok: false, values: [], idx: {} };
  const values  = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => normalizeHeaderKey_(h));
  const idx = {
    month:      indexOfHeader_(headers, ['month']),
    workdate:   indexOfHeader_(headers, ['workdate','work_date','date']),
    project:    indexOfHeader_(headers, ['project','projectid','project_id']),
    userid:     indexOfHeader_(headers, ['userid','user_id','user']),
    name:       indexOfHeader_(headers, ['name']),
    amount:     indexOfHeader_(headers, ['amount','price','cost']),
    lineuserid: indexOfHeader_(headers, ['lineuserid','line_user_id','lineid']),
    needhotel:  indexOfHeader_(headers, ['needhotel','need_hotel']),
    smoking:    indexOfHeader_(headers, ['smoking']),
    source:     indexOfHeader_(headers, ['source']),
    status:     indexOfHeader_(headers, ['status']),
    isactive:   indexOfHeader_(headers, ['isactive', 'is_active']),
    linefollowstatus: indexOfHeader_(headers, ['linefollowstatus', 'line_follow_status']),
    fullnamekanji: indexOfHeader_(headers, ['fullnamekanji', 'full_name_kanji']),
    fullnamekana: indexOfHeader_(headers, ['fullnamekana', 'full_name_kana']),
    birthdate: indexOfHeader_(headers, ['birthdate', 'birth_date']),
    neareststation: indexOfHeader_(headers, ['neareststation', 'nearest_station']),
    phone: indexOfHeader_(headers, ['phone', 'tel']),
    emergencyrelation: indexOfHeader_(headers, ['emergencyrelation', 'emergency_relation']),
    emergencyphone: indexOfHeader_(headers, ['emergencyphone', 'emergency_phone']),
    postalcode: indexOfHeader_(headers, ['postalcode', 'postal_code']),
    address: indexOfHeader_(headers, ['address'])
  };
  return { ok: true, values, idx };
}

function normalizeHeaderKey_(v) {
  return sanitizeString_(v).toLowerCase().replace(/\s+/g, '');
}

function indexOfHeader_(headers, keys) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    for (let k = 0; k < keys.length; k++) {
      if (h === keys[k]) return i;
    }
  }
  return -1;
}

/* =========================================================
 * Envelope + validation
 * =======================================================*/

function getRequestBodyText_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') return '';
  return e.postData.contents.trim();
}

function validateEnvelope_(req) {
  if (!req || typeof req !== 'object')           return { ok: false, code: 'E_INVALID_REQUEST', message: 'Request must be a JSON object.' };
  if (sanitizeString_(req.action) === '')        return { ok: false, code: 'E_MISSING_ACTION',  message: 'Missing action.' };
  if (!Object.prototype.hasOwnProperty.call(req, 'token')) return { ok: false, code: 'E_MISSING_TOKEN', message: 'Missing token.' };
  if (!req.data || typeof req.data !== 'object') return { ok: false, code: 'E_MISSING_DATA',   message: 'Missing data object.' };
  return { ok: true };
}

function validateTrafficData_(data) {
  const errors      = [];
  const userId      = sanitizeString_(data && data.userId);
  const workDate    = sanitizeString_(data && data.workDate);
  const fromStation = sanitizeString_(data && data.fromStation);
  const toStation   = sanitizeString_(data && data.toStation);
  const roundTrip   = sanitizeString_(data && data.roundTrip);
  const amount      = Number(data && data.amount);
  if (!userId)    errors.push({ field: 'userId',    reason: 'required' });
  if (!workDate)  errors.push({ field: 'workDate',  reason: 'required' });
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) errors.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (!fromStation) errors.push({ field: 'fromStation', reason: 'required' });
  if (!toStation)   errors.push({ field: 'toStation',   reason: 'required' });
  if (!Number.isFinite(amount) || amount <= 0) errors.push({ field: 'amount', reason: 'must be number > 0' });
  if (roundTrip !== '片道' && roundTrip !== '往復') errors.push({ field: 'roundTrip', reason: 'must be "片道" or "往復"' });
  return { ok: errors.length === 0, details: { fields: errors } };
}

/**
 * [P13] リクエスト内ワンショットキャッシュで PropertiesService 多重呼び出しを防ぐ
 */
function getConfig_() {
  if (CONFIG_REQUEST_CACHE_ && CONFIG_REQUEST_CACHE_.ok) return CONFIG_REQUEST_CACHE_;
  const props        = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');
  const staffToken    = props.getProperty('STAFF_TOKEN');
  const missing = [];
  if (!spreadsheetId) missing.push('SPREADSHEET_ID');
  if (!staffToken)    missing.push('STAFF_TOKEN');
  if (missing.length) {
    return { ok: false, code: 'E_CONFIG_MISSING', message: 'Missing script properties.', details: { missing } };
  }
  CONFIG_REQUEST_CACHE_ = { ok: true, values: { SPREADSHEET_ID: spreadsheetId, STAFF_TOKEN: staffToken } };
  return CONFIG_REQUEST_CACHE_;
}

function getShiftSourceMode_() {
  const props = PropertiesService.getScriptProperties();
  const raw   = sanitizeString_(props.getProperty('SP_SHIFT_SOURCE_MODE')).toUpperCase();
  return raw === 'ASSIGNMENTS_FIRST' ? 'ASSIGNMENTS_FIRST' : 'SHIFT_FIRST';
}

/* =========================================================
 * Utilities
 * =======================================================*/

function sanitizeString_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sanitizeSheetCellValue_(value) {
  if (typeof value !== 'string') return value;
  if (!value) return value;
  return /^[=+\-@]/.test(value) ? ("'" + value) : value;
}

function sanitizeSheetRowValues_(row) {
  return (Array.isArray(row) ? row : []).map(function(cell) {
    return sanitizeSheetCellValue_(cell);
  });
}

function sanitizeSheetMatrixValues_(matrix) {
  return (Array.isArray(matrix) ? matrix : []).map(function(row) {
    return sanitizeSheetRowValues_(row);
  });
}

function appendRowSanitized_(sheet, row) {
  sheet.appendRow(sanitizeSheetRowValues_(row));
}

function setRangeValueSanitized_(range, value) {
  range.setValue(sanitizeSheetCellValue_(value));
}

function setRangeValuesSanitized_(range, values) {
  range.setValues(sanitizeSheetMatrixValues_(values));
}

function toNumber_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeYmd_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TZ_, 'yyyy-MM-dd');
  const s = sanitizeString_(value);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ_, 'yyyy-MM-dd');
  return '';
}

function normalizeYm_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TZ_, 'yyyy-MM');
  const s = sanitizeString_(value);
  if (!s) return '';
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ_, 'yyyy-MM');
  return '';
}

function daysInMonthFromYm_(month) {
  const ym = sanitizeString_(month);
  const m  = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return 31;
  const y   = Number(m[1]);
  const mon = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mon) || mon < 1 || mon > 12) return 31;
  return new Date(y, mon, 0).getDate();
}

function buildYmdFromMonthDay_(month, day) {
  const d  = Number(day);
  const dd = d < 10 ? '0' + d : String(d);
  return sanitizeString_(month) + '-' + dd;
}

function uniq_(arr) {
  const seen = {};
  const out  = [];
  for (let i = 0; i < arr.length; i++) {
    const k = String(arr[i] || '');
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function parseNeedHotel_(value) {
  if (value === true || value === false) return value;
  const s = sanitizeString_(value).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

function normalizeSmoking_(value) {
  const s = sanitizeString_(value).toLowerCase();
  if (s === 'non' || s === 'smoke' || s === 'none') return s;
  if (s === '禁煙') return 'non';
  if (s === '喫煙') return 'smoke';
  return '';
}

function splitCsvLike_(value) {
  const text = sanitizeString_(value);
  if (!text) return [];
  return uniq_(text.split(',').map(function(v) { return sanitizeString_(v); }).filter(Boolean));
}

function normalizePhoneDigits_(value) {
  return sanitizeString_(value).replace(/[^\d]/g, '');
}

function normalizePostalCode_(value) {
  return sanitizeString_(value).replace(/[^\d]/g, '');
}

function isFullNameWithSpace_(value) {
  return /^[^ \u3000]+[ \u3000][^ \u3000]+$/.test(sanitizeString_(value));
}

function isKanaNameWithSpace_(value) {
  return /^[ァ-ヶー]+[ \u3000][ァ-ヶー]+$/.test(sanitizeString_(value));
}

function normalizeLineFollowStatus_(value) {
  const text = sanitizeString_(value).toLowerCase();
  if (text === 'unfollow' || text === 'unfollowed') return 'unfollow';
  return 'follow';
}

function parseBooleanValue_(value, fallback) {
  if (value === true || value === false) return value;
  const text = sanitizeString_(value).toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return Boolean(fallback);
}

function resolveIsActiveFromInput_(rawIsActive, status) {
  const statusText = sanitizeString_(status).toLowerCase();
  if (statusText === 'inactive') return false;
  return parseBooleanValue_(rawIsActive, true);
}

function toLegacyStaffStatus_(isActive, lineFollowStatus) {
  if (!isActive) return 'inactive';
  if (lineFollowStatus === 'unfollow') return 'unfollowed';
  return 'active';
}

function isStaffPushTarget_(staff) {
  // Spec: v5_spec 3.1 Staff Master targeting filter
  const lineFollowStatus = normalizeLineFollowStatus_(sanitizeString_(staff && staff.lineFollowStatus) || sanitizeString_(staff && staff.status));
  const isActive = resolveIsActiveFromInput_(staff && staff.isActive, sanitizeString_(staff && staff.status));
  return isActive && lineFollowStatus === 'follow' && isStaffRegistrationComplete_(staff);
}

function isStaffRegistrationComplete_(staff) {
  const record = staff && typeof staff === 'object' ? staff : {};
  const nameKanji = sanitizeString_(record.fullNameKanji || record.name);
  const nameKana = sanitizeString_(record.fullNameKana || record.nameKana || record.kana);
  const birthDate = normalizeYmd_(record.birthDate);
  const nearestStation = sanitizeString_(record.nearestStation || record.station);
  const phone = normalizePhoneDigits_(record.phone || record.tel);
  const emergencyRelation = sanitizeString_(record.emergencyRelation);
  const emergencyPhone = normalizePhoneDigits_(record.emergencyPhone);
  const postalCode = normalizePostalCode_(record.postalCode);
  const address = sanitizeString_(record.address);

  return Boolean(
    nameKanji &&
    nameKana &&
    birthDate &&
    nearestStation &&
    phone &&
    emergencyRelation &&
    emergencyPhone &&
    postalCode &&
    address
  );
}

function getFieldFromRowByKeys_(headers, row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const key = normalizeHeaderKey_(keys[i]);
    const idx = indexOfHeader_(headers, [key]);
    if (idx < 0) continue;
    const value = sanitizeString_(row[idx]);
    if (value) return value;
  }
  return '';
}

function buildStaffDataHash_(payload) {
  const text = safeJsonStringify_(payload && typeof payload === 'object' ? payload : {});
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function buildEmptyRegistrationState_(userId, lineUserId) {
  return {
    userId: sanitizeString_(userId),
    registered: false,
    registrationStatus: 'unregistered',
    missingFields: REGISTRATION_REQUIRED_FIELDS_.slice(),
    staff: {
      lineUserId: sanitizeString_(lineUserId) || sanitizeString_(userId),
      nameKanji: '',
      nameKana: '',
      nearestStation: '',
      isActive: true,
      lineFollowStatus: 'follow'
    }
  };
}

function buildRegistrationStateFromRow_(headerRow, row, userId, lineUserId) {
  // Spec: api_schema 1 Register status response fields
  const headers = (Array.isArray(headerRow) ? headerRow : []).map(function(h) { return normalizeHeaderKey_(h); });
  const record = Array.isArray(row) ? row : [];

  const nameKanji = getFieldFromRowByKeys_(headers, record, ['fullNameKanji', 'name']);
  const nameKana = getFieldFromRowByKeys_(headers, record, ['fullNameKana', 'nameKana', 'kana']);
  const birthDate = normalizeYmd_(getFieldFromRowByKeys_(headers, record, ['birthDate']));
  const nearestStation = getFieldFromRowByKeys_(headers, record, ['nearestStation', 'station']);
  const phone = normalizePhoneDigits_(getFieldFromRowByKeys_(headers, record, ['phone', 'tel']));
  const emergencyRelation = getFieldFromRowByKeys_(headers, record, ['emergencyRelation']);
  const emergencyPhone = normalizePhoneDigits_(getFieldFromRowByKeys_(headers, record, ['emergencyPhone']));
  const postalCode = normalizePostalCode_(getFieldFromRowByKeys_(headers, record, ['postalCode']));
  const address = getFieldFromRowByKeys_(headers, record, ['address']);
  const isActive = resolveIsActiveFromInput_(getFieldFromRowByKeys_(headers, record, ['isActive']), getFieldFromRowByKeys_(headers, record, ['status']));
  const lineFollowStatus = normalizeLineFollowStatus_(getFieldFromRowByKeys_(headers, record, ['lineFollowStatus', 'status']));

  const byKey = {
    nameKanji: nameKanji,
    nameKana: nameKana,
    birthDate: birthDate,
    nearestStation: nearestStation,
    phone: phone,
    emergencyRelation: emergencyRelation,
    emergencyPhone: emergencyPhone,
    postalCode: postalCode,
    address: address
  };

  const missingFields = REGISTRATION_REQUIRED_FIELDS_.filter(function(field) {
    return !sanitizeString_(byKey[field]);
  });

  return {
    userId: sanitizeString_(userId),
    registered: missingFields.length === 0,
    registrationStatus: missingFields.length === 0 ? 'registered' : 'unregistered',
    missingFields: missingFields,
    staff: {
      lineUserId: sanitizeString_(lineUserId) || sanitizeString_(userId),
      nameKanji: nameKanji,
      nameKana: nameKana,
      birthDate: birthDate,
      nearestStation: nearestStation,
      phone: phone,
      emergencyRelation: emergencyRelation,
      emergencyPhone: emergencyPhone,
      postalCode: postalCode,
      address: address,
      isActive: isActive,
      lineFollowStatus: lineFollowStatus
    }
  };
}

function normalizeShiftRawRecentLimit_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function buildShiftRawTextPreview_(value) {
  const normalized = sanitizeString_(value).replace(/\r\n|\r|\n/g, '\\n');
  return normalized.length <= 120 ? normalized : normalized.slice(0, 120);
}

/**
 * Parse @All shift raw text — pure, no side effects
 */
function parseShiftAllRawText_(rawText) {
  const errors = [];
  const blocks = [];
  try {
    const rawBlocks = splitBlocks_(rawText);
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = rawBlocks[i];
      const rows  = Array.isArray(block && block.lines) ? block.lines : [];
      if (rows.length === 0) continue;
      let headerIndex = -1, parsedHeader = null;
      for (let j = 0; j < rows.length; j++) {
        const candidate = parseSiteHeader_(rows[j].lineText);
        if (candidate.ok) { headerIndex = j; parsedHeader = candidate; break; }
      }
      if (headerIndex < 0 || !parsedHeader || !parsedHeader.ok) {
        const head = rows[0];
        errors.push({ code: 'E_SITE_HEADER_PARSE', blockIndex: i, rawLine: Number(head && head.rawLine ? head.rawLine : 0), headerLine: String(head && head.lineText ? head.lineText : ''), reason: 'header_pattern_unmatched' });
        blocks.push({ siteRaw: '', periodFromDay: null, periodToDay: null, lines: rows.map(function(row) { return { rawLine: Number(row && row.rawLine ? row.rawLine : 0), lineText: String(row && row.lineText ? row.lineText : '') }; }) });
        continue;
      }
      blocks.push({
        siteRaw:       parsedHeader.siteRaw,
        periodFromDay: parsedHeader.periodFromDay,
        periodToDay:   parsedHeader.periodToDay,
        lines: rows.slice(headerIndex + 1).map(function(row) { return { rawLine: Number(row && row.rawLine ? row.rawLine : 0), lineText: String(row && row.lineText ? row.lineText : '') }; })
      });
    }
  } catch (err) {
    errors.push({ code: 'E_PARSE_UNEXPECTED', reason: String(err && err.message ? err.message : err) });
  }
  return { ok: true, blocks, errors };
}

function splitBlocks_(rawText) {
  const text = String(rawText === null || rawText === undefined ? '' : rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows  = text.split('\n');
  const blocks = [];
  let current = [];
  for (let i = 0; i < rows.length; i++) {
    const line = String(rows[i] || '');
    if (line.trim() === '') {
      if (current.length > 0) { blocks.push({ lines: current }); current = []; }
      continue;
    }
    current.push({ rawLine: i + 1, lineText: line });
  }
  if (current.length > 0) blocks.push({ lines: current });
  return blocks;
}

function parseSiteHeader_(line) {
  const header = String(line === null || line === undefined ? '' : line).trim();
  if (!header) return { ok: false, reason: 'empty_header' };
  const match = header.match(/^(.+?)\s*[（(]\s*(\d{1,2})\s*日\s*[～~\-]\s*(\d{1,2})\s*日\s*[)）]\s*$/);
  if (!match)  return { ok: false, reason: 'header_pattern_unmatched' };
  const siteRaw = String(match[1] || '').trim();
  const fromDay = Number(match[2]);
  const toDay   = Number(match[3]);
  if (!siteRaw)                                            return { ok: false, reason: 'empty_site' };
  if (!Number.isInteger(fromDay) || !Number.isInteger(toDay)) return { ok: false, reason: 'invalid_period_number' };
  if (fromDay < 1 || fromDay > 31 || toDay < 1 || toDay > 31) return { ok: false, reason: 'period_out_of_range' };
  return { ok: true, siteRaw, periodFromDay: fromDay, periodToDay: toDay };
}

function getHomeNearestStation_(ss, userId) {
  const uid = sanitizeString_(userId);
  if (!uid) return '';
  const staffSheet = resolveStaffMasterSheetForRegistration_(ss);
  if (!staffSheet) return '';
  const table = readTable_(staffSheet);
  if (!table.ok || !table.values || table.values.length <= 1) return '';
  const headers           = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxUserId         = indexOfHeader_(headers, ['userid','user_id','user']);
  const idxNearestStation = indexOfHeader_(headers, ['neareststation','nearest_station','station']);
  if (idxUserId < 0 || idxNearestStation < 0) return '';
  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (sanitizeString_(row[idxUserId]) !== uid) continue;
    return sanitizeString_(row[idxNearestStation]);
  }
  return '';
}

/* =========================================================
 * Traffic dedup helpers — [P4] CacheService 移行
 * =======================================================*/

function buildTrafficMemoWithRequestId_(memo, requestId) {
  const cleanMemo      = sanitizeString_(memo);
  const cleanRequestId = sanitizeString_(requestId);
  if (!cleanRequestId) return cleanMemo;
  if (extractRequestIdFromTrafficMemo_(cleanMemo) === cleanRequestId) return cleanMemo;
  const marker = TRAFFIC_REQUEST_MEMO_PREFIX_ + cleanRequestId + TRAFFIC_REQUEST_MEMO_SUFFIX_;
  return cleanMemo ? cleanMemo + ' ' + marker : marker;
}

function extractRequestIdFromTrafficMemo_(memo) {
  const text = sanitizeString_(memo);
  if (!text) return '';
  const escapedPrefix = TRAFFIC_REQUEST_MEMO_PREFIX_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSuffix = TRAFFIC_REQUEST_MEMO_SUFFIX_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(escapedPrefix + '(.*?)' + escapedSuffix));
  return match ? sanitizeString_(match[1]) : '';
}

/**
 * [P11] TRAFFIC_LOG のメモ列インデックスを動的に解決（ハードコード依存を低減）
 * ヘッダーが見つからない場合はフォールバック定数を使用
 */
function resolveTrafficMemoColIndex_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return TRAFFIC_MEMO_COL_FALLBACK_;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idx     = indexOfHeader_(headers, ['memo', 'note', 'remarks']);
  return idx >= 0 ? idx + 1 : TRAFFIC_MEMO_COL_FALLBACK_;
}

/**
 * [P4] ScriptProperties → CacheService
 */
function getTrafficCacheKey_(requestId) {
  const cleanRequestId = sanitizeString_(requestId);
  if (!cleanRequestId) return '';
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, cleanRequestId, Utilities.Charset.UTF_8);
  return TRAFFIC_REQUEST_CACHE_PREFIX_ + bytesToHex_(digest);
}

function getTrafficRowByRequestIndex_(sheet, requestId) {
  const key = getTrafficCacheKey_(requestId);
  if (!key) return 0;
  const cache  = CacheService.getScriptCache();
  const rawRow = cache.get(key);
  if (!rawRow) return 0;
  const rowNumber = Number(rawRow);
  const lastRow   = sheet.getLastRow();
  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
    cache.remove(key);
    return 0;
  }
  const memoCol  = resolveTrafficMemoColIndex_(sheet);
  const memoValue = sheet.getRange(rowNumber, memoCol, 1, 1).getValue();
  if (extractRequestIdFromTrafficMemo_(memoValue) === sanitizeString_(requestId)) {
    return rowNumber;
  }
  cache.remove(key);
  return 0;
}

function findTrafficRowByRequestId_(sheet, requestId) {
  const targetRequestId = sanitizeString_(requestId);
  if (!targetRequestId) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const memoCol    = resolveTrafficMemoColIndex_(sheet);
  const memoValues = sheet.getRange(2, memoCol, lastRow - 1, 1).getValues();
  for (let i = 0; i < memoValues.length; i++) {
    if (extractRequestIdFromTrafficMemo_(memoValues[i][0]) === targetRequestId) {
      return i + 2;
    }
  }
  return 0;
}

function setTrafficRequestIndex_(requestId, rowNumber) {
  const key = getTrafficCacheKey_(requestId);
  if (!key || !Number.isInteger(rowNumber) || rowNumber < 2) return;
  // [P4] CacheService に TTL 付きで保存（ScriptProperties の容量問題を解消）
  CacheService.getScriptCache().put(key, String(rowNumber), TRAFFIC_REQUEST_CACHE_TTL_SEC_);
}

function bytesToHex_(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const n = (bytes[i] + 256) % 256;
    out.push((n < 16 ? '0' : '') + n.toString(16));
  }
  return out.join('');
}

/* =========================================================
 * Send guard helpers
 * =======================================================*/

function buildHotelSendGuardKey_(date, projectId, lineUserId) {
  return 'hotel|' + sanitizeString_(date) + '|' + sanitizeString_(projectId) + '|' + sanitizeString_(lineUserId);
}

function buildReminderSendGuardKey_(date, lineUserId) {
  return 'reminder|' + sanitizeString_(date) + '|' + sanitizeString_(lineUserId);
}

function isSendGuardStatus_(value) {
  return value === 'pushed' || value === 'failed';
}

function resolveSendGuardStaleState_(status, createdAtValue, ttlMs) {
  if (sanitizeString_(status).toLowerCase() !== 'sending') return { stale: false, createdAtMs: 0, ageMs: 0 };
  const createdAtMs = toEpochMs_(createdAtValue);
  const nowMs       = Date.now();
  if (createdAtMs <= 0) return { stale: true, createdAtMs: 0, ageMs: -1 };
  const ageMs = nowMs - createdAtMs;
  return { stale: ageMs >= ttlMs, createdAtMs, ageMs };
}

function getSendGuardSendingTtlMs_() {
  const defaultSeconds = 600;
  const props      = PropertiesService.getScriptProperties();
  const rawSeconds = sanitizeString_(props.getProperty('SEND_GUARD_SENDING_TTL_SECONDS'));
  const seconds    = Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultSeconds * 1000;
  return Math.floor(seconds * 1000);
}

function toEpochMs_(value) {
  if (value instanceof Date) return value.getTime();
  const text = sanitizeString_(value);
  if (!text) return 0;
  const date    = new Date(text);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs) || isNaN(epochMs)) return 0;
  return epochMs;
}

function findHotelSentLogRow_(sheet, date, projectId, lineUserId) {
  const table = readTable_(sheet);
  if (!table.ok) return 0;
  const idx = table.idx;
  if (idx.workdate < 0 || idx.project < 0 || idx.lineuserid < 0) return 0;
  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (normalizeYmd_(row[idx.workdate]) === date && sanitizeString_(row[idx.project]) === projectId && sanitizeString_(row[idx.lineuserid]) === lineUserId) {
      return r + 1;
    }
  }
  return 0;
}

function findReminderSentLogRow_(sheet, date, lineUserId) {
  const table = readTable_(sheet);
  if (!table.ok) return 0;
  const idx = table.idx;
  if (idx.workdate < 0 || idx.lineuserid < 0) return 0;
  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (normalizeYmd_(row[idx.workdate]) === date && sanitizeString_(row[idx.lineuserid]) === lineUserId) {
      return r + 1;
    }
  }
  return 0;
}

function findShiftRawRowByMessageId_(sheet, rawMessageId) {
  const targetId = sanitizeString_(rawMessageId);
  if (!targetId) return 0;
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return 0;
  const headers        = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxRawMessageId = indexOfHeader_(headers, ['rawmessageid','raw_message_id']);
  if (idxRawMessageId < 0) return 0;
  for (let r = table.values.length - 1; r >= 1; r--) {
    if (sanitizeString_(table.values[r][idxRawMessageId]) === targetId) return r + 1;
  }
  return 0;
}

/* =========================================================
 * Logging
 * =======================================================*/

function logSendGuard_(event, requestId, details) {
  Logger.log(JSON.stringify(redactLogPayload_(Object.assign({ event, requestId }, details || {}))));
}

function redactLogPayload_(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out  = {};
  const keys = Object.keys(payload);
  for (let i = 0; i < keys.length; i++) {
    const key   = keys[i];
    const value = payload[key];
    if (isSensitiveLogKey_(key)) { out[key] = '[REDACTED]'; continue; }
    if (typeof value === 'string') { out[key] = value.length > 200 ? value.slice(0, 200) + '...[truncated]' : value; continue; }
    out[key] = value;
  }
  return out;
}

/**
 * [P7] Set ベースに変更（name による過剰マッチを修正）
 */
const SENSITIVE_LOG_KEYS_ = new Set([
  'token', 'secret', 'authorization', 'apikey',
  'userid', 'lineuserid',
  'phone', 'tel', 'address'
  // 注意: 'name' は意図的に除外（siteNameNorm 等がREDACTEDになる問題を修正）
]);

function isSensitiveLogKey_(key) {
  const normalized = sanitizeString_(key).toLowerCase().replace(/[\s_\-]/g, '');
  if (!normalized) return false;
  return SENSITIVE_LOG_KEYS_.has(normalized);
}

/* =========================================================
 * Sheet ensurers
 * =======================================================*/

function ensureHotelIntentSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_HOTEL_INTENT_);
  if (!sheet) sheet = ss.insertSheet(SHEET_HOTEL_INTENT_);
  ensureHeaderRowIfEmpty_(sheet, ['timestamp','userId','projectId','workDate','needHotel','smoking','source','status']);
  return sheet;
}

function ensureHotelSentLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_HOTEL_SENT_LOG_);
  if (!sheet) sheet = ss.insertSheet(SHEET_HOTEL_SENT_LOG_);
  ensureHeaderRowIfEmpty_(sheet, ['date','projectId','lineUserId','status','requestId','createdAt']);
  return sheet;
}

function ensureReminderSentLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_REMINDER_SENT_LOG_);
  if (!sheet) sheet = ss.insertSheet(SHEET_REMINDER_SENT_LOG_);
  ensureHeaderRowIfEmpty_(sheet, ['date','lineUserId','status','requestId','createdAt']);
  return sheet;
}

function ensureStaffMasterSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_STAFF_);
  if (!sheet) sheet = ss.insertSheet(SHEET_STAFF_);
  // Spec: registration_spec 4 Master Fields / v5_spec 3.1 Staff Master
  ensureHeaderRowIfEmpty_(sheet, ['userId','name','project','lineUserId','status','updatedAt','fullNameKanji','fullNameKana','nameKana','kana','birthDate','phone','tel','emergencyRelation','emergencyPhone','postalCode','nearestStation','station','address','isActive','lineFollowStatus','updatedBy','dataHash','aliases']);
  ensureHeaderColumnsExist_(sheet, ['userId','name','project','lineUserId','status','updatedAt','fullNameKanji','fullNameKana','nameKana','kana','birthDate','phone','tel','emergencyRelation','emergencyPhone','postalCode','nearestStation','station','address','isActive','lineFollowStatus','updatedBy','dataHash','aliases']);
  return sheet;
}

function ensureSiteMasterSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_SITE_MASTER_);
  if (!sheet) sheet = ss.insertSheet(SHEET_SITE_MASTER_);
  ensureHeaderRowIfEmpty_(sheet, ['siteId','projectId','workDate','siteName','siteAddress','nearestStations','aliases','updatedAt']);
  return sheet;
}

function ensureShiftRawSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_SHIFT_RAW_);
  if (!sheet) sheet = ss.insertSheet(SHEET_SHIFT_RAW_);
  ensureHeaderRowIfEmpty_(sheet, ['rawMessageId','timestamp','source','lineGroupId','lineUserId','rawText','parserVersion','parseStatus','error','requestId']);
  return sheet;
}

/**
 * [P10] ensureHeaderColumnExists_ の3連続呼び出しを一括処理に変更
 */
function ensureShiftAssignmentsSheet_(ss) {
  let sheet = ss.getSheetByName('SHIFT_ASSIGNMENTS');
  if (!sheet) sheet = ss.insertSheet('SHIFT_ASSIGNMENTS');
  const baseHeaders = [
    'assignmentId','rawMessageId','userId','rawLine','parserVersion',
    'siteId','siteNameNorm','siteRaw',
    'sitePeriodFromDay','sitePeriodToDay',
    'role','segmentFromDay','segmentToDay',
    'staffNameRaw','staffKanaRaw','status','createdAt'
  ];
  ensureHeaderRowIfEmpty_(sheet, baseHeaders);
  // 既存ヘッダーに不足列があれば一括追加
  ensureHeaderColumnsExist_(sheet, ['userId','siteId','siteNameNorm']);
  return sheet;
}

function ensureTrafficPairSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_TRAFFIC_PAIR_);
  if (!sheet) sheet = ss.insertSheet(SHEET_TRAFFIC_PAIR_);
  ensureHeaderRowIfEmpty_(sheet, ['pairKey','timestamp','workKey','workDate','userId','siteId','type','fromStation','toStation','amount','rawDate','requestId']);
  return sheet;
}

/* =========================================================
 * Responses
 * =======================================================*/

function okResponse_(data, requestId) {
  return jsonResponse_({ ok: true, data, meta: { requestId, timestamp: new Date().toISOString() } });
}

function errorResponse_(code, message, details, requestId, retryable) {
  return jsonResponse_({ ok: false, error: { code, message, details: details || {}, retryable: Boolean(retryable) }, meta: { requestId, timestamp: new Date().toISOString() } });
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
 * Misc helpers
 * =======================================================*/

function pick_(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== '' && obj[k] !== null && obj[k] !== undefined) return obj[k];
  }
  return '';
}

function getSheetByCanonicalOrAlias_(ss, canonical) {
  const canonicalName = sanitizeString_(canonical);
  if (!canonicalName) return null;
  const aliases = SHEET_CANONICAL_ALIASES_[canonicalName] || [canonicalName];
  for (let i = 0; i < aliases.length; i++) {
    const hit = ss.getSheetByName(sanitizeString_(aliases[i]));
    if (hit) return hit;
  }
  return null;
}

function ensureSheetByCanonical_(ss, canonical) {
  const canonicalName = sanitizeString_(canonical);
  if (!canonicalName) return null;
  let sheet = getSheetByCanonicalOrAlias_(ss, canonicalName);
  if (!sheet) sheet = ss.insertSheet(canonicalName);
  const canonicalHeaders = SHEET_CANONICAL_HEADERS_[canonicalName] || [];
  ensureHeaderRowIfEmpty_(sheet, canonicalHeaders);
  ensureHeaderColumnsExist_(sheet, canonicalHeaders);
  return sheet;
}

function ensureHeaderRowIfEmpty_(sheet, headers) {
  if (!sheet || !Array.isArray(headers) || headers.length === 0) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  const readWidth = Math.max(sheet.getLastColumn(), headers.length);
  const firstRow  = sheet.getRange(1, 1, 1, readWidth).getValues()[0];
  const hasValue  = firstRow.some(function(v) { return sanitizeString_(v) !== ''; });
  if (hasValue) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

/**
 * [P10] 複数列の存在チェックを一括処理（ensureHeaderColumnExists_ の3連呼び出し廃止）
 */
function ensureHeaderColumnsExist_(sheet, headerNames) {
  if (!sheet || !Array.isArray(headerNames) || headerNames.length === 0) return;
  let lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    // 空シートに一括書き込み
    sheet.getRange(1, 1, 1, headerNames.length).setValues([headerNames]);
    return;
  }
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const toAdd   = headerNames.filter(function(name) {
    return indexOfHeader_(headers, [normalizeHeaderKey_(name)]) < 0;
  });
  if (toAdd.length === 0) return;
  // まとめて1回のsetValuesで追加
  sheet.getRange(1, lastCol + 1, 1, toAdd.length).setValues([toAdd]);
}

// 旧 ensureHeaderColumnExists_ は互換のため残す（内部では ensureHeaderColumnsExist_ を使用）
function ensureHeaderColumnExists_(sheet, headerName) {
  ensureHeaderColumnsExist_(sheet, [headerName]);
}

function withScriptLock_(requestId, fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return errorResponse_('E_LOCK_TIMEOUT', 'System busy. Retry later.', { reason: String(err && err.message ? err.message : err) }, requestId, true);
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function upsertSheetRowById_(sheet, idCol, idValue, patch) {
  const patchObj = patch && typeof patch === 'object' ? patch : {};
  const requiredHeaders = [idCol].concat(Object.keys(patchObj));
  ensureHeaderColumnsExist_(sheet, requiredHeaders);
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length === 0) {
    return { ok: false, code: 'E_VALIDATION', message: 'Validation failed.', details: { fields: [{ field: 'sheet', reason: 'header_missing' }] } };
  }
  const headers          = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idKey            = normalizeHeaderKey_(idCol);
  const idIndex          = indexOfHeader_(headers, [idKey]);
  if (idIndex < 0) {
    return { ok: false, code: 'E_VALIDATION', message: 'Validation failed.', details: { fields: [{ field: idCol, reason: 'column_not_found' }] } };
  }
  const normalizedIdValue = sanitizeString_(idValue);
  if (!normalizedIdValue) {
    return { ok: false, code: 'E_VALIDATION', message: 'Validation failed.', details: { fields: [{ field: idCol, reason: 'required' }] } };
  }
  let rowNumber = -1;
  for (let r = 1; r < table.values.length; r++) {
    if (sanitizeString_(table.values[r][idIndex]) === normalizedIdValue) { rowNumber = r + 1; break; }
  }
  const lastCol  = Math.max(sheet.getLastColumn(), headers.length);
  const created  = rowNumber < 0;
  if (created) rowNumber = sheet.getLastRow() + 1;
  const rowValues = created
    ? new Array(lastCol).fill('')
    : sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  if (idIndex >= 0) rowValues[idIndex] = normalizedIdValue;
  Object.keys(patchObj).forEach(function(key) {
    const keyIndex = indexOfHeader_(headers, [normalizeHeaderKey_(key)]);
    if (keyIndex >= 0) rowValues[keyIndex] = patchObj[key];
  });
  setRangeValuesSanitized_(sheet.getRange(rowNumber, 1, 1, lastCol), [rowValues]);
  return { ok: true, row: rowNumber, created };
}

function resolveStaffMasterSheetForRegistration_(ss) {
  let sheet = null;
  try { sheet = ensureSheetByCanonical_(ss, 'STAFF_MASTER'); } catch (err) { sheet = null; }
  if (!sheet) {
    try { sheet = ensureStaffMasterSheet_(ss); } catch (err) { sheet = null; }
  }
  if (!sheet) return null;
  const table = readTable_(sheet);
  if (table.ok && table.idx.userid >= 0) return sheet;
  try { return ensureStaffMasterSheet_(ss); } catch (err) { return sheet; }
}

function safeJsonStringify_(value) {
  try {
    return JSON.stringify(value === undefined ? {} : value);
  } catch (err) {
    return JSON.stringify({ stringifyError: true, reason: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: { message: 'WebApp is alive. Use POST for API.' }, meta: { timestamp: new Date().toISOString() } }))
    .setMimeType(ContentService.MimeType.JSON);
}

function DEBUG_shiftLastRow_() {
  const props = PropertiesService.getScriptProperties();
  const ss    = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  const sh    = ss.getSheetByName('SHIFT');
  Logger.log({ sheetFound: !!sh, lastRow: sh ? sh.getLastRow() : null, lastCol: sh ? sh.getLastColumn() : null });
}
