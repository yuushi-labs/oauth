# Phase 4-B 実装計画 — ソーシャル連携の確認画面（email 一致の連携を許可）

> 対象: M4 の追加分（Phase 4 v1.1 で意図的に「停止」した `link_required` フローの置き換え）
> 前提: Phase 4 本体（`docs/phase4-oauth-social-login-実装計画.md`）が実装済み・PR #6
> 本書: 決定事項 **D-32-01 〜 D-32-17**（D-32-17 は実装で追加）
> 現状（2026-10-18）: 実ブラウザ検証で 2 件の課題が判明
> 1. Google / GitHub でログインすると `/login?error=link_required` に飛ばされ、**連携が完了できない**
> 2. Discord で新規登録できたが、**username が `___` になった**

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何が変わる | callback で「紐付きアカウントが無い」場合は、**エラーに落とすのではなく確認画面を出す**。利用者が「新規登録」または「パスワードでログインして連携」を選ぶ |
| 乗っ取り防御は保たれるか | **保たれる**。連携には「**social の email を持つアカウントのパスワード**」の証明が必ず要る。email の**一致だけ**で自動連携することはありません（自動統合は引き続き禁止・§11） |
| 何 additionally 直す | username 生成（表示名の非 ASCII 文字で `___` になる件） |
| 追加 migration | **1 本** = `0016_oauth_social_claims.sql` |
| 新規ファイル | 6 ファイル → §4.1 |
| テスト | 新規 **5 ファイル・約 34 ケース** → §7 |
| 工数 | **約 11 時間**（内訳は §9） |

---

## 1. 背景

### 1.1 現状の実測

Phase 4 本体は「**email 一致での自動統合をしない**」（§11 / D-31-16）と決めて、email が既存アカウントと一致する場合は `link_required` で停止する設計にした。根拠は次の通り。

- provider が返す email は「検証済み」ではあるが、その email を**攻撃者が自分のアカウントに設定できる**という保証はない
- email の一致だけで 2 つのアカウントを同一人物とみなすと乗っ取りになる

この判断自体は妥当。ただし UX として **「誘導はするが、誘導先がなかった」**という状態になっている。

### 1.2 ユーザー報告

| # | 報告 | 原因 |
|---|---|---|
| 1 | Google / GitHub でログイン → `/login?error=link_required` | このフェーズ以前に**同じ email でパスワード登録済みのローカルアカウント**があるための、意図した挙動。**しかして誘導先が無い**ので完了できない |
| 2 | Discord で新規登録できたが username が `___` | `sanitizeUsername()` が非 ASCII をすべて `_` に置換する。表示名が「ミカさん」だと `___`（3 文字）になり、`min 3` を通 derrubしてしまう |

### 1.3 目的

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | **紐付きが無い場合は必ず完了できる道を作る** | 確認画面から「新規登録」または「パスワードでログインして連携」が選べる |
| 2 | **乗っ取り防御は緩めない** | 連携には email 所有者の**パスワード**が必要。email 一致のみでの自動連携はゼロ |
| 3 | username を人間に読めるものにする | 表示名を ASCII 化 → 無効なら email ローカル部 → 無効なら `user_` + ハッシュ |

---

## 2. 決定事項（D-32-01 〜 D-32-16）

