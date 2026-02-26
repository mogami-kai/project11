# Action Contracts (v5) — Project1

このドキュメントは、v5における **API/Actionの契約（Contract）** を「一覧表」と「共通ルール」で固定する。
将来のv6+（DBをSQLへ置換等）でも、**Contractを守る限り内部実装は差し替え可能**とする。

参照（SoT）:
- [API I/O Schema (v5 Final)](./api_schema.md)
- [Ops Rules (v5)](./ops_rules.md)
- [v5 Spec (Final)](./v5_spec.md)
- [DX Core Audit Memo](./DX_CORE.md)

---

## 0. スコープ境界（重複防止）

- 本書は、HTTP APIとGAS actionの責務境界（Auth/Gate/Idempotency/永続先）を固定する。
- HTTP APIのリクエスト/レスポンス項目（JSON形状）の正本は [api_schema.md](./api_schema.md) とする。
- 実装逸脱の監査は [DX_CORE.md](./DX_CORE.md) を正本とする。

---

## 1. 共通レスポンス（SoT）

全APIは共通レスポンス形式を守る。

- success: `{ ok:true, data:{...}, meta:{ requestId, timestamp, warnings[] } }`
- error: `{ ok:false, error:{ code, message, details, retryable }, meta:{ requestId, timestamp } }`

---

## 2. 共通ゲート（提出系）

提出系（traffic/expense/shift/hotel回答 等）は以下を共通適用：

- 未登録/required不足：`E_REGISTER_REQUIRED`（retryable=false）
- inactive：`E_STAFF_INACTIVE`（retryable=false, v5推奨）
- unfollow：提出はOK（配信は対象外）

---

## 3. Idempotency（原則）

- 提出系は `idempotencyKey` を受け付け、再送で重複作成しない。
- 重複時は「同一結果の再返却」が原則（UX維持）。

---

## 4. Contract Table（HTTP API / GAS Actions）

### 4.1 HTTP API（v5 / docs明示分）

この節は「責務と運用契約」の整理であり、I/O JSONの正本は [api_schema.md](./api_schema.md) とする。

| API | Auth | Gate | Idempotency | 永続化 | 主なData Policy |
|---|---|---|---|---|---|
| `GET /api/register/status` | LIFF idToken | なし | 不要 | 参照のみ | 登録状態/不足項目を返す |
| `POST /api/register/upsert` | LIFF idToken | なし | あり（body.idempotencyKey） | STAFF_MASTER upsert | 必須項目の正規化・未充足はregistered=false |
| `POST /api/traffic/create` | LIFF idToken | ✅ | あり | TRAFFIC_LOG | 交通費はmanual/ocr同一ログ。画像は受け取らない |
| `POST /api/traffic/ocr-auto` | LIFF idToken | ✅ | （requestId基準推奨） | 保存しない | OCRで下書き生成のみ。画像base64受領→抽出→返却、保存しない |
| `POST /api/expense/create` | LIFF idToken | ✅ | あり | EXPENSE_LOG + receiptURL | 領収書はWorkerでリサイズしてストレージ保存、DBにはURLのみ |
| `POST /api/hotel/push` | x-api-key | 対象抽出 | 送信ガード推奨 | HOTEL_SENT_LOG 等 | isActive=true & follow のみを対象に配信 |
| `POST /api/hotel/screenshot/process` | x-api-key | なし | （requestId基準推奨） | 監査/アラートのみ | 画像保存しない。OCR→名寄せ。不一致はADMIN_ALERTS |

> 注：上記は現行docsで明示済みの主要HTTP APIの契約サマリ。

---

### 4.2 GAS Actions（v5 / Contract固定）

本リポジトリで運用する action を Contract として固定する。

| action | 主目的 | 提出ゲート | Idempotency（期待） | 永続化（主） | 備考 |
|---|---|---|---|---|---|
| `staff.register.status` | 登録状態照会 | なし | 不要 | 参照 | |
| `staff.register.upsert` | 登録upsert | なし | あり | STAFF_MASTER | 必須フィールドはregistration specに準拠 |
| `traffic.create` | 交通費登録 | ✅ | あり（重複排除） | TRAFFIC_LOG | v5: 画像は保存しない |
| `traffic.setPair` | OCR行き帰りペア | ✅ | あり推奨 | TRAFFIC_PAIR_LOG | |
| `status.get` | 月次状況 | 参照 | 不要 | 集計 | |
| `dashboard.staff.snapshot` | ダッシュボード集計 | 参照 | 不要 | 集計 | |
| `monthly.file.generate` | 月次レポート生成 | 参照 | 不要 | MONTHLY_EXPORT_LOG | |
| `unsubmitted.list` | 未提出一覧 | 参照 | 不要 | 集計 | |
| `hotel.intent.submit` | ホテル要否回答 | ✅ | あり推奨 | HOTEL_INTENT_LOG | |
| `hotel.intent.list` | ホテル回答一覧 | 参照 | 不要 | 参照 | |
| `hotel.intent.summary` | ホテル回答集計 | 参照 | 不要 | 集計 | |
| `hotel.intent.targets` | ホテル通知対象 | 参照 | 不要 | 参照 | |
| `hotel.user.upsert` | LINE状態反映 | なし | あり推奨 | STAFF_MASTER | unfollow等の状態反映 |
| `reminder.targets` | リマインド対象抽出 | 参照 | 不要 | 参照 | |
| `hotel.sendGuard` | ホテル送信ガード | なし | guard token | HOTEL_SENT_LOG | guard/result二段階 |
| `reminder.sendGuard` | リマインド送信ガード | なし | guard token | REMINDER_SENT_LOG | guard/result二段階 |
| `ops.log` | 監査/アラート記録 | なし | あり推奨 | LINE_MESSAGE_LOG / ADMIN_ALERTS | No Silent Failure |
| `shift.raw.ingest` | シフト原文保管 | ✅ | あり推奨 | SHIFT_RAW | |
| `shift.raw.recent` | シフト原文履歴 | 参照 | 不要 | 参照 | |
| `shift.parse.run` | シフト解析 | 参照 | 不要 | SHIFT等 | |
| `shift.parse.stats` | 解析状態件数 | 参照 | 不要 | 集計 | |

---

## 5. Error Codes（v5固定）

エラーコードは API schema の表をSoTとする。

| code | retryable | 意味 |
|---|---:|---|
| `E_REGISTER_REQUIRED` | false | 登録未完了（必須不足） |
| `E_STAFF_INACTIVE` | false | isActive=false |
| `E_DUPLICATE` | false（再送OK） | idempotencyKey重複 |
| `E_VALIDATION` | false | バリデーション不正 |
| `E_IMAGE_TOO_LARGE` | false | リサイズ後も上限超過（5MB） |

---

## 6. Images Contract（v5固定）

- 交通費OCR入力画像：保存しない（下書き生成のみ）
- ホテル予約スクショ：保存しない（名寄せ処理後に破棄）
- 経費領収書：Workerでリサイズしてストレージ保存、DBはURLのみ

---

## 7. No Silent Failure（監査契約）

監査/アラート記録失敗は必ずwarning等で可視化する。
