import { callGas } from '../clients/gas.js';
import { createMeta } from '../http/response.js';
import { safeLog } from './redact.js';

export async function tryWriteOpsLogAlert(env, requestId, alertInput) {
  const token = String(env.STAFF_TOKEN_FOR_GAS || '').trim();
  if (!token) return { ok: false, reason: 'missing_token' };

  const source = String(alertInput?.source || '').trim() || 'worker';
  const event = String(alertInput?.event || '').trim() || 'unknown';
  const message = String(alertInput?.message || '').trim();
  const payload = alertInput?.payload && typeof alertInput.payload === 'object' ? alertInput.payload : {};

  const { ok: gasOk, gasJson } = await callGas(
    env,
    {
      action: 'ops.log',
      token,
      requestId,
      data: {
        kind: 'admin_alert',
        severity: 'warn',
        source,
        event,
        message,
        payload,
        status: 'open'
      }
    },
    createMeta(requestId),
    { retries: 0 }
  );

  if (!gasOk || !gasJson?.ok) {
    safeLog('ops.log.write.failed', {
      requestId,
      source,
      event,
      gasErrorCode: gasJson?.error?.code || ''
    });
    return {
      ok: false,
      reason: gasJson?.error?.code || 'ops_log_failed'
    };
  }

  return { ok: true };
}
