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
const SHEET_EXPENSE_LOG_ = 'EXPENSE_LOG';
const SHEET_HOTEL_INTENT_ = 'HOTEL_INTENT_LOG';
const SHEET_HOTEL_CONFIRMED_ = 'HOTEL_CONFIRMED_LOG';
const SHEET_MONTHLY_EXPORT_LOG_ = 'MONTHLY_EXPORT_LOG';
const SHEET_HOTEL_SENT_LOG_ = 'HOTEL_SENT_LOG';
const SHEET_REMINDER_SENT_LOG_ = 'REMINDER_SENT_LOG';
const SHEET_ROLE_BINDINGS_ = 'ROLE_BINDINGS';
const SHEET_SETTINGS_ = 'SETTINGS';
const SHEET_AUDIT_LOG_ = 'AUDIT_LOG';
const SHEET_WEEK_ASSIGNMENTS_PREFIX_ = 'WEEK_ASSIGNMENTS_';
const SHEET_BROADCAST_LOG_PREFIX_ = 'BROADCAST_LOG_';
const SHEET_FAILED_JOBS_PREFIX_ = 'FAILED_JOBS_';
const SHEET_APPROVAL_QUEUE_PREFIX_ = 'APPROVAL_QUEUE_';
const SHEET_MONTHLY_LOCK_PREFIX_ = 'MONTHLY_LOCK_';
const SHIFT_RAW_PARSER_VERSION_ = 'shift_raw_v1';
const SHIFT_RAW_PARSE_STATUS_STORED_ = 'stored';
const SHIFT_RAW_SOURCE_LINE_WEBHOOK_ = 'line_webhook';
const SHEET_CANONICAL_ALIASES_ = {
  STAFF_MASTER: ['STAFF_MASTER'],
  SITE_MASTER: ['SITE_MASTER'],
  ROLE_BINDINGS: ['ROLE_BINDINGS'],
  SETTINGS: ['SETTINGS', 'SYSTEM_CONFIG'],
  AUDIT_LOG: ['AUDIT_LOG'],
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
  SITE_MASTER: ['siteId', 'projectId', 'workDate', 'siteName', 'siteAddress', 'nearestStations', 'openChatUrl', 'aliases', 'updatedAt'],
  ROLE_BINDINGS: ['bindingId', 'slackUserId', 'lineUserId', 'email', 'role', 'isActive', 'updatedAt', 'updatedBy'],
  SETTINGS: ['configKey', 'configValue', 'updatedAt'],
  AUDIT_LOG: ['auditId', 'timestamp', 'actorType', 'actorId', 'actorRole', 'action', 'operationId', 'targetType', 'targetId', 'fromState', 'toState', 'detailsJson', 'requestId'],
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
      case 'expense.create':            return handleExpenseCreate_(ss, req.data, requestId);
      case 'hotel.screenshot.process':  return handleHotelScreenshotProcess_(ss, req.data, requestId);
      case 'traffic.create':        return handleTrafficCreate_(ss, req.data, requestId);
      case 'traffic.setPair':       return handleTrafficSetPair_(ss, req.data, requestId);
      case 'status.get':            return handleStatusGet_(ss, req.data, requestId);
      case 'dashboard.staff.snapshot': return handleDashboardStaffSnapshot_(ss, req.data, requestId);
      case 'monthly.file.generate': return handleMonthlyFileGenerate_(ss, req.data, requestId);
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
      case 'my.week.assignments':   return handleMyWeekAssignments_(ss, req.data, requestId);
      case 'admin.role.resolve':    return handleAdminRoleResolve_(ss, req.data, requestId);
      case 'admin.broadcast.preview': return handleAdminBroadcastPreview_(ss, req.data, requestId);
      case 'admin.broadcast.send.prepare': return handleAdminBroadcastSendPrepare_(ss, req.data, requestId);
      case 'admin.broadcast.send.finalize': return handleAdminBroadcastSendFinalize_(ss, req.data, requestId);
      case 'admin.broadcast.retryFailed.prepare': return handleAdminBroadcastRetryFailedPrepare_(ss, req.data, requestId);
      case 'admin.broadcast.retryFailed.finalize': return handleAdminBroadcastRetryFailedFinalize_(ss, req.data, requestId);
      case 'admin.approval.pending': return handleAdminApprovalPending_(ss, req.data, requestId);
      case 'admin.approval.decide': return handleAdminApprovalDecide_(ss, req.data, requestId);
      case 'admin.monthly.close.export': return handleAdminMonthlyCloseExport_(ss, req.data, requestId);
      case 'admin.hotel.summary': return handleAdminHotelSummary_(ss, req.data, requestId);
      case 'admin.audit.lookup': return handleAdminAuditLookup_(ss, req.data, requestId);
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
 * dashboard.staff.snapshot
 * - userId 指定時: スタッフ単体のダッシュボードカードを返す
 * - userId 省略時: 全スタッフの一覧サマリを返す
 */
function handleDashboardStaffSnapshot_(ss, data, requestId) {
  const month = sanitizeString_(data && data.month);
  const userId = sanitizeString_(data && data.userId);
  const limitRaw = Number(data && data.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 200;

  const fields = [];
  if (!month || !/^\d{4}-\d{2}$/.test(month)) fields.push({ field: 'month', reason: 'must be YYYY-MM' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const snapshot = buildMonthlySnapshot_(ss, month);
  if (!snapshot.ok) {
    return errorResponse_(snapshot.code || 'E_INTERNAL', snapshot.message || 'Failed to build dashboard snapshot.', snapshot.details || {}, requestId, true);
  }

  if (userId) {
    return okResponse_(buildDashboardPayloadForUser_(snapshot, userId), requestId);
  }

  return okResponse_(
    {
      month,
      staff: buildDashboardListPayload_(snapshot, limit),
      totalStaff: snapshot.summaryList.length,
      generatedAt: Utilities.formatDate(new Date(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX")
    },
    requestId
  );
}

/**
 * monthly.file.generate
 * - 月次レポートファイルを Drive に生成し、MONTHLY_EXPORT_LOG に記録
 */
function handleMonthlyFileGenerate_(ss, data, requestId) {
  const month = sanitizeString_(data && data.month);
  const fields = [];
  if (!month || !/^\d{4}-\d{2}$/.test(month)) fields.push({ field: 'month', reason: 'must be YYYY-MM' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const snapshot = buildMonthlySnapshot_(ss, month);
    if (!snapshot.ok) {
      return errorResponse_(snapshot.code || 'E_INTERNAL', snapshot.message || 'Failed to build monthly snapshot.', snapshot.details || {}, requestId, true);
    }

    const reportName = 'Project1_Monthly_' + month.replace('-', '_');
    const reportBook = SpreadsheetApp.create(reportName);
    const reportId = reportBook.getId();
    const reportUrl = reportBook.getUrl();

    const firstSheet = reportBook.getSheets()[0];
    if (firstSheet) firstSheet.setName('Staff_Summary');
    writeMatrixToSheet_(firstSheet, buildMonthlyStaffSummaryValues_(snapshot));

    const dashboardSheet = reportBook.insertSheet('Staff_Dashboard');
    writeMatrixToSheet_(dashboardSheet, buildDashboardSheetValues_(snapshot));

    const rawTrafficSheet = reportBook.insertSheet('Raw_Traffic');
    writeMatrixToSheet_(rawTrafficSheet, buildRawTrafficValues_(snapshot));

    const rawExpenseSheet = reportBook.insertSheet('Raw_Expense');
    writeMatrixToSheet_(rawExpenseSheet, buildRawExpenseValues_(snapshot));

    const hotelStatusSheet = reportBook.insertSheet('Hotel_Status');
    writeMatrixToSheet_(hotelStatusSheet, buildHotelStatusValues_(snapshot));

    const exportLogSheet = ensureMonthlyExportLogSheet_(ss);
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    appendRowSanitized_(exportLogSheet, [
      nowStr,
      month,
      reportId,
      reportUrl,
      snapshot.summaryList.length,
      snapshot.trafficRows.length,
      snapshot.expenseRows.length,
      snapshot.hotelStatusRows.length,
      snapshot.totals.traffic,
      snapshot.totals.expense,
      snapshot.totals.cost,
      requestId,
      'exported'
    ]);

    return okResponse_(
      {
        month,
        fileId: reportId,
        fileUrl: reportUrl,
        rowCounts: {
          staffSummary: snapshot.summaryList.length,
          rawTraffic: snapshot.trafficRows.length,
          rawExpense: snapshot.expenseRows.length,
          hotelStatus: snapshot.hotelStatusRows.length
        },
        totals: snapshot.totals,
        engine: 'gas'
      },
      requestId
    );
  });
}

function buildMonthlySnapshot_(ss, month) {
  try {
    const staffSheet = ss.getSheetByName(SHEET_STAFF_);
    const staffMap = staffSheet ? buildStaffMapFast_(staffSheet) : {};
    const plannedByUser = buildPlannedByUserFeatureFlagged_(ss, month, '', '');

    const trafficSheet = getSheetByNames_(ss, [SHEET_TRAFFIC_, 'TRAFFIC_CLAIMS']);
    if (!trafficSheet) {
      return {
        ok: false,
        code: 'E_SHEET_NOT_FOUND',
        message: 'Sheet TRAFFIC_LOG not found.',
        details: {}
      };
    }

    const trafficRows = readTrafficRowsForMonth_(trafficSheet, month);
    const expenseSheet = getSheetByNames_(ss, [SHEET_EXPENSE_LOG_, 'EXPENSE_CLAIMS']);
    const expenseRows = expenseSheet ? readExpenseRowsForMonth_(expenseSheet, month) : [];

    const hotelIntentSheet = ss.getSheetByName(SHEET_HOTEL_INTENT_);
    const hotelIntentRows = hotelIntentSheet ? readHotelIntentRowsForMonth_(hotelIntentSheet, month) : [];

    const hotelConfirmedSheet = ss.getSheetByName(SHEET_HOTEL_CONFIRMED_);
    const hotelConfirmedRows = hotelConfirmedSheet ? readHotelConfirmedRowsForMonth_(hotelConfirmedSheet, month) : [];

    const summaryByUser = {};
    Object.keys(plannedByUser).forEach(function(uid) {
      const planned = plannedByUser[uid] || {};
      const stat = ensureMonthlySnapshotEntry_(summaryByUser, uid, sanitizeString_(planned.name) || sanitizeString_((staffMap[uid] || {}).name));
      (planned.plannedDates || []).forEach(function(d) {
        const ymd = normalizeYmd_(d);
        if (ymd && ymd.slice(0, 7) === month) stat.plannedDates[ymd] = true;
      });
    });

    trafficRows.forEach(function(row) {
      const stat = ensureMonthlySnapshotEntry_(summaryByUser, row.userId, row.name || sanitizeString_((staffMap[row.userId] || {}).name));
      if (row.workDate) stat.submittedDates[row.workDate] = true;
      stat.trafficCount += 1;
      stat.trafficTotal += toNumber_(row.amount);
    });

    expenseRows.forEach(function(row) {
      const stat = ensureMonthlySnapshotEntry_(summaryByUser, row.userId, row.name || sanitizeString_((staffMap[row.userId] || {}).name));
      stat.expenseCount += 1;
      stat.expenseTotal += toNumber_(row.amount);
    });

    hotelIntentRows.forEach(function(row) {
      const stat = ensureMonthlySnapshotEntry_(summaryByUser, row.userId, sanitizeString_((staffMap[row.userId] || {}).name));
      if (!stat.name) stat.name = sanitizeString_((staffMap[row.userId] || {}).name);
      if (row.workDate) stat.answeredHotelDates[row.workDate] = true;
      if (row.needHotel === true) stat.hotelNeed += 1;
    });

    hotelConfirmedRows.forEach(function(row) {
      const stat = ensureMonthlySnapshotEntry_(summaryByUser, row.userId, row.name || sanitizeString_((staffMap[row.userId] || {}).name));
      stat.hotelConfirmed += 1;
    });

    const summaryList = Object.keys(summaryByUser)
      .sort(function(a, b) { return String(a).localeCompare(String(b)); })
      .map(function(uid) {
        const stat = summaryByUser[uid];
        const plannedDates = Object.keys(stat.plannedDates).sort();
        const submittedDates = Object.keys(stat.submittedDates).sort();
        const answeredHotelDates = Object.keys(stat.answeredHotelDates).sort();
        const submittedSet = stat.submittedDates;
        const answeredSet = stat.answeredHotelDates;
        const unsubmittedDates = plannedDates.filter(function(d) { return !submittedSet[d]; });
        const hotelUnansweredDates = plannedDates.filter(function(d) { return !answeredSet[d]; });
        const trafficTotal = Number(stat.trafficTotal || 0);
        const expenseTotal = Number(stat.expenseTotal || 0);
        return {
          userId: uid,
          name: stat.name || sanitizeString_((staffMap[uid] || {}).name),
          plannedDates: plannedDates,
          submittedDates: submittedDates,
          unsubmittedDates: unsubmittedDates,
          answeredHotelDates: answeredHotelDates,
          hotelUnansweredDates: hotelUnansweredDates,
          shiftDays: plannedDates.length,
          trafficCount: stat.trafficCount,
          trafficTotal: trafficTotal,
          expenseCount: stat.expenseCount,
          expenseTotal: expenseTotal,
          hotelNeed: stat.hotelNeed,
          hotelConfirmed: stat.hotelConfirmed,
          totalCost: trafficTotal + expenseTotal
        };
      });

    const totals = summaryList.reduce(function(acc, row) {
      acc.traffic += Number(row.trafficTotal || 0);
      acc.expense += Number(row.expenseTotal || 0);
      acc.cost += Number(row.totalCost || 0);
      return acc;
    }, { traffic: 0, expense: 0, cost: 0 });

    const hotelStatusRows = buildHotelStatusRows_(hotelIntentRows, hotelConfirmedRows, staffMap);

    return {
      ok: true,
      month: month,
      staffMap: staffMap,
      summaryByUser: summaryByUser,
      summaryList: summaryList,
      trafficRows: trafficRows,
      expenseRows: expenseRows,
      hotelIntentRows: hotelIntentRows,
      hotelConfirmedRows: hotelConfirmedRows,
      hotelStatusRows: hotelStatusRows,
      totals: totals
    };
  } catch (err) {
    return {
      ok: false,
      code: 'E_INTERNAL',
      message: 'Failed to aggregate monthly snapshot.',
      details: { reason: String(err && err.message ? err.message : err) }
    };
  }
}

function ensureMonthlySnapshotEntry_(summaryByUser, userId, name) {
  const uid = sanitizeString_(userId);
  if (!summaryByUser[uid]) {
    summaryByUser[uid] = {
      userId: uid,
      name: sanitizeString_(name),
      plannedDates: {},
      submittedDates: {},
      answeredHotelDates: {},
      trafficCount: 0,
      trafficTotal: 0,
      expenseCount: 0,
      expenseTotal: 0,
      hotelNeed: 0,
      hotelConfirmed: 0
    };
  } else if (!summaryByUser[uid].name && name) {
    summaryByUser[uid].name = sanitizeString_(name);
  }
  return summaryByUser[uid];
}

function getSheetByNames_(ss, names) {
  const list = Array.isArray(names) ? names : [];
  for (let i = 0; i < list.length; i++) {
    const sheet = ss.getSheetByName(sanitizeString_(list[i]));
    if (sheet) return sheet;
  }
  return null;
}

function readTrafficRowsForMonth_(sheet, month) {
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0 || idx.amount < 0) return [];
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxFrom = indexOfHeader_(headers, ['fromstation', 'from_station', 'from']);
  const idxTo = indexOfHeader_(headers, ['tostation', 'to_station', 'to']);
  const idxRoundTrip = indexOfHeader_(headers, ['roundtrip', 'round_trip']);
  const idxMemo = indexOfHeader_(headers, ['memo', 'note']);

  const rows = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const workDate = normalizeYmd_(row[idx.workdate]);
    if (!workDate || workDate.slice(0, 7) !== month) continue;
    const userId = sanitizeString_(row[idx.userid]);
    if (!userId) continue;
    rows.push({
      userId: userId,
      name: idx.name >= 0 ? sanitizeString_(row[idx.name]) : '',
      project: idx.project >= 0 ? sanitizeString_(row[idx.project]) : '',
      workDate: workDate,
      fromStation: idxFrom >= 0 ? sanitizeString_(row[idxFrom]) : '',
      toStation: idxTo >= 0 ? sanitizeString_(row[idxTo]) : '',
      amount: toNumber_(row[idx.amount]),
      roundTrip: idxRoundTrip >= 0 ? sanitizeString_(row[idxRoundTrip]) : '',
      memo: idxMemo >= 0 ? sanitizeString_(row[idxMemo]) : ''
    });
  }
  return rows;
}

function readExpenseRowsForMonth_(sheet, month) {
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0 || idx.amount < 0) return [];
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxCategory = indexOfHeader_(headers, ['category']);
  const idxPaymentMethod = indexOfHeader_(headers, ['paymentmethod', 'payment_method']);
  const idxMemo = indexOfHeader_(headers, ['memo', 'note', 'description']);
  const idxStatus = indexOfHeader_(headers, ['status']);

  const rows = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const workDate = normalizeYmd_(row[idx.workdate]);
    if (!workDate || workDate.slice(0, 7) !== month) continue;
    const userId = sanitizeString_(row[idx.userid]);
    if (!userId) continue;
    rows.push({
      userId: userId,
      name: idx.name >= 0 ? sanitizeString_(row[idx.name]) : '',
      project: idx.project >= 0 ? sanitizeString_(row[idx.project]) : '',
      workDate: workDate,
      category: idxCategory >= 0 ? sanitizeString_(row[idxCategory]) : '',
      amount: toNumber_(row[idx.amount]),
      paymentMethod: idxPaymentMethod >= 0 ? sanitizeString_(row[idxPaymentMethod]) : '',
      memo: idxMemo >= 0 ? sanitizeString_(row[idxMemo]) : '',
      status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : ''
    });
  }
  return rows;
}

function readHotelIntentRowsForMonth_(sheet, month) {
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0) return [];

  const latestByUserDate = {};
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const workDate = normalizeYmd_(row[idx.workdate]);
    if (!workDate || workDate.slice(0, 7) !== month) continue;
    const userId = sanitizeString_(row[idx.userid]);
    if (!userId) continue;
    const key = userId + '|' + workDate;
    latestByUserDate[key] = {
      userId: userId,
      workDate: workDate,
      needHotel: parseNeedHotel_(idx.needhotel >= 0 ? row[idx.needhotel] : ''),
      smoking: idx.smoking >= 0 ? sanitizeString_(row[idx.smoking]) : '',
      status: idx.status >= 0 ? sanitizeString_(row[idx.status]).toLowerCase() : ''
    };
  }

  return Object.keys(latestByUserDate).map(function(k) { return latestByUserDate[k]; });
}

