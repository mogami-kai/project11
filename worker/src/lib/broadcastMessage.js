import { pushLineMessage } from '../clients/line.js';
import { getLiffUrls } from './env.js';

/**
 * Broadcast Flex Message builder (canonical)
 * Source of truth: broadcast.js version (includes weekId text, label slice 20)
 * Used by: handlers/broadcast.js, handlers/slack.js
 */
export function buildBroadcastFlexMessage(recipient, env) {
  const { trafficUrl: liffTrafficUrl, expenseUrl: liffExpenseUrl, hotelUrl: liffHotelUrl } = getLiffUrls(env);
  const weekId = String(recipient?.weekId || '').trim();
  const siteName = String(recipient?.siteName || recipient?.siteRaw || '').trim() || '現場未設定';
  const role = String(recipient?.role || '').trim() || '-';
  const dateRange = String(recipient?.dateRange || '').trim();
  const openChatUrl = sanitizeBroadcastUrl(recipient?.openChatUrl);
  const trafficUrl = sanitizeBroadcastUrl(liffTrafficUrl);
  const expenseUrl = sanitizeBroadcastUrl(liffExpenseUrl);
  const hotelUrl = sanitizeBroadcastUrl(liffHotelUrl);

  const footerContents = [];
  if (openChatUrl) {
    footerContents.push(buildBroadcastButton('現場チャット', openChatUrl, 'primary'));
  }
  if (trafficUrl) footerContents.push(buildBroadcastButton('交通費入力', trafficUrl, openChatUrl ? 'secondary' : 'primary'));
  if (expenseUrl) footerContents.push(buildBroadcastButton('経費入力', expenseUrl, 'secondary'));
  if (hotelUrl) footerContents.push(buildBroadcastButton('ホテル回答', hotelUrl, 'secondary'));

  const contents = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '今週の担当連絡', weight: 'bold', size: 'md' },
        { type: 'text', text: siteName, weight: 'bold', size: 'xl', wrap: true },
        { type: 'text', text: `週: ${weekId || '-'}`, size: 'sm', color: '#666666' },
        { type: 'text', text: `期間: ${dateRange || '-'}`, size: 'sm', color: '#666666', wrap: true },
        { type: 'text', text: `役割: ${role}`, size: 'sm', color: '#666666' }
      ]
    }
  };

  if (footerContents.length > 0) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents
    };
  }

  return {
    type: 'flex',
    altText: `週次担当: ${siteName} ${role}`,
    contents
  };
}

export function sanitizeBroadcastUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

export function buildBroadcastButton(label, uri, style = 'secondary') {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: {
      type: 'uri',
      label: String(label || '').slice(0, 20),
      uri
    }
  };
}

/**
 * Execute LINE push delivery for a recipient list.
 *
 * @param {object} env - Worker env bindings
 * @param {Array}  recipients - recipient objects from GAS send.prepare
 * @param {string} requestId
 * @param {object} [options]
 * @param {boolean} [options.includeRecipientMeta=false]
 *   When true, delivery entries include role/siteId/workDate fields.
 *   broadcast.js path: true  (preserves existing delivery structure with meta)
 *   slack.js path:     false (preserves existing delivery structure without meta)
 *   Changing this flag for the slack path would alter failedJobId hashes in GAS
 *   persistFailedJobsFromDeliveries_ and must not be done in PR-1.
 * @returns {{ pushed: number, failed: number, deliveries: Array }}
 */
export async function executeBroadcastDelivery(env, recipients, requestId, options = {}) {
  const includeRecipientMeta = Boolean(options.includeRecipientMeta);
  const operationId = String(options.operationId || '').trim(); // [P0-1]
  const alreadySentIds = options.alreadySentIds instanceof Set ? options.alreadySentIds : new Set(); // [P0-1]
  const kv = env?.IDEMPOTENCY_KV; // [P0-1]
  const deliveries = [];
  let pushed = 0;
  let failed = 0;
  let alreadySent = 0; // [P0-1]

  for (const recipient of recipients) {
    const lineUserId = String(recipient?.lineUserId || '').trim();
    const recipientId = String(recipient?.recipientId || '').trim(); // [P0-1]

    // [P0-1] skip recipients already sent in a previous run
    if (recipientId && alreadySentIds.has(recipientId)) {
      alreadySent += 1;
      const entry = {
        recipientId,
        userId: String(recipient?.userId || ''),
        lineUserId,
        status: 'already_sent',
        errorCode: ''
      };
      if (includeRecipientMeta) {
        entry.role = String(recipient?.role || '');
        entry.siteId = String(recipient?.siteId || '');
        entry.workDate = String(recipient?.workDate || '');
      }
      deliveries.push(entry);
      continue;
    }

    if (!lineUserId) {
      const entry = {
        recipientId, // [P0-1]
        userId: String(recipient?.userId || ''),
        lineUserId: '',
        status: 'failed',
        errorCode: 'LINE_USER_MISSING'
      };
      if (includeRecipientMeta) {
        entry.role = String(recipient?.role || '');
        entry.siteId = String(recipient?.siteId || '');
        entry.workDate = String(recipient?.workDate || '');
      }
      deliveries.push(entry);
      failed += 1;
      continue;
    }

    const flexMessage = buildBroadcastFlexMessage(recipient, env);
    const pushResult = await pushLineMessage(env, lineUserId, [flexMessage], requestId);

    if (pushResult.ok) {
      pushed += 1;
      // [P0-1] immediately mark recipient as sent in KV for cross-request dedup
      if (recipientId && operationId && kv) {
        try { await kv.put(`broadcast:sent:${operationId}:${recipientId}`, '1', { expirationTtl: 604800 }); } catch { /* ignore */ }
      }
      const entry = {
        recipientId, // [P0-1]
        userId: String(recipient?.userId || ''),
        lineUserId,
        status: 'sent',
        errorCode: ''
      };
      if (includeRecipientMeta) {
        entry.role = String(recipient?.role || '');
        entry.siteId = String(recipient?.siteId || '');
        entry.workDate = String(recipient?.workDate || '');
      }
      deliveries.push(entry);
    } else {
      failed += 1;
      const entry = {
        recipientId, // [P0-1]
        userId: String(recipient?.userId || ''),
        lineUserId,
        status: 'failed',
        errorCode: String(pushResult.errorCode || 'LINE_PUSH_FAILED')
      };
      if (includeRecipientMeta) {
        entry.role = String(recipient?.role || '');
        entry.siteId = String(recipient?.siteId || '');
        entry.workDate = String(recipient?.workDate || '');
      }
      deliveries.push(entry);
    }
  }

  return { pushed, failed, alreadySent, deliveries }; // [P0-1] add alreadySent
}
