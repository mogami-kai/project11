import { parseAllowedOrigins, validateEnvForRequest, validateEnvForScheduled } from './lib/env.js';
import { requireCfAccessJwt } from './lib/access.js';
import { buildError, createMeta, createResponder } from './lib/response.js';
import { handleAdminShiftRawRecent, handleDebugAuth, handleDebugEnv, handleDebugFingerprint, handleDebugGas, handleDebugLineBotInfo, handleDebugRoutes } from './handlers/admin.js';
import { handleAdminBroadcastPreview, handleAdminBroadcastRetryFailed, handleAdminBroadcastSend } from './handlers/broadcast.js';
import { handleDashboardMonth } from './handlers/dashboard.js';
import { handleExpenseCreate } from './handlers/expense.js';
import { handleHotelPush } from './handlers/hotel.js';
import { handleHotelScreenshotProcess } from './handlers/hotelScreenshot.js';
import { renderRegisterLiffHtml, renderStatusPageHtml, renderTrafficLiffHtml } from './handlers/liff.js';
import { handleMonthlyExport } from './handlers/monthly.js';
import { handleOcrExtract } from './handlers/ocr.js';
import { handleRegisterUpsert } from './handlers/register.js';
import { handleReminderPush, runScheduledReminder } from './handlers/reminder.js';
import { handleShiftParseRun, handleShiftParseStats, handleShiftRawIngest } from './handlers/shift.js';
import { handleSlackCommand, handleSlackEvents, handleSlackInteractive } from './handlers/slack.js';
import { handleRegisterStatus, handleStatusGet, handleUnsubmittedList } from './handlers/status.js';
import { handleTrafficCreate } from './handlers/traffic.js';
import { handleTrafficOcrAuto } from './handlers/trafficPair.js';
import { handleLineWebhook } from './handlers/webhook.js';
import { handleMyWeekAssignments } from './handlers/my.js';
import { htmlNoStoreResponse, getAllowedOrigin, normalizePath } from './util/http.js';
import { redactHeaders, safeLog } from './lib/redact.js';
import { ymdJstFromEpoch } from './util/time.js';
import { sanitizeRequestId } from './lib/validate.js';

const ROUTE_METHODS = new Map([
  ['/api/health', ['GET']],
  ['/api/dashboard/month', ['GET']],
  ['/api/status', ['GET']],
  ['/api/register/status', ['GET']],
  ['/api/register/upsert', ['POST']],
  ['/api/unsubmitted', ['GET']],
  ['/api/my/week/assignments', ['GET']],
  ['/api/traffic/create', ['POST']],
  ['/api/expense/create', ['POST']],
  ['/api/traffic/ocr-auto', ['POST']],
  ['/api/hotel/push', ['POST']],
  ['/api/hotel/screenshot/process', ['POST']],
  ['/api/reminder/push', ['POST']],
  ['/api/monthly/export', ['POST']],
  ['/api/ocr/extract', ['POST']],
  ['/api/shift/raw/ingest', ['POST']],
  ['/api/shift/parse/run', ['POST']],
  ['/api/shift/parse/stats', ['POST']],
  ['/api/admin/broadcast/preview', ['POST']],
  ['/api/admin/broadcast/send', ['POST']],
  ['/api/admin/broadcast/retry-failed', ['POST']],
  ['/api/slack/command', ['POST']],
  ['/api/slack/events', ['POST']],
  ['/api/slack/interactive', ['POST']],
  ['/api/_debug/env', ['GET']],
  ['/api/_debug/auth', ['GET']],
  ['/api/_debug/gas', ['GET']],
  ['/api/_debug/fingerprint', ['GET']],
  ['/api/_debug/line/botinfo', ['GET']],
  ['/api/_debug/routes', ['GET']],
  ['/api/admin/shift/raw/recent', ['GET']],
  ['/webhook', ['POST']],
  ['/liff/register', ['GET']],
  ['/liff/status', ['GET']],
  ['/liff/traffic', ['GET']]
]);

const DEBUG_ROUTE_LIST = Array.from(ROUTE_METHODS.keys());