function readHotelConfirmedRowsForMonth_(sheet, month) {
  const table = readTable_(sheet);
  if (!table.ok || !table.values || table.values.length <= 1) return [];
  const idx = table.idx;
  if (idx.userid < 0 || idx.workdate < 0) return [];
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxHotel = indexOfHeader_(headers, ['hotel', 'hotelname', 'hotel_name']);

  const rows = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const workDate = normalizeYmd_(row[idx.workdate]);
    if (!workDate || workDate.slice(0, 7) !== month) continue;
    const userId = sanitizeString_(row[idx.userid]);
    if (!userId) continue;
    rows.push({
      userId: userId,
      workDate: workDate,
      name: idx.name >= 0 ? sanitizeString_(row[idx.name]) : '',
      status: idx.status >= 0 ? sanitizeString_(row[idx.status]).toLowerCase() : '',
      hotel: idxHotel >= 0 ? sanitizeString_(row[idxHotel]) : ''
    });
  }
  return rows;
}

function buildDashboardPayloadForUser_(snapshot, userId) {
  const uid = sanitizeString_(userId);
  const summary = snapshot.summaryList.find(function(row) { return row.userId === uid; }) || {
    userId: uid,
    name: sanitizeString_((snapshot.staffMap[uid] || {}).name),
    plannedDates: [],
    submittedDates: [],
    unsubmittedDates: [],
    answeredHotelDates: [],
    hotelUnansweredDates: [],
    shiftDays: 0,
    trafficTotal: 0,
    expenseTotal: 0,
    hotelConfirmed: 0
  };

  return {
    month: snapshot.month,
    userId: uid,
    name: summary.name || '',
    cards: {
      shiftDays: summary.shiftDays,
      trafficTotal: summary.trafficTotal,
      expenseTotal: summary.expenseTotal,
      unsubmittedTraffic: summary.unsubmittedDates.length,
      hotelUnanswered: summary.hotelUnansweredDates.length,
      hotelConfirmed: summary.hotelConfirmed
    },
    details: {
      plannedDates: summary.plannedDates,
      submittedDates: summary.submittedDates,
      unsubmittedDates: summary.unsubmittedDates,
      answeredHotelDates: summary.answeredHotelDates
    },
    engine: 'gas'
  };
}

function buildDashboardListPayload_(snapshot, limit) {
  return snapshot.summaryList
    .map(function(row) {
      return {
        userId: row.userId,
        name: row.name || '',
        shiftDays: row.shiftDays,
        unsubmittedTraffic: row.unsubmittedDates.length,
        hotelUnanswered: row.hotelUnansweredDates.length,
        trafficTotal: row.trafficTotal,
        expenseTotal: row.expenseTotal,
        totalCost: row.totalCost,
        status: resolveDashboardStatus_(row)
      };
    })
    .sort(function(a, b) {
      if (b.unsubmittedTraffic !== a.unsubmittedTraffic) return b.unsubmittedTraffic - a.unsubmittedTraffic;
      if (b.hotelUnanswered !== a.hotelUnanswered) return b.hotelUnanswered - a.hotelUnanswered;
      return String(a.userId).localeCompare(String(b.userId));
    })
    .slice(0, limit);
}

function resolveDashboardStatus_(summaryRow) {
  if ((summaryRow.unsubmittedDates || []).length > 0) return 'needs_traffic_submit';
  if ((summaryRow.hotelUnansweredDates || []).length > 0) return 'needs_hotel_answer';
  return 'ok';
}

function buildMonthlyStaffSummaryValues_(snapshot) {
  const values = [[
    'userId',
    'name',
    'shiftDays',
    'trafficSubmittedDays',
    'unsubmittedTrafficDays',
    'trafficCount',
    'trafficTotal',
    'expenseCount',
    'expenseTotal',
    'hotelAnsweredDays',
    'hotelNeedCount',
    'hotelConfirmedCount',
    'totalCost'
  ]];

  snapshot.summaryList.forEach(function(row) {
    values.push([
      row.userId,
      row.name || '',
      row.shiftDays,
      row.submittedDates.length,
      row.unsubmittedDates.length,
      row.trafficCount,
      row.trafficTotal,
      row.expenseCount,
      row.expenseTotal,
      row.answeredHotelDates.length,
      row.hotelNeed,
      row.hotelConfirmed,
      row.totalCost
    ]);
  });

  return values;
}

function buildDashboardSheetValues_(snapshot) {
  const values = [[
    'userId',
    'name',
    'shiftDays',
    'unsubmittedTrafficDays',
    'hotelUnansweredDays',
    'trafficTotal',
    'expenseTotal',
    'totalCost',
    'status'
  ]];

  snapshot.summaryList.forEach(function(row) {
    values.push([
      row.userId,
      row.name || '',
      row.shiftDays,
      row.unsubmittedDates.length,
      row.hotelUnansweredDates.length,
      row.trafficTotal,
      row.expenseTotal,
      row.totalCost,
      resolveDashboardStatus_(row)
    ]);
  });

  return values;
}

function buildRawTrafficValues_(snapshot) {
  const values = [[
    'userId',
    'name',
    'project',
    'workDate',
    'fromStation',
    'toStation',
    'amount',
    'roundTrip',
    'memo'
  ]];
  snapshot.trafficRows.forEach(function(row) {
    values.push([
      row.userId,
      row.name || '',
      row.project || '',
      row.workDate || '',
      row.fromStation || '',
      row.toStation || '',
      row.amount || 0,
      row.roundTrip || '',
      row.memo || ''
    ]);
  });
  return values;
}

function buildRawExpenseValues_(snapshot) {
  const values = [[
    'userId',
    'name',
    'project',
    'workDate',
    'category',
    'amount',
    'paymentMethod',
    'memo',
    'status'
  ]];
  snapshot.expenseRows.forEach(function(row) {
    values.push([
      row.userId,
      row.name || '',
      row.project || '',
      row.workDate || '',
      row.category || '',
      row.amount || 0,
      row.paymentMethod || '',
      row.memo || '',
      row.status || ''
    ]);
  });
  return values;
}

function buildHotelStatusRows_(hotelIntentRows, hotelConfirmedRows, staffMap) {
  const byUserDate = {};

  (hotelIntentRows || []).forEach(function(row) {
    const key = row.userId + '|' + row.workDate;
    if (!byUserDate[key]) {
      byUserDate[key] = {
        userId: row.userId,
        name: sanitizeString_((staffMap[row.userId] || {}).name),
        workDate: row.workDate,
        needHotel: '',
        smoking: '',
        intentStatus: '',
        confirmedCount: 0
      };
    }
    byUserDate[key].needHotel = row.needHotel === true ? 'true' : row.needHotel === false ? 'false' : '';
    byUserDate[key].smoking = row.smoking || '';
    byUserDate[key].intentStatus = row.status || '';
  });

  (hotelConfirmedRows || []).forEach(function(row) {
    const key = row.userId + '|' + row.workDate;
    if (!byUserDate[key]) {
      byUserDate[key] = {
        userId: row.userId,
        name: row.name || sanitizeString_((staffMap[row.userId] || {}).name),
        workDate: row.workDate,
        needHotel: '',
        smoking: '',
        intentStatus: '',
        confirmedCount: 0
      };
    }
    byUserDate[key].confirmedCount += 1;
    if (!byUserDate[key].name && row.name) byUserDate[key].name = row.name;
  });

  return Object.keys(byUserDate)
    .map(function(key) { return byUserDate[key]; })
    .sort(function(a, b) {
      if (a.workDate !== b.workDate) return String(a.workDate).localeCompare(String(b.workDate));
      return String(a.userId).localeCompare(String(b.userId));
    });
}

function buildHotelStatusValues_(snapshot) {
  const values = [[
    'userId',
    'name',
    'workDate',
    'needHotel',
    'smoking',
    'intentStatus',
    'confirmedCount'
  ]];
  snapshot.hotelStatusRows.forEach(function(row) {
    values.push([
      row.userId || '',
      row.name || '',
      row.workDate || '',
      row.needHotel || '',
      row.smoking || '',
      row.intentStatus || '',
      row.confirmedCount || 0
    ]);
  });
  return values;
}

function writeMatrixToSheet_(sheet, values) {
  if (!sheet) return;
  const normalized = normalizeMatrixWidth_(values);
  sheet.clearContents();
  setRangeValuesSanitized_(sheet.getRange(1, 1, normalized.length, normalized[0].length), normalized);
}

function normalizeMatrixWidth_(rows) {
  const src = Array.isArray(rows) ? rows : [];
  const width = src.reduce(function(max, row) {
    if (!Array.isArray(row)) return max;
    return Math.max(max, row.length);
  }, 0);
  if (width <= 0) return [['No data']];
  return src.map(function(row) {
    const out = Array.isArray(row) ? row.slice() : [];
    while (out.length < width) out.push('');
    return out;
  });
}

function ensureMonthlyExportLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_MONTHLY_EXPORT_LOG_);
  if (!sheet) sheet = ss.insertSheet(SHEET_MONTHLY_EXPORT_LOG_);
  ensureHeaderRowIfEmpty_(sheet, [
    'timestamp',
    'month',
    'fileId',
    'fileUrl',
    'userCount',
    'trafficRows',
    'expenseRows',
    'hotelRows',
    'totalTraffic',
    'totalExpense',
    'totalCost',
    'requestId',
    'status'
  ]);
  return sheet;
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
 * Spec: v5_spec 2.3 Idempotency / ops_rules 1 / action-contracts hotel.intent.submit
 * userId + projectId + workDate をキーに upsert。重複ポストバック・再送で二重登録しない。
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

  return withScriptLock_(requestId, function() {
    const sheet  = ensureHotelIntentSheet_(ss);
    const table  = readTable_(sheet);
    const idx    = table.idx;
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]

    // userId + projectId + workDate が既存行と一致すれば上書き更新（upsert）
    if (table.ok && table.values && table.values.length > 1 &&
        idx.userid >= 0 && idx.project >= 0 && idx.workdate >= 0) {
      for (let r = 1; r < table.values.length; r++) {
        const row = table.values[r];
        if (sanitizeString_(row[idx.userid])  === userId &&
            sanitizeString_(row[idx.project]) === projectId &&
            sanitizeString_(row[idx.workdate]) === workDate) {
          const sheetRowNum = r + 1; // 1-indexed
          const lastCol = sheet.getLastColumn();
          const existingValues = sheet.getRange(sheetRowNum, 1, 1, lastCol).getValues()[0];
          existingValues[0] = nowStr; // timestamp
          if (idx.needhotel >= 0) existingValues[idx.needhotel] = needHotelVal;
          if (idx.smoking  >= 0) existingValues[idx.smoking]   = smoking;
          if (idx.source   >= 0) existingValues[idx.source]    = source;
          if (idx.status   >= 0) existingValues[idx.status]    = status;
          setRangeValuesSanitized_(sheet.getRange(sheetRowNum, 1, 1, lastCol), [existingValues]);
          return okResponse_({ row: sheetRowNum, dedup: true }, requestId);
        }
      }
    }

    appendRowSanitized_(sheet, [nowStr, userId, projectId, workDate, needHotelVal, smoking, source, status]);
    return okResponse_({ row: sheet.getLastRow(), dedup: false }, requestId);
  });
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
  ensureHeaderRowIfEmpty_(sheet, ['siteId','projectId','workDate','siteName','siteAddress','nearestStations','openChatUrl','aliases','updatedAt']);
  ensureHeaderColumnsExist_(sheet, ['siteId','projectId','workDate','siteName','siteAddress','nearestStations','openChatUrl','aliases','updatedAt']);
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

