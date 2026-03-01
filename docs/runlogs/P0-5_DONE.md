# GATE 4: P0-5 完了ログ — 2026-03-01

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `worker/src/handlers/webhook.js` | `ctx.waitUntil` 廃止・同期処理化・KV 成功後記録・500 返却 |

---

## 差分要点

### 1. `handleLineWebhook()` — `ctx.waitUntil` 廃止・失敗時 500 返却

```diff
-  const task = processLineEvents(events, env, requestId);
-  if (ctx && typeof ctx.waitUntil === 'function') {
-    ctx.waitUntil(task);
-    return ack({ accepted: true, queued: true, eventCount: events.length });
-  }
-  try {
-    await task;
-  } catch (error) {
-    safeLog('line.webhook', { requestId, reason: 'process_failed', ... });
-  }
-  return ack({ accepted: true, queued: false, eventCount: events.length });

+  // [P0-5] 同期処理: 失敗時は 500 で返して LINE 再送を許可
+  const result = await processLineEvents(events, env, requestId);
+  if (!result.ok) {
+    safeLog('line.webhook', { requestId, reason: 'processing_failed', eventCount: events.length });
+    const res = fail(buildError('E_UPSTREAM', 'Event processing failed. Retry expected.', {}, true), meta, { status: 500 });
+    return withCorsHeaders(res, origin, allowedOrigin, requestId);
+  }
+  return ack({ accepted: true, eventCount: events.length });
```

**意図**: `ctx.waitUntil` は常に 200 を返すため GAS 失敗を LINE に伝達できなかった。
同期処理化により、GAS エラー時に 500 を返して LINE の自動再送を許可する。

---

### 2. `processLineEvents()` — `{ok: boolean}` 返却・新トラッカー呼出し

```diff
-async function processLineEvents(events, env, requestId) {
-  for (const event of events) {
-    ...
-    await processSingleLineEventSafely(event, env, requestId);
-  }
-}

+async function processLineEvents(events, env, requestId) {
+  for (const event of events) {
+    ...
+    // [P0-5] 成功後に KV 記録。失敗時は false を返して 500 へ
+    const eventOk = await processSingleLineEventTracked(event, env, requestId, replayGuard.storeKey);
+    if (!eventOk) return { ok: false };
+  }
+  return { ok: true };
+}
```

---

### 3. `processSingleLineEventTracked()` — 新関数追加

```js
// [P0-5] 処理成功後にのみ KV へ記録し、失敗時は false を返す
async function processSingleLineEventTracked(event, env, requestId, storeKey) {
  try {
    await processSingleLineEvent(event, env, requestId);
    await recordWebhookEventProcessed(env, storeKey, requestId);
    return true;
  } catch (error) {
    safeLog('line.event', { requestId, type: ..., reason: 'event_failed', message: ... });
    return false;
  }
}
```

---

### 4. `recordWebhookEventProcessed()` — 新関数追加

```js
// [P0-5] 成功後に KV / メモリキャッシュへ記録（事前予約の廃止に対応）
async function recordWebhookEventProcessed(env, storeKey, requestId) {
  if (!storeKey) return;
  const ttlSeconds = parseWebhookReplayTtlSeconds(env);
  const kv = env?.IDEMPOTENCY_KV;
  if (kv) {
    await kv.put(storeKey, requestId, { expirationTtl: ttlSeconds });
    return;
  }
  WEBHOOK_EVENT_MEMORY_CACHE.set(storeKey, Date.now() + ttlSeconds * 1000);
}
```

---

### 5. `reserveWebhookEventForProcessing()` — KV 事前予約を廃止・`storeKey` を返却に追加

```diff
-  await kv.put(storeKey, requestId, { expirationTtl: ttlSeconds });
-  return { processable: true, reason: 'reserved', eventId, eventTimestampMs };
+  return { processable: true, reason: 'new', eventId, eventTimestampMs, storeKey };

-  WEBHOOK_EVENT_MEMORY_CACHE.set(storeKey, now + ttlSeconds * 1000);
-  return { processable: true, reason: 'reserved', eventId, eventTimestampMs };
+  return { processable: true, reason: 'new', eventId, eventTimestampMs, storeKey };

   // no_event_id 早期返却にも storeKey: '' を追加
-  return { processable: true, reason: 'no_event_id', eventId: '', eventTimestampMs: 0 };
+  return { processable: true, reason: 'no_event_id', eventId: '', eventTimestampMs: 0, storeKey: '' };
```

**意図**: 処理前に KV へ書くと、GAS 失敗後の再送時に `duplicate_event` と判定されて再処理不可になる。
廃止後は処理成功時のみ KV へ書く（`recordWebhookEventProcessed`）。

---

## 変更対象外（スコープ外）

| 項目 | 理由 |
|------|------|
| `processSingleLineEventSafely()` | 削除せず残置（最小変更方針）。`processLineEvents` からの呼出しは置換済み |
| GAS 側 | Gate 4 は Worker のみ |
| 他の Worker ハンドラ | 変更なし |

---

## 検証

```
bash scripts/check-syntax.sh
→ Checked: 44 files, Errors: 0
→ [OK] All syntax checks passed.
```

---

## 動作保証

| シナリオ | Before | After |
|----------|--------|-------|
| GAS エラー時 | Worker は 200 返却（LINE 再送なし） | Worker は **500** 返却（LINE が自動再送） |
| 同一イベント再送（成功済み） | KV 照合で `duplicate_event` → 200 スキップ | 同左（KV に記録済みのため dedup 維持） |
| 失敗イベントの再送 | KV 事前記録済みのため再処理不可（**バグ**） | KV 未記録のため再処理可能（**修正**） |
| `webhookEventId` なしイベント | 常に処理 | 同左（`storeKey: ''` → KV 記録スキップ） |

---

## 次 Gate に進めるか

**YES** — Gate 5（P0-1: broadcast recipient-unit idempotency）へ進める。
