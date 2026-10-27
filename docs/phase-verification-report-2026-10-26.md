# 全Phase完了状況 & 仕様書↔実装 矛盾検証レポート（2026-10-26）

> 目的: 「6時までに他Phaseが全て完了しているか、仕様書と実装が矛盾していないか」の確認
> 実施日: 2026-10-26（JST）
> 対象リビジョン: `origin/main` = `abd71cd`（PR #18 マージ後）/ 検証ブランチ `fix/phase7-doc-consistency`
> 手法: リポジトリ全探索（仕様書 v1.3 全 69 章 ↔ 実装）、実 PostgreSQL でのマイグレーション往復、テスト全件実行

---

## 0. 結論（TL;DR）

| 観点 | 結果 |
|---|---|
| 他Phaseの完了状況 | **M0〜M5 完了**。M6（Passkey）は**未着手**。M7〜M9 は設計書（M7）／未着手 |
| 仕様書 ↔ 実装の矛盾 | **セキュリティ要件の矛盾は 0 件**。発見したのは **①コード 1 件（ID 規約）②ドキュメント整合 5 件 ③将来フェーズの実装漏れリスク 2 件** |
| 品質ゲート | **全 green**（lint 0 error / typecheck / test 623 / build / db:verify-migrations） |
| 修正した項目 | コード 1 件（`security_events.id`）＋ ドキュメント 5 件 |
| 要フォロー項目 | §24 Passkey 無効化の Phase 6 反映、`rotateSession` の死蔵、§7.1 アイドル再認証（任意） |

**セキュリティ機能の欠落・仕様違反は検出されなかった**（§48 の必須テストは実ファイルで充足。§49〜§51・§61 は Phase 7 で実装予定で、計画書に反映済み）。

---

## 1. 検証環境と品質ゲート

| 項目 | コマンド | 結果 |
|---|---|---|
| Docker / PostgreSQL 16 | `docker compose up -d` | ✅ healthy |
| migration 適用 | `drizzle-kit migrate` | ✅ 0017 まで適用済み |
| seed | `tsx scripts/seed.ts` | ✅ roles 4 行 |
| テスト全件 | `vitest run` | ✅ **89 ファイル / 623 テスト green** |
| 型検査 | `tsc --noEmit` | ✅ 0 error |
| Lint | `eslint .` | ✅ **0 error** / 84 warning（すべて既存・テスト用の `security/detect-*`） |
| 本番ビルド | `next build` | ✅ 成功 |
| migration 可逆性 | `scripts/verify-migrations.ts` | ✅ up / down / 往復 / restore すべて成功 |

> `verify-migrations.ts` は `pnpm` / `docker` を spawn する。サンドボックスでは PATH に無いため、
> 検証時は `pnpm exec` をローカル `node_modules/.bin` へ委譲する shim と `docker` を `sudo docker` へ委譲する shim を一時的に用意して実行した（**リポジトリの変更ではない**）。

---

## 2. Phase 完了状況（実測）

