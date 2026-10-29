# Phase 9 運用ランブック

> 対象: 本番運用の手順（§17.2.1 / §52-57 / Phase 9）
> 正本: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 本書
> 初版: 2026-10-29

本書は「運用者が本番で何をするか」を手順として固定する。判断に迷う操作（アカウント復旧・
キーローテ・インシデント対応）はここに従う。実装の詳細は
`docs/phase9-運用デプロイ-実装計画.md` を参照。

> **サーバーへの初期デプロイ**（OS 設定 / Node / PostgreSQL / env / migration / systemd / Nginx + TLS）は
> **[`docs/phase9-デプロイ手順.md`](phase9-デプロイ手順.md)** にまとめている。

---

## 0. 前提

- 環境変数は Secret Manager（または sealed secret）から注入する。`.env` を本番に置かない。
- DB は公開ポートを開けない（`compose.yaml` は localhost のみ。本番は別ネットワーク）。
- 監視は `pnpm alert:check` の構造化ログを収集する（外部 SaaS へは送らない・D-39-05）。
- バックアップは `pnpm backup`（暗号化・保持 30 日）。手順は `docs/phase9-バックアップ復元手順.md`。

---

## 1. 定期ジョブ（cron 例）

```cron
# 期限切れデータの削除（§52）
0 3 * * *  cd /srv/oauth && pnpm purge >> /var/log/oauth/purge.log 2>&1

# バックアップ（§53）
15 3 * * * cd /srv/oauth && pnpm backup >> /var/log/oauth/backup.log 2>&1

# アラート判定（5 分ごと）
*/5 * * * * cd /srv/oauth && pnpm alert:check >> /var/log/oauth/alert.log 2>&1

# ログの secret 検知（1 日 1 回）
0 4 * * *  cd /srv/oauth && pnpm logs:scan /var/log/oauth/app.log >> /var/log/oauth/logscan.log 2>&1
```

---

## 2. アカウントの停止 / 解除（§51）

### 停止（suspend）

1. 対象ユーザーを特定する（メールまたはユーザー名）。
2. 管理画面 `/admin/users` から「停止」を実行する、または管理 API を使う。
   - 停止は `users.suspended_at` を立て、全セッションを失効させる。
   - `security_events` に `account_suspended` が記録される。
3. 停止理由・実行者・時刻を運用記録へ残す（`admin_audit_logs` を確認）。

### 解除（unsuspend）

1. 本人確認を**§54-55 の手順**で行う（後述）。
2. `/admin/users` から「解除」を実行する。`security_events` に `account_unsuspended` が記録される。

---

## 3. アカウント復旧フロー（§54-55）

> **禁止事項**: 弱い本人確認（メールの到達のみ、公開情報での照合、口頭確認のみ）で
> 復旧してはならない。復旧は「メール喪失時」を含め、以下の統制を満たす場合のみ行う。

### 3.1 通常の復旧（メールが使える）

1. 本人が `/forgot-password` から再設定する（メール到達で完結）。
2. 2FA を有効にしている場合は TOTP か Recovery Code を要求する。

### 3.2 メール喪失時の復旧（§55）

メールアドレス自体を失った場合は、**本人確認の強度を上げた手動フロー**のみ許可する。

1. **申請**: 本人がサポートへ申請する。申請内容に、登録済みの補助情報（最終ログイン日時・
   利用したデバイス・登録日）を求める。
2. **確認**: 運用者は次を**複数**組み合わせて確認する。
   - 登録済みの Passkey / 2FA デバイスが手元にあるか（**これがあれば最優先**）。
   - 過去のログイン履歴（`security_events` の `login_success` / `new_device_login`）と
     申請者が提示する情報の一致。
   - 支払い・契約がある場合は、契約者情報との一致（該当サービスのみ）。
3. **メール変更**: 確認が取れたら、管理者が `/admin/users` から連絡先メールを変更し、
   本人へ再設定リンクを発行する。**パスワード・TOTP secret を運用者が閲覧・設定しない**
   （§51）。
4. **記録**: 申請・確認・実施の全ステップを運用記録へ残す（誰が・いつ・何を根拠に）。

