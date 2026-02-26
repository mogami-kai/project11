#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
API_KEY="${API_KEY:-<WORKER_API_KEY>}"

run() {
  echo
  echo "[command] $*"
  eval "$@"
}

echo "[expected] /api/health returns ok=true and /api/_debug/routes includes /api/shift/raw/ingest"
run "curl -sS \"${WORKER_BASE}/api/health\""
run "curl -sS \"${WORKER_BASE}/api/_debug/routes\" -H \"x-api-key: ${API_KEY}\""

echo

echo "[grep tips]"
echo "curl .../api/health | grep -E '\"ok\"|healthy'"
echo "curl .../api/_debug/routes ... | grep '/api/shift/raw/ingest'"
