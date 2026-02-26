#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
TEST_USER_ID="${TEST_USER_ID:-U1234567890}"
TEST_NAME="${TEST_NAME:-テスト太郎}"
TEST_PROJECT="${TEST_PROJECT:-PJT_DEMO}"
MONTH="${MONTH:-$(date +%Y-%m)}"
WORK_DATE="${WORK_DATE:-$(date +%Y-%m-%d)}"

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

echo "[expected] 主要APIがok=trueで応答し、ダッシュボード指標が更新される"

echo

echo "[1/7] health + routes"
run "curl -sS \"${WORKER_BASE}/api/health\""
run "curl -sS \"${WORKER_BASE}/api/_debug/routes\" -H \"x-api-key: ${API_KEY}\""

echo

echo "[2/7] dashboard"
run "curl -sS \"${WORKER_BASE}/api/dashboard/month?userId=${TEST_USER_ID}&month=${MONTH}\" -H \"x-api-key: ${API_KEY}\""

echo

echo "[3/7] traffic.create"
run "curl -sS -X POST \"${WORKER_BASE}/api/traffic/create\" -H \"content-type: application/json\" -H \"x-api-key: ${API_KEY}\" -H \"x-idempotency-key: e2e-full-traffic-${MONTH}\" --data '{\"userId\":\"'\"${TEST_USER_ID}\"'\",\"name\":\"'\"${TEST_NAME}\"'\",\"project\":\"'\"${TEST_PROJECT}\"'\",\"workDate\":\"'\"${WORK_DATE}\"'\",\"fromStation\":\"新宿\",\"toStation\":\"渋谷\",\"amount\":220,\"roundTrip\":\"片道\",\"memo\":\"e2e full system\",\"requestId\":\"e2e-full-traffic-'\"${MONTH}\"'\"}'"

echo

echo "[4/7] expense.create"
run "curl -sS -X POST \"${WORKER_BASE}/api/expense/create\" -H \"content-type: application/json\" -H \"x-api-key: ${API_KEY}\" -H \"x-idempotency-key: e2e-full-expense-${MONTH}\" --data '{\"userId\":\"'\"${TEST_USER_ID}\"'\",\"name\":\"'\"${TEST_NAME}\"'\",\"project\":\"'\"${TEST_PROJECT}\"'\",\"workDate\":\"'\"${WORK_DATE}\"'\",\"category\":\"備品\",\"amount\":1500,\"paymentMethod\":\"advance\",\"memo\":\"e2e full expense\",\"requestId\":\"e2e-full-expense-'\"${MONTH}\"'\"}'"

echo

echo "[5/7] hotel.push (運用に応じて対象0件でもok)"
run "curl -sS -X POST \"${WORKER_BASE}/api/hotel/push\" -H \"content-type: application/json\" -H \"x-api-key: ${API_KEY}\" --data '{\"projectId\":\"'\"${TEST_PROJECT}\"'\",\"workDate\":\"'\"${WORK_DATE}\"'\"}'"

echo

echo "[6/7] reminder.push"
run "curl -sS -X POST \"${WORKER_BASE}/api/reminder/push\" -H \"content-type: application/json\" -H \"x-api-key: ${API_KEY}\" --data '{\"date\":\"'\"${WORK_DATE}\"'\"}'"

echo

echo "[7/7] dashboard re-check"
run "curl -sS \"${WORKER_BASE}/api/dashboard/month?userId=${TEST_USER_ID}&month=${MONTH}\" -H \"x-api-key: ${API_KEY}\""

echo

echo "[expected summary]"
echo "- 各レスポンスで \"ok\":true"
echo "- dashboard.cards に shiftDays / trafficTotal / expenseTotal / hotelUnanswered / hotelConfirmed が存在"
