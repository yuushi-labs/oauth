# Phase 9 実行 Todo — 運用デプロイ（M9）

> 計画: `docs/phase9-運用デプロイ-実装計画.md`（D-39-01〜D-39-08）
> 正本: `実装Todo.md` の P9 セクション（§11）を、実装単位まで展開した実行用チェックリスト
> 状態: **完了（2026-10-29）**。品質ゲート・ドキュメント更新まで消化済み
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**。

---

## 0. 事前準備

- [x] `pnpm install` が通ることを確認
- [x] `pnpm lint && pnpm typecheck && pnpm test` が green（**Phase 9 着手前のベースライン**。Phase 8 完了状態 = 127 files / 865 tests）
- [x] `pnpm db:verify-migrations` が green（最新は `0022`）
- [x] `pnpm seed` 済み（`roles` に 4 行）
- [x] ブランチを切る（`feat/phase9-operations`）
- [x] `pg_dump` / `pg_restore` / `createdb` / `dropdb` が PATH にあることを確認（復元テストの前提）
- [x] `src/lib/ops/` が**存在しない**ことを確認（新規作成）

---

## 1. P9-A: 実装

### P9-A-01★ — CAPTCHA（Turnstile）実接続（1.2h）

- [x] `src/test/security/captcha.test.ts` を**先に**更新
  - [x] 差し替え provider（成功 / 失敗）で `verifyCaptchaIfRequired` が通過 / `CAPTCHA_INVALID`
  - [x] 本番 + secret 未設定 → `CAPTCHA_UNCONFIGURED`（500）
  - [x] 本番 + provider が throw → `CAPTCHA_PROVIDER_ERROR`（503）
  - [x] 非本番は no-op で通過（既存挙動の回帰）
- [x] `src/lib/auth/captcha.ts`
  - [x] `TurnstileCaptchaProvider`（`siteverify` へ POST・`AbortController` タイムアウト）
  - [x] `setCaptchaProvider` 差し替え口
  - [x] `error-codes` をログ・例外メッセージへ出さない（§45）
- [x] `src/lib/env.ts` に `CAPTCHA_TIMEOUT_MS`（既定 3000）を追加
- [x] 完了条件: `captcha.test.ts` green

### P9-A-02★ — バックアップ暗号化（1.6h）

- [x] `src/test/unit/ops-backup.test.ts` を**先に**書く（純関数）
  - [x] `encryptBackup` → `decryptBackup` で往復一致
  - [x] 鍵不一致で throw
  - [x] 1 バイト改竄で throw（GCM 認証）
  - [x] `backupFileName` が `backup-<ISO>.dump.enc` 形式
  - [x] `selectExpiredBackups` が保持期間内を残し、期間外だけ返す（境界: ちょうど keepDays）
  - [x] `BACKUP_ENCRYPTION_KEY` 未設定で `createBackup` が throw（平文フォールバック禁止）
- [x] `src/lib/ops/backup.ts` を実装（暗号化 / 命名 / pruning / `createBackup`）
- [x] `src/lib/env.ts` に `BACKUP_ENCRYPTION_KEY`（任意・Base64 32 バイト検証）を追加
- [x] `src/config/ops.ts` に `BACKUP_RETENTION_DAYS`（既定 30）
- [x] 完了条件: `ops-backup.test.ts` green

### P9-A-03★ — 復元（1.2h）

- [x] `src/lib/ops/restore.ts` を実装（`decryptBackup` → `pg_restore`、一時ファイルを finally で削除）
- [x] `scripts/backup.ts` / `scripts/restore.ts`（`isMain` ガード付き・`dotenv/config` 読み込み）
- [x] `package.json` に `backup` / `restore` を追加
- [x] 完了条件: `pnpm typecheck` green

### P9-A-04★ — 復元テスト（実 DB・2.0h）

- [x] `src/test/integration/ops-backup-restore.test.ts` を**先に**書く
  - [x] 一時 DB を作成 → 検証用の行を入れる
  - [x] `createBackup` で暗号化バックアップを作る
  - [x] **別の一時 DB** へ `restoreBackup` し、検証行が存在する
  - [x] バックアップが暗号化されている（平文 dump が残っていない）
  - [x] finally で一時 DB・一時ファイルを必ず削除
- [x] 完了条件: `ops-backup-restore.test.ts` green（**DoD 直結**）

### P9-A-05★ — 監視・アラート（1.4h）

- [x] `src/config/ops.ts`（閾値集約）
- [x] `src/test/unit/ops-alerting.test.ts` を**先に**書く
  - [x] 閾値超過で `critical`、80% 超で `warning`、未満は出さない
  - [x] 複数キーが同時に超過したら複数返す
  - [x] 0 件は返さない
- [x] `src/lib/ops/alerting.ts`（`evaluateAlerts` 純関数）
- [x] `src/lib/db/queries/security-events.ts` に `countRecentEventsByType` / `countRecentFailedEventTypes` を追記
- [x] `src/test/integration/alert-queries.test.ts`（実 DB・ウィンドウ境界）
- [x] `scripts/alert-check.ts` + `package.json` の `alert:check`
- [x] 完了条件: ユニット + 統合 green

### P9-A-06 — ログ secret 検知（1.0h）

- [x] `src/test/unit/ops-log-scan.test.ts` を**先に**書く
  - [x] `token=` / `code=` / `state=` / `nonce=` / `code_verifier=` を含む行を検出
  - [x] 検出結果に**値が含まれない**（行番号のみ）
  - [x] secret を含まない行は検出しない
