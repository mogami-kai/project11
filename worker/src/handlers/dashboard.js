// Spec: data-boundary.md §2 / action-contracts §4.2
// PR-A: Sheets フォールバックを削除。GAS action 失敗時は E_UPSTREAM を返す。
// Worker は Sheets（EXPENSE_LOG / HOTEL_INTENT_LOG / HOTEL_CONFIRMED_LOG）に直接アクセスしない。
import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { buildError, fail, ok } from '../lib/response.js';
import { ymJstFromEpoch } from '../util/time.js';
import { sanitizeMonth, sanitizeUserId } from '../lib/validate.js';

export async function handleDashboardMonth(request, env, meta, requestId, url) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  const queryUserId = sanitizeUserId(url.searchParams.get('userId'));
  const userId = auth.mode === 'liff-id-token' ? auth.userId : queryUserId;
  if (!userId) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'userId', reason: 'required' }] }, false),
      meta,
      { status: 400 }
    );
  }

  if (auth.mode === 'liff-id-token' && queryUserId && queryUserId !== auth.userId) {
    return fail(buildError('E_FORBIDDEN', 'Forbidden userId.', { userId: queryUserId }, false), meta, { status: 403 });
  }

  const month = sanitizeMonth(url.searchParams.get('month')) || ymJstFromEpoch(Date.now());
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, false),
      meta,
      { status: 400 }
    );
  }

  // Spec: data-boundary.md §2 — 集計は GAS action 経由に統一
  const gasSnapshot = await callGas(
    env,
    {
      action: 'dashboard.staff.snapshot',
      token: env.STAFF_TOKEN_FOR_GAS,
      requestId,
      data: { userId, month }
    },
    meta,
    { retries: 0 }
  );

  if (gasSnapshot.ok && gasSnapshot.gasJson?.ok) {
    return ok(gasSnapshot.gasJson?.data || {}, meta);
  }

  // フォールバック経路（Sheets直読み）は data-boundary.md §2 違反のため廃止。
  // GAS が応答しない場合は E_UPSTREAM で返す。
  if (!gasSnapshot.ok) return gasSnapshot.response;

  return fail(
    buildError('E_UPSTREAM', 'dashboard.staff.snapshot failed.', { gasError: gasSnapshot.gasJson?.error || {} }, true),
    meta,
    { status: 502 }
  );
}
