# GATE0_8_DOCS_ALIGN_HOTEL_STATUS — Runlog

**Gate:** 0.8
**Date:** 2026-03-01
**Auditor:** Release Auditor / Environment Architect
**Scope:** Docs-only. No runtime logic modified. No secrets written.

---

## Objective

Align environment spec and ops rules with confirmed product reality:
- (A) Hotel flow is NOT LIFF — message-based only
- (B) Status view (状況把握) requirement defined
- (C) Traffic LIFF is a unified single endpoint
- (D) IP hard requirement remains removed (unchanged from Gate 0.7)

---

## Commands Executed (Read)

```
docs/ENVIRONMENT.md              (full read)
docs/ENVIRONMENT_PROMPT.md       (full read)
docs/docs_ops_rules.md           (full read)
docs/README.md                   (full read)
docs/v7_spec.md:145-165          (partial read — §8 LIFF Traffic Behavior)
```

Grep scans (read-only, no writes):
```
pattern: LIFF_HOTEL_URL          → docs/ENVIRONMENT.md:52,138,170; ENVIRONMENT_PROMPT.md:155
pattern: hotel.*liff|liff.*hotel → ENVIRONMENT_RUNBOOK.md:65,105; ENVIRONMENT_PROMPT.md:155 (pre-existing)
pattern: 状況把握|status view     → no matches in docs/
pattern: LIFF_TRAFFIC_URL        → ENVIRONMENT.md:50,138; action-contracts.md:58-59; v7_spec.md:151
pattern: traffic.*single|unified → no matches (policy newly defined here)
```

---

## Files Changed

| File | Why |
|---|---|
| `docs/ENVIRONMENT.md` | Gate bump 0.7→0.8; demote LIFF_HOTEL_URL; add §4.9/4.10/4.11; fix §4.7; fix §5 checklist |
| `docs/docs_ops_rules.md` | Expand §3 Hotel to full message-based contract; add §7 Status; add §8 Traffic LIFF |
| `docs/ENVIRONMENT_PROMPT.md` | Remove LIFF_HOTEL_URL from required list; add hotel consistency check to Strict Mode Rules; add deprecated section to Quick Reference |

**Not touched (out-of-scope):**
- `docs/ENVIRONMENT_RUNBOOK.md` — contains `LIFF_HOTEL_URL` references at lines 65 and 105; NOT in gate scope; to be addressed in a future runbook update gate
- `docs/runlogs/GATE0_5_ENVIRONMENT_SYSTEM.md`, `GATE0_6_ENV_AUDIT.md` — historical, immutable
- All `worker/`, `gas/`, `liff/`, `wrangler.toml`, `scripts/`, `tests/` — runtime, not touched

---

## Exact Rule Changes

### A. LIFF_HOTEL_URL — Required(Prod) change

**ENVIRONMENT.md §3.1 (line 52):**
```
BEFORE: Required(Prod) = Yes | Purpose: "LIFF URL for hotel intent (broadcast messages)"
AFTER:  Required(Prod) = No  | Purpose: "[DEPRECATED — hotel is message-based, no LIFF required] LIFF URL for hotel intent — variable retained in code; hotel flow operates via LINE push/broadcast with Yes/No button replies, not a LIFF page"
```

**ENVIRONMENT.md §4.7:**
```
BEFORE: "LIFF_URL acts as a general fallback when LIFF_TRAFFIC_URL, LIFF_EXPENSE_URL, or LIFF_HOTEL_URL are not set. [...] All four should be set in production for correct broadcast button behavior."
AFTER:  "LIFF_URL acts as a general fallback when LIFF_TRAFFIC_URL or LIFF_EXPENSE_URL are not set. [...] LIFF_HOTEL_URL is deprecated — hotel flow is message-based [...] See §4.9."
```

**ENVIRONMENT.md §5 Checklist:**
```
BEFORE: "- [ ] `LIFF_HOTEL_URL` — set, non-empty"
AFTER:  "- [ ] `LIFF_HOTEL_URL` — deprecated/optional; hotel flow is message-based; not required in production"
```

**ENVIRONMENT_PROMPT.md Quick Reference required list:**
```
BEFORE: listed LIFF_HOTEL_URL under Required(Prod)=Yes Worker variables
AFTER:  removed from required list; added to new "Deprecated" section
```

**ENVIRONMENT_PROMPT.md Strict Mode Rules:**
```
ADDED: "`LIFF_HOTEL_URL` is deprecated and not required. Its absence is NOT a BLOCK condition."
ADDED: "Hotel consistency check: If ENVIRONMENT.md §4.9 states hotel is message-based, the audit must NOT flag `LIFF_HOTEL_URL` absence as a violation."
```

