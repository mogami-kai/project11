# Data Boundary (v5) — Worker / GAS / Sheets

このドキュメントは、Project1の **データ境界（どの層が何に触れてよいか）** を固定し、
責務混在・事故・将来のSQL移行コストを最小化する。

参照（SoT）:
- [DX Core Audit Memo](./DX_CORE.md)
- [Ops Rules (v5)](./ops_rules.md)
- [v5 Spec (Final)](./v5_spec.md)
- [API I/O Schema](./api_schema.md)

---

## 0. 原則（結論）

- **永続データ（System of Record）は Google Sheets**。
- **業務ロジックと永続化（書き込み）の正本は GAS**。
- **Workerは公開API Gatewayであり、認証/オーケストレーション担当**。
- **LIFFはUIのみ**（永続化も業務判定もしない）。

---

## 1. Workerが触ってよいもの

### 1.1 認証・トークン（短命/秘匿）
- `Authorization: Bearer <LIFF idToken>`（受領・検証）
- `x-api-key`（受領・照合）
- `/webhook` の `x-line-signature` 検証

### 1.2 画像の一時処理（必要最小限）
- 経費領収書：受領→リサイズ→ストレージ保存→URL化→破棄
- 交通費OCR/ホテルOCR：受領→OCR→結果返却/名寄せ→破棄（保存しない）

### 1.3 外部API連携
- LINE Messaging API（push/reply/content）
- Gemini API（OCR）
- オブジェクトストレージ（R2/GCS）※v5で保存対象は領収書のみ

### 1.4 idempotencyキャッシュ（正本ではない）
- DO/KV/in-memory など「再送UX維持」のためのレスポンスキャッシュ

---

## 2. Workerが触ってはいけないもの（原則禁止）

- **Google Sheetsへの直接読み書き（System of Record）**  
  WorkerがSheetsを直接更新すると、業務ルール・重複排除・監査が分裂し事故が起きる。  
  v5の正本はGASに集約する。

> 例外を作る場合は、例外理由・期限・廃止計画を必ずdocs化（v6で解消）。
> 現在の逸脱一覧は [DX_CORE.md](./DX_CORE.md) の「逸脱点」表を正本として管理する。

---

## 3. GASが触ってよいもの

- Sheetsの読み書き（正本）
  - Staff Master（登録/状態）
  - Transaction Logs（交通費/経費/ホテル/シフト）
- 監査・アラート（ops.log / ADMIN_ALERTS）
- 名寄せ・正規化の業務ルール（ホテルOCR等）

---

## 4. データ分類（v5）

### 4.1 Master / Transaction
- **Master（正本）**：STAFF_MASTER（本人情報/状態）
- **Transaction Logs**：TRAFFIC_LOG, EXPENSE_LOG, HOTEL_INTENT_LOG, SHIFT_* 等

### 4.2 画像データ分類

| 種別 | 保存 | 保存先 | DB保持 |
|---|---:|---|---|
| 交通費OCRスクショ | ❌ | なし | なし |
| ホテル予約スクショ | ❌ | なし | なし |
| 経費領収書 | ✅（リサイズ後） | R2/GCS | URLのみ |

---

## 5. 実装ルール（境界固定）

### 5.1 Workerの責務（固定）
- 認証（LIFF idToken / x-api-key / webhook署名）
- ルーティング（HTTP→GAS action）
- idempotency制御（再送UX維持）
- 外部API（LINE/Gemini/R2）オーケストレーション
- 画像は「必要なものだけ一時処理」。原本をDBへ入れない。

### 5.2 GASの責務（固定）
- action dispatcher（業務ルールの入口）
- validation / gating（登録必須・inactive拒否）
- Sheets永続化（追記・参照・集計）
- 監査ログ/アラート記録（No Silent Failure）

---

## 6. v6+（SQL移行/管理画面）への布石

- API/Action contract（action-contracts.md）を凍結し、内部永続層を段階差し替えする。
- Sheets名（論理テーブル）をドメインモデル名として扱い、物理保存先を差し替え可能にする。
- admin-web は運用UIを担い、永続化はGAS/将来API層に集約する。

---

## 7. 監査チェックリスト（境界破り検出）

- WorkerがSheetsを更新している（原則禁止）
- 交通費OCR画像を保存している（v5違反）
- ホテル予約スクショを保存している（v5違反）
- 領収書をリサイズせず保存/DBにバイナリ保存している（v5違反）
- ops.log/ADMIN_ALERTSの失敗を握りつぶしている（運用違反）

---

## 8. 逸脱管理

- 境界逸脱の現況・解消状況は [DX_CORE.md](./DX_CORE.md) を正本として一元管理する。
- 本書は原則定義（あるべき姿）を維持し、逸脱の詳細列挙はDX Coreへ集約する。
