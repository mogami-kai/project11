# Runlog: Gate 0.5 — Environment Management System

**Date**: 2026-03-01
**Gate**: 0.5
**Operator**: Claude (release auditor)
**Status**: COMPLETE

---

## Commands Executed

1. Repository tree scan (`find` — non-binary files, excluding node_modules/.git)
2. Read `worker/wrangler.toml`
3. Read `worker/src/lib/env.js`
4. Read `worker/src/index.js`
5. Read `worker/src/auth.js`
6. Read `worker/src/clients/gas.js`
7. Read `worker/src/clients/line.js`
8. Read `worker/src/clients/slack.js`
9. Read `worker/src/clients/gemini.js`
10. Read `worker/src/clients/google.js`
11. Read `worker/src/lib/access.js`
12. Read `worker/src/lib/validate.js`
13. Read `worker/src/router.js`
14. Read `worker/src/handlers/admin.js`
15. Read `worker/src/handlers/liff.js`
16. Read `worker/src/handlers/broadcast.js`
17. Read `worker/src/handlers/monthly.js`
18. Read `worker/src/handlers/webhook.js`
19. Read `worker/src/lib/receipt.js` (partial)
20. Read `worker/src/lib/idempotency.js` (partial)
21. Read `worker/src/util/ops.js`
22. Read `gas/コード.js` (partial — 150 lines; full grep for ScriptProperties)
23. Grep `worker/src/**/*.js` for all `env.<NAME>` references
24. Grep `gas/コード.js` for `ScriptProperties`, `getProperty`, `STAFF_TOKEN`, `SPREADSHEET_ID`
25. Read `docs/ops_rules.md`
26. Read `docs/docs_ops_rules.md`
27. Read `docs/action-contracts.md`
28. Read `docs/README.md`
29. Read `.gitignore`
30. Read `worker/.dev.vars` (existence check only — values not output)

---

## Diff Summary

### Files Created

| File | Size | Purpose |
|---|---|---|
| `docs/ENVIRONMENT.md` | ~6KB | Normative env spec (variables, classification, checklist, rotation, incident) |
| `docs/ENVIRONMENT_RUNBOOK.md` | ~4KB | Operator runbook (local setup, secret commands, GAS setup, pre-deploy) |
| `docs/ENVIRONMENT_PROMPT.md` | ~3KB | AI audit instruction (strict gate, SECTION A–D output format) |
| `worker/.dev.vars.example` | ~1.5KB | Example file for local .dev.vars (empty values, all worker vars listed) |

### Files Modified

| File | Change |
|---|---|
| `docs/README.md` | Added 3 rows to SoT table: ENVIRONMENT.md, ENVIRONMENT_RUNBOOK.md, ENVIRONMENT_PROMPT.md |

### Files NOT Modified

- All `worker/src/**/*.js` — no runtime logic touched
- `worker/wrangler.toml` — no changes
- `gas/コード.js` — no changes
- All existing `docs/*.md` except README.md

---

## ENV_DISCOVERY_LIST (final, deduplicated)

### Worker [vars] (wrangler.toml)
1. `ALLOWED_ORIGINS` — CORS origin allowlist
2. `IDEMPOTENCY_TTL_SECONDS` — idempotency record TTL
3. `WEBHOOK_EVENT_TTL_SECONDS` — webhook event dedup TTL
4. `ADMIN_ALLOWED_IPS` — admin route IP allowlist (**normative, BLOCK if absent**)
5. `LIFF_REGISTER_URL` — registration LIFF URL
6. `LINE_RICHMENU_ID_UNREGISTERED` — rich menu for unregistered users
7. `LINE_RICHMENU_ID_REGISTERED` — rich menu for registered users
8. `SLACK_SIGNING_SECRET` — Slack signing secret (**note: currently in [vars], must be secret**)
9. `SLACK_BOT_TOKEN` — Slack bot token (**note: currently in [vars], must be secret**)
10. `LIFF_TRAFFIC_URL` — traffic LIFF URL for broadcasts
11. `LIFF_EXPENSE_URL` — expense LIFF URL for broadcasts
12. `LIFF_HOTEL_URL` — hotel LIFF URL for broadcasts