| ID | 決定 | 理由 |
|---|---|---|
| **D-32-01** | 紐付きが無い場合は **403/エラーにせず、確認画面へ 303** する | エラーで止まるのは「完了できない」ので UX として破綻している。方針としては変更だが、**「email 一致のみで trusted」な状態から「password 証明alley」に置き換わる**ので受け入れられる |
| **D-32-02** | 確認画面は**常に**出す（自動新規登録はしない） | 利用者が「何をitivity するか」を選択してから確定する（ユーザー指定）。**自動登録しないので `email 済みなら新規登録`**という不整合が起きない |
| **D-32-03★** | **連携には password の証明を必須にする。** email 一致のみでは絶対に link しない | §11 の維持。email は同一性の証拠にならない。パスワード入力 = 通常のログインと同じ証明力を持つ |
| ~~**D-32-04**~~ | ~~確認画面では email が一致しないアカウントのパスワードでもログインできる（連携はしない）~~ | **D-32-18 で改訂**（ユーザー指摘。`login-but-not-link` から `reject` へ） |
| **D-32-18★★** | **password でログインできるのは `claim.emailOwnerId` のアカウントだけ**。email が一致しない・ユーザー名で代用した・そもそも email を持つローカルアカウントが無い場合は **ログインもさせない**（409 `ACCOUNT_LINK_OWNER_MISMATCH` / 401 `INVALID_CREDENTIALS`） | **同じ password を使うユーザーがいると、email 入力を差し替えるだけでそのアカウントに入れてしまう**（ユーザー指摘）。email が確定している場面なので、email の一致まで要求するのが正しい。通常の `/login` には同じ性質が残るが、ここは「どのアカウントの連携として完了させるか」が確定している場面であり、限定するのが安全側の特例 |
| **D-32-05** | claim（保留中の連携情報）は**新しいテーブル**に保持し、**httpOnly Cookie に token だけ**入れて URL には載せない | URL クエリに claim を載せると Referer やブラウザ履歴から漏れる。Cookie + サーバ側テーブルなら漏れる_sources はない |
| **D-32-06** | claim は **10 分・1 回限り**（消費は `UPDATE ... WHERE consumed_at IS NULL`） | `oauth_states` と同じ方式。使い切りになる |
| **D-32-07** | claim 発行時点で **email の所有者を `email_owner_id` に確定して无症状のまま保持する** | 完了時に「その email のアカウント」の判定が揺れない。password 検証も「この 1 ユーザー」に限定できる |
| **D-32-08** | 完了時に **`(provider, provider_account_id)` を再確認**する | callback と完了の間に他人が同じ外部 ID を紐付けた可能性があるので、**TOCTOU 対策** |
| **D-32-09** | password 試行は既存の **login 系レート制限**（`login.ip` / `login.account` / `login.ipAccount`）と reservation 方式を再利用する | 既存の account 単位の試行制限（reservation）がそのまま効く。専用の新キーは作らない |
| **D-32-10** | 完了後も**新しいセッション**を発行する（callback と同じ） | セッション固定対策（§6.2） |
| **D-32-11★** | username は **表示名を ASCII 化 → 有効なら使う → 無効なら email ローカル部 → 無効なら `user_` + hash8** の順で決める | `___` の発生を防ぐ。「英数字が 1 文字も入っていない」「`[^A-Za-z0-9_-]` に全是換しただけ」の 2 条件を不合格とする |
| **D-32-12** | 既存アカウントの username は**触らない**（新規作成時のみこの規則を適用） | 既存ユーザーの名前変更は別件の UX 課題。データ移行はしない（§9 の任意タスクを参照） |
| **D-32-13** | 未検証 email / `email: null` の場合、**新規登録ボタンは出さない**（ログインのみ可） | D-31-08 の維持 |
| **D-32-14** | claim のテーブルも `purge-expired` に追加（期限切れは即削除、消費済みは 1 時間後） | `oauth_states` と同じ |
| **D-32-15** | **`security_events` の新規 type は追加しない**。既存型で表現する | D-31-18 の spirit |
| **D-32-16** | 確認画面の導線は **POST + CSRF**（匿名時は anon cookie の CSRF） | `GET` ではなく POST で「確定する」操作であり、CSRF token を必須にする |
| **D-32-17** | claim Cookie は**読みは `request.cookies`、書きはレスポンスの `Set-Cookie` ヘッダ**で行う（`cookies()` を経由しない） | `cookies()` は Next の request scope に依存し、Route Handler を直接呼ぶテストでは必ず 500 になる。request から読み・ヘッダで書くほうが副作用が明確でテストもしやすい |
| **D-32-19★★** | **claim は「peek → 検証 → 成功確定直前で消費」する**。password 検証やメール送信の**前**では消費しない | 先に消費すると、password 誤り・CSRF の再送・通信断のたびに claim を失い、用户在 OAuth の最初からやり直すことになる（実測・BUG-15） |
| **D-32-20★★** | **CSRF トークンは callback が anon Cookie と一緒に書き出し、確認画面がそれを読む**（クライアントに `/api/auth/csrf` を叩かせない） | Next.js 15 では Server Component の描画中は Cookie を変更できない。あとからクライアントに取得させると、ブラウザが Cookie を保存する前に送信して 403 になる（実測・BUG-15）。callback は Route Handler なので両方を同時に書ける |

