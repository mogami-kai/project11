// Spec: data-boundary.md §2 / action-contracts §4.2
// PR-A: Sheets フォールバックを削除。GAS action 失敗時は E_UPSTREAM を返す。
// Worker は SHIFT_ASSIGNMENTS / TRAFFIC_LOG / EXPENSE_LOG / HOTEL_* に直接アクセスしない。
import { authenticateRequest } from '../auth.js';
import { callGas } from '../clients/gas.js';
import { requireAdmin } from '../lib/access.js';
import { buildError, fail, json, ok } from '../lib/response.js';
import { sanitizeMonth } from '../lib/validate.js';

export async function handleMonthlyExport(request, env, meta, requestId) {
  const auth = await authenticateRequest(request, env, meta, {
    allowApiKey: true,
    allowLiffIdToken: true
  });
  if (!auth.ok) return auth.response;

  const adminCheck = requireAdmin(request, env, meta, {
    requireAdminUser: auth.mode === 'liff-id-token',
    userId: auth.userId
  });
  if (!adminCheck.ok) return adminCheck.response;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const month = sanitizeMonth(body?.month);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return fail(
      buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'month', reason: 'must be YYYY-MM' }] }, false),
      meta,
      { status: 400 }
    );
  }

  // Spec: data-boundary.md §2 — 集計・レポート生成は GAS action 経由に統一
  const gasMonthly = await callGas(
    env,
    {
      action: 'monthly.file.generate',
      token: env.STAFF_TOKEN_FOR_GAS,
      requestId,
      data: { month }
    },
    meta,
    { retries: 0, timeoutMs: 60000 }
  );

  if (gasMonthly.ok && gasMonthly.gasJson?.ok) {
    return ok(gasMonthly.gasJson?.data || {}, meta);
  }

  // フォールバック経路（Sheets直読み + スプレッドシート直接作成）は data-boundary.md §2 違反のため廃止。
  // GAS が E_UNSUPPORTED_ACTION を返す場合は monthly.file.generate を GAS 側で実装してください。
  if (!gasMonthly.ok) return gasMonthly.response;

  const gasErrorCode = String(gasMonthly.gasJson?.error?.code || '');
  if (gasErrorCode === 'E_UNSUPPORTED_ACTION') {
    return fail(
      buildError('E_UPSTREAM', 'monthly.file.generate is not implemented in GAS. Please implement this action.', { action: 'monthly.file.generate' }, false),
      meta,
      { status: 501 }
    );
  }

  return json({ ok: false, error: gasMonthly.gasJson?.error || {}, meta }, { status: 400 });
}
