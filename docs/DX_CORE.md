# DX Core Audit Memo (v5)

このファイルは入口ではなく、**実装監査・逸脱点メモ**です。仕様の正本は [README.md](./README.md) から辿るSoT群です。

## SoT優先順位

- データ方針とDone Criteria: [v5_spec.md](./v5_spec.md)
- 登録要件: [registration_spec.md](./registration_spec.md)
- HTTP入出力契約: [api_schema.md](./api_schema.md)
- 運用ルール: [ops_rules.md](./ops_rules.md)
- 状態遷移: [state-machine.md](./state-machine.md)
- 責務契約: [action-contracts.md](./action-contracts.md)
- データ境界: [data-boundary.md](./data-boundary.md)

## システム構成スナップショット

```text
LINE User/Admin -> Worker (公開API) -> GAS (業務ロジック) -> Google Sheets (SoR)
```

原則責務:
- Worker: 認証、ルーティング、idempotency、外部API連携
- GAS: 業務判定、永続化、監査記録
- Sheets: System of Record

## 逸脱点（2026-02-26 時点 → 2026-02-27 是正済み）

| 区分 | SoT参照 | 是正状況 | 是正内容 |
|---|---|---|---|
| Worker直書き (GAP-001) | [data-boundary.md](./data-boundary.md) | ✅ 是正済み (PR-A / 2026-02-27) | `expense.js` を GAS `expense.create` action 経由に変更 |
| Worker直読み書き (GAP-002) | [data-boundary.md](./data-boundary.md) | ✅ 是正済み (PR-A / 2026-02-27) | `hotelScreenshot.js` の名寄せ・永続化を GAS `hotel.screenshot.process` action に委譲 |
| Workerフォールバック (GAP-003) | [data-boundary.md](./data-boundary.md) | ✅ 是正済み (PR-A / 2026-02-27) | `dashboard.js` / `monthly.js` の Sheets 直接参照フォールバックを削除 |
| 認証バイパス (GAP-004) | [ops_rules.md](./ops_rules.md) | ✅ 是正済み (PR-B / 2026-02-27) | `auth.js` から `STAFF_BEARER_TOKEN` バイパスブロックをコード削除 |
| idempotency未統一 (GAP-005) | [v5_spec.md](./v5_spec.md) | ✅ 是正済み (PR-C / 2026-02-27) | GAS `handleHotelIntentSubmit_()` を upsert semantics（userId+projectId+workDate キー）に変更 |

## Done Criteria 監査（2026-02-27 是正後）

| 項目 | 判定 | 根拠 |
|---|---|---|
| 登録完了まで提出不可 | ✅ 達成 | `requireRegistered` 実装済み。authバイパス削除で全経路で有効化 |
| lineUserId 紐付け | ✅ 達成 | `staff.register.*` 経路で紐付け。authバイパス削除済み |
| idempotency保証 | ✅ 達成 | traffic/expense/hotel.intent.submit/hotel.push 全て対応済み |
| Sheet破壊なし | ✅ 達成 | 追記のみ・ヘッダ変更禁止・後方互換を維持 |
| 二重登録なし | ✅ 達成 | 全提出系に idempotency 実装済み |
| E2E成功 | 準備完了 | `scripts/e2e_v5.sh` 作成済み。本番環境での実行で証明可能 |

## 運用ルール

1. SoTと実装の差分は、まずこのファイルへ追記する。
2. 逸脱は「影響」と「是正方針」を必ずセットで記録する。
3. 逸脱解消後は、このファイルと関連SoTの両方を更新する。
