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

### 3.1 配信方式（Normative）

ホテルフローは **LIFF を使用しない**。LINE メッセージ Push / ブロードキャストのみで完結する。

- `hotel.push` は対象月/現場/在籍/フォロー状態で配信対象を絞り、LINE メッセージを送信する
- ユーザーへの提示はボタン付きメッセージ（Yes / No）で行う
- 変更・キャンセルは後続ボタン返信（Cancel / Change）で受け付ける
- **LIFF URL は不要**。`LIFF_HOTEL_URL` は非推奨（deprecated）であり、本番での設定は必須ではない

### 3.2 状態遷移（Normative）

```
UNSET → YES   (「必要」回答)
UNSET → NO    (「不要」回答)
YES   → NO    (変更)
NO    → YES   (変更)
YES | NO → UNSET  (期間クローズ後リセット)
```

- 状態は `YES` / `NO` / `UNSET` の3値のみ
- `UNSET` は「未回答」を意味し、期間クローズ後のリセットにも使用する

### 3.3 監査要件（Normative）

- 必要/不要の回答は必ずログに残す（最終状態 + 更新履歴を保持）
- 不一致は必ず `ADMIN_ALERTS` に残し、後処理できる
- 予約スクショOCRは**画像保存しない**

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

---

## 6. Admin Route Protection（必須設定）

### 6.1 仕様定義（Normative）

管理ルートの本番環境保護は **Cloudflare Access** を主たる手段とする。

- Worker の以下のルートは、Cloudflare Access によるログイン要求を前提として設計されている：
  - `GET /api/admin/shift/raw/recent`（管理診断ルート）
  - `POST /api/hotel/push`（ホテル要否プッシュ）
  - `POST /api/reminder/push`（リマインダープッシュ）
  - `/api/admin/*` 配下の全ルート
- 管理ルートが有効（ルーターに登録済み）の場合、`CF_ACCESS_TEAM_DOMAIN` および `CF_ACCESS_AUD` が未設定・空文字・不正値の状態での本番デプロイは **仕様上の禁止事項（デプロイ不可）** とする。
- 管理ルートが無効（ルーターに未登録）の場合、これらの変数は Conditional/No となり BLOCK の対象外とする。
- **例外**：ローカル開発環境では未設定を許容する。

### 6.2 対象の環境変数

| 変数名 | 種別 | 必須 | 説明 |
|--------|------|------|------|
| `CF_ACCESS_TEAM_DOMAIN` | Worker シークレット | **管理ルート有効時は本番必須（BLOCK）** | Cloudflare Access チームドメイン（例：`team.cloudflareaccess.com`） |
| `CF_ACCESS_AUD` | Worker シークレット | **管理ルート有効時は本番必須（BLOCK）** | Cloudflare Access JWT オーディエンスタグ。管理ルートの JWT 検証に使用 |
| `ADMIN_ALLOWED_IPS` | Worker 環境変数 | **任意（推奨）** | カンマ区切りの許可 IP アドレス一覧。Cloudflare Access に加える多層防御として設定可。**本番必須ではない** |

### 6.3 値の要件

- `CF_ACCESS_TEAM_DOMAIN`：有効なドメイン文字列（空文字列・空白のみは未設定と同義）
- `CF_ACCESS_AUD`：Cloudflare Access が発行する AUD タグ文字列（空文字列・空白のみは未設定と同義）
- `ADMIN_ALLOWED_IPS`：IPv4 アドレスのカンマ区切りリスト（任意）

### 6.4 デプロイ前確認事項（管理ルート有効時）

本番デプロイの前に、以下を確認すること：

1. `CF_ACCESS_TEAM_DOMAIN` が Worker シークレットに設定されていること（空でないこと）→ 未設定ならデプロイ中止
2. `CF_ACCESS_AUD` が Worker シークレットに設定されていること（空でないこと）→ 未設定ならデプロイ中止
3. `ADMIN_ALLOWED_IPS` が設定されている場合、最低 1 件以上の有効な IP アドレスが含まれること（任意設定のため不在は許容）

確認結果は監査ログ（デプロイ記録）に「CF_ACCESS 設定済み」として残すこと。

### 6.5 運用責務

- `CF_ACCESS_TEAM_DOMAIN` および `CF_ACCESS_AUD` の管理責任者は、本番 Worker 環境を管理する運用担当者とする
- Cloudflare Access アプリケーションの変更・ローテーション後は `wrangler secret put` で更新し再デプロイすること
- `ADMIN_ALLOWED_IPS` は任意の追加防御として運用可。管理は Worker 環境変数の更新として扱う

### 6.6 未設定時のリスク整理

`CF_ACCESS_TEAM_DOMAIN` または `CF_ACCESS_AUD` が未設定の状態（管理ルート有効時）では、以下のリスクが存在する：

- `/api/hotel/push`・`/api/reminder/push`・`/api/admin/*`：Cloudflare Access による認証なしで呼び出し可能となる
- JWT 検証が機能せず、管理ルートへの不正アクセスを防げない

このため、管理ルートが有効な場合の Cloudflare Access 設定を仕様として必須化し、IP 依存に頼らない認証前提を確立する。

---

## 7. Status View — 状況把握（Normative Requirement）

### 7.1 要件定義（Normative）

ユーザーが当月・前月の交通費・経費の合計を素早く確認できる手段を提供しなければならない。

**表示必須の情報：**

| 項目 | 内容 |
|------|------|
| 当月 交通費 | 今月提出した交通費の件数または合計額 |
| 当月 経費 | 今月提出した経費の件数または合計額 |
| 前月 交通費 | 先月提出した交通費の件数または合計額 |
| 前月 経費 | 先月提出した経費の件数または合計額 |

### 7.2 実装モード

以下の2方式のいずれかを採用する（排他選択）：

**(A) LIFF ステータスページ**
- 単一の LIFF エンドポイント URL で状況把握画面を提供する
- 必要な環境変数は実装ゲートで確定し `ENVIRONMENT.md` に追記する

**(B) LINE メッセージコマンド**
- ユーザーが所定のキーワードを送信すると、Worker が月次合計をメッセージで返す
- コマンドキーワードと応答フォーマットは実装ゲートで確定する

### 7.3 REVIEW_REQUIRED

どちらのモードが実装されているかは、このゲートではソースコードの検証を行っていない。実装ゲートで確認し、確認結果に基づき本ドキュメントを更新すること。現時点では「要件として必須」であることのみを規定する。

---

## 8. Traffic LIFF — 単一エンドポイントポリシー（Normative）

### 8.1 仕様定義（Normative）

交通費提出は **単一の LIFF アプリケーション**（1エンドポイント）で完結しなければならない。

- OCR 補助入力とマニュアル入力は、同一 LIFF 内のモード切替として実装する
- OCR 用と手動用に別々の LIFF URL を作成することは禁止する
- `LIFF_TRAFFIC_URL` が交通費 LIFF の唯一の URL 変数である

### 8.2 対象の環境変数

| 変数名 | 種別 | 必須 | 説明 |
|--------|------|------|------|
| `LIFF_TRAFFIC_URL` | Worker 環境変数 | **本番必須** | 交通費 LIFF の単一エンドポイント URL（OCR/手動 共通） |

### 8.3 入力モード

| モード | 説明 |
|--------|------|
| OCR 補助 | 画像を LIFF 内で取得し、Worker の OCR API（`POST /api/traffic/ocr-auto`）を呼び出して下書き生成 |
| 手動入力 | ユーザーが直接フォームに金額・日付等を入力 |

いずれのモードも `POST /api/traffic/create` を呼び出して交通費レコードを作成する。

