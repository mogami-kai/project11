import { callGas } from '../clients/gas.js';
import { acquireLock, releaseLock } from '../lib/idempotency.js';
import {
  linkUserRichMenu,
  pushLineMessage,
  replyLineMessage,
  verifyLineWebhookSignature
} from '../clients/line.js';
import { buildError, createMeta, fail, ok, withCorsHeaders } from '../lib/response.js';
import { sha256Hex } from '../util/hash.js';
import { safeLog } from '../lib/redact.js';
import { getLiffUrls } from '../lib/env.js';
import { ymJstFromEpoch } from '../util/time.js';
import { tryWriteOpsLogAlert } from '../util/ops.js';
import { buildHelpMessage, buildMenuMessage, handleHotelPostbackEvent } from './hotel.js';
import { handleHotelScreenshotProcess } from './hotelScreenshot.js';

const WEBHOOK_EVENT_MEMORY_CACHE = new Map();

export async function handleLineWebhook(request, env, meta, requestId, origin, allowedOrigin, ctx) {
  const signature = String(request.headers.get('x-line-signature') || '').trim();
  const ack = (details = {}) => withCorsHeaders(
    ok({ acknowledged: true, ...details }, meta, { status: 200 }),
    origin,
    allowedOrigin,
    requestId
  );

  if (!env.LINE_CHANNEL_SECRET) {
    safeLog('line.webhook', { requestId, reason: 'missing_channel_secret' });
    const res = fail(buildError('E_CONFIG', 'LINE_CHANNEL_SECRET is missing.', {}, false), meta, { status: 500 });
    return withCorsHeaders(res, origin, allowedOrigin, requestId);
  }

  let rawBody;
  try {
    rawBody = await request.arrayBuffer();
  } catch (error) {
    safeLog('line.webhook', { requestId, reason: 'read_body_failed', message: String(error?.message || error) });
    return ack({ accepted: false, reason: 'read_body_failed' });
  }

  const validSignature = await verifyLineWebhookSignature(rawBody, env.LINE_CHANNEL_SECRET, signature);
  if (!validSignature) {
    safeLog('line.webhook', {
      requestId,
      reason: 'invalid_signature',
      hasSignature: Boolean(signature)
    });
    const res = fail(buildError('E_UNAUTHORIZED', 'Invalid LINE signature.', {}, false), meta, { status: 401 });
    return withCorsHeaders(res, origin, allowedOrigin, requestId);
  }

  let bodyJson;
  try {
    bodyJson = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    safeLog('line.webhook', { requestId, reason: 'invalid_json', message: String(error?.message || error) });
    return ack({ accepted: false, reason: 'invalid_json' });
  }

  const events = extractWebhookEvents(bodyJson);
  // [P0-5] 同期処理: 失敗時は 500 で返して LINE 再送を許可
  const result = await processLineEvents(events, env, requestId);
  if (!result.ok) {
    safeLog('line.webhook', { requestId, reason: 'processing_failed', eventCount: events.length });
    const res = fail(buildError('E_UPSTREAM', 'Event processing failed. Retry expected.', {}, true), meta, { status: 500 });
    return withCorsHeaders(res, origin, allowedOrigin, requestId);
  }
  return ack({ accepted: true, eventCount: events.length });
}

async function processLineEvents(events, env, requestId) {
  for (const event of events) {
    const replayGuard = await reserveWebhookEventForProcessing(event, env, requestId);
    if (!replayGuard.processable) {
      safeLog('line.event.replay.skipped', {
        requestId,
        eventId: replayGuard.eventId,
        eventTs: replayGuard.eventTimestampMs || null,
        reason: replayGuard.reason
      });
      continue;
    }

    // [P0-5] 成功後に KV 記録。失敗時は false を返して 500 へ
    const eventOk = await processSingleLineEventTracked(event, env, requestId, replayGuard.storeKey);
    if (!eventOk) return { ok: false };
  }
  return { ok: true };
}

async function processSingleLineEventSafely(event, env, requestId) {
  try {
    await processSingleLineEvent(event, env, requestId);
  } catch (error) {
    safeLog('line.event', {
      requestId,
      type: String(event?.type || ''),
      reason: 'event_failed',
      message: String(error?.message || error)
    });
  }
}

