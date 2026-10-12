# Phase 2 設計ドキュメント（セキュリティ基盤強化） v1.8

> 本ドキュメントは**実装より先に**作成・改訂した設計書です。対象工程は `実装計画.md` v1.4 の 16章「Phase 2 — セキュリティ基盤強化」および `実装Todo.md` の P2-01〜P2-08 に対応します。  
> 初版作成日: 2026-10-10 / v1.1〜v1.5: 2026-10-10 / v1.6: 2026-10-10 / v1.7: 2026-10-10 / v1.7.1: 2026-10-11 / v1.7.2: 2026-10-11 / v1.7.3: 2026-10-11 / v1.7.4: 2026-10-11 / v1.7.5: 2026-10-11 / v1.7.6: 2026-10-11 / v1.8 改訂日: 2026-10-12（外部レビュー指摘反映: 決定ID再採番P2-D-01〜07・予約方式の設計バグ検証→事前INCR方式に方針変更・Redis RateLimiter IF追加・閾値を計画8.6と整合・IP/プロキシ信頼規則新設・CSP/CORS/Cache-Control/Vary/Permissions-Policy網羅・RATE_LIMIT_SECRET必須化・security_eventsパージ対象外明記・DoD/テスト計画にP2-07/08追加・未決U-xx整理） / 状態: 改訂版（実装前の設計書。未決事項U-xxあり）

---

## 1. 目的と範囲

### 1.1 目的

Phase 1 で構築したメール/パスワード認証の基盤に対し、**本番運用に耐えるセキュリティ基盤**を追加・強化する。具体的には：

- **Next.js 15 適合 CSP nonce アーキテクチャの完全確定**:
  - `src/middleware.ts` を唯一の設定元とし、暗号学的に安全な 16 バイト以上の Base64 nonce (`crypto.getRandomValues(new Uint8Array(16))`) をリクエストごとに生成。
  - リクエストヘッダー `x-nonce` および `Content-Security-Policy` を設定し、Next.js レンダリングエンジンおよび Server Components (`await headers()`) に伝達。
  - レスポンスヘッダーに `Content-Security-Policy` を設定し、`next.config.ts` との重複設定を根本防止。
  - 動的レンダリング（SSR）への影響、および Vitest（ヘッダー検証）と Playwright（実ブラウザ DOM 遮断検証）の役割分担を定義。
- **CORS と CSRF 信頼境界の完全分離**:
  - CORS 用 `ALLOWED_ORIGINS` と CSRF 用 `CSRF_TRUSTED_ORIGINS` の環境変数を分離。
  - `new URL(origin).origin` による scheme + host + port の完全一致判定、`Origin` 欠落時の `Referer` 検証、および両方欠落・`Origin: null`・不正 URL 形式に対する `403 Forbidden` 拒否を確定。
- **HTTPS 強制・プロキシ信頼条件と Host 偽装防衛**:
  - 信頼できるリバースプロキシが `X-Forwarded-Proto` を上書きする前提契約の明記。
  - カンマ区切りマルチヘッダー処理（最外郭エッジプロキシの最先頭値評価）。
  - 未検証 `Host` ヘッダー依存を排除し、`NEXT_PUBLIC_APP_URL` / `ALLOWED_HOSTS` に基づく安全な 308 リダイレクト先 URL 構築による Host Header Injection / Open Redirect 防衛。
- **全 13 レート制限キーの完全統一・HMAC 識別子保護・本番フェイルクローズ**:
  - 全 13 キーを「**全リクエスト対象キー**（処理実行前にインクリメント）」と「**失敗試行対象キー**（認証失敗後のみインクリメント、成功時にリセット）」に明確に分類し、許可回数・拒否開始回数・ログ記録タイミングの数値を 100% 整合。
  - メールアドレス識別子の HMAC-SHA256（`RATE_LIMIT_SECRET`）による辞書攻撃防衛。
  - 本番環境（`NODE_ENV === 'production'`）で実 Turnstile 未設定時に CAPTCHA 必須領域のリクエストを **`400 Bad Request` / `500 Internal Server Error` で安全に拒否するフェイルクローズ設計**（`NoopCaptchaProvider` の本番バイパス防止）。
- **`rate_limit_hits` および 30日保持条件を含む 6 テーブル期限切れデータ削除スクリプト**:
   - PostgreSQL 適合バッチ削除クエリ (`DELETE ... WHERE id/key IN (SELECT ... LIMIT 1000 FOR UPDATE SKIP LOCKED)`) に `rate_limit_hits` (`window_expires_at < NOW()`)、`used_at` カラム、および **失効済みセッション（`revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days'`）と未失効期限切れセッション（`revoked_at IS NULL AND (expires_at < NOW() OR absolute_expires_at < NOW())`）の完全分流条件** を適用。
- **分散環境対応のアトミック ログ抑制（Throttled Logging）**:
   - `RateLimiter.check()` のアトミック更新戻り値を活用し、ハード制限突破のまさに初回（全リクエストキー: `count === hard_limit + 1` / 失敗試行キー: `failed_count === hard_limit`）のみ `security_events` へ 1 回記録する判定により、マルチプロセス・マルチインスタンス環境での DB ログ溢れを防止。
- **本番環境での CAPTCHA 未設定時の安全拒否**:
   - `NODE_ENV === 'production'` かつ `TURNSTILE_SECRET_KEY` 未設定時に、CAPTCHA 必須領域（ソフト制限超過）のリクエストを **`500 Internal Server Error (CAPTCHA_UNCONFIGURED)`** で拒否し、クライアント入力エラー（400系）とサーバ設定不備（500系）を厳密に区別する。
- **セキュリティテスト計画と DoD の完全整合**:
   - Vitest 5.0.3 (`pnpm test:security`) による API/ヘッダーテストと、Playwright (E2E ブラウザテストタスク) の定義。

### 1.2 今回やらないこと（対象外）

| 項目 | 担当フェーズ | 理由 |
|---|---|---|
| shadcn/ui / テーマ切替 UI / 通知メール | Phase 3 | UI・表示層の構築タスク |
| OAuth（Google/GitHub/Discord） | Phase 4 | ソーシャルログイン実装タスク（Phase 2 では CSRF / ヘッダー基盤との分離のみ定義） |
| TOTP / Passkey / 管理者機能 | Phase 5・6・7 | 高度認証・管理機能 |
| CI / gitleaks / 監視 / バックアップ | Phase 9 | インフラ・本番監視 |
| 実際の Cloudflare Turnstile 実接続 | Phase 9 | Phase 2 では interface と `NoopCaptchaProvider` のみ定義（本番拒否ガード付き） |

### 1.3 DoD（Phase 2 完了条件）

