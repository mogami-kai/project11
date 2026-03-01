# Project1 Worker Release Notes

## Release
- Date: 2026-03-02 (JST)
- Component: worker
- Service: traffic-worker-v0

## Included commits (latest 4)
- 29d01ab chore: add deploy helper script
- 0ea0436 chore(wrangler): align vars with SoT and remove incorrect legacy LIFF vars
- 8cace58 Refactor: use getLiffUrls adapter across handlers
- cc84133 Fix auth/LIFF env resolution; add staff bearer auth and screen-aware LIFF IDs

## Scope (最低運用ライン)
- Worker → GAS 連携（traffic / expense 書き込み）
- LINE webhook 受信（署名なし拒否）
- LIFF 3画面（register / traffic / expense）
- /api/status（x-api-key / staff bearer）

## Changes (要点)
### 1) 認証の安定化（"LIFF_ID is missing" 根絶）
- Authorization: Bearer の扱いを整理し、dev/test 用に staff bearer を許可
- LIFF ID 解決に screen 指定を導入し、不要ルートで LIFF を必須にしない方向へ整理

### 2) LIFF HTML の LIFF_ID 解決を明確化
- /liff/traffic, /liff/expense がそれぞれ正しい LIFF_ID_* を参照するように固定

### 3) 環境変数のSoT整合（キー名のブレ排除）
- vars / secrets の責務分離（誤った LIFF_* URL vars の削除など）
- Secret不足（Slack系）の追加により、SoTとの一致を達成

## Verification (実コマンド根拠)
- repo clean: git status / git diff
- import: index/router import OK
- status:
  - x-api-key: 200
  - Bearer(staff): 200
- liff:
  - /liff/register: 200
  - /liff/traffic: 200
  - /liff/expense: 200
- webhook:
  - 署名なし: 401（拒否）
- submit:
  - 登録済み: traffic/create 200, expense/create 200
  - 未登録: traffic/create 403（E_REGISTER_REQUIRED）

## Known Notes / Follow-ups
- /api/admin/* を本番運用する場合は CF Access 系 Secret（キー名のみ）を追加
  - CF_ACCESS_TEAM_DOMAIN
  - CF_ACCESS_AUD
- Worker内で参照されない Secret は棚卸しして削除検討（外部依存が無いことを確認してから）
