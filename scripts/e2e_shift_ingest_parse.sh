#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
RAW_MESSAGE_ID="shift-e2e-$(date +%s)"
RAW_TEXT='@All
新宿現場（1日～2日）
DL: 山田太郎
CL: 佐藤花子'

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

echo "[expected] /api/_debug/routes includes /api/shift/raw/ingest to prevent E_NOT_FOUND"
run "curl -sS \"${WORKER_BASE}/api/_debug/routes\" -H \"x-api-key: ${API_KEY}\""

echo "[expected] ingest ok=true"
run "curl -sS -X POST \"${WORKER_BASE}/api/shift/raw/ingest\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '{\"rawMessageId\":\"${RAW_MESSAGE_ID}\",\"rawText\":\"'\"${RAW_TEXT//$'\n'/\\n}\"'\",\"lineUserId\":\"U_SHIFT_E2E\",\"lineGroupId\":\"G_SHIFT_E2E\"}'"

echo "[expected] parse run ok=true and parsed/skipped/errored fields exist"
run "curl -sS -X POST \"${WORKER_BASE}/api/shift/parse/run\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '{\"rawMessageId\":\"${RAW_MESSAGE_ID}\",\"includeErrors\":true,\"limit\":1}'"

echo "[expected] stats ok=true with total/stored/parsed/error"
run "curl -sS -X POST \"${WORKER_BASE}/api/shift/parse/stats\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '{}'"

echo "[expected] recent includes the rawMessageId"
run "curl -sS \"${WORKER_BASE}/api/admin/shift/raw/recent?limit=20\" -H \"x-api-key: ${API_KEY}\""

echo

echo "[grep tips]"
echo "grep '/api/shift/raw/ingest' from _debug/routes"
echo "grep ${RAW_MESSAGE_ID} from ingest/recent output"
echo "grep -E '\"parsed\"|\"errored\"|\"assignmentInserted\"' from parse output"
