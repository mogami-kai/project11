#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TEST_USER_ID="${TEST_USER_ID:-U_E2E_REGISTER_001}"
TODAY="${TODAY:-$(date +%F)}"

REG_IDEM="reg-${TEST_USER_ID}-${TODAY}"
TRAFFIC_IDEM_PRE="traffic-pre-${TEST_USER_ID}-${TODAY}"
TRAFFIC_IDEM_POST="traffic-post-${TEST_USER_ID}-${TODAY}"

REGISTER_PAYLOAD=$(cat <<JSON
{
  "requestId": "${REG_IDEM}",
  "idempotencyKey": "${REG_IDEM}",
  "staff": {
    "nameKanji": "山田 太郎",
    "nameKana": "ヤマダ タロウ",
    "birthDate": "1999-01-01",
    "nearestStation": "新宿（東京）",
    "phone": "090-1234-5678",
    "emergencyRelation": "母",
    "emergencyPhone": "090-0000-0000",
    "postalCode": "123-4567",
    "address": "東京都新宿区..."
  }
}
JSON
)

TRAFFIC_PAYLOAD=$(cat <<JSON
{
  "requestId": "${TRAFFIC_IDEM_PRE}",
  "idempotencyKey": "${TRAFFIC_IDEM_PRE}",
  "userId": "${TEST_USER_ID}",
  "workDate": "${TODAY}",
  "fromStation": "新宿",
  "toStation": "渋谷",
  "amount": 240,
  "roundTrip": "片道",
  "memo": "e2e register gate pre"
}
JSON
)

TRAFFIC_PAYLOAD_POST=$(cat <<JSON
{
  "requestId": "${TRAFFIC_IDEM_POST}",
  "idempotencyKey": "${TRAFFIC_IDEM_POST}",
  "userId": "${TEST_USER_ID}",
  "workDate": "${TODAY}",
  "fromStation": "新宿",
  "toStation": "渋谷",
  "amount": 240,
  "roundTrip": "片道",
  "memo": "e2e register gate post"
}
JSON
)

echo "[1/5] register status (before)"
curl -sS "${WORKER_BASE}/api/register/status?userId=${TEST_USER_ID}" \
  -H "x-api-key: ${API_KEY}" | jq

echo "[2/5] traffic.create should be blocked with E_REGISTER_REQUIRED"
curl -sS -X POST "${WORKER_BASE}/api/traffic/create" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${TRAFFIC_IDEM_PRE}" \
  --data "${TRAFFIC_PAYLOAD}" | jq

echo "[3/5] register upsert"
curl -sS -X POST "${WORKER_BASE}/api/register/upsert" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${REG_IDEM}" \
  --data "${REGISTER_PAYLOAD}" | jq

echo "[4/5] register status (after)"
curl -sS "${WORKER_BASE}/api/register/status?userId=${TEST_USER_ID}" \
  -H "x-api-key: ${API_KEY}" | jq

echo "[5/5] traffic.create should pass"
curl -sS -X POST "${WORKER_BASE}/api/traffic/create" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -H "x-idempotency-key: ${TRAFFIC_IDEM_POST}" \
  --data "${TRAFFIC_PAYLOAD_POST}" | jq
