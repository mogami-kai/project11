# gas

## 役割
- `doPost` actionディスパッチ
- 業務ロジック実行
- Google Sheets永続化
- 監査ログ管理

## 境界契約
- Workerからの `action/token/requestId/data` を唯一の入力とする。
- Script Properties の `STAFF_TOKEN` で入口認証する。

## 現状課題
- `コード.js` 単一ファイルに責務が集中している。
- v6では `actions/`, `domain/`, `infra/sheets/` への分割を前提とする。
