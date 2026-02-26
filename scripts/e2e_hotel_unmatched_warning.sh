#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
ADMIN_LINE_USER_ID="${ADMIN_LINE_USER_ID:-U_ADMIN_LINE_USER_ID}"
HOTEL_SCREENSHOT_IMAGE_BASE64="${HOTEL_SCREENSHOT_IMAGE_BASE64:-}"
TARGET_USER_ID="${TARGET_USER_ID:-U_NOT_EXIST_999}"

if [[ -z "${HOTEL_SCREENSHOT_IMAGE_BASE64}" ]]; then
  echo "HOTEL_SCREENSHOT_IMAGE_BASE64 is required"
  exit 1
fi

echo "[expected] result=unmatched and warnings include NEEDS_MANUAL_REVIEW"
curl -sS -X POST "${WORKER_BASE}/api/hotel/screenshot/process" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  --data "{\"lineUserId\":\"${ADMIN_LINE_USER_ID}\",\"targetUserId\":\"${TARGET_USER_ID}\",\"mimeType\":\"image/jpeg\",\"imageBase64\":\"${HOTEL_SCREENSHOT_IMAGE_BASE64}\"}" | jq
