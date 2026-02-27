#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TARGET_MONTH="${TARGET_MONTH:-$(date +%Y-%m)}"
BROADCAST_ID="${BROADCAST_ID:-}"
OPERATION_ID="${OPERATION_ID:-retry-${TARGET_MONTH}-001}"

if [[ -z "${BROADCAST_ID}" ]]; then
  printf '[error] set BROADCAST_ID before running this script\n' >&2
  exit 1
fi

printf '[expected] retry-failed runs remaining pending/failed only; second run is no-op/same aggregate\n\n'

printf '[command] POST /api/admin/broadcast/retry-failed\n'
curl -sS -X POST "${WORKER_BASE}/api/admin/broadcast/retry-failed" \
  -H 'content-type: application/json' \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${OPERATION_ID}-1" \
  --data "{\"targetMonth\":\"${TARGET_MONTH}\",\"broadcastId\":\"${BROADCAST_ID}\",\"operationId\":\"${OPERATION_ID}\"}"

printf '\n\n[command] POST /api/admin/broadcast/retry-failed (same operationId)\n'
curl -sS -X POST "${WORKER_BASE}/api/admin/broadcast/retry-failed" \
  -H 'content-type: application/json' \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${OPERATION_ID}-2" \
  --data "{\"targetMonth\":\"${TARGET_MONTH}\",\"broadcastId\":\"${BROADCAST_ID}\",\"operationId\":\"${OPERATION_ID}\"}"

printf '\n\n[grep tips]\n'
printf '... | grep -E "\"ok\"|\"retry\"|\"remainingFailed\"|\"status\"|\"updated\""\n'