// [P0-5] 処理成功後にのみ KV へ記録し、失敗時は false を返す
async function processSingleLineEventTracked(event, env, requestId, storeKey) {
  try {
    await processSingleLineEvent(event, env, requestId);
    await recordWebhookEventProcessed(env, storeKey, requestId);
    return true;
  } catch (error) {
    safeLog('line.event', {
      requestId,
      type: String(event?.type || ''),
      reason: 'event_failed',
      message: String(error?.message || error)
    });
    return false;
  }
}

async function processSingleLineEvent(event, env, requestId) {
  const type = String(event?.type || '');
  const userId = String(event?.source?.userId || '').trim();

  if (type === 'message' && event?.message?.type === 'text') {
    await handleTextMessageEvent(event, env, requestId, userId);
  } else if (type === 'message' && event?.message?.type === 'image') {
    await handleImageMessageEvent(event, env, requestId, userId);
  } else if (type === 'postback') {
    await handleHotelPostbackEvent(event, env, requestId);
  } else if ((type === 'follow' || type === 'unfollow') && userId) {
    // Spec: api_schema 6 Unfollow Webhook / v5_spec 3.1 Staff Master
    const lineFollowStatus = type === 'follow' ? 'follow' : 'unfollow';
    const eventMeta = createMeta(requestId);
    const gasToken = resolveGasToken(env);

    if (gasToken) {
      await callGas(
        env,
        {
          action: 'hotel.user.upsert',
          token: gasToken,
          requestId,
          data: {
            userId,
            lineUserId: userId,
            status: lineFollowStatus === 'follow' ? 'active' : 'unfollowed',
            lineFollowStatus,
            source: 'line'
          }
        },
        eventMeta
      );
    }

    if (type === 'follow') {
      if (gasToken) {
        const registerLock = await callGas(
          env,
          {
            action: 'staff.register.lock',
            token: gasToken,
            requestId,
            data: {
              userId,
              lineUserId: userId
            }
          },
          eventMeta,
          { retries: 0 }
        );

        if (!registerLock.ok || !registerLock.gasJson?.ok) {
          safeLog('register.lock.failed', {
            requestId,
            userId,
            reachable: Boolean(registerLock.ok),
            gasErrorCode: registerLock.gasJson?.error?.code || '',
            gasErrorMessage: registerLock.gasJson?.error?.message || ''
          });
        }
      }

      const { registerUrl } = getLiffUrls(env);
      const guideMessage = { type: 'text', text: buildRegisterGuideText(registerUrl) };
      const guidePush = await pushLineMessage(env, userId, [guideMessage], requestId);
      if (!guidePush.ok) {
        safeLog('register.guide.push.failed', {
          requestId,
          userId,
          lineStatus: guidePush.status || null,
          lineErrorCode: guidePush.errorCode || ''
        });

        await tryWriteOpsLogAlert(env, requestId, {
          source: 'worker.webhook.follow',
          event: 'register.guide.push.failed',
          message: 'Failed to push register guide message.',
          payload: {
            userId,
            lineStatus: guidePush.status || null,
            lineErrorCode: guidePush.errorCode || ''
          }
        });
      }

      const richMenuId = String(env.LINE_RICHMENU_ID_UNREGISTERED || '').trim();
      if (richMenuId) {
        const richMenuResult = await linkUserRichMenu(env, userId, richMenuId, requestId);
        if (!richMenuResult.ok) {
          safeLog('line.richmenu.link.failed', {
            requestId,
            userId,
            richMenuId,
            lineStatus: richMenuResult.status || null,
            lineErrorCode: richMenuResult.errorCode || ''
          });

          await tryWriteOpsLogAlert(env, requestId, {
            source: 'worker.webhook.follow',
            event: 'line.richmenu.link.failed',
            message: 'Failed to link unregistered rich menu.',
            payload: {
              userId,
              richMenuId,
              lineStatus: richMenuResult.status || null,
              lineErrorCode: richMenuResult.errorCode || ''
            }
          });
        }
      }
    }
  }
}