/* =========================================================
 * PR-A: expense.create / hotel.screenshot.process
 * Spec: data-boundary.md §2 / action-contracts §4.2
 * Worker→GAS 経路統一により追加。Worker は Sheets を直接読み書きしない。
 * =======================================================*/

/**
 * expense.create
 * Spec: action-contracts §4.2 / v5_spec 2.3 Idempotency / ops_rules 1
 * Worker でリサイズ・R2保存済みの receiptUrl を受け取り EXPENSE_LOG に追記する。
 * requestId をキーに重複排除する。
 */
function handleExpenseCreate_(ss, data, requestId) {
  const userId        = sanitizeString_(data && data.userId);
  const workDate      = sanitizeString_(data && data.workDate);
  const category      = sanitizeString_(data && data.category);
  const amount        = Number(data && data.amount);
  const paymentMethod = sanitizeString_(data && data.paymentMethod) || 'advance';
  const memo          = sanitizeString_(data && data.memo);
  const project       = sanitizeString_(data && data.project);
  const name          = sanitizeString_(data && data.name);
  const receiptUrl    = sanitizeString_(data && data.receiptUrl);
  const status        = sanitizeString_(data && data.status) || 'submitted';

  const fields = [];
  if (!userId)   fields.push({ field: 'userId',         reason: 'required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (!category) fields.push({ field: 'category',       reason: 'required' });
  if (!Number.isFinite(amount) || amount <= 0) fields.push({ field: 'amount', reason: 'must be number > 0' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    try {
      const sheet = ensureExpenseLogSheet_(ss);
      // requestId キーで重複排除
      const existingRow = findExpenseRowByRequestId_(sheet, requestId);
      if (existingRow > 0) {
        Logger.log('expense.create dedup: requestId=' + requestId + ', row=' + existingRow);
        return okResponse_({ expenseId: requestId, row: existingRow, dedup: true }, requestId);
      }
      const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss'); // [P12]
      appendRowSanitized_(sheet, [
        nowStr, userId, name, project, workDate, category,
        amount, paymentMethod, memo, receiptUrl, status, requestId
      ]);
      return okResponse_({ expenseId: requestId, row: sheet.getLastRow(), dedup: false }, requestId);
    } catch (err) {
      return errorResponse_(
        'E_APPEND_FAILED', 'Failed to append expense row.',
        { reason: String(err && err.message ? err.message : err) }, requestId, true
      );
    }
  });
}

function findExpenseRowByRequestId_(sheet, targetRequestId) {
  if (!targetRequestId) return 0;
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return 0;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxRequestId = indexOfHeader_(headers, ['requestid', 'request_id']);
  if (idxRequestId < 0) return 0;
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = 0; i < values.length; i++) {
    if (sanitizeString_(values[i][idxRequestId]) === targetRequestId) return i + 2; // 1-indexed
  }
  return 0;
}

function ensureExpenseLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_EXPENSE_LOG_);
  if (!sheet) sheet = ss.insertSheet(SHEET_EXPENSE_LOG_);
  ensureHeaderRowIfEmpty_(sheet, ['timestamp','userId','name','project','workDate','category','amount','paymentMethod','memo','receiptUrl','status','requestId']);
  return sheet;
}

/**
 * hotel.screenshot.process
 * Spec: action-contracts §4.2 / v5_spec 1.4 / v5_spec 3.2 / v5_spec 3.3 No Silent Failure
 * Worker が OCR した結果（ocrName/ocrHotel/ocrDate）を受け取り、名寄せ・永続化を担当する。
 * 画像はWorker側で破棄済み。バイト数のみ監査ログ用に受け取る。
 */
function handleHotelScreenshotProcess_(ss, data, requestId) {
  const adminLineUserId = sanitizeString_(data && data.adminLineUserId);
  const messageId       = sanitizeString_(data && data.messageId);
  const ocrName         = sanitizeString_(data && data.ocrName);
  const ocrHotel        = sanitizeString_(data && data.ocrHotel);
  const ocrDate         = sanitizeString_(data && data.ocrDate);
  const mimeType        = sanitizeString_(data && data.mimeType) || 'image/jpeg';
  const bytes           = Number(data && data.bytes) || 0;
  const inputTargetUserId = sanitizeString_(data && data.targetUserId);

  if (!adminLineUserId) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'adminLineUserId', reason: 'required' }] }, requestId);
  }

  return withScriptLock_(requestId, function() {
    try {
      const staffSheet     = ensureStaffMasterSheet_(ss);
      const staffTable     = readTable_(staffSheet);
      const hotelConfSheet = ensureHotelConfirmedLogSheet_(ss);
      const hotelConfTable = readTable_(hotelConfSheet);
      const rawSheet       = ensureHotelScreenshotRawSheet_(ss);

      // 名寄せ: OCR 抽出名を正規化してスタッフマスタと照合
      // Spec: v5_spec 3.2 Hotel OCR normalization
      const normalizedOcrName = normalizeNameForMatch_(ocrName);
      const staffLookup = buildStaffNameLookup_(staffTable);
      const targetUserId = inputTargetUserId || staffLookup.nameToUserId[normalizedOcrName] || '';
      const targetStaff  = targetUserId ? staffLookup.byUserId[targetUserId] || null : null;

      // シフト割当確認（SHIFT_ASSIGNMENTS があれば参照、なければスキップ）
      const assignmentSheet = ss.getSheetByName('SHIFT_ASSIGNMENTS') || ss.getSheetByName('SHIFT');
      const isAssigned = checkAssignmentMatch_(assignmentSheet, targetUserId, ocrDate);

      // 重複チェック（HOTEL_CONFIRMED_LOG）
      const isDuplicate = checkDuplicateConfirmed_(hotelConfTable, messageId, targetUserId, ocrDate, ocrHotel);

      const matchStatus = !targetUserId ? 'unmatched'
        : (isDuplicate ? 'duplicate' : (isAssigned ? 'confirmed' : 'unmatched'));

      const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');

      // HOTEL_SCREENSHOT_RAW に監査ログを書く（v5_spec 2.2: 画像バイナリは保存しない、バイト数のみ）
      appendRowSanitized_(rawSheet, [
        nowStr, messageId, adminLineUserId, targetUserId,
        ocrName, ocrHotel, ocrDate, mimeType, bytes, matchStatus, requestId, ''
      ]);

      const warnings = [];
      let auditLogged = true;
      let confirmedCount = 0, unmatchedCount = 0, duplicateCount = 0;

      if (matchStatus === 'unmatched') {
        unmatchedCount = 1;
        warnings.push('NEEDS_MANUAL_REVIEW');
        // Spec: v5_spec 3.3 No Silent Failure / ops_rules 5 — 不一致は ADMIN_ALERTS に残す
        const alertSheet = ensureSheetByCanonical_(ss, 'ADMIN_ALERTS');
        const alertId    = Utilities.getUuid();
        const alertUpsert = upsertSheetRowById_(alertSheet, 'alertId', alertId, {
          timestamp:   nowStr,
          requestId:   requestId,
          severity:    'warn',
          source:      'worker.hotel.screenshot',
          event:       'hotel.screenshot.unmatched',
          message:     'Hotel screenshot could not be matched to assignment.',
          payloadJson: safeJsonStringify_({ adminLineUserId, ocrName, ocrHotel, ocrDate, messageId, reason: !targetUserId ? 'user_not_matched' : 'assignment_not_matched' }),
          status:      'open'
        });
        if (!alertUpsert.ok) {
          auditLogged = false;
          warnings.push('ADMIN_ALERT_WRITE_FAILED');
        }
      } else if (matchStatus === 'duplicate') {
        duplicateCount = 1;
      } else {
        // confirmed: HOTEL_CONFIRMED_LOG に書く
        confirmedCount = 1;
        appendRowSanitized_(hotelConfSheet, [
          nowStr, ocrDate, targetUserId,
          targetStaff ? sanitizeString_(targetStaff.lineUserId) : '',
          targetStaff ? sanitizeString_(targetStaff.name) : ocrName,
          ocrHotel, 'line.webhook', 'auto_confirmed', messageId, requestId
        ]);
      }

      return okResponse_({
        result:          matchStatus,
        name_candidate:  ocrName,
        matched:         targetStaff ? { userId: targetStaff.userId, lineUserId: targetStaff.lineUserId, name: targetStaff.name } : null,
        auditLogged,
        confirmedCount,
        unmatchedCount,
        duplicateCount,
        extracted:       { name: ocrName, hotel: ocrHotel, date: ocrDate },
        matchedUserId:   targetUserId,
        status:          matchStatus,
        warnings
      }, requestId);
    } catch (err) {
      return errorResponse_(
        'E_SCREENSHOT_PROCESS_FAILED', 'Failed to process hotel screenshot.',
        { reason: String(err && err.message ? err.message : err) }, requestId, true
      );
    }
  });
}

/**
 * 名前正規化（ホテルOCR名寄せ用）
 * Spec: v5_spec 3.2 Hotel OCR normalization
 * Worker の normalizeName() と同じロジックを GAS 側でも実装する。
 */
function normalizeNameForMatch_(value) {
  let text = sanitizeString_(value);
  if (!text) return '';
  // NFKC 正規化（全角/半角統一）
  text = text.normalize ? text.normalize('NFKC') : text;
  // カタカナ → ひらがな変換
  text = text.replace(/[\u30A1-\u30F6]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0x60);
  });
  // 小書きかな正規化
  const smallKanaMap = {
    '\u3041': '\u3042', '\u3043': '\u3044', '\u3045': '\u3046', '\u3047': '\u3048', '\u3049': '\u304A',
    '\u3063': '\u3064', '\u3083': '\u3084', '\u3085': '\u3086', '\u3087': '\u3088', '\u308E': '\u308F',
    '\u3095': '\u304B', '\u3096': '\u3051'
  };
  text = text.replace(/[\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u3095\u3096]/g, function(ch) {
    return smallKanaMap[ch] || ch;
  });
  // 濁点・半濁点の除去（NFKDに分解して結合文字を除去）
  if (text.normalize) {
    text = text.normalize('NFKD').replace(/[\u3099\u309A]/g, '').normalize('NFC');
  }
  return text.toLowerCase().replace(/[\s\u3000]/g, '');
}

function buildStaffNameLookup_(staffTable) {
  const byUserId    = {};
  const nameToUserId = {};
  if (!staffTable.ok || !staffTable.values || staffTable.values.length <= 1) return { byUserId, nameToUserId };
  const idx     = staffTable.idx;
  if (idx.userid < 0) return { byUserId, nameToUserId };
  const headers = staffTable.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxAlias = indexOfHeader_(headers, ['aliases', 'alias']);
  const idxFullNameKanji = indexOfHeader_(headers, ['fullnamekanji', 'full_name_kanji']);
  const idxFullNameKana  = indexOfHeader_(headers, ['fullnamekana', 'full_name_kana']);
  const idxNameKana      = indexOfHeader_(headers, ['namekana', 'namekana', 'kana']);
  const idxLineUserId    = indexOfHeader_(headers, ['lineuserid', 'line_user_id']);
  const idxName          = indexOfHeader_(headers, ['name']);
  for (let r = 1; r < staffTable.values.length; r++) {
    const row    = staffTable.values[r];
    const userId = sanitizeString_(idx.userid >= 0 ? row[idx.userid] : '');
    if (!userId) continue;
    const name       = sanitizeString_(idxName >= 0 ? row[idxName] : '');
    const lineUserId = sanitizeString_(idxLineUserId >= 0 ? row[idxLineUserId] : '');
    byUserId[userId] = { userId, name, lineUserId };
    const candidates = [
      name,
      idxFullNameKanji >= 0 ? sanitizeString_(row[idxFullNameKanji]) : '',
      idxFullNameKana  >= 0 ? sanitizeString_(row[idxFullNameKana])  : '',
      idxNameKana      >= 0 ? sanitizeString_(row[idxNameKana])       : ''
    ];
    if (idxAlias >= 0) {
      const aliasStr = sanitizeString_(row[idxAlias]);
      aliasStr.split(/[|,]/).forEach(function(a) { if (a.trim()) candidates.push(a.trim()); });
    }
    candidates.forEach(function(c) {
      const norm = normalizeNameForMatch_(c);
      if (norm && !nameToUserId[norm]) nameToUserId[norm] = userId;
    });
  }
  return { byUserId, nameToUserId };
}

function checkAssignmentMatch_(assignmentSheet, userId, dateYmd) {
  if (!userId || !dateYmd || !assignmentSheet) return true; // シートがなければ matched 扱い
  const table = readTable_(assignmentSheet);
  if (!table.ok || !table.values || table.values.length <= 1) return true;
  const idx = table.idx;
  if (idx.userid < 0) return true;
  const targetMonth = dateYmd.slice(0, 7);
  const targetDay   = Number(dateYmd.slice(8, 10));
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    if (sanitizeString_(row[idx.userid]) !== userId) continue;
    const workDate = normalizeYmd_(row[idx.workdate]);
    if (workDate) { if (workDate === dateYmd) return true; continue; }
    const rowMonth = idx.month >= 0 ? sanitizeString_(row[idx.month]) : '';
    if (rowMonth && rowMonth !== targetMonth) continue;
    const idxFrom = indexOfHeader_(table.values[0].map(function(h) { return normalizeHeaderKey_(h); }), ['segmentfromday','sitperiodfromday','fromday']);
    const idxTo   = indexOfHeader_(table.values[0].map(function(h) { return normalizeHeaderKey_(h); }), ['segmenttoday','siteperiodtoday','today']);
    const from = idxFrom >= 0 ? Math.floor(Number(row[idxFrom])) : 0;
    const to   = idxTo   >= 0 ? Math.floor(Number(row[idxTo]))   : 0;
    if (!from && !to) continue;
    const start = Math.min(from || to, to || from);
    const end   = Math.max(from || to, to || from);
    if (targetDay >= start && targetDay <= end) return true;
  }
  return false;
}

function checkDuplicateConfirmed_(table, messageId, userId, workDate, hotel) {
  if (!table.ok || !table.values || table.values.length <= 1) return false;
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxMsgId   = indexOfHeader_(headers, ['rawmessageid', 'messageid']);
  const idxUserId  = indexOfHeader_(headers, ['userid']);
  const idxDate    = indexOfHeader_(headers, ['workdate', 'date']);
  const idxHotel   = indexOfHeader_(headers, ['hotel']);
  const hotelNorm  = (hotel || '').toLowerCase();
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    if (messageId && idxMsgId >= 0 && sanitizeString_(row[idxMsgId]) === messageId) return true;
    if (userId && workDate) {
      const rowUserId = idxUserId >= 0 ? sanitizeString_(row[idxUserId]) : '';
      const rowDate   = idxDate   >= 0 ? normalizeYmd_(row[idxDate])     : '';
      const rowHotel  = idxHotel  >= 0 ? sanitizeString_(row[idxHotel]).toLowerCase() : '';
      if (rowUserId === userId && rowDate === workDate && hotelNorm && rowHotel === hotelNorm) return true;
    }
  }
  return false;
}

function ensureHotelConfirmedLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_HOTEL_CONFIRMED_);
  if (!sheet) sheet = ss.insertSheet(SHEET_HOTEL_CONFIRMED_);
  ensureHeaderRowIfEmpty_(sheet, ['timestamp','workDate','userId','lineUserId','name','hotel','source','status','rawMessageId','requestId']);
  return sheet;
}

function ensureHotelScreenshotRawSheet_(ss) {
  const sheetName = 'HOTEL_SCREENSHOT_RAW';
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaderRowIfEmpty_(sheet, ['timestamp','messageId','adminLineUserId','targetUserId','ocrName','ocrHotel','ocrDate','mimeType','bytes','status','requestId','rawOcrJson']);
  return sheet;
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

/* =========================================================
 * V7 Additions (Slack Admin + Weekly Broadcast + Week Assignments)
 * =======================================================*/

function handleMyWeekAssignments_(ss, data, requestId) {
  const userId = sanitizeString_(data && data.userId);
  const targetDate = normalizeYmd_(data && data.targetDate) || Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd');
  const requestedWeekId = sanitizeString_(data && data.weekId);

  const fields = [];
  if (!userId) fields.push({ field: 'userId', reason: 'required' });
  if (!targetDate) fields.push({ field: 'targetDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const weekId = requestedWeekId || deriveIsoWeekId_(targetDate);
  const monthCandidates = monthCandidatesForTargetDate_(targetDate);
  const items = queryWeekAssignmentsForUser_(ss, userId, weekId, monthCandidates);

  const sorted = items.sort(function(a, b) {
    if (a.workDate !== b.workDate) return String(a.workDate).localeCompare(String(b.workDate));
    if (a.siteName !== b.siteName) return String(a.siteName).localeCompare(String(b.siteName));
    return String(a.role).localeCompare(String(b.role));
  });

  const siteMap = {};
  sorted.forEach(function(row) {
    const key = sanitizeString_(row.siteId) || sanitizeString_(row.siteName);
    if (!key) return;
    if (!siteMap[key]) {
      siteMap[key] = {
        siteId: sanitizeString_(row.siteId),
        siteName: sanitizeString_(row.siteName) || sanitizeString_(row.siteRaw),
        openChatUrl: sanitizeString_(row.openChatUrl)
      };
    }
  });

  const siteOptions = Object.keys(siteMap)
    .map(function(key) { return siteMap[key]; })
    .sort(function(a, b) { return String(a.siteName).localeCompare(String(b.siteName)); });

  const targetDayItems = sorted.filter(function(row) { return sanitizeString_(row.workDate) === targetDate; });
  const defaultAssignment = targetDayItems.length > 0 ? targetDayItems[0] : (sorted.length > 0 ? sorted[0] : null);

  return okResponse_(
    {
      userId,
      weekId,
      targetDate,
      assignments: sorted,
      siteOptions,
      defaultAssignment,
      hasAssignments: sorted.length > 0
    },
    requestId
  );
}

function handleAdminRoleResolve_(ss, data, requestId) {
  const slackUserId = sanitizeString_(data && (data.slackUserId || data.actorSlackUserId));
  if (!slackUserId) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'slackUserId', reason: 'required' }] }, requestId);
  }

  const actor = resolveRoleBindingBySlackUserId_(ss, slackUserId);
  return okResponse_(
    {
      slackUserId,
      allowed: actor.allowed,
      role: actor.role,
      roleBinding: actor.roleBinding
    },
    requestId
  );
}

function handleAdminBroadcastPreview_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'VIEWER', requestId, 'admin.broadcast.preview');
  if (!roleCheck.ok) return roleCheck.response;

  const targetMonth = sanitizeString_(data && data.targetMonth);
  const rawText = sanitizeString_(data && data.rawText);
  const operationId = sanitizeString_(data && data.operationId) || requestId;

  const fields = [];
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const parsed = parseWeeklyBroadcastPayloadV7_(ss, targetMonth, rawText, requestId);
    if (!parsed.ok) {
      return errorResponse_(parsed.code || 'E_VALIDATION', parsed.message || 'Parse failed.', parsed.details || {}, requestId);
    }

    const previewPayload = {
      weekId: parsed.weekId,
      targetMonth: targetMonth,
      siteSummaries: parsed.preview.siteSummaries,
      missingStaff: parsed.preview.missingStaff,
      missingSiteMaster: parsed.preview.missingSiteMaster,
      missingOpenChat: parsed.preview.missingOpenChat,
      unmatchedNames: parsed.preview.unmatchedNames,
      parseErrors: parsed.preview.parseErrors,
      totalAssignments: parsed.records.length,
      recipientCount: parsed.records.length
    };

    const logSheet = ensureBroadcastLogMonthSheet_(ss, targetMonth);
    const existing = findBroadcastLogByOperationId_(logSheet, operationId);
    const existingStatus = sanitizeString_(existing.status).toUpperCase();
    const broadcastId = sanitizeString_(existing.broadcastId) || buildBroadcastId_(targetMonth);
    const isFinalized = existingStatus === 'PREPARED' || existingStatus === 'SENT' || existingStatus === 'PARTIAL';
    const responseStatus = isFinalized ? existingStatus : 'DRAFT';

    if (!isFinalized) {
      const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
      const logUpsert = upsertSheetRowById_(logSheet, 'broadcastId', broadcastId, {
        broadcastId: broadcastId,
        operationId: operationId,
        weekId: parsed.weekId,
        targetMonth: targetMonth,
        status: 'DRAFT',
        preparedAt: '',
        sentAt: '',
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
        totalRecipients: parsed.records.length,
        missingStaffJson: safeJsonStringify_(parsed.preview.missingStaff),
        missingSiteMasterJson: safeJsonStringify_(parsed.preview.missingSiteMaster),
        missingOpenChatJson: safeJsonStringify_(parsed.preview.missingOpenChat),
        unmatchedNamesJson: safeJsonStringify_(parsed.preview.unmatchedNames),
        previewJson: safeJsonStringify_(previewPayload),
        rawText: rawText,
        requestId: requestId,
        updatedAt: nowStr
      });
      if (!logUpsert.ok) {
        return errorResponse_(logUpsert.code, logUpsert.message, logUpsert.details || {}, requestId, true);
      }
    }

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.broadcast.preview',
      operationId: operationId,
      targetType: 'broadcast.preview',
      targetId: parsed.weekId,
      fromState: '',
      toState: responseStatus,
      details: {
        targetMonth,
        weekId: parsed.weekId,
        broadcastId: broadcastId,
        status: responseStatus,
        totalAssignments: parsed.records.length,
        missingStaffCount: parsed.preview.missingStaff.length
      },
      requestId: requestId
    });

    return okResponse_(
      {
        broadcastId: broadcastId,
        status: responseStatus,
        operationId,
        targetMonth,
        weekId: parsed.weekId,
        siteCount: parsed.preview.siteSummaries.length,
        totalAssignments: parsed.records.length,
        missingStaff: parsed.preview.missingStaff,
        missingSiteMaster: parsed.preview.missingSiteMaster,
        missingOpenChat: parsed.preview.missingOpenChat,
        unmatchedNames: parsed.preview.unmatchedNames,
        siteSummaries: parsed.preview.siteSummaries,
        preview: parsed.preview
      },
      requestId
    );
  });
}

function handleAdminBroadcastSendPrepare_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'APPROVER', requestId, 'admin.broadcast.send.prepare');
  if (!roleCheck.ok) return roleCheck.response;

  const targetMonth = sanitizeString_(data && data.targetMonth);
  const rawText = sanitizeString_(data && data.rawText);
  const operationId = sanitizeString_(data && data.operationId) || requestId;

  const fields = [];
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!rawText) fields.push({ field: 'rawText', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    if (isMonthLocked_(ss, targetMonth)) {
      return errorResponse_('E_MONTH_LOCKED', 'Target month is locked. Post-lock changes must be recorded as adjustment in next month.', {
        month: targetMonth,
        adjustmentMonth: addMonthsYm_(targetMonth, 1)
      }, requestId, false);
    }

    const logSheet = ensureBroadcastLogMonthSheet_(ss, targetMonth);
    const existing = findBroadcastLogByOperationId_(logSheet, operationId);
    const existingStatus = sanitizeString_(existing.status).toUpperCase();
    if (existing.row > 0 && existingStatus && existingStatus !== 'DRAFT') {
      const existingBroadcastId = sanitizeString_(existing.broadcastId);
      const recipients = existingStatus === 'PREPARED' && existingBroadcastId
        ? listBroadcastRecipientsByBroadcastId_(ss, existingBroadcastId)
        : [];
      return okResponse_({
        alreadyProcessed: true,
        broadcastId: existingBroadcastId,
        operationId,
        targetMonth,
        status: existing.status,
        preview: existing.preview,
        recipients: recipients
      }, requestId);
    }

    const parsed = parseWeeklyBroadcastPayloadV7_(ss, targetMonth, rawText, requestId);
    if (!parsed.ok) {
      return errorResponse_(parsed.code || 'E_VALIDATION', parsed.message || 'Parse failed.', parsed.details || {}, requestId);
    }

    const broadcastId = sanitizeString_(existing.broadcastId) || buildBroadcastId_(targetMonth);
    const persisted = persistWeekAssignmentsFromBroadcast_(ss, {
      targetMonth,
      weekId: parsed.weekId,
      broadcastId,
      operationId,
      records: parsed.records,
      requestId
    });

    if (!persisted.ok) {
      return errorResponse_(persisted.code || 'E_APPEND_FAILED', persisted.message || 'Failed to persist assignments.', persisted.details || {}, requestId, true);
    }

    const recipients = buildBroadcastRecipientsFromRecords_(parsed.records);
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    const previewPayload = {
      weekId: parsed.weekId,
      targetMonth,
      siteSummaries: parsed.preview.siteSummaries,
      missingStaff: parsed.preview.missingStaff,
      missingSiteMaster: parsed.preview.missingSiteMaster,
      missingOpenChat: parsed.preview.missingOpenChat,
      unmatchedNames: parsed.preview.unmatchedNames,
      totalAssignments: parsed.records.length,
      recipientCount: recipients.length
    };

    const logUpsert = upsertSheetRowById_(logSheet, 'broadcastId', broadcastId, {
      broadcastId: broadcastId,
      operationId: operationId,
      weekId: parsed.weekId,
      targetMonth: targetMonth,
      status: 'PREPARED',
      preparedAt: nowStr,
      sentAt: '',
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      totalRecipients: recipients.length,
      missingStaffJson: safeJsonStringify_(parsed.preview.missingStaff),
      missingSiteMasterJson: safeJsonStringify_(parsed.preview.missingSiteMaster),
      missingOpenChatJson: safeJsonStringify_(parsed.preview.missingOpenChat),
      unmatchedNamesJson: safeJsonStringify_(parsed.preview.unmatchedNames),
      previewJson: safeJsonStringify_(previewPayload),
      rawText: rawText,
      requestId: requestId,
      updatedAt: nowStr
    });
    if (!logUpsert.ok) return errorResponse_(logUpsert.code, logUpsert.message, logUpsert.details || {}, requestId, true);

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.broadcast.send.prepare',
      operationId: operationId,
      targetType: 'broadcast',
      targetId: broadcastId,
      fromState: '',
      toState: 'PREPARED',
      details: {
        targetMonth,
        weekId: parsed.weekId,
        recipientCount: recipients.length,
        totalAssignments: parsed.records.length,
        insertedRows: persisted.insertedRows
      },
      requestId: requestId
    });

    return okResponse_({
      broadcastId,
      operationId,
      targetMonth,
      weekId: parsed.weekId,
      preview: previewPayload,
      recipients,
      alreadyProcessed: false
    }, requestId);
  });
}

function handleAdminBroadcastSendFinalize_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'APPROVER', requestId, 'admin.broadcast.send.finalize');
  if (!roleCheck.ok) return roleCheck.response;

  const targetMonth = sanitizeString_(data && data.targetMonth);
  const broadcastId = sanitizeString_(data && data.broadcastId);
  const operationId = sanitizeString_(data && data.operationId) || requestId;
  const delivery = data && data.delivery && typeof data.delivery === 'object' ? data.delivery : {};
  const deliveries = Array.isArray(delivery.deliveries) ? delivery.deliveries : [];

  const fields = [];
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!broadcastId) fields.push({ field: 'broadcastId', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const logSheet = ensureBroadcastLogMonthSheet_(ss, targetMonth);
    const current = findBroadcastLogByBroadcastId_(logSheet, broadcastId);
    if (current.row < 2) {
      return errorResponse_('E_NOT_FOUND', 'Broadcast log not found.', { broadcastId, targetMonth }, requestId);
    }

    if (current.status === 'SENT' || current.status === 'PARTIAL') {
      return okResponse_({
        alreadyProcessed: true,
        broadcastId,
        targetMonth,
        status: current.status,
        sentCount: Number(current.sentCount || 0),
        failedCount: Number(current.failedCount || 0),
        skippedCount: Number(current.skippedCount || 0)
      }, requestId);
    }

    if (current.status !== 'PREPARED') {
      return errorResponse_('E_INVALID_STATE', 'Broadcast can only be finalized from PREPARED.', {
        broadcastId,
        currentStatus: current.status
      }, requestId, false);
    }

    const pushed = Number(delivery.pushed || 0);
    const failed = Number(delivery.failed || 0);
    const skipped = Number(delivery.skipped || 0);
    const finalStatus = failed > 0 ? 'PARTIAL' : 'SENT';
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');

    const failedJobStats = persistFailedJobsFromDeliveries_(ss, targetMonth, {
      broadcastId,
      operationId,
      deliveries,
      requestId
    });

    const patch = {
      status: finalStatus,
      sentAt: nowStr,
      sentCount: pushed,
      failedCount: failed,
      skippedCount: skipped,
      updatedAt: nowStr,
      requestId: requestId
    };

    const upsert = upsertSheetRowById_(logSheet, 'broadcastId', broadcastId, patch);
    if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details || {}, requestId, true);

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.broadcast.send.finalize',
      operationId: operationId,
      targetType: 'broadcast',
      targetId: broadcastId,
      fromState: 'PREPARED',
      toState: finalStatus,
      details: {
        targetMonth,
        pushed,
        failed,
        skipped,
        failedJobsCreated: failedJobStats.created,
        failedJobsWriteFailed: failedJobStats.writeFailed
      },
      requestId: requestId
    });

    return okResponse_({
      broadcastId,
      targetMonth,
      status: finalStatus,
      sentCount: pushed,
      failedCount: failed,
      skippedCount: skipped,
      failedJobsCreated: failedJobStats.created,
      failedJobsWriteFailed: failedJobStats.writeFailed,
      warning: failedJobStats.writeFailed > 0 ? 'FAILED_JOB_WRITE_PARTIAL' : ''
    }, requestId);
  });
}

