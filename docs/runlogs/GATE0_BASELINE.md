# GATE 0: Baseline — 2026-03-01

## 0-1) 状態確認

### git status --short
```
?? docs/CODEX_PROMPT_GATE_EXECUTION.md
?? docs/README_READINESS_STATUS.md
?? docs/システム設計評価.docx          (pre-existing untracked)
?? docs/スタッフ管理システム_確定版統合仕様書_v5.0.docx  (pre-existing untracked)
```
→ **tracked ファイルに差分なし。git diff は空。**

### lint / syntax チェック
```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

## 0-2) 入口の確認

### Worker

| 役割 | ファイル | 行 |
|------|----------|----|
| エントリ (fetch) | `worker/src/index.js` | L1-14 |
| ルーター | `worker/src/router.js` → `routeFetch()` | L54 |
| 認証モジュール | `worker/src/auth.js` → `authenticateRequest()` | L61 |
| Admin ハンドラ | `worker/src/handlers/admin.js` | 全体 |
| Broadcast ハンドラ | `worker/src/handlers/broadcast.js` | 全体 |
| Webhook ハンドラ | `worker/src/handlers/webhook.js` | 全体 |

**ルーティング方式**: `router.js` が `switch (routeKey)` で全ルートをディスパッチ。
**認証方式**: `authenticateRequest(request, env, meta, { allowApiKey, allowLiffIdToken })` で各ハンドラが個別に呼ぶ。

### GAS

| 役割 | ファイル | 行 |
|------|----------|----|
| エントリ | `gas/コード.js` → `doPost(e)` | L88 |
| トークン検証 | `doPost()` 内 | ~L120 |
| アクション dispatch | `switch(req.action)` | ~L126 |
| 月次ロック判定 | `isMonthLocked_()` | L6074 |
| ロックシート ensure | `ensureMonthlyLockSheet_()` | L6165 |

**認証方式**: STAFF_TOKEN の一致のみ（登録/active/lineUserId チェックなし）。

---

## 0-3) P0 事前状況サマリ

### P0-2（Gate 1 候補）: admin経路
- `worker/src/handlers/admin.js` の全ハンドラが `allowApiKey: true` を指定
- API key が有効な限り `/api/admin/*` に到達可能 → **Slack署名限定になっていない**
- `isAdminIpAllowed()` (admin.js:L243) は `ADMIN_ALLOWED_IPS` が空なら `return true` → **fail-open**
- broadcast 3ハンドラ (`broadcast.js:L419`) も `allowApiKey: true` かつ IP チェックなし

### P0-4（Gate 2 候補）: 月次 lock fail-close
- `isMonthLocked_()` (gas:L6074) が `ensureMonthlyLockSheet_()` を呼ぶ
- シート欠損時に **自動作成** → fail-open（欠損=OPEN 復帰）
- `traffic.create`, `expense.create`, `hotel.intent.submit` でのロック事前検証を要確認

### P0-3（Gate 3 候補）: GAS submit gate
- `doPost()` (gas:L88) は STAFF_TOKEN のみチェック
- staffId ACTIVE・lineUserId 一致・lock の検証なし → GAS 直叩きで Worker gate 回避可能

### P0-5（Gate 4 候補）: webhook 再処理可能化
- `reserveWebhookEventForProcessing()` (webhook.js) は処理**前**に KV に記録
- 処理失敗でも idempotency キーが残る → LINE 再送しても処理されない
- `handleLineWebhook` は常に `ack({ accepted: true })` で 200 を返す → 失敗が LINE に通知されない

### P0-1（Gate 5 候補）: broadcast 重複配信
- `broadcast.js` の send/finalize 経路を次 Gate 以降で確認予定

---

## 結論

- 差分: **ゼロ**（tracked files clean）
- Syntax: **全通過**
- P0-2/P0-3/P0-4/P0-5 の問題箇所を特定済み
- **次 Gate: Gate 1（P0-2 — admin 経路の Slack 署名限定）**

Gate 0 完了。
