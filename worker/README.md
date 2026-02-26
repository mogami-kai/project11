# worker

## 役割
- 公開API Gateway
- 認証・認可
- idempotency制御
- LINE/Gemini/R2連携
- GAS action 呼び出し

## 境界契約
- Workerは業務永続化を直接持たない。
- 業務判定・集計・重複排除の正本はGAS actionに置く。

## 現状の移行対象
- `src/handlers/expense.js`（Sheets直接書込）
- `src/handlers/hotelScreenshot.js`（Sheets直接読書込）
- `src/handlers/dashboard.js`（Sheets直接読込フォールバック）
- `src/handlers/monthly.js`（Sheets直接集計フォールバック）
