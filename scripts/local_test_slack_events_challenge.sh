#!/usr/bin/env bash
# local_test_slack_events_challenge.sh
# 目的: /api/slack/events の url_verification challenge をローカルで再現検証する
# 前提: wrangler dev がポート 8787 で起動していること
#       SLACK_SIGNING_SECRET が .dev.vars に設定されていること
# 使い方: bash scripts/local_test_slack_events_challenge.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"

if [ -z "$SIGNING_SECRET" ]; then
  # .dev.vars から読み込み試行
  DEVVARS="$(dirname "$0")/../worker/.dev.vars"
  if [ -f "$DEVVARS" ]; then
    SIGNING_SECRET=$(grep '^SLACK_SIGNING_SECRET=' "$DEVVARS" | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi

if [ -z "$SIGNING_SECRET" ]; then
  echo "[ERROR] SLACK_SIGNING_SECRET が未設定です。環境変数か worker/.dev.vars に設定してください。"
  exit 1
fi

CHALLENGE="test_challenge_$(date +%s)"
BODY="{\"type\":\"url_verification\",\"challenge\":\"${CHALLENGE}\",\"token\":\"dummy\"}"
TIMESTAMP=$(date +%s)
BASESTRING="v0:${TIMESTAMP}:${BODY}"

# HMAC-SHA256 署名を計算
SIG=$(printf '%s' "$BASESTRING" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')
SLACK_SIG="v0=${SIG}"

echo "--- Request ---"
echo "URL:       POST ${BASE_URL}/api/slack/events"
echo "Timestamp: ${TIMESTAMP}"
echo "Signature: ${SLACK_SIG}"
echo "Body:      ${BODY}"
echo ""

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST "${BASE_URL}/api/slack/events" \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: ${TIMESTAMP}" \
  -H "x-slack-signature: ${SLACK_SIG}" \
  -d "${BODY}")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY_RESP=$(echo "$RESPONSE" | grep -v "HTTP_STATUS:")

echo "--- Response ---"
echo "Status: ${HTTP_STATUS}"
echo "Body:   ${BODY_RESP}"
echo ""

# 検証
if [ "$HTTP_STATUS" != "200" ]; then
  echo "[FAIL] Expected HTTP 200, got ${HTTP_STATUS}"
  exit 1
fi

RETURNED_CHALLENGE=$(echo "$BODY_RESP" | grep -o '"challenge":"[^"]*"' | cut -d'"' -f4)
if [ "$RETURNED_CHALLENGE" = "$CHALLENGE" ]; then
  echo "[PASS] challenge が正しく返却されました: ${RETURNED_CHALLENGE}"
else
  echo "[FAIL] challenge 不一致。期待: ${CHALLENGE} / 実際: ${RETURNED_CHALLENGE}"
  exit 1
fi
