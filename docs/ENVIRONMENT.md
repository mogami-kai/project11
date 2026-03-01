# ENVIRONMENT.md — Project1 Environment Management Specification

**Status: Normative**
**Gate: 0.8**
**Last updated: 2026-03-01**

---

## 1. Principles (Normative)

1. **Source of Truth**: This file (`docs/ENVIRONMENT.md`) is the single normative reference for all environment variables in this project.
2. **No Secrets in Code**: Secret values are never written into source files, wrangler.toml, or committed .dev.vars files.
3. **Fail-Close**: Missing required variables cause explicit, logged failures — not silent degradation.
4. **Minimal Surface**: Only variables that appear in the codebase are documented here. No speculative additions.
5. **Gate 0.5 Rule**: Deployment to production is **forbidden** if any `Required(Prod)=Yes` variable is absent.
6. **ops_rules Normative Override**: Cloudflare Access protection for admin routes is normative per `docs/docs_ops_rules.md §6`. When admin routes are enabled, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` must be present — their absence is a deployment BLOCK regardless of any other gate status.

---

## 2. Source of Truth Definition

| Component | Config mechanism | Where values live |
|---|---|---|
| Cloudflare Worker | `wrangler.toml [vars]` | Non-secret vars, committed with empty values for secrets |
| Cloudflare Worker | `wrangler secret put` | Secret values, stored in Cloudflare dashboard |
| Cloudflare Worker (local) | `worker/.dev.vars` | Local-only, **git-ignored** |
| GAS | `PropertiesService.getScriptProperties()` | GAS Script Properties panel |
| Cloudflare KV | `wrangler.toml [[kv_namespaces]]` | KV namespace binding (ID in toml) |
| Cloudflare DO | `wrangler.toml [[durable_objects.bindings]]` | Durable Object class binding |

`.dev.vars` is listed in `.gitignore`. It must never be committed.

---

## 3. Variable Table

### 3.1 Worker — Configuration Variables (wrangler.toml [vars])

| Variable | Type | Sensitive | Required(Prod) | Required(Dev) | Source | Purpose |
|---|---|---|---|---|---|---|
| `ALLOWED_ORIGINS` | variable | No | **Yes** | **Yes** | `wrangler.toml:7`, `env.js:79`, `router.js:71` | Comma-separated HTTPS origins for CORS allowlist |
| `IDEMPOTENCY_TTL_SECONDS` | variable | No | No | No | `wrangler.toml:8`, `idempotency.js:83,198` | TTL for idempotency records (default: 86400) |
| `WEBHOOK_EVENT_TTL_SECONDS` | variable | No | No | No | `wrangler.toml:9`, `webhook.js:599` | TTL for LINE webhook event dedup (default: 86400) |
| `ADMIN_ALLOWED_IPS` | variable | No | No | No | `wrangler.toml:10`, `access.js:71`, `admin.js:244`, `docs_ops_rules.md §6` | Comma-separated IPv4 allowlist for admin routes — optional defense-in-depth; Cloudflare Access is the primary admin protection |
| `LIFF_REGISTER_URL` | variable | No | **Yes** | Conditional | `wrangler.toml:11`, `liff.js:2`, `webhook.js:185` | LIFF registration page URL |
| `LINE_RICHMENU_ID_UNREGISTERED` | variable | No | Conditional | No | `wrangler.toml:12`, `webhook.js:208` | LINE rich menu ID for unregistered users |
| `LINE_RICHMENU_ID_REGISTERED` | variable | No | Conditional | No | `wrangler.toml:13`, `register.js:182` | LINE rich menu ID for registered users |
| `SLACK_SIGNING_SECRET` | **secret** | **Yes** | Conditional | Conditional | `wrangler.toml:14`, `slack.js:21,37,690`, `broadcast.js:392` | Slack request signing secret — currently listed as [vars]; MUST be migrated to `wrangler secret` |
| `SLACK_BOT_TOKEN` | **secret** | **Yes** | Conditional | Conditional | `wrangler.toml:15`, `clients/slack.js:60`, `slack.js:82` | Slack Bot OAuth token — currently listed as [vars]; MUST be migrated to `wrangler secret` |
| `LIFF_TRAFFIC_URL` | variable | No | **Yes** | Conditional | `wrangler.toml:16`, `broadcastMessage.js:14` | LIFF URL for traffic expense submission (broadcast messages) |
| `LIFF_EXPENSE_URL` | variable | No | **Yes** | Conditional | `wrangler.toml:17`, `broadcastMessage.js:15` | LIFF URL for expense submission (broadcast messages) |
| `LIFF_HOTEL_URL` | variable | No | No | No | `wrangler.toml:18`, `broadcastMessage.js:16` | **[DEPRECATED — hotel is message-based, no LIFF required]** LIFF URL for hotel intent — variable retained in code; hotel flow operates via LINE push/broadcast with Yes/No button replies, not a LIFF page |

### 3.2 Worker — Secrets (set via `wrangler secret put`)

| Variable | Type | Sensitive | Required(Prod) | Required(Dev) | Source | Purpose |
|---|---|---|---|---|---|---|
| `GAS_ENDPOINT` | secret | No* | **Yes** | **Yes** | `clients/gas.js:29,38,57`, `lib/env.js:28`, `admin.js:211,224` | GAS Web App deployment URL (ends with `/exec`) |
| `STAFF_TOKEN_FOR_GAS` | secret | **Yes** | **Yes** | **Yes** | `clients/gas.js:118`, `lib/env.js:28,63`, `access.js:141` | Auth bearer token for Worker→GAS API calls |
| `LINE_CHANNEL_SECRET` | secret | **Yes** | **Yes** | **Yes** | `webhook.js:28,42`, `lib/env.js:32` | LINE channel secret for webhook HMAC verification |
| `LINE_CHANNEL_ACCESS_TOKEN` | secret | **Yes** | **Yes** | **Yes** | `clients/line.js:40,50,81,98,171,184`, `lib/env.js:32,54` | LINE Bot API access token |
| `LIFF_ID` | secret | No* | **Yes** | **Yes** | `auth.js:74,77`, `handlers/liff.js:171` | LINE LIFF application ID (used in token verification) |
| `LIFF_URL` | variable | No | **Yes** | Conditional | `webhook.js:329,185`, `hotel.js:296,313`, `reminder.js:165,208` | General LIFF URL (fallback for traffic/expense/hotel) |
| `GEMINI_API_KEY` | secret | **Yes** | Conditional | Conditional | `clients/gemini.js:26`, `handlers/ocr.js:60`, `handlers/trafficPair.js:69`, `handlers/hotelScreenshot.js:73` | Google Gemini API key for OCR features |
| `WORKER_API_KEY` | secret | **Yes** | **Yes** | **Yes** | `lib/validate.js:98`, `admin.js:212` | API key for internal/admin authentication (x-api-key header) |
| `LINE_ADMIN_USER_IDS` | variable | No | **Yes** | Conditional | `lib/access.js:85` | Comma-separated LINE user IDs with admin privileges |
| `CF_ACCESS_TEAM_DOMAIN` | secret | No | Conditional | No | `docs_ops_rules.md §6` | Cloudflare Access team domain (e.g. `team.cloudflareaccess.com`) — required when admin routes are enabled |
| `CF_ACCESS_AUD` | secret | **Yes** | Conditional | No | `docs_ops_rules.md §6` | Cloudflare Access JWT audience tag for admin route verification — required when admin routes are enabled |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | secret | **Yes** | Conditional | Conditional | `clients/google.js:21,35,110` | Google service account email (only if direct Sheets/Drive access used) |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | secret | **Yes** | Conditional | Conditional | `clients/google.js:22,36,111` | Google service account RSA private key (PEM) |
| `GOOGLE_SPREADSHEET_ID` | variable | No | Conditional | Conditional | `clients/google.js:324` | Google Spreadsheet ID for direct Sheets access (not via GAS) |
| `GOOGLE_DRIVE_EXPORT_FOLDER_ID` | variable | No | Conditional | No | `clients/google.js:487` | Google Drive folder ID for monthly export placement |
| `RECEIPT_BUCKET` | binding | No | Conditional | No | `lib/receipt.js:175,185` | Cloudflare R2 bucket binding for expense receipt storage |
| `RECEIPT_PUBLIC_BASE_URL` | variable | No | Conditional | No | `lib/receipt.js:176,186` | Public URL prefix for stored receipts (required if RECEIPT_BUCKET set) |

### 3.3 Worker — Optional Overrides

| Variable | Type | Sensitive | Required(Prod) | Required(Dev) | Source | Purpose |
|---|---|---|---|---|---|---|
| `GEMINI_MODEL` | variable | No | No | No | `clients/gemini.js:11` | Override Gemini model name (default: `gemini-1.5-flash-8b`) |
| `GEMINI_OCR_MODEL` | variable | No | No | No | `clients/gemini.js:11` | Legacy alias for `GEMINI_MODEL` |
| `IDEMPOTENCY_LOCK_TTL_SECONDS` | variable | No | No | No | `lib/idempotency.js:146` | Lock TTL override (default: 120s) |
| `SPREADSHEET_ID` | variable | No | Conditional | Conditional | `clients/google.js:326` | Legacy alias for `GOOGLE_SPREADSHEET_ID` |
| `STAFF_TOKEN` | variable | **Yes** | No | No | `lib/env.js:63`, `handlers/shift.js:16` | Legacy alias for `STAFF_TOKEN_FOR_GAS` |

### 3.4 Worker — Cloudflare Bindings (wrangler.toml)

| Binding | Type | Required(Prod) | Required(Dev) | Source | Purpose |
|---|---|---|---|---|---|
| `IDEMPOTENCY_KV` | KV Namespace | **Yes** | **Yes** | `wrangler.toml:23-26`, `lib/idempotency.js:91,118,144,175,206`, `webhook.js:591,643` | KV store for idempotency records and webhook event dedup |
| `IDEMPOTENCY_LOCK` | Durable Object | **Yes** | **Yes** | `wrangler.toml:28-30`, `lib/idempotency.js:59,62,63` | Durable Object for distributed locking |

### 3.5 GAS — Script Properties

| Property | Type | Sensitive | Required(Prod) | Required(Dev) | Source | Purpose |
|---|---|---|---|---|---|---|
| `SPREADSHEET_ID` | script property | No | **Yes** | **Yes** | `gas/コード.js:3008,116,4196` | Google Spreadsheet ID for all GAS data operations |
| `STAFF_TOKEN` | script property | **Yes** | **Yes** | **Yes** | `gas/コード.js:3009,113` | Auth token; must match Worker's `STAFF_TOKEN_FOR_GAS` |
| `SP_SHIFT_SOURCE_MODE` | script property | No | No | No | `gas/コード.js:3022` | Shift source mode behavior flag |
| `SEND_GUARD_SENDING_TTL_SECONDS` | script property | No | No | No | `gas/コード.js:3525` | Send guard TTL override |

---

## 4. Conditional Logic Rules

### 4.1 OCR Feature (Gemini)
`GEMINI_API_KEY` is required if and only if any of the following routes are in use:
- `POST /api/ocr/extract`
- `POST /api/traffic/ocr-auto`
- `POST /api/hotel/screenshot/process`

If OCR is enabled in production, `GEMINI_API_KEY` transitions to `Required(Prod)=Yes`.

### 4.2 Slack Integration
`SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are required if any of the following routes are in use:
- `POST /api/slack/command`
- `POST /api/slack/events`
- `POST /api/slack/interactive`
- `POST /api/admin/broadcast/*`