### Worker Secrets (not in [vars])
13. `GAS_ENDPOINT` — GAS Web App URL
14. `STAFF_TOKEN_FOR_GAS` — GAS auth token
15. `LINE_CHANNEL_SECRET` — LINE webhook HMAC secret
16. `LINE_CHANNEL_ACCESS_TOKEN` — LINE Bot API token
17. `LIFF_ID` — LIFF application ID
18. `LIFF_URL` — general LIFF URL fallback
19. `GEMINI_API_KEY` — Gemini AI API key
20. `WORKER_API_KEY` — internal API key
21. `LINE_ADMIN_USER_IDS` — admin LINE user ID list
22. `GOOGLE_SERVICE_ACCOUNT_EMAIL` — Google service account email
23. `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — Google service account private key
24. `GOOGLE_SPREADSHEET_ID` — Spreadsheet ID (direct access)
25. `GOOGLE_DRIVE_EXPORT_FOLDER_ID` — Drive export folder
26. `RECEIPT_BUCKET` — R2 bucket binding
27. `RECEIPT_PUBLIC_BASE_URL` — receipt storage public URL

### Worker Optional Overrides
28. `GEMINI_MODEL` — model override (default: gemini-1.5-flash-8b)
29. `GEMINI_OCR_MODEL` — legacy alias for GEMINI_MODEL
30. `IDEMPOTENCY_LOCK_TTL_SECONDS` — lock TTL override (default: 120s)
31. `SPREADSHEET_ID` — legacy alias for GOOGLE_SPREADSHEET_ID
32. `STAFF_TOKEN` — legacy alias for STAFF_TOKEN_FOR_GAS

### Worker Bindings (wrangler.toml)
33. `IDEMPOTENCY_KV` — KV namespace
34. `IDEMPOTENCY_LOCK` — Durable Object

### GAS Script Properties
35. `SPREADSHEET_ID` (GAS) — target spreadsheet
36. `STAFF_TOKEN` (GAS) — auth token (must match Worker's STAFF_TOKEN_FOR_GAS)
37. `SP_SHIFT_SOURCE_MODE` (GAS) — optional behavior flag
38. `SEND_GUARD_SENDING_TTL_SECONDS` (GAS) — optional TTL

**Total: 38 unique environment variables / bindings / script properties**

---

## Classification Rationale

### ADMIN_ALLOWED_IPS — Required(Prod)=Yes, BLOCK
`docs/docs_ops_rules.md §6` is explicitly normative: "未設定・空文字・不正値...の状態での本番デプロイは仕様上の禁止事項（デプロイ不可）". No exception.

### GAS_ENDPOINT — classified as non-secret variable
The URL is not itself a secret (it is a public endpoint), but it encodes the deployment identity. Classified as variable with no sensitive flag. The auth protection is the `STAFF_TOKEN_FOR_GAS`.

### SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN — classification note
Currently declared under `[vars]` in wrangler.toml with empty values. Both are security-sensitive and MUST be set via `wrangler secret put` in production. The wrangler.toml entries act as empty placeholders. ENVIRONMENT.md documents them as `secret` type.

### GEMINI_API_KEY — Conditional
OCR routes fail gracefully with `E_OCR_DISABLED` if absent. Only becomes Required(Prod)=Yes if OCR routes are actively used.

### GOOGLE_SERVICE_ACCOUNT_* — Conditional
`clients/google.js` exists and monthly export uses GAS as primary path. Direct Sheets access is a fallback. Classified Conditional unless direct access is confirmed active.

### STAFF_TOKEN / SPREADSHEET_ID — legacy aliases
Multiple handlers accept either `STAFF_TOKEN_FOR_GAS` OR `STAFF_TOKEN` (e.g., `env.js:63`). These are documented as aliases; only the canonical name needs to be set in production.

---

## Secrets Written to Files

**None.**

The `.dev.vars.example` file contains only empty values. No secret values were read, stored, or output during this gate. The existing `worker/.dev.vars` file (which contains real credentials) was detected but its contents were not output and are not reproduced in any generated file.

---

## Final Status

**Gate 0.5: COMPLETE**

Files created: 4
Files modified: 1
Runtime logic modified: 0
Secrets written to files: 0