async function handleImageMessageEvent(event, env, requestId, userId) {
  const replyToken = String(event?.replyToken || '').trim();
  const messageId = String(event?.message?.id || '').trim();
  if (!messageId) {
    if (replyToken) {
      await replyLineMessage(env, replyToken, [{ type: 'text', text: '画像IDを取得できませんでした。' }], requestId);
    }
    return;
  }

  const eventMeta = createMeta(requestId);
  const processed = await handleHotelScreenshotProcess(env, eventMeta, requestId, {
    source: 'line.webhook.image',
    adminLineUserId: userId,
    messageId
  });

  if (!replyToken) return;

  if (!processed.ok) {
    const message = processed.status === 403
      ? '管理者のみホテル確認画像を処理できます。'
      : `画像処理に失敗しました: ${String(processed.code || 'E_UPSTREAM')}`;
    await replyLineMessage(env, replyToken, [{ type: 'text', text: message }], requestId);
    return;
  }

  const data = processed.data || {};
  const lines = [
    'ホテル確認画像を処理しました。',
    `confirmedCount: ${Number(data.confirmedCount || 0)}`,
    `unmatchedCount: ${Number(data.unmatchedCount || 0)}`,
    `duplicateCount: ${Number(data.duplicateCount || 0)}`
  ];
  await replyLineMessage(env, replyToken, [{ type: 'text', text: lines.join('\n') }], requestId);
}

function extractWebhookEvents(bodyJson) {
  return Array.isArray(bodyJson?.events) ? bodyJson.events : [];
}

async function handleTextMessageEvent(event, env, requestId, userId) {
  const text = String(event?.message?.text || '').trim();
  const sideEffects = await runMessageSideEffects(event, text, env, requestId);
  await replyToTextMessage(event, text, env, requestId, userId, sideEffects);
}

async function runMessageSideEffects(event, text, env, requestId) {
  try {
    const shift = await tryIngestAndParseShiftRawEvent(event, text, env, requestId);
    return { shift };
  } catch (error) {
    safeLog('shift.raw.ingest.failed', {
      requestId,
      reason: 'side_effect_exception',
      message: String(error?.message || error)
    });
    return {
      shift: {
        handled: isLikelyAllShiftText(text),
        ok: false,
        reason: 'side_effect_exception',
        rawMessageId: '',
        parse: null,
        ingestStored: false
      }
    };
  }
}

async function replyToTextMessage(event, text, env, requestId, userId, sideEffects) {
  const replyToken = String(event?.replyToken || '').trim();
  if (!replyToken) {
    safeLog('line.reply.skipped', {
      requestId,
      type: 'message',
      reason: 'missing_reply_token'
    });
    return;
  }

  const month = ymJstFromEpoch(event?.timestamp || Date.now());
  const replyMessages = await buildReplyMessagesForText(text, env, requestId, userId, month, sideEffects);
  await replyLineMessage(env, replyToken, replyMessages, requestId);
}

async function buildReplyMessagesForText(text, env, requestId, userId, month, sideEffects) {
  if (sideEffects?.shift?.handled) {
    return [buildShiftParseReplyMessage(sideEffects.shift)];
  }

  if (text.includes('交通')) {
    const { trafficUrl } = getLiffUrls(env);
    return [{ type: 'text', text: trafficUrl ? `交通費申請はこちら:\n${trafficUrl}` : 'LIFF_TRAFFIC_URL/LIFF_URL が未設定です。運用担当へ連絡してください。' }];
  }

  if (text.includes('状況') || text.includes('ステータス') || text.includes('未提出')) {
    const eventMeta = createMeta(requestId);
    const gasToken = resolveGasToken(env);
    if (!gasToken) {
      return [{ type: 'text', text: '設定不足のため状況を取得できません。運用担当へ連絡してください。' }];
    }

    const { ok: gasOk, gasJson } = await callGas(
      env,
      { action: 'status.get', token: gasToken, requestId, data: { userId, month } },
      eventMeta
    );

    if (!gasOk || !gasJson?.ok) {
      return [{ type: 'text', text: '状況取得に失敗しました。少し時間を置いて再度お試しください。' }];
    }

    const data = gasJson.data || {};
    return [{
      type: 'text',
      text:
        `【${month} 状況】\n` +
        `提出済: ${(data.submittedDates || []).join(', ') || 'なし'}\n` +
        `未提出: ${(data.unsubmittedDates || []).join(', ') || 'なし'}\n` +
        `交通費合計: ${Number(data.trafficTotal || 0).toLocaleString()}円`
    }];
  }

  if (text.includes('ホテル')) {
    return [{
      type: 'text',
      text: 'ホテル要否は前日にこちらから個別メッセージで配信します。届いたメッセージのボタンで回答してください。'
    }];
  }

  if (text.includes('ヘルプ') || text.includes('help')) {
    return [buildHelpMessage(env)];
  }

  return [buildMenuMessage(env)];
}