| マイルストーン | 計画 | 実測 | 根拠 |
|---|---|---|---|
| M0 Phase 0 | 土台 | ✅ 完了 | `drizzle/0000_*`、`src/lib/{env,errors,util}`、unit 9 ファイル |
| M1 Phase 1 | メール/PW 認証 | ✅ 完了 | `src/app/api/auth/*`（register/login/logout/…）、§30 の 10 ルートすべて実在 |
| M2 Phase 2 | Web セキュリティ | ✅ 完了 | `src/middleware.ts`（CSP nonce・CORS・Origin 検証）、`web.test.ts` |
| M2.5 Phase 2.5 | OIDC Provider | ✅ 完了 | `src/lib/oidc/*`、`oidc-flow.test.ts`、29/29 タスク |
| M2.6 Phase 2.6 | 管理コンソール | ✅ 完了 | `src/app/settings/applications/*` |
| M3 Phase 3 | UI / テーマ / 通知 | ✅ 完了 | `src/app/settings/*`、`theme-*` テスト。実ブラウザ検証のみ Phase 8-B |
| M4 / 4-B Phase 4 | ソーシャル連携 | ✅ 実装完了 | `src/app/api/auth/oauth/*`、`account-linking.test.ts`。実 provider 疎通のみ未 |
| M5 Phase 5 | TOTP 2FA | ✅ 完了 | `src/lib/auth/totp.ts`、`2fa/*` 6 ルート、`2fa.test.ts` |
| **M6 Phase 6** | **Passkey** | **❌ 未着手** | `src/lib/auth/passkey/` も `webauthn_credentials` も**存在しない**。migration `0018` 未作成。`docs/phase6-*` は設計のみ |
| M7 Phase 7 | 管理者 / RBAC / 監査 | ❌ 未着手 | `src/app/api/admin/` も `admin_audit_logs` も無い。設計書は本書と同時に作成 |
| M8 Phase 8-9 | リスク検知 / 運用 | ❌ 未着手 | `src/lib/auth/risk.ts` 無し |

**次の実装対象は M6（Passkey）**。M5 完了（PR #11）と PR #18 のマージで、M0〜M5 が確定した。

---

## 3. 仕様書 ↔ 実装の突合（章別）

### 3.1 一致を確認した主要章

| 仕様 | 確認内容 | 結果 |
|---|---|---|
| §5 パスワード | Argon2id / 8〜128 文字 / Unicode・空白可 / breached 拒否 / 定期変更なし | ✅ `src/lib/auth/password.ts`・`strength.ts`・`breached.ts`。`password.test.ts` |
| §6 ログイン | email / username / ソーシャル / Passkey。**login で必ず新セッション** | ✅ `login/route.ts` が `createSession` で新規発行（fixation 防止）。Passkey は Phase 6 |
| §7 セッション | `__Host-` Cookie / HttpOnly / Secure / SameSite=Lax / 30 日 / DB はハッシュ | ✅ `src/lib/auth/cookie.ts`・`session.ts`。`session-attr.test.ts` |
| §8 再認証 | 8 操作で再認証。手段は PW / Passkey / TOTP | ✅ `withAuthPipeline({ requireReauth })`・`strong-reauth.ts`（Passkey 検証器は Phase 6） |
| §13 2FA | TOTP 暗号化保存 / リカバリー 10 個 / 1 回限り / 残数少で再生成促し | ✅ `totp.ts`（AES-256-GCM）・`recovery-codes.ts`。`RECOVERY_CODE_COUNT=10` |
| §16/§17/§56 レート制限 | ログイン等にレート制限 / CAPTCHA hook / 値は集約 | ✅ `src/config/rate-limits.ts`・`src/lib/auth/rate-limit.ts`（PostgreSQL が正本） |
| §20 IP | マスク表示・生 IP は限定的 | ✅ `src/lib/util/ip.ts`、`security_events.ip_masked` |
| §21 セキュリティログ | 16 イベント種別を記録 | ✅ `SECURITY_EVENT_TYPES` が 16 種を包含（+ 拡張種別） |
| §23/§24 状態・削除 | `pending_email/active/suspended/deleted`・論理削除・全セッション/token/OIDC grant 無効化 | ✅ `schema.ts`・`account/route.ts`。**Passkey 無効化のみ §3.4 参照** |
| §25 CSRF | SameSite 依存せず・GET で状態変更しない | ✅ `withAuthPipeline` の Origin/CSRF 検証。`csrf.test.ts` |
| §26/§27/§28 XSS/SQLi/ヘッダ | — | ✅ `web.test.ts`・`next.config.ts`・`middleware.ts` |
| §29 JWT | — | ✅ OIDC は `jose`/`oidc-provider` を使用（自作検証なし） |
| §30〜§33 API | §30 の 10 ルート・§31 OAuth・§33 2FA | ✅ 実在。§32 Passkey は Phase 6 |
| §37 セキュリティ設定画面 | 8 カード | ✅ `settings/security/page.tsx` |
| §44 認証メール | 統一テンプレート | ✅ `email/layout.ts`（HTML＋`text` 両方送信） |
| §45 情報漏洩防止 | 10 種の秘密をログ/応答に出さない | ✅ `logger.ts` の `SENSITIVE_KEYS`・`log-redaction.test.ts` |
| §46 エラーメッセージ | 列挙防止の統一文言 | ✅ `enumeration.test.ts`・`messages/ja.ts` が正典 |
| §47 CORS | `*` 禁止 | ✅ `middleware.ts`（許可 Origin のみ・credentials は同一 Origin のみ） |
| §48 セキュリティテスト | 認証/PW/OAuth/OIDC/セッション/Web/2FA/Passkey | ✅ 実ファイルで充足（§4 参照）。Passkey は Phase 6 |
| §49/§50/§51/§61/§62 | 認可サーバ側・role・管理者・監査・禁止事項 | ⏳ **Phase 7 で実装**（設計書 `docs/phase7-admin-rbac-audit-実装計画.md`） |
| §58/§59/§60 | 応答形式・ID・UTC | ✅ `handleSuccess`/`failResponse`・`util/id.ts`（**§3.2 の 1 件を除く**）・UTC 保存 |
| §64 完成条件 | アカウント/ソーシャル/高度な認証/セッション/セキュリティ/UI | ✅ 充足は M5 まで。**Passkey（M6）と Audit Log（M7）が残** |