---

## 3. スコープ

### 3.1 実装する

- callback の「紐付きが無い」分岐を「確認画面へ 303」に変更
- claim の発行・消費（1 回限り・10 分）
- 確認画面（サーバーコンポーネント）+ クライアントフォーム
- 新規登録 / パスワードでログインして連携 の 2 アクション
- username 生成規則の修正
- `purge-expired` への追加
- 文言（`ui.oauth.confirm.*`）

### 3.2 実装しない（理由と引継ぎ先）

| 項目 | 判断 | 引継ぎ先 |
|---|---|---|
| **email 一致の自動統合** | **引き続き永久に禁止**（D-32-03） | なし |
| 既存アカウントの username の一括修復 | 既存データは触らない（D-32-12） | §9 の任意タスク |
| 確認画面からの**別 provider への切替** | 画面内にリンクを出すだけ（新しい claim は発行しない） | なし |
| パスワード変更の再入 | なし | なし |
| 既存ユーザー向けの「連携済みだが別アカウントから見えない」問題 | 対象外 | なし |

---

## 4. 全体設計

### 4.1 ファイル一覧

**新規（6）**

| # | パス | 責務 |
|---|---|---|
| 1 | `src/lib/auth/oauth/social-claim.ts` | claim の発行・消費（1 回限り・10 分・SHA-256 で引く） |
| 2 | `src/lib/auth/oauth/username.ts` | 表示名 / email ローカル部から username を決める（§5.3） |
| 3 | `src/app/api/auth/oauth/social-login/route.ts` | `POST` — `signup` / `password` の完了処理 |
| 4 | `src/app/api/auth/oauth/social-login/cancel/route.ts` | `POST` — claim を破棄して `/login` へ |
| 5 | `src/app/login/social-confirm/page.tsx` | 確認画面（サーバーコンポーネント） |
| 6 | `src/components/auth/social-confirm-form.tsx` | 画面内のクライアントフォーム |

**変更（8）**

| パス | 変更 |
|---|---|
| `drizzle/` | migration `0016_oauth_social_claims.sql` |
| `src/lib/db/schema.ts` | `oauthSocialClaims` テーブル |
| `src/app/api/auth/oauth/[provider]/callback/route.ts` | `link_required` → claim 発行 + 303 |
| `src/lib/auth/oauth/complete-login.ts` | `link_required` / `register` 分岐を削除し、`needs_confirmation` に集約。username 生成は `username.ts` へ移動 |
| `src/lib/auth/cookie.ts` | claim Cookie の set / read / clear |
| `scripts/purge-expired.ts` | `social claim` ジョブを追加 |
| `src/messages/ja.ts` | `ui.oauth.confirm.*` |
| `src/lib/validate/oauth.ts` | claim の body スキーマ |

### 4.2 データモデル

```sql
CREATE TABLE "oauth_social_claims" (
  "state_hash"          text PRIMARY KEY,          -- SHA-256(cookie token)。生 token は保存しない
  "provider"            text NOT NULL,
  "provider_account_id" text NOT NULL,
  "provider_email"      text,
  "email_verified"      boolean NOT NULL DEFAULT false,
  -- この email を持つ既存ユーザー。該当なしは NULL（新規登録できる）
  "email_owner_id"      text REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "expires_at"          timestamptz NOT NULL,
  "consumed_at"         timestamptz
);
CREATE INDEX "oauth_social_claims_expires_at_idx" ON "oauth_social_claims" ("expires_at");
```

