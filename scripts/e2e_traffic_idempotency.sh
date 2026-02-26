#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TODAY="$(date +%F)"
IDEMPOTENCY_KEY="traffic-e2e-${TODAY}-001"
PAYLOAD="{\"userId\":\"U_E2E_TRAFFIC\",\"name\":\"E2E User\",\"project\":\"P_E2E\",\"workDate\":\"${TODAY}\",\"fromStation\":\"東京\",\"toStation\":\"新宿\",\"amount\":200,\"roundTrip\":\"片道\",\"memo\":\"e2e idempotency\",\"requestId\":\"${IDEMPOTENCY_KEY}\"}"

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

echo "[expected] first request ok=true, second request ok=true and dedup=true (or same row id)."
run "curl -sS -X POST \"${WORKER_BASE}/api/traffic/create\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -H \"x-idempotency-key: ${IDEMPOTENCY_KEY}\" -d '${PAYLOAD}'"
run "curl -sS -X POST \"${WORKER_BASE}/api/traffic/create\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -H \"x-idempotency-key: ${IDEMPOTENCY_KEY}\" -d '${PAYLOAD}'"

echo

echo "[grep tips]"
echo "grep -E '\"ok\":true|dedup'"
echo "Cloudflare logs: grep requestId=${IDEMPOTENCY_KEY}"
