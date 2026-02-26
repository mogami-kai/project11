import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { pushLineMessage, replyLineMessage } from '../clients/line.js';
import { buildError, createMeta, fail, json, ok } from '../http/response.js';
import { requireAdmin, requireRegistered } from '../lib/access.js';
import {
  acquireLock,
  ensureIdempotencyPayloadMatch,
  getIdempotentResponse,
  releaseLock,
  resolvePayloadHash,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { safeLog } from '../util/redact.js';
import { sanitizeDateYmd, sanitizeRequestId, sanitizeUserId } from '../util/validate.js';
import { finalizeSendGuard, reserveSendGuard } from './reminder.js';

export async function handleHotelPush(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: false
  });
  if (!auth.ok) return auth.response;

  const adminCheck = requireAdmin(request, env, meta, { requireIpAllow: true });
  if (!adminCheck.ok) return adminCheck.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(buildError('E_BAD_REQUEST', 'Invalid JSON.', {}, false), meta, { status: 400 });
  }

  const projectId = String(body?.projectId || '').trim();
  const workDate = sanitizeDateYmd(body?.workDate);
  const messageTemplate = String(body?.messageTemplate || '').trim();

  const fields = [];
  if (!projectId) fields.push({ field: 'projectId', reason: 'required' });
  if (!workDate) fields.push({ field: 'workDate', reason: 'must be YYYY-MM-DD' });
  if (fields.length) {
    return fail(buildError('E_VALIDATION', 'Validation failed.', { fields }, false), meta, { status: 400 });
  }

  const routeKey = '/api/hotel/push';
  const idemKey = resolveIdempotencyKey(request, body);
  const payloadHash = idemKey
    ? await resolvePayloadHash({
      projectId,
      workDate,
      messageTemplate
    })
    : '';

  if (idemKey) {
    const payloadMatched = await ensureIdempotencyPayloadMatch(env, routeKey, idemKey, payloadHash);
    if (!payloadMatched) {
      return fail(
        buildError('E_IDEMPOTENCY_MISMATCH', 'Idempotency key payload mismatch.', {}, false),
        meta,
        { status: 409 }
      );
    }

    const cached = await getIdempotentResponse(env, routeKey, idemKey);
    if (cached) {
      return json(cached, { status: 200 });
    }
  }

  let lockAcquired = false;
  try {
    if (idemKey) {
      lockAcquired = await acquireLock(env, routeKey, idemKey);
      if (!lockAcquired) {
        return fail(buildError('E_CONFLICT', 'Request in progress.', {}, true), meta, { status: 409 });
      }
    }

    const { ok: gasOk, response, gasJson } = await callGas(
      env,
      {
        action: 'hotel.intent.targets',
        token: env.STAFF_TOKEN_FOR_GAS,
        requestId,
        data: { projectId, workDate }
      },
      meta
    );
    if (!gasOk) return response;

    if (!gasJson?.ok) {
      return json({ ok: false, error: gasJson.error || {}, meta }, { status: 400 });
    }

    const targets = Array.isArray(gasJson?.data?.targets) ? gasJson.data.targets : [];
    let pushed = 0;
    let failed = 0;
    let skipped = 0;

    for (const target of targets) {
      const to = String(target?.lineUserId || '').trim();
      const userId = sanitizeUserId(target?.userId || to);
      if (!to || !userId) {
        failed += 1;
        continue;
      }

      const guard = await reserveSendGuard(env, meta, requestId, {
        action: 'hotel.sendGuard',
        data: {
          date: workDate,
          projectId,
          lineUserId: to,
          kind: 'hotel'
        }
      });
      if (!guard.ok) {
        failed += 1;
        safeLog('hotel.push.guard.error', { requestId, projectId, workDate, lineUserId: to });
        continue;
      }

      if (!guard.allowed) {
        skipped += 1;
        safeLog('hotel.push.skipped', {
          requestId,
          projectId,
          workDate,
          lineUserId: to,
          reason: 'guard_duplicate',
          guardToken: guard.guardToken
        });
        continue;
      }

      const text = messageTemplate || `${workDate} (${projectId}) のホテル要否を回答してください。`;
      const pushMessage = buildHotelIntentPushMessage(projectId, workDate, text);
      const pushResult = await pushLineMessage(env, to, [pushMessage], requestId);
      const deliveryStatus = pushResult.ok ? 'pushed' : 'failed';

      await finalizeSendGuard(env, meta, requestId, {
        action: 'hotel.sendGuard',
        data: {
          date: workDate,
          projectId,
          lineUserId: to,
          kind: 'hotel'
        },
        guardToken: guard.guardToken,
        status: deliveryStatus
      });

      safeLog('hotel.push.delivery', {
        requestId,
        projectId,
        workDate,
        lineUserId: to,
        status: deliveryStatus,
        lineStatus: pushResult.status || null,
        lineErrorCode: pushResult.errorCode || ''
      });

      if (pushResult.ok) {
        pushed += 1;
      } else {
        failed += 1;
      }
    }

    const result = {
      ok: true,
      data: {
        projectId,
        workDate,
        targetCount: targets.length,
        pushed,
        failed,
        skipped
      },
      meta
    };

    if (idemKey) {
      await setIdempotentResponse(env, routeKey, idemKey, result);
    }

    return json(result, { status: 200 });
  } finally {
    if (idemKey && lockAcquired) {
      await releaseLock(env, routeKey, idemKey);
    }
  }
}

