# Runlog: Gate 0.6 — Environment Audit

**Date**: 2026-03-01
**Gate**: 0.6
**Auditor**: Claude (release auditor)
**Instruction source**: `docs/ENVIRONMENT_PROMPT.md` (strict mode)
**Spec source**: `docs/ENVIRONMENT.md`

---

## Commands Executed

1. Read `docs/ENVIRONMENT.md` — extracted SPEC_REQUIRED_PROD, SPEC_BLOCK_CONDITIONS, SPEC_CONDITIONAL_RULES
2. Read `worker/wrangler.toml` — inspected all `[vars]` values, binding declarations
3. Read `worker/.dev.vars.example` — confirmed template completeness
4. Read `worker/src/router.js:26-65` — confirmed active route registrations (ROUTE_METHODS)
5. Read `worker/src/lib/env.js` — confirmed ROUTE_ENV_REQUIREMENTS and SCHEDULED_ENV_REQUIREMENTS
6. Read `worker/src/handlers/webhook.js:185-208` — confirmed LIFF_REGISTER_URL graceful degradation path
7. Read `worker/src/lib/broadcastMessage.js:14-16` (via prior grep) — confirmed LIFF_TRAFFIC/EXPENSE/HOTEL_URL fallback
8. Read `worker/src/clients/gemini.js:11,26` (via prior grep) — confirmed GEMINI_API_KEY hard dependency
9. Read `worker/src/handlers/slack.js:21,37,82` (via prior grep) — confirmed SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN dependencies
10. Cross-referenced `docs/docs_ops_rules.md §6` — confirmed ADMIN_ALLOWED_IPS normative status

---

## STEP 1 — SPEC_REQUIRED_PROD extracted from ENVIRONMENT.md

The following variables have `Required(Prod)=Yes`:

**[vars] / wrangler.toml (observable)**
- `ALLOWED_ORIGINS`
- `ADMIN_ALLOWED_IPS` (+ normative BLOCK per ops_rules §6)
- `LIFF_REGISTER_URL`
- `LIFF_TRAFFIC_URL`
- `LIFF_EXPENSE_URL`
- `LIFF_HOTEL_URL`

**Secrets (via `wrangler secret put`, NOT observable from repository)**
- `GAS_ENDPOINT`
- `STAFF_TOKEN_FOR_GAS`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LIFF_ID`
- `LIFF_URL`
- `WORKER_API_KEY`
- `LINE_ADMIN_USER_IDS`

**Bindings (wrangler.toml, observable)**
- `IDEMPOTENCY_KV`
- `IDEMPOTENCY_LOCK`

**GAS Script Properties (not observable from repository)**
- `SPREADSHEET_ID`
- `STAFF_TOKEN`

---

## STEP 2 — Repository State (observable values only)

### wrangler.toml [vars] — observed values

| Variable | Value in wrangler.toml | State |
|---|---|---|
| `ALLOWED_ORIGINS` | `"https://traffic-worker-v0.kaitomoga0316.workers.dev,https://liff.line.me"` | **SET** |
| `IDEMPOTENCY_TTL_SECONDS` | `"86400"` | SET (optional) |
| `WEBHOOK_EVENT_TTL_SECONDS` | `"86400"` | SET (optional) |
| `ADMIN_ALLOWED_IPS` | `""` | **EMPTY** |
| `LIFF_REGISTER_URL` | `""` | **EMPTY** |
| `LINE_RICHMENU_ID_UNREGISTERED` | `""` | empty (Conditional) |
| `LINE_RICHMENU_ID_REGISTERED` | `""` | empty (Conditional) |
| `SLACK_SIGNING_SECRET` | `""` | **EMPTY** (+ wrong section, see §B) |
| `SLACK_BOT_TOKEN` | `""` | **EMPTY** (+ wrong section, see §B) |
| `LIFF_TRAFFIC_URL` | `""` | **EMPTY** |
| `LIFF_EXPENSE_URL` | `""` | **EMPTY** |
| `LIFF_HOTEL_URL` | `""` | **EMPTY** |

### wrangler.toml bindings — observed

| Binding | Present | Detail |
|---|---|---|
| `IDEMPOTENCY_KV` | **YES** | id=`36c930ac6ddb4676a648a997a71945fa`, preview_id set |
| `IDEMPOTENCY_LOCK` | **YES** | class `IdempotencyLockDurableObject`, migration tag `v1` present |

### Secrets — NOT observable from repository

The following Required(Prod)=Yes variables are set via `wrangler secret put` and **cannot be confirmed present or absent from static repository analysis**:
`GAS_ENDPOINT`, `STAFF_TOKEN_FOR_GAS`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LIFF_ID`, `LIFF_URL`, `WORKER_API_KEY`, `LINE_ADMIN_USER_IDS`