function handleAdminBroadcastRetryFailedPrepare_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'APPROVER', requestId, 'admin.broadcast.retryFailed.prepare');
  if (!roleCheck.ok) return roleCheck.response;

  const targetMonth = sanitizeString_(data && data.targetMonth);
  const broadcastId = sanitizeString_(data && data.broadcastId);
  const operationId = sanitizeString_(data && data.operationId) || requestId;

  const fields = [];
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!broadcastId) fields.push({ field: 'broadcastId', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  const failedJobs = listFailedJobsByBroadcast_(ss, targetMonth, broadcastId);

  appendAuditLog_(ss, {
    actorType: roleCheck.actor.actorType,
    actorId: roleCheck.actor.actorId,
    actorRole: roleCheck.actor.role,
    action: 'admin.broadcast.retryFailed.prepare',
    operationId: operationId,
    targetType: 'broadcast',
    targetId: broadcastId,
    fromState: '',
    toState: 'RETRY_PREPARED',
    details: {
      targetMonth,
      failedJobCount: failedJobs.length
    },
    requestId: requestId
  });

  return okResponse_({
    broadcastId,
    targetMonth,
    operationId,
    failedJobs: failedJobs
  }, requestId);
}

function handleAdminBroadcastRetryFailedFinalize_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'APPROVER', requestId, 'admin.broadcast.retryFailed.finalize');
  if (!roleCheck.ok) return roleCheck.response;

  const targetMonth = sanitizeString_(data && data.targetMonth);
  const broadcastId = sanitizeString_(data && data.broadcastId);
  const operationId = sanitizeString_(data && data.operationId) || requestId;
  const delivery = data && data.delivery && typeof data.delivery === 'object' ? data.delivery : {};
  const deliveries = Array.isArray(delivery.deliveries) ? delivery.deliveries : [];

  const fields = [];
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) fields.push({ field: 'targetMonth', reason: 'must be YYYY-MM' });
  if (!broadcastId) fields.push({ field: 'broadcastId', reason: 'required' });
  if (!operationId) fields.push({ field: 'operationId', reason: 'required' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const updated = finalizeFailedJobRetries_(ss, targetMonth, deliveries, requestId);
    const remainingFailed = listFailedJobsByBroadcast_(ss, targetMonth, broadcastId).length;
    const finalStatus = remainingFailed > 0 ? 'PARTIAL' : 'SENT';
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    const logSheet = ensureBroadcastLogMonthSheet_(ss, targetMonth);
    const logUpsert = upsertSheetRowById_(logSheet, 'broadcastId', broadcastId, {
      status: finalStatus,
      failedCount: remainingFailed,
      updatedAt: nowStr,
      requestId: requestId
    });
    if (!logUpsert.ok) return errorResponse_(logUpsert.code, logUpsert.message, logUpsert.details || {}, requestId, true);

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.broadcast.retryFailed.finalize',
      operationId: operationId,
      targetType: 'broadcast',
      targetId: broadcastId,
      fromState: 'RETRY_PREPARED',
      toState: 'RETRY_DONE',
      details: {
        targetMonth,
        updated: updated,
        remainingFailed: remainingFailed,
        status: finalStatus
      },
      requestId: requestId
    });

    return okResponse_({
      broadcastId,
      targetMonth,
      operationId,
      updated,
      remainingFailed: remainingFailed,
      status: finalStatus
    }, requestId);
  });
}

function handleAdminApprovalPending_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'VIEWER', requestId, 'admin.approval.pending');
  if (!roleCheck.ok) return roleCheck.response;

  const month = sanitizeString_(data && data.month) || Utilities.formatDate(new Date(), TZ_, 'yyyy-MM');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, requestId);
  }

  const sheet = ensureApprovalQueueMonthSheet_(ss, month);
  const table = readTable_(sheet);
  const items = [];
  if (table.ok && table.values.length > 1) {
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxApprovalId = indexOfHeader_(headers, ['approvalid']);
    const idxKind = indexOfHeader_(headers, ['kind']);
    const idxStatus = indexOfHeader_(headers, ['status']);
    const idxTargetId = indexOfHeader_(headers, ['targetid']);
    const idxCreatedAt = indexOfHeader_(headers, ['createdat']);
    const idxRequestedBy = indexOfHeader_(headers, ['requestedby']);
    const idxReason = indexOfHeader_(headers, ['reason']);
    for (let r = 1; r < table.values.length; r++) {
      const row = table.values[r];
      if (sanitizeString_(row[idxStatus]).toUpperCase() !== 'PENDING') continue;
      items.push({
        approvalId: idxApprovalId >= 0 ? sanitizeString_(row[idxApprovalId]) : '',
        kind: idxKind >= 0 ? sanitizeString_(row[idxKind]) : '',
        status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : 'PENDING',
        targetId: idxTargetId >= 0 ? sanitizeString_(row[idxTargetId]) : '',
        createdAt: idxCreatedAt >= 0 ? sanitizeString_(row[idxCreatedAt]) : '',
        requestedBy: idxRequestedBy >= 0 ? sanitizeString_(row[idxRequestedBy]) : '',
        reason: idxReason >= 0 ? sanitizeString_(row[idxReason]) : ''
      });
    }
  }

  return okResponse_({ month, items }, requestId);
}

function handleAdminApprovalDecide_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'APPROVER', requestId, 'admin.approval.decide');
  if (!roleCheck.ok) return roleCheck.response;

  const approvalId = sanitizeString_(data && data.approvalId);
  const decisionRaw = sanitizeString_(data && data.decision).toUpperCase();
  const decision = decisionRaw === 'APPROVE' ? 'APPROVED' : (decisionRaw === 'REJECT' ? 'REJECTED' : '');
  const reason = sanitizeString_(data && data.reason);

  const fields = [];
  if (!approvalId) fields.push({ field: 'approvalId', reason: 'required' });
  if (!decision) fields.push({ field: 'decision', reason: 'must be approve/reject' });
  if (fields.length) return errorResponse_('E_VALIDATION', 'Validation failed.', { fields }, requestId);

  return withScriptLock_(requestId, function() {
    const located = findApprovalById_(ss, approvalId);
    if (!located.sheet || located.row < 2) {
      return errorResponse_('E_NOT_FOUND', 'Approval not found.', { approvalId }, requestId);
    }

    if (sanitizeString_(located.status).toUpperCase() !== 'PENDING') {
      return errorResponse_('E_INVALID_STATE', 'Approval can only be decided from PENDING.', {
        approvalId,
        currentStatus: located.status
      }, requestId, false);
    }

    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    const patch = {
      status: decision,
      decidedAt: nowStr,
      decidedBy: roleCheck.actor.actorId,
      decisionReason: reason,
      updatedAt: nowStr,
      requestId: requestId
    };

    const upsert = upsertSheetRowById_(located.sheet, 'approvalId', approvalId, patch);
    if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details || {}, requestId, true);

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.approval.decide',
      operationId: sanitizeString_(data && data.operationId) || requestId,
      targetType: 'approval',
      targetId: approvalId,
      fromState: 'PENDING',
      toState: decision,
      details: {
        reason: reason
      },
      requestId: requestId
    });

    return okResponse_({ approvalId, status: decision }, requestId);
  });
}

function handleAdminMonthlyCloseExport_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'ADMIN', requestId, 'admin.monthly.close.export');
  if (!roleCheck.ok) return roleCheck.response;

  const month = sanitizeString_(data && data.month);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return errorResponse_('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, requestId);
  }

  return withScriptLock_(requestId, function() {
    const lockSheet = ensureMonthlyLockSheet_(ss, month);
    const lock = findMonthlyLockByMonth_(lockSheet, month);
    if (lock.row > 0 && sanitizeString_(lock.status).toUpperCase() === 'LOCKED') {
      return okResponse_({
        month,
        status: 'LOCKED',
        alreadyLocked: true,
        fileId: lock.exportFileId,
        fileUrl: lock.exportFileUrl
      }, requestId);
    }

    const exportOutput = handleMonthlyFileGenerate_(ss, { month: month }, requestId);
    const exportPayload = parseActionResponsePayload_(exportOutput);
    if (!exportPayload || exportPayload.ok !== true) {
      return errorResponse_('E_UPSTREAM', 'monthly.file.generate failed.', {
        month,
        response: exportPayload || null
      }, requestId, true);
    }

    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    const upsert = upsertSheetRowById_(lockSheet, 'month', month, {
      month: month,
      status: 'LOCKED',
      lockedAt: nowStr,
      lockedBy: roleCheck.actor.actorId,
      exportFileId: sanitizeString_(exportPayload.data && exportPayload.data.fileId),
      exportFileUrl: sanitizeString_(exportPayload.data && exportPayload.data.fileUrl),
      requestId: requestId,
      updatedAt: nowStr
    });
    if (!upsert.ok) return errorResponse_(upsert.code, upsert.message, upsert.details || {}, requestId, true);

    appendAuditLog_(ss, {
      actorType: roleCheck.actor.actorType,
      actorId: roleCheck.actor.actorId,
      actorRole: roleCheck.actor.role,
      action: 'admin.monthly.close.export',
      operationId: sanitizeString_(data && data.operationId) || requestId,
      targetType: 'month',
      targetId: month,
      fromState: 'OPEN',
      toState: 'LOCKED',
      details: {
        fileId: sanitizeString_(exportPayload.data && exportPayload.data.fileId),
        fileUrl: sanitizeString_(exportPayload.data && exportPayload.data.fileUrl)
      },
      requestId: requestId
    });

    return okResponse_({
      month,
      status: 'LOCKED',
      alreadyLocked: false,
      fileId: sanitizeString_(exportPayload.data && exportPayload.data.fileId),
      fileUrl: sanitizeString_(exportPayload.data && exportPayload.data.fileUrl)
    }, requestId);
  });
}

function handleAdminHotelSummary_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'VIEWER', requestId, 'admin.hotel.summary');
  if (!roleCheck.ok) return roleCheck.response;

  const weekId = sanitizeString_(data && data.weekId);
  const siteId = sanitizeString_(data && data.siteId);
  const roleFilter = sanitizeString_(data && data.role).toUpperCase();

  const assignments = queryWeekAssignmentsByFilter_(ss, {
    weekId: weekId,
    siteId: siteId,
    role: roleFilter
  });

  const requiredUsers = {};
  assignments.forEach(function(item) {
    const uid = sanitizeString_(item.userId);
    if (!uid) return;
    requiredUsers[uid] = {
      userId: uid,
      lineUserId: sanitizeString_(item.lineUserId),
      name: sanitizeString_(item.staffNameRaw),
      siteId: sanitizeString_(item.siteId),
      role: sanitizeString_(item.role)
    };
  });

  const requiredList = Object.keys(requiredUsers).map(function(uid) { return requiredUsers[uid]; });
  const answeredMap = buildHotelAnsweredMapForAssignments_(ss, assignments);

  const answered = [];
  const missing = [];
  requiredList.forEach(function(row) {
    if (answeredMap[row.userId]) answered.push(row);
    else missing.push(row);
  });

  return okResponse_({
    weekId: weekId,
    siteId: siteId,
    role: roleFilter,
    requiredCount: requiredList.length,
    answeredCount: answered.length,
    missingCount: missing.length,
    required: requiredList,
    answered: answered,
    missing: missing
  }, requestId);
}

function handleAdminAuditLookup_(ss, data, requestId) {
  const roleCheck = requireAdminRoleForAction_(ss, data, 'VIEWER', requestId, 'admin.audit.lookup');
  if (!roleCheck.ok) return roleCheck.response;

  const keyword = sanitizeString_(data && data.keyword).toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(data && data.limit) || 20));

  const sheet = ensureAuditLogSheet_(ss);
  const table = readTable_(sheet);
  const items = [];
  if (table.ok && table.values.length > 1) {
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxAuditId = indexOfHeader_(headers, ['auditid']);
    const idxTimestamp = indexOfHeader_(headers, ['timestamp']);
    const idxActorId = indexOfHeader_(headers, ['actorid']);
    const idxActorRole = indexOfHeader_(headers, ['actorrole']);
    const idxAction = indexOfHeader_(headers, ['action']);
    const idxOperationId = indexOfHeader_(headers, ['operationid']);
    const idxTargetId = indexOfHeader_(headers, ['targetid']);
    const idxDetails = indexOfHeader_(headers, ['detailsjson']);

    for (let r = table.values.length - 1; r >= 1; r--) {
      if (items.length >= limit) break;
      const row = table.values[r];
      const item = {
        auditId: idxAuditId >= 0 ? sanitizeString_(row[idxAuditId]) : '',
        timestamp: idxTimestamp >= 0 ? sanitizeString_(row[idxTimestamp]) : '',
        actor: idxActorId >= 0 ? sanitizeString_(row[idxActorId]) : '',
        actorRole: idxActorRole >= 0 ? sanitizeString_(row[idxActorRole]) : '',
        event: idxAction >= 0 ? sanitizeString_(row[idxAction]) : '',
        operationId: idxOperationId >= 0 ? sanitizeString_(row[idxOperationId]) : '',
        targetId: idxTargetId >= 0 ? sanitizeString_(row[idxTargetId]) : '',
        detailsJson: idxDetails >= 0 ? sanitizeString_(row[idxDetails]) : ''
      };
      if (!keyword) {
        items.push(item);
        continue;
      }
      const bag = [item.auditId, item.actor, item.actorRole, item.event, item.operationId, item.targetId, item.detailsJson].join(' ').toLowerCase();
      if (bag.indexOf(keyword) >= 0) items.push(item);
    }
  }

  return okResponse_({ keyword: keyword, items: items }, requestId);
}

function requireAdminRoleForAction_(ss, data, requiredRole, requestId, actionName) {
  const actorType = sanitizeString_(data && data.actorType).toLowerCase() || 'slack';
  const required = sanitizeString_(requiredRole).toUpperCase() || 'VIEWER';

  const actorSlackUserId = sanitizeString_(data && data.actorSlackUserId);
  if (!actorSlackUserId) {
    return {
      ok: false,
      response: errorResponse_('E_FORBIDDEN', 'Slack actor is required.', { action: actionName }, requestId, false)
    };
  }

  const roleResolved = resolveRoleBindingBySlackUserId_(ss, actorSlackUserId);
  if (!roleResolved.allowed) {
    return {
      ok: false,
      response: errorResponse_('E_FORBIDDEN', 'Slack actor has no active role binding.', { action: actionName, actorSlackUserId }, requestId, false)
    };
  }

  const actorRank = roleRank_(roleResolved.role);
  const requiredRank = roleRank_(required);
  if (actorRank < requiredRank) {
    return {
      ok: false,
      response: errorResponse_('E_FORBIDDEN', 'Insufficient role for action.', {
        action: actionName,
        requiredRole: required,
        currentRole: roleResolved.role
      }, requestId, false)
    };
  }

  return {
    ok: true,
    actor: {
      actorType: actorType,
      actorId: actorSlackUserId,
      role: roleResolved.role,
      roleBinding: roleResolved.roleBinding
    }
  };
}

