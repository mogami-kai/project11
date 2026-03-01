# Readiness Status & Execution Plan (v5.0 → Go) — 追記ドキュメント

このファイルは「確定版 統合仕様書 v5.0」を"正本（憲法）"として運用する前提で、**現在の状態（No-Go）**と、**Go までの実装タスクを段階的に実行する手順**を固定する。
- v5.0は **P0全件完了後にGo** と定義されている（現状はNo-Go）。
- v6.0は v5.0を破壊せずに積み上げる追加弱点と改善案である。

---

## 0. 現在の結論（固定）

- **方針は固まっている**：P0の設計が具体化され、E2Eシナリオまで定義済み。
- **ただし実装が追いつくまでNo-Go**：P0未完了の状態で本番投入は禁止。

> 以後、本ファイルのチェックリストを "実装の進捗" の単位（Gate）として扱う。
> 新機能の追加は **P0完了までは禁止**（P0を増やさない）。

---

## 1. Go / No-Go 基準（P0）

### 1.1 Go 条件（P0-1〜P0-5 全クリア）
P0は以下（全て v5.0に明記）。

- **P0-1** broadcast重複配信の修正（recipient単位送信記録 + finalize専用経路）
- **P0-2** /api/admin/* を Slack署名経路のみに制限（legacy_api_key廃止 + ADMIN_ALLOWED_IPS必須）
- **P0-3** GAS側 submit gate 追加（registration/active + actor一致）
- **P0-4** 月次lock fail-close を submit/export に全面適用（欠損=エラー）
- **P0-5** webhook失敗の再処理可能化（成功後にidempotency記録、失敗は500で再送）

### 1.2 No-Go 継続条件（いずれか放置で禁止）
- legacy_api_key 経路を残したまま投入
- STAFF_TOKEN単一境界のままGAS直叩きを許容
- lock欠損でOPEN復帰する挙動を放置
- broadcast重複配信リスクを放置
- webhook失敗が再処理不能のまま

---

## 2. 段階的実行（Gate方式）

### Gate 0: 現状把握（必須）
- `git status --short` が空であること
- `git diff` が空であること
- 既存のlint/syntaxチェックが通ること（ある場合）
- 主要actionの一覧と入口（Worker/GAS/Slack）を把握してメモ化

**成果物**：`docs/runlogs/GATE0_BASELINE.md`（差分0の証跡）

---

### Gate 1: P0-2（admin経路）から入る（推奨）
理由：攻撃経路が明確で、境界が単純。先に塞ぐと後工程が安全になる。

- /api/admin/* は Slack署名のみ許可
- legacy_api_key 経路の廃止
- ADMIN_ALLOWED_IPS の強制（未設定はfail-close）

**成果物**
- テスト: **T06** パス
- `docs/runlogs/P0-2_DONE.md`

---

### Gate 2: P0-4（月次 fail-close）を徹底
理由：運用破綻（閉月汚染）を最優先で防ぐ。

- lockシート欠損時は自動再作成しない（E_SCHEMA_BROKEN）
- traffic/expense/hotel/export 全てで lock判定（CLOSEDなら拒否）
- CLOSING中は書き込み拒否（E_CLOSING_MONTH）

**成果物**
- テスト: **T02/T03/T12** パス
- `docs/runlogs/P0-4_DONE.md`

---

### Gate 3: P0-3（GAS submit gate）を追加
理由：Worker gate回避（GAS直叩き）の根治。

- staffIdがSTAFF_MASTERに存在し status=ACTIVE
- 対象月がCLOSEDでない（fail-close）
- lineUserId一致（本人以外拒否）

**成果物**
- テスト: **T07** パス
- `docs/runlogs/P0-3_DONE.md`

---

### Gate 4: P0-5（webhook 再処理可能化）
- idempotencyは「成功確認後」に記録
- 失敗時は500でLINE再送を許可（最大3回）
- 既に処理済みなら200（正常冪等性）

**成果物**
- テスト: **T05** パス
- `docs/runlogs/P0-5_DONE.md`

---

### Gate 5: P0-1（broadcast recipient単位記録）
- recipient単位の送信済み記録（BROADCAST_LOG_RECIPIENTS）
- send/finalize 経路分離
- sent=false のみ送信（再送でも重複しない）
- operationId + recipientId ロック

**成果物**
- テスト: **T04** パス
- `docs/runlogs/P0-1_DONE.md`

---

## 3. P1以降（v6.0積み上げ方針）

P0完了後に、以下を **破壊せず追加** で積む。
- 秘密情報・キー管理（Rotation/失効/分離）
- DB ACL / シート保護 / 改ざん検知
- PIIマスキング（Slack表示）
- 監視・アラート・Runbook
- 制限値（GAS/Sheets/Slack/LINE）明文化
- requestId E2E トレーシング / 不変ID設計

**注意**：P1は"Go後のリリースサイクル"で実施（v5.0にも期限が明記）。
