import { callGas } from '../clients/gas.js';
import { openSlackModal, postSlackMessage, verifySlackSignature } from '../clients/slack.js';
import {
  acquireLock,
  getIdempotentResponse,
  releaseLock,
  setIdempotentResponse
} from '../lib/idempotency.js';
import { sha256Hex } from '../util/hash.js';
import { sanitizeMonth, sanitizeRequestId } from '../lib/validate.js';
import { buildBroadcastFlexMessage, executeBroadcastDelivery } from '../lib/broadcastMessage.js';

const SLACK_COMMAND_ROUTE = '/api/slack/command';
const SLACK_INTERACTIVE_ROUTE = '/api/slack/interactive';
const SLACK_DEDUPE_TTL_SECONDS = 1800;
const SLACK_DEDUPE_WAIT_MS = 150;
const SLACK_DEDUPE_WAIT_RETRIES = 8;

export async function handleSlackCommand(request, env, meta, requestId) {
  const rawBody = await request.text();
  const verified = await verifySlackSignature(rawBody, request.headers, env.SLACK_SIGNING_SECRET);
  if (!verified.ok) {
    return slackJson({ text: 'Invalid Slack signature.' }, 401);
  }

  const form = new URLSearchParams(rawBody);
  const dedupeKey = await buildSlackCommandDedupeKey(form);
  const retryNum = parseSlackRetryNum(request.headers);

  return runSlackDedupe(env, SLACK_COMMAND_ROUTE, dedupeKey, async () => (
    processSlackCommandForm(form, env, meta, requestId)
  ), { retryNum });
}

export async function handleSlackInteractive(request, env, meta, requestId) {
  const rawBody = await request.text();
  const verified = await verifySlackSignature(rawBody, request.headers, env.SLACK_SIGNING_SECRET);
  if (!verified.ok) {
    return slackJson({ text: 'Invalid Slack signature.' }, 401);
  }

  const form = new URLSearchParams(rawBody);
  const payloadRaw = String(form.get('payload') || '').trim();
  if (!payloadRaw) {
    return slackJson({ text: 'payload is required' }, 400);
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return slackJson({ text: 'payload must be JSON' }, 400);
  }

  const operationId = resolveSlackInteractiveOperationId(payload);
  const dedupeKey = buildSlackInteractiveDedupeKey(payload, operationId);
  const retryNum = parseSlackRetryNum(request.headers);

  return runSlackDedupe(env, SLACK_INTERACTIVE_ROUTE, dedupeKey, async () => (
    processSlackInteractivePayload(payload, operationId, env, meta, requestId)
  ), { retryNum });
}