### 3.2 【コード・修正済み】`security_events.id` が ID 規約に違反

- **事象**: `recordSecurityEvent` が `id` を `` `evt_${Date.now().toString(36)}${Math.random()...}` `` と**手書き**していた（実測 **18 文字**）。一方 §59 / 計画 8.1 / D-22 は「**`prefix_` + ULID 26 文字**」、`ID_PREFIXES` に `evt` が定義済み、`parseId(value, 'evt')` は 26 文字以外を **throw** する。つまり**定義済み prefix の ID が `parseId` で通らない**という内部矛盾。
- **影響**: `security_events` は外部に `id` を晒さないため**直接の脆弱性ではない**が、ID 設計の規約（§59 / D-22 / D-25「`evt_` は `security_events` 専用」）に違反し、将来 `parseId` を使う経路（監査・エクスポート）で壊れる。衝突耐性も ULID より低い（時刻 36 進 + 乱数 6 文字）。
- **修正**: `src/lib/auth/security-events.ts` を `newId('evt')` に変更。回帰テスト `security-events-coverage.test.ts` に「`evt_` + ULID 26 文字・`parseId` が通る」を追加。
- **検証**: 該当 3 テストファイル green。全 623 テスト green。

### 3.3 【ドキュメント・修正済み】整合の是正 5 件

| # | ファイル | 是正前 | 是正後 |
|---|---|---|---|
| D1 | `実装Todo.md` §1 マイルストーン | M5 が **`[ ] 未着手`** | `[x] 達成（2026-10-24）（PR #11 → f02683d）` |
| D2 | `実装Todo.md` §5 Phase 3 | 完了済み 21 項目が **`[ ]` のまま**（本文は ✅ 完了） | `[x]` へ統一 |
| D3 | `実装Todo.md` §12 テストトラッカー | **存在しないファイル名**を列挙（`auth.test.ts` / `session.test.ts` / `oauth-redirect.test.ts` / `notify-events.test.ts` / `*.spec.ts`）・全 `[ ]` | **実在ファイル**へ置換・状態を実測に一致（`[x]`/`[ ]`）・注記追加 |
| D4 | `README.md` マイルストーン表 | M2.5 が **「実装中」** | 「完了（2026-10-17）」（Phase 2.5 は M2.5 達成済み） |
| D5 | `AGENTS.md` 現在の到達点 | 2026-10-24 時点・テスト数なし | 2026-10-26 時点・**89 ファイル / 623 テスト**・Phase 7 設計書の存在を追記 |