These require `npx wrangler secret list` for verification. **Not confirmed. Must be verified separately.**

### Active routes (router.js ROUTE_METHODS)

The following conditional-trigger routes are **registered and active** in the Worker:
- OCR routes: `POST /api/ocr/extract`, `POST /api/traffic/ocr-auto`, `POST /api/hotel/screenshot/process`
- Slack routes: `POST /api/slack/command`, `POST /api/slack/events`, `POST /api/slack/interactive`, `POST /api/admin/broadcast/*`

---

## SECTION A: Missing

Variables referenced in source but absent from `docs/ENVIRONMENT.md`.

**Source scan result**: All 37 variables found in `worker/src/**/*.js` and `gas/コード.js` are documented in ENVIRONMENT.md.

**Anomaly (not a spec miss, but flagged)**:
`WORKER_URL` is present in `worker/.dev.vars` (line 7) but:
- Is NOT referenced as `env.WORKER_URL` in any `worker/src/**/*.js`
- Is NOT documented in `ENVIRONMENT.md`
- Is NOT in `worker/.dev.vars.example`

This is a dead local configuration entry, not a code-referenced variable. It does not constitute a Missing spec item. No action required in ENVIRONMENT.md, but the entry in `.dev.vars` should be cleaned up to avoid confusion.

```
ANOMALY: WORKER_URL
  Source: worker/.dev.vars:7
  Status: Not referenced in worker source; not a code env variable
  Action: Remove from .dev.vars (cleanup only; no ENVIRONMENT.md change needed)
```

**SECTION A: No spec misses. One anomaly noted above.**

---

## SECTION B: Invalid

Variables in `ENVIRONMENT.md` where classification is inconsistent with source evidence.

---

**INVALID-1: `LIFF_URL`**

```
INVALID: LIFF_URL
  Spec says: Required(Prod)=Yes
  Evidence: Code handles absence gracefully — no E_CONFIG, no 500
    webhook.js:329-330 — returns user-facing "LIFF_URL が未設定です" text message
    hotel.js:296,313 — same graceful pattern
    reminder.js:165,208 — same graceful pattern
  Inconsistency: ENVIRONMENT.md Principle §3 states "Missing required variables cause
    explicit, logged failures." LIFF_URL's absence causes no failure, only degraded UX.
  Action: Either (a) downgrade to Required(Prod)=Conditional with an ops-level note,
    OR (b) add explicit E_CONFIG enforcement in source to match the Required=Yes
    designation. Resolve this inconsistency before next deploy gate.
```

**INVALID-2: `LIFF_REGISTER_URL`**

```
INVALID: LIFF_REGISTER_URL
  Spec says: Required(Prod)=Yes
  Evidence: Code handles absence gracefully — no E_CONFIG, no 500
    liff.js:24-28 — renders fallback HTML "LIFF_REGISTER_URL が未設定です"
    webhook.js:185 — falls back to env.LIFF_URL, then empty string, with text fallback
  Inconsistency: Same as LIFF_URL above — graceful degradation contradicts Required=Yes
    plus Principle §3.
  Action: Same as LIFF_URL — align spec or enforce in code.
```

**INVALID-3: `LIFF_TRAFFIC_URL`, `LIFF_EXPENSE_URL`, `LIFF_HOTEL_URL`**

