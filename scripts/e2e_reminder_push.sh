#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TODAY="$(date +%F)"

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

PAYLOAD="{\"date\":\"${TODAY}\"}"

echo "[expected] reminder push returns ok=true with targetCount/pushed/failed/skipped"
run "curl -sS -X POST \"${WORKER_BASE}/api/reminder/push\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '${PAYLOAD}'"

echo

echo "[grep tips]"
echo "grep -E '\"ok\":true|targetCount|pushed|failed|skipped'"
echo "Worker logs: grep 'reminder.push.delivery'"