---

### B. Hotel Operation Contract — NEW (docs_ops_rules.md §3 expanded)

§3 rewritten from a 4-bullet stub to a full normative contract with:
- §3.1: Confirmed hotel is NOT LIFF. Message push only, buttons (Yes/No/Cancel/Change).
- §3.2: State machine defined: `UNSET → YES | NO`, reversible, resets after period closes.
- §3.3: Audit requirements: last state + update history must be preserved.

---

### C. Status View — NEW (docs_ops_rules.md §7; ENVIRONMENT.md §4.10)

New normative requirement added:
- Must show 当月/前月 × 交通費/経費 = 4 data points
- Two supported modes: (A) LIFF status page or (B) LINE message command
- **REVIEW_REQUIRED**: implementation mode not verified against source code in this gate
- No new environment variable added until implementation gate confirms route and var name

---

### D. Traffic LIFF — NEW (docs_ops_rules.md §8; ENVIRONMENT.md §4.11)

New normative policy added:
- Traffic submission uses ONE LIFF endpoint regardless of OCR or manual input method
- `LIFF_TRAFFIC_URL` is the sole URL variable; no separate OCR URL
- Consistent with `v7_spec.md §8` (LIFF Traffic Behavior) and `action-contracts.md:58-59`

---

### E. Admin Route Protection — UNCHANGED

Gate 0.7 Cloudflare Access policy unchanged:
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`: conditional BLOCK (admin routes enabled)
- `ADMIN_ALLOWED_IPS`: optional, not required

---

## BLOCK Conditions After This Gate

| Condition | Status |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` absent AND admin routes enabled | **BLOCK** |
| `CF_ACCESS_AUD` absent AND admin routes enabled | **BLOCK** |
| `GAS_ENDPOINT` absent | **BLOCK** |
| `STAFF_TOKEN_FOR_GAS` absent | **BLOCK** |
| `LINE_CHANNEL_SECRET` absent | **BLOCK** |
| `LINE_CHANNEL_ACCESS_TOKEN` absent | **BLOCK** |
| `LIFF_ID` absent | **BLOCK** |
| `WORKER_API_KEY` absent | **BLOCK** |
| `ALLOWED_ORIGINS` absent or empty | **BLOCK** |
| `IDEMPOTENCY_KV` binding absent | **BLOCK** |
| `LIFF_HOTEL_URL` absent | **NOT A BLOCK** (deprecated) |
| `ADMIN_ALLOWED_IPS` absent | **NOT A BLOCK** (optional) |

---

## Variables Whose Required(Prod) Changed

| Variable | Before | After |
|---|---|---|
| `LIFF_HOTEL_URL` | `Yes` | `No` (deprecated) |

---

## Open Questions (REVIEW_REQUIRED)

1. **Status view implementation mode**: Neither LIFF nor message-command implementation verified in source. Implementation gate must read `worker/src/` to confirm which mode exists and add any required env var to ENVIRONMENT.md.

2. **LIFF_URL source reference `hotel.js:296,313`**: ENVIRONMENT.md §3.2 lists `LIFF_URL` as Required(Prod)=Yes with source including `hotel.js`. If hotel flow no longer uses LIFF, this code reference may become dead code. Verify in implementation gate whether `LIFF_URL` fallback in `hotel.js` can be removed or if it is still reachable via a non-hotel code path.

3. **ENVIRONMENT_RUNBOOK.md**: Lines 65 and 105 still reference `LIFF_HOTEL_URL` as a required secret to set. This runbook is out-of-scope for this gate; a future gate should update the runbook to remove `LIFF_HOTEL_URL` from setup instructions.

---

## Confirmations

- [x] No secret values written to any file.
- [x] No runtime files touched (`worker/`, `gas/`, `liff/`, `wrangler.toml`, `scripts/`, `tests/`).
- [x] No runtime logic modified.
- [x] `WORKER_API_KEY`, `LINE_ADMIN_USER_IDS`, and all other existing admin auth rules unchanged.
- [x] Cloudflare Access conditional BLOCK logic (Gate 0.7) preserved unchanged.
- [x] Internal consistency maintained: ENVIRONMENT.md §4.9/§3.1, ENVIRONMENT_PROMPT.md Strict Mode, docs_ops_rules.md §3 all agree hotel is message-based.
- [x] Gate version bumped: 0.7 → 0.8 in ENVIRONMENT.md header.
