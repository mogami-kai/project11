# LIFF Traffic v1

## 置換が必要な値
- `liff/index.html` の `LIFF_ID` を LINE Developers で作成した LIFF ID に置き換える
- `liff/index.html` の `WORKER_ENDPOINT` を Worker の `https://<worker-domain>` に置き換える

## テスト時の認証について
- 本番想定は `Authorization: Bearer <liff.getIDToken()>` で Worker に送信する
- 管理者テスト時は `x-api-key: <WORKER_API_KEY>` で API を叩ける
- `index.html` に `WORKER_API_KEY` を埋め込まない
- Worker API レスポンスは `{ ok, data|error, meta }` 形式（`meta.requestId` を含む）

## 動作確認
1. LIFF URL に `index.html` の公開URL（Pages等）を設定
2. LINEアプリ内で LIFF を開く
3. 提出方法（通常入力 / IC履歴 / まとめ入力）を選んで送信
4. `TRAFFIC_LOG` に1行追加されることを確認

## OCRについて
- OCR APIは `POST /api/ocr/extract` を利用
- Workerに `GEMINI_API_KEY` が未設定の場合、OCRは失敗扱いになりフォーム手入力へフォールバック