function buildShiftParseReplyMessage(shiftResult) {
  if (!shiftResult?.ok) {
    const reason = String(shiftResult?.reason || 'unknown');
    return {
      type: 'text',
      text: `シフト投稿を受信しましたが、取込/解析でエラーが発生しました。\nreason: ${reason}`
    };
  }

  const parse = shiftResult.parse || {};
  return {
    type: 'text',
    text: [
      'シフト投稿を取り込みました。',
      `rawMessageId: ${String(shiftResult.rawMessageId || '')}`,
      `stored: ${shiftResult.ingestStored ? 'true' : 'false'}`,
      `parsed: ${Number(parse.parsed || 0)}`,
      `skipped: ${Number(parse.skipped || 0)}`,
      `errored: ${Number(parse.errored || 0)}`,
      `assignmentInserted: ${Number(parse.assignmentInserted || 0)}`
    ].join('\n')
  };
}

async function tryIngestAndParseShiftRawEvent(event, text, env, requestId) {
  if (!isLikelyAllShiftText(text)) {
    return {
      handled: false,
      ok: false,
      reason: 'not_shift_posting',
      rawMessageId: '',
      ingestStored: false,
      parse: null
    };
  }

  const rawMessageId = await resolveRawMessageId(event, text);
  if (!rawMessageId) {
    return {
      handled: true,
      ok: false,
      reason: 'missing_raw_message_id',
      rawMessageId: '',
      ingestStored: false,
      parse: null
    };
  }

  const gasToken = resolveGasToken(env);
  if (!gasToken) {
    safeLog('shift.raw.ingest.failed', {
      requestId,
      rawMessageId,
      reason: 'missing_staff_token_for_gas'
    });
    return {
      handled: true,
      ok: false,
      reason: 'missing_staff_token_for_gas',
      rawMessageId,
      ingestStored: false,
      parse: null
    };
  }

  const lineUserId = String(event?.source?.userId || '').trim();
  const lineGroupId = resolveLineGroupId(event?.source);
  const eventMeta = createMeta(requestId);

  const ingest = await callGas(
    env,
    {
      action: 'shift.raw.ingest',
      token: gasToken,
      requestId,
      data: {
        rawMessageId,
        rawText: String(text || ''),
        lineUserId,
        lineGroupId
      }
    },
    eventMeta,
    { retries: 0 }
  );

  if (!ingest.ok || !ingest.gasJson?.ok) {
    safeLog('shift.raw.ingest.failed', {
      requestId,
      rawMessageId,
      reachable: Boolean(ingest.ok),
      gasErrorCode: ingest.gasJson?.error?.code || '',
      gasErrorMessage: ingest.gasJson?.error?.message || ''
    });
    return {
      handled: true,
      ok: false,
      reason: ingest.gasJson?.error?.code || 'shift_raw_ingest_failed',
      rawMessageId,
      ingestStored: false,
      parse: null
    };
  }

  const ingestStored = Boolean(ingest.gasJson?.data?.stored);

  const parseRun = await callGas(
    env,
    {
      action: 'shift.parse.run',
      token: gasToken,
      requestId,
      data: {
        rawMessageId,
        includeErrors: true,
        limit: 1
      }
    },
    eventMeta,
    { retries: 0 }
  );

  if (!parseRun.ok || !parseRun.gasJson?.ok) {
    safeLog('shift.parse.run.failed', {
      requestId,
      rawMessageId,
      reachable: Boolean(parseRun.ok),
      gasErrorCode: parseRun.gasJson?.error?.code || '',
      gasErrorMessage: parseRun.gasJson?.error?.message || ''
    });
    return {
      handled: true,
      ok: false,
      reason: parseRun.gasJson?.error?.code || 'shift_parse_run_failed',
      rawMessageId,
      ingestStored,
      parse: null
    };
  }

  const parseSummary = parseRun.gasJson?.data || {};
  safeLog('shift.raw.ingest.parse.summary', {
    requestId,
    rawMessageId,
    stored: ingestStored,
    parsed: Number(parseSummary?.parsed || 0),
    skipped: Number(parseSummary?.skipped || 0),
    errored: Number(parseSummary?.errored || 0),
    assignmentInserted: Number(parseSummary?.assignmentInserted || 0)
  });

  return {
    handled: true,
    ok: true,
    reason: '',
    rawMessageId,
    ingestStored,
    parse: {
      targetCount: Number(parseSummary?.targetCount || 0),
      parsed: Number(parseSummary?.parsed || 0),
      skipped: Number(parseSummary?.skipped || 0),
      errored: Number(parseSummary?.errored || 0),
      assignmentInserted: Number(parseSummary?.assignmentInserted || 0)
    }
  };
}

