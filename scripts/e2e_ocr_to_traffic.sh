#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TODAY="$(date +%F)"
OCR_IMAGE_BASE64="${OCR_IMAGE_BASE64:-}"
OCR_MIME_TYPE="${OCR_MIME_TYPE:-image/jpeg}"
USER_ID="${USER_ID:-U_OCR_E2E}"

if [[ -z "${OCR_IMAGE_BASE64}" ]]; then
  echo "[error] OCR_IMAGE_BASE64 is required for this script."
  echo "[hint] export OCR_IMAGE_BASE64='...base64 receipt image...'"
  exit 1
fi

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

OCR_FILE="/tmp/ocr_extract_$$.json"
TRAFFIC_FILE="/tmp/ocr_traffic_$$.json"

OCR_PAYLOAD="{\"userId\":\"${USER_ID}\",\"workDate\":\"${TODAY}\",\"projectId\":\"P_OCR\",\"name\":\"OCR E2E\",\"imageBase64\":\"${OCR_IMAGE_BASE64}\",\"mimeType\":\"${OCR_MIME_TYPE}\"}"

echo "[expected] OCR returns ok=true and includes data.normalizedClaimDraft"
run "curl -sS -X POST \"${WORKER_BASE}/api/ocr/extract\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -d '${OCR_PAYLOAD}' | tee ${OCR_FILE}"

if ! grep -q '"normalizedClaimDraft"' "${OCR_FILE}"; then
  echo "[error] normalizedClaimDraft not found in OCR response"
  exit 1
fi

REQUEST_ID="ocr-e2e-$(date +%s)"
DRAFT_PAYLOAD="$(node -e 'const fs=require("fs");const path=process.argv[1];const reqId=process.argv[2];const p=JSON.parse(fs.readFileSync(path,"utf8"));if(!p.ok||!p.data||!p.data.normalizedClaimDraft){process.exit(2)};const d=p.data.normalizedClaimDraft;d.requestId=reqId;process.stdout.write(JSON.stringify(d));' "${OCR_FILE}" "${REQUEST_ID}")"

echo "[expected] traffic create from draft returns ok=true"
run "curl -sS -X POST \"${WORKER_BASE}/api/traffic/create\" -H \"Content-Type: application/json\" -H \"x-api-key: ${API_KEY}\" -H \"x-idempotency-key: ${REQUEST_ID}\" -d '${DRAFT_PAYLOAD}' | tee ${TRAFFIC_FILE}"

echo

echo "[grep tips]"
echo "grep 'normalizedClaimDraft' ${OCR_FILE}"
echo "grep -E '\"ok\":true|dedup|row' ${TRAFFIC_FILE}"
