#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"
USER_ID="${USER_ID:-U_TEST}"
TARGET_DATE="${TARGET_DATE:-$(date +%F)}"

printf '[expected] my.week.assignments returns weekId / assignments / siteOptions\n\n'

printf '[command] GET /api/my/week/assignments\n'
curl -sS "${WORKER_BASE}/api/my/week/assignments?userId=${USER_ID}&targetDate=${TARGET_DATE}" \
  -H "x-api-key: ${API_KEY}" \
  -H 'accept: application/json'

printf '\n\n[grep tips]\n'
printf '... | grep -E "\"ok\"|\"weekId\"|\"assignments\"|\"siteOptions\""\n'