`package.json` に定義されている以下の検証コマンドが全てパスすること：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:security && pnpm build
```

さらに、以下の具体的な判定基準を満たしていること：

1. **CSP nonce**: `middleware.ts` で生成された `x-nonce` がレスポンス CSP ヘッダーおよび `<Script>` に正しく伝達され、`next.config.ts` とのヘッダー重複がないこと。
2. **CORS & CSRF 分離**: `ALLOWED_ORIGINS` と `CSRF_TRUSTED_ORIGINS` が分離され、不正 Origin/Referer および `Origin: null` からの Cookie 伴う状態変更リクエストが 403 拒否されること。
3. **HTTPS & プロキシ**: カンマ区切り `X-Forwarded-Proto` や偽装 Host ヘッダーに対して安全な HTTPS リダイレクトが動作すること。
4. **レート制限 13 キー & HMAC & 本番 CAPTCHA 防御**: 13 キーの閾値が適用され、**全リクエスト対象キーは処理実行前の単一アトミック INCR で上限を厳密保証**すること。失敗試行対象キーは「事前読み取り判定→失敗時のみインクリメント→成功時 DELETE」フローで、認証処理の実行前判定により硬件上限を守ること（詳細は §6.1 参照）。HMAC-SHA256 によるメールア dress 保護、本番未設定時の CAPTCHA バイパス防止が実装されていること。
5. **期限切り削除**: `rate_limit_hits` および 30 日保持セッションを含む全 6 テーブルの期限切りバッチ削除が正常終了すること。`security_events`（180 日保持、D-13）はパージ対象外。
6. **セキュリティイベント網羅 & Web 攻撃テスト**: 計画 P2-07（全認証カバレッジの `security_events` 記録検証）と P2-08（XSS / SQLi / clickjacking / Open Redirect / IDOR の各テスト）が存在し、`pnpm test:security` で green になること。

---

## 2. 前提・制約・技術スタック

### 2.1 依存関係と技術スタックの実態

- **Next.js**: `15.5.27`（React `19.3.0`）— `headers()` は Promise を返す非同期 API（[Next.js 15 CSP Guide](https://nextjs.org/docs/15/app/guides/content-security-policy) 準拠）。
- **ORM / DB**: `drizzle-orm` `^0.45.3` / PostgreSQL (`pg` `^8.23.1`)。
- **テスト**: `vitest` `^5.0.3` (`pnpm test:security`)。Playwright による実ブラウザテストは Phase 2 の E2E タスクとして定義。

### 2.2 スキーマと DB インデックスの実態確認結果

1. **`security_events`**: `event_type` カラムは DB 上で **`text NOT NULL`**（Enum ではない）。`SECURITY_EVENT_TYPES` 配列の拡張に DB マイグレーションは不要。
2. **`used_at` カラム**: `email_verification_tokens`, `password_reset_tokens`, `email_change_requests` の全 3 テーブルに **`used_at` (timestamp with time zone) が実在** する。
3. **`rate_limit_hits`**: `key` (text PK), `count` (integer), `window_expires_at` (timestamp with time zone) が存在し、`rate_limit_hits_window_expires_at_idx` インデックスが作成済みである。

### 2.3 ロック済み決定事項（変更不可）

| ID | 決定 | Phase 2 での遵守事項 |
|---|---|---|
| §28 | HTTPS-only / HSTS / Security Headers 必須 | `next.config.ts` + `middleware.ts` で完全適用 |
| §47 | CORS ワイルドカード禁止・credentials 併用禁止 | 許可リスト厳密チェック。同一オリジンのみ credentials 許可 |
| D-05 | Redis 不在時は PG フォールバック | `rate-limit.ts` で PostgreSQL アトミック更新を標準化 |
| D-17 | HIBP fail-open（Phase 1 実装済み） | 変更なし |
| 計画8.6 | レート制限 13 キー・閾値は設定集約 | `src/config/rate-limits.ts` に全 13 キーを集約 |
| 計画17 | CAPTCHA hook（Turnstile）は interface のみ | Phase 2 では interface と `NoopCaptchaProvider` のみ実装 |

---

## 3. 作成・変更ファイル一覧

### 3.1 変更対象ファイル

| パス | 責務 | 主な変更内容 |
|---|---|---|
| `next.config.ts` | Next.js 全体設定 | 静的ヘッダー（HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy）の設定。**CSP は重複防止のため除外**。 |
| `src/middleware.ts` | Edge/HTTP ミドルウェア | HTTPS 強制、CORS / CSRF 信頼オリジン分離検証、動的 CSP nonce 生成 (`x-nonce`) と `Content-Security-Policy` ヘッダー付与。 |
| `src/config/rate-limits.ts` | レート制限閾値定義 | 全 13 キーに対する基本制限値、ソフト制限値（CAPTCHA）、ハード制限値（429）を定義。 |
| `src/lib/auth/rate-limit.ts` | レート制限実装 | 単一アトミック SQL (`INSERT ... ON CONFLICT DO UPDATE RETURNING`) による競合防止、ハード制限突破時の初回ログ判定、`captchaRequired` 返却。 |
| `src/lib/db/schema.ts` | DB スキーマ定義 | `SECURITY_EVENT_TYPES` 配列に `rate_limited`, `captcha_challenged` を追加。 |

### 3.2 新規作成ファイル

| パス | 責務 |
|---|---|
| `src/lib/auth/rate-limit-keys.ts` | 13 キーに対する型安全なキー生成ヘルパー（HMAC-SHA256 によるメールアドレス保護含む）。 |
| `src/lib/auth/captcha.ts` | `CaptchaProvider` interface, `NoopCaptchaProvider`, および本番環境未設定ガード処理。 |
| `scripts/purge-expired.ts` | `rate_limit_hits` を含む **6 テーブル**（reservations / hits / 3種 token / sessions）の PostgreSQL 適合バッチ削除スクリプト。`security_events`（180 日保持）はパージ対象外。 |
| `src/test/security/web.test.ts` | Vitest による Headers, CORS, CSRF, HTTPS, Injection, Open Redirect, レート制限アトミックテスト。 |
| `src/test/security/idor.test.ts` | 現存する Phase 1/2 エンドポイント（セッション破棄・セキュリティイベント取得）の IDOR テスト。 |
| `src/test/security/security-events-coverage.test.ts` | セキュリティイベント記録の網羅性とログサプレッションの検証（計画 P2-07）。 |
| `src/test/security/web-attack.test.ts` | XSS / SQLi / clickjacking / Open Redirect / IDOR の各テスト（計画 P2-08）。`web.test.ts` と分離し、各攻撃を独立 describe で検証。 |

---

## 4. Security Headers & CSP nonce 設計

### 4.1 Next.js 15 適合 CSP nonce アーキテクチャ

#### 伝達・レンダリング構造
1. **`src/middleware.ts`（単一設定元）**:
   - `crypto.getRandomValues(new Uint8Array(16))` を使用し、リクエストごとに暗号学的に安全な 16 バイト以上の Base64 文字列 `nonce` を生成（24文字）。
   - リクエストヘッダーに `requestHeaders.set('x-nonce', nonce)` および `requestHeaders.set('Content-Security-Policy', cspHeader)` を設定（Next.js レンダリングエンジンへの伝達）。
   - レスポンスヘッダーに `Content-Security-Policy` を付与：
     ```text
     default-src 'self';
     script-src 'self' 'nonce-{NONCE}' 'strict-dynamic';
     style-src 'self' 'unsafe-inline';
     img-src 'self' data: https:;
     font-src 'self';
     connect-src 'self';
     frame-ancestors 'none';
     base-uri 'self';
     form-action 'self';
     ```
   - **`next.config.ts` で CSP を重複設定しない**。

2. **Server Components (`layout.tsx`) での取得**:
   - Next.js 15 の非同期 API を使用：
     ```ts
     import { headers } from 'next/headers';

     export default async function RootLayout({ children }: { children: React.ReactNode }) {
       const headersList = await headers();
       const nonce = headersList.get('x-nonce') ?? undefined;

       return (
         <html lang="ja">
           <body>
             {children}
             <Script src="..." nonce={nonce} />
           </body>
         </html>
       );
     }
     ```

3. **動的レンダリングとキャッシュへの影響**:
   - リクエストごとに一意な nonce を生成・付与するため、nonce を参照するページは **Dynamic Rendering（SSR）** となり、静的 HTML キャッシュ（SSG/ISR）は無効化される。本認証システムは全認証画面が動的保護対象であるため、この挙動を前提設計とする。

4. **nonce 欠落・不一致時の挙動**:
   - nonce の付与されていないインラインスクリプトや、不一致な script タグはブラウザの CSP エンジンによって実行が阻止され、ブラウザコンソールに CSP 違反エラーが出力される。

5. **テストの役割分担**:
   - **Vitest (`web.test.ts`)**: レスポンスヘッダーの CSP 文字列、`x-nonce` の存在、Base64 形式、重複ヘッダーのないことを検証。
   - **Playwright (E2E タスク)**: 実際のヘッドレスブラウザでページを読み込み、nonce なしスクリプトがブロックされ、正規スクリプトのみ実行されることを検証。

---

## 5. HTTPS 強制・CORS・CSRF 防御設計

### 5.1 HTTPS 強制・プロキシ信頼条件・クライアント IP 抽出規則

1. **信頼プロキシ前提**:
   - Vercel, Cloudflare, AWS ALB 等のエッジプロキシがクライアントの偽装 `X-Forwarded-Proto` を上書きする前提とする。
2. **マルチヘッダー・欠落処理**:
   - `X-Forwarded-Proto` がカンマ区切り（例: `https, http`）の場合、**最先頭（最外郭プロキシが設定した値）** を評価する。
   - ヘッダー欠落時は `request.nextUrl.protocol === 'https:'` を確認。
   - 不正値・非 `https` の場合は `308 Permanent Redirect` を返す。
3. **安全なリダイレクト URL 構築**:
   - 未検証の `Host` ヘッダーを直接使用せず、`NEXT_PUBLIC_APP_URL` のオリジンまたは許可ホストリスト（`ALLOWED_HOSTS`）と一致することを確認してリダイレクト先 URL を組み立て、Host Header Injection や Open Redirect を防ぐ。
4. **開発環境の例外**:
   - `process.env.NODE_ENV === 'development'` または ホストが `localhost` / `127.0.0.1` の場合は HTTPS 強制をスキップ。
5. **クライアント IP 抽出規則（レート制限キーの根幹）**:
   - **信頼ホップ数** を `TRUSTED_PROXY_HOPS`（既定 `0` = プロキシ未信頼）で指定。`0` の場合はソケット IP（`request.ip` または TCP 接続元）を採用。
   - **プラットフォーム固有ヘッダー** を `TRUSTED_PROXY_HEADER`（例: `cf-connecting-ip` / `x-vercel-forwarded-for` / `x-forwarded-for`）で指定し、指定時はそのヘッダーの **最先頭値** を採用（`TRUSTED_PROXY_HOPS` と併用可）。
   - **既定は「プロキシ未信頼＝ソケット IP」**。`X-Forwarded-For` の左端値はクライアント偽装可能なため **信頼しない**。
   - IPv6 は **`/64` プレフィクスで集約** してレート制限キーに使用（`src/lib/util/ip.ts` の `maskIpv6` と整合：前半グループのみ保持）。IPv4 は単一アドレスとして扱う。
   - この規則は `src/lib/auth/session.ts` の `getClientIp()` と `src/lib/util/ip.ts` の `hashIp()` / `maskIp()` の実装と一致させること。

    - **実装状況と今後の整合（U-03 関連）**: 現行 `getClientIp()`（`src/lib/auth/session.ts:26-33`）は `x-forwarded-for` の **左端値** を無条件に採用し、`TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` には対応していない。これは **プロキシ未信頼の既定方針に反する**。Phase 2 実装時に上記規則に合わせて修正し、左端値は信頼しないこと（U-03）。

### 5.2 CORS 許可リスト設計

- **設定変数**: `ALLOWED_ORIGINS`（カンマ区切り）。未設定時は `NEXT_PUBLIC_APP_URL` のみ。
- **ワイルドカード `*` 禁止**。
- `Access-Control-Allow-Credentials: true` は `Origin === NEXT_PUBLIC_APP_URL` の場合のみ返却。

### 5.3 CSRF 防御設計（CORS からの完全分離・計画 §8.4 完全準拠）

1. **設定の分離**:
   - CORS 用 `ALLOWED_ORIGINS` とは別に、CSRF 検証用設定 **`CSRF_TRUSTED_ORIGINS`**（デフォルト: `NEXT_PUBLIC_APP_URL`）を定義。

2. **二段構えの CSRF 防御（計画 §8.4 準拠）**:
   - **第1段階: Origin / Referer 検証**（許可リスト外なら即座に `403`）。`new URL(origin).origin` による `scheme`, `host`, `port` の完全一致を検証。`Origin` が存在しない場合は `Referer` ヘッダーから `new URL(referer).origin` を抽出して検証。両方欠落・`Origin: null`・不正 URL 形式の場合は **`403 Forbidden`** で拒否。
   - **第2段階: `X-CSRF-Token` ヘッダー検証**（Session 派生 HMAC と照合）。`src/lib/auth/pipeline.ts` の共通関数 `validateCsrfToken()` を使用し、定数時間比較（`timingSafeEqualStr`）で検証。

3. **共通パイプラインの唯一実装**:
   - **Route Handler と Server Action の双方**は `src/lib/auth/pipeline.ts` の `runCorePipeline()` を通す。**同一の検証関数を共有し、二重実装しない**。
   - `"Server Action だから CSRF 検証を省略する"` 解釈を **禁止**する。Server Action も共通パイプラインを通過し、token 検証を受ける（自動付与が落ちてもサーバ側で拒否）。
   - 例外は **OAuth コールバック等、仕様上 GET が必要な経路のみ**。この経路は `state` + OIDC `nonce` で CSRF を担保し、`X-CSRF-Token` 方式では代替しない。

4. **Origin 判定ロジックの共有**:
   - `isAllowedOrigin()` は `src/lib/auth/pipeline.ts` に 1 箇所のみ定義し、middleware（早期拒否用）と共通パイプライン（本検証用）から呼ぶ。**二重実装しない**。

5. **処理順序（Route Handler / Server Action 共通・計画 §8.4 完全準拠）**:
   ```text
   mutation（POST / PUT / PATCH / DELETE）
     ↓
   Origin / Referer 検証（許可リスト外なら 403）
     ↓
   CSRF 検証（X-CSRF-Token と session 派生 HMAC の照合）
     ↓
   認証確認（requireUser）
     ↓
   再認証確認（必要な操作のみ requireReauth）
     ↓
   認可確認（requireRole / owner 確認）
     ↓
   入力検証（zod）
     ↓
   処理（＋ security_events 記録）
   ```
   - CSRF 失敗・Origin 不一致は認証・認可より **先に** `403` + `CSRF_FAILED` で弾く。
   - **レート制限の加算は CSRF 検証後**（無駄なカウントを避けるため）。

6. **Server Actions の `allowedOrigins` との整合**:
   - Next.js 組み込み Origin チェック（`serverActions.allowedOrigins`）は Host / X-Forwarded-Host ベースであり、`CSRF_TRUSTED_ORIGINS` とは別物。プロキシ配下では両者の許可リストを環境変数で一致させること。
   - ミドルウェアでの早期拒否（第1段階のみ）と、共通パイプラインでの本検証（第1・2段階）を併用し、Edge runtime で Node crypto / PG が使えない制約を吸収する。

    - **実装上の注意（U-05）**: 現行 `runCorePipeline()`（`src/lib/auth/pipeline.ts:77-79`）は `isMutation` を `request.method` 而非 `Content-Type` で判定する不具合（`getContentType()` の結果を無視して POST と固定）がある。本設計書の「GET では状態変更しない（§25）」に反し、`Content-Type: application/json` の GET リクエストが mutation 扱いされ CSRF 検証が走る。Phase 2 実装時に `request.method` で正しく判定すること。

7. **Session Cookie 属性と `__Host-` プレフィックス強化**:
   - セッション Cookie には `HttpOnly`, `SameSite=Lax`, `Path=/` を常時付与し、`NODE_ENV === 'production'`（HTTPS環境）では `Secure` 属性および **`__Host-` プレフィックス** (`__Host-auth_session`) を必須付与する。`__Host-` プレフィックス使用時は **`Domain` 属性を指定してはならない (Omit Domain)**、**`Secure` 属性必須**、**`Path=/` 必須**（Cookie Prefixes 仕様／`draft-ietf-httpbis-layered-cookies-02` §4.1.3.2 **Internet-Draft** 準拠。正式な RFC 発行前のため将来変更の可能性あり）。これによりサブドメインからの Cookie 上書き・ハイジャックを防止する。実装は `src/lib/auth/cookie.ts` の `SESSION_COOKIE = '__Host-auth_session'` に一致。

---

## 6. レート制限 13 キー・HMAC・原子性・CAPTCHA フロー設計

### 6.1 カウント方式の明確な分類と実装上の注意

1. **全リクエスト対象キー (All-request Counter Keys)**:
   - 対象 API 呼び出し時に、認証合否にかかわらず実行前にカウントをインクリメント。
   - カウントがハード制限に達している場合（上限回数実行済み）、次回リクエストは処理を実行せず直ちに `429 Too Many Requests` を返却。
   - 実装: `rateLimiter.check()` の単一アトミック SQL (`INSERT ... ON CONFLICT DO UPDATE RETURNING count`) で実行前にインクリメントし、戻り値 `count > max` で拒否判定。並行実行下でも行ロックにより上限を厳密に保証。

2. **失敗試行対象キー (Failed-attempt Counter Keys)**:
   - **設計意図**: 認証処理の**実行前**に現在の失敗カウントを読み取り判定。
      - 失敗カウント >= ハード制限上限（例: 5回失敗済み）: 認証処理（パスワード検証等）を実行せず `429 Too Many Requests` を返却。
      - ソフト制限 <= 失敗カウント < ハード制限: CAPTCHA 検証を実施。失敗時は認証処理を実行せず `400 Bad Request`。
   - **認証失敗時のみ**カウントを原子的にインクリメント。
   - **認証成功時**は失敗カウントを即座に削除・リセット（`DELETE FROM rate_limit_hits WHERE key IN ('rl:login:acct:{email_hmac}', 'rl:login:ip+acct:{ip}:{email_hmac}')`）。
   - **【実装ギャップ・要対応】** 現行実装 (`src/app/api/auth/login/route.ts`) では、全 3 キー (`rl:login:ip`, `rl:login:acct`, `rl:login:ip+acct`) を同一の `rateLimiter.check()` で呼び出しており、**全リクエスト対象キーと同様に実行前に無条件インクリメントしている**。失敗試行キーの「事前読み取り判定→失敗時のみインクリメント→成功時 DELETE」という設計フローは**未実装**である。

3. **実行枠予約方式（Reservation Pattern）の導入**:
   - **課題**: 失敗時のみインクリメントする設計では、認証処理実行後にカウントを増やすため、ハード上限直前で複数リクエストが同時到着すると、上限を超えて認証処理が並行実行されてしまう（例: 上限 5・現在 4 で A/B 同時到着 → 両方とも認証実行 → 双方失敗でカウント 6 に到達）。
   - **解決**: 認証処理**開始前に**実行枠を原子的に確保する「予約方式」を採用する。予約ごとに**一意の予約ID**（`reservation_id` = UUID v7 または `gen_random_uuid()`）を発行し、予約レコードとして管理する。
   - **スキーマ設計**（専用予約テーブル `rate_limit_reservations` を新設）:
     ```sql
     CREATE TABLE rate_limit_reservations (
       reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       key text NOT NULL REFERENCES rate_limit_hits(key) ON DELETE CASCADE,
       generation bigint NOT NULL,          -- カウンター行の世代番号
       status text NOT NULL DEFAULT 'active', -- 'active' | 'confirmed' | 'released' | 'expired'
       created_at timestamptz NOT NULL DEFAULT NOW(),
       expires_at timestamptz NOT NULL,     -- 予約固有の TTL（ウィンドウ期限 + 猶予）
       confirmed_at timestamptz,
       released_at timestamptz
     );
     CREATE INDEX rate_limit_reservations_key_generation_idx ON rate_limit_reservations(key, generation);
     CREATE INDEX rate_limit_reservations_expires_at_idx ON rate_limit_reservations(expires_at);
     ```
     - `rate_limit_hits` に `generation`（`bigint NOT NULL DEFAULT 1`）と `failed_count`（`integer NOT NULL DEFAULT 0`）を追加。`count` 列は `failed_count` に改名し、**失敗確定数のみ**を保持する。実行中予約数は `rate_limit_reservations` で `status='active' AND generation=hits.generation` を数えて求める。
     - ※ 既存スキーマで代替する場合は、単一カラム `count = failed_count + active_reservations` 合算運用も可能だが、予約所有権の保証には予約レコード方式が最も堅牢。本設計では専用テーブルを採用するが、実装時に列追加のみで代替する場合も設計書で方針のみ確定。実際の DB 変更は行わない。
- **予約確保（認証実行前）**：
      ```sql
      -- 単一トランザクションで「上限未満なら予約レコードを作成」
      -- 同一キーの同時予約を直列化するため、hits 行を FOR UPDATE でロック
      BEGIN ISOLATION LEVEL REPEATABLE READ;
      
      -- 1. カウンター行をロックして取得（存在しなければ作成）
      INSERT INTO rate_limit_hits (key, generation, failed_count, window_expires_at)
      VALUES ($1, 1, 0, NOW() + $window)
      ON CONFLICT (key) DO UPDATE SET
        generation = rate_limit_hits.generation,
        failed_count = rate_limit_hits.failed_count,
        window_expires_at = CASE
          WHEN rate_limit_hits.window_expires_at <= NOW() THEN NOW() + $window
          ELSE rate_limit_hits.window_expires_at
        END
      WHERE rate_limit_hits.window_expires_at > NOW()  -- 期限切れ行は新しい世代として扱う
      RETURNING generation, failed_count, window_expires_at;
      
      -- 2. アクティブ予約数をロック内でカウントし、上限判定して予約作成
      WITH current AS (
        SELECT generation, failed_count FROM rate_limit_hits WHERE key = $1
      ), reserve_check AS (
        SELECT c.generation, c.failed_count,
               COUNT(r.reservation_id) AS active_count
        FROM current c
        LEFT JOIN rate_limit_reservations r
          ON r.key = $1 AND r.generation = c.generation AND r.status = 'active'
        GROUP BY c.generation, c.failed_count
      )
      INSERT INTO rate_limit_reservations (key, generation, expires_at)
      SELECT $1, generation, NOW() + $window + INTERVAL '30 seconds'
      FROM reserve_check
      WHERE failed_count + active_count < $hard_limit
      RETURNING reservation_id, generation;
      
      COMMIT;
      ```
      - **原子性の保証**: `BEGIN ... COMMIT` 単一トランザクション内で hits 行ロック（`INSERT ... ON CONFLICT` が行ロックを取得）→ アクティブ予約数カウント → 上限判定 → 予約INSERT を連続実行。`REPEATABLE READ` 分離レベルでファントムリードを防ぎ、同時リクエスト A/B は直列化される。
      - **初回行作成との競合**: `ON CONFLICT DO UPDATE` が既存行をロックしつつ `generation` と `failed_count` を維持。期限切れ行（`window_expires_at <= NOW()`）は `WHERE` 句で除外され、新しい行として扱われる（実質的に世代交代）。
      - **上限到達時の振る舞い**: `failed_count + active_count >= hard_limit` の場合、CTE `reserve_check` の `WHERE` 句で行が返らず、予約INSERTは実行されない。トランザクションは正常コミットされ、アプリ側は戻り値なし＝`429` と判定。
      - **リトライ条件**: 並行トランザクションによるシリアライゼーション失敗（`SQLSTATE 40001`）はアプリ側で即時リトライ（最大 3 回、指数バックオフ）。
   - **ソフト制限・CAPTCHA 判定**: 予約確保時点で `failed_count`（失敗確定数）を見て判定。`failed_count >= soft_limit` なら CAPTCHA 必須。CAPTCHA 検証失敗時は自分の予約だけ `status='released'` にして `400`。
- **認証成功時**: **自分の予約だけ** `status='released'` に更新し、`rate_limit_hits` の **`failed_count` を 0 にリセット**（`generation` は **インクリメントしない**。同一ウィンドウ内の他予約を無効化しないため）。**行全体を削除しない**。
      ```sql
      BEGIN ISOLATION LEVEL REPEATABLE READ;
      -- 自分の予約かつ active 状態のみ release（二重 release 防止）
      UPDATE rate_limit_reservations
      SET status = 'released', released_at = NOW()
      WHERE reservation_id = $my_reservation_id
        AND status = 'active';
      
      -- 対応するヒット行の failed_count を 0 にリセット
      UPDATE rate_limit_hits
      SET failed_count = 0
      WHERE key = $key AND generation = $my_generation;
      COMMIT;
      ```
      - **冪等性**: `status = 'active'` 条件により、同じ `reservation_id` の再実行は 0 行更新となり、カウンターを二重リセットしない。
      - `generation` を変えないため、同じウィンドウ内の他の実行中予約（他のリクエストの認証処理）は有効なまま継続し、完了時にそれぞれ自分の予約を確定・解放する。
    - **認証失敗時**: **自分の予約だけ** `status='confirmed'`, `confirmed_at=NOW()` に更新し、`rate_limit_hits.failed_count++`。
      ```sql
      BEGIN ISOLATION LEVEL REPEATABLE READ;
      -- 自分の予約かつ active 状態のみ confirmed（二重確定防止）
      UPDATE rate_limit_reservations
      SET status = 'confirmed', confirmed_at = NOW()
      WHERE reservation_id = $my_reservation_id
        AND status = 'active';
      
      -- 確定した場合のみ failed_count をインクリメント
      UPDATE rate_limit_hits
      SET failed_count = failed_count + 1
      WHERE key = $key AND generation = $my_generation
        AND EXISTS (
          SELECT 1 FROM rate_limit_reservations
          WHERE reservation_id = $my_reservation_id
            AND status = 'confirmed'
        );
      COMMIT;
      ```
      - **冪等性・二重確定防止**: `status = 'active'` 条件で 1 回だけ遷移可能。`EXISTS` 副問合せで「自分の予約が確定済み」の場合のみカウンター加算。
      - 別のリクエストの予約や、別の `generation` の行は一切触れない。
      - トランザクション途中でエラー・ロールバック時、予約は `active` のまま残る（`try...finally` で release または TTL で expired へ）。
   - **内部エラー・プロセス停止・タイムアウト時の予約解放**:
      - **認証実行タイムアウト**: 認証処理（パスワード検証等）に **上限 5 秒** を設定（`statement_timeout` またはアプリ側 `Promise.race`）。タイムアウト時は即座に自分の `reservation_id` を `status='released'` に更新。
      - **プロセスクラッシュ・強制終了**: `try...finally` は正常終了・例外時に確実に release するが、OS シグナル（`SIGKILL` 等）でプロセスが即死した場合は実行されない。このケースは **予約固有の `expires_at` TTL** でカバーする。
      - **TTL 設計**: `expires_at = NOW() + $window + INTERVAL '30 seconds'`（ウィンドウ期限 + 猶予 30 秒）。認証処理が 5 秒以内に終わる前提で、猶予はネットワーク遅延・GC 停止等を吸収。
      - **期限切れ回収**: バッチ処理（`scripts/purge-expired.ts`）が `expires_at < NOW() AND status='active'` の予約を `status='expired'` に更新（物理削除は完了済み予約のみ）。`expired` 遷移は **状態変更のみ** で `failed_count` には影響しない。
      - **期限切れ後の遅延処理**: 予約が `expired` になった後に元の認証処理が戻ってきても、`UPDATE ... WHERE status='active'` が 0 行更新となり、確定・release ともに無効化される。カウンターは変更されない。
      - **延長しない**: 予約の延長は行わない。認証処理が長引く場合は設計上 5 秒で打ち切り、クライアントには `504 Gateway Timeout` または `400` を返す。延長機構を入れると、複数プロセス間での延長競合・期限切れ判定の不整合を招くため。
      - **上限の安全側倒れ**: TTL 回収に失敗（バッチ停止等）しても、予約は `active` のまま `expires_at` 経過後も残る。これにより `total_in_use` 計算に含まれ続け、**上限が無条件に緩和されることはない**（安全側＝制限が厳しくなる方向に倒れる）。
   - **並行制御**: 予約確保トランザクションは `rate_limit_hits` 行ロック（`SELECT ... FOR UPDATE` または `INSERT ... ON CONFLICT`）を取得し、同一キーへの同時予約を直列化。`total_in_use < hard_limit` 判定をロック内で原子的に実行。

4. **カウンター行の初期化・世代管理・再生成の保証**:
   - **世代番号の生成**: `generation` は `bigint` で、**単調増加**（`DEFAULT 1`、行再作成時に `COALESCE(max(generation), 0) + 1`）。ウィンドウ期限切れで行が削除された後の新規作成時は、過去最大値 + 1 を割り当て、**再利用しない**。これにより「古い予約の `generation` が新しい行と一致する」事象を物理的に防止。
   - **初回予約**: `rate_limit_hits` 行が存在しない場合、予約確保トランザクション内で `INSERT ... ON CONFLICT` で `generation=1, failed_count=0` の行を作成し、同一トランザクションで予約レコードを `generation=1` で作成。`reservation_id` を発行。
   - **成功時リセット後の再予約**: 成功時は `failed_count=0` にリセットするのみで **`generation` はインクリメントしない**（同一ウィンドウ内の他予約を生かすため）。次のリクエストが予約を取る際は、同じ `generation` の行に対して予約レコードを追加する。
   - **ウィンドウ期限切れ後の初回予約**: `rate_limit_hits.window_expires_at < NOW()` の場合、バッチ削除で行と関連予約が物理削除済み。次の予約確保トランザクションでは、`ON CONFLICT` 更新の `WHERE window_expires_at > NOW()` 条件により既存行がスキップされ、新しい行が `generation = COALESCE((SELECT max(generation) FROM rate_limit_hits WHERE key=$1), 0) + 1` で作成される。クリーンな状態から開始。
   - **同時初回アクセス**: 複数プロセスが同時に初回予約を試みる場合、予約確保トランザクションの行ロックで直列化。1 つだけが行作成、他は既存行への予約追加として処理。最終的な `total_in_use = failed_count + active予約数` で上限判定される。
   - **予約確保と行削除の並行**: 成功時は行を削除**しない**（`failed_count=0` リセットのみ）。したがって DELETE と予約確保の競合は発生しない。ウィンドウ期限切れによるバッチ削除は `window_expires_at < NOW()` かつ `active` 予約がない行のみ対象（`NOT EXISTS (SELECT 1 FROM rate_limit_reservations WHERE key=hits.key AND status='active')`）。
   - **上限到達行の予期せぬ削除**: バッチ削除は `window_expires_at < NOW()` かつアクティブ予約なしの行のみ。成功時リセットも行削除しないため、実行中予約が消えることはない。
   - **古い予約の失敗確定が新しいウィンドウを破壊しない**: 予約レコードには作成時の `generation` が紐づく。失敗確定 UPDATE は `WHERE key=$1 AND generation=$my_generation` で実行。ウィンドウ期限切れで行が再生成された場合、新しい行の `generation` は古いものより大きいため、古い予約の `generation` は一致せず、**新しい `failed_count` には一切加算されない**。古い予約が確定しようとしても `WHERE generation=$old` で 0 行更新となり、安全に無視される。

5. **成功時リセットと失敗確定の競合（予約ID・世代番号方式での確定設計）**:
   - **前提**: 成功・失敗ともに **自分の `reservation_id` のみ**を対象に更新。`generation` も一致確認。`status='active'` のときだけ遷移可能（冪等・二重実行防止）。
   - **順序ベースの最終状態ルール**（同一 `generation` 内）:
     - **ルール 1（成功優先クリア）**: 失敗確定が先にコミット → 成功リセットが後からコミット
       - 失敗確定: `failed_count = N+1`
       - 成功リセット: `failed_count = 0`
       - **最終結果: `failed_count = 0`**（成功が優先し、失敗カウントをクリア）。
     - **ルール 2（成功前開始の失敗は記録）**: 成功リセットが先にコミット → 失敗確定が後からコミット
       - 成功リセット: `failed_count = 0`
       - 失敗確定: `failed_count = 1`（自分の予約のみ確定、別予約の release には影響しない）
       - **最終結果: `failed_count = 1`**（成功前に開始したリクエストの失敗は正しく記録）。
     - **ルール 3（異なる予約の独立性）**: A成功 → C新規予約（同一 `generation`）→ B失敗確定
       - A成功: `failed_count = 0`
       - C予約: `total_in_use` 増加（`failed_count` 変更なし）
       - B確定: `failed_count = 1`
       - **最終結果: Bの失敗のみ記録**。Cは別 `reservation_id` なので影響なし。
     - **ルール 4（世代分離）**: 古い予約（`generation=N`）の失敗確定が、新しいウィンドウ（`generation=N+1`）の `failed_count` を汚染しない
       - 古い予約の UPDATE: `WHERE generation=N` → 新しい行（`generation=N+1`）は 0 行更新
       - **最終結果: 新しいウィンドウの `failed_count` は 0 のまま**。
   - **成功時リセットの対象**: `failed_count`（失敗確定数）のみを 0 にリセット。**全リクエスト対象キー（`rl:login:ip` 等）はリセットしない**。これらは「処理実行前インクリメント」方式であり、成功・失敗に関わらずカウントが積み上がる設計のため。
   - **期限切れ予約の成功リセット**: 成功リセット実行時点で自分の予約が既に `expired` になっている場合、`UPDATE ... WHERE status='active'` は 0 行更新となり release しない。ただし `failed_count=0` リセットは実行される（**現在の世代の失敗履歴をクリア**するため）。これは「認証成功した事実」を優先し、期限切れで予約を失っても履歴リセットは行う設計。
   - **設計決定**: **予約ID・世代番号・状態ガードで所有権を完全分離**。成功時は行削除せず `failed_count=0` リセットのみ。失敗確定は自分の予約のみ確定。コミット順序により「成功優先クリア（ルール 1）」または「成功前開始の失敗は記録（ルール 2）」となり、仕様を明確化。異なる世代は物理的に分離（ルール 4）。
   - 現行実装では成功時リセットが**存在しない**ため、この競合は発生しない。現状は **「成功時リセット未実装のため競合なし」** と記述するに留める。

### 6.2 全 13 キーの仕様一覧

| キー名 | 用途 | 識別子 | カウント対象 | インクリメントタイミング | 時間枠 | 許可される最大回数 | ソフト制限 (CAPTCHA要求) | 拒否が始まる正確な回数 | 拒否 Status | ログ記録タイミング | 本番 CAPTCHA 未設定時 | テスト方法 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `rl:register:ip:{ip}` | ユーザー登録 | Client IP | 全リクエスト | 処理実行前 | 1h (3600s) | 5回 | 4回目から要求 | **6回目から拒否** (429) | 429 | `count === 6` (6回目拒否時) | 400 Bad Request | Vitest |
| `rl:login:ip:{ip}` | ログイン (IP) | Client IP | 全リクエスト | 処理実行前 | 5m (300s) | 20回 | 6回目から要求 | **21回目から拒否** (429) | 429 | `count === 21` (21回目拒否時) | 400 Bad Request | Vitest |
| `rl:login:acct:{email_hmac}` | ログイン (アカウント) | HMAC-SHA256(email) | 失敗試行 | 認証失敗後 | 15m (900s) | 5失敗 | 4回目試行から要求 | **6回目試行から拒否** (429) | 429 | `count === 5` (5回目失敗記録時) | 400 Bad Request | Vitest |
| `rl:login:ip+acct:{ip}:{email_hmac}` | ログイン (複合) | IP + HMAC-SHA256(email) | 失敗試行 | 認証失敗後 | 15m (900s) | 5失敗 | 4回目試行から要求 | **6回目試行から拒否** (429) | 429 | `count === 5` (5回目失敗記録時) | 400 Bad Request | Vitest |
| `rl:forgot:email:{email_hmac}` | PWリセット (Email) | HMAC-SHA256(email) | 全リクエスト | 処理実行前 | 1h (3600s) | 5回 | 3回目から要求 | **6回目から拒否** (429) | 429 | `count === 6` (6回目拒否時) | 400 Bad Request | Vitest |
| `rl:forgot:ip:{ip}` | PWリセット (IP) | Client IP | 全リクエスト | 処理実行前 | 1h (3600s) | 10回 | 6回目から要求 | **11回目から拒否** (429) | 429 | `count === 11` (11回目拒否時) | 400 Bad Request | Vitest |
| `rl:resend:user:{user_id}` | メール再送信 (User) | User ID | 全リクエスト | 処理実行前 | 1h (3600s) | 5回 | 4回目から要求 | **6回目から拒否** (429) | 429 | `count === 6` (6回目拒否時) | 400 Bad Request | Vitest |
| `rl:resend:ip:{ip}` | メール再送信 (IP) | Client IP | 全リクエスト | 処理実行前 | 1h (3600s) | 10回 | 6回目から要求 | **11回目から拒否** (429) | 429 | `count === 11` (11回目拒否時) | 400 Bad Request | Vitest |
| `rl:oauth:start:{ip}` | OAuth開始 (P4) | Client IP | 全リクエスト | 処理実行前 | 10m (600s) | 10回 | 6回目から要求 | **11回目から拒否** (429) | 429 | `count === 11` (11回目拒否時) | 400 Bad Request | Vitest |
| `rl:oauth:callback:{ip}` | OAuthCallback (P4) | Client IP | 全リクエスト | 処理実行前 | 10m (600s) | 20回 | 11回目から要求 | **21回目から拒否** (429) | 429 | `count === 21` (21回目拒否時) | 400 Bad Request | Vitest |
| `rl:2fa:user:{user_id}` | 2FA検証 (P5) | User ID | 失敗試行 | 認証失敗後 | 5m (300s) | 10失敗 | 4回目試行から要求 | **11回目試行から拒否** (429) | 429 | `count === 10` (10回目失敗記録時) | 400 Bad Request | Vitest |
| `rl:passkey:ip:{ip}` | Passkey (P6) | Client IP | 全リクエスト | 処理実行前 | 5m (300s) | 30回 | 11回目から要求 | **31回目から拒否** (429) | 429 | `count === 31` (31回目拒否時) | 400 Bad Request | Vitest |
| `rl:settings:user:{user_id}` | 設定変更 | User ID | 全リクエスト | 処理実行前 | 1m (60s) | 120回 | 61回目から要求 | **121回目から拒否** (429) | 429 | `count === 121` (121回目拒否時) | 400 Bad Request | Vitest |

### 6.3 メールアドレス識別子の HMAC-SHA256 保護

1. **ハッシュ方式の改善**:
   - メールアドレスを `email.trim().toLowerCase()` で正規化した上で **HMAC-SHA256** を適用。
   - `crypto.createHmac('sha256', secret).update(normalizedEmail).digest('hex')` を使用。
2. **秘密鍵管理とフォールバック**:
   - 秘密鍵には `process.env.RATE_LIMIT_SECRET` を使用（未設定時は `TOKEN_PEPPER` を安全にフォールバック利用）。

### 6.4 CAPTCHA 本番安全制御（フェイルクローズ）

1. **本番環境でのバイパス防止 (`NoopCaptchaProvider` ガード)**:
   - `NODE_ENV === 'production'` の環境において、実 Turnstile プロバイダーが設定されていない（`TURNSTILE_SECRET_KEY` なし）場合、ソフト制限を超過したリクエスト（CAPTCHA 必須領域）は **`500 Internal Server Error (CAPTCHA_UNCONFIGURED)`** で安全に拒否する。`NoopCaptchaProvider` による自動無条件許可は dev/test 環境限定とする。利用者の入力エラー（400系）とサーバー環境設定エラー（500系）を厳密に区別する。
2. **ハード制限の最優先適用**:
   - CAPTCHA 検証に成功した場合であっても、カウントがハード制限値を超えている場合は **無条件に 429 Too Many Requests** で拒否する。
3. **エラー HTTP ステータスの明確な契約**:
   - 利用者による CAPTCHA トークン未提供 / 無効: `400 Bad Request` (`code: "CAPTCHA_REQUIRED"` / `"CAPTCHA_INVALID"`)
   - CAPTCHA プロバイダー一時障害・通信エラー: `503 Service Unavailable` (`code: "CAPTCHA_PROVIDER_ERROR"`)
   - サーバー設定未完了（`TURNSTILE_SECRET_KEY` 未設定）: `500 Internal Server Error` (`code: "CAPTCHA_UNCONFIGURED"`)
   - ハード制限超過: `429 Too Many Requests` (`code: "RATE_LIMIT_EXCEEDED"`)

---

## 7. 期限切れデータ削除スクリプト設計

### 7.1 PostgreSQL 適合バッチ削除構文（セッション30日保持の完全分離）

#### `scripts/purge-expired.ts` 実行クエリ一覧

```sql
-- 1. rate_limit_reservations: 期限切れかつ完了済みの予約を削除
DELETE FROM rate_limit_reservations
WHERE reservation_id IN (
  SELECT reservation_id FROM rate_limit_reservations
  WHERE expires_at < NOW()
    AND status IN ('confirmed', 'released', 'expired')
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 2. rate_limit_reservations: 期限切れでまだ active な予約を expired に更新（物理削除せず状態遷移）
UPDATE rate_limit_reservations
SET status = 'expired'
WHERE reservation_id IN (
  SELECT reservation_id FROM rate_limit_reservations
  WHERE expires_at < NOW()
    AND status = 'active'
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 3. rate_limit_hits: ウィンドウ期限切れかつアクティブ予約のない行を削除
DELETE FROM rate_limit_hits
WHERE key IN (
  SELECT h.key FROM rate_limit_hits h
  WHERE h.window_expires_at < NOW()
    AND NOT EXISTS (
      SELECT 1 FROM rate_limit_reservations r
      WHERE r.key = h.key AND r.status = 'active'
    )
  ORDER BY h.window_expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 4. email_verification_tokens (used_at 実在確認済み)
DELETE FROM email_verification_tokens
WHERE id IN (
  SELECT id FROM email_verification_tokens
  WHERE expires_at < NOW() OR used_at IS NOT NULL
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 5. password_reset_tokens (used_at 実在確認済み)
DELETE FROM password_reset_tokens
WHERE id IN (
  SELECT id FROM password_reset_tokens
  WHERE expires_at < NOW() OR used_at IS NOT NULL
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 6. email_change_requests (used_at 実在確認済み)
DELETE FROM email_change_requests
WHERE id IN (
  SELECT id FROM email_change_requests
  WHERE expires_at < NOW() OR used_at IS NOT NULL
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);

-- 7. sessions (未失効期限切れ vs 失効済み30日保持の完全分流)
DELETE FROM sessions
WHERE id IN (
  SELECT id FROM sessions
  WHERE (
    -- パターンA: 未失効かつ有効期限（通常または絶対）切れセッション
    (revoked_at IS NULL AND (expires_at < NOW() OR absolute_expires_at < NOW()))
    OR
    -- パターンB: 失効済みセッション（失効日時から30日経過後に削除）
    (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')
  )
  ORDER BY expires_at ASC
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);
```

### 7.2 安全性とバッチループ制御

- 削除件数が 0 件になるまで 1000 件単位のトランザクションで繰り返し実行。
- 複数プロセス同時実行時も `SKIP LOCKED` によりロック競合を回避。
- **予約の期限とウィンドウ期限の分離**: `rate_limit_reservations.expires_at` は予約固有の TTL（ウィンドウ期限 + 猶予 30 秒）。`rate_limit_hits.window_expires_at` はレート制限ウィンドウの期限。バッチ処理はそれぞれ独立して実行し、アクティブ予約がある行はウィンドウ期限切れでも削除しない。
- **プロセス停止で予約が永久に残らない**: `expires_at` 経過で `status='expired'` に遷移し、次のバッチで物理削除。`try...finally` での明示的解放も併用。

---

## 8. DB スキーマ・セキュリティイベント・分散ログ抑制設計

### 8.1 分散環境対応のログサプレッション（Throttled Logging）

複数サーバー・複数プロセス環境において、メモリ上のキャッシュによるログ抑制は機能しない。そのため、`PgRateLimiter` のアトミッククエリの戻り値（`RETURNING count`）を利用した **アトミック判定** を行う。

1. **全リクエスト対象キー**:
   - `count === hard_limit + 1`（6回目リクエストで初めて 429 拒否が発生したまさにその瞬間）に、`security_events` へ `rate_limited` イベントを 1 件だけ書き込む。
2. **失敗試行対象キー**:
   - `count === hard_limit`（5回目の失敗が記録され、上限に達したまさにその瞬間）に、`security_events` へ `rate_limited` イベントを 1 件だけ書き込む。
3. **ログ保護と非露出**:
   - `security_events.metadata` には生のメールアドレス、トークン、パスワードを一切含めない。IP アドレスは `ipMasked` を使用。

---

## 9. 環境変数仕様一覧

| 変数名 | 型・制約 | 用途 | 必須/任意 | 開発時デフォルト | 本番検証条件 | ログ出力 |
|---|---|---|---|---|---|---|
| `NODE_ENV` | Enum (`development`,`test`,`production`) | 実行モード | 必須 | `development` | Strict Enum | 可 |
| `NEXT_PUBLIC_APP_URL` | URL | アプリ Origin | 必須 | `http://localhost:3000` | 完全な HTTPS URL | 可 |
| `ALLOWED_ORIGINS` | カンマ区切り URL | CORS 許可 Origin | 任意 | `NEXT_PUBLIC_APP_URL` | 各値が URL | 可 |
| `CSRF_TRUSTED_ORIGINS` | カンマ区切り URL | CSRF 信頼 Origin | 任意 | `NEXT_PUBLIC_APP_URL` | 各値が URL | 可 |
| `ALLOWED_HOSTS` | カンマ区切り Host | HTTPS リダイレクト許可 Host | 任意 | Host from `NEXT_PUBLIC_APP_URL` | 各値が Host 名 | 可 |
| `RATE_LIMIT_SECRET` | 文字列 (min 32文字) | レート制限 HMAC 鍵 | 任意 | (Fallback: `TOKEN_PEPPER`) | 32文字以上 | **不可 (秘匿)** |
| `TOKEN_PEPPER` | 文字列 (min 32文字) | トークンハッシュ Pepper | 必須 | 定義値 | 32文字以上 | **不可 (秘匿)** |
| `IP_HASH_PEPPER` | 文字列 (min 32文字) | IPアドレスハッシュ Pepper | 必須 | 定義値 | 32文字以上 | **不可 (秘匿)** |
| `SESSION_PEPPER` | 文字列 (min 32文字) | セッションハッシュ Pepper | 必須 | 定義値 | 32文字以上 | **不可 (秘匿)** |
| `CSRF_SECRET` | 文字列 (min 32文字) | CSRF トークン HMAC 署名・検証 Pepper | 必須 | 定義値 | 32文字以上 | **不可 (秘匿)** |
| `TURNSTILE_SECRET_KEY` | 文字列 | CAPTCHA Secret | 任意 (P9) | 未設定 | 本番 CAPTCHA 時必須 | **不可 (秘匿)** |

---

## 10. セキュリティテスト計画

### 10.1 テストツールの役割分担

| ツール | 担当範囲 | 実行スクリプト |
|---|---|---|
| **Vitest 5.0.3** | Headers, CORS, CSRF, Route Handlers, レート制限アトミック性, purge スクリプト, IDOR | `pnpm test:security` / `pnpm test` |
| **Playwright** | 実ブラウザでの CSP 実行制御、`<Script>` nonce 自動適用、UI 総合 E2E | Phase 2 E2E タスク（`package.json` 追加入力時） |

### 10.2 テストシナリオ詳細

1. **CSP**: `x-nonce` リクエストヘッダー伝達、レスポンスヘッダー検証、重複ヘッダーのないこと。
2. **CSRF**: 許可 Origin / 不許可 Origin / `Origin: null` / ヘッダー欠落時の 403 応答。Server Actions の保護。
3. **HTTPS**: カンマ区切り `X-Forwarded-Proto` 処理、偽装 Host ヘッダー時の安全なリダイレクト。
4. **レート制限 & CAPTCHA**: 13 キーの各閾値（ソフト/ハード）、全リクエストキーのアトミック並行クエリ検証、失敗試行キーの「実行枠予約確保→認証実行→失敗時確定/成功時 release・failed_count=0」フローの実装検証、同時到着時の上限厳守（hits 行ロック＋単一トランザクション）、予約ID所有権検証（Aの予約をBが誤操作しない）、成功リセット並行時の failed_count 結果（ルール 1: 失敗→成功で 0 / ルール 2: 成功→失敗で 1）、単調増加世代番号によるウィンドウ分離（古い予約が新しい世代に加算されない）、TTL 期限切れ予約の自動 expired 遷移・遅延処理の無効化、認証タイムアウト 5 秒・猶予 30 秒の境界、本番未設定時の 400/500 ガード拒否。
5. **Purge スクリプト**: 5 テーブルに対する削除、有効データの保持確認、0 件時の正常終了。

---

## 11. 推奨実装手順

1. **設定・キー生成**:
   - `src/config/rate-limits.ts`（13キー閾値定義）
   - `src/lib/auth/rate-limit-keys.ts`（HMAC-SHA256 ヘルパー、失敗試行キー用の「予約確保・確定・release・世代管理」メソッド含む）
   - `src/lib/auth/captcha.ts`（本番未設定ガード付き Provider）
2. **スキーマ拡張・アトミック レート制限 & ログ抑制**:
   - `rate_limit_hits` に `generation`, `failed_count` 列追加、`count` を `failed_count` に改名
   - `rate_limit_reservations` テーブル新設（予約ID・generation・status・expires_at・confirmed_at・released_at）
   - `src/lib/auth/rate-limit.ts`（予約確保・確定・release・世代管理のアトミック SQL、ログ判定。トランザクション分離レベル REPEATABLE READ、行ロック FOR UPDATE、シリアライゼーション失敗リトライ）
3. **ログインフローへの適用**:
   - `src/app/api/auth/login/route.ts` を修正し、失敗試行キー（`rl:login:acct`, `rl:login:ip+acct`）を予約方式フロー（予約確保 → CAPTCHA判定 → 認証実行 5 秒タイムアウト → 成功時 release+failed_count=0 / 失敗時確定 / タイムアウト・エラー時 release）で処理する
   - 全リクエストキー（`rl:login:ip` 等）は従来通り `rateLimiter.check()` で処理し、成功時リセット**しない**
4. **ミドルウェア強化**:
   - `src/middleware.ts`（HTTPS マルチヘッダー判定, CORS / CSRF 分離, nonce 生成・伝達）
   - `next.config.ts`（CSP を除く静的ヘッダー設定）
5. **バッチ削除スクリプト**:
   - `scripts/purge-expired.ts`（`rate_limit_reservations` の期限切れ expired 遷移・削除、`rate_limit_hits` のアクティブ予約なし行削除）
6. **テスト作成と検証**:
   - `src/test/security/web.test.ts`, `idor.test.ts`, `security-events-coverage.test.ts`
   - 並行到着・上限境界・予約ID所有権・成功リセット並行（ルール 1/2）・単調増加世代番号分離・TTL回収・認証タイムアウト・シリアライゼーションリトライの専用テストケース追加
   - `pnpm test:security`
7. **品質ゲート全パス確認**:
   - `pnpm lint && pnpm typecheck && pnpm test && pnpm test:security && pnpm build`

---

## 12. 検証手順

```bash
# 1. 開発サーバー起動
pnpm dev

# 2. ヘッダー及び CSP nonce 確認
curl -I http://localhost:3000/

# 3. CSRF 判定確認 (Origin 不正)
curl -H "Origin: https://evil.com" -X POST -I http://localhost:3000/api/auth/login
# 期待値: 403 Forbidden

# 4. バッチ削除スクリプト実行確認
npx tsx scripts/purge-expired.ts

# 5. セキュリティテスト実行
pnpm test:security

# 6. 品質ゲート（全チェック）
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

---

## 13. リスクと対処

| リスク | 影響 | 対処案 |
|---|---|---|
| レンダリング動的化によるキャッシュ失効 | nonce 使用ページが Dynamic Rendering になる | 全認証画面は保護対象であり SSR 前提設計とする。 |
| 本番環境での CAPTCHA バイパス | Captcha 未設定時に Noop が動くと攻撃を許す | `NODE_ENV === 'production'` 時に未設定なら 400 ガード拒否する。 |
| 複数プロキシ経由時の HTTPS 判定誤り | カンマ区切りヘッダーでリダイレクトループ発生 | 最外郭プロキシが設定した最先頭値を評価する。 |
| HMAC 鍵変更による一時的制限リセット | 秘密鍵変更時にキーが変わり一時的にカウントがリセットされる | 重大障害ではないため Graceful Reset として許容する。 |
| **失敗試行レート制限の上限保証不足** | 並行リクエストでハード上限（5回）を超えて認証処理が実行される可能性 | **実行枠予約方式を導入**（認証実行前に hits 行ロック＋単一トランザクションで `failed_count + active_count < hard_limit` を原子確保）。`rate_limit_reservations` テーブル新設・予約IDによる所有権分離で実装。 |
| 予約枠リーク（内部エラー・プロセス停止で解放されない） | 予約が永久に残り上限を誤って圧迫 | 予約固有の `expires_at` TTL で自動 `expired` 遷移、バッチ削除スクリプトの物理削除、アプリ側 `try...finally` での明示的 release。 |
| 成功時リセットと失敗確定の競合 | 成功優先の仕様が破綻し失敗カウントが残存 | 予約ID・世代番号・状態ガードで所有権完全分離。成功時は `failed_count=0` リセットのみ（行削除不行き）。コミット順序により「成功優先クリア（失敗→成功）」または「成功前開始の失敗は記録（成功→失敗）」に収束。 |
| 古いウィンドウの失敗確定が新しいウィンドウを破壊 | 成功リセット後に古い予約が失敗確定し、新しい failed_count を汚染 | **単調増加世代番号**でウィンドウ分離。古い予約の `generation` は新しい行と一致せず、UPDATE は 0 行更新で安全に無視。 |
| バッチ削除がアクティブ予約を持つ行を誤削除 | 実行中の認証処理の予約が消え、上限判定が狂う | `rate_limit_hits` 削除条件に `NOT EXISTS active予約` を必須化。予約は独立した `expires_at` で管理。 |
| 認証処理タイムアウト・強制終了での予約未解放 | 5 秒超過や SIGKILL で予約が active のまま残る | 予約固有 TTL（ウィンドウ + 30 秒）で自動 expired 遷移。延長機構は入れず、安全側（上限厳しく）に倒れる設計。 |
| 予約取得時のシリアライゼーション失敗 | 高並行時にトランザクション競合で失敗 | `REPEATABLE READ` + 行ロックで直列化。失敗時は即時リトライ（最大 3 回、指数バックオフ）。 |

---

## 14. 追加決定事項・未決事項

### 確定済み追加決定事項

| ID | 内容 | 理由 |
|---|---|---|
| D-25 | CORS (`ALLOWED_ORIGINS`) と CSRF (`CSRF_TRUSTED_ORIGINS`) の設定を分離 | 制御目的と信頼境界が異なるため。 |
| D-26 | メールアドレスキーのハッシュ化に HMAC-SHA256 を使用 | 辞書攻撃によるメールアドレス推測を防止するため。 |
| D-27 | 本番環境で Captcha 未設定の場合、ソフト制限超過リクエストを安全拒否する | Noop による本番バイパスを防ぐため。 |
| D-28 | `rate_limited` イベントはハード制限突破時のアトミック判定で 1 回のみ記録 | 分散環境での DB ログオーバーフローを防止するため。 |

### 未決事項（Unresolved Items）

| ID | 項目 | 課題・前提条件 | 推奨案 | 影響 |
|---|---|---|---|---|
| U-03 | 本番エッジプロキシのヘッダー評価順序 | デプロイ先（Cloudflare / Vercel / AWS 等）により `X-Forwarded-Proto` の付与規則が異なる場合がある。 | デプロイインフラ確定時（Phase 9）に最外郭プロキシの付与順序に合わせて評価インデックスを調整。 | Phase 2 では最先頭値評価で実装。 |

---

## 改訂履歴

| 版 | 日付 | 変更者 | 変更概要 |
|---|---|---|---|
| v1.0 | 2026-10-10 | 開発チーム | 初版作成。 |
| v1.1 | 2026-10-10 | セキュリティレビュー | CSP nonce レスポンス一元化、CORS/CSRF分離、アトミックPGレート制限、バッチ削除構文修正。 |
| v1.2 | 2026-10-10 | 追加セキュリティレビュー | 追加セキュリティレビュー反映。CSP Next.js 15 適合、CSRF 厳密比較、全 13 キー閾値表、HMAC 保護、`rate_limit_hits` 削除。 |
| v1.3 | 2026-10-10 | 最終決定レビュー | 最終決定版。全章・全表・全クエリの完全整合。 |
| v1.4 | 2026-10-10 | 最終確定 | 最終確定版。全矛盾の完全排除。 |
| v1.4.5 | 2026-10-10 | 最終精査 | 実装計画・実コード最終精査版。全 13 キーのカウント型と境界条件・アトミック判定式、セッション30日保持SQL、環境変数仕様の完璧な照合・固定完了。 |
| v1.5 | 2026-10-10 | 自律セキュリティレビュー | 自律的セキュリティレビュー反映。<br>1. Cookie接頭辞 `__Host-` プレフィックス (`__Host-auth_session`) と Secure/SameSite=Lax 連携仕様の追加。<br>2. ログイン成功時における失敗カウンターアトミック削除クエリ (`DELETE FROM rate_limit_hits WHERE key IN (...)`) の明確化。<br>3. 環境変数 `CSRF_SECRET` の HMAC 署名 Pepper 用途仕様の明確化。<br>4. Native Edit ツールによる部分置換編集の遵守。 |
| v1.6 | 2026-10-10 | 自律セキュリティレビュー v2 | 自律的セキュリティレビュー v2 反映。<br>1. Cookie Prefixes 仕様（RFC 6265bis）準拠 `__Host-` Cookie プレフィックス使用時の **Domain 属性省略 (Omit Domain)** 仕様の確定。<br>2. 本番 CAPTCHA 未設定/障害時の `500 Internal Server Error (CAPTCHA_UNCONFIGURED)` とクライアント入力を区別する HTTP ステータス契約の確定。<br>3. 環境変数表への `TOKEN_PEPPER`, `IP_HASH_PEPPER` 追加と `src/lib/env.ts` との完全同期。<br>4. Antigravity Native Edit ツールによる局所置換編集の遵守。 |
| v1.7.1 | 2026-10-11 | 追加監査（Phase 2 v1.6 再検証） | レート制限の並行競合保証と規格根拠を再検証。<br>1. §6.1 失敗試行キーの「事前読み取り判定→失敗時のみインクリメント→成功時 DELETE」フローが**未実装**であることを明記（現行は全キーを無条件インクリメント）。ハード上限保証には条件付き原子更新または予約方式の導入が必要。<br>2. 成功時 DELETE と失敗時条件付き UPDATE の競合について、順序ごとの最終状態（ケース A: 失敗カウント増加なし / ケース B: 削除）を具体化し、トランザクション内原子化＋条件付き UPDATE で「成功優先」を保証する設計を確定。現行は成功時 DELETE 未実装のため競合なしと限定。<br>3. Cookie名を仕様確定値 `__Host-auth_session` に統一（従来 `__Host-session` は誤り）。<br>4. `__Host-` プレフィックスの規格引用を RFC 6265 Section 4.1.2.5 から Cookie Prefixes 仕様（RFC 6265bis §4.1.3）に修正（RFC 9654 は OCSP Nonce 仕様であり誤り）。 |
| v1.7.2 | 2026-10-11 | 追加確認（Cookie規格・競合設計の完成） | Cookie仕様の引用を RFC 6265bis §4.1.3 に修正（RFC 9654 誤参照を是正）。成功時リセットと失敗時加算の競合設計を完成：条件付き原子 UPDATE ＋ トランザクション内 DELETE で「成功優先」を保証し、並行プロセス下でも最終状態が「行なし」になることを設計確定。 |
| v1.7.3 | 2026-10-11 | 実行枠予約方式・カウンター再生成・成功リセット意味の設計確定 | 失敗試行キーに実行枠予約方式（事前予約確保→認証実行→失敗時確定振替/成功時行削除）を導入し、並行到着時の上限厳守を設計確定。`reserved_count` 列追加案と単一カラム合算運用案を比較検討し設計書に方針記載。カウンター行の初回作成・成功後再生成・削除並行時の整合性を詳細化。成功時リセット「成功優先」の意味をケース分けで明確化。Cookie規格引用を `draft-ietf-httpbis-rfc6265bis-22`（Internet-Draft）に修正。DoD・テストシナリオ・実装手順・リスク表を同期。 |
| v1.7.4 | 2026-10-11 | 予約所有権の保証・成功時リセットの分離・世代番号導入・TTL競合解決 | 予約方式を予約ID（`reservation_id`）・専用テーブル `rate_limit_reservations`・世代番号（`generation`）方式に再設計。所有権保証：A/B/C 同時並行で各予約を自分の ID のみ確定・解放。成功時リセット：行削除せず `failed_count=0` のみ、`generation` 不変で並行予約を保持。古い予約の失敗確定は同一 `generation` なら加算、分離必要なら `generation++` 選択肢を記載。TTL：予約固有 `expires_at` とウィンドウ `window_expires_at` を分離、バッチはアクティブ予約なし行のみ削除。DoD・テスト・実装手順・リスク表を全面同期。 |
| v1.7.5 | 2026-10-11 | 予約所有権の保証・成功時リセットの分離・世代番号導入・TTL競合解決・改訂履歴同期 | v1.7.4 の内容に加え、改訂履歴の同期。 |
| v1.7.6 | 2026-10-11 | 予約取得の原子性・状態遷移の原子性・単調増加世代番号・認証実行タイムアウト・Cookie規格確定 | 予約確保を hits 行ロック＋単一トランザクション（REPEATABLE READ）で原子化し、同時到着時の上限厳守を保証。状態遷移に `status='active'` ガードを追加し、二重確定・二重 release を防止。世代番号を単調増加（再利用なし）とし、ウィンドウ期限切れ後の再生成時に古い予約が新しいカウントを破壊しないことを保証。認証実行 5 秒タイムアウト・予約 TTL 猶予 30 秒・延長なしでプロセス強制終了も安全側に倒れる設計。Cookie Prefixes 参照を `draft-ietf-httpbis-layered-cookies-02` §4.1.3.2 に確定。DoD・テスト・実装手順・リスク表を全面同期。 |