> これらは「実装は完了しているのにドキュメントが未更新」という**記録のズレ**であり、コードの不具合ではない。ただし進捗の正本（`実装Todo.md`）が実態と食い違うと、後続フェーズの判断を誤るため是正した。

### 3.4 【要フォロー】§24「アカウント削除時の Passkey 無効化」が Phase 6 計画に未反映

- **仕様 §24**: 削除開始時に「全セッション無効化・OAuth 連携無効化・**Passkey 無効化**・API アクセス無効化」を行う。
- **現状**: `DELETE /api/auth/account` は `softDeleteUser` → `revokeAllSessions` → `invalidateAllUserTokens` → `revokeUserOidcGrants` を実行するが、**Passkey（`webauthn_credentials`）は Phase 6 で導入されるため存在しない**。
- **リスク**: Phase 6 で Passkey を追加した際、`account/route.ts` に**Passkey 失効を足し忘れる**と §24 に違反する（ただし論理削除＋ログイン遮断により実害は限定的）。
- **対応**: Phase 6 の実行 Todo に「アカウント削除で `deleteCredentialsByUser` を呼ぶ」を**明示的に追加**する。本レポートで issue 化した。

### 3.5 【要フォロー】`rotateSession` が死蔵コード

- **事象**: `src/lib/auth/session.ts` の `rotateSession()` は定義されているが、**呼び出し元が 0 件・テストも 0 件**（`grep` で確認）。
- **仕様**: §6.2「ログイン成功時には必ず新しいセッション ID を発行する」は `createSession` の新規発行で満たしている。`rotateSession` は Phase 1 の設計時に用意されたが、OAuth callback も `createSession` を直接使うため未使用。
- **影響**: 機能的な欠陥ではない（セッション固定は防げている）。ただし未テストのコードが残ると、将来「ローテーションしているつもり」で誤用される余地がある。
- **対応**: Phase 6 以降で不要なら削除、必要ならテストを付ける。本レポートで issue 化した。

### 3.6 【任意・仕様の裁量】§7.1 アイドル再認証

- **仕様 §7.1**: 「ただし**一定時間操作がない場合は再認証を要求できる**」。
- **現状**: 絶対期限（90 日）と重要操作の再認証は実装済み。**アイドルタイムアウトによる再認証は未実装**。
- **判断**: 仕様は「〜できる」（任意）であり、§64 の完成条件にも含まれない。**MVP の必須要件ではない**ため、未実装を「矛盾」とは扱わない。実装する場合は `sessions.last_seen_at` を使う（計画 8.3 に列あり）。

### 3.7 【参考】§30 ログイン入力の表記差（矛盾ではない）

- §30 のリクエスト例は `email` だが、実装は `email_or_username`（§6.1 の「email または username」と整合）。
- これは `docs/phase3-ui-theme-notification-実装計画.md`（709 行）で「識別子は単一入力欄 `email_or_username` を維持」と**明示的に決定済み**（API 契約と列挙対策を不変にする）。**仕様 §6.1 と一致**しており矛盾ではない。

---

## 4. §48 セキュリティテストの充足（実ファイル）

`実装Todo.md` §12 の旧表は存在しないファイル名を列挙していたため、実測で置換した（D3）。要点:

- **認証**: `deleted-account-login.test.ts`（正PW/誤PW/未認証/削除済み/停止中）・`enumeration.test.ts`（列挙防止）・`session-management.test.ts`（期限切れ・logout-all）
- **パスワード**: `unit/password.test.ts`（8/128/129 文字・Unicode・空白）・`token-reuse.test.ts`（reset token 再利用）
- **OAuth**: `oauth-state` / `oauth-nonce` / `oauth-pkce` / `oauth-email-verified` / `account-linking` / `social-confirm-link`
- **OIDC Provider**: `oidc-*`（10 ファイル）＋ `e2e/oidc-flow.test.ts`・`integration/oidc-persistence.test.ts`（8 並列 token 交換）
- **セッション**: `session-management` / `session-attr` / `csrf`
- **Web**: `web.test.ts` / `web-attack.test.ts`（XSS/CSRF/SQLi/OpenRedirect/Clickjacking/CORS/Header）
- **2FA**: `2fa` / `2fa-bruteforce` / `2fa-disable-reauth` / `recovery-code-reuse` / `2fa-secret-leak` / `2fa-concurrent-replay` / `2fa-pending-session`
- **Passkey**: **Phase 6 で作成**（未着手）

**§48 の必須カテゴリは、Passkey を除き実テストで充足している。**

---

## 5. 要フォロー一覧（issue 化）

| # | 種別 | 内容 | 優先度 |
|---|---|---|---|
| 1 | 実装漏れリスク | §24 アカウント削除で Passkey を無効化（Phase 6 で対応） | 中 |
| 2 | 保守性 | `rotateSession` が死蔵（削除 or テスト） | 低 |
| 3 | 記録 | 本レポートの是正内容の周知（D1〜D5・コード 1 件） | 低 |

> `security_events.id`（§3.2）は**本ブランチで修正済み**のため、issue は「修正記録」として起票する。

---

## 6. 検証で確認できなかった点（制約）

- **実ブラウザ / 実 provider**: Phase 3・4 の実機検証（viewport・Google/GitHub/Discord 実疎通）は Phase 8-B へ引継ぎ済み（計画通り）。本検証は実 HTTP（vitest）まで。
- **本番構成**: HTTPS・Nginx/Cloudflare・Secret Manager・監視は Phase 9（§52/§53）。ローカルでは検証対象外。
- **負荷テスト**: `pnpm oidc:load` は Phase 2.5 で実施済み（`docs/phase2.5-load-test.md`）。本検証では再実行していない。

---

## 7. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-26 | 初版。全 Phase 完了状況と仕様書↔実装の矛盾を検証。コード 1 件（`security_events.id`）とドキュメント 5 件を是正。要フォロー 3 件を issue 化 |
| v1.1 | 2026-10-27 | 要フォロー 3 件（#19 / #20 / #21）をすべて解消。詳細は §8 |

---

## 8. 要フォロー項目の解消（2026-10-27）

| issue | 内容 | 解消 |
|---|---|---|
| #20 | `security_events.id` を ID 規約（`evt_` + ULID 26 文字）へ | `newId('evt')` に変更（§3.2 の修正を main へ反映）。回帰テスト `security-events-coverage.test.ts` に「`evt_` + ULID・`parseId` が通る」を追加 |
| #19 | §24 アカウント削除時に Passkey を無効化 | `DELETE /api/auth/account` に `deleteCredentialsByUser(user.id)` を追加。回帰テスト `account-delete-passkey.test.ts`（実 DB で credential 0 件）を追加 |
| #21 | `rotateSession()` が死蔵コード | 呼び出し元・テスト 0 件、かつ §6.2 は `createSession` の新規発行で充足するため**削除**。session 発行 4 経路すべてが新規発行であり、認証前セッションを昇格する箇所は無い |

### 追加で検出・修正した欠陥

- **管理者セッション TTL の抜け道（§51 / D-35-03）**: `GET /api/auth/oauth/{provider}/callback` が `sessionMaxAgeSecondsForRole` を適用せず `createSession` していたため、**OAuth ログイン経由の管理者だけ 30 日セッション**を得られた。callback に短命セッション適用を追加し、`rbac.test.ts` に「session 発行 4 経路すべてが `sessionMaxAgeSecondsForRole` を使う」静的検査を追加。