export async function handleHotelPostbackEvent(event, env, requestId) {
  const postbackData = parsePostbackData(String(event?.postback?.data || ''));
  const replyToken = String(event?.replyToken || '').trim();
  const userId = String(event?.source?.userId || '').trim();
  const projectId = String(postbackData.projectId || '').trim();
  const workDate = String(postbackData.workDate || '').trim();
  const eventMeta = createMeta(requestId);

  const intent = String(postbackData['hotel:intent'] || '');
  if (intent === 'yes' && replyToken) {
    await replyLineMessage(env, replyToken, [buildSmokingQuestionMessage(projectId, workDate)], requestId);
    return;
  }

  async function checkHotelAnswerGate() {
    // Spec: api_schema 2 Gate (hotel回答 is submission endpoint)
    const gate = await requireRegistered(env, eventMeta, requestId, { userId });
    if (gate.ok) return { ok: true };

    if (replyToken) {
      const gatePayload = await gate.response.clone().json().catch(() => null);
      const code = String(gatePayload?.error?.code || '');
      const text = code === 'E_STAFF_INACTIVE'
        ? '現在このアカウントでは回答できません。管理者へ連絡してください。'
        : '登録未完了のため回答できません。登録完了後に再度お試しください。';
      await replyLineMessage(env, replyToken, [{ type: 'text', text }], requestId);
    }

    return { ok: false };
  }

  if (intent === 'no') {
    const gate = await checkHotelAnswerGate();
    if (!gate.ok) return;

    if (userId && projectId && workDate) {
      // Spec: v5_spec 2.3 Idempotency / action-contracts hotel.intent.submit
      // GAS side uses userId+projectId+workDate upsert semantics for dedup
      await callGas(
        env,
        {
          action: 'hotel.intent.submit',
          token: env.STAFF_TOKEN_FOR_GAS,
          requestId,
          data: {
            userId,
            projectId,
            workDate,
            needHotel: false,
            smoking: 'none',
            source: 'line',
            status: 'answered'
          }
        },
        eventMeta
      );
    }
    if (replyToken) {
      await replyLineMessage(env, replyToken, [{ type: 'text', text: '回答ありがとうございます。（ホテル不要）' }], requestId);
    }
    return;
  }

  const smoke = String(postbackData['hotel:smoke'] || '');
  if (smoke === 'non' || smoke === 'smoke') {
    const gate = await checkHotelAnswerGate();
    if (!gate.ok) return;

    if (userId && projectId && workDate) {
      // Spec: v5_spec 2.3 Idempotency / action-contracts hotel.intent.submit
      // GAS side uses userId+projectId+workDate upsert semantics for dedup
      await callGas(
        env,
        {
          action: 'hotel.intent.submit',
          token: env.STAFF_TOKEN_FOR_GAS,
          requestId,
          data: {
            userId,
            projectId,
            workDate,
            needHotel: true,
            smoking: smoke,
            source: 'line',
            status: 'answered'
          }
        },
        eventMeta
      );
    }

    if (replyToken) {
      const smokeLabel = smoke === 'non' ? '禁煙' : '喫煙';
      await replyLineMessage(env, replyToken, [{ type: 'text', text: `回答ありがとうございます。（${smokeLabel}）` }], requestId);
    }
  }
}

