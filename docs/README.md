# Project1 Docs SoT (v5)

このファイルは `docs/` の唯一の入口です。仕様変更時は **docsを先に更新**し、実装はその後に追従させます。

## 読む順番

1. [v5_spec.md](./v5_spec.md)（v5 Done Criteria）
2. [registration_spec.md](./registration_spec.md)（登録要件）
3. [api_schema.md](./api_schema.md)（HTTP API I/O 契約）
4. [ops_rules.md](./ops_rules.md)（運用ルール）
5. [state-machine.md](./state-machine.md)（状態遷移）
6. [action-contracts.md](./action-contracts.md)（HTTP/GAS 契約マップ）
7. [data-boundary.md](./data-boundary.md)（責務境界）
8. [DX_CORE.md](./DX_CORE.md)（実装監査・逸脱点メモ）

## SoT一覧

| ファイル | 役割 |
|---|---|
| [v5_spec.md](./v5_spec.md) | v5の目的・Done Criteria・データ方針の正本 |
| [registration_spec.md](./registration_spec.md) | 登録必須項目とバリデーションの正本 |
| [api_schema.md](./api_schema.md) | HTTP APIの入出力契約（JSON形状）の正本 |
| [ops_rules.md](./ops_rules.md) | 運用時の共通ルール（Idempotency/配信/監査） |
| [state-machine.md](./state-machine.md) | スタッフ状態・提出ゲート・送信ガードの遷移定義 |
| [action-contracts.md](./action-contracts.md) | HTTP APIとGAS actionの責務境界・契約対応表 |
| [data-boundary.md](./data-boundary.md) | Worker/GAS/Sheetsのデータ境界ルール |
| [DX_CORE.md](./DX_CORE.md) | 実装監査メモ（SoTからの逸脱点と是正状況） |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | 環境変数の正本（全変数の分類・必須条件・デプロイチェックリスト） |
| [ENVIRONMENT_RUNBOOK.md](./ENVIRONMENT_RUNBOOK.md) | 環境構築・シークレット設定・デプロイ前検証の手順書 |
| [ENVIRONMENT_PROMPT.md](./ENVIRONMENT_PROMPT.md) | AI監査プロンプト（環境変数の自動検証ゲート指示） |

## 更新ルール（docs -> code）

1. 仕様変更は必ずSoTファイルを先に更新する。
2. コード変更PRは、どのSoTに準拠した変更かを明記する。
3. SoTと実装がずれた場合、仕様を上書きせず [DX_CORE.md](./DX_CORE.md) に逸脱として記録する。
4. 逸脱を解消したら DX_CORE の該当項目を更新し、必要ならSoT本文に反映する。
5. docs内リンクは相対パスで記述する（`./file.md`）。

## docs運用ポリシー

- `docs/` は原則 `*.md` のみを置く。
- `xlsx` などのバイナリは `docs/` に置かず、必要なら `samples/` に配置する。
- 廃止したが参照価値のある文書は `docs/archive/` に退避する。
