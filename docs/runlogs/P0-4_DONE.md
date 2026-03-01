# GATE 2: P0-4 完了ログ — 2026-03-01

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `gas/コード.js` | `assertMonthWritable_()` 追加・`isMonthLocked_()` 修正・ロックゲート 4 箇所追加 |

---

## 差分要点

### 1. 新ヘルパー `assertMonthWritable_()` を追加

```diff
+function assertMonthWritable_(ss, month, requestId) {
+  const name = SHEET_MONTHLY_LOCK_PREFIX_ + sanitizeString_(month).replace('-', '_');
+  const sheet = ss.getSheetByName(name);   // getSheetByName のみ（ensure しない）
+  if (!sheet) {
+    return errorResponse_('E_SCHEMA_BROKEN', 'Monthly lock sheet not found...', ...);
+  }
+  const status = sanitizeString_(lock.status).toUpperCase();
+  if (status === 'LOCKED')  return errorResponse_('E_MONTH_LOCKED',   ...);
+  if (status === 'CLOSING') return errorResponse_('E_CLOSING_MONTH',  ...);
+  return null; // 書込み可
+}
```

### 2. `isMonthLocked_()` を fail-close に修正

```diff
 function isMonthLocked_(ss, month) {
-  const sheet = ensureMonthlyLockSheet_(ss, month);  // ← 欠損時に自動作成（fail-open）
+  const name = SHEET_MONTHLY_LOCK_PREFIX_ + sanitizeString_(month).replace('-', '_');
+  const sheet = ss.getSheetByName(name);              // ← 欠損時は null 返却（fail-close）
+  if (!sheet) return null;
   ...
 }
```

### 3. `dispatchMonthlyAction_` — `monthly.file.generate` にロックゲート

```diff
-    case 'monthly.file.generate':
+    case 'monthly.file.generate': {
+      const month = sanitizeString_(data && data.month);
+      const monthlyLockErr = assertMonthWritable_(ss, month, requestId);
+      if (monthlyLockErr) return monthlyLockErr;
       return handleMonthlyFileGenerate_(ss, data, requestId);
+    }
```
- `admin.monthly.close.export` 経由は `handleMonthlyFileGenerate_()` を直接呼ぶため影響なし

### 4. `handleAdminBroadcastSendPrepare_` — `isMonthLocked_` 置換

```diff
-    if (isMonthLocked_(ss, targetMonth)) {
-      return errorResponse_('E_MONTH_LOCKED', ..., { month, adjustmentMonth });
-    }
+    const broadcastLockErr = assertMonthWritable_(ss, targetMonth, requestId);
+    if (broadcastLockErr) return broadcastLockErr;
```
- シート欠損（E_SCHEMA_BROKEN）・CLOSING（E_CLOSING_MONTH）も拒否するように強化

### 5. `handleTrafficCreate_` — dedup 後・書込み前にロックゲート

```diff
     // dedup チェック後
+    const trafficMonth = sanitizeString_(data && data.workDate).slice(0, 7);
+    const trafficLockErr = assertMonthWritable_(ss, trafficMonth, requestId);
+    if (trafficLockErr) return trafficLockErr;
     // write ...
```
- 既存 requestId のデータはデdup で OK 返却（ロック前の記録は冪等性を維持）
- 新規書込みのみロック検証

### 6. `handleExpenseCreate_` — dedup 後・書込み前にロックゲート

```diff
     // dedup チェック後
+    const expenseMonth = sanitizeString_(data && data.workDate).slice(0, 7);
+    const expenseLockErr = assertMonthWritable_(ss, expenseMonth, requestId);
+    if (expenseLockErr) return expenseLockErr;
     // write ...
```

### 7. `handleHotelIntentSubmit_` — `withScriptLock_` 冒頭にロックゲート

```diff
   return withScriptLock_(requestId, function() {
+    const hotelMonth = sanitizeString_(data && data.workDate).slice(0, 7);
+    const hotelLockErr = assertMonthWritable_(ss, hotelMonth, requestId);
+    if (hotelLockErr) return hotelLockErr;
     const sheet = ensureHotelIntentSheet_(ss);
```
- upsert も対象（既存行更新も LOCKED/CLOSING 月は拒否）

---

## 変更対象外（スコープ外）

| 項目 | 理由 |
|------|------|
| `handleAdminMonthlyCloseExport_()` | lock を書くのが責務。`ensureMonthlyLockSheet_()` を引き続き使用する正規経路 |
| `lib/access.js` の `isAdminIpAllowed` | Gate 1 で対応済み |
| Worker 側 | GAS のみ |

---

## エラーコード対応表

| 状況 | エラーコード |
|------|-------------|
| ロックシート欠損 | `E_SCHEMA_BROKEN` |
| 月がロック済み | `E_MONTH_LOCKED` |
| 月がクローズ中 | `E_CLOSING_MONTH` |

---

## 検証

```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

## 次 Gate に進めるか

**YES** — Gate 3（P0-3: GAS submit gate）へ進める。
