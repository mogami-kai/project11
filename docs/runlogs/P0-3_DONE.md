# GATE 3: P0-3 完了ログ — 2026-03-01

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `gas/コード.js` | `assertSubmitActorValid_()` 追加・3ハンドラへの呼び出し差し込み |

---

## 追加ヘルパー仕様

### `assertSubmitActorValid_(ss, userId, lineUserId, requestId)`

```
引数:
  ss          : SpreadsheetApp オブジェクト
  userId      : リクエストの userId（sanitize 済み）
  lineUserId  : リクエストの lineUserId（sanitize 済み、空可）
  requestId   : ログ用

検証順:
  1. userId が空   → E_VALIDATION (fields: userId required)
  2. STAFF_MASTER シートが存在しない  → E_SCHEMA_BROKEN
  3. readTable_ でテーブルが空/読取不可 → E_SCHEMA_BROKEN
  4. 必須列 (userid, status) が欠損    → E_SCHEMA_BROKEN
  5. userId に一致するスタッフ行なし   → E_STAFF_NOT_FOUND
  6. status が ACTIVE 以外             → E_STAFF_INACTIVE
  7. lineUserId が非空 AND マスターの lineUserId が非空 AND 不一致
                                        → E_ACTOR_MISMATCH
  8. 全て通過  → null（書込み許可）
```

**lineUserId 一致検証の方針**: リクエストに lineUserId が含まれる場合のみ検証。
Worker は traffic/expense では lineUserId を GAS ペイロードに含めないため、
該当アクションではステップ 7 はスキップされる。hotel.intent.submit はポストバックイベント
経由で userId（= LINE user ID）と lineUserId の両方が同値で渡されることがある。

---

## 差し込み箇所

### (A) `handleTrafficCreate_` — `withScriptLock_` 冒頭・dedup より前

```diff
   return withScriptLock_(requestId, function() {
     try {
+      // [P0-3] actor 検証（dedup より前：actor 不一致は既存 requestId でも拒否）
+      const trafficActorErr = assertSubmitActorValid_(ss, sanitizeString_(data && data.userId), sanitizeString_(data && data.lineUserId), requestId);
+      if (trafficActorErr) return trafficActorErr;
+
       const sheet = ss.getSheetByName(SHEET_TRAFFIC_);
       // [P4] dedup...
```

**意図**: actor が無効なら dedup ヒットでも拒否。

### (B) `handleExpenseCreate_` — `withScriptLock_` 冒頭・dedup より前

```diff
   return withScriptLock_(requestId, function() {
     try {
+      // [P0-3] actor 検証（dedup より前：actor 不一致は既存 requestId でも拒否）
+      const expenseActorErr = assertSubmitActorValid_(ss, sanitizeString_(data && data.userId), sanitizeString_(data && data.lineUserId), requestId);
+      if (expenseActorErr) return expenseActorErr;
+
       const sheet = ensureExpenseLogSheet_(ss);
       // dedup...
```

### (C) `handleHotelIntentSubmit_` — lock 判定より前（`withScriptLock_` 冒頭）

```diff
   return withScriptLock_(requestId, function() {
+    // [P0-3] actor 検証（lock 判定より前）
+    const hotelActorErr = assertSubmitActorValid_(ss, sanitizeString_(data && data.userId), sanitizeString_(data && data.lineUserId), requestId);
+    if (hotelActorErr) return hotelActorErr;
+
     // [P0-4] 書込み前にロック検証（upsert も対象）
     const hotelMonth = ...
```

---

## エラーコード対応表

| 状況 | エラーコード |
|------|-------------|
| userId 未指定 | `E_VALIDATION` |
| STAFF_MASTER シート欠損 / 列欠損 | `E_SCHEMA_BROKEN` |
| userId がマスターに存在しない | `E_STAFF_NOT_FOUND` |
| status が ACTIVE 以外 | `E_STAFF_INACTIVE` |
| lineUserId が登録値と不一致 | `E_ACTOR_MISMATCH` |

---

## 変更対象外（スコープ外）

| 項目 | 理由 |
|------|------|
| Worker 側 | Gate 3 は GAS のみ |
| その他 GAS アクション（shift/staff/ops 等） | P0-3 対象外。管理系アクションは admin.role による認可で管理 |
| Gate 2 の assertMonthWritable_ | 維持・変更なし |

---

## 検証

```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

---

## 修正履歴（Gate 3 範囲内）

### 2026-03-01 — `table.values.length <= 1` を `E_STAFF_NOT_FOUND` に変更

```diff
-  if (!table.ok || !table.values || table.values.length <= 1) {
-    return errorResponse_('E_SCHEMA_BROKEN', 'STAFF_MASTER is empty or unreadable.', {}, requestId, false);
+  if (!table.ok || !table.values || table.values.length <= 1) {
+    // ヘッダー行のみ（データ行なし）= 未登録扱い
+    return errorResponse_('E_STAFF_NOT_FOUND', 'Staff not registered.', { userId: userId }, requestId, false);
```

**修正理由**: `table.values.length <= 1` はヘッダー行のみ存在（データ行ゼロ）の状態。
シート構造は正常だがスタッフが一人も登録されていない = userId が存在しないと同義であり、
`E_STAFF_NOT_FOUND`（未登録）が正確なセマンティクス。
`E_SCHEMA_BROKEN` はシートやヘッダー列が欠損している構成エラー専用として維持。

| 条件 | 変更前 | 変更後 |
|------|--------|--------|
| `table.values.length <= 1`（データ行なし） | `E_SCHEMA_BROKEN` | `E_STAFF_NOT_FOUND` |
| シート欠損 | `E_SCHEMA_BROKEN` | 変更なし |
| `idxUserId / idxStatus < 0`（列欠損） | `E_SCHEMA_BROKEN` | 変更なし |

```
bash scripts/check-syntax.sh → Checked: 44 files, Errors: 0, [OK]
```

---

## 次 Gate に進めるか

**YES** — Gate 4（P0-5: webhook 再処理可能化）へ進める。