function resolveRoleBindingBySlackUserId_(ss, slackUserId) {
  const uid = sanitizeString_(slackUserId);
  if (!uid) return { allowed: false, role: '', roleBinding: null };

  const sheet = ensureRoleBindingsSheet_(ss);
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return { allowed: false, role: '', roleBinding: null };

  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxSlackUserId = indexOfHeader_(headers, ['slackuserid', 'slack_user_id']);
  const idxRole = indexOfHeader_(headers, ['role']);
  const idxIsActive = indexOfHeader_(headers, ['isactive', 'is_active']);
  const idxBindingId = indexOfHeader_(headers, ['bindingid']);
  const idxUpdatedAt = indexOfHeader_(headers, ['updatedat']);
  if (idxSlackUserId < 0 || idxRole < 0) return { allowed: false, role: '', roleBinding: null };

  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (sanitizeString_(row[idxSlackUserId]) !== uid) continue;
    const role = sanitizeString_(row[idxRole]).toUpperCase();
    const active = idxIsActive < 0 ? true : parseBooleanValue_(row[idxIsActive], true);
    if (!active) return { allowed: false, role: role, roleBinding: null };
    if (roleRank_(role) <= 0) return { allowed: false, role: role, roleBinding: null };
    return {
      allowed: true,
      role: role,
      roleBinding: {
        bindingId: idxBindingId >= 0 ? sanitizeString_(row[idxBindingId]) : '',
        slackUserId: uid,
        role: role,
        updatedAt: idxUpdatedAt >= 0 ? sanitizeString_(row[idxUpdatedAt]) : ''
      }
    };
  }

  return { allowed: false, role: '', roleBinding: null };
}

function roleRank_(role) {
  const text = sanitizeString_(role).toUpperCase();
  if (text === 'VIEWER') return 1;
  if (text === 'APPROVER') return 2;
  if (text === 'ADMIN') return 3;
  return 0;
}

function parseWeeklyBroadcastPayloadV7_(ss, targetMonth, rawText, requestId) {
  const month = sanitizeString_(targetMonth);
  const text = String(rawText || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, code: 'E_VALIDATION', message: 'targetMonth must be YYYY-MM', details: { field: 'targetMonth' } };
  }
  if (!text.trim()) {
    return { ok: false, code: 'E_VALIDATION', message: 'rawText is required', details: { field: 'rawText' } };
  }

  const staffSheet = ss.getSheetByName(SHEET_STAFF_);
  const siteSheet = ss.getSheetByName(SHEET_SITE_MASTER_);
  const staffIndex = buildStaffMasterIndex_(staffSheet);
  const staffMap = staffSheet ? buildStaffMapFast_(staffSheet) : {};
  const siteIndex = buildSiteMasterExtendedIndex_(siteSheet);

  const blocks = splitBlocks_(text);
  const records = [];
  const missingStaff = [];
  const missingSiteMaster = [];
  const missingOpenChat = [];
  const unmatchedNames = [];
  const siteSummaryMap = {};
  const parseErrors = [];

  let firstRangeStart = '';

  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b] || {};
    const lines = Array.isArray(block.lines) ? block.lines : [];
    if (lines.length === 0) continue;

    const header = extractBroadcastHeaderFromLines_(lines);
    if (!header.ok) {
      parseErrors.push({
        blockIndex: b,
        reason: header.reason || 'header_not_found'
      });
      continue;
    }

    const siteRaw = sanitizeString_(header.siteRaw);
    const siteFromDay = Number(header.periodFromDay);
    const siteToDay = Number(header.periodToDay);
    const range = resolveSiteDateRangeForTargetMonth_(month, siteFromDay, siteToDay);
    if (!firstRangeStart && range.fromDate) firstRangeStart = range.fromDate;

    const siteHit = matchSiteExtended_(siteRaw, siteIndex);
    if (!siteHit.siteId) {
      pushUniqueByKey_(missingSiteMaster, {
        siteRaw: siteRaw,
        reason: 'site_master_unmatched'
      }, 'siteRaw');
    }
    if (siteHit.siteId && !siteHit.openChatUrl) {
      pushUniqueByKey_(missingOpenChat, {
        siteId: siteHit.siteId,
        siteName: siteHit.siteNameNorm || siteRaw,
        siteRaw: siteRaw
      }, 'siteId');
    }

    const bodyLines = lines.slice(header.lineIndex + 1);
    for (let i = 0; i < bodyLines.length; i++) {
      const line = sanitizeString_(bodyLines[i] && bodyLines[i].lineText);
      if (!line) continue;
      const roleMatch = line.match(/^(DL|CL|CA)\s*[:：]\s*(.+)$/i);
      if (!roleMatch) continue;

      const role = sanitizeString_(roleMatch[1]).toUpperCase();
      const body = sanitizeString_(roleMatch[2]);
      const expanded = expandBroadcastRoleBody_(body, month, siteFromDay, siteToDay);

      for (let e = 0; e < expanded.length; e++) {
        const entry = expanded[e];
        const staffNameRaw = sanitizeString_(entry.staffNameRaw);
        const workDate = sanitizeString_(entry.workDate);
        if (!workDate) continue;

        const matchedUserId = matchStaffUserId_(staffNameRaw, staffIndex);
        if (!matchedUserId) {
          if (staffNameRaw) {
            const missing = {
              name: staffNameRaw,
              role: role,
              siteRaw: siteRaw,
              workDate: workDate
            };
            missingStaff.push(missing);
            unmatchedNames.push(missing);
          }
          continue;
        }

        const staff = staffMap[matchedUserId] || {};
        const lineUserId = sanitizeString_(staff.lineUserId);
        if (!lineUserId) {
          missingStaff.push({
            name: staffNameRaw,
            role: role,
            siteRaw: siteRaw,
            workDate: workDate,
            reason: 'line_user_missing'
          });
          continue;
        }

        const assignmentKey = [matchedUserId, workDate, siteHit.siteId || siteRaw, role].join('|');
        if (!siteSummaryMap[assignmentKey]) {
          const item = {
            userId: matchedUserId,
            lineUserId: lineUserId,
            staffNameRaw: staffNameRaw,
            role: role,
            workDate: workDate,
            weekId: '',
            siteId: sanitizeString_(siteHit.siteId),
            siteName: sanitizeString_(siteHit.siteNameNorm) || siteRaw,
            siteRaw: siteRaw,
            openChatUrl: sanitizeString_(siteHit.openChatUrl),
            dateRangeFrom: range.fromDate,
            dateRangeTo: range.toDate,
            dateRange: range.fromDate && range.toDate ? (range.fromDate + ' ~ ' + range.toDate) : '',
            targetMonth: month
          };
          siteSummaryMap[assignmentKey] = item;
          records.push(item);
        }

        const siteSummaryKey = sanitizeString_(siteHit.siteId) || siteRaw;
        if (!siteSummaryMap['SUMMARY:' + siteSummaryKey]) {
          siteSummaryMap['SUMMARY:' + siteSummaryKey] = {
            siteId: sanitizeString_(siteHit.siteId),
            siteName: sanitizeString_(siteHit.siteNameNorm) || siteRaw,
            siteRaw: siteRaw,
            assignmentCount: 0
          };
        }
        siteSummaryMap['SUMMARY:' + siteSummaryKey].assignmentCount += 1;
      }
    }
  }

  const anchor = firstRangeStart || (month + '-01');
  const weekId = deriveIsoWeekId_(anchor);
  records.forEach(function(rec) { rec.weekId = weekId; });

  const siteSummaries = Object.keys(siteSummaryMap)
    .filter(function(k) { return k.indexOf('SUMMARY:') === 0; })
    .map(function(k) { return siteSummaryMap[k]; })
    .sort(function(a, b) { return String(a.siteName).localeCompare(String(b.siteName)); });

  return {
    ok: true,
    weekId: weekId,
    records: records,
    preview: {
      weekId: weekId,
      targetMonth: month,
      totalAssignments: records.length,
      siteSummaries: siteSummaries,
      missingStaff: missingStaff,
      missingSiteMaster: missingSiteMaster,
      missingOpenChat: missingOpenChat,
      unmatchedNames: unmatchedNames,
      parseErrors: parseErrors
    }
  };
}

function extractBroadcastHeaderFromLines_(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = sanitizeString_(lines[i] && lines[i].lineText);
    if (!line) continue;
    const parsed = parseSiteHeader_(line);
    if (parsed.ok) {
      return {
        ok: true,
        lineIndex: i,
        siteRaw: parsed.siteRaw,
        periodFromDay: parsed.periodFromDay,
        periodToDay: parsed.periodToDay
      };
    }
  }
  return { ok: false, reason: 'site_header_not_found' };
}

function expandBroadcastRoleBody_(body, targetMonth, siteFromDay, siteToDay) {
  const text = sanitizeString_(body);
  if (!text) return [];

  if (text.indexOf('調整中') >= 0) {
    return [];
  }

  const normalized = normalizeArrows_(text).replace(/\s*→\s*/g, '→');
  const segments = normalized.indexOf('→') >= 0
    ? normalized.split('→').map(function(v) { return sanitizeString_(v); }).filter(Boolean)
    : [normalized];

  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dayMatch = seg.match(/(\d{1,2})\s*日/);
    const day = dayMatch ? Number(dayMatch[1]) : null;
    const noDay = sanitizeString_(seg.replace(/\d{1,2}\s*日/g, ''));
    const names = splitBroadcastNames_(noDay);

    const dates = day
      ? [resolveDayToYmdWithMonthContext_(targetMonth, siteFromDay, siteToDay, day)]
      : expandSiteRangeToYmdList_(targetMonth, siteFromDay, siteToDay);

    for (let d = 0; d < dates.length; d++) {
      const ymd = sanitizeString_(dates[d]);
      if (!ymd) continue;
      for (let n = 0; n < names.length; n++) {
        const name = sanitizeString_(names[n]);
        if (!name) continue;
        out.push({ workDate: ymd, staffNameRaw: name });
      }
    }
  }

  return out;
}

function splitBroadcastNames_(text) {
  const src = sanitizeString_(text);
  if (!src) return [];
  return src
    .split(/[、,，\/・]/)
    .map(function(v) { return sanitizeString_(v); })
    .filter(Boolean);
}

function resolveSiteDateRangeForTargetMonth_(targetMonth, fromDay, toDay) {
  const from = Number(fromDay);
  const to = Number(toDay);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { fromDate: '', toDate: '' };
  }

  const crossMonth = from > to;
  if (!crossMonth) {
    return {
      fromDate: buildYmdFromMonthDay_(targetMonth, from),
      toDate: buildYmdFromMonthDay_(targetMonth, to)
    };
  }

  const prevMonth = addMonthsYm_(targetMonth, -1);
  return {
    fromDate: buildYmdFromMonthDay_(prevMonth, from),
    toDate: buildYmdFromMonthDay_(targetMonth, to)
  };
}

function resolveDayToYmdWithMonthContext_(targetMonth, siteFromDay, siteToDay, day) {
  const d = Number(day);
  if (!Number.isFinite(d) || d < 1 || d > 31) return '';
  const from = Number(siteFromDay);
  const to = Number(siteToDay);
  const crossMonth = from > to;
  if (!crossMonth) {
    return buildYmdFromMonthDay_(targetMonth, d);
  }
  if (d >= from) {
    return buildYmdFromMonthDay_(addMonthsYm_(targetMonth, -1), d);
  }
  return buildYmdFromMonthDay_(targetMonth, d);
}

function expandSiteRangeToYmdList_(targetMonth, siteFromDay, siteToDay) {
  const from = Number(siteFromDay);
  const to = Number(siteToDay);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];

  const out = [];
  if (from <= to) {
    for (let d = from; d <= to; d++) out.push(buildYmdFromMonthDay_(targetMonth, d));
    return out;
  }

  const prevMonth = addMonthsYm_(targetMonth, -1);
  const prevDays = daysInMonthFromYm_(prevMonth);
  for (let d = from; d <= prevDays; d++) out.push(buildYmdFromMonthDay_(prevMonth, d));
  for (let d = 1; d <= to; d++) out.push(buildYmdFromMonthDay_(targetMonth, d));
  return out;
}

function addMonthsYm_(month, offset) {
  const ym = sanitizeString_(month);
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  let year = Number(m[1]);
  let mon = Number(m[2]);
  const off = Number(offset || 0);
  mon += off;
  while (mon < 1) { mon += 12; year -= 1; }
  while (mon > 12) { mon -= 12; year += 1; }
  return String(year) + '-' + (mon < 10 ? '0' + mon : String(mon));
}

function deriveIsoWeekId_(ymd) {
  const dateStr = sanitizeString_(ymd);
  const base = dateStr.match(/^\d{4}-\d{2}-\d{2}$/) ? new Date(dateStr + 'T00:00:00+09:00') : new Date();
  if (!base || isNaN(base.getTime())) return '';

  const date = new Date(base.getTime());
  date.setHours(0, 0, 0, 0);
  const dayNum = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dayNum + 3);
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
  return String(date.getFullYear()) + '-W' + (week < 10 ? '0' + week : String(week));
}

function persistWeekAssignmentsFromBroadcast_(ss, input) {
  const records = Array.isArray(input && input.records) ? input.records : [];
  const broadcastId = sanitizeString_(input && input.broadcastId);
  const operationId = sanitizeString_(input && input.operationId);
  const weekId = sanitizeString_(input && input.weekId);
  const targetMonth = sanitizeString_(input && input.targetMonth);
  const requestId = sanitizeString_(input && input.requestId);

  let insertedRows = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] || {};
    const month = normalizeYm_(rec.workDate) || targetMonth;
    if (!/^\d{4}-\d{2}$/.test(month)) continue;

    const sheet = ensureWeekAssignmentsMonthSheet_(ss, month);
    const assignmentId = buildStableIdFromParts_(['wa', weekId, broadcastId, rec.userId, rec.siteId || rec.siteRaw, rec.role, rec.workDate]);
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');

    const upsert = upsertSheetRowById_(sheet, 'assignmentId', assignmentId, {
      assignmentId: assignmentId,
      broadcastId: broadcastId,
      operationId: operationId,
      weekId: weekId,
      targetMonth: targetMonth,
      workDate: sanitizeString_(rec.workDate),
      siteId: sanitizeString_(rec.siteId),
      siteName: sanitizeString_(rec.siteName),
      siteRaw: sanitizeString_(rec.siteRaw),
      role: sanitizeString_(rec.role),
      userId: sanitizeString_(rec.userId),
      lineUserId: sanitizeString_(rec.lineUserId),
      staffNameRaw: sanitizeString_(rec.staffNameRaw),
      dateRangeFrom: sanitizeString_(rec.dateRangeFrom),
      dateRangeTo: sanitizeString_(rec.dateRangeTo),
      openChatUrl: sanitizeString_(rec.openChatUrl),
      status: 'PENDING_SEND',
      createdAt: nowStr,
      updatedAt: nowStr,
      requestId: requestId
    });

    if (!upsert.ok) return { ok: false, code: upsert.code, message: upsert.message, details: upsert.details || {} };
    if (upsert.created) insertedRows += 1;
  }

  return { ok: true, insertedRows: insertedRows };
}

function buildBroadcastRecipientsFromRecords_(records) {
  const src = Array.isArray(records) ? records : [];
  return src.map(function(rec) {
    return {
      userId: sanitizeString_(rec.userId),
      lineUserId: sanitizeString_(rec.lineUserId),
      weekId: sanitizeString_(rec.weekId),
      siteId: sanitizeString_(rec.siteId),
      siteName: sanitizeString_(rec.siteName),
      siteRaw: sanitizeString_(rec.siteRaw),
      role: sanitizeString_(rec.role),
      workDate: sanitizeString_(rec.workDate),
      dateRange: sanitizeString_(rec.dateRange),
      openChatUrl: sanitizeString_(rec.openChatUrl)
    };
  });
}