function resolveGasToken(env) {
  return String(env.STAFF_TOKEN_FOR_GAS || '').trim();
}

function isLikelyAllShiftText(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  return body.includes('@All') && body.includes('（') && body.includes('日') && body.includes('～');
}

async function resolveRawMessageId(event, text) {
  const messageId = String(event?.message?.id || '').trim();
  if (messageId) return messageId;

  const timestamp = Number(event?.timestamp || Date.now());
  const hash = await sha256Hex(`shift.raw:${timestamp}:${String(text || '')}`);
  return `${timestamp}-${hash.slice(0, 16)}`;
}

function resolveLineGroupId(source) {
  const groupId = String(source?.groupId || '').trim();
  if (groupId) return groupId;

  const roomId = String(source?.roomId || '').trim();
  if (roomId) return roomId;

  return String(source?.userId || '').trim();
}

function buildRegisterGuideText(registerUrl) {
  const lines = [
    'フォローありがとうございます。',
    '利用開始のため、初回登録をお願いします。'
  ];

  if (registerUrl) {
    lines.push(`登録フォーム: ${registerUrl}`);
  } else {
    lines.push('登録フォームURLが未設定です。運用担当へ連絡してください。');
  }

  return lines.join('\n');
}

// [P0-5] 成功後に KV / メモリキャッシュへ記録（事前予約の廃止に対応）
async function recordWebhookEventProcessed(env, storeKey, requestId) {
  if (!storeKey) return;
  const ttlSeconds = parseWebhookReplayTtlSeconds(env);
  const kv = env?.IDEMPOTENCY_KV;
  if (kv) {
    await kv.put(storeKey, requestId, { expirationTtl: ttlSeconds });
    return;
  }
  WEBHOOK_EVENT_MEMORY_CACHE.set(storeKey, Date.now() + ttlSeconds * 1000);
}

function parseWebhookReplayTtlSeconds(env) {
  const raw = Number(env?.WEBHOOK_EVENT_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 86400;
  return Math.floor(raw);
}

function resolveWebhookEventIdentity(event) {
  const eventId = String(event?.webhookEventId || event?.eventId || '').trim();
  const eventTimestampMs = Number(event?.timestamp || 0);
  if (!eventId || !Number.isFinite(eventTimestampMs) || eventTimestampMs <= 0) {
    return { eventId: '', eventTimestampMs: 0, storeKey: '' };
  }
  const storeKey = `line:webhook:event:${eventId}:${eventTimestampMs}`;
  return { eventId, eventTimestampMs, storeKey };
}

function cleanupWebhookMemoryCache() {
  const now = Date.now();
  for (const [key, expiresAtMs] of WEBHOOK_EVENT_MEMORY_CACHE.entries()) {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      WEBHOOK_EVENT_MEMORY_CACHE.delete(key);
    }
  }
}

async function reserveWebhookEventForProcessing(event, env, requestId) {
  const { eventId, eventTimestampMs, storeKey } = resolveWebhookEventIdentity(event);
  if (!storeKey) {
    return { processable: true, reason: 'no_event_id', eventId: '', eventTimestampMs: 0, storeKey: '' };
  }

  const ttlSeconds = parseWebhookReplayTtlSeconds(env);
  const now = Date.now();
  if (Math.abs(now - eventTimestampMs) > ttlSeconds * 1000) {
    return { processable: false, reason: 'stale_timestamp', eventId, eventTimestampMs };
  }

  const lockPath = '/webhook/replay';
  const lockAcquired = await acquireLock(env, lockPath, storeKey);
  if (!lockAcquired) {
    return { processable: false, reason: 'in_progress_or_duplicate', eventId, eventTimestampMs };
  }

  try {
    const kv = env?.IDEMPOTENCY_KV;
    if (kv) {
      const exists = await kv.get(storeKey);
      if (exists) {
        return { processable: false, reason: 'duplicate_event', eventId, eventTimestampMs };
      }
      return { processable: true, reason: 'new', eventId, eventTimestampMs, storeKey };
    }

    cleanupWebhookMemoryCache();
    const expiresAtMs = WEBHOOK_EVENT_MEMORY_CACHE.get(storeKey);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > now) {
      return { processable: false, reason: 'duplicate_event', eventId, eventTimestampMs };
    }
    return { processable: true, reason: 'new', eventId, eventTimestampMs, storeKey };
  } finally {
    await releaseLock(env, lockPath, storeKey);
  }
}
