# e2e

現行E2Eスクリプトは `scripts/` にあります。

- `scripts/e2e_health.sh`
- `scripts/e2e_traffic_idempotency.sh`
- `scripts/e2e_idempotency_v5.sh`
- `scripts/e2e_full_system.sh`

移行ルール:

- 新規E2Eは本ディレクトリ配下に作成
- 既存スクリプトは非破壊で段階移行（呼び出し互換を維持）
