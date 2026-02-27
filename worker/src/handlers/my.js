import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, json } from '../lib/response.js';
import { sanitizeDateYmd, sanitizeUserId } from '../lib/validate.js';
import { ymdJstFromEpoch } from '../util/time.js';

export async function handleMyWeekAssignments(request, env, meta, requestId, url) {
  const gasToken = String(env.STAFF_TOKEN_FOR_GAS || env.STAFF_TOKEN || '').trim();
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  const queryUserId = sanitizeUserId(url.searchParams.get('userId'));
  const weekId = String(url.searchParams.get('weekId') || '').trim();
  const targetDate = sanitizeDateYmd(url.searchParams.get('targetDate')) || ymdJstFromEpoch(Date.now());

  const userId = auth.mode === 'liff-id-token' ? auth.userId : queryUserId;
  if (!userId) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required' }] }, false),
      meta,
      { status: 400 }
    );
  }

  if (auth.mode === 'liff-id-token' && queryUserId && queryUserId !== auth.userId) {
    return fail(
      buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: queryUserId }, false),
      meta,
      { status: 403 }
    );
  }

  const { ok: gasOk, response, gasJson } = await callGas(
    env,
    {
      action: 'my.week.assignments',
      token: gasToken,
      requestId,
      data: {
        userId,
        targetDate,
        weekId
      }
    },
    meta,
    { retries: 0 }
  );

  if (!gasOk) return response;

  const result = gasJson?.ok
    ? { ok: true, data: gasJson.data || {}, meta }
    : { ok: false, error: gasJson.error || {}, meta };

  return json(result, { status: result.ok ? 200 : 400 });
}
