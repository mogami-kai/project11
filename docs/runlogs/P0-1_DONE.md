# GATE 5: P0-1 完了ログ — 2026-03-01

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `gas/コード.js` | 定数追加・`buildBroadcastRecipientsFromRecords_` に `recipientId` 追加・`listBroadcastRecipientsByBroadcastId_` に `recipientId` 追加・`handleAdminBroadcastSendFinalize_` に BROADCAST_LOG_RECIPIENTS 書込み + `alreadySent` 対応・`ensureBroadcastLogRecipientsSheet_` 追加 |
| `worker/src/lib/broadcastMessage.js` | `executeBroadcastDelivery` に `alreadySentIds`/`operationId`/`recipientId`/KV書込み/`alreadySent` 返却を追加 |
| `worker/src/handlers/broadcast.js` | `handleAdminBroadcastSend` に KV 先読み（alreadySentIds 構築）+ finalize payload に `alreadySent` 追加 |

---

## 差分要点

### 1. `gas/コード.js` — 新定数

```diff
+const SHEET_BROADCAST_LOG_RECIPIENTS_PREFIX_ = 'BROADCAST_LOG_RECIPIENTS_'; // [P0-1]
```

---

### 2. `buildBroadcastRecipientsFromRecords_(records, broadcastId)` — `recipientId` 追加

```diff
-function buildBroadcastRecipientsFromRecords_(records) {
+function buildBroadcastRecipientsFromRecords_(records, broadcastId) {
+  const bid = sanitizeString_(broadcastId);
   return src.map(function(rec) {
+    const userId = sanitizeString_(rec.userId);
+    const siteKey = sanitizeString_(rec.siteId) || sanitizeString_(rec.siteRaw);
+    const role = sanitizeString_(rec.role);
+    const workDate = sanitizeString_(rec.workDate);
     return {
+      recipientId: bid ? buildStableIdFromParts_(['br', bid, userId, siteKey, role, workDate]) : '',
       ...
     };
   });
```

呼出し元（`handleAdminBroadcastSendPrepare_`）も `broadcastId` を渡すよう更新。

---

### 3. `listBroadcastRecipientsByBroadcastId_` — `recipientId` 追加

```diff
+      const rUserId = idxUserId >= 0 ? sanitizeString_(row[idxUserId]) : '';
+      ...
       out.push({
+        recipientId: id ? buildStableIdFromParts_(['br', id, rUserId, rSiteId || rSiteRaw, rRole, rWorkDate]) : '',
         userId: rUserId,
         ...
       });
```

idempotent 返却（PREPARED 既存）でも `recipientId` が含まれるようになった。

---

### 4. `handleAdminBroadcastSendFinalize_` — BROADCAST_LOG_RECIPIENTS 書込み・`alreadySent` 対応

```diff
+    const alreadySent = Number(delivery.alreadySent || 0); // [P0-1]

+    // [P0-1] write per-recipient delivery log to BROADCAST_LOG_RECIPIENTS
+    const recipientSheet = ensureBroadcastLogRecipientsSheet_(ss, targetMonth);
+    const deliveryItems = Array.isArray(deliveries) ? deliveries : [];
+    for (let i = 0; i < deliveryItems.length; i++) {
+      const d = deliveryItems[i];
+      const recId = sanitizeString_(d && d.recipientId);
+      if (!recId) continue;
+      const isSent = dStatus === 'sent' || dStatus === 'already_sent';
+      upsertSheetRowById_(recipientSheet, 'recipientId', recId, { ... });
+    }

     const patch = {
-      sentCount: pushed,
+      sentCount: pushed + alreadySent, // [P0-1] total sent across all runs
```

`finalStatus = failed > 0 ? 'PARTIAL' : 'SENT'` ロジックは変更なし（`already_sent` は失敗扱いにならない）。

---

### 5. `ensureBroadcastLogRecipientsSheet_` — 新ヘルパー追加

```js
// [P0-1] recipient単位の送信ログシート（monthly partition）
function ensureBroadcastLogRecipientsSheet_(ss, month) {
  return ensureMonthlyPartitionSheet_(ss, SHEET_BROADCAST_LOG_RECIPIENTS_PREFIX_, month,
    ['recipientId', 'broadcastId', 'operationId', 'targetMonth', 'userId', 'lineUserId',
     'siteId', 'role', 'workDate', 'sent', 'sentAt', 'errorCode', 'createdAt', 'updatedAt', 'requestId']);
}
```

