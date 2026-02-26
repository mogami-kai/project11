#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TODAY="$(date +%F)"
PROJECT_ID="${PROJECT_ID:-P_E2E}"

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

PAYLOAD="{\"projectId\":\"${PROJECT_ID}\",\"workDate\":\"${TODAY}\",\"messageTemplate\":\"${TODAY} ${PROJECT_ID} ホテル要否を回答してください。\"}"

echo "[expected] hotel push returns ok=true with targetCount/pushed/failed/skipped"
run "curl -sS -X POST \"${WORKER_BASE}/api/hotel/push\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '${PAYLOAD}'"

echo

echo "[grep tips]"
echo "grep -E '\"ok\":true|targetCount|pushed|failed|skipped'"
echo "Worker logs: grep 'hotel.push.delivery'"