> 弱い確認しかできない場合は**復旧しない**。その場合は新規登録を案内し、旧アカウントは
> 停止（suspend）したままにする。

---

## 4. キーローテーション

| 鍵 | 用途 | ローテ手順 |
|---|---|---|
| `SESSION_PEPPER` | セッショントークンのハッシュ | 新値を注入 → 再起動 → 既存セッションは無効化される（全ユーザー再ログイン）。計画的に実施 |
| `TOKEN_PEPPER` | 各種トークンのハッシュ | 同上。未使用トークンは失効するため、通知のうえ実施 |
| `CSRF_SECRET` | CSRF トークン署名 | 新値を注入 → 再起動。進行中のフォームは再取得が必要 |
| `TOTP_ENCRYPTION_KEY` | TOTP secret の暗号化 | **キー変更には再暗号化が必要**。`scripts/` の移行手順に従い、旧鍵で復号 → 新鍵で暗号化して保存 → 切替 |
| `OIDC_JWKS_JSON` | OIDC 署名鍵 | `pnpm oidc:keygen` で新鍵を生成し、**旧鍵を併記**して配布（JWKS は複数鍵を持つ）。検証側が新鍵を取り込んだ後に旧鍵を外す |
| `OIDC_ADAPTER_ENCRYPTION_KEY` | OIDC アダプタの DB 暗号化 | 再暗号化が必要。OIDC セッションを一時停止して実施 |
| `BACKUP_ENCRYPTION_KEY` | バックアップの暗号化 | 新鍵で新規バックアップを取得。**旧鍵は旧バックアップが不要になるまで保管**（復元に必要） |

> 鍵の値は Secret Manager で更新し、アプリは再起動で読み直す。値そのものをログ・
> チケット・チャットへ貼らない。

---

## 5. インシデント対応

### 5.1 ログから認証トークンを検出した場合（§17.2.1）

1. `pnpm logs:scan <logfile>` の結果（行番号）から該当ログを特定する。
2. 対象 token の種別を判断する。
   - メール確認 / パスワード再設定 token → 該当ユーザーの token を**無効化**（再発行）。
   - OAuth `code` / `state` → 短命のため原則失効済み。念のため該当セッションを失効。
3. ログから当該値を**削除**する（該当行を除去したログへ差し替え、外部転送先も同様）。
4. 影響ユーザーへ通知する（`security_notification_failed` 等の通知経路を使う）。
5. 再発防止として `deploy/nginx/oauth.conf` / `deploy/cloudflare.md` を修正し、
   `deploy/log-security-checklist.md` を再確認する。

### 5.2 不審ログインの急増（§57）

1. `pnpm alert:check` の `loginFailed` / `rateLimited` を確認する。
2. 特定 IP の集中なら、エッジ（WAF / Cloudflare）でブロックする。
3. `RISK_ENFORCEMENT` を一時的に `challenge` へ引き上げ、追加確認を強制する。

### 5.3 認証系 5xx / 遅延の急増

1. `pnpm alert:check` の `serverErrors` を確認する。
2. `/api/health` の readiness を確認する（DB 接続）。503 なら DB 障害を疑う。
3. 直近のデプロイ・migration を確認し、必要ならロールバックする。

---

## 6. メール到達性（SPF / DKIM / DMARC）

1. 送信ドメインの DNS に以下を設定する。
   - **SPF**: 送信サービスの IP / include を許可し、`-all`（または `~all`）で締める。
   - **DKIM**: 送信サービスの公開鍵を TXT で登録する。
   - **DMARC**: `_dmarc` に `v=DMARC1; p=quarantine; rua=mailto:...` を設定する。
2. 確認: 送信先の受信ヘッダーで `spf=pass` / `dkim=pass` / `dmarc=pass` を確認する。
3. 本文は HTML と `text/plain` を併記する（実装済み・`src/lib/auth/email/templates.ts`）。

---

## 7. 障害時の連絡

- 復旧手順・エスカレーション先は運用体制に合わせて追記する。
- セキュリティインシデントは §5 の記録を残し、必要に応じて影響ユーザーへ通知する。
