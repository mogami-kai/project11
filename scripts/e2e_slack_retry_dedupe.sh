#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://<worker-domain>}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"

if [[ -z "${SLACK_SIGNING_SECRET}" ]]; then
  printf '[error] set SLACK_SIGNING_SECRET before running this script\n' >&2
  exit 1
fi

BODY='team_id=TTEST&channel_id=CTEST&user_id=UTEST&command=%2Ftl&text=unknown&trigger_id=13345224609.738474920.8088930838d88f008e0'
TIMESTAMP="$(date +%s)"
BASE_STRING="v0:${TIMESTAMP}:${BODY}"
DIGEST="$(printf '%s' "${BASE_STRING}" | openssl dgst -sha256 -hmac "${SLACK_SIGNING_SECRET}" | awk '{print $2}')"
SIGNATURE="v0=${DIGEST}"

printf '[expected] identical Slack payload with x-slack-retry-num returns cached response and does not duplicate side effects\n\n'

printf '[command] first request\n'
FIRST_RESPONSE="$(curl -sS -X POST "${WORKER_BASE}/api/slack/command" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "x-slack-request-timestamp: ${TIMESTAMP}" \
  -H "x-slack-signature: ${SIGNATURE}" \
  --data "${BODY}")"
printf '%s\n' "${FIRST_RESPONSE}"

printf '\n[command] retry request (x-slack-retry-num: 1)\n'
SECOND_RESPONSE="$(curl -sS -X POST "${WORKER_BASE}/api/slack/command" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "x-slack-request-timestamp: ${TIMESTAMP}" \
  -H "x-slack-signature: ${SIGNATURE}" \
  -H 'x-slack-retry-num: 1' \
  -H 'x-slack-retry-reason: http_timeout' \
  --data "${BODY}")"
printf '%s\n' "${SECOND_RESPONSE}"

printf '\n[result] '
if [[ "${FIRST_RESPONSE}" == "${SECOND_RESPONSE}" ]]; then
  printf 'PASS (cached response matched)\n'
else
  printf 'WARN (response body changed)\n'
fi