```
INVALID: LIFF_TRAFFIC_URL, LIFF_EXPENSE_URL, LIFF_HOTEL_URL
  Spec says: Required(Prod)=Yes
  Evidence: broadcastMessage.js:14-16 — each falls back to env.LIFF_URL if absent.
    If LIFF_URL is also absent, sanitizeBroadcastUrl() receives empty string.
    Broadcast Flex Message buttons render with empty/null action URL.
    No E_CONFIG raised. Silent functional failure (broken buttons).
  Inconsistency: Not an explicit 500 failure as Principle §3 implies.
    However, the silent functional failure (broken broadcast buttons) is a genuine
    production defect. Required(Prod)=Yes is operationally correct.
  Action: Preferred resolution — add presence check in broadcastMessage.js or
    broadcast handler and return E_CONFIG if any LIFF URL is empty. This would
    align code behavior with the Required=Yes designation.
    Until resolved: classification is OVERSTATED relative to code enforcement.
```

**INVALID-4: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` placement**

```
INVALID (configuration placement): SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
  Spec says: Type=secret; note: "currently listed as [vars]; MUST be migrated"
  Evidence: wrangler.toml:14-15 — both listed under [vars] with empty values.
    Values in [vars] are visible in plaintext in the committed wrangler.toml file.
    While current values are empty (so no secret is exposed), the [vars] section
    is the wrong mechanism for secrets.
  ENVIRONMENT.md status: Already explicitly documented as a known issue.
  Inconsistency: The note in §3.1 acknowledges this but does not constitute a fix.
    This is a live misconfiguration. A future operator might accidentally set a real
    value under [vars], committing a secret.
  Action: Remove SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN entries from wrangler.toml
    [vars]. Set exclusively via `wrangler secret put` when Slack integration is activated.
    This is a wrangler.toml change (no code change required).
```

---

## SECTION C: Conditional Violations

Conditional variables whose conditions are MET in the current deployment configuration.

---

**CONDITIONAL_VIOLATION-1: `GEMINI_API_KEY`**

```
CONDITIONAL_VIOLATION: GEMINI_API_KEY
  Condition (ENVIRONMENT.md §4.1): Required if OCR routes in use
  Evidence of condition: router.js registers the following OCR routes as active:
    - POST /api/ocr/extract (line 41)
    - POST /api/traffic/ocr-auto (line 36)
    - POST /api/hotel/screenshot/process (line 38)
  Status: Condition IS MET — OCR routes are wired and callable
  Current value: UNVERIFIABLE from repository (set via wrangler secret put)
  Action: Treat as Required(Prod)=Yes for this deployment.
    Verify: npx wrangler secret list | grep GEMINI_API_KEY
    If absent → BLOCK.
```

**CONDITIONAL_VIOLATION-2: `SLACK_SIGNING_SECRET`**

```
CONDITIONAL_VIOLATION: SLACK_SIGNING_SECRET
  Condition (ENVIRONMENT.md §4.2): Required if Slack routes in use
  Evidence of condition: router.js registers the following Slack routes as active:
    - POST /api/slack/command (line 48)
    - POST /api/slack/events (line 49)
    - POST /api/slack/interactive (line 50)
    - POST /api/admin/broadcast/preview (line 45)
    - POST /api/admin/broadcast/send (line 46)
    - POST /api/admin/broadcast/retry-failed (line 47)
  Status: Condition IS MET — Slack routes are wired and callable
  Current value: "" (empty) in wrangler.toml [vars]. Not set via [vars].
    Whether set via wrangler secret: UNVERIFIABLE from repository.
  Action: Treat as Required(Prod)=Yes for this deployment.
    Verify: npx wrangler secret list | grep SLACK_SIGNING_SECRET
    If absent (not in secrets either) → BLOCK.
```

**CONDITIONAL_VIOLATION-3: `SLACK_BOT_TOKEN`**

```
CONDITIONAL_VIOLATION: SLACK_BOT_TOKEN
  Condition (ENVIRONMENT.md §4.2): Required if Slack routes in use (same as above)
  Status: Condition IS MET (same Slack routes active)
  Current value: "" (empty) in wrangler.toml [vars]. Not set via [vars].
    Whether set via wrangler secret: UNVERIFIABLE from repository.
  Action: Treat as Required(Prod)=Yes for this deployment.
    Verify: npx wrangler secret list | grep SLACK_BOT_TOKEN
    If absent → BLOCK.