function listBroadcastRecipientsByBroadcastId_(ss, broadcastId) {
  const id = sanitizeString_(broadcastId);
  if (!id) return [];

  const out = [];
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const name = sanitizeString_(sheet.getName());
    if (name.indexOf(SHEET_WEEK_ASSIGNMENTS_PREFIX_) !== 0) continue;

    const table = readTable_(sheet);
    if (!table.ok || table.values.length <= 1) continue;
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxBroadcastId = indexOfHeader_(headers, ['broadcastid']);
    if (idxBroadcastId < 0) continue;

    const idxStatus = indexOfHeader_(headers, ['status']);
    const idxUserId = indexOfHeader_(headers, ['userid']);
    const idxLineUserId = indexOfHeader_(headers, ['lineuserid']);
    const idxWeekId = indexOfHeader_(headers, ['weekid']);
    const idxSiteId = indexOfHeader_(headers, ['siteid']);
    const idxSiteName = indexOfHeader_(headers, ['sitename']);
    const idxSiteRaw = indexOfHeader_(headers, ['siteraw']);
    const idxRole = indexOfHeader_(headers, ['role']);
    const idxWorkDate = indexOfHeader_(headers, ['workdate']);
    const idxOpenChatUrl = indexOfHeader_(headers, ['openchaturl']);
    const idxDateRangeFrom = indexOfHeader_(headers, ['daterangefrom']);
    const idxDateRangeTo = indexOfHeader_(headers, ['daterangeto']);

    for (let r = 1; r < table.values.length; r++) {
      const row = table.values[r];
      if (sanitizeString_(row[idxBroadcastId]) !== id) continue;
      const status = idxStatus >= 0 ? sanitizeString_(row[idxStatus]).toUpperCase() : '';
      if (status === 'DELETED') continue;

      const dateRangeFrom = idxDateRangeFrom >= 0 ? sanitizeString_(row[idxDateRangeFrom]) : '';
      const dateRangeTo = idxDateRangeTo >= 0 ? sanitizeString_(row[idxDateRangeTo]) : '';
      const dateRange = dateRangeFrom && dateRangeTo
        ? (dateRangeFrom === dateRangeTo ? dateRangeFrom : dateRangeFrom + '〜' + dateRangeTo)
        : (dateRangeFrom || dateRangeTo);

      out.push({
        userId: idxUserId >= 0 ? sanitizeString_(row[idxUserId]) : '',
        lineUserId: idxLineUserId >= 0 ? sanitizeString_(row[idxLineUserId]) : '',
        weekId: idxWeekId >= 0 ? sanitizeString_(row[idxWeekId]) : '',
        siteId: idxSiteId >= 0 ? sanitizeString_(row[idxSiteId]) : '',
        siteName: idxSiteName >= 0 ? sanitizeString_(row[idxSiteName]) : '',
        siteRaw: idxSiteRaw >= 0 ? sanitizeString_(row[idxSiteRaw]) : '',
        role: idxRole >= 0 ? sanitizeString_(row[idxRole]) : '',
        workDate: idxWorkDate >= 0 ? sanitizeString_(row[idxWorkDate]) : '',
        dateRange: dateRange,
        openChatUrl: idxOpenChatUrl >= 0 ? sanitizeString_(row[idxOpenChatUrl]) : ''
      });
    }
  }

  return out;
}

function persistFailedJobsFromDeliveries_(ss, targetMonth, input) {
  const deliveries = Array.isArray(input && input.deliveries) ? input.deliveries : [];
  const broadcastId = sanitizeString_(input && input.broadcastId);
  const operationId = sanitizeString_(input && input.operationId);
  const requestId = sanitizeString_(input && input.requestId);
  const sheet = ensureFailedJobsMonthSheet_(ss, targetMonth);

  let created = 0;
  let writeFailed = 0;
  for (let i = 0; i < deliveries.length; i++) {
    const d = deliveries[i] || {};
    if (sanitizeString_(d.status).toLowerCase() !== 'failed') continue;

    const failedJobId = buildStableIdFromParts_(['fj', broadcastId, sanitizeString_(d.userId), sanitizeString_(d.lineUserId), sanitizeString_(d.siteId), sanitizeString_(d.role), sanitizeString_(d.workDate)]);
    const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
    const upsert = upsertSheetRowById_(sheet, 'failedJobId', failedJobId, {
      failedJobId: failedJobId,
      broadcastId: broadcastId,
      operationId: operationId,
      jobType: 'broadcast_send',
      userId: sanitizeString_(d.userId),
      lineUserId: sanitizeString_(d.lineUserId),
      siteId: sanitizeString_(d.siteId),
      role: sanitizeString_(d.role),
      workDate: sanitizeString_(d.workDate),
      errorCode: sanitizeString_(d.errorCode) || 'LINE_PUSH_FAILED',
      errorMessage: sanitizeString_(d.errorMessage),
      payloadJson: safeJsonStringify_(d),
      status: 'pending',
      retryCount: 0,
      createdAt: nowStr,
      updatedAt: nowStr,
      requestId: requestId
    });
    if (upsert.ok && upsert.created) {
      created += 1;
    } else if (!upsert.ok) {
      writeFailed += 1;
    }
  }

  return { created: created, writeFailed: writeFailed };
}

function listFailedJobsByBroadcast_(ss, targetMonth, broadcastId) {
  const sheet = ensureFailedJobsMonthSheet_(ss, targetMonth);
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return [];

  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxFailedJobId = indexOfHeader_(headers, ['failedjobid']);
  const idxBroadcastId = indexOfHeader_(headers, ['broadcastid']);
  const idxLineUserId = indexOfHeader_(headers, ['lineuserid']);
  const idxStatus = indexOfHeader_(headers, ['status']);
  const idxRetryCount = indexOfHeader_(headers, ['retrycount']);
  const idxPayload = indexOfHeader_(headers, ['payloadjson']);

  const out = [];
  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    if (sanitizeString_(row[idxBroadcastId]) !== broadcastId) continue;
    const status = sanitizeString_(row[idxStatus]).toLowerCase();
    if (status !== 'pending' && status !== 'failed') continue;
    const payload = parseJsonSafe_(idxPayload >= 0 ? row[idxPayload] : '{}');
    out.push({
      failedJobId: idxFailedJobId >= 0 ? sanitizeString_(row[idxFailedJobId]) : '',
      lineUserId: idxLineUserId >= 0 ? sanitizeString_(row[idxLineUserId]) : '',
      status: status,
      retryCount: idxRetryCount >= 0 ? Number(row[idxRetryCount] || 0) : 0,
      recipient: payload && typeof payload === 'object' ? payload : {}
    });
  }
  return out;
}

function finalizeFailedJobRetries_(ss, targetMonth, deliveries, requestId) {
  const sheet = ensureFailedJobsMonthSheet_(ss, targetMonth);
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return { updated: 0, resolved: 0, failed: 0 };

  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxFailedJobId = indexOfHeader_(headers, ['failedjobid']);
  const idxStatus = indexOfHeader_(headers, ['status']);
  const idxRetryCount = indexOfHeader_(headers, ['retrycount']);
  const idxErrorCode = indexOfHeader_(headers, ['errorcode']);
  const idxUpdatedAt = indexOfHeader_(headers, ['updatedat']);
  const idxRequestId = indexOfHeader_(headers, ['requestid']);
  if (idxFailedJobId < 0 || idxStatus < 0) return { updated: 0, resolved: 0, failed: 0 };

  const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
  const map = {};
  (Array.isArray(deliveries) ? deliveries : []).forEach(function(item) {
    const id = sanitizeString_(item && item.failedJobId);
    if (!id) return;
    map[id] = item;
  });

  let updated = 0;
  let resolved = 0;
  let failed = 0;

  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const id = sanitizeString_(row[idxFailedJobId]);
    if (!id || !map[id]) continue;
    const item = map[id];
    const status = sanitizeString_(item.status).toLowerCase() === 'sent' ? 'resolved' : 'failed';
    if (idxStatus >= 0) row[idxStatus] = status;
    if (idxRetryCount >= 0) row[idxRetryCount] = Number(row[idxRetryCount] || 0) + 1;
    if (idxErrorCode >= 0) row[idxErrorCode] = sanitizeString_(item.errorCode);
    if (idxUpdatedAt >= 0) row[idxUpdatedAt] = nowStr;
    if (idxRequestId >= 0) row[idxRequestId] = requestId;
    setRangeValuesSanitized_(sheet.getRange(r + 1, 1, 1, row.length), [row]);
    updated += 1;
    if (status === 'resolved') resolved += 1;
    else failed += 1;
  }

  return { updated: updated, resolved: resolved, failed: failed };
}

function queryWeekAssignmentsForUser_(ss, userId, weekId, monthCandidates) {
  const uid = sanitizeString_(userId);
  const targetWeekId = sanitizeString_(weekId);
  const months = Array.isArray(monthCandidates) ? monthCandidates : [];

  const items = [];
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const name = sanitizeString_(sheet.getName());
    if (name.indexOf(SHEET_WEEK_ASSIGNMENTS_PREFIX_) !== 0) continue;
    const month = name.replace(SHEET_WEEK_ASSIGNMENTS_PREFIX_, '').replace(/_/g, '-');
    if (months.length > 0 && months.indexOf(month) < 0) continue;

    const table = readTable_(sheet);
    if (!table.ok || table.values.length <= 1) continue;
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxUserId = indexOfHeader_(headers, ['userid']);
    const idxWeekId = indexOfHeader_(headers, ['weekid']);
    const idxStatus = indexOfHeader_(headers, ['status']);
    if (idxUserId < 0) continue;

    const idxSiteId = indexOfHeader_(headers, ['siteid']);
    const idxSiteName = indexOfHeader_(headers, ['sitename']);
    const idxSiteRaw = indexOfHeader_(headers, ['siteraw']);
    const idxRole = indexOfHeader_(headers, ['role']);
    const idxWorkDate = indexOfHeader_(headers, ['workdate']);
    const idxOpenChatUrl = indexOfHeader_(headers, ['openchaturl']);
    const idxBroadcastId = indexOfHeader_(headers, ['broadcastid']);

    for (let r = 1; r < table.values.length; r++) {
      const row = table.values[r];
      if (sanitizeString_(row[idxUserId]) !== uid) continue;
      if (targetWeekId && idxWeekId >= 0 && sanitizeString_(row[idxWeekId]) !== targetWeekId) continue;
      const status = idxStatus >= 0 ? sanitizeString_(row[idxStatus]).toUpperCase() : '';
      if (status === 'DELETED') continue;
      items.push({
        weekId: idxWeekId >= 0 ? sanitizeString_(row[idxWeekId]) : targetWeekId,
        userId: uid,
        siteId: idxSiteId >= 0 ? sanitizeString_(row[idxSiteId]) : '',
        siteName: idxSiteName >= 0 ? sanitizeString_(row[idxSiteName]) : '',
        siteRaw: idxSiteRaw >= 0 ? sanitizeString_(row[idxSiteRaw]) : '',
        role: idxRole >= 0 ? sanitizeString_(row[idxRole]) : '',
        workDate: idxWorkDate >= 0 ? sanitizeString_(row[idxWorkDate]) : '',
        openChatUrl: idxOpenChatUrl >= 0 ? sanitizeString_(row[idxOpenChatUrl]) : '',
        broadcastId: idxBroadcastId >= 0 ? sanitizeString_(row[idxBroadcastId]) : ''
      });
    }
  }

  return items;
}

function queryWeekAssignmentsByFilter_(ss, filter) {
  const weekId = sanitizeString_(filter && filter.weekId);
  const siteId = sanitizeString_(filter && filter.siteId);
  const role = sanitizeString_(filter && filter.role).toUpperCase();

  const items = [];
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const name = sanitizeString_(sheet.getName());
    if (name.indexOf(SHEET_WEEK_ASSIGNMENTS_PREFIX_) !== 0) continue;

    const table = readTable_(sheet);
    if (!table.ok || table.values.length <= 1) continue;
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxWeekId = indexOfHeader_(headers, ['weekid']);
    const idxSiteId = indexOfHeader_(headers, ['siteid']);
    const idxRole = indexOfHeader_(headers, ['role']);
    const idxUserId = indexOfHeader_(headers, ['userid']);
    const idxLineUserId = indexOfHeader_(headers, ['lineuserid']);
    const idxName = indexOfHeader_(headers, ['staffnameraw']);
    const idxWorkDate = indexOfHeader_(headers, ['workdate']);

    for (let r = 1; r < table.values.length; r++) {
      const row = table.values[r];
      if (weekId && idxWeekId >= 0 && sanitizeString_(row[idxWeekId]) !== weekId) continue;
      if (siteId && idxSiteId >= 0 && sanitizeString_(row[idxSiteId]) !== siteId) continue;
      if (role && idxRole >= 0 && sanitizeString_(row[idxRole]).toUpperCase() !== role) continue;
      items.push({
        weekId: idxWeekId >= 0 ? sanitizeString_(row[idxWeekId]) : weekId,
        siteId: idxSiteId >= 0 ? sanitizeString_(row[idxSiteId]) : '',
        role: idxRole >= 0 ? sanitizeString_(row[idxRole]) : '',
        userId: idxUserId >= 0 ? sanitizeString_(row[idxUserId]) : '',
        lineUserId: idxLineUserId >= 0 ? sanitizeString_(row[idxLineUserId]) : '',
        staffNameRaw: idxName >= 0 ? sanitizeString_(row[idxName]) : '',
        workDate: idxWorkDate >= 0 ? sanitizeString_(row[idxWorkDate]) : ''
      });
    }
  }

  return items;
}

function buildHotelAnsweredMapForAssignments_(ss, assignments) {
  const src = Array.isArray(assignments) ? assignments : [];
  const answered = {};
  const byMonth = {};
  src.forEach(function(item) {
    const ymd = sanitizeString_(item.workDate);
    const uid = sanitizeString_(item.userId);
    if (!uid || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    const month = ymd.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = {};
    byMonth[month][uid + '|' + ymd] = true;
  });

  const months = Object.keys(byMonth);
  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const intentRows = readHotelIntentRowsForMonth_(ensureHotelIntentSheet_(ss), month);
    for (let j = 0; j < intentRows.length; j++) {
      const row = intentRows[j];
      const key = sanitizeString_(row.userId) + '|' + sanitizeString_(row.workDate);
      if (!byMonth[month][key]) continue;
      answered[sanitizeString_(row.userId)] = true;
    }
  }

  return answered;
}

