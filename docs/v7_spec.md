# Project1 v7 Spec (Slack Admin + Weekly Broadcast)

## 0. Scope
v7 は v5 の契約を維持したまま、以下を **加算実装**する。

- Slack を管理コンソール化（Slash/Block Kit/Modal）
- 週次現場文面の解析と配信
- WEEK_ASSIGNMENTS を業務割当 SoT として利用
- LIFF 交通費画面の割当自動セット + 手動変更
- 月次ロック運用（LOCKED + ADJUSTMENT方針）

v5 非破壊条件:

- 共通レスポンス `ok/data/meta` と `ok=false error/meta` を維持
- 提出ゲート `E_REGISTER_REQUIRED` / `E_STAFF_INACTIVE` を維持
- Data boundary（Sheets SoR / GAS SoT / Worker API Gateway / LIFF UI）を維持
- 画像ポリシー（交通OCR・ホテル画像は保存しない、経費領収書はリサイズURL保存）を維持

## 1. V7 Architecture

- Worker:
  - Slack / LINE 署名検証
  - HTTP ルーティング
  - idempotency lock/cache
  - LINE Messaging API 配信
- GAS:
  - 週次文面パース
  - STAFF/SITE 名寄せ
  - Sheets 永続化（WEEK_ASSIGNMENTS / BROADCAST_LOG / FAILED_JOBS）
  - 監査ログ / 役割判定 / CAS判定
- Sheets:
  - CORE_DB（ROLE_BINDINGS, SETTINGS, AUDIT_LOG, STAFF_MASTER, SITE_MASTER）
  - MONTH_DB（*_YYYY_MM パーティション）

## 2. New API (Worker)

- `GET /api/my/week/assignments`
- `POST /api/admin/broadcast/preview`
- `POST /api/admin/broadcast/send`
- `POST /api/admin/broadcast/retry-failed`
- `POST /api/slack/command`
- `POST /api/slack/interactive`

## 3. New GAS Actions

- `my.week.assignments`
- `admin.v7.setup`
- `admin.role.resolve`
- `admin.broadcast.preview`
- `admin.broadcast.send.prepare`
- `admin.broadcast.send.finalize`
- `admin.broadcast.retryFailed.prepare`
- `admin.broadcast.retryFailed.finalize`
- `admin.approval.pending`
- `admin.approval.decide`
- `admin.monthly.close.export`
- `admin.hotel.summary`
- `admin.audit.lookup`

## 4. Weekly Broadcast Parse Rules

入力例:

- `現場名（26日～1日）`
- `DL: ... / CL: ... / CA: ...`
- `27日A→28日B→1日C`

ルール:

1. `targetMonth(YYYY-MM)` を必須入力にする。
2. `fromDay <= toDay` は targetMonth 内日付に解決。
3. `fromDay > toDay` は跨月とみなし、`fromDay..月末` を前月、`1..toDay` を targetMonth に解決。
4. スタッフ名は v5 正規化ロジックを再利用して STAFF_MASTER に名寄せ。
5. 名寄せ不可は `missingStaff/unmatchedNames` へ出力し、配信対象から除外。
6. SITE_MASTER 未一致や `openChatUrl` 欠落は preview に明示。
7. preview 実行時は `BROADCAST_LOG_YYYY_MM` に `status=DRAFT` を upsert し、parse diagnostics を保持する。

weekId 定義:

- `ISO Week` 形式（例: `2026-W09`）
- 週ブロック開始日をアンカーに算出

## 5. Monthly Partition Tables (v7)

- `WEEK_ASSIGNMENTS_YYYY_MM`
- `BROADCAST_LOG_YYYY_MM`
- `FAILED_JOBS_YYYY_MM`
- `APPROVAL_QUEUE_YYYY_MM`
- `MONTHLY_LOCK_YYYY_MM`

COREテーブル:

- `ROLE_BINDINGS`
- `AUDIT_LOG`
- `SETTINGS`

## 6. Security & Ops

### 6.1 Slack Security and Role Gate

- 署名: `x-slack-signature`, `x-slack-request-timestamp` を必須検証
- ロール: ROLE_BINDINGS の `ADMIN/APPROVER/VIEWER`
- 権限制御:
  - preview: `VIEWER+`
  - send/retry/approval decision: `APPROVER+`
  - monthly close/export: `ADMIN`
- Slack retry / 二重クリック対策:
  - Worker idempotency key
  - GAS operationId + state/CAS 判定

### 6.2 Security & Ops (Addendum)

認証運用:

- Slack endpoint（`/api/slack/command`, `/api/slack/events`, `/api/slack/interactive`）は Slack 署名検証（`x-slack-signature`, `x-slack-request-timestamp`）で受け付ける。`x-api-key` は不要。
- 上記以外の認証対象 endpoint は `x-api-key` または LIFF `idToken`（`Authorization: Bearer ...`）で認証する。
- `/api/admin/broadcast/*` の非Slack経路は `x-api-key` 認証 + adminチェック（IP許可含む）で受け付ける。

OCR エラーポリシー:

- `GEMINI_API_KEY` 未設定時は `503`（`E_OCR_DISABLED`）を返す。
- 入力欠落・不正（例: `imageBase64` 欠落、`mimeType` 不正、`workDate` 不正）は `400`（`E_BAD_REQUEST` または `E_VALIDATION`）を返す。
- OCR失敗時は `502`（`E_OCR_FAILED` など）で返し、Worker はクラッシュさせない。

`admin.v7.setup` 実行手順:

- 実行者: `ROLE_BINDINGS` で `ADMIN` ロールを持つ Slack actor（`actorSlackUserId` 必須）。
- 実行タイミング: v7導入時の初期セットアップ時。固定シート作成は原則1回でよい。
- 実行内容:
  - 固定シート（`ROLE_BINDINGS`, `SETTINGS`, `AUDIT_LOG`, `STAFF_MASTER`, `SITE_MASTER`）を存在保証。
  - `createMonthlyPartitions=true` の場合のみ `targetMonth` 1か月分の月次パーティションを作成（全月自動作成はしない）。
  - `ROLE_BINDINGS` の初期行（seed）は自動作成しない。
- 必要権限: GAS action `admin.v7.setup` は `ADMIN` ロール必須。

月次ファイル運用の入口（現状）:

- 自動実行: 未実装（Workerの `scheduled` は reminder 実行のみ）。
- 手動実行:
  - `POST /api/monthly/export` -> GAS `monthly.file.generate`
  - Slack `/tl monthly close YYYY-MM` -> GAS `admin.monthly.close.export`（内部で `monthly.file.generate` 実行 + `MONTHLY_LOCK_YYYY_MM` 更新）

## 7. State Rules (v7 Additions)

- Approval: `PENDING -> APPROVED|REJECTED` のみ許可
- Broadcast: `DRAFT -> PREPARED -> SENT|PARTIAL`
- `SENT/PARTIAL` 済みの再 finalize は idempotent に同値応答
- Month lock: `OPEN -> LOCKED`
- `LOCKED` 月への直接更新は禁止。
  - 事後修正は翌月 ADJUSTMENT レコードとして扱う

## 8. LIFF Traffic Behavior

- `my.week.assignments` で勤務日/現場候補を取得
- 交通費画面は対象日の割当を自動セット
- ユーザー手動変更を許可
  - 割当現場候補 + `その他/臨時`
  - `その他/臨時` 選択時は memo 必須
- workDate は月次ルーティングの SoT とする

## 9. No Silent Failure

- 配信失敗は `FAILED_JOBS_YYYY_MM` に記録
- retry API で failed のみ再送
- 監査失敗は warning/アラートとして露出
