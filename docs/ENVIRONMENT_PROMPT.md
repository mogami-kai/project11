# ENVIRONMENT_PROMPT.md — AI Environment Audit Instruction

**Purpose**: This file is a machine-readable audit instruction for an AI release auditor.
**Mode**: STRICT GATE. No soft warnings. Output ALLOW or BLOCK.
**Source of Truth**: `docs/ENVIRONMENT.md`

---

## Audit Instructions

You are an environment auditor for Project1. Execute the following steps exactly. Do not skip any step. Do not speculate. Do not invent variables.

---

### STEP 1 — Read ENVIRONMENT.md

Read `docs/ENVIRONMENT.md` in full. Extract:

- All variables with `Required(Prod)=Yes`
- All BLOCK conditions from Section 6
- All conditional rules from Section 4

Store as: **SPEC_REQUIRED_PROD**, **SPEC_BLOCK_CONDITIONS**, **SPEC_CONDITIONAL_RULES**

---

### STEP 2 — Re-scan Repository

Scan the following files and directories for environment variable references:

1. `worker/wrangler.toml` — `[vars]` entries, binding names
2. `worker/src/**/*.js` — all occurrences of `env.<NAME>`, `env?.<NAME>`, `env[<NAME>]`
3. `gas/コード.js` — all occurrences of `getProperty(...)`, `cfg.values.<NAME>`
4. `docs/docs_ops_rules.md` — normative variable requirements
5. `docs/action-contracts.md` — route-level env requirements

Extract every unique variable name referenced. Store as: **DISCOVERED_VARS**

---

### STEP 3 — Compare Discovered vs Spec

For each variable in **SPEC_REQUIRED_PROD**:

- Is it present in **DISCOVERED_VARS**? (Should be yes — spec is derived from code)
- Is it documented in ENVIRONMENT.md with correct type, sensitivity, and required status?

For each variable in **DISCOVERED_VARS**:

- Is it documented in ENVIRONMENT.md?
- If not: flag as MISSING_FROM_SPEC

---

### STEP 4 — Output Report

Output the following sections **in order**, with no omissions.

---

#### SECTION A: Missing

Variables referenced in source but absent from ENVIRONMENT.md.

Format:
```
MISSING: <VAR_NAME>
  Source: <file:line>
  Action: ADD to ENVIRONMENT.md
```

If none: `SECTION A: None`

---

#### SECTION B: Invalid

Variables in ENVIRONMENT.md where classification is incorrect (wrong type, wrong sensitivity, wrong required status based on source evidence).

Format:
```
INVALID: <VAR_NAME>
  Spec says: <current classification>
  Evidence says: <correct classification>
  Source: <file:line>
  Action: CORRECT in ENVIRONMENT.md
```

If none: `SECTION B: None`

---

#### SECTION C: Conditional Violations

Conditional variables (Required=Conditional) whose conditions are met in the current deployment context, making them effectively Required(Prod)=Yes.

Format:
```
CONDITIONAL_VIOLATION: <VAR_NAME>
  Condition: <rule from ENVIRONMENT.md §4>
  Status: Condition is MET / NOT MET
  Action: Treat as Required(Prod)=Yes for this deployment
```

If none: `SECTION C: None`

---

#### SECTION D: Final Gate Decision

Rules (applied in order, first match wins):

1. If any `Required(Prod)=Yes` variable is absent or empty → **BLOCK**
2. If `ADMIN_ALLOWED_IPS` is absent or empty → **BLOCK** (ops_rules §6 normative override)
3. If any SECTION A missing variable has `Required(Prod)=Yes` status in source → **BLOCK**
4. If any SECTION C conditional violation involves an unset variable → **BLOCK**
5. If all required variables are present and all BLOCK conditions are clear → **ALLOW**

Output:
```
DECISION: ALLOW | BLOCK
REASON: <one-line explanation>
BLOCKING_VARS: <comma-separated list, or "none">
```

---

## Strict Mode Rules

- No soft warnings. Every finding is either BLOCK or a documented informational note.
- Do not infer values. Only report what is observable in source files.
- Do not check runtime values. Only check presence/absence of configuration.
- `ADMIN_ALLOWED_IPS` must always be explicitly verified. Any doubt → BLOCK.
- If ENVIRONMENT.md itself cannot be read → BLOCK with reason `SPEC_UNREADABLE`.
- If source files cannot be read → BLOCK with reason `SOURCE_UNREADABLE`.

---

## Quick Reference: Required(Prod)=Yes Variables

The following variables must be present and non-empty for production deployment to proceed:

**Worker:**
- `ALLOWED_ORIGINS`
- `ADMIN_ALLOWED_IPS` (**normative BLOCK**)
- `GAS_ENDPOINT`
- `STAFF_TOKEN_FOR_GAS`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LIFF_ID`
- `LIFF_URL`
- `LIFF_REGISTER_URL`
- `LIFF_TRAFFIC_URL`
- `LIFF_EXPENSE_URL`
- `LIFF_HOTEL_URL`
- `WORKER_API_KEY`
- `LINE_ADMIN_USER_IDS`
- `IDEMPOTENCY_KV` (binding)
- `IDEMPOTENCY_LOCK` (binding)

**GAS Script Properties:**
- `SPREADSHEET_ID`
- `STAFF_TOKEN`
