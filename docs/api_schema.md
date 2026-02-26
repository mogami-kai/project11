# API I/O Schema (v5 Final)

参照（SoT）:
- [v5 Spec (Final)](./v5_spec.md)
- [Registration Spec](./registration_spec.md)
- [Action Contracts](./action-contracts.md)
- [Ops Rules](./ops_rules.md)

## スコープ境界（重複防止）

- 本書はHTTP APIのリクエスト/レスポンス契約（JSON形状）を定義する。
- GAS action側の責務・永続先・運用契約は [action-contracts.md](./action-contracts.md) を正本とする。

---

## 共通レスポンス

```json
// success
{
  "ok": true,
  "data": {},
  "meta": { "requestId": "string", "timestamp": "ISO8601", "warnings": [] }
}

// error
{
  "ok": false,
  "error": { "code": "E_xxx", "message": "string", "details": {}, "retryable": false },
  "meta": { "requestId": "string", "timestamp": "ISO8601" }
}
```

**エラーコード一覧（v5）**

| code | 意味 |
|------|------|
| `E_REGISTER_REQUIRED` | 登録未完了（必須フィールド不足） |
| `E_STAFF_INACTIVE` | isActive=false（無効スタッフ） |
| `E_DUPLICATE` | idempotencyKey重複（再送OK） |
| `E_VALIDATION` | バリデーション不正 |
| `E_IMAGE_TOO_LARGE` | リサイズ後も基準超過（上限5MB） |

---

## 1. 登録

### `GET /api/register/status`
- 認証：LIFF idToken（Bearer）

