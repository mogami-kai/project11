# v5 Gap Report — SoT vs 実装差分

作成日: 2026-02-27
監査者: senior-implementer (automated audit)
SoT優先順: v5_spec → registration_spec → api_schema → ops_rules → state-machine → action-contracts → data-boundary → DX_CORE

---

## SoT要点（20行以内）

1. LINE userId と本人情報（8必須項目）を確実に紐づける登録フローが必要
2. 登録完了まで提出系API（traffic/expense/hotel回答/shift）は E_REGISTER_REQUIRED で拒否
3. 交通費は manual/ocr が同一ログ。OCR 入力画像は保存しない（下書き生成のみ）
4. 経費領収書はWorkerでリサイズ（1200px/70%JPEG）→ ストレージ保存 → DBにはURLのみ
5. ホテル予約スクショはOCR後に破棄（保存しない）。不一致は ADMIN_ALERTS に必ず記録
6. Worker は公開 API Gateway。永続化の正本は GAS → Sheets（WorkerはSheetsを直接読み書きしない）
7. isActive / lineFollowStatus を運用に組み込み、一括配信は active+follow のみに限定
8. unfollow webhook で staff master の lineFollowStatus を更新
9. 提出系は idempotencyKey で二重登録を防止
10. ops.log / ADMIN_ALERTS の失敗は握りつぶさず warning で露出（No Silent Failure）

---

## 逸脱一覧（GAP-001〜GAP-005）

### GAP-001: Worker が EXPENSE_LOG に直接書き込み
| 項目 | 内容 |
|---|---|
| **SoT参照** | data-boundary.md §2「Workerが触ってはいけないもの」/ action-contracts.md §4.2 `expense.create` action |
| **実装場所** | `worker/src/handlers/expense.js` : `handleExpenseCreate()` L118-L170 |
| **現状** | `ensureSheetWithHeaders()` / `appendSheetValues()` で EXPENSE_LOG に直接書き込み。GAS action `expense.create` を呼んでいない |
| **影響** | 業務ルール・重複排除・監査がWorker/GAS に分裂。GAS側 idempotency/gate が効かない |
| **是正方針** | Worker内のSheets直書きを削除し、`callGas({ action: 'expense.create', ... })` に置き換える。GAS側に `expense.create` action（gate/idempotency/永続化）を実装 |
| **対応PR** | PR-A |

---

### GAP-002: Worker が STAFF_MASTER/SHIFT_ASSIGNMENTS/HOTEL_CONFIRMED_LOG/HOTEL_SCREENSHOT_RAW に直接読み書き
| 項目 | 内容 |
|---|---|
| **SoT参照** | data-boundary.md §2 / action-contracts.md §4.2 |
| **実装場所** | `worker/src/handlers/hotelScreenshot.js` : `processHotelScreenshot()` L234-L394 |
| **現状** | `ensureSheetWithHeaders()` で4シートのヘッダを保証し、`readSheetValues()` で STAFF_MASTER / SHIFT_ASSIGNMENTS / HOTEL_CONFIRMED_LOG を全件読み取り。`appendSheetValues()` で HOTEL_SCREENSHOT_RAW / HOTEL_CONFIRMED_LOG に直接書き込み |
| **影響** | 名寄せ・永続化責務の混在。GAS の登録ゲート・監査ロジックをバイパス |
| **是正方針** | OCR結果（extracted）と adminLineUserId を GAS action（新規: `hotel.screenshot.process`）に渡し、名寄せ・永続化をGAS側に集約。Worker は OCR だけ担当 |
| **対応PR** | PR-A |

---

### GAP-003: Worker が dashboard/monthly でフォールバックとして Sheets を直接参照
| 項目 | 内容 |
|---|---|
| **SoT参照** | data-boundary.md §2 / action-contracts.md §4.2 |
| **実装場所 (1)** | `worker/src/handlers/dashboard.js` : `handleDashboardMonth()` L97-L196 |
| **実装場所 (2)** | `worker/src/handlers/monthly.js` : `handleMonthlyExport()` L151-L296 |
| **現状 (dashboard)** | GAS `dashboard.staff.snapshot` 成功時はOK。**失敗時** に `EXPENSE_LOG` / `HOTEL_INTENT_LOG` / `HOTEL_CONFIRMED_LOG` を直接読み取る fallback が存在 |
| **現状 (monthly)** | GAS `monthly.file.generate` が成功すればOK。`E_UNSUPPORTED_ACTION` または接続失敗時に5シートを全件読み取り、新規スプレッドシートを作成・書き込みする fallback が存在 |
| **影響** | API経路の一貫性低下。GAS が正本の読み取り経路が二重化し、データ差異リスク |
| **是正方針** | フォールバックのSheets直アクセスコードを削除。GAS action の実装・安定性を確保し、失敗時は E_UPSTREAM を返す |
| **対応PR** | PR-A |

---