async function processSlackCommandForm(form, env, meta, requestId) {
  const gasToken = resolveGasToken(env);
  const commandText = String(form.get('text') || '').trim();
  const actorSlackUserId = String(form.get('user_id') || '').trim();
  const triggerId = String(form.get('trigger_id') || '').trim();

  const role = await resolveSlackRole(env, meta, requestId, actorSlackUserId);
  if (!role.ok) {
    return slackJson({ response_type: 'ephemeral', text: '権限情報を取得できませんでした。' }, 200);
  }
  if (!role.allowed) {
    return slackJson({ response_type: 'ephemeral', text: 'この操作は許可されていません。' }, 200);
  }

  const tokens = commandText.split(/\s+/).filter(Boolean);
  const root = String(tokens[0] || '').toLowerCase();

  if (root === 'broadcast' || !root) {
    if (triggerId && env.SLACK_BOT_TOKEN) {
      const modalResult = await openSlackModal(env, triggerId, buildBroadcastModalView(actorSlackUserId), requestId);
      if (modalResult.ok) {
        return new Response('', { status: 200 });
      }
    }

    return slackJson({
      response_type: 'ephemeral',
      text: '使い方: /tl broadcast でモーダルを開きます。'
    });
  }

  if (root === 'approvals') {
    const res = await callGas(
      env,
      {
        action: 'admin.approval.pending',
        token: gasToken,
        requestId,
        data: {
          actorSlackUserId,
          actorType: 'slack'
        }
      },
      meta,
      { retries: 0 }
    );

    if (!res.ok || !res.gasJson?.ok) {
      return slackJson({ response_type: 'ephemeral', text: '承認一覧の取得に失敗しました。' });
    }

    const items = Array.isArray(res.gasJson.data?.items) ? res.gasJson.data.items : [];
    if (items.length === 0) {
      return slackJson({ response_type: 'ephemeral', text: '承認待ちはありません。' });
    }

    const lines = items.slice(0, 20).map((item) => `• ${item.approvalId} ${item.kind} ${item.status}`);
    return slackJson({
      response_type: 'ephemeral',
      text: ['承認待ち一覧', ...lines].join('\n')
    });
  }

  if (root === 'monthly' && String(tokens[1] || '').toLowerCase() === 'close') {
    const targetMonth = sanitizeMonth(tokens[2]);
    if (!targetMonth) {
      return slackJson({ response_type: 'ephemeral', text: '使い方: /tl monthly close YYYY-MM' });
    }

    const res = await callGas(
      env,
      {
        action: 'admin.monthly.close.export',
        token: gasToken,
        requestId,
        data: {
          month: targetMonth,
          actorSlackUserId,
          actorType: 'slack'
        }
      },
      meta,
      { retries: 0, timeoutMs: 60000 }
    );

    if (!res.ok || !res.gasJson?.ok) {
      return slackJson({ response_type: 'ephemeral', text: `月次クローズ失敗: ${res.gasJson?.error?.code || 'E_UPSTREAM'}` });
    }

    const fileUrl = String(res.gasJson.data?.fileUrl || '');
    return slackJson({
      response_type: 'ephemeral',
      text: fileUrl ? `月次クローズ完了: ${fileUrl}` : '月次クローズ完了'
    });
  }

  if (root === 'hotel') {
    const weekId = String(tokens[1] || '').trim();
    const siteId = String(tokens[2] || '').trim();
    const roleFilter = String(tokens[3] || '').trim();
    const res = await callGas(
      env,
      {
        action: 'admin.hotel.summary',
        token: gasToken,
        requestId,
        data: {
          weekId,
          siteId,
          role: roleFilter,
          actorSlackUserId,
          actorType: 'slack'
        }
      },
      meta,
      { retries: 0 }
    );

    if (!res.ok || !res.gasJson?.ok) {
      return slackJson({ response_type: 'ephemeral', text: 'ホテル集計取得に失敗しました。' });
    }

    const data = res.gasJson.data || {};
    return slackJson({
      response_type: 'ephemeral',
      text: `hotel summary\nweekId=${data.weekId || '-'}\nrequired=${Number(data.requiredCount || 0)} answered=${Number(data.answeredCount || 0)} missing=${Number(data.missingCount || 0)}`
    });
  }

  if (root === 'audit') {
    const keyword = tokens.slice(1).join(' ').trim();
    const res = await callGas(
      env,
      {
        action: 'admin.audit.lookup',
        token: gasToken,
        requestId,
        data: {
          keyword,
          actorSlackUserId,
          actorType: 'slack'
        }
      },
      meta,
      { retries: 0 }
    );

    if (!res.ok || !res.gasJson?.ok) {
      return slackJson({ response_type: 'ephemeral', text: '監査検索に失敗しました。' });
    }

    const rows = Array.isArray(res.gasJson.data?.items) ? res.gasJson.data.items : [];
    const lines = rows.slice(0, 20).map((item) => `• ${item.timestamp} ${item.event} ${item.actor}`);
    return slackJson({ response_type: 'ephemeral', text: lines.length ? lines.join('\n') : '該当なし' });
  }

  return slackJson({
    response_type: 'ephemeral',
    text: '対応コマンド: broadcast / approvals / monthly close YYYY-MM / hotel [weekId] [siteId] [role] / audit <keyword>'
  });
}

