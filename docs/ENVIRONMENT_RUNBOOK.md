# ENVIRONMENT_RUNBOOK.md — Project1 Environment Operations

**Audience: Operators, developers setting up local or production environments.**
**Source of Truth: [ENVIRONMENT.md](./ENVIRONMENT.md)**

---

## 1. Local Setup

### 1.1 Prerequisites

- `node` / `npm` installed
- `wrangler` CLI available (`npx wrangler` or global install)
- Access to LINE Developer Console, GAS deployment URL, Google Cloud Console (if needed)

### 1.2 Create .dev.vars

The file `worker/.dev.vars` is **git-ignored**. Copy the example and fill in values:

```sh
cp worker/.dev.vars.example worker/.dev.vars
```

Edit `worker/.dev.vars` and set all values. See Section 2 for rules.

### 1.3 Start local dev server

```sh
cd worker
npx wrangler dev
```

Wrangler reads `worker/.dev.vars` automatically for local secrets.

---

## 2. .dev.vars Usage Rules

- `worker/.dev.vars` is listed in `.gitignore`. **Never commit it.**
- `worker/.dev.vars.example` is committed and contains only empty values with comments.
- Every variable listed in `.dev.vars.example` is a candidate for `.dev.vars`.
- For local dev, `ADMIN_ALLOWED_IPS` may be left empty (admin routes become gated differently — see ENVIRONMENT.md §4 note).
- Do NOT copy production secret values into `.dev.vars` unless operating in an isolated environment you control.

---

## 3. Setting Worker Secrets via wrangler

Run each command and enter the value when prompted. Do not pass values on the command line.

```sh
# Core secrets — required in all environments
npx wrangler secret put GAS_ENDPOINT
npx wrangler secret put STAFF_TOKEN_FOR_GAS
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LIFF_ID
npx wrangler secret put WORKER_API_KEY

# LINE LIFF URLs (may be set as [vars] or secrets)
npx wrangler secret put LIFF_URL
npx wrangler secret put LIFF_REGISTER_URL
npx wrangler secret put LIFF_TRAFFIC_URL
npx wrangler secret put LIFF_EXPENSE_URL
npx wrangler secret put LIFF_HOTEL_URL

# Slack integration (required if Slack routes are used)
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN

# OCR (required if Gemini OCR routes are used)
npx wrangler secret put GEMINI_API_KEY

# Admin user list
npx wrangler secret put LINE_ADMIN_USER_IDS

# Google Sheets/Drive direct access (conditional)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_SPREADSHEET_ID
npx wrangler secret put GOOGLE_DRIVE_EXPORT_FOLDER_ID

# Receipt storage (conditional)
npx wrangler secret put RECEIPT_PUBLIC_BASE_URL
```

After setting secrets, verify with:

```sh
npx wrangler secret list
```

---

## 4. Cloudflare Dashboard Instructions

### 4.1 Set [vars] (non-secrets)

1. Go to Cloudflare Dashboard → Workers & Pages → `traffic-worker-v0` → Settings → Variables.
2. Under "Environment Variables", add or update:
   - `ALLOWED_ORIGINS` — comma-separated HTTPS URLs
   - `ADMIN_ALLOWED_IPS` — comma-separated IPv4 addresses (**required**)
   - `IDEMPOTENCY_TTL_SECONDS` — integer seconds (optional, default 86400)
   - `WEBHOOK_EVENT_TTL_SECONDS` — integer seconds (optional, default 86400)
   - `LIFF_REGISTER_URL`, `LIFF_TRAFFIC_URL`, `LIFF_EXPENSE_URL`, `LIFF_HOTEL_URL`
   - `LINE_RICHMENU_ID_UNREGISTERED`, `LINE_RICHMENU_ID_REGISTERED`
3. Save and re-deploy.

### 4.2 Set Secrets via Dashboard

1. Go to Workers & Pages → `traffic-worker-v0` → Settings → Variables.
2. Under "Encrypted Variables (Secrets)", add each secret listed in Section 3.
3. Encrypted values are never visible after save.

### 4.3 Verify KV Namespace

1. Go to Workers & Pages → KV.
2. Confirm namespace with ID `36c930ac6ddb4676a648a997a71945fa` (production) and `8f69a945fcc6486e871c150a923dde47` (preview) exists.
3. If not: create namespace, update `wrangler.toml [[kv_namespaces]]` `id` and `preview_id`, redeploy.

### 4.4 Verify Durable Objects

1. Go to Workers & Pages → Durable Objects.
2. Confirm `IdempotencyLockDurableObject` class is registered for `traffic-worker-v0`.
3. Migration tag `v1` must be applied (wrangler handles this on deploy).

---

## 5. GAS Script Properties Setup

1. Open the GAS project in script.google.com.
2. Go to **Project Settings** → **Script Properties**.
3. Add the following properties:

| Property key | Value |
|---|---|
| `SPREADSHEET_ID` | Google Spreadsheet ID (the long alphanumeric ID from the sheet URL) |
| `STAFF_TOKEN` | Same value as Worker's `STAFF_TOKEN_FOR_GAS` |
| `SP_SHIFT_SOURCE_MODE` | (optional) behavior flag |
| `SEND_GUARD_SENDING_TTL_SECONDS` | (optional) integer seconds |

4. After setting, redeploy the GAS Web App: **Deploy** → **Manage deployments** → update deployment.
5. Copy the new deployment URL if changed and update `GAS_ENDPOINT` in the Worker.

**Critical**: `STAFF_TOKEN` in GAS must match `STAFF_TOKEN_FOR_GAS` in the Worker exactly. A mismatch causes `E_UNAUTHORIZED` from GAS on all API calls.

---

## 6. Pre-Deploy Validation

Run these checks before every production deployment:

### 6.1 Verify secrets are set

```sh
cd worker
npx wrangler secret list
```

Confirm all required secrets from ENVIRONMENT.md §5 appear in the list.

### 6.2 Check [vars] in wrangler.toml

Confirm `ADMIN_ALLOWED_IPS` is non-empty in `wrangler.toml` before deploying:

```sh
grep 'ADMIN_ALLOWED_IPS' worker/wrangler.toml
```

Output must show a non-empty value. If empty → **STOP. Do not deploy.**

### 6.3 Smoke test after deploy

After deploying, run:

```sh
# Health check
curl https://<worker-url>/api/health

# Env debug (requires WORKER_API_KEY)
curl -H "x-api-key: <WORKER_API_KEY>" https://<worker-url>/api/_debug/env
```

Confirm all `present.*` fields in the debug response are `true` for required variables.

### 6.4 GAS reachability check

```sh
curl -H "x-api-key: <WORKER_API_KEY>" "https://<worker-url>/api/_debug/gas"
```

Confirm `reachable: true` and `gasEndpointIsUrl: true`.

---

## 7. Runlogs Recording Procedure

After each environment change or deployment gate:

1. Create a file in `docs/runlogs/` named `<GATE_OR_DATE>_<DESCRIPTION>.md`.
2. Record:
   - Date and operator
   - Variables changed (names only, no values)
   - Commands executed (names only)
   - Confirmation that no secrets were written to files
   - Result (PASS / BLOCK)
3. Commit the runlog file.

Template:

```md
# Runlog: <description>
Date: YYYY-MM-DD
Operator: <name>

## Changes
- Set `<VAR_NAME>` via wrangler secret put
- Updated `ADMIN_ALLOWED_IPS` in wrangler.toml

## Commands
- wrangler secret put <VAR_NAME>
- wrangler deploy

## Secrets written to files
None.

## Result
PASS / BLOCK — reason
```
