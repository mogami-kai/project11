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

- 追記用セクション（既存契約の意味変更なしで加筆する）

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
