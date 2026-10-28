# Phase 7.6 実装計画 — アカウント削除フローとアカウント保護イベント

> 対象: 仕様 §8（再認証）・§21（security_events）・§24（アカウント削除）の実装ギャップを埋める
> 前提工程: Phase 7.5（M7.5 管理者の付与）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-28
> 状態: **実装完了**

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | ①セルフサービス退会を**メール確認**でも行えるようにし、②削除の副作用（全セッション・全トークン・Passkey・OIDC grant 失効）を 1 か所に集約、③アカウント保護系の `security_events`（`account_deletion_requested` ほか）を配線する |
| なぜやる | 仕様 §8 は削除に再認証を要求するが、2FA も Passkey も未設定の利用者は**削除する手段が無かった**。また `DELETE /api/auth/account` と管理 API の論理削除が副作用を別々に実装しており、片方だけ Passkey 失効が漏れていた（§24 違反） |
| migration | `0022_tan_oracle.sql`（`account_deletion_requests` テーブルを追加） |
| 新規ファイル | ライブラリ 1 / API 2 / 画面 2 / 部品 1 / テスト 1 |
| 最大リスク | 削除の確認経路が増えるほど「再認証なしで消せる抜け道」が生まれやすい。全経路を `performAccountDeletion` に収束させ、テストで固定する |

---

## 1. 背景

Phase 7.5 完了時点で、アカウント削除には次のギャップがあった。

- `DELETE /api/auth/account` は再認証（パスワード＋コード / Passkey）を要求する。**2FA も Passkey も未設定の利用者は削除できない**（§8 の「メールアドレス変更」等は再認証で足りるが、削除は強い確認を要求する設計）。
- 管理 API `POST /api/admin/users/{id}/delete` は削除の副作用（セッション・トークン・OIDC grant）を**独自に実装**しており、`deleteCredentialsByUser`（Passkey 失効・§24）が漏れていた。
- `security_events` の `account_deletion_requested` など、仕様 §21 が列挙するイベントの一部が未配線だった。

---

## 2. スコープ

**やること**

1. `POST /api/auth/account/delete/request` — 確認リンクをメール送信する（削除はまだしない）。
2. `GET /api/auth/account/delete/confirm` — 303 転送のみ（状態変更しない・§25）。
3. `POST /api/auth/account/delete/confirm` — トークンを 1 回限り消費して削除を確定する。
4. `/account/delete/confirm` — 確定画面（POST のみ）。
5. `src/lib/auth/account-deletion.ts` — 削除の副作用を集約（`performAccountDeletion`）。
6. `DELETE /api/auth/account` と管理 API の論理削除を**同じヘルパ**へ寄せる。
7. `/settings/account` に削除カード（2FA / Passkey / メール確認のタブ）。

**やらないこと**

- 保持期間（30 日）経過後の物理削除。既存の `pnpm purge:expired` が担当（D-36-09）。
- 削除の取り消し（論理削除の復元）。仕様に規定が無い。

---

## 3. 決定事項（D-37-01 〜 D-37-06）

| # | 決定 | 理由 |
|---|---|---|
| D-37-01 | 削除の副作用は **`performAccountDeletion` に集約**し、自己削除・メール確認・管理 API の 3 経路すべてがこれを呼ぶ | §24 の「全セッション・OAuth 連携・Passkey・API アクセスの無効化」を 1 か所に固定する。経路ごとの実装は片方だけ漏れる（実際に管理 API で Passkey 失効が漏れていた） |
| D-37-02 | 削除は**強い再認証**（パスワード＋コード / Passkey）または**メール確認**のいずれかを必須とする。パスワード再認証（5 分猶予）だけでは削除できない | §8 は削除を重要操作に挙げる。セッション窃取だけでは消せないようにする（T22） |
| D-37-03 | メール確認は **専用テーブル `account_deletion_requests`** を使い、`TOKEN_PURPOSES` は増やさない | 目的の異なるトークンを同じテーブルに混ぜると、`verifyAndConsumeToken` の目的判定が複雑化し、目的混同の余地が増える。既存の `email_change_requests` と同じ分離方針 |
| D-37-04 | 確認リンクの **GET は状態を変えず 303 転送のみ**。削除は画面内の POST がトークンを消費したときに確定する | §25「GET でデータ変更を行ってはならない」。メールクライアント・セキュリティスキャナの先読みで消えないようにする |
| D-37-05 | 再要求すると**未消費の旧トークンを無効化**する（`invalidateAccountDeletionRequests`）。消費は `UPDATE ... WHERE used_at IS NULL` の更新行数で判定する | D-16（1 回限りの値は単文 UPDATE の更新行数で消費する）。複数リンクの同時有効を防ぐ |
| D-37-06 | 削除の確認リクエストには**利用者単位＋IP 単位**のレート制限を課す | 任意の第三者アドレスへの確認メール爆撃を防ぐ（SEC-2 と同じ考え方・§18） |