### GAP-004: auth.js に開発バイパス（STAFF_BEARER_TOKEN）が残存
| 項目 | 内容 |
|---|---|
| **SoT参照** | ops_rules.md §1（認証ルール）/ DX_CORE.md「認証バイパス」 |
| **実装場所** | `worker/src/auth.js` : `verifyLineIdToken()` L19-L23 |
| **現状** | `env.STAFF_BEARER_TOKEN` と Bearer token が一致すれば `userId='U_DEV_DUMMY_USER'` として無条件通過するバイパスが `// v5 Dev Bypass` コメントとともに残存 |
| **影響** | 本番環境でこの Secret を知る者は任意のリクエストを通過させられる。認可境界が弱くなる |
| **是正方針** | バイパスブロックをコードから完全削除（本番設定での無効化では不十分）。STAFF_BEARER_TOKEN 変数自体も wrangler.toml / .dev.vars から除去 |
| **対応PR** | PR-B |

---

### GAP-005: GAS の hotel.intent.submit が idempotencyKey 未対応
| 項目 | 内容 |
|---|---|
| **SoT参照** | v5_spec.md §2.3 Idempotency / action-contracts.md §4.2 `hotel.intent.submit` (あり推奨) / ops_rules.md §1 |
| **実装場所** | `gas/コード.js` : `handleHotelIntentSubmit_()` L1845-L1865 |
| **現状** | `userId+projectId+workDate+needHotel+smoking` を受け取り `appendRowSanitized_()` で追記するだけ。`idempotencyKey` のチェックがない。ユーザーが重複ポストバックを送ると二重登録される |
| **影響** | LINE のポストバックはネットワーク再送・ユーザー連打で重複が起きやすい。二重登録リスクあり |
| **是正方針** | GAS 側 `handleHotelIntentSubmit_()` に `userId+projectId+workDate` をキーとした重複チェック（既存行があれば上書き更新）を追加。Worker 側 `handleHotelPostbackEvent()` からも `idempotencyKey` を付与して呼ぶ |
| **対応PR** | PR-C |

---

## Done Criteria 監査サマリ（2026-02-27 時点）

| 項目 | 判定 | 備考 |
|---|---|---|
| 登録完了まで提出不可（APIレベル） | 条件付き達成 | `requireRegistered` 実装済み。ただし expense は GAS ではなく Worker 内で gate を呼んでいる |
| lineUserId 紐付け | 条件付き達成 | `staff.register.*` 経路で紐付け済み。auth バイパス除去後に完全達成 |
| 交通費 manual/ocr 同一ログ・画像保存しない | 達成 | traffic.js は GAS 経由で適切に実装済み |
| 領収書リサイズ保存・DBはURLのみ | 達成 | receipt.js でリサイズ処理あり。ただし EXPENSE_LOG への書き込み経路が Worker直書きで GAP-001 あり |
| ホテル必要/不要運用 | 達成 | hotel.push/postback実装済み |
| ホテルスクショOCR名寄せ・不一致ADMIN_ALERTS | 条件付き達成 | 機能実装済みだが Sheets直書き（GAP-002）あり |
| isActive / unfollow 運用組み込み | 達成 | hotel.user.upsert / hotel.intent.targets で対応 |
| idempotency 全提出系 | 部分達成 | traffic/expense/hotel.push は対応。hotel.intent.submit が未統一（GAP-005）|
| No Silent Failure | 達成 | warnings 露出実装済み |
| E2E 成功証跡 | 未証明 | スクリプト存在するが CI 合格記録なし |

---

## PR分割計画

### PR-A: Worker→GAS 経路統一（expense/hotelScreenshot/dashboard/monthly のSheets直アクセス排除）
**対応GAP:** GAP-001, GAP-002, GAP-003
**変更ファイル:**
- `worker/src/handlers/expense.js` — GAS `expense.create` action 呼び出しに置き換え
- `worker/src/handlers/hotelScreenshot.js` — OCR後の名寄せ・永続化を GAS `hotel.screenshot.process` action に委譲
- `worker/src/handlers/dashboard.js` — Sheets フォールバック削除、GAS 失敗時は E_UPSTREAM
- `worker/src/handlers/monthly.js` — Sheets フォールバック削除、GAS 失敗時は E_UPSTREAM
- `gas/コード.js` — `expense.create` / `hotel.screenshot.process` action を追加

### PR-B: authバイパス削除（コードから除去）
**対応GAP:** GAP-004
**変更ファイル:**
- `worker/src/auth.js` — STAFF_BEARER_TOKEN バイパスブロック削除

### PR-C: idempotencyKey 未統一 action の統一（hotel.intent.submit）
**対応GAP:** GAP-005
**変更ファイル:**
- `gas/コード.js` — `handleHotelIntentSubmit_()` に重複チェック追加
- `worker/src/handlers/hotel.js` — `handleHotelPostbackEvent()` で idempotencyKey 付与

### PR-D: E2Eスクリプト/テスト整備（再現可能な証跡）
**対応GAP:** Done Criteria「E2E成功未証明」
**変更ファイル:**
- `scripts/e2e_v5.sh` — 全E2Eをワンコマンドで実行
- `scripts/deploy_all.sh` — テスト→デプロイをワンコマンドで実行
- `artifacts/` — 実行ログ保存先

---

## 修正の原則

- 既存 Contract（api_schema / action-contracts）を壊さない
- Sheets ヘッダ変更・列移動・削除禁止（追記のみ、末尾追加）
- 後方互換・migration 不要を原則とする
