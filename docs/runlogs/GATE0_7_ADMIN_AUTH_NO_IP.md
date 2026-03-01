# GATE0_7_ADMIN_AUTH_NO_IP — Runlog

**Gate:** 0.7
**Date:** 2026-03-01
**Auditor:** Release Auditor / Environment Architect
**Scope:** Docs-only. No runtime logic modified. No secrets written.

---

## Objective

Remove the hard BLOCK requirement on `ADMIN_ALLOWED_IPS` in production.
Replace it with a Cloudflare Access-based admin protection model.

---

## Commands Executed

```
# Read (no-op, audit only)
docs/ENVIRONMENT.md
docs/ENVIRONMENT_PROMPT.md
docs/docs_ops_rules.md
docs/runlogs/GATE0_6_ENV_AUDIT.md   # reviewed for prior gate state

# Files modified
docs/ENVIRONMENT.md
docs/ENVIRONMENT_PROMPT.md
docs/docs_ops_rules.md

# File created
docs/runlogs/GATE0_7_ADMIN_AUTH_NO_IP.md  (this file)
```

No `wrangler` commands. No `git` commands. No secret writes. No source file edits.

---

## Diff Summary

### docs/ENVIRONMENT.md

| Location | Change |
|---|---|
| Header | Gate: 0.5 → 0.7 |
| §1 Principle 6 | Replaced `ADMIN_ALLOWED_IPS` normative BLOCK statement with Cloudflare Access normative BLOCK statement (when admin routes enabled) |
| §3.1 `ADMIN_ALLOWED_IPS` row | `Required(Prod)`: `Yes (BLOCK)` → `No`; Purpose updated to "optional defense-in-depth" |
| §3.2 (new rows) | Added `CF_ACCESS_TEAM_DOMAIN` (secret, Conditional) and `CF_ACCESS_AUD` (secret, Conditional, sensitive) |
| §4 (new §4.8) | Added Cloudflare Access conditional rule: CF vars required when admin routes enabled; optional when routes disabled |
| §5 Checklist | `ADMIN_ALLOWED_IPS` entry: removed BLOCK annotation, marked optional; added two conditional entries for CF_ACCESS vars |
| §6 BLOCK table | Removed `ADMIN_ALLOWED_IPS absent` row; added `CF_ACCESS_TEAM_DOMAIN absent + admin routes enabled` and `CF_ACCESS_AUD absent + admin routes enabled` rows |
| §7 Rotation Policy | `ADMIN_ALLOWED_IPS` entry updated to "(optional; omit if not used)"; added `CF_ACCESS_AUD` rotation entry |
| §8 Incident Response | Replaced "ADMIN_ALLOWED_IPS Missing" section with "Cloudflare Access Variables Missing (admin routes enabled)" section |
| §9 Prohibition Statement | Replaced `ADMIN_ALLOWED_IPS` normative reference with `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` normative reference |

### docs/docs_ops_rules.md

| Location | Change |
|---|---|
| §6 title | "Admin IP Allowlist（必須設定）" → "Admin Route Protection（必須設定）" |
| §6.1 | Replaced IP allowlist mandate with Cloudflare Access mandate; conditional on admin routes being enabled |
| §6.2 Variable table | Added `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` as mandatory (when admin routes enabled); `ADMIN_ALLOWED_IPS` demoted to optional/推奨 |
| §6.3 Values | Updated to describe CF_ACCESS vars; `ADMIN_ALLOWED_IPS` listed as optional |
| §6.4 Pre-deploy checklist | Replaced IP check steps with CF_ACCESS check steps; `ADMIN_ALLOWED_IPS` noted as optional |
| §6.5 Responsibilities | Updated to cover CF_ACCESS management; `ADMIN_ALLOWED_IPS` remains as optional supplemental defense |
| §6.6 Risk summary | Replaced IP-absence risk with CF_ACCESS-absence risk |

### docs/ENVIRONMENT_PROMPT.md

