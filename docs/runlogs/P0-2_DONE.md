# GATE 1: P0-2 完了ログ — 2026-03-01

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `worker/src/handlers/broadcast.js` | `parseAdminRequest()` から legacy api-key ブランチを削除。未使用 import 2件を削除 |
| `worker/src/handlers/admin.js` | ローカル `isAdminIpAllowed()` を fail-close に修正 |

---

## 差分要点

### broadcast.js

**import 削除（2行）**
```diff
-import { authenticateRequest } from '../auth.js';
-import { requireAdmin } from '../lib/access.js';
```

**`parseAdminRequest()` 変更**
- Before: `hasSlackSignature` フラグで Slack / api-key の2経路に分岐
- After: 無条件に `verifySlackSignature` を実行。失敗なら即 401
- `actorType: 'legacy_api_key'` 経路を完全削除
- `actorType: 'slack'` 経路のみ残存

```diff
-  const hasSlackSignature = Boolean(request.headers.get('x-slack-signature'));
-  if (hasSlackSignature) {
-    const verified = await verifySlackSignature(...)
-    ...
-  }
-  // legacy branch
-  const auth = await authenticateRequest(..., { allowApiKey: true });
-  const adminCheck = requireAdmin(..., { requireIpAllow: true });
-  return { actorType: 'legacy_api_key', ... };

+  const verified = await verifySlackSignature(rawBody, request.headers, env.SLACK_SIGNING_SECRET);
+  if (!verified.ok) return { ok: false, response: fail(...E_UNAUTHORIZED 'Slack signature required.'...) };
+  return { actorType: 'slack', ... };
```

### admin.js

**`isAdminIpAllowed()` fail-close**
```diff
-  if (!allowRaw) return true;   // ADMIN_ALLOWED_IPS 未設定 → 全許可（fail-open）
+  if (!allowRaw) return false;  // ADMIN_ALLOWED_IPS 未設定 → 全拒否（fail-close）
```
対象: `GET /api/admin/shift/raw/recent` (`handleAdminShiftRawRecent`)

---

## 変更対象外（スコープ外）

| 項目 | 理由 |
|------|------|
| `lib/access.js` の `isAdminIpAllowed` | `hotel.js` / `reminder.js`（非 admin ルート）でも使用。変更すると Gate 1 スコープ外に影響するため対象外 |
| `_debug` ルート群 | `/api/_debug/*` は `/api/admin/*` ではないため対象外。別途 P1 以降で検討 |
| GAS 側 | Gate 1 は Worker のみ |

---

## 検証

```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

## セキュリティ効果（P0-2 達成）

| 攻撃経路 | Before | After |
|----------|--------|-------|
| `x-api-key` で `/api/admin/broadcast/*` 到達 | **可能** (legacy_api_key) | **不可** (401) |
| Slack 署名なしで `/api/admin/broadcast/*` 到達 | **可能** | **不可** (401) |
| `ADMIN_ALLOWED_IPS` 未設定で `/api/admin/shift/raw/recent` | **許可** (fail-open) | **拒否** (fail-close) |
| Slack 署名付きで `/api/admin/broadcast/*` 到達 | 可能 | 可能（正規経路）|

---

## 次 Gate に進めるか

**YES** — Gate 2（P0-4: 月次 lock fail-close の全面適用）へ進める。
