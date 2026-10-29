# AGENTS.md — リポジトリ固有の知識

## プロジェクト

「超本格アカウント・認証システム」。Next.js 15 (App Router) + TypeScript strict + Drizzle ORM + PostgreSQL 16 +
Tailwind v4。自作サービス向け OIDC Provider も同梱（`oidc-provider`）。

正典（優先順位の高い順）:
1. `超本格アカウント・認証システム仕様書 v1.3.md`（全 69 章）
2. `実装計画.md` v1.6（フェーズ分解・DoD・決定事項 C-xx / D-xx）
3. `実装Todo.md`（進捗の正本。チェックボックス）
4. `docs/phase*-*.md`（フェーズごとの実装レベル詳細。最新フェーズが最も具体的）

## コマンド

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（`vitest run`）
- `pnpm test:unit` / `test:security` / `test:integration` / `test:e2e`
- `pnpm dev`（`node --import tsx scripts/server.ts dev`。Next + OIDC を 1 プロセスで起動）
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:verify-migrations`
- `pnpm seed`（roles）/ `pnpm secrets:gen`（`.env` 生成）

テストは `fileParallelism: false`、`src/test/**` に集約（D-18）。テストは実際の PostgreSQL を使うものが多い。
`src/test/setup.ts` が必須環境変数（pepper 類 + `TOTP_ENCRYPTION_KEY`）を注入する。

## 構成の要点

- `src/lib/env.ts` — zod で起動時 fail fast。`TOTP_ENCRYPTION_KEY` は **Base64 32 バイト**必須（既に検証済み）。
- `src/lib/errors.ts` — `ERROR_CODES` / `ERROR_STATUS` / 既定メッセージ。新コードは 3 か所すべてに足す。
- `src/lib/api/utils.ts` + `src/lib/auth/pipeline.ts` — 全 API の共通パイプライン
  （Origin → CSRF → session → user → body → reauth → handler）。新 API は必ず `withAuthPipeline` を通す。
- `src/lib/auth/session.ts` — サーバサイドセッション。`SessionData` 型は pipeline / reauth / tests が依存。
  変更時は `src/test/security/*` の SessionData フィクスチャ（7 ファイル）を確認する。
- `src/lib/auth/rate-limit.ts` — PostgreSQL が唯一の正本（D-05）。`src/config/rate-limits.ts` に値、
  `src/lib/auth/rate-limit-keys.ts` にキー生成を集約（コード散在禁止）。
- `src/lib/db/schema.ts` — 全テーブル。migration は `drizzle/`（up のみ）。最新は `0021`。
- `scripts/purge-expired.ts` — 保持期間パージ（`pnpm purge`）。期限切れ token/session/OIDC artifact に加え、
  `security_events` は 180 日（D-13）、論理削除済みユーザーは 30 日経過後に**物理削除**（§24 / D-36-09）。
  ユーザー物理削除は本人データを `ON DELETE CASCADE`、`security_events` / `oauth_clients` /
  `admin_audit_logs` を `SET NULL`（匿名化保持）で処理する。追加ジョブは `jobs` 配列に足す。
- `scripts/server.ts` — OIDC interaction UI（login / consent）を素の HTML で描画。CSP は script 禁止。
- `src/lib/util/logger.ts` — secret redaction。機密キーは `SENSITIVE_KEYS` に追加する。
- `src/messages/ja.ts` — UI 文言・メール文面の一元管理（D-30-18）。`m('a.b.c')` で型安全に引く。
- `src/components/layout/auth-shell.tsx` — 認証系画面（login/register/forgot/reset/verify/email-change/delete-confirm）の共通枠。
  `<h1>` は 1 ページ 1 つ、`#main-content` はここで付ける。`src/components/layout/skip-link.tsx` は root layout に設置。
- `src/components/ui/button.tsx` — `loading` prop（スピナー＋`aria-busy`＋`disabled`、ラベル据え置き）。
  送信ボタンは `busy ? m('common.loading') : label` ではなく `loading={busy}` に統一する。
- SEO は `src/app/layout.tsx`（`metadata` + `viewport`）に集約。各 `page.tsx` は `metadata.title` のみ足す
  （ルート `page.tsx` は同セグメントのため `title.absolute`）。`robots.ts` / `manifest.ts` は全画面 noindex 前提。

## 決定事項の慣習

- フェーズごとに `D-<phase>-<n>` を採番する（Phase 3 = D-30-xx、Phase 4 = D-31-xx、Phase 4-B = D-32-xx、
  **Phase 5 = D-33-xx**）。`実装計画.md` §9 の D-01〜D-27 は全フェーズ共通のロック済み決定。
- 仕様と実装が食い違ったら「実装を仕様に寄せる」か「仕様に制約を明記して緩和する」かを必ず文書化する。

## 注意（過去に踏んだ地雷）

- `cookies()`（Next の request scope）は **Route Handler を直接呼ぶテストで 500 になる**。
  Cookie の読みは `request.cookies`、書きは `Set-Cookie` ヘッダを使う（Phase 4-B D-32-17 / BUG-15）。
- Server Component の描画中は Cookie を**変更できない**。発行は Route Handler で行う（BUG-15）。
- ルート `src/app/loading.tsx` は置かない。`loading.tsx` を挟むとストリーミングが始まり、
  auth guard の `redirect()` が HTTP 3xx を返さず 200 + クライアント側遷移になり、`notFound()` も 404 を
  返さなくなる（e2e のリダイレクト/ステータス検証が落ちる）。共通ローディングはセグメント単位に留める。
- この環境の `HOSTNAME` はコンテナ名（`runtime-...`）なので、`pnpm dev` は素で起動すると
  `0.0.0.0` ではなくその名前で bind する。work URL から到達させるには `PORT=12000 HOSTNAME=0.0.0.0 pnpm dev`
  （`scripts/server.ts` は `process.env.HOSTNAME` を bind 先に使う）。
- `process.env` を読むモジュール（OAuth registry 等）をクライアントコンポーネントから import すると
  hydration mismatch になる（BUG-11）。サーバ側で読んで props で渡す。
- OAuth callback では `Origin` / `Referer` を検証しない（provider からの top-level GET のため必ず 403 になる。
  CSRF は `state` 1 回限り消費 + PKCE で担保。BUG-12）。
- 一意性は **partial unique index**（`deleted_at IS NULL`）のみ。通常 UNIQUE は付けない（D-04）。
- ルート `app/loading.tsx` を置くと、認証ガードの 3xx リダイレクトと 404 がストリーミング 200 に化ける
  （`redirect()` / `notFound()` が HTTP ステータスを返さなくなる）。共通ローディングはセグメント単位に留める。
- 「1 回限り」の値（token / state / claim）は **`UPDATE ... WHERE <未消費>` の更新行数**で消費する。
  read → 判定 → write の 2 段書きは禁止（D-16）。
- **partial unique index 違反を 500 にしない**。`deleted_at IS NULL` の一意制約に当たる更新
  （メール変更確定・登録など）は、**消費前に衝突を検査して 409 を返す**（`findUserByLowerEmail`）。
  500 は列挙オラクル（500=登録済み / 200=空き）になる。並行確定の保険として
  `isUniqueViolation` も 409 に正規化する。検査は token 消費より前に置き、衝突でトークンを
  焼かない（SEC-1）。
- **Drizzle の失敗クエリはバインド値を `message` へ展開する**。error を丸ごとログへ流すと
  保存済み argon2 ハッシュや PII が平文で残る。`logger` は argon2 パターンも伏せ字化する。
  新しい機密形式を保存するときは `SENSITIVE_TEXT_PATTERNS` に追加する（SEC-3）。
- **メール送信を伴う API は必ずレート制限を課す**（§4.3 / §18）。`RATE_LIMITS` と
  `rateLimitKeys` に利用者単位＋ IP 単位の両方を足す（SEC-2。`emailChange` が抜けていた）。
- `pnpm dev` の `relation "xxx" does not exist`（42P01）は**コードのバグではなく DB が古い**。
  `pnpm db:migrate`（必要なら `pnpm seed`）で解消する。起動時に `scripts/server.ts` が
  `assertSchemaReady()`（`src/lib/db/schema-readiness.ts`）で不足テーブルを検出し fail fast する（Phase 7 後）。
- **drizzle-kit は `drizzle.__drizzle_migrations` の sha256 ハッシュで適用済みを判定し、
  「最後に記録された migration より新しいもの」だけを適用する**。途中の migration が作ったテーブルを
  手で DROP しても `pnpm db:migrate` は「success」と言うだけで再作成しない（その SQL を直接流すか、
  該当行を消して以降を再適用する）。schema を疑ったら `pnpm db:verify-migrations` で往復検証する。

## 現在の到達点（2026-10-29 時点）

M0〜M9 完了（Phase 0 / 1 / 2 / 2.5 / 2.6 / 3 / 4 / 4-B / 5 / 6 / 7 / 7.5 / 7.6 / 8 / **9**）。**M8 の残件（運用デプロイ）まで完了**。
Phase 9 の計画は `docs/phase9-運用デプロイ-実装計画.md`（D-39-01〜D-39-08）、実行タスクは `docs/phase9-実行Todo.md`。

Phase 9 の要点（運用デプロイ）:
- **CAPTCHA（Turnstile）実接続**: `src/lib/auth/captcha.ts` の `TurnstileCaptchaProvider` が `siteverify` を
  **POST body** で叩く（secret を URL に載せない・D-39-01）。本番で secret 未設定は 500（fail closed）、
  通信失敗は 503。テストは `setCaptchaProvider` で差し替え、ネットワークを叩かない。
- **バックアップ／復元**: `src/lib/ops/backup.ts` / `restore.ts`。`pg_dump --format=custom` → **AES-256-GCM** →
  保持 30 日 pruning。**平文 dump を一時ファイルにも残さない**（パイプで受けて暗号化・D-39-02）。
  `BACKUP_ENCRYPTION_KEY` 未設定なら失敗する（D-39-03）。復元は `src/test/integration/ops-backup-restore.test.ts` が
  **実 `pg_dump`/`pg_restore` で一時 DB へ流して行数を検証**する（DoD 直結）。
- **監視**: 閾値は `src/config/ops.ts`、判定は**純関数** `src/lib/ops/alerting.ts`（D-39-04）。`pnpm alert:check` が
  `security_events` を集計し、閾値超過のみ構造化ログで出す（外部 SaaS へ送らない・D-39-05）。
- **ログ secret 検知**: `src/lib/ops/log-scan.ts`。`pnpm logs:scan` は**値ではなく行番号**を報告する（D-39-06）。
  既定の検出対象は URL に載る認証トークン（`token`/`code`/`state`/`nonce`/`code_verifier`）のみ。
  `password`/`secret` 等は誤検知しやすいため `--credentials` 指定時のみ対象にする。
- **外部コマンド**: `pg_dump`/`pg_restore` の spawn/pipe は `src/lib/ops/command.ts` の `runCommand` に集約（backup/restore で二重実装しない）。
- **ログ漏洩対策**: アプリ側は `logger.ts` ＋ `src/test/security/log-url-redaction.test.ts`。外側の層は成果物
  `deploy/nginx/oauth.conf` / `deploy/cloudflare.md` / `deploy/log-security-checklist.md`（実地確認は運用 DoD・D-39-07）。
- **ランブック**: `docs/phase9-運用ランブック.md`（suspend / 復旧 / キーローテ / §54-55 手動復旧フロー / インシデント）、
  `docs/phase9-デプロイ手順.md`（初期状態のサーバーからのデプロイ一式）、
  `docs/phase9-バックアップ復元手順.md`。
- **CI**: `verify` に `pnpm build`（smoke）と Node 22/24 の matrix を追加（D-39-08）。gitleaks / audit は維持。

Phase 8 の要点（リスク検知・§57 / §48 テスト完成）:
- 不審ログイン検知は **純関数** `src/lib/auth/risk.ts`（信号判定 → スコア → `allow`/`notify`/`challenge`/`hold`）。
  重み・閾値は `src/config/risk.ts` に集約（D-38-02）。DB / HTTP に触れないので単体テストしやすい。
- 既定は **通知のみ**（`RISK_ENFORCEMENT='notify'`・D-38-03）。高スコアでもログインは成功し、既存挙動を変えない。
  強制を上げたい環境だけ `'challenge'` / `'hold'` を設定する。判定は `src/lib/auth/login-risk.ts` の
  `evaluateAndRecordLoginRisk`（集計 → 判定 → `login_risk` 記録）が担い、ログイン / OAuth callback / Passkey login へ配線済み。
- 「短時間で複数地域」は外部 geo-IP を持ち込まず、短期間の複数 `ip_hash` で代理する（D-38-01・`sessions.ip_country` は常に null）。
- §48 の各カテゴリは**正規ファイル名**に 1:1 対応（`security/{auth,session,oauth-redirect,oauth-replay,risk}.test.ts` ほか・D-38-05）。
- E2E は **Playwright を導入しない**。`src/test/e2e/auth-journey.test.ts` が `startTestAppServer` で実 HTTP を通す（D-38-04）。
  メール本文は Next のバンドル境界を跨げないため、確認メールの「クリック」は DB 状態を直接確定させて代替する。
- テスト基盤は `src/test/helpers/{fixtures,rate-limit,totp}.ts` に集約（D-38-06）。時間依存は `vi.useFakeTimers()` を使い実時間待ちをしない。

Phase 7.6 の要点（アカウント削除フロー・§8 / §21 / §24）:
- 削除の副作用は `src/lib/auth/account-deletion.ts` の **`performAccountDeletion` に集約**（D-37-01）。論理削除・全セッション・
  全トークン・**Passkey**・OIDC grant 失効・`account_deleted` 記録・削除通知を 1 か所で行う。自己削除・メール確認・
  管理 API の 3 経路すべてがこれを呼ぶ（管理 API に Passkey 失効が漏れていた §24 違反を解消）。
- メール確認退会: `POST /api/auth/account/delete/request` → `GET /api/auth/account/delete/confirm`（**303 転送のみ**・§25）
  → `/account/delete/confirm` の POST でトークンを 1 回限り消費して確定（専用テーブル `account_deletion_requests`・D-37-03）。
- 削除は**強い再認証**（パスワード＋コード / Passkey）またはメール確認を必須（D-37-02）。確認メールは利用者 5/時・IP 10/時。

Phase 7 の計画は `docs/phase7-admin-rbac-audit-実装計画.md`（D-35-01〜D-35-12）。**UI はスコープ外**（§34 に管理画面が無い）。

Phase 7 の要点:
- `src/lib/auth/admin-policy.ts` — 認可は **role rank** 比較（`user`=0 / `moderator`=1 / `admin`=2 / `superadmin`=3、未知は -1）。
  `requireRole(user, 'admin')` は 403 `FORBIDDEN`。`requireAdminAccess(user)` は **role ≥ admin ＋ 2FA 有効**を必須にする
  （未設定は 403 `ADMIN_2FA_REQUIRED`・D-35-04）。**request / headers を受け取らない**（§49）。
- `src/lib/api/admin.ts` — 管理 API の共通ラッパー `withAdminPipeline(request, scope, handler)`。
  `requireAuth` ＋ `requireReauth`（**GET も含めすべて**・D-35-05）→ `requireAdminAccess` → レート制限（read / mutation）の順。
- `src/lib/auth/audit.ts` — `recordAdminAudit()` は `admin_audit_logs`（**`security_events` とは別テーブル**・D-35-07）に追記。
  metadata は許可キー（`count` / `reason` / `status` / `sessions`）のみ。**記録失敗で呼び出し元を失敗させない**。
- `src/lib/db/queries/admin.ts` — `listAdminUsers` は **secret 列を select しない**（`has_password` / `has_2fa` /
  `passkey_count` に畳む）。drizzle の相関サブクエリは `"id"` を非修飾で出すと内側の表に束縛されるため
  **LEFT JOIN ＋ 集約**で書く（過去の地雷）。
- `src/lib/api/admin-target.ts` — `resolveAdminTarget()`: 不正形式 / 不存在 / 論理削除済みは 404 `ADMIN_NOT_FOUND`（§49）、
  自分自身は 409 `CANNOT_TARGET_SELF`（D-35-10）。
- 管理者のログイン（password / passkey / social）は **8 時間セッション**（`sessionMaxAgeSecondsForRole`・D-35-03）。
  既定は従来どおり 30 日。`createSession` の第 3 引数は options オブジェクト。
- 管理 API: `GET /api/admin/users`・`POST /api/admin/users/{id}/{suspend,unsuspend,sessions/revoke,delete}`・
  `GET /api/admin/audit-logs`。`AdminAuditAction` は 5 種。
- テストは `src/test/security/{rbac,admin,audit-access}.test.ts` ＋ `src/test/integration/{admin-queries,admin-session-ttl}.test.ts`。
  監査ログの 5 アクションが `admin_audit_logs` に入り、一般ユーザーは 403 で読めないことを固定する。

Phase 6 の計画は `docs/phase6-passkey-webauthn-実装計画.md`（D-34-01〜D-34-16）。

Phase 6 の要点:
- `src/lib/auth/passkey/config.ts` — `rpID` / `rpName` / 許可 origin を**環境変数から明示解決**する。
  **request / headers を受け取らない**（Host 偽装での検証迂回を防ぐ・D-34-01）。`isPasskeyEnabled()` は
  設定不備でも throw せず `false`（ログイン画面を壊さない）。
- `src/lib/auth/passkey/challenge.ts` — challenge は TTL 5 分・**単文 UPDATE の更新行数で 1 回限り消費**（D-34-05 / D-16）。
- `src/lib/auth/passkey/registration.ts` / `authentication.ts` — 検証は `@simplewebauthn/server` に委譲（自作禁止・D-34-03）。
  challenge は**文字列のまま渡さず** `isoBase64URL.toBuffer()` でバイト列に変換して渡す（文字列渡しは UTF-8 再エンコードで値が変わる）。
- `src/lib/db/queries/webauthn.ts` — `advanceSignCount` は単文 UPDATE。`newCounter === 0` は `last_used_at` のみ更新（D-34-06）。
- `src/lib/auth/strong-reauth.ts` — 検証器配列は「パスワード＋コード → Passkey」の順（D-34-11）。
  `strong_reauth_methods` は Passkey を 1 件以上持つときだけ `['password','passkey']`。
- UI は `PasskeyPanel`（登録・一覧・削除）／`PasskeyLoginButton`（`/login`）／`StrongReauthDialog` の Passkey タブ。
  Passkey の有無は**サーバ側で判定して props で渡す**（BUG-11）。
- ログの `SENSITIVE_KEYS` に `credentialid` / `publickey` / `challenge` / `signature` 等を追加済み。

Phase 5 で得た知見（次フェーズでも効くもの）:
- 2FA 有効化（`setup` → `verify`）は `enabled=false` の保留行に対してコード検証する。
  `consumeTotpCounter` / `verifyAndConsumeTotp` の `allowPending` を忘れると `verify` が常に 400 になる。
- `totp_pending = true` の保留セッションは既定で全 API を 403 `TOTP_REQUIRED`。例外を作るのは
  `challenge/verify` / `logout` / `logout-all` / `csrf` / `me` の 5 経路だけで、`2fa-static-checks.test.ts` が固定する。
- 無効化・再生成は「強い再認証（パスワード＋コード）」。判定順は**再認証 → コード**で、失敗時にコードを消費しない。
  検証器は `src/lib/auth/strong-reauth.ts` の配列に足す（Phase 6 の Passkey は 1 件足すだけ）。
- 未確認 email は 403 `EMAIL_NOT_VERIFIED` でログインさせない（D-33-21）。再送は未認証の
  `POST /api/auth/resend-verification`（`requireAuth: false`・応答は常に同一・D-33-22）。
- 2FA 系のレート制限キーは `rateLimitKeys.twoFactorUser`、値は `RATE_LIMITS.twoFactor`（10/5 分）。
- **Drizzle は driver エラーを `DrizzleQueryError` で包む**ので SQLSTATE は `err.cause.code` にある。
  `err.code` だけを見ると `23505`（一意制約違反）を取り逃し、重複登録が 500 になる。
  `src/lib/db/sql-state.ts` の `getSqlState` / `isUniqueViolation` を使う。
- **応答文言は `src/messages/ja.ts` が正典**。ルートに直書きした文言が正典とずれると、
  成功経路と重複経路で応答が割れ、それ自体が列挙オラクルになる（§46）。`register-duplicate.test.ts` が固定する。
- 保留セッションの封じ込めのソース走査は **`denyTotpPending: false` の 4 経路**
  （`challenge/verify` / `logout` / `logout-all` / `me`）。`csrf` は許可経路だが `withAuthPipeline` を通らないため
  `false` を書かない（D-33-26）。「許可経路 5 つ」と「コード上の `false` 4 つ」は一致しない。