- **生 token は保存しない**（`oauth_states` と同じ。Cookie には生 token、DB には SHA-256）
- `email_owner_id` は **claim 発行時点で確定**する（D-32-07）。完了時に email を引き直すと、発行と完了の間に.owner が変わった場合に判定が揺れる
- `ON DELETE CASCADE`：`users` が物理削除されたら claim も消える（論理削除では残るので、完了時に `status` を見る）

### 4.3 フロー

```
【callback】GET /api/auth/oauth/{provider}/callback
  共通 1〜7（従来どおり）
  8a. (provider, provider_account_id) に紐付きがある
        → そのユーザーでログイン（新規セッション）→ 303 redirect_to ?? '/'
  8b. その user が suspended / deleted
        → 403 ACCOUNT_SUSPENDED（従来どおり）
  8c. 紐付きが無い（新規 or email 衝突の双方）
        → issueSocialClaim({ provider, identity, emailOwner })
        → claim cookie をセット
        → 303 /login/social-confirm

【確認画面】GET /login/social-confirm
  claim cookie を読み、期限・消費済みを検査
  - claim なし / 期限切れ / 消費済み → /login へ 303
  - 以下を表示（server 側で判定済みの情報を渡す）
      · provider 名
      · social email（provider 検証済み）
      · email_owner_id があれば「既存アカウントと一致します」
      · email が未使用なら「このメールでアカウントを作る」ボタンを出す
      · パスワード欄（任意アカウントでログイン可）
      · 「キャンセル」

【完了】POST /api/auth/oauth/social-login   body: { action: 'signup' | 'password', password? }
  1. Origin / CSRF（匿名は anon cookie。**callback が書き出した anon Cookie**を使う）
  2. peekSocialClaim(cookie token) → なければ 400 INVALID_STATE（消費しない）
  2'. body の検証。identifier が空でも通す（password 判定で落とす）
  3. action = 'signup'
       - email_verified === false          → 400 ACCOUNT_NOT_LINKABLE
       - email_owner_id !== null           → 409 EMAIL_CONFLICT（「既に登録済み」）
       - (provider, provider_account_id) が存在 → 409 ACCOUNT_LINKED_ELSEWHERE（D-32-08）
       - social-only ユーザーを作成
       - ★ ここまで成功ellyたら **consumeSocialClaim** → accounts 行作成 → セッション → oauth_linked
  4. action = 'password'
       - login 系レート制限 + reservation（既存の方式）
       - findUserByEmailOrUsername(identifier)
       - verifyPassword
         · 失敗 → 401 INVALID_CREDENTIALS（列挙攻撃対策のため通常のログインと同じ既定文言）
         · 成功 → セッション発行（ログインのみ）
       - ★ さらに「そのユーザーの email が claim の provider_email と一致」なら
           追加で accounts 行を作成（連携）。一致しなければ**連携しない**
       - セッション発行 → 303 '/'
  5. claim cookie をクリア
```

**セキュリティの要点**

| 脅威 | 対策 |
|---|---|
| ★ **email 一致による自動乗っ取り** | 連携は「password で `email_owner_id` にログインできた」場合のみ。`email_owner_id === user.id` を**サーバー側で**照合する（D-32-03） |
| **別アカウントでログインして連携しない** | `email_owner_id !== user.id` なら**リンクを作らない**（ログインだけ）。画面にもその旨を表示 |
| **claim の盗用** | httpOnly + SameSite=Lax Cookie、10 分、1 回限り |
| **callback と完了の間の TOCTOU** | 完了時に `(provider, provider_account_id)` を再確認（D-32-08） |
| **password 総当たり** | 既存の login 系レート制限 + reservation（account 単位・IP 単位） |
| **列挙攻撃** | password 失敗のメッセージは `INVALID_CREDENTIALS` で統一（どの email のアカウントかも教えない） |
| **suspended / deleted ユーザー** | 完了時にも `status` を確認（`email_owner_id` のユーザーが停止中でも連携しない） |

