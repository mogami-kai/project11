#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TARGET_MONTH="${TARGET_MONTH:-$(date +%Y-%m)}"
RAW_TEXT="${RAW_TEXT:-@All 現場A（26日～1日） DL: 山田 太郎 CL: 27日 佐藤 花子→28日 鈴木 一郎→1日 田中 次郎}"
PREVIEW_OPERATION_ID="${PREVIEW_OPERATION_ID:-preview-${TARGET_MONTH}-001}"
SEND_OPERATION_ID="${SEND_OPERATION_ID:-send-${TARGET_MONTH}-001}"

printf '[expected] preview -> send -> send again with same operationId is safe (idempotent / resumable)\n\n'

printf '[command] POST /api/admin/broadcast/preview\n'
curl -sS -X POST "${WORKER_BASE}/api/admin/broadcast/preview" \
  -H 'content-type: application/json' \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${PREVIEW_OPERATION_ID}" \
  --data "{\"targetMonth\":\"${TARGET_MONTH}\",\"rawText\":\"${RAW_TEXT}\",\"operationId\":\"${PREVIEW_OPERATION_ID}\"}"

printf '\n\n[command] POST /api/admin/broadcast/send\n'
curl -sS -X POST "${WORKER_BASE}/api/admin/broadcast/send" \
  -H 'content-type: application/json' \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${SEND_OPERATION_ID}-1" \
  --data "{\"targetMonth\":\"${TARGET_MONTH}\",\"rawText\":\"${RAW_TEXT}\",\"operationId\":\"${SEND_OPERATION_ID}\"}"

printf '\n\n[command] POST /api/admin/broadcast/send (same operationId, different idempotency key)\n'
curl -sS -X POST "${WORKER_BASE}/api/admin/broadcast/send" \
  -H 'content-type: application/json' \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${SEND_OPERATION_ID}-2" \
  --data "{\"targetMonth\":\"${TARGET_MONTH}\",\"rawText\":\"${RAW_TEXT}\",\"operationId\":\"${SEND_OPERATION_ID}\"}"

printf '\n\n[grep tips]\n'
printf '... | grep -E "\"ok\"|\"broadcastId\"|\"operationId\"|\"status\"|\"alreadyProcessed\""\n'
