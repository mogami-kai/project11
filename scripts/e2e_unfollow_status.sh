#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
LINE_CHANNEL_SECRET="${LINE_CHANNEL_SECRET:-}"
TARGET_USER_ID="${TARGET_USER_ID:-U_E2E_UNFOLLOW_001}"

if [[ -z "${LINE_CHANNEL_SECRET}" ]]; then
  echo "LINE_CHANNEL_SECRET is required"
  exit 1
fi

TS="$(($(date +%s) * 1000))"
EVENT_ID="evt-unfollow-${TS}"
PAYLOAD=$(cat <<JSON
{"events":[{"type":"unfollow","source":{"type":"user","userId":"${TARGET_USER_ID}"},"timestamp":${TS},"webhookEventId":"${EVENT_ID}"}]}
JSON
)

SIGNATURE=$(printf '%s' "${PAYLOAD}" | openssl dgst -sha256 -hmac "${LINE_CHANNEL_SECRET}" -binary | openssl base64)

echo "[1/2] webhook unfollow"
curl -sS -X POST "${WORKER_BASE}/webhook" \
  -H "content-type: application/json" \
  -H "x-line-signature: ${SIGNATURE}" \
  --data "${PAYLOAD}" | jq

echo "[2/2] register status should show lineFollowStatus=unfollow"
curl -sS "${WORKER_BASE}/api/register/status?userId=${TARGET_USER_ID}" \
  -H "x-api-key: ${API_KEY}" | jq
