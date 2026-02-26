# Webhook Signature Notes (/webhook)

LINE webhook signature verification must use:
1. The exact raw request body bytes.
2. HMAC-SHA256 with `LINE_CHANNEL_SECRET`.
3. Base64 output set to header `x-line-signature`.

The Worker route is:

```text
POST https://<worker-domain>/webhook
```

## Reproducible local signing flow

```bash
export WORKER_BASE="https://<worker-domain>"
export LINE_CHANNEL_SECRET="your_line_channel_secret"

cat > /tmp/line_webhook_body.json <<'JSON'
{"events":[{"type":"message","replyToken":"DUMMY_REPLY_TOKEN","timestamp":1739980800000,"source":{"type":"user","userId":"U123"},"message":{"id":"m123","type":"text","text":"@All\n渋谷現場（1日～2日）\nDL: 山田"}}]}
JSON

SIGNATURE=$(openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary /tmp/line_webhook_body.json | openssl base64)

curl -sS -X POST "$WORKER_BASE/webhook" \
  -H "content-type: application/json" \
  -H "x-line-signature: $SIGNATURE" \
  --data-binary @/tmp/line_webhook_body.json
```

Expected:
- HTTP 200 with `ok: true` and `acknowledged: true`.
- Worker logs include `shift.raw.ingest.parse.summary` when message text matches shift format.

Invalid signature check:

```bash
curl -sS -X POST "https://<worker-domain>/webhook" \
  -H "content-type: application/json" \
  -H "x-line-signature: invalid-signature" \
  --data-binary @/tmp/line_webhook_body.json
```

Expected:
- HTTP 401 with `error.code = E_UNAUTHORIZED`.
