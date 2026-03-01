# GATE0_9_CF_ACCESS_ADMIN_PROTECTION — Runlog

**Gate:** 0.9
**Date:** 2026-03-01
**Scope:** Runtime implementation — admin route protection via Cloudflare Access JWT

---

## Objective

Implement the admin protection policy decided in Gate0.7 docs:
- Cloudflare Access JWT → primary protection for `/api/admin/*` routes
- ADMIN_ALLOWED_IPS → optional defense-in-depth (no longer required)
- Zero impact on public/user routes

---

## Commands Executed

```bash
# Read (verification before any edit)
git status --short
bash scripts/check-syntax.sh
grep -rn "requireIpAllow|isAdminIpAllowed" worker/src/

# Files read:
#   worker/src/lib/access.js
#   worker/src/lib/env.js
#   worker/src/handlers/hotel.js
#   worker/src/handlers/admin.js
#   worker/src/handlers/reminder.js
#   worker/src/router.js

# Syntax check after implementation
bash scripts/check-syntax.sh   → Checked: 44 files, Errors: 0

# Verify diff
git diff --stat
git diff
```

---

## Files Changed

| File | Change type | Summary |
|---|---|---|
| `worker/src/lib/access.js` | Addition | `requireCfAccessJwt` export + private JWKS helpers |
| `worker/src/lib/env.js` | Addition | `/api/admin/*` → `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` required |
| `worker/src/router.js` | Addition | Import + CF Access JWT gate for `/api/admin/` paths |
| `worker/src/handlers/hotel.js` | Removal | `{ requireIpAllow: true }` → `requireAdmin(request, env, meta)` |
| `worker/src/handlers/reminder.js` | Removal | Same as hotel.js |
| `worker/src/handlers/admin.js` | Fix | Local `isAdminIpAllowed`: `empty → false` changed to `empty → true` |

---

## New Environment Variables and Conditions

| Variable | Required when | Effect if missing |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `/api/admin/*` request received | `E_CONFIG` 500 (env validation, before routing) |
| `CF_ACCESS_AUD` | `/api/admin/*` request received | `E_CONFIG` 500 (env validation, before routing) |

---

## Behavior Change: Before → After

### A. `/api/admin/*` routes (broadcast, shift/raw/recent)

| | Before Gate0.9 | After Gate0.9 |
|---|---|---|
| Primary protection | x-api-key (WORKER_API_KEY) | x-api-key + CF Access JWT |
| CF Access JWT absent | allowed through | **401 E_UNAUTHORIZED** |
| CF Access JWT invalid sig | allowed through | **401 E_UNAUTHORIZED** |
| CF Access JWT aud mismatch | allowed through | **403 E_FORBIDDEN** |
| CF_ACCESS_* env vars missing | not checked | **500 E_CONFIG** |

### B. `/api/hotel/push` and `/api/reminder/push` (non-admin prefix)

| | Before Gate0.9 | After Gate0.9 |
|---|---|---|
| IP check | `requireIpAllow: true` (hard block if no ADMIN_ALLOWED_IPS) | **Removed** — API key only |
| ADMIN_ALLOWED_IPS empty | 403 E_FORBIDDEN for ALL requests | allowed (CF Access not applicable here) |
| CF Access JWT | not checked | not checked (non-admin prefix) |

### C. `/api/admin/shift/raw/recent` (local isAdminIpAllowed in admin.js)

| | Before Gate0.9 | After Gate0.9 |
|---|---|---|
| ADMIN_ALLOWED_IPS empty | 403 E_FORBIDDEN for ALL requests | allowed (CF Access is primary; IP is optional) |
| ADMIN_ALLOWED_IPS set | IP check enforced | IP check enforced (retained as defense-in-depth) |

---

## CF Access JWT Verification Logic

Implemented in `worker/src/lib/access.js` — `requireCfAccessJwt(request, env, meta)`:

1. Extract `CF-Access-Jwt-Assertion` header → absent → 401
2. Split JWT into header.payload.signature (3 parts) → malformed → 401
3. base64url decode header + payload
4. Check `payload.exp >= now` → expired → 401
5. Check `payload.aud` contains `env.CF_ACCESS_AUD` (string or array) → mismatch → 403
6. Check `header.alg === 'RS256'` → other alg → 401
7. Fetch JWKS from `https://{CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`
   - Module-scope cache: 5-minute TTL (avoids repeated fetches per isolate)
8. Select key by `header.kid` (fallback: first key)
9. `crypto.subtle.importKey('jwk', ...)` + `crypto.subtle.verify('RSASSA-PKCS1-v1_5', ...)` (WebCrypto, no deps)
10. Signature invalid → 401; valid → `{ ok: true }`

---

## Error Codes

| Condition | Code | HTTP |
|---|---|---|
| CF_ACCESS_* env missing | `E_CONFIG` | 500 |
| JWT header absent | `E_UNAUTHORIZED` | 401 |
| JWT format/parse/sig error | `E_UNAUTHORIZED` | 401 |
| JWT expired | `E_UNAUTHORIZED` | 401 |
| aud mismatch | `E_FORBIDDEN` | 403 |

---

## Compatibility

- All routes outside `/api/admin/*` are completely unaffected
- Existing x-api-key (WORKER_API_KEY) authentication remains first layer before CF Access check
- `isAdminIpAllowed` function in both `access.js` and `admin.js` is retained; optional defense still works when `ADMIN_ALLOWED_IPS` is set
- `requireAdmin` signature unchanged; `requireIpAllow` option still exists (now unused in production)
- No dependencies added — uses Workers built-in `WebCrypto`, `fetch`, `TextEncoder`, `atob`

---

## Confirmations

- [x] No secret values written to any file or committed to repo
- [x] No `.dev.vars` modification
- [x] Syntax: 44 files checked, 0 errors (before and after)
- [x] Diff contains ONLY `worker/src/` files (no docs/, gas/, scripts/)
- [x] Public/user routes (`/api/traffic/*`, `/webhook`, `/liff/*`, etc.) unchanged
- [x] Existing response format (ok/data/meta, fail/error/meta) preserved
- [x] No new npm dependencies