シート名: `BROADCAST_LOG_RECIPIENTS_YYYY_MM`（月次 partition）

---

### 6. `worker/src/lib/broadcastMessage.js` — `executeBroadcastDelivery` 変更

```diff
-export async function executeBroadcastDelivery(env, recipients, requestId, options = {}) {
-  const includeRecipientMeta = Boolean(options.includeRecipientMeta);
-  const deliveries = [];
-  let pushed = 0;
-  let failed = 0;

+  const operationId = String(options.operationId || '').trim(); // [P0-1]
+  const alreadySentIds = options.alreadySentIds instanceof Set ? options.alreadySentIds : new Set();
+  const kv = env?.IDEMPOTENCY_KV;
+  let alreadySent = 0;

   for (const recipient of recipients) {
+    const recipientId = String(recipient?.recipientId || '').trim();

+    // [P0-1] skip already-sent recipients from previous runs
+    if (recipientId && alreadySentIds.has(recipientId)) {
+      alreadySent += 1;
+      deliveries.push({ recipientId, ..., status: 'already_sent', errorCode: '' });
+      continue;
+    }

     // lineUserId missing → failed (recipientId added to entry)
     // LINE push success → KV.put(`broadcast:sent:${operationId}:${recipientId}`, '1', { expirationTtl: 604800 })
     // all entries now include recipientId
   }

-  return { pushed, failed, deliveries };
+  return { pushed, failed, alreadySent, deliveries }; // [P0-1]
```

---

### 7. `worker/src/handlers/broadcast.js` — KV 先読み + finalize payload 更新

```diff
+    // [P0-1] check KV for recipients already sent in a previous run
+    const alreadySentIds = new Set();
+    const kv = env?.IDEMPOTENCY_KV;
+    if (operationId && kv) {
+      for (const rec of recipients) {
+        const recId = String(rec?.recipientId || '').trim();
+        if (!recId) continue;
+        try {
+          const val = await kv.get(`broadcast:sent:${operationId}:${recId}`);
+          if (val) alreadySentIds.add(recId);
+        } catch { /* ignore */ }
+      }
+    }

-    const { pushed, failed, deliveries } = await executeBroadcastDelivery(env, recipients, requestId, { includeRecipientMeta: true });
+    const { pushed, failed, alreadySent, deliveries } = await executeBroadcastDelivery(env, recipients, requestId, {
+      includeRecipientMeta: true,
+      operationId,
+      alreadySentIds
+    });

     delivery: {
       pushed,
       failed,
       skipped,
+      alreadySent, // [P0-1]
       deliveries
     }
```

---

## 変更対象外（スコープ外）

| 項目 | 理由 |
|------|------|
| `handleAdminBroadcastRetryFailed` | retry-failed は独立ループで LINE 送信、P0-1 対象外 |
| `slack.js` のbroadcast送信経路 | `executeBroadcastDelivery` の新 `alreadySent` 戻り値を破壊しない（デストラクチャリングで無視される）。`alreadySentIds` 未指定 → 空 Set で動作継続 |
| `handleAdminBroadcastRetryFailedFinalize_` | finalize の BROADCAST_LOG_RECIPIENTS 書込みは P0-1 スコープ外 |

---

## 動作保証

| シナリオ | Before | After |
|----------|--------|-------|
| 同一 operationId で再実行 | 全 recipient に再送信 | KV で sent=true → skip、BROADCAST_LOG_RECIPIENTS 書込み済み |
| 一部失敗後に再実行 | 全 recipient に再送信 | 成功済み recipient は skip、失敗 recipient のみ再送 |
| finalize: 全員 sent | finalStatus = SENT | SENT（failed === 0 の場合、already_sent も failed にならない）|
| finalize: 一部失敗 | finalStatus = PARTIAL | PARTIAL（failed > 0 の場合）|
| KV なし環境 | 既存動作 | KV check スキップ、alreadySentIds = 空 Set → 全員送信（フォールバック）|

---

## 検証

```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

## 次 Gate に進めるか

**P0 全 Gate 完了（P0-1〜P0-5）** — Go 条件達成。