```

---

## SECTION D: Final Gate Decision

### Observable BLOCKs (confirmed from repository state)

| # | Variable | Evidence | Condition |
|---|---|---|---|
| 1 | `ADMIN_ALLOWED_IPS` | `wrangler.toml:10` = `""` | ops_rules §6 normative BLOCK |
| 2 | `LIFF_REGISTER_URL` | `wrangler.toml:11` = `""` | Required(Prod)=Yes, empty |
| 3 | `LIFF_TRAFFIC_URL` | `wrangler.toml:16` = `""` | Required(Prod)=Yes, empty |
| 4 | `LIFF_EXPENSE_URL` | `wrangler.toml:17` = `""` | Required(Prod)=Yes, empty |
| 5 | `LIFF_HOTEL_URL` | `wrangler.toml:18` = `""` | Required(Prod)=Yes, empty |

### Conditional BLOCKs (condition met; value unverifiable from repository)

| # | Variable | Condition status | Block if absent |
|---|---|---|---|
| 6 | `GEMINI_API_KEY` | OCR routes active → Required(Prod)=Yes | YES |
| 7 | `SLACK_SIGNING_SECRET` | Slack routes active → Required(Prod)=Yes | YES |
| 8 | `SLACK_BOT_TOKEN` | Slack routes active → Required(Prod)=Yes | YES |

### Unverifiable secrets (require `wrangler secret list`)

Cannot confirm present or absent from repository state alone. Must be verified before deploy:
`GAS_ENDPOINT`, `STAFF_TOKEN_FOR_GAS`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LIFF_ID`, `LIFF_URL`, `WORKER_API_KEY`, `LINE_ADMIN_USER_IDS`

GAS Script Properties (`SPREADSHEET_ID`, `STAFF_TOKEN`) are also unverifiable from repository.

### Decision

```
DECISION: BLOCK
REASON: ADMIN_ALLOWED_IPS is empty in wrangler.toml (ops_rules §6 normative BLOCK);
  additionally LIFF_REGISTER_URL, LIFF_TRAFFIC_URL, LIFF_EXPENSE_URL, LIFF_HOTEL_URL
  are all empty in wrangler.toml (Required(Prod)=Yes). Five confirmed BLOCKs from
  observable repository state alone. Conditional violations for GEMINI_API_KEY,
  SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN are unverifiable and would be additional
  BLOCKs if unset.
BLOCKING_VARS: ADMIN_ALLOWED_IPS, LIFF_REGISTER_URL, LIFF_TRAFFIC_URL,
  LIFF_EXPENSE_URL, LIFF_HOTEL_URL
UNVERIFIED_POTENTIAL_BLOCKS: GEMINI_API_KEY, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN,
  GAS_ENDPOINT, STAFF_TOKEN_FOR_GAS, LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN,
  LIFF_ID, LIFF_URL, WORKER_API_KEY, LINE_ADMIN_USER_IDS
```

---

## Required Actions to Unblock

Listed in priority order:

1. **[BLOCK-1 — CRITICAL]** Set `ADMIN_ALLOWED_IPS` to a non-empty IPv4 list in `wrangler.toml [vars]` and redeploy.
2. **[BLOCK-2/3/4/5]** Set `LIFF_REGISTER_URL`, `LIFF_TRAFFIC_URL`, `LIFF_EXPENSE_URL`, `LIFF_HOTEL_URL` in `wrangler.toml [vars]` (or via `wrangler secret put` if preferred) with real LIFF URLs.
3. **[CONDITIONAL-BLOCK-6/7/8]** Run `npx wrangler secret list` and confirm `GEMINI_API_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` are present. If absent, set via `wrangler secret put`.
4. **[UNVERIFIED]** Run `npx wrangler secret list` and confirm all 8 unverified secrets are present.
5. **[SECTION B cleanup]** Remove `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` from `wrangler.toml [vars]`; set exclusively via `wrangler secret put`.
6. **[SECTION B spec]** Resolve LIFF_URL / LIFF_REGISTER_URL / LIFF_TRAFFIC_URL / LIFF_EXPENSE_URL / LIFF_HOTEL_URL inconsistency: either enforce E_CONFIG in code or downgrade classification to Conditional with an ops note.

---

## Secrets Written to Files

**None.** No secret values were read, reproduced, or written during this audit.

---

**Gate 0.6: BLOCK**