export async function routeFetch(request, env, ctx) {
  const requestId = sanitizeRequestId(request.headers.get('x-request-id')) || crypto.randomUUID();
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const origin = request.headers.get('origin') || '';
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const allowedOrigin = getAllowedOrigin(origin, allowedOrigins);
  const responder = createResponder(requestId, origin, allowedOrigin);
  const meta = responder.meta;

  if (request.method === 'OPTIONS') {
    // CORS preflight is always 200; non-allowed origins simply don't receive ACAO.
    return responder.ok({ status: 'preflight' }, { status: 200 });
  }

  if (origin && !allowedOrigin) {
    return responder.fail(
      buildError('E_CORS_ORIGIN_DENIED', 'Origin is not allowed.', { origin }, false),
      { status: 403 }
    );
  }

  const envValidation = validateEnvForRequest(env, path, request.method);
  if (!envValidation.ok) {
    return responder.fail(
      buildError('E_CONFIG', 'Missing required environment variables.', { missing: envValidation.missing }, false),
      { status: 500 }
    );
  }

  // Gate0.9: Cloudflare Access JWT is required for all /api/admin/* routes
  if (path.startsWith('/api/admin/')) {
    const cfCheck = await requireCfAccessJwt(request, env, meta);
    if (!cfCheck.ok) return responder.withCors(cfCheck.response);
  }

  try {
    const routeKey = `${request.method} ${path}`;
    switch (routeKey) {
      case 'POST /webhook':
        return await handleLineWebhook(request, env, meta, requestId, origin, allowedOrigin, ctx);
      case 'GET /api/health':
        return responder.ok({ status: 'healthy', version: 'v1' });
      case 'GET /api/dashboard/month':
        return responder.withCors(await handleDashboardMonth(request, env, meta, requestId, url));
      case 'GET /liff/traffic':
        return responder.withCors(htmlNoStoreResponse(renderTrafficLiffHtml(env)));
      case 'GET /liff/status':
        return responder.withCors(htmlNoStoreResponse(renderStatusPageHtml()));
      case 'GET /liff/register':
        return responder.withCors(htmlNoStoreResponse(renderRegisterLiffHtml(env)));
      case 'GET /api/status':
        return responder.withCors(await handleStatusGet(request, env, meta, requestId, url));
      case 'GET /api/register/status':
        return responder.withCors(await handleRegisterStatus(request, env, meta, requestId, url));
      case 'GET /api/my/week/assignments':
        return responder.withCors(await handleMyWeekAssignments(request, env, meta, requestId, url));
      case 'POST /api/register/upsert':
        return responder.withCors(await handleRegisterUpsert(request, env, meta, requestId));
      case 'GET /api/unsubmitted':
        return responder.withCors(await handleUnsubmittedList(request, env, meta, requestId, url));
      case 'POST /api/traffic/create':
        return responder.withCors(await handleTrafficCreate(request, env, meta, requestId));
      case 'POST /api/expense/create':
        return responder.withCors(await handleExpenseCreate(request, env, meta, requestId));
      case 'POST /api/traffic/ocr-auto':
        return responder.withCors(await handleTrafficOcrAuto(request, env, meta, requestId));
      case 'POST /api/hotel/push':
        return responder.withCors(await handleHotelPush(request, env, meta, requestId));
      case 'POST /api/hotel/screenshot/process':
        return responder.withCors(await handleHotelScreenshotProcess(request, env, meta, requestId));
      case 'POST /api/reminder/push':
        return responder.withCors(await handleReminderPush(request, env, meta, requestId));
      case 'POST /api/monthly/export':
        return responder.withCors(await handleMonthlyExport(request, env, meta, requestId));
      case 'POST /api/ocr/extract':
        return responder.withCors(await handleOcrExtract(request, env, meta, requestId));
      case 'POST /api/shift/raw/ingest':
        return responder.withCors(await handleShiftRawIngest(request, env, meta, requestId));
      case 'POST /api/shift/parse/run':
        return responder.withCors(await handleShiftParseRun(request, env, meta, requestId));
      case 'POST /api/shift/parse/stats':
        return responder.withCors(await handleShiftParseStats(request, env, meta, requestId));
      case 'POST /api/admin/broadcast/preview':
        return responder.withCors(await handleAdminBroadcastPreview(request, env, meta, requestId));
      case 'POST /api/admin/broadcast/send':
        return responder.withCors(await handleAdminBroadcastSend(request, env, meta, requestId));
      case 'POST /api/admin/broadcast/retry-failed':
        return responder.withCors(await handleAdminBroadcastRetryFailed(request, env, meta, requestId));
      case 'POST /api/slack/command':
        return responder.withCors(await handleSlackCommand(request, env, meta, requestId));
      case 'POST /api/slack/events':
        return responder.withCors(await handleSlackEvents(request, env, meta, requestId));
      case 'POST /api/slack/interactive':
        return responder.withCors(await handleSlackInteractive(request, env, meta, requestId));
      case 'GET /api/_debug/env':
        return responder.withCors(await handleDebugEnv(request, env, meta, origin, allowedOrigin));
      case 'GET /api/_debug/auth':
        return responder.withCors(await handleDebugAuth(request, env, meta));
      case 'GET /api/_debug/gas':
        return responder.withCors(await handleDebugGas(request, env, meta, requestId, url));
      case 'GET /api/_debug/line/botinfo':
        return responder.withCors(await handleDebugLineBotInfo(request, env, meta));
      case 'GET /api/_debug/routes':
        return responder.withCors(await handleDebugRoutes(request, env, meta, DEBUG_ROUTE_LIST));
      case 'GET /api/_debug/fingerprint':
        return responder.withCors(await handleDebugFingerprint(request, env, meta, origin, allowedOrigin));
      case 'GET /api/admin/shift/raw/recent':
        return responder.withCors(await handleAdminShiftRawRecent(request, env, meta, requestId, url));
      default:
        if (ROUTE_METHODS.has(path)) {
          return responder.fail(
            buildError('E_METHOD_NOT_ALLOWED', 'Method not allowed.', { path, method: request.method }, false),
            { status: 405 }
          );
        }
        return responder.fail(buildError('E_NOT_FOUND', 'Not found.', { path }, false), { status: 404 });
    }
  } catch (error) {
    safeLog('error.unhandled', {
      requestId,
      path,
      method: request.method,
      headers: redactHeaders(request.headers),
      message: String(error?.message || error)
    });

    return responder.fail(buildError('E_INTERNAL', 'Internal error.', {}, true), { status: 500 });
  }
}

export async function routeScheduled(controller, env, ctx) {
  const requestId = crypto.randomUUID();
  const meta = createMeta(requestId);
  const envValidation = validateEnvForScheduled(env);
  if (!envValidation.ok) {
    safeLog('scheduled.config.invalid', { requestId, missing: envValidation.missing });
    return;
  }
  const scheduledAtMs = Number(controller?.scheduledTime || Date.now());
  const date = ymdJstFromEpoch(scheduledAtMs);

  const task = runScheduledReminder(env, meta, requestId, { date });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
    return;
  }
  await task;
}

export { ROUTE_METHODS };
