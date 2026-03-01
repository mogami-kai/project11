#!/usr/bin/env bash
set -eu

info(){ echo "ℹ️  $*"; }
ok(){ echo "✅ $*"; }

WORKER_NAME="traffic-worker-v0"

# wrangler.toml の [vars] を一気に更新
info "=== Patching wrangler.toml [vars] with full values ==="

VARS=(
  "ALLOWED_ORIGINS:https://traffic-worker-v0.kaitomoga0316.workers.dev,https://liff.line.me"
  "GEMINI_MODEL:gemini-1.5-flash"
  "IDEMPOTENCY_TTL_SECONDS:86400"
  "WEBHOOK_EVENT_TTL_SECONDS:86400"
  "LINE_RICHMENU_ID_REGISTERED:richmenu-79334ff2600b5f8c8bd6c60e95f00ba6"
  "LINE_RICHMENU_ID_UNREGISTERED:richmenu-887950d6199cf7c72c53a490e2a3436b"
  "LIFF_REGISTER_URL:https://traffic-worker-v0.kaitomoga0316.workers.dev/liff/register"
  "LIFF_TRAFFIC_URL:https://traffic-worker-v0.kaitomoga0316.workers.dev/liff/traffic"
  "LIFF_EXPENSE_URL:https://traffic-worker-v0.kaitomoga0316.workers.dev/liff/expense"
  "LIFF_HOTEL_URL:https://traffic-worker-v0.kaitomoga0316.workers.dev/liff/status"
)

for item in "${VARS[@]}"; do
  key="${item%%:*}"
  value="${item#*:}"
  escaped_val=$(printf '%s' "$value" | sed 's/[&/]/\\&/g')
  
  if grep -q "^\s*${key}\s*=" wrangler.toml; then
    perl -i -pe "s/^\s*${key}\s*=.*/${key} = \"${escaped_val}\"/" wrangler.toml
  else
    perl -i -pe "s/(\[vars\])/\$1\n${key} = \"${escaped_val}\"/" wrangler.toml
  fi
  ok "Var set: $key"
done

# 注意: SLACK系は Secret に入れたいので、もし wrangler.toml に空の vars があるなら削除するか、Secretを優先させるために wrangler.toml から消すのが安全です。
# 今回はそのままデプロイします。

info "=== Deploying Worker (Final) ==="
npx wrangler deploy --name "$WORKER_NAME"

ok "Fix deployed!"