async function processSlackInteractivePayload(payload, operationId, env, meta, requestId) {
  const gasToken = resolveGasToken(env);
  const actorSlackUserId = String(payload?.user?.id || '').trim();
  const role = await resolveSlackRole(env, meta, requestId, actorSlackUserId);
  if (!role.ok || !role.allowed) {
    return modalSubmissionErrors({ raw_text_block: '権限がありません' });
  }

  if (String(payload?.type || '') === 'view_submission' && String(payload?.view?.callback_id || '') === 'broadcast_modal_v7') {
    const state = payload?.view?.state?.values || {};
    const mode = getViewValue(state, 'mode_block', 'mode_action');
    const targetMonth = sanitizeMonth(getViewValue(state, 'target_month_block', 'target_month_action'));
    const rawText = getViewValue(state, 'raw_text_block', 'raw_text_action');

    if (!targetMonth || !rawText) {
      return modalSubmissionErrors({
        target_month_block: !targetMonth ? 'YYYY-MM を入力してください' : '',
        raw_text_block: !rawText ? '週次原文を入力してください' : ''
      });
    }

    const resolvedOperationId = operationId || buildBroadcastOperationId(payload, targetMonth, mode);

    if (mode === 'preview') {
      const preview = await callGas(
        env,
        {
          action: 'admin.broadcast.preview',
          token: gasToken,
          requestId,
          data: {
            targetMonth,
            rawText,
            operationId: resolvedOperationId,
            actorSlackUserId,
            actorType: 'slack'
          }
        },
        meta,
        { retries: 0 }
      );

      if (!preview.ok || !preview.gasJson?.ok) {
        const errorCode = String(preview.gasJson?.error?.code || 'E_UPSTREAM');
        return modalSubmissionErrors({ raw_text_block: `プレビュー取得に失敗しました (${errorCode})` });
      }

      const p = preview.gasJson.data || {};
      const previewPost = await postSlackMessage(
        env,
        actorSlackUserId,
        `preview: sites=${Number(p.siteCount || 0)} assignments=${Number(p.totalAssignments || 0)} missingStaff=${Number((p.missingStaff || []).length)}`,
        null,
        requestId
      );
      if (!previewPost.ok) {
        const postErrorCode = String(previewPost.errorCode || 'SLACK_POST_FAILED');
        return modalSubmissionErrors({ raw_text_block: `結果通知に失敗しました (${postErrorCode})` });
      }

      return slackJson({ response_action: 'clear' });
    }

    const prepare = await callGas(
      env,
      {
        action: 'admin.broadcast.send.prepare',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          rawText,
          operationId: resolvedOperationId,
          actorSlackUserId,
          actorType: 'slack'
        }
      },
      meta,
      { retries: 0 }
    );

    if (!prepare.ok || !prepare.gasJson?.ok) {
      await postSlackMessage(env, actorSlackUserId, 'broadcast send prepare failed', null, requestId);
      const errorCode = String(prepare.gasJson?.error?.code || 'E_UPSTREAM');
      return modalSubmissionErrors({ raw_text_block: `配信準備に失敗しました (${errorCode})` });
    }

    const prepared = prepare.gasJson.data || {};
    const recipients = Array.isArray(prepared.recipients) ? prepared.recipients : [];
    const { pushed, failed, deliveries } = await executeBroadcastDelivery(env, recipients, requestId);

    const finalize = await callGas(
      env,
      {
        action: 'admin.broadcast.send.finalize',
        token: gasToken,
        requestId,
        data: {
          targetMonth,
          broadcastId: String(prepared.broadcastId || ''),
          operationId: resolvedOperationId,
          actorSlackUserId,
          actorType: 'slack',
          delivery: {
            pushed,
            failed,
            skipped: 0,
            deliveries
          }
        }
      },
      meta,
      { retries: 0 }
    );

    if (!finalize.ok || !finalize.gasJson?.ok) {
      await postSlackMessage(env, actorSlackUserId, `broadcast finalize failed: ${finalize.gasJson?.error?.code || 'E_UPSTREAM'}`, null, requestId);
      const errorCode = String(finalize.gasJson?.error?.code || 'E_UPSTREAM');
      return modalSubmissionErrors({ raw_text_block: `配信結果の確定に失敗しました (${errorCode})` });
    }

    const sendPost = await postSlackMessage(env, actorSlackUserId, `broadcast sent. pushed=${pushed} failed=${failed}`, null, requestId);
    if (!sendPost.ok) {
      const postErrorCode = String(sendPost.errorCode || 'SLACK_POST_FAILED');
      return modalSubmissionErrors({ raw_text_block: `結果通知に失敗しました (${postErrorCode})` });
    }
    return slackJson({ response_action: 'clear' });
  }

  if (String(payload?.type || '') === 'block_actions') {
    const action = Array.isArray(payload?.actions) ? payload.actions[0] : null;
    const actionId = String(action?.action_id || '').trim();
    const match = actionId.match(/^approval:(approve|reject):(.+)$/);
    if (match) {
      const decision = match[1];
      const approvalId = match[2];
      const reason = String(action?.value || '').trim();
      const decide = await callGas(
        env,
        {
          action: 'admin.approval.decide',
          token: gasToken,
          requestId,
          data: {
            approvalId,
            decision,
            reason,
            actorSlackUserId,
            actorType: 'slack'
          }
        },
        meta,
        { retries: 0 }
      );

      if (!decide.ok || !decide.gasJson?.ok) {
        return slackJson({ text: '承認更新に失敗しました。', replace_original: false });
      }

      return slackJson({ text: `更新しました: ${approvalId} -> ${decision}`, replace_original: false });
    }
  }

  return slackJson({ text: 'OK' });
}

