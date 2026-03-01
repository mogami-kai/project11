# Codex 実行プロンプト（段階実行 / Gate方式）

以下をそのまま Codex（もしくは Claude Code/Cursor）に貼ってください。
このプロンプトは「確定版 統合仕様書 v5.0」を正本とし、P0を**段階的に**実装してGoに近づけるための実行手順です。

---

## SYSTEM / ROLE
あなたは本リポジトリのリリース担当AIです。
推測で進めません。必ず実ファイルと差分を確認してから作業します。

## INPUTS（参照必須）
- docs/ スコープ: 「確定版 統合仕様書 v5.0」を正本とする（P0全件完了までNo-Go）。
- 本プロンプトが指定する Gate 0〜5 をこの順に実行する。
- 1 Gate = 1 PR（または1コミット系列）で提出する。Gate間で差分を混ぜない。

## GLOBAL RULES（絶対）
1. **推測禁止**：ファイルを開いて根拠行を示す。
2. **最小変更**：Gateの目的に不要なリファクタは禁止。
3. **Fail-Fast**：テスト/実行で失敗したら、そのGateを修正してから進む。
4. **改変禁止領域**：既存の契約（action名・レスポンス形・既存シートの列順）を壊さない。
5. **証跡**：各Gate完了時に `docs/runlogs/<GATEX_...>.md` を追加し、変更点・検証結果・コマンドログを記録する。
6. **セキュリティ**：秘密鍵/トークンをログやファイルに出さない。

---

## GATE 0: 現状把握（必須）
### 0-1) 状態確認
- `git status --short`
- `git diff`
- 既存のlint/syntaxチェック（あれば）

### 0-2) 入口の確認
- Worker: ルータ/認証/ハンドラの入口を特定（router/auth/webhook/broadcast/admin）
- GAS: doPostのaction dispatch入口と主要ハンドラを特定

### 0-3) 生成物
- `docs/runlogs/GATE0_BASELINE.md`
  - 実行したコマンド
  - 差分が空である証跡
  - 入口ファイルと行番号（見つかった範囲）

Gate 0が完了したら停止し、要約して報告。

---

## GATE 1: P0-2（/api/admin 経路のSlack署名限定）
目的：/api/admin/* を **Slack署名経路のみ** に制限し、legacy_api_key を廃止し、ADMIN_ALLOWED_IPS 未設定はfail-closeにする。

### 実装タスク
- Worker側で /api/admin/* へのアクセス判定を「Slack署名検証済み」に限定
- api-keyベースで admin に到達する経路があれば廃止
- ADMIN_ALLOWED_IPS が未設定/空なら拒否

### 検証
- E2E: T06 相当（actorSlackUserId偽装が無効、署名由来IDのみ利用）

### 生成物
- `docs/runlogs/P0-2_DONE.md`

完了したら停止し、要約して報告。

---

## GATE 2: P0-4（月次 lock fail-close の全面適用）
目的：lockシート欠損時の自動再作成禁止、submit/export全系にlock検証、CLOSING中は書込み拒否。

### 実装タスク
- GASの isMonthLocked_ で「欠損=E_SCHEMA_BROKEN」へ（ensureで作らない）
- traffic.create / expense.create / hotel.intent.submit / monthly.export で事前lock検証
- CLOSING中は E_CLOSING_MONTH

### 検証
- T02/T03/T12

### 生成物
- `docs/runlogs/P0-4_DONE.md`

完了したら停止し、要約して報告。

---

## GATE 3: P0-3（GAS submit gate）
目的：GAS直叩きでも登録/active/本人一致/lock を必ずチェックし、Worker gate回避を無効化。

### 実装タスク
- traffic/expense/hotel submit 系の冒頭で
  - staffId存在 + ACTIVE
  - lineUserId一致
  - lock検証（Gate2で共通化できるなら共通関数化）

### 検証
- T07

### 生成物
- `docs/runlogs/P0-3_DONE.md`

完了したら停止し、要約して報告。

---

## GATE 4: P0-5（webhook 再処理可能化）
目的：成功後にのみidempotency記録、失敗時は500で再送可能にする。

### 実装タスク
- Workerのwebhook処理で「事前予約」を廃止
- 重複チェックのみ先に行い、成功後に記録
- GAS転送が失敗したら 500 を返す

### 検証
- T05

### 生成物
- `docs/runlogs/P0-5_DONE.md`

完了したら停止し、要約して報告。

---

## GATE 5: P0-1（broadcast recipient単位冪等性）
目的：recipient単位の送信済み記録 + 経路分離で重複配信を防止。

### 実装タスク
- BROADCAST_LOG_RECIPIENTS を追加/利用
- send: sent=false のみ送信、成功時に sent=true を即反映
- finalize: 全員sent=trueでSENT確定

### 検証
- T04

### 生成物
- `docs/runlogs/P0-1_DONE.md`

完了したら停止し、要約して報告。

---

## OUTPUT FORMAT（各Gate報告の形式）
- 変更したファイル一覧（最小）
- 重要diff（要点のみ）
- 実行したコマンドを（テスト含む）
- 期待結果 vs 実結果
- 次Gateに進めるか（YES/NO、理由）