- [x] `src/lib/ops/log-scan.ts`（`scanForSecrets`。`logger.ts` のパターンを再利用）
  - [x] 既定は URL トークンのみ。`password`/`secret` 等は `--credentials` 指定時のみ検出（Kilo レビュー反映・D-39-06）
- [x] `scripts/log-scan.ts` + `package.json` の `logs:scan`
- [x] 完了条件: green

### P9-A-07 — アプリ側 URL redaction の検証（0.6h）

- [x] `src/test/security/log-url-redaction.test.ts`（新設）
  - [x] `/verify-email?token=...` を含むログが平文 token を出さない
  - [x] `/reset-password?token=...` 同上
  - [x] `/api/auth/oauth/google/callback?code=...&state=...` 同上
  - [x] `logger` の全レベル（debug/info/warn/error）で効く
- [x] 完了条件: green（P9-08e）

---

## 2. P9-B: デプロイ成果物・ドキュメント

### P9-B-01 — reverse proxy / CDN の設定成果物（1.2h）

- [x] `deploy/nginx/oauth.conf`
  - [x] `map` で `/verify-email`・`/reset-password`・`/api/auth/oauth/` の query を除去（または機密パラメータを `***`）
  - [x] `log_format` を認証 URL 用に分離（パス・ステータス・レイテンシ・IP hash のみ）
  - [x] error log にも同じ redaction（`$request` / `$request_uri`）
- [x] `deploy/cloudflare.md`（query string を保存しない設定・Transform Rules の例）
- [x] `deploy/log-security-checklist.md`（access / error / tracing / APM / RUM / CDN を網羅。確認方法と「ログ実物」の記録欄）
- [x] 完了条件: 3 ファイルが §17.2.1 の全対象を網羅

### P9-B-02 — ランブック（1.4h）

- [x] `docs/phase9-運用ランブック.md`
  - [x] アカウント suspend / unsuspend の手順
  - [x] 復旧フロー（§54-55: メール喪失時。**弱い本人確認を禁止**する旨を明記）
  - [x] キーローテ（`SESSION_PEPPER` / `TOTP_ENCRYPTION_KEY` / `OIDC_JWKS_JSON` / `OIDC_ADAPTER_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY`）
  - [x] インシデント対応（ログから token を検出した場合: 無効化・ユーザー通知・ログ削除＝P9-08f）
  - [x] `purge-expired` の定期実行（cron 例）
- [x] `docs/phase9-バックアップ復元手順.md`（`pnpm backup` / `pnpm restore`、鍵管理、復元テストの実施記録欄）
- [x] 完了条件: ランブックが運用 DoD を満たす

### P9-B-03 — SPF/DKIM/DMARC 手順（0.4h）

- [x] ランブックに SPF / DKIM / DMARC の設定手順と確認方法を追記
- [x] `text/plain` 併記が実装済みであることを確認（`email/templates.ts`）
- [x] 完了条件: 記載済み

---

## 3. P9-C: CI 強化

### P9-C-01 — build smoke（0.4h）

- [x] `.github/workflows/ci.yml` に `build` ジョブを追加（`pnpm build`）
- [x] 完了条件: ローカルで `pnpm build` green

### P9-C-02 — Node matrix（0.4h）

- [x] `verify` ジョブを Node 22 / 24 の matrix にする（Node 24 で green を確認）
- [x] 完了条件: ローカルは Node 24 で green。matrix 定義が妥当

---

## 4. 品質ゲート

- [x] `pnpm lint`（0 error / 0 warning）
- [x] `pnpm typecheck`
- [x] `pnpm test`（全 green）
- [x] `pnpm test:security` / `pnpm test:e2e`
- [x] `pnpm build`
- [x] `pnpm backup` → `pnpm restore`（一時 DB）を手動でも 1 回実施
- [x] `pnpm alert:check` / `pnpm logs:scan` の動作確認
- [x] §20.3 DoD チェックリスト（計画書）
  - [x] secret / 生 IP がログ・応答・metadata に漏れていないか（§45）
  - [x] 新規スクリプトが secret を標準出力・ログへ出さないか
  - [x] エラーが統一形式（§58）か

---

## 5. ドキュメント更新

- [x] `実装Todo.md` の P9-01〜P9-08 を完了に更新
- [x] `README.md` の実装状況表（M9 完了）と Phase 9 節を追記
- [x] `AGENTS.md` の到達点を M9 完了へ更新
- [x] `.env.example` に `BACKUP_ENCRYPTION_KEY` / `CAPTCHA_TIMEOUT_MS` を追記

---

## 6. 運用者へ残す項目（デプロイ時に実施）

以下は本リポジトリの外（実インフラ）でしか確認できないため、**成果物のみ整備**し実地確認は運用 DoD とする。

- [ ] ログ設定セキュリティチェック（access / error / tracing / APM / CDN が認証トークン付き query を平文保存しないこと）を**テストリクエストのログ実物**で確認し、`deploy/log-security-checklist.md` の記録欄へ残す
- [ ] 本番環境で `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` を実際のプロキシ構成に合わせて設定
- [ ] Secret Manager へ `BACKUP_ENCRYPTION_KEY` 等を注入
- [ ] cron（`purge` / `backup` / `alert:check` / `logs:scan`）を本番スケジューラへ登録（例はランブック §1）
- [ ] バックアップ復元テストを四半期ごとに実施し `docs/phase9-バックアップ復元手順.md` の記録欄へ残す
