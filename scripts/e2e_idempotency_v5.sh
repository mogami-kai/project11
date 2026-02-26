#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TEST_USER_ID="${TEST_USER_ID:-U_E2E_IDEM_001}"
TODAY="${TODAY:-$(date +%F)}"

TRAFFIC_KEY="idem-traffic-${TEST_USER_ID}-${TODAY}"
EXPENSE_KEY="idem-expense-${TEST_USER_ID}-${TODAY}"
SHIFT_KEY="idem-shift-${TEST_USER_ID}-${TODAY}"

TRAFFIC_PAYLOAD=$(cat <<JSON
{"requestId":"${TRAFFIC_KEY}","idempotencyKey":"${TRAFFIC_KEY}","userId":"${TEST_USER_ID}","workDate":"${TODAY}","fromStation":"東京","toStation":"新宿","amount":220,"roundTrip":"片道","memo":"idem traffic"}
JSON
)

EXPENSE_PAYLOAD=$(cat <<JSON
{"requestId":"${EXPENSE_KEY}","idempotencyKey":"${EXPENSE_KEY}","userId":"${TEST_USER_ID}","work":{"workDate":"${TODAY}","site":"E2E"},"expense":{"amount":1500,"category":"備品","note":"idem expense"}}
JSON
)

SHIFT_PAYLOAD=$(cat <<JSON
{"requestId":"${SHIFT_KEY}","idempotencyKey":"${SHIFT_KEY}","rawMessageId":"raw-${SHIFT_KEY}","rawText":"@All\nテスト現場（1日～1日）\n山田 太郎（ヤマダ タロウ）", "lineUserId":"${TEST_USER_ID}","lineGroupId":"G_E2E"}
JSON
)

echo "[traffic] first"
curl -sS -X POST "${WORKER_BASE}/api/traffic/create" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${TRAFFIC_KEY}" --data "${TRAFFIC_PAYLOAD}" | jq

echo "[traffic] second (same key)"
curl -sS -X POST "${WORKER_BASE}/api/traffic/create" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${TRAFFIC_KEY}" --data "${TRAFFIC_PAYLOAD}" | jq

echo "[expense] first"
curl -sS -X POST "${WORKER_BASE}/api/expense/create" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${EXPENSE_KEY}" --data "${EXPENSE_PAYLOAD}" | jq

echo "[expense] second (same key)"
curl -sS -X POST "${WORKER_BASE}/api/expense/create" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${EXPENSE_KEY}" --data "${EXPENSE_PAYLOAD}" | jq

echo "[shift.raw.ingest] first"
curl -sS -X POST "${WORKER_BASE}/api/shift/raw/ingest" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${SHIFT_KEY}" --data "${SHIFT_PAYLOAD}" | jq

echo "[shift.raw.ingest] second (same key)"
curl -sS -X POST "${WORKER_BASE}/api/shift/raw/ingest" -H "content-type: application/json" -H "x-api-key: ${API_KEY}" -H "x-idempotency-key: ${SHIFT_KEY}" --data "${SHIFT_PAYLOAD}" | jq
