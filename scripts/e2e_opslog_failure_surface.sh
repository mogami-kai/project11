#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
MONTH="${MONTH:-$(date +%Y-%m)}"

cat <<'NOTE'
Run this against an environment where ops.log writes fail (for example, invalid STAFF_TOKEN_FOR_GAS)
while business writes still succeed.
Expected:
- monthly/export returns ok=true with meta.warnings including OPS_LOG_WRITE_FAILED
- hotel/screenshot/process unmatched returns warnings including ADMIN_ALERT_WRITE_FAILED and auditLogged=false
NOTE

echo "[monthly/export]"
curl -sS -X POST "${WORKER_BASE}/api/monthly/export" \
  -H "content-type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  --data "{\"month\":\"${MONTH}\"}" | jq
