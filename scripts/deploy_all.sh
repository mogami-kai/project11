#!/usr/bin/env bash
# ===========================================================================
# deploy_all.sh — テスト→デプロイをワンコマンドで実行
# Spec: docs/v5_spec.md §4 Done Criteria / ルール: 失敗したら停止
#
# 使用方法:
#   export WORKER_BASE="https://traffic-worker-v0.kaitomoga0316.workers.dev"
#   export API_KEY="<your-api-key>"
#   bash scripts/deploy_all.sh
#
# 前提:
#   - wrangler が PATH に入っていること（npx wrangler でも可）
#   - clasp が PATH に入っていること
#   - gas/.clasp.json が存在すること
# ===========================================================================
set -euo pipefail

WORKER_DIR="${WORKER_DIR:-$(dirname "$0")/../worker}"
GAS_DIR="${GAS_DIR:-$(dirname "$0")/../gas}"
SCRIPTS_DIR="${SCRIPTS_DIR:-$(dirname "$0")}"
LOG_DATE=$(date +%Y%m%d)
LOG_DIR="${SCRIPTS_DIR}/../artifacts/e2e_logs_${LOG_DATE}"
LOG_FILE="${LOG_DIR}/deploy_$(date +%H%M%S).log"

mkdir -p "$LOG_DIR"

log() { echo "[$(date +%T)] $*" | tee -a "$LOG_FILE"; }
die() { log "ERROR: $*"; log "デプロイ中断。ロールバック手順: git revert HEAD && wrangler deploy（前バージョン）"; exit 1; }

log "==========================================================="
log "Project1 v5 デプロイパイプライン開始"
log "LOG: ${LOG_FILE}"
log "==========================================================="

# ---------------------------------------------------------------------------
# Step 1: E2E テスト（デプロイ前に実行、失敗したら停止）
# ---------------------------------------------------------------------------
log "[Step 1/4] E2E テスト実行..."
if bash "${SCRIPTS_DIR}/e2e_v5.sh" 2>&1 | tee -a "$LOG_FILE"; then
  log "[Step 1/4] E2E テスト: PASSED"
else
  die "[Step 1/4] E2E テスト失敗。デプロイを中断します。"
fi

# ---------------------------------------------------------------------------
# Step 2: Worker デプロイ（wrangler）
# ---------------------------------------------------------------------------
log "[Step 2/4] Worker デプロイ（wrangler）..."

WRANGLER_CMD="wrangler"
if ! command -v wrangler &>/dev/null; then
  WRANGLER_CMD="npx wrangler"
fi

# 差分サマリ
log "--- Worker 差分サマリ ---"
git -C "${WORKER_DIR}/.." diff --name-only HEAD 2>/dev/null || true
git -C "${WORKER_DIR}/.." log --oneline -5 2>/dev/null || true

# 影響範囲
log "--- 影響範囲 ---"
log "Worker: 全ルーティング（expense/hotelScreenshot/dashboard/monthly）"
log "GAS: expense.create, hotel.screenshot.process, hotel.intent.submit（upsert）"
log "auth.js: STAFF_BEARER_TOKEN バイパス削除（本番認証強化）"

# ロールバック手順を生成
CURRENT_VERSION=$(cd "$WORKER_DIR" && $WRANGLER_CMD deployments list 2>/dev/null | head -2 | tail -1 | awk '{print $1}' || echo "unknown")
log "--- ロールバック手順 ---"
log "Worker rollback: cd worker && wrangler rollback ${CURRENT_VERSION}"
log "GAS rollback: clasp 管理画面 → バージョン履歴から前バージョンをデプロイ"

# Worker デプロイ実行
(cd "$WORKER_DIR" && $WRANGLER_CMD deploy 2>&1 | tee -a "$LOG_FILE") || die "Worker デプロイ失敗"
log "[Step 2/4] Worker デプロイ: DONE"

# ---------------------------------------------------------------------------
# Step 3: GAS デプロイ（clasp）
# ---------------------------------------------------------------------------
log "[Step 3/4] GAS デプロイ（clasp push）..."

if ! command -v clasp &>/dev/null; then
  log "WARNING: clasp が見つかりません。GAS デプロイをスキップします。"
  log "         手動で: cd gas && clasp push"
else
  (cd "$GAS_DIR" && clasp push 2>&1 | tee -a "$LOG_FILE") || die "GAS clasp push 失敗"
  log "[Step 3/4] GAS デプロイ: DONE"
fi

# ---------------------------------------------------------------------------
# Step 4: デプロイ後 E2E 検証（smoke test）
# ---------------------------------------------------------------------------
log "[Step 4/4] デプロイ後 smoke test..."
if bash "${SCRIPTS_DIR}/e2e_health.sh" 2>&1 | tee -a "$LOG_FILE"; then
  log "[Step 4/4] デプロイ後 smoke test: PASSED"
else
  log "WARNING: smoke test 失敗。ロールバックを検討してください。"
  log "ロールバック手順: cd worker && wrangler rollback ${CURRENT_VERSION}"
fi

# ---------------------------------------------------------------------------
# 完了サマリ
# ---------------------------------------------------------------------------
log "==========================================================="
log "デプロイ完了"
log "LOG ファイル: ${LOG_FILE}"
log "==========================================================="
