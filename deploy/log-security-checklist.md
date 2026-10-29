# ログ設定セキュリティチェックリスト（§17.2.1 / Phase 9）

> 目的: 認証トークン付き URL（`/verify-email?token=` / `/reset-password?token=` /
> `/api/auth/oauth/*?code=&state=`）が、**どの層のログにも平文で残らない**ことを
> デプロイ前に実物で確認する（D-39-07）。
>
> アプリ側の redaction は `src/lib/util/logger.ts` ＋
> `src/test/security/log-url-redaction.test.ts` で固定済み。ここでは**外側の層**を確認する。

## 対象と確認方法

| # | 層 | 確認すること | 確認方法 |
|---|---|---|---|
| 1 | reverse proxy（Nginx 等） | access log に query string が無い | `deploy/nginx/oauth.conf` の `log_format` を使い、`tail -f` で実リクエストを確認 |
| 2 | reverse proxy error log | スタックトレース・`$request` に token が無い | 500 を意図的に起こし、error log を確認 |
| 3 | CDN（Cloudflare 等） | Logpush / Analytics が query を保存しない | `deploy/cloudflare.md` の手順で `KNOWN-VALUE` を検索 |
| 4 | tracing / APM（OpenTelemetry 等） | span の `http.url` / `url.query` 属性を送らない | span 属性をダンプし `KNOWN-VALUE` を検索 |
| 5 | error tracking（Sentry 等） | `request.url` / breadcrumbs を scrub 済み | イベント詳細で `KNOWN-VALUE` を検索 |
| 6 | アプリのログ | `logger` が値を伏せる | `pnpm logs:scan <logfile>` が行番号のみ報告する |

## 実施記録（デプロイごとに追記）

| 日付 | 環境 | 確認者 | 1 | 2 | 3 | 4 | 5 | 6 | 備考 |
|---|---|---|---|---|---|---|---|---|---|
| （例）2026-10-29 | staging | 運用 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `KNOWN-VALUE` はどこにもヒットせず |

## 検証用リクエスト

```bash
# 認証トークン付き URL を既知の値で叩き、各層のログに値が出ないことを確認する。
KNOWN_VALUE="CHECK-$(date +%s)"
curl -s "https://auth.example.com/verify-email?token=${KNOWN_VALUE}" -o /dev/null
curl -s "https://auth.example.com/reset-password?token=${KNOWN_VALUE}" -o /dev/null
curl -s "https://auth.example.com/api/auth/oauth/google/callback?code=${KNOWN_VALUE}&state=${KNOWN_VALUE}" -o /dev/null

# アプリ側のログを行番号だけで走査する（値は出力されない）。
pnpm logs:scan /var/log/oauth/app.log
```

## 不合格時の対応

1. 該当層のログ設定を `deploy/nginx/oauth.conf` / `deploy/cloudflare.md` に合わせて修正。
2. すでに token が保存されていた場合、**当該 token を無効化**し、ログを削除する
   （`docs/phase9-運用ランブック.md` の「ログから token を検出した場合」を参照）。
3. 再確認し、記録欄を更新する。