If Slack integration is active in production, both transition to `Required(Prod)=Yes`.

**WARNING**: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are currently declared under `[vars]` in `wrangler.toml`. They are security-sensitive and MUST be stored via `wrangler secret put` in production. The `[vars]` entries act as empty-value placeholders only.

### 4.3 Rich Menus
`LINE_RICHMENU_ID_UNREGISTERED` and `LINE_RICHMENU_ID_REGISTERED` are required only if LINE rich menu onboarding flow is used. If absent, rich menu linking is silently skipped (no error).

### 4.4 Direct Google Sheets / Drive Access
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`, and `GOOGLE_DRIVE_EXPORT_FOLDER_ID` are required only if the Worker accesses Sheets/Drive directly (not via GAS). Currently `clients/google.js` is present and the `POST /api/monthly/export` route delegates to GAS first; direct access is a fallback path.

### 4.5 Receipt Storage
`RECEIPT_BUCKET` (R2 binding) and `RECEIPT_PUBLIC_BASE_URL` are required together if expense receipt storage is enabled. If `RECEIPT_BUCKET` is set, `RECEIPT_PUBLIC_BASE_URL` is also required.

### 4.6 STAFF_TOKEN_FOR_GAS vs STAFF_TOKEN
The code accepts either `STAFF_TOKEN_FOR_GAS` or `STAFF_TOKEN` (legacy alias). In production, set `STAFF_TOKEN_FOR_GAS`. The GAS side reads `STAFF_TOKEN` from Script Properties — these two values must be identical.

### 4.7 LIFF URLs
`LIFF_URL` acts as a general fallback when `LIFF_TRAFFIC_URL` or `LIFF_EXPENSE_URL` are not set. For broadcast messages, specific URLs are preferred over the fallback.

`LIFF_TRAFFIC_URL` and `LIFF_EXPENSE_URL` must be set in production for correct broadcast button behavior. `LIFF_HOTEL_URL` is **deprecated** — hotel flow is message-based (LINE push + Yes/No buttons) and does not require a LIFF URL. See §4.9.

### 4.8 Cloudflare Access (Admin Route Protection)
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are required if and only if admin routes are enabled (registered in the router):
- `GET /api/admin/shift/raw/recent`
- `POST /api/hotel/push`
- `POST /api/reminder/push`
- Any other route under `/api/admin/*`

If admin routes are enabled in production, both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` transition to `Required(Prod)=Yes` (BLOCK).

If admin routes are disabled (not registered in the router), these variables are `Conditional/No`.

`ADMIN_ALLOWED_IPS` may be set as additional defense-in-depth but is not required.

### 4.9 Hotel Operation (Message-Based — No LIFF)
Hotel flow does **not** use a LIFF page. Hotel operations are handled entirely via LINE messaging:
- Hotel need/not-needed is collected via LINE broadcast push with interactive button replies (Yes / No).
- Users may change their response (Cancel / Change) via subsequent button replies.
- State machine: `UNSET → YES | NO`, reversible (`YES ↔ NO`), reset to `UNSET` after period closes.
- All state transitions must be logged; last state and update history must be preserved in audit records.
- No LIFF URL is required or expected for hotel flow. `LIFF_HOTEL_URL` is deprecated (see §3.1).

### 4.10 Status View — 状況把握 (REVIEW_REQUIRED)
The system must provide a way for users to quickly check monthly totals:
- **当月 (current month)**: total traffic submissions + total expense submissions
- **前月 (previous month)**: total traffic submissions + total expense submissions

Two supported implementation modes (choose one per deployment):

**(A) LIFF status page** — a single LIFF endpoint URL serves the status view. If this mode is active, a dedicated LIFF URL variable must be set (specific variable name to be determined in the implementation gate).

**(B) LINE message command** — user sends a command keyword; Worker replies with a formatted message containing the monthly totals.

**REVIEW_REQUIRED**: Which mode is implemented has not been verified against source code in this gate. No env var is added for mode (A) until the implementation gate confirms the route exists and the variable name is determined.

### 4.11 Traffic LIFF (Unified Single Endpoint)
Traffic expense submission uses a **single LIFF application** regardless of input method:
- OCR-assisted entry and manual entry are both served by the same LIFF endpoint.
- `LIFF_TRAFFIC_URL` is the sole URL variable for the traffic LIFF — no separate OCR URL exists.
- The distinction between OCR mode and manual mode is handled inside the LIFF UI, not via separate URLs.

---

## 5. Production Deploy Checklist

Before every production deployment, confirm each item:

- [ ] `ALLOWED_ORIGINS` — non-empty, contains only valid HTTPS URLs
- [ ] `ADMIN_ALLOWED_IPS` — optional; if set, must contain ≥1 valid IPv4 address (defense-in-depth only, not required)
- [ ] `GAS_ENDPOINT` — set, ends with `/exec`, is a valid HTTPS URL
- [ ] `STAFF_TOKEN_FOR_GAS` — set, non-empty, matches GAS `STAFF_TOKEN` script property
- [ ] `LINE_CHANNEL_SECRET` — set, non-empty
- [ ] `LINE_CHANNEL_ACCESS_TOKEN` — set, non-empty
- [ ] `LIFF_ID` — set, non-empty
- [ ] `LIFF_URL` — set, non-empty
- [ ] `LIFF_REGISTER_URL` — set, non-empty
- [ ] `LIFF_TRAFFIC_URL` — set, non-empty
- [ ] `LIFF_EXPENSE_URL` — set, non-empty
- [ ] `LIFF_HOTEL_URL` — **deprecated/optional**; hotel flow is message-based (LINE push + Yes/No buttons); not required in production
- [ ] `WORKER_API_KEY` — set, non-empty
- [ ] `LINE_ADMIN_USER_IDS` — set, contains ≥1 LINE user ID
- [ ] `IDEMPOTENCY_KV` binding — KV namespace ID present in wrangler.toml, namespace exists in Cloudflare
- [ ] `IDEMPOTENCY_LOCK` binding — Durable Object migration `v1` applied
- [ ] GAS `SPREADSHEET_ID` script property — set, valid Spreadsheet ID
- [ ] GAS `STAFF_TOKEN` script property — set, matches `STAFF_TOKEN_FOR_GAS`
- [ ] If Slack enabled: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` set via `wrangler secret`
- [ ] If OCR enabled: `GEMINI_API_KEY` set via `wrangler secret`
- [ ] If receipt storage enabled: `RECEIPT_BUCKET` binding and `RECEIPT_PUBLIC_BASE_URL` set
- [ ] If admin routes enabled: `CF_ACCESS_TEAM_DOMAIN` — set, non-empty (**BLOCK if absent**)
- [ ] If admin routes enabled: `CF_ACCESS_AUD` — set, non-empty (**BLOCK if absent**)

---

## 6. BLOCK Conditions

**Deployment is forbidden if any Required(Prod)=Yes variable is missing or empty.**

| Condition | Block | Reason |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` absent and admin routes enabled | **BLOCK** | Normative per `docs_ops_rules.md §6`; admin routes lack Cloudflare Access protection |
| `CF_ACCESS_AUD` absent and admin routes enabled | **BLOCK** | Normative per `docs_ops_rules.md §6`; Cloudflare Access JWT audience verification impossible |
| `GAS_ENDPOINT` absent | **BLOCK** | Core dependency; majority of API routes fail at 500 |
| `STAFF_TOKEN_FOR_GAS` absent | **BLOCK** | Core auth; all GAS-backed routes fail |
| `LINE_CHANNEL_SECRET` absent | **BLOCK** | Webhook signature verification impossible |
| `LINE_CHANNEL_ACCESS_TOKEN` absent | **BLOCK** | All LINE message delivery fails |
| `LIFF_ID` absent | **BLOCK** | LIFF-authenticated routes return 500 |
| `WORKER_API_KEY` absent | **BLOCK** | Admin/debug API authentication impossible |
| `ALLOWED_ORIGINS` absent or empty | **BLOCK** | CORS validation rejects all browser requests |
| `IDEMPOTENCY_KV` binding absent | **BLOCK** | Idempotency and webhook dedup broken |

---

## 7. Rotation Policy

| Variable | Rotation trigger | Procedure |
|---|---|---|
| `STAFF_TOKEN_FOR_GAS` / GAS `STAFF_TOKEN` | Compromise, quarterly | Update Worker secret AND GAS script property atomically. Worker reads new value on next request. |
| `LINE_CHANNEL_ACCESS_TOKEN` | Compromise, LINE policy | Rotate in LINE Developer Console, then `wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` |
| `LINE_CHANNEL_SECRET` | Compromise, LINE policy | Rotate in LINE Developer Console, then `wrangler secret put LINE_CHANNEL_SECRET` |
| `SLACK_SIGNING_SECRET` | Compromise, Slack policy | Rotate in Slack App settings, then `wrangler secret put SLACK_SIGNING_SECRET` |
| `SLACK_BOT_TOKEN` | Compromise, Slack policy | Rotate in Slack App settings, then `wrangler secret put SLACK_BOT_TOKEN` |
| `GEMINI_API_KEY` | Compromise | Rotate in Google Cloud Console, then `wrangler secret put GEMINI_API_KEY` |
| `WORKER_API_KEY` | Compromise, quarterly | `wrangler secret put WORKER_API_KEY` and update all callers |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Compromise, annual | Generate new key in GCP, update `wrangler secret put` |
| `ADMIN_ALLOWED_IPS` | IP change | `wrangler deploy` after updating `wrangler.toml [vars]` (optional; omit if not used) |
| `CF_ACCESS_AUD` | Cloudflare Access app rotation | `wrangler secret put CF_ACCESS_AUD`; update `CF_ACCESS_TEAM_DOMAIN` if team domain changes |

After any rotation: verify affected routes with a health check. Record rotation in deployment log.

---

## 8. Incident Response

### Secret Compromise

1. **Immediately** rotate the compromised secret (see §7).
2. Verify new value is live: call `GET /api/_debug/env` with `x-api-key` header and confirm the relevant `present.*` field is `true`.
3. Check `ADMIN_ALERTS` sheet in the Spreadsheet for any abuse evidence.
4. Record the incident and rotation in the ops runlog.

### Missing Required Variable Detected at Runtime

1. Worker returns `{ ok: false, error: { code: "E_CONFIG", ... } }` — check Cloudflare Worker logs.
2. Identify missing variable from `error.details.missing[]`.
3. Set the variable via `wrangler secret put <NAME>` or update `wrangler.toml` and redeploy.
4. Do NOT deploy while any Required(Prod)=Yes variable is absent.

### Cloudflare Access Variables Missing (admin routes enabled)

1. This is a **BLOCK** condition. Do not proceed with deployment.
2. Verify the Cloudflare Access application exists for this Worker's admin routes.
3. Set `CF_ACCESS_TEAM_DOMAIN` via `wrangler secret put CF_ACCESS_TEAM_DOMAIN`.
4. Set `CF_ACCESS_AUD` via `wrangler secret put CF_ACCESS_AUD`.
5. Verify admin routes require a valid Cloudflare Access JWT before marking incident resolved.

Note: `ADMIN_ALLOWED_IPS` is no longer a BLOCK condition. It may be set as optional defense-in-depth, but its absence does not block deployment.

---

## 9. Deployment Prohibition Statement

> **Deployment to production is forbidden if any variable with `Required(Prod)=Yes` is absent or empty.**
>
> When admin routes are enabled, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are additionally normative per `docs/docs_ops_rules.md §6`. Their absence constitutes a specification violation independent of all other checks.
>
> No exception. No soft warning. BLOCK.