---

## 4. API 契約

### 4.1 `POST /api/auth/account/delete/request`

| 項目 | 内容 |
|---|---|
| 認証 | 必須（`requireAuth`） |
| 入力 | なし |
| 出力 | `{ success: true, data: { message } }` |
| 副作用 | 旧トークン無効化 → 新トークン発行 → 確認メール送信（best-effort）→ `account_deletion_requested` 記録 |
| レート制限 | 利用者 5 回/時・IP 10 回/時（`RATE_LIMITS.accountDeleteEmail`） |

### 4.2 `GET /api/auth/account/delete/confirm?token=...`

| 項目 | 内容 |
|---|---|
| 認証 | 不要 |
| 動作 | `token` を `/account/delete/confirm` に引き継ぎ **303 で転送するだけ**（状態変更なし・§25） |

### 4.3 `POST /api/auth/account/delete/confirm`

| 項目 | 内容 |
|---|---|
| 認証 | 不要（トークン所持が根拠）。CSRF は anon cookie で検証 |
| 入力 | `{ token: string }` |
| 出力 | 成功 `{ success: true, data: { message } }` / 失敗 400 `INVALID_TOKEN` |
| 副作用 | トークンを 1 回限り消費 → `performAccountDeletion`（§24 の全失効） |

### 4.4 `DELETE /api/auth/account`

| 項目 | 内容 |
|---|---|
| 認証 | 必須 ＋ **強い再認証**（パスワード＋コード / Passkey） |
| レート制限 | 利用者 10 回/5 分（`RATE_LIMITS.accountDelete`） |
| 副作用 | `requireStrongReauth` 成功後に `performAccountDeletion` |

---

## 5. テスト

| ファイル | 何を固定するか |
|---|---|
| `src/test/security/account-deletion-flow.test.ts` | 再認証なし／コード誤りで削除されない。再認証成功で全セッション・Passkey・未消費トークンが失効し `account_deleted` を記録。メール確認リンクで削除が確定。トークンの 1 回限り消費と再要求時の無効化 |
| `src/test/security/account-delete-passkey.test.ts` | `DELETE /api/auth/account` が `deleteCredentialsByUser` を呼ぶ（§24 回帰ガード） |
| `src/test/security/security-events-coverage.test.ts` | 削除の副作用が `account-deletion.ts` に集約され `account_deleted` を記録する |
| `src/test/integration/schema-readiness.test.ts` | 宣言テーブル 24 件（`account_deletion_requests` を含む） |

---

## 6. 実装ファイル

| 種別 | パス |
|---|---|
| ライブラリ | `src/lib/auth/account-deletion.ts`（新規） |
| API | `src/app/api/auth/account/delete/request/route.ts` / `src/app/api/auth/account/delete/confirm/route.ts`（新規） |
| 画面 | `src/app/account/delete/confirm/page.tsx` / `account-delete-confirm-form.tsx`（新規） |
| 部品 | `src/components/settings/account-delete-panel.tsx`（新規） |
| 変更 | `src/app/api/auth/account/route.ts` / `src/app/api/admin/users/[id]/delete/route.ts` / `src/app/settings/account/page.tsx` / `src/lib/db/schema.ts` / `src/lib/db/queries/tokens.ts` / `src/lib/auth/tokens/verify.ts` / `src/config/rate-limits.ts` / `src/lib/auth/rate-limit-keys.ts` / `src/lib/auth/email/templates.ts` / `src/messages/ja.ts` |
| migration | `drizzle/0022_tan_oracle.sql` |