| Location | Change |
|---|---|
| SECTION D Rule 2 | Replaced `ADMIN_ALLOWED_IPS absent → BLOCK` with `CF_ACCESS vars absent AND admin routes enabled → BLOCK` |
| Strict Mode Rules | Removed `ADMIN_ALLOWED_IPS must always be explicitly verified`; added CF_ACCESS verification rule and explicit note that `ADMIN_ALLOWED_IPS` absence is NOT a BLOCK |
| Quick Reference | Removed `ADMIN_ALLOWED_IPS` from required list; added `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` under conditional required section; added `ADMIN_ALLOWED_IPS` under optional section |

---

## Exact Rule Changes

### REMOVED BLOCK
```
ADMIN_ALLOWED_IPS absent or empty → BLOCK
Rationale: normative per docs_ops_rules.md §6; admin routes lack IP protection
```

### ADDED BLOCKS (conditional on admin routes being enabled)
```
CF_ACCESS_TEAM_DOMAIN absent AND admin routes enabled → BLOCK
Rationale: normative per docs_ops_rules.md §6; admin routes lack Cloudflare Access protection

CF_ACCESS_AUD absent AND admin routes enabled → BLOCK
Rationale: normative per docs_ops_rules.md §6; Cloudflare Access JWT audience verification impossible
```

### CHANGED STATUS
```
ADMIN_ALLOWED_IPS: Required(Prod)=Yes (BLOCK) → Required(Prod)=No (optional, defense-in-depth)
```

### NEW VARIABLES DEFINED
```
CF_ACCESS_TEAM_DOMAIN
  Type: secret
  Sensitive: No
  Required(Prod): Conditional (Yes when admin routes enabled)
  Required(Dev): No
  Source: docs_ops_rules.md §6 (code refs to be added in implementation gate)

CF_ACCESS_AUD
  Type: secret
  Sensitive: Yes
  Required(Prod): Conditional (Yes when admin routes enabled)
  Required(Dev): No
  Source: docs_ops_rules.md §6 (code refs to be added in implementation gate)
```

### CONDITIONAL DEPENDENCY (§4.8)
```
IF admin routes are enabled (registered in router):
  CF_ACCESS_TEAM_DOMAIN → Required(Prod)=Yes (BLOCK)
  CF_ACCESS_AUD         → Required(Prod)=Yes (BLOCK)
  ADMIN_ALLOWED_IPS     → Optional (defense-in-depth)

IF admin routes are disabled (not registered in router):
  CF_ACCESS_TEAM_DOMAIN → Conditional/No
  CF_ACCESS_AUD         → Conditional/No
  ADMIN_ALLOWED_IPS     → Optional
```

---

## Rationale

The prior model required a fixed IPv4 allowlist (`ADMIN_ALLOWED_IPS`) as the normative BLOCK condition for admin routes. This is brittle because:

1. Dynamic or cloud-NAT environments do not have stable egress IPs.
2. Cloudflare Access provides identity-based (SSO) protection independent of IP, with JWT attestation that can be cryptographically verified.
3. IP allowlisting becomes defense-in-depth rather than a primary control.

The new model:
- Makes `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` the normative BLOCK condition when admin routes are enabled.
- Preserves `ADMIN_ALLOWED_IPS` as an optional layered control.
- Maintains all existing `WORKER_API_KEY` and `LINE_ADMIN_USER_IDS` admin auth rules unchanged.
- Does not touch any runtime code — policy change only.

---

## Consistency Check

| Document | Consistent with new policy? |
|---|---|
| `docs/ENVIRONMENT.md` §1, §3.1, §3.2, §4.8, §5, §6, §7, §8, §9 | Yes |
| `docs/docs_ops_rules.md` §6 | Yes |
| `docs/ENVIRONMENT_PROMPT.md` SECTION D, Strict Mode, Quick Reference | Yes |

---

## Confirmations

- [ ] No secret values written to any file.
- [ ] No runtime logic (`worker/src/**`) modified.
- [ ] No `wrangler.toml` modified (CF_ACCESS vars are secrets; no placeholder entry needed until implementation gate).
- [ ] `WORKER_API_KEY` and existing admin auth rules are unchanged.
- [ ] Internal consistency maintained across all three updated documents.
- [ ] Gate version bumped: 0.5 → 0.7 in ENVIRONMENT.md header.
