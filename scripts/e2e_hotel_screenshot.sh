#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
ADMIN_LINE_USER_ID="${ADMIN_LINE_USER_ID:-U_ADMIN_LINE_USER_ID}"
HOTEL_SCREENSHOT_IMAGE_BASE64="${HOTEL_SCREENSHOT_IMAGE_BASE64:-}"
TARGET_USER_ID="${TARGET_USER_ID:-}"

if [[ -z "${HOTEL_SCREENSHOT_IMAGE_BASE64}" ]]; then
  echo "[skip] HOTEL_SCREENSHOT_IMAGE_BASE64 が未設定です。"
  echo "       base64化したホテル確認スクリーンショットを環境変数へ設定してください。"
  exit 0
fi

echo "[expected] confirmedCount/unmatchedCount/duplicateCount を含むJSONを返す"

echo

echo "[command] POST /api/hotel/screenshot/process"
curl -sS -X POST "${WORKER_BASE}/api/hotel/screenshot/process" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  --data "{\"lineUserId\":\"${ADMIN_LINE_USER_ID}\",\"targetUserId\":\"${TARGET_USER_ID}\",\"mimeType\":\"image/jpeg\",\"imageBase64\":\"${HOTEL_SCREENSHOT_IMAGE_BASE64}\"}"

echo

echo "[grep tips]"
echo "... | grep -E '\"confirmedCount\"|\"unmatchedCount\"|\"duplicateCount\"'"