function monthCandidatesForTargetDate_(targetDate) {
  const ymd = sanitizeString_(targetDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return [];
  const month = ymd.slice(0, 7);
  return uniq_([addMonthsYm_(month, -1), month, addMonthsYm_(month, 1)]);
}

function buildSiteMasterExtendedIndex_(siteSheet) {
  const byName = {};
  if (!siteSheet) return { byName: byName };
  const table = readTable_(siteSheet);
  if (!table.ok || table.values.length <= 1) return { byName: byName };

  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxSiteId = indexOfHeader_(headers, ['siteid', 'site_id']);
  const idxSiteName = indexOfHeader_(headers, ['sitename', 'site_name', 'name']);
  const idxOpenChat = indexOfHeader_(headers, ['openchaturl', 'open_chat_url']);
  const idxAliases = indexOfHeader_(headers, ['aliases', 'alias']);

  for (let r = 1; r < table.values.length; r++) {
    const row = table.values[r];
    const siteId = idxSiteId >= 0 ? sanitizeString_(row[idxSiteId]) : '';
    const siteNameNorm = idxSiteName >= 0 ? sanitizeString_(row[idxSiteName]) : '';
    const openChatUrl = idxOpenChat >= 0 ? sanitizeString_(row[idxOpenChat]) : '';
    const aliases = idxAliases >= 0 ? sanitizeString_(row[idxAliases]).split(/[|,]/) : [];

    if (!siteId && !siteNameNorm) continue;
    addSiteExtendedIndexName_(byName, siteNameNorm, siteId, siteNameNorm, openChatUrl);
    for (let i = 0; i < aliases.length; i++) {
      addSiteExtendedIndexName_(byName, aliases[i], siteId, siteNameNorm, openChatUrl);
    }
  }

  return { byName: byName };
}

function addSiteExtendedIndexName_(byName, rawName, siteId, siteNameNorm, openChatUrl) {
  const key = normalizeSiteNameForMatch_(rawName);
  if (!key) return;
  if (!byName[key]) {
    byName[key] = {
      siteId: sanitizeString_(siteId),
      siteNameNorm: sanitizeString_(siteNameNorm),
      openChatUrl: sanitizeString_(openChatUrl)
    };
  }
}

function matchSiteExtended_(siteRaw, siteIndex) {
  const key = normalizeSiteNameForMatch_(siteRaw);
  if (!key) return { siteId: '', siteNameNorm: '', openChatUrl: '' };
  const index = siteIndex && siteIndex.byName ? siteIndex.byName : {};
  const hit = index[key];
  if (!hit) return { siteId: '', siteNameNorm: '', openChatUrl: '' };
  return {
    siteId: sanitizeString_(hit.siteId),
    siteNameNorm: sanitizeString_(hit.siteNameNorm),
    openChatUrl: sanitizeString_(hit.openChatUrl)
  };
}

function buildBroadcastId_(targetMonth) {
  const month = sanitizeString_(targetMonth).replace('-', '');
  return 'bc-' + month + '-' + Utilities.getUuid().slice(0, 8);
}

function buildStableIdFromParts_(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const text = list.map(function(v) { return sanitizeString_(v); }).join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytesToHex_(digest).slice(0, 32);
}

function findBroadcastLogByOperationId_(sheet, operationId) {
  const op = sanitizeString_(operationId);
  if (!op) return { row: 0, status: '', broadcastId: '', preview: null, sentCount: 0, failedCount: 0, skippedCount: 0 };
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return { row: 0, status: '', broadcastId: '', preview: null, sentCount: 0, failedCount: 0, skippedCount: 0 };
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxOperationId = indexOfHeader_(headers, ['operationid']);
  const idxBroadcastId = indexOfHeader_(headers, ['broadcastid']);
  const idxStatus = indexOfHeader_(headers, ['status']);
  const idxPreview = indexOfHeader_(headers, ['previewjson']);
  const idxSent = indexOfHeader_(headers, ['sentcount']);
  const idxFailed = indexOfHeader_(headers, ['failedcount']);
  const idxSkipped = indexOfHeader_(headers, ['skippedcount']);

  if (idxOperationId < 0) return { row: 0, status: '', broadcastId: '', preview: null, sentCount: 0, failedCount: 0, skippedCount: 0 };
  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (sanitizeString_(row[idxOperationId]) !== op) continue;
    return {
      row: r + 1,
      status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : '',
      broadcastId: idxBroadcastId >= 0 ? sanitizeString_(row[idxBroadcastId]) : '',
      preview: idxPreview >= 0 ? parseJsonSafe_(row[idxPreview]) : null,
      sentCount: idxSent >= 0 ? Number(row[idxSent] || 0) : 0,
      failedCount: idxFailed >= 0 ? Number(row[idxFailed] || 0) : 0,
      skippedCount: idxSkipped >= 0 ? Number(row[idxSkipped] || 0) : 0
    };
  }

  return { row: 0, status: '', broadcastId: '', preview: null, sentCount: 0, failedCount: 0, skippedCount: 0 };
}

function findBroadcastLogByBroadcastId_(sheet, broadcastId) {
  const id = sanitizeString_(broadcastId);
  if (!id) return { row: 0, status: '', sentCount: 0, failedCount: 0, skippedCount: 0 };
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return { row: 0, status: '', sentCount: 0, failedCount: 0, skippedCount: 0 };
  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxBroadcastId = indexOfHeader_(headers, ['broadcastid']);
  const idxStatus = indexOfHeader_(headers, ['status']);
  const idxSent = indexOfHeader_(headers, ['sentcount']);
  const idxFailed = indexOfHeader_(headers, ['failedcount']);
  const idxSkipped = indexOfHeader_(headers, ['skippedcount']);

  if (idxBroadcastId < 0) return { row: 0, status: '', sentCount: 0, failedCount: 0, skippedCount: 0 };
  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (sanitizeString_(row[idxBroadcastId]) !== id) continue;
    return {
      row: r + 1,
      status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : '',
      sentCount: idxSent >= 0 ? Number(row[idxSent] || 0) : 0,
      failedCount: idxFailed >= 0 ? Number(row[idxFailed] || 0) : 0,
      skippedCount: idxSkipped >= 0 ? Number(row[idxSkipped] || 0) : 0
    };
  }

  return { row: 0, status: '', sentCount: 0, failedCount: 0, skippedCount: 0 };
}

function findApprovalById_(ss, approvalId) {
  const id = sanitizeString_(approvalId);
  if (!id) return { sheet: null, row: 0, status: '' };

  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const name = sanitizeString_(sheet.getName());
    if (name.indexOf(SHEET_APPROVAL_QUEUE_PREFIX_) !== 0) continue;

    const table = readTable_(sheet);
    if (!table.ok || table.values.length <= 1) continue;
    const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
    const idxApprovalId = indexOfHeader_(headers, ['approvalid']);
    const idxStatus = indexOfHeader_(headers, ['status']);
    if (idxApprovalId < 0) continue;

    for (let r = table.values.length - 1; r >= 1; r--) {
      const row = table.values[r];
      if (sanitizeString_(row[idxApprovalId]) !== id) continue;
      return {
        sheet: sheet,
        row: r + 1,
        status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : ''
      };
    }
  }

  return { sheet: null, row: 0, status: '' };
}

function isMonthLocked_(ss, month) {
  const sheet = ensureMonthlyLockSheet_(ss, month);
  const lock = findMonthlyLockByMonth_(sheet, month);
  return lock.row > 0 && sanitizeString_(lock.status).toUpperCase() === 'LOCKED';
}

function findMonthlyLockByMonth_(sheet, month) {
  const target = sanitizeString_(month);
  const table = readTable_(sheet);
  if (!table.ok || table.values.length <= 1) return { row: 0, status: '', exportFileId: '', exportFileUrl: '' };

  const headers = table.values[0].map(function(h) { return normalizeHeaderKey_(h); });
  const idxMonth = indexOfHeader_(headers, ['month']);
  const idxStatus = indexOfHeader_(headers, ['status']);
  const idxFileId = indexOfHeader_(headers, ['exportfileid']);
  const idxFileUrl = indexOfHeader_(headers, ['exportfileurl']);
  if (idxMonth < 0) return { row: 0, status: '', exportFileId: '', exportFileUrl: '' };

  for (let r = table.values.length - 1; r >= 1; r--) {
    const row = table.values[r];
    if (sanitizeString_(row[idxMonth]) !== target) continue;
    return {
      row: r + 1,
      status: idxStatus >= 0 ? sanitizeString_(row[idxStatus]) : '',
      exportFileId: idxFileId >= 0 ? sanitizeString_(row[idxFileId]) : '',
      exportFileUrl: idxFileUrl >= 0 ? sanitizeString_(row[idxFileUrl]) : ''
    };
  }
  return { row: 0, status: '', exportFileId: '', exportFileUrl: '' };
}

function appendAuditLog_(ss, input) {
  const sheet = ensureAuditLogSheet_(ss);
  const auditId = Utilities.getUuid();
  const nowStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm:ss');
  appendRowSanitized_(sheet, [
    auditId,
    nowStr,
    sanitizeString_(input && input.actorType),
    sanitizeString_(input && input.actorId),
    sanitizeString_(input && input.actorRole),
    sanitizeString_(input && input.action),
    sanitizeString_(input && input.operationId),
    sanitizeString_(input && input.targetType),
    sanitizeString_(input && input.targetId),
    sanitizeString_(input && input.fromState),
    sanitizeString_(input && input.toState),
    safeJsonStringify_(input && input.details ? input.details : {}),
    sanitizeString_(input && input.requestId)
  ]);
}

function ensureRoleBindingsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_ROLE_BINDINGS_);
  if (!sheet) sheet = ss.insertSheet(SHEET_ROLE_BINDINGS_);
  ensureHeaderRowIfEmpty_(sheet, ['bindingId', 'slackUserId', 'lineUserId', 'email', 'role', 'isActive', 'updatedAt', 'updatedBy']);
  ensureHeaderColumnsExist_(sheet, ['bindingId', 'slackUserId', 'lineUserId', 'email', 'role', 'isActive', 'updatedAt', 'updatedBy']);
  return sheet;
}

function ensureAuditLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_AUDIT_LOG_);
  if (!sheet) sheet = ss.insertSheet(SHEET_AUDIT_LOG_);
  ensureHeaderRowIfEmpty_(sheet, ['auditId', 'timestamp', 'actorType', 'actorId', 'actorRole', 'action', 'operationId', 'targetType', 'targetId', 'fromState', 'toState', 'detailsJson', 'requestId']);
  ensureHeaderColumnsExist_(sheet, ['auditId', 'timestamp', 'actorType', 'actorId', 'actorRole', 'action', 'operationId', 'targetType', 'targetId', 'fromState', 'toState', 'detailsJson', 'requestId']);
  return sheet;
}

function ensureWeekAssignmentsMonthSheet_(ss, month) {
  const normalized = sanitizeString_(month).replace('-', '_');
  const name = SHEET_WEEK_ASSIGNMENTS_PREFIX_ + normalized;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRowIfEmpty_(sheet, ['assignmentId', 'broadcastId', 'operationId', 'weekId', 'targetMonth', 'workDate', 'siteId', 'siteName', 'siteRaw', 'role', 'userId', 'lineUserId', 'staffNameRaw', 'dateRangeFrom', 'dateRangeTo', 'openChatUrl', 'status', 'createdAt', 'updatedAt', 'requestId']);
  ensureHeaderColumnsExist_(sheet, ['assignmentId', 'broadcastId', 'operationId', 'weekId', 'targetMonth', 'workDate', 'siteId', 'siteName', 'siteRaw', 'role', 'userId', 'lineUserId', 'staffNameRaw', 'dateRangeFrom', 'dateRangeTo', 'openChatUrl', 'status', 'createdAt', 'updatedAt', 'requestId']);
  return sheet;
}

function ensureBroadcastLogMonthSheet_(ss, month) {
  const normalized = sanitizeString_(month).replace('-', '_');
  const name = SHEET_BROADCAST_LOG_PREFIX_ + normalized;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRowIfEmpty_(sheet, ['broadcastId', 'operationId', 'weekId', 'targetMonth', 'status', 'preparedAt', 'sentAt', 'sentCount', 'failedCount', 'skippedCount', 'totalRecipients', 'missingStaffJson', 'missingSiteMasterJson', 'missingOpenChatJson', 'unmatchedNamesJson', 'previewJson', 'rawText', 'requestId', 'updatedAt']);
  ensureHeaderColumnsExist_(sheet, ['broadcastId', 'operationId', 'weekId', 'targetMonth', 'status', 'preparedAt', 'sentAt', 'sentCount', 'failedCount', 'skippedCount', 'totalRecipients', 'missingStaffJson', 'missingSiteMasterJson', 'missingOpenChatJson', 'unmatchedNamesJson', 'previewJson', 'rawText', 'requestId', 'updatedAt']);
  return sheet;
}

function ensureFailedJobsMonthSheet_(ss, month) {
  const normalized = sanitizeString_(month).replace('-', '_');
  const name = SHEET_FAILED_JOBS_PREFIX_ + normalized;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRowIfEmpty_(sheet, ['failedJobId', 'broadcastId', 'operationId', 'jobType', 'userId', 'lineUserId', 'siteId', 'role', 'workDate', 'errorCode', 'errorMessage', 'payloadJson', 'status', 'retryCount', 'createdAt', 'updatedAt', 'requestId']);
  ensureHeaderColumnsExist_(sheet, ['failedJobId', 'broadcastId', 'operationId', 'jobType', 'userId', 'lineUserId', 'siteId', 'role', 'workDate', 'errorCode', 'errorMessage', 'payloadJson', 'status', 'retryCount', 'createdAt', 'updatedAt', 'requestId']);
  return sheet;
}

function ensureApprovalQueueMonthSheet_(ss, month) {
  const normalized = sanitizeString_(month).replace('-', '_');
  const name = SHEET_APPROVAL_QUEUE_PREFIX_ + normalized;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRowIfEmpty_(sheet, ['approvalId', 'kind', 'targetId', 'status', 'requestedBy', 'reason', 'createdAt', 'decidedAt', 'decidedBy', 'decisionReason', 'updatedAt', 'requestId']);
  ensureHeaderColumnsExist_(sheet, ['approvalId', 'kind', 'targetId', 'status', 'requestedBy', 'reason', 'createdAt', 'decidedAt', 'decidedBy', 'decisionReason', 'updatedAt', 'requestId']);
  return sheet;
}

function ensureMonthlyLockSheet_(ss, month) {
  const normalized = sanitizeString_(month).replace('-', '_');
  const name = SHEET_MONTHLY_LOCK_PREFIX_ + normalized;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRowIfEmpty_(sheet, ['month', 'status', 'lockedAt', 'lockedBy', 'exportFileId', 'exportFileUrl', 'requestId', 'updatedAt']);
  ensureHeaderColumnsExist_(sheet, ['month', 'status', 'lockedAt', 'lockedBy', 'exportFileId', 'exportFileUrl', 'requestId', 'updatedAt']);
  return sheet;
}

function parseActionResponsePayload_(output) {
  try {
    if (!output || typeof output.getContent !== 'function') return null;
    return JSON.parse(output.getContent());
  } catch (err) {
    return null;
  }
}

function parseJsonSafe_(value) {
  const text = sanitizeString_(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function pushUniqueByKey_(arr, item, keyField) {
  const list = Array.isArray(arr) ? arr : [];
  const key = sanitizeString_(item && item[keyField]);
  if (!key) return;
  for (let i = 0; i < list.length; i++) {
    if (sanitizeString_(list[i] && list[i][keyField]) === key) return;
  }
  list.push(item);
}