**Response**
```json
{
  "ok": true,
  "data": {
    "registered": true,
    "missingFields": [],
    "staff": {
      "lineUserId": "Uxxx",
      "nameKanji": "山田 太郎",
      "nameKana": "ヤマダ タロウ",
      "nearestStation": "新宿",
      "isActive": true,
      "lineFollowStatus": "follow"
    }
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

### `POST /api/register/upsert`
- 認証：LIFF idToken（Bearer）
- 仕様：全必須項目を受け、正規化して staff master を upsert。未充足は `registered=false`

**Request**
```json
{
  "requestId": "reg-20260226-001",
  "idempotencyKey": "reg-Uxxx-20260226-001",
  "staff": {
    "nameKanji": "山田 太郎",
    "nameKana": "ヤマダ タロウ",
    "birthDate": "1999-01-01",
    "nearestStation": "新宿（東京）",
    "phone": "090-1234-5678",
    "emergencyRelation": "母",
    "emergencyPhone": "090-0000-0000",
    "postalCode": "123-4567",
    "address": "東京都..."
  }
}
```

**Response**
```json
{
  "ok": true,
  "data": {
    "registered": true,
    "missingFields": [],
    "staff": {
      "lineUserId": "Uxxx",
      "isActive": true,
      "lineFollowStatus": "follow"
    }
  },
  "meta": { "requestId": "...", "timestamp": "...", "warnings": [] }
}
```

---

## 2. ゲート（提出系共通ルール）

提出系（traffic/expense/shift/hotel回答）の全エンドポイントで適用：

| 状態 | 結果 |
|------|------|
| staff master なし or required不足 | `E_REGISTER_REQUIRED` で拒否 |
| `isActive=false` | `E_STAFF_INACTIVE` で拒否（v5推奨） |
| `lineFollowStatus=unfollow` | 提出OK（配信対象外は運用側で制御） |

**Error例**
```json
{
  "ok": false,
  "error": {
    "code": "E_REGISTER_REQUIRED",
    "message": "Registration required",
    "details": { "missingFields": ["phone"] },
    "retryable": false
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

---

## 3. 交通費

### `POST /api/traffic/create`
- 認証：LIFF idToken
- 仕様：`source` を `manual` / `ocr` で持ち、同一ログに保存。**画像は受け取らない**

**Request**
```json
{
  "requestId": "tr-202602-001",
  "idempotencyKey": "tr-Uxxx-202602-001",
  "source": "manual",
  "work": {
    "workDate": "2026-02-24",
    "site": "〇〇店",
    "client": "〇〇",
    "workStartDate": "2026-02-24",
    "workEndDate": "2026-02-24",
    "hotelUse": "有り"
  },
  "train": { "from": "新宿", "to": "渋谷", "amount": 240, "oneway": "片道", "total": 480 },
  "bus":   { "from": "", "to": "", "amount": 0, "oneway": "", "total": 0 },
  "trafficTotal": 480,
  "memo": "任意"
}
```

### `POST /api/traffic/ocr-auto`（下書き生成）
- 認証：LIFF idToken
- 仕様：画像base64を受け、抽出結果のみ返す（**保存しない**）

**Request**
```json
{
  "requestId": "ocr-202602-001",
  "work": { "workDate": "2026-02-24", "site": "〇〇店" },
  "image_base64": "data:image/png;base64,...",
  "memo_text": "追加: 電車 240円 ルート: 新宿→渋谷 理由: 打合せ"
}
```

**Response**
```json
{
  "ok": true,
  "data": {
    "totals": { "train_total": 726, "bus_total": 0, "grand_total": 726, "unknown_total": 0 },
    "draft": {
      "train": { "from": "", "to": "", "amount": 0, "oneway": "片道", "total": 726 },
      "bus":   { "from": "", "to": "", "amount": 0, "oneway": "", "total": 0 },
      "trafficTotal": 726,
      "memo_struct": { "adds": [], "edits": [], "notes": [] },
      "needs_review": true
    }
  },
  "meta": { "requestId": "...", "timestamp": "...", "warnings": ["NEEDS_REVIEW"] }
}
```

> draft をUIで人が補正 → `/api/traffic/create` で確定保存

---

## 4. 経費立替

### `POST /api/expense/create`
- 認証：LIFF idToken
- 仕様：金額/用途/備考 + 領収書画像（任意）を受け取る  
  **領収書画像はWorker側でリサイズしてストレージ保存 → DBにはURLのみ格納**

**Request**
```json
{
  "requestId": "exp-202602-001",
  "idempotencyKey": "exp-Uxxx-202602-001",
  "work": {
    "workDate": "2026-02-24",
    "site": "〇〇店"
  },
  "expense": {
    "amount": 1500,
    "category": "備品",
    "note": "コピー用紙購入"
  },
  "receipt": {
    "image_base64": "data:image/jpeg;base64,...",
    "originalFilename": "receipt.jpg"
  }
}
```

> `receipt` フィールドは省略可能（領収書なし申請を許容）

**Workerの処理フロー（receipt がある場合）**
```
1. base64デコード
2. リサイズ処理（最大1200px / JPEG 70% / PNG・HEIC・WEBPは変換）
3. ストレージ（R2 or GCS）へアップロード
4. 取得したURLをDBのexpenseログに保存
5. base64原本は破棄（メモリから解放）
```

**Response**
```json
{
  "ok": true,
  "data": {
    "expenseId": "exp-Uxxx-202602-001",
    "receiptUrl": "https://storage.example.com/receipts/exp-Uxxx-202602-001.jpg",
    "resized": true
  },
  "meta": { "requestId": "...", "timestamp": "...", "warnings": [] }
}
```

> `receipt` 省略時は `receiptUrl: null`, `resized: false`

**リサイズ失敗時（E_IMAGE_TOO_LARGE など）**
```json
{
  "ok": false,
  "error": {
    "code": "E_IMAGE_TOO_LARGE",
    "message": "Receipt image exceeds 5MB after resize",
    "details": { "sizeKB": 6200 },
    "retryable": false
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

---

## 5. ホテル

### `POST /api/hotel/push`（管理者）
- 認証：x-api-key
- 対象：`isActive=true` かつ `lineFollowStatus=follow` のみ（未登録除外）

### `POST /api/hotel/screenshot/process`（管理者OCR）
- 認証：x-api-key
- 仕様：画像は**保存しない**。OCRで `name_candidate` 抽出 → 正規化して名寄せ

**Response例（不一致）**
```json
{
  "ok": true,
  "data": {
    "result": "unmatched",
    "name_candidate": "YAMADA TARO",
    "matched": null,
    "auditLogged": true
  },
  "meta": { "requestId": "...", "timestamp": "...", "warnings": ["NEEDS_MANUAL_REVIEW"] }
}
```

**result の種類**

| value | 意味 |
|-------|------|
| `confirmed` | 名寄せ成功・自動仕分け完了 |
| `unmatched` | 一致なし・ADMIN_ALERTSに記録 |
| `duplicate` | 同一スタッフへの重複検知 |

---

## 6. Unfollow Webhook（LINEイベント）

- `eventType=unfollow` を受信したら staff master の `lineFollowStatus` を `unfollow` に更新
- 以後 push 対象から除外（`hotel.push` / 各種一括配信）

```json
// LINE webhook payload（参考）
{
  "events": [{
    "type": "unfollow",
    "source": { "type": "user", "userId": "Uxxx" },
    "timestamp": 1740000000000
  }]
}
```
