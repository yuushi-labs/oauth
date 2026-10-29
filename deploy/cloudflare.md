# Cloudflare 設定 — 認証トークン付き URL のログ漏洩対策（§17.2.1 / Phase 9 / D-39-07）

Cloudflare を前段に置く場合、**query string をログ・分析へ残さない**設定が必要。
アプリ側（`src/lib/util/logger.ts`）の redaction と二重で守る。実地確認は
`deploy/log-security-checklist.md` を使う。

## 1. ログ / 分析で query string を保存しない

- **Logpush**: HTTP Requests データセットの `ClientRequestURI` を送らない、または
  `ClientRequestPath` のみを使う（query を含まない）。
- **Analytics / Web Analytics**: 「URL のクエリ文字列を含める」をオフにする。
- **Cache Rules / Trace**: 認証パスは cache 対象外（`Cache-Control: no-store` を尊重）。

## 2. Transform Rules（Rewrite URL）で query を除去してよい範囲

| パス | 方針 |
|---|---|
| `/verify-email`, `/reset-password`, `/email-change/confirm` | query を**アプリへは渡す**（token の検証に必要）。ログ側だけで落とす |
| `/api/auth/oauth/*` | provider からの `code` / `state` を**アプリへ渡す**。ログ側だけで落とす |
| 静的資産 (`/_next/static`, `/_next/image`) | query を除去してキャッシュ効率を上げてよい |

> ⚠️ アプリへ渡す query をエッジで落とすと認証が壊れる。**落とすのはログ／分析のみ**。

## 3. Managed Transform

- 「Add visitor location headers」は IP をヘッダーに載せるため、アプリ側で
  `TRUSTED_PROXY_HEADER` を設定する場合のみ有効化する（§45: 生 IP をログへ保存しない）。
- 「Remove visitor IP headers」を有効にし、アプリが必要とする場合だけ `cf-connecting-ip` を使う。

## 4. WAF / Bot 対策

- Managed Rules の OWASP コアルールを有効化。
- Turnstile はアプリ側（`src/lib/auth/captcha.ts`）で siteverify する。Cloudflare の
  Bot Fight Mode と併用してよい。

## 5. 確認手順（実地）

1. `curl 'https://auth.example.com/verify-email?token=KNOWN-VALUE'` を実行。
2. Logpush / Analytics のダッシュボードで `KNOWN-VALUE` を検索し、**ヒットしない**ことを確認。
3. アプリの access log（`deploy/nginx/oauth.conf`）にも `KNOWN-VALUE` が無いことを確認。
4. `pnpm logs:scan <logfile>` で値ではなく行番号だけが報告されることを確認。
5. 結果を `deploy/log-security-checklist.md` の記録欄へ残す。