export function buildMenuMessage(env) {
  const liffUrl = String(env.LIFF_URL || '').trim();
  const lines = [
    'メニュー',
    '・交通費（リッチメニュー）',
    '・状況確認（リッチメニュー）',
    '・ヘルプ（リッチメニュー）',
    '※ホテルは前日に個別メッセージで配信します。'
  ];

  if (liffUrl) {
    lines.push(`交通費フォーム: ${liffUrl}`);
  }

  return { type: 'text', text: lines.join('\n') };
}

export function buildHelpMessage(env) {
  const liffUrl = String(env.LIFF_URL || '').trim();
  const lines = [
    '【ヘルプ】',
    '1) 交通費: リッチメニュー「交通費」からフォームへ',
    '2) 状況確認: リッチメニュー「状況確認」',
    '3) ホテル: 前日の個別メッセージに回答',
    '4) 勤怠提出機能はありません'
  ];

  if (liffUrl) {
    lines.push(`交通費フォームURL: ${liffUrl}`);
  }

  return { type: 'text', text: lines.join('\n') };
}

function parsePostbackData(raw) {
  const out = {};
  const text = String(raw || '').trim();
  if (!text) return out;

  const pairs = text.split('&');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) {
      out[decodeURIComponent(pair)] = '';
      continue;
    }
    const key = decodeURIComponent(pair.slice(0, idx));
    const value = decodeURIComponent(pair.slice(idx + 1));
    out[key] = value;
  }

  return out;
}

function buildHotelIntentPushMessage(projectId, workDate, text) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'ホテル要',
            data: `hotel:intent=yes&projectId=${encodeURIComponent(projectId)}&workDate=${encodeURIComponent(workDate)}`
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'ホテル不要',
            data: `hotel:intent=no&projectId=${encodeURIComponent(projectId)}&workDate=${encodeURIComponent(workDate)}`
          }
        }
      ]
    }
  };
}

function buildSmokingQuestionMessage(projectId, workDate) {
  return {
    type: 'text',
    text: '禁煙／喫煙を選択してください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '禁煙',
            data: `hotel:smoke=non&projectId=${encodeURIComponent(projectId)}&workDate=${encodeURIComponent(workDate)}`
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '喫煙',
            data: `hotel:smoke=smoke&projectId=${encodeURIComponent(projectId)}&workDate=${encodeURIComponent(workDate)}`
          }
        }
      ]
    }
  };
}

function resolveIdempotencyKey(request, body) {
  const headerKey = String(request.headers.get('x-idempotency-key') || '').trim();
  if (headerKey) return headerKey.slice(0, 120);

  const bodyKey = String(body?.idempotencyKey || '').trim();
  if (bodyKey) return bodyKey.slice(0, 120);

  const bodyRequestId = sanitizeRequestId(body?.requestId);
  if (!bodyRequestId) return '';
  return `requestId:${bodyRequestId}`;
}