### 4.4 API 契約

| Method | Path | 概要 | エラー |
|---|---|---|---|
| `GET` | `/login/social-confirm` | 確認画面（claim cookie 必須） | claim 不正 → 303 `/login` |
| `POST` | `/api/auth/oauth/social-login` | 完了（`signup` / `password`） | 400 `INVALID_STATE` / 400 `ACCOUNT_NOT_LINKABLE` / 409 `EMAIL_CONFLICT` / 409 `ACCOUNT_LINKED_ELSEWHERE` / 401 `INVALID_CREDENTIALS` / 429 `RATE_LIMITED` |
| `POST` | `/api/auth/oauth/social-login/cancel` | claim 破棄 → 303 `/login` | ― |

### 4.5 username 生成（§5.3）

```ts
// src/lib/auth/oauth/username.ts
/**
 * 表示名 / email ローカル部から username を作る。
 *
 * 実測（BUG-14）: 表示名「ミカさん」を ASCII 化すると `___` になり、
 * min 3 を通有的人の `___` という username が作られていた。
 * 「英数字が 1 文字もない」「`_` に置換した結果だけ」は**不合格**とする。
 */
export function usernameCandidates(identity: Identity): string[] {
  return [
    sanitize(identity.displayName ?? ''),
    sanitize(localPart(identity.email ?? '')),
  ].filter((candidate) => isAcceptable(candidate));
}
```

**合格条件（両方満たす場合のみ使う）**

| 条件 | 理由 |
|---|---|
| `3 <= length <= 32` | `usernameSchema` の制約 |
| `/^[A-Za-z0-9_-]+$/` に一致 | 同上 |
| **英数字を 1 文字以上含む** | `___`・`___` のような機械的な名前を避ける |
| **先頭が `_` ではない** | `_foo` のような見た目の悪さを避ける |

**フォールバック**

```ts
if (!candidates.length) {
  return `user_${sha256Hex(identity.email ?? identity.providerAccountId).slice(0, 8)}`;
}
```

**衝突時の扱い** — 従来どおりランダム suffix で引き直し、10 回失敗したら `user_` + hash。

### 4.6 文言（`ui.oauth.confirm.*`）

| キー | 用途 |
|---|---|
| `title` | 画面タイトル（`{provider}` で埋め） |
| `emailLabel` | 「認証されたメールアドレス」 |
| `existingAccountNotice` | 「このメールアドレスは既に登録されています。パスワードを入力すると、そのアカウントにログインして連携します。」 |
| `newAccountNotice` | 「このメールアドレスはまだ使われていません。アカウントを作成できます。」 |
| `signupAction` | 「このメールアドレスでアカウントを作る」 |
| `passwordLabel` | パスワード |
| `passwordLoginAction` | 「パスワードでログイン」 |
| `differentAccountNotice` | 「別のアカウントのパスワードでもログインできます。その場合、{provider} は連携されません。ログイン後に設定画面から連携してください。」 |
| `cancel` | キャンセル |
| `errors.linkRequired` | 完了に失敗したときの一時メッセージ |

---

## 5. テスト計画

