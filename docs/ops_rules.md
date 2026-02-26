# Ops Rules (v5)

## 1. Idempotency
- 提出系は全て `idempotencyKey` を受け付ける
- 再送は重複作成しない
- 重複時は同一結果の再返却が原則（ユーザー体験を壊さない）

---

## 2. Staff Status

| 状態 | 配信 | 提出 |
|------|------|------|
| `isActive=false` | 対象外 | 拒否して管理者誘導（v5推奨） |
| `lineFollowStatus=unfollow` | 対象外 | 提出はOK（ただし配信は飛ばさない） |

- unfollow webhook を受けて状態更新し、送信失敗を減らす

---

## 3. Hotel Operations
- `hotel.push` は対象月/現場/在籍/フォロー状態で配信対象を絞る
- 必要/不要の回答は必ずログに残す
- 予約スクショOCRは**画像保存しない**
- 不一致は必ず `ADMIN_ALERTS` に残し、後処理できる

---

## 4. Images（経費立替 領収書）
- 高画質原本をDBに保存しない
- Worker 受信時にリサイズ処理を行ってからストレージへアップロード
- リサイズ仕様は [v5_spec.md §2.2](./v5_spec.md) に準拠

```
入力  : JPEG / PNG / HEIC / WEBP（any）
出力  : JPEG, 最大1200px, 品質70%
保存  : R2 or GCS（DBにはURLのみ）
```

---

## 5. No Silent Failure
- `ops.log` / `ADMIN_ALERTS` などの監査・アラート記録が失敗したら：
  - レスポンスに `warning` を返す
  - 重要処理は `partial` / `fail` を固定

TODO(v5): `partial`/`fail` の判定基準をエンドポイント別に明文化する（監査失敗のみか、業務本体失敗も含むか）。