async function resolveSlackRole(env, meta, requestId, slackUserId) {
  if (!slackUserId) return { ok: true, allowed: false, role: '' };
  const gasToken = resolveGasToken(env);

  const res = await callGas(
    env,
    {
      action: 'admin.role.resolve',
      token: gasToken,
      requestId,
      data: {
        slackUserId,
        actorSlackUserId: slackUserId,
        actorType: 'slack'
      }
    },
    meta,
    { retries: 0 }
  );

  if (!res.ok || !res.gasJson?.ok) return { ok: false, allowed: false, role: '' };

  return {
    ok: true,
    allowed: Boolean(res.gasJson.data?.allowed),
    role: String(res.gasJson.data?.role || '')
  };
}

function resolveGasToken(env) {
  return String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
}

function buildBroadcastModalView(actorSlackUserId) {
  return {
    type: 'modal',
    callback_id: 'broadcast_modal_v7',
    private_metadata: actorSlackUserId,
    title: { type: 'plain_text', text: '週次配信' },
    submit: { type: 'plain_text', text: '実行' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: 'mode_block',
        label: { type: 'plain_text', text: 'モード' },
        element: {
          type: 'static_select',
          action_id: 'mode_action',
          initial_option: {
            text: { type: 'plain_text', text: 'preview' },
            value: 'preview'
          },
          options: [
            { text: { type: 'plain_text', text: 'preview' }, value: 'preview' },
            { text: { type: 'plain_text', text: 'send' }, value: 'send' }
          ]
        }
      },
      {
        type: 'input',
        block_id: 'target_month_block',
        label: { type: 'plain_text', text: '対象月 (YYYY-MM)' },
        element: {
          type: 'plain_text_input',
          action_id: 'target_month_action',
          placeholder: { type: 'plain_text', text: '2026-03' }
        }
      },
      {
        type: 'input',
        block_id: 'raw_text_block',
        label: { type: 'plain_text', text: '週次原文' },
        element: {
          type: 'plain_text_input',
          action_id: 'raw_text_action',
          multiline: true,
          placeholder: { type: 'plain_text', text: '@All ... 現場名（26日～1日） DL: ...' }
        }
      }
    ]
  };
}