| ファイル | 種別 | 主要ケース |
|---|---|---|
| `src/test/unit/oauth-username.test.ts` | unit | 「ミカさん」→ `user_xxxx` / 「octo」→ `octo` / 全て非 ASCII → フォールバック / 衝突時の suffix / 先頭 `_` を排除 |
| `src/test/security/social-claim.test.ts` | security | claim が 1 回のみ消費できる / 期限切れ → null / **token の生の値が DB に無い** / 他 provider の claim を引けない |
| `src/test/security/social-confirm-link.test.ts` | security | ★ **email 一致の account の password で連携できる** / ★ **別アカウントの password では連携されない（ログインだけ）** / 未検証 email では signup 不可 / email が使用済みなら signup は 409 / suspended ユーザーの password では連携しない / `(provider, id)` の TOCTOU 409 |
| `src/test/e2e/social-confirm-flow.test.ts` | e2e | 実 HTTP：callback → 303 `/login/social-confirm` → claim Cookie → 画面 200 → `POST signup` → セッション発行 → `/` へ |
| `src/test/integration/purge-expired.test.ts` | integration（**既存に追記**） | `oauth_social_claims` のパージ |

**件数の見積もり**: 新規 4 ファイル + 約 34 ケース。

---

## 6. DoD

**機能**
- [ ] Google / GitHub でログインして `link_required` に飛ばされない
- [ ] 紐付きが無いときは確認画面が出て、`signup` と `password login` の両方が使える
- [ ] password で `email_owner_id` にログインすると**そのアカウントに連携される**
- [ ] 別アカウントの password では**ログインだけ**され、連携はされない
- [ ] email が未使用なら「このメールでアカウントを作る」で新規登録できる
- [ ] username が `___` のような機械的な名前にならない

**セキュリティ**
- [ ] **email 一致のみでは連携が一切起きない**（password 必須）
- [ ] 別アカウントの password では連携しない（ログインだけ）
- [ ] claim は 1 回限り・10 分・Cookie にのみ生 token
- [ ] 完了時に TOCTOU（他人の新規リンク）を 409 で拒否
- [ ] password 失敗は一律 `INVALID_CREDENTIALS`（列挙対策）
- [ ] 未検証 email では signup 不可
- [ ] suspended / deleted ユーザーでは連携しない
- [ ] claim token が URL・ログ・`security_events.metadata` に現れない

**運用**
- [ ] `pnpm lint`（0 errors）/ `typecheck` / `test` / `build` green
- [ ] `purge-expired` が `oauth_social_claims` を削除する
- [ ] **実ブラウザで Google / GitHub / Discord の 3 経路を通す**

---

## 7. 実装順序

```text
Step 1（データ・基盤）
  migration 0016 + schema + purge ジョブ
  username.ts（生成規則の修正）+ unit テスト

Step 2（claim）
  social-claim.ts（発行・消費・1 回限り）
  cookie.ts に claim Cookie
  security/social-claim.test.ts

Step 3（完了 API）
  POST /api/auth/oauth/social-login（signup / password）
  security/social-confirm-link.test.ts（★ 乗っ取り回帰）

Step 4（画面）
  callback を「確認画面へ 303」に変更
  /login/social-confirm + social-confirm-form + 文言
  cancel エンドポイント

Step 5（確認）
  e2e/social-confirm-flow.test.ts
  全テスト・lint・typecheck・build
  実ブラウザで 3 provider を通す
```

---

## 8. リスク / ロールバック

| リスク | 影響 | 緩和 |
|---|---|---|
| **連携の緩和が乗っ取りにopeningする** | 他人のアカウント乗っ取り | password 必須を**サーバ側で強制**し、テストで固定。email 一致のみでは一切 link しない |
| 別アカウントでログインした人が混乱する | 「連携したはずなのにない」 | 画面に明示。ログイン後に設定画面への導線を出す |
| 既存 `___` の username が残る | 見た目が悪い | D-32-12 で**既存は触らない**。必要なら §9 の任意タスクで手動修正 |
| claim テーブルが増え続ける | DB 肥大 | `purge-expired` に追加済み |
| 確認画面への遷移で state が消費される | やり直し Hirotaない | claim は独立した token。`oauth_states` の state は callback で消費済みだが、claim は別 |

**ロールバック**

