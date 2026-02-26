#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
MONTH="${MONTH:-$(date +%Y-%m)}"

echo "[expected] /api/monthly/export が fileUrl / rowCounts / totals を返す"

echo

echo "[command] POST /api/monthly/export"
curl -sS -X POST "${WORKER_BASE}/api/monthly/export" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  --data "{\"month\":\"${MONTH}\"}"

echo

echo "[grep tips]"
echo "... | grep -E '\"ok\"|\"fileUrl\"|\"rowCounts\"|\"totals\"'"