function getViewValue(values, blockId, actionId) {
  const action = values?.[blockId]?.[actionId];
  if (!action) return '';

  if (typeof action.value === 'string') return action.value.trim();
  if (action.selected_option?.value) return String(action.selected_option.value).trim();
  return '';
}

function slackJson(payload, status = 200) {
  return new Response(JSON.stringify(payload || {}), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function modalSubmissionErrors(errors) {
  const clean = {};
  for (const [blockId, message] of Object.entries(errors || {})) {
    const text = String(message || '').trim();
    if (text) clean[blockId] = text;
  }
  return slackJson({ response_action: 'errors', errors: clean }, 200);
}

function hashShort(input) {
  const text = String(input || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return String(Math.abs(hash));
}

function buildBroadcastOperationId(payload, targetMonth, mode) {
  const month = sanitizeMonth(targetMonth) || 'unknown-month';
  const opBase = `${payload?.view?.id || ''}:${payload?.view?.hash || ''}:${mode || ''}`;
  return `slack-modal-${month}-${hashShort(opBase)}`;
}

function resolveSlackInteractiveOperationId(payload) {
  const explicit = sanitizeRequestId(payload?.operationId);
  if (explicit) return explicit;

  const type = String(payload?.type || '').trim();
  const callbackId = String(payload?.callback_id || payload?.view?.callback_id || '').trim();

  if (type === 'view_submission' && callbackId === 'broadcast_modal_v7') {
    const state = payload?.view?.state?.values || {};
    const mode = getViewValue(state, 'mode_block', 'mode_action');
    const targetMonth = sanitizeMonth(getViewValue(state, 'target_month_block', 'target_month_action'));
    return buildBroadcastOperationId(payload, targetMonth, mode);
  }

  const actionTs = sanitizeRequestId(payload?.action_ts || payload?.container?.message_ts);
  if (actionTs) {
    const action = Array.isArray(payload?.actions) ? payload.actions[0] : null;
    const actionId = sanitizeRequestId(action?.action_id);
    if (actionId) return `slack-action-${actionTs}-${actionId}`;
    return `slack-action-${actionTs}`;
  }

  const viewId = sanitizeRequestId(payload?.view?.id);
  if (viewId) {
    const callback = sanitizeRequestId(callbackId);
    if (callback) return `slack-view-${viewId}-${callback}`;
    return `slack-view-${viewId}`;
  }

  const triggerId = sanitizeRequestId(payload?.trigger_id);
  if (triggerId) return `slack-trigger-${triggerId}`;

  return `slack-op-${hashShort(`${type}:${callbackId}:${payload?.user?.id || ''}`)}`;
}

// Dedupe key format reference:
// command: team_id:channel_id:user_id:command:trigger_id:text_hash
// interactive: team.id:user.id:(action_ts|view.id):(callback_id|view.callback_id):operationId
async function buildSlackCommandDedupeKey(form) {
  const commandText = String(form.get('text') || '').trim();
  const textHash = await sha256Hex(commandText);

  return [
    normalizeDedupeSegment(form.get('team_id')),
    normalizeDedupeSegment(form.get('channel_id')),
    normalizeDedupeSegment(form.get('user_id')),
    normalizeDedupeSegment(form.get('command')),
    normalizeDedupeSegment(form.get('trigger_id')),
    normalizeDedupeSegment(textHash)
  ].join(':');
}

function buildSlackInteractiveDedupeKey(payload, operationId) {
  return [
    normalizeDedupeSegment(payload?.team?.id || payload?.team_id || payload?.view?.team_id),
    normalizeDedupeSegment(payload?.user?.id),
    normalizeDedupeSegment(payload?.action_ts || payload?.view?.id),
    normalizeDedupeSegment(payload?.callback_id || payload?.view?.callback_id),
    normalizeDedupeSegment(operationId)
  ].join(':');
}

function normalizeDedupeSegment(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.replace(/:/g, '_').slice(0, 200);
}

async function runSlackDedupe(env, path, dedupeKey, handler, options = {}) {
  const retryNum = Number(options?.retryNum);
  const isRetry = Number.isInteger(retryNum) && retryNum > 0;

  if (!dedupeKey) {
    return handler();
  }

  const cached = await readSlackDedupeResponse(env, path, dedupeKey);
  if (cached) {
    return cached;
  }

  let lockAcquired = false;
  try {
    lockAcquired = await acquireLock(env, path, dedupeKey);
    if (!lockAcquired) {
      const pending = await waitForSlackDedupeResponse(env, path, dedupeKey);
      if (pending) return pending;
      return slackAck(isRetry);
    }

    const cachedAfterLock = await readSlackDedupeResponse(env, path, dedupeKey);
    if (cachedAfterLock) {
      return cachedAfterLock;
    }

    const response = await handler();
    await cacheSlackDedupeResponse(env, path, dedupeKey, response);
    return response;
  } finally {
    if (lockAcquired) {
      await releaseLock(env, path, dedupeKey);
    }
  }
}

function parseSlackRetryNum(headers) {
  const raw = String(headers?.get('x-slack-retry-num') || '').trim();
  if (!raw) return -1;
  const retryNum = Number(raw);
  if (!Number.isInteger(retryNum) || retryNum < 0) return -1;
  return retryNum;
}

function slackAck(noRetry) {
  const headers = new Headers();
  if (noRetry) {
    headers.set('x-slack-no-retry', '1');
  }
  return new Response('', { status: 200, headers });
}

async function waitForSlackDedupeResponse(env, path, dedupeKey) {
  for (let attempt = 0; attempt < SLACK_DEDUPE_WAIT_RETRIES; attempt += 1) {
    await sleep(SLACK_DEDUPE_WAIT_MS);
    const cached = await readSlackDedupeResponse(env, path, dedupeKey);
    if (cached) return cached;
  }
  return null;
}

async function readSlackDedupeResponse(env, path, dedupeKey) {
  const cached = await getIdempotentResponse(env, path, dedupeKey);
  if (!cached || typeof cached !== 'object') return null;

  const status = Number(cached.status);
  if (!Number.isFinite(status) || status < 100 || status > 599) return null;

  const body = typeof cached.body === 'string' ? cached.body : '';
  const contentType = String(cached.contentType || '').trim();
  const headers = new Headers();
  if (contentType) {
    headers.set('content-type', contentType);
  }

  return new Response(body, {
    status,
    headers
  });
}

async function cacheSlackDedupeResponse(env, path, dedupeKey, response) {
  if (!response || typeof response.clone !== 'function') return;

  const cloned = response.clone();
  const payload = {
    status: Number(response.status) || 200,
    body: await cloned.text(),
    contentType: String(response.headers.get('content-type') || '').trim()
  };

  await setIdempotentResponse(env, path, dedupeKey, payload, { ttlSeconds: SLACK_DEDUPE_TTL_SECONDS });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function handleSlackEvents(request, env, _meta, _requestId) {
  const rawBody = await request.text();
  const verified = await verifySlackSignature(rawBody, request.headers, env.SLACK_SIGNING_SECRET);
  if (!verified.ok) {
    return slackJson({ error: 'Invalid Slack signature.' }, 401);
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return slackJson({ error: 'Invalid JSON.' }, 400);
  }

  if (body.type === 'url_verification') {
    return slackJson({ challenge: String(body.challenge || '') }, 200);
  }

  // Other event types: acknowledge immediately
  return new Response('', { status: 200 });
}