| 対象 | 手順 |
|---|---|
| 確認画面（Phase 4-B 全体） | migration を残したまま callback の 303 をやめて `link_required` に戻す（1 か所） |
| migration | `DROP TABLE oauth_social_claims;`（外部参照なし） |
| username 生成 | `username.ts` のフォールバック順序を旧来に戻す |

---

## 9. 任意タスク（今回やらない）

- **既存 username の修復**: `___` のようなProfiles のアカウントを一時 SQL で修正する
  ```sql
  UPDATE users SET username = 'user_' || substr(md5(id), 1, 8)
  WHERE username !~ '[A-Za-z0-9]';
  ```
  実行前に `WHERE username ~ '^_+$' OR username !~ '[A-Za-z0-9]'` で対象をdry-run すること
- `email_owner_id` の**名字変更に追従させる**（現状は claim 発行時点の値で固定）

---

## 10. 仕様トレーサビリティ

| 仕様 | 章 | 担当 |
|---|---|---|
| ソーシャルログイン | §9 | Step 3・4 |
| accounts の UNIQUE | §10 | D-32-08 |
| **email 一致の自動統合禁止** | §11 | **D-32-03（維持・password 証明に置き換え）** |
| email verified のみ採用 | §11.2 | D-32-13 |
| CSRF（callback 例外） | §8.4 | D-32-16 |
| レート制限 | §16 | D-32-09 |
| 再認証 | §8 | 既存 link フローと同じ（今回の画面では不要） |
| セッションローテーション | §6.2 | D-32-10 |
| 機密値 redaction | §45 | §5 セキュリティ（claim は Cookie のみ・URL に載せない） |
| IDOR | §49 | claim は `email_owner_id` をサーバー側固定（body で受け取らない） |
| UI 文言一元化 | 計画 14 章 | §4.6 |

---

## 11. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-18 | 初版。実ブラウザ検証で報告された 2 件（`link_required` で完了できない / username が `___`）に対する設計。確認画面は「常に表示」、password は「任意のアカウントでログイン可・連携は email 一致時のみ」、username は「表示名を ASCII 化」 |
| **v1.1** | 2026-10-18 | **実装完了。** 決定事項 D-32-01〜D-32-16 をそのまま実装した。設計変更 2 件: (1) **claim Cookie の読み書きを `cookies()` からレスポンスヘッダ・request に移した**（D-32-17）。`cookies()` は Next の request scope に依存するため、Route Handler を直接呼ぶテストで必ず 500 になる。読みは `request.cookies`、書きは `Set-Cookie` ヘッダにするほうが副作用も明確で、テスト可能になる。(2) **`completeLogin` から `register` と `link_required` の分岐を削除**し、`needs_confirmation` に集約した。新規登録と連携は完了 API の責務になり、callback は「確認待ちを発行するだけ」に単純化された。テストは 68 files / 477 tests green。**残作業は実ブラウザでの 3 provider 通しのみ**。 |
| **v1.2** | 2026-10-18 | **BUG-15 の是正（実ブラウザで「403 → 400 中队完了失败」となった）**。原因は 2 つ重なっていた。(1) **claim を password 検証より前に消費していた**ため、password 検証や CSRF の再送で失敗すると claim を使い切り、用户在 OAuth の最初からやり直すされていた（D-32-19）。(2) **CSRF トークンをクライアントに `/api/auth/csrf` で取得させていた**が、ブラウザが anon Cookie を保存する前に送信するとトークンと Cookie が食い違い 403 になる。さらに Next.js 15 では Server Component の描画中に Cookie を変更できないため、確認画面から anon Cookie を発行する方式も選べなかった。callback（Route Handler）で **claim と anon Cookie を 1 つの応答に**書き出し、確認画面はその値を読み取るだけにした（D-32-20）。加えて `identifier` を空文字でも受け付けるようにして、body の parse で 400 にせず通常の認証判定に落とすようにした。実 HTTP で再現・修正を確認し、回帰テスト 4 ケースを追加。テストは 68 files / 482 tests green。 |
