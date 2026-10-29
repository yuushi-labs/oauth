# Phase 9 実装計画 — 運用デプロイ（M9）

> 対象: 仕様 §17.2.1（認証トークン付き URL のログ漏洩対策）・§52（DB セキュリティ）・§53（バックアップ）・§54-55（アカウント復旧）・§56（レートリミット）・§17（Bot 対策）
> 前提工程: Phase 8（M8 リスク検知＋セキュリティテスト完成）まで完了
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md`（§15 Phase 9 / §17.2.1）→ 進捗 `実装Todo.md`（§11）→ **本書（実装レベルの詳細）**
> 初版: 2026-10-29
> 状態: **実装着手**
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**。

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | M8 の残件＝運用デプロイ。①CAPTCHA（Turnstile）の**実接続**、②**バックアップ／復元の実装と復元テスト**、③**監視・アラート判定**とログの secret 検知、④**認証トークン付き URL のログ漏洩対策**（アプリ側検証＋ reverse proxy / CDN 設定の成果物化＋チェックリスト）、⑤運用**ランブック**（suspend / 復旧 / キーローテ / §54-55 手動復旧フロー）、⑥CI 強化 |
| なぜやる | M8 の完成条件は「CI green ＋ バックアップ／監視／ランブック整備」。現状 CI は既に lint/typecheck/test/gitleaks/audit を実行しているが、**バックアップ／復元は手順が無く、復元テストも未実施**。CAPTCHA は `interface` のみで実 provider が未接続（本番では安全側に倒れて全リクエストを拒否する）。§17.2.1 のログ漏洩対策はアプリ内 redaction のみで、**外側の層（reverse proxy / CDN / tracing）の成果物が無い** |
| 工数 | 約 16 時間（9-A 実装 8h / 9-B 監視・ログ 4h / 9-C ドキュメント 3h / 9-D CI 1h） |
| 追加依存 | **無し**（暗号化は Node 標準 `node:crypto`、バックアップは既存の `pg_dump` / `pg_restore`、CAPTCHA は `fetch`） |
| migration | **無し**（監視は既存 `security_events` の集計のみ。新テーブルを作らない） |
| 新規ファイル | 設定 1 / ライブラリ 4 / クエリ追記 1 / スクリプト 4 / デプロイ成果物 3 / ドキュメント 4 / テスト 6 → §7 |
| 最大リスク | **復元テストを「実施したつもり」で終わらせる**こと。バックアップは取れても復元できなければ意味が無い。本書は復元を**実 DB（一時 DB）へ流して行数を検証する**統合テストを DoD にする（D-39-02） |

---

## 1. 背景

Phase 8 完了時点（`docs/phase8-実行Todo.md`）で、M8 の残件は Phase 9（運用デプロイ）のみ。

1. **CAPTCHA 未接続**: `src/lib/auth/captcha.ts` は `NoopCaptchaProvider` のみ。本番で `TURNSTILE_SECRET_KEY` が設定されていても `CAPTCHA_PROVIDER_ERROR` を返し、**ソフトリミット超過時は常に拒否**する（安全側だが機能しない）。`実装Todo.md` の「Turnstile の実接続（接続は Phase 9）」が未消化。
2. **バックアップ／復元が無い**: `scripts/` にバックアップ系スクリプトが無い。仕様 §53 は「復元テストを定期的に行う」を要求するが、手順書もスクリプトも存在しない。
3. **監視・アラートが無い**: `/api/health`（liveness/readiness）と `security_events` の記録はあるが、**異常の集計とアラート判定**が無い。仕様 §17.2 は「認証系 5xx/遅延アラート、レート制限 429 の急増、security_events の異常集計」を要求する。
4. **ログ漏洩対策の外側が無い**: アプリ側 `logger.ts` の redaction は実装済み（`log-redaction.test.ts`）だが、**reverse proxy / CDN / error log / tracing / APM の設定成果物**が無い。§17.2.1 は実地確認を DoD にする。
5. **ランブックが無い**: suspend / 復旧 / キーローテ / §54-55（メール喪失時）の手順書が存在しない。

---

## 2. スコープ

**やること**

1. **CAPTCHA 実接続（9-A）**: `TurnstileCaptchaProvider` を実装し、本番で `TURNSTILE_SECRET_KEY` 設定時に実際に検証する。ネットワーク障害は `CAPTCHA_PROVIDER_ERROR`（503）で**安全側に倒す**。テスト用の provider 差し替え口を設ける。
2. **バックアップ／復元（9-A）**: `src/lib/ops/backup.ts`（`pg_dump` → AES-256-GCM 暗号化 → 保存 → 保持期間で pruning）と `src/lib/ops/restore.ts`（復号 → `pg_restore`）。CLI `pnpm backup` / `pnpm restore`。**復元を一時 DB へ流す統合テスト**を追加。
3. **監視・アラート（9-B）**: `src/config/ops.ts` に閾値、`src/lib/ops/alerting.ts` に純関数の判定、`security_events` の集計クエリ、`pnpm alert:check`。判定結果は `logger` へ構造化出力（secret を含めない）。
4. **ログ secret 検知（9-B）**: `src/lib/ops/log-scan.ts`（`scanForSecrets`）。`pnpm logs:scan <file|->` でログを行単位で走査し、token 付き URL・secret を検出して**行番号だけ**を報告（値は出さない）。
5. **ログ漏洩対策の成果物（9-B / 9-C）**: `deploy/nginx/oauth.conf`（access log / error log の redaction 例）、`deploy/cloudflare.md`、`deploy/log-security-checklist.md`。
6. **ランブック（9-C）**: `docs/phase9-運用ランブック.md`（suspend / 復旧 / キーローテ / インシデント / §54-55）、`docs/phase9-バックアップ復元手順.md`。
7. **CI 強化（9-D）**: `pnpm build` の smoke ジョブと、Node 22/24 の matrix（Node 24 対応の確認）。既存の gitleaks / audit は維持。
8. **アプリ側 redaction の検証（9-B）**: 認証トークン付き URL を `logger` が平文出力しないことを**テストで固定**（P9-08e）。

**やらないこと**

- 実際のクラウド（Cloudflare / Secret Manager / LB）へのデプロイ。成果物（設定・手順・チェックリスト）を整備し、**実地確認は運用者が行う**。
- SPF / DKIM / DMARC の DNS 設定そのもの（手順書に記載。`text/plain` 併記は実装済み）。
- 新テーブル / migration。
- 外部監視 SaaS（Datadog 等）の接続。`logger` の構造化出力までとし、収集は運用側に委ねる。

---

## 3. 決定事項（D-39-01 〜 D-39-08）

| # | 決定 | 理由 |
|---|---|---|
| D-39-01 | CAPTCHA は **Cloudflare Turnstile** を `fetch` で直接呼ぶ（`siteverify`）。provider は**差し替え可能**にし、テストはネットワークを叩かない | `interface` は既存を再利用する。Turnstile は secret を query ではなく **POST body** で送るため、URL ログに secret が残らない。差し替え口は既存の `email/send.ts` の `setEmailTransport` と同じ流儀 |
| D-39-02 | バックアップは **`pg_dump --format=custom` → AES-256-GCM 暗号化**。復元は**一時 DB を作って流し、行数で検証**する統合テストを必須にする | 仕様 §53「バックアップ自体も機密」「復元テストを定期的に」。平文 dump を残さないため暗号化を既定にする。復元の実証が無いバックアップは DoD を満たさない |
| D-39-03 | 暗号鍵は `BACKUP_ENCRYPTION_KEY`（Base64 32 バイト）で注入し、**鍵はファイルに残さない**。鍵未設定なら `pnpm backup` は**失敗**する（平文で書かない） | §52「Secret は Secret Manager 等で管理」。平文フォールバックを作ると運用で事故る |
| D-39-04 | 監視の閾値は `src/config/ops.ts` に集約し、`alerting.ts` は**純関数**（集計値 → 判定）にする | 閾値の散在は判定の再現性を壊す（Phase 8 の D-38-02 と同じ理由）。純関数にすれば実 DB 無しで境界を固定できる |
| D-39-05 | アラートは**アプリから外部へ送らない**。`pnpm alert:check` が判定結果を構造化ログ（1 行 JSON）で出し、収集側が拾う | 外部 SaaS 依存を持ち込まない方針（D-38-01 と同じ）。`logger` 経由なので secret redaction が自動で効く |
| D-39-06 | ログの secret 検知は **`logger.ts` の既存パターンを再利用**し、検出時は**行番号のみ**を報告する（値は出さない）。既定の検出対象は URL に載る認証トークン（`token`/`code`/`state`/`nonce`/`code_verifier`）に絞り、`password`/`secret` 等の誤検知しやすいキーは `--credentials` 指定時のみ対象にする | 検知器自体が漏洩源にならないようにする（§45）。パターンの二重管理を避ける。日次実行の走査がノイズで無視されないようにする（Kilo レビュー反映） |
| D-39-07 | §17.2.1 の対策は**成果物（nginx / Cloudflare / チェックリスト）＋アプリ側テスト**までを本フェーズで実装し、**実地確認は運用 DoD へ明示的に残す** | 実 reverse proxy / CDN のログ設定は本リポジトリの外。設定例と検証手順を固定し、DoD を「テストリクエストのログ実物で確認」と明記する |
| D-39-08 | CI は **`build` の smoke ジョブ**と **Node 22/24 matrix** を追加する。gitleaks / audit は現状維持 | Node 24 は実行環境（v24.21.0）。`next build` は型・CSP・env の検証を兼ねる smoke test になる。matrix は将来のランタイム更新を安全にする |

---

## 4. CAPTCHA 実接続（9-A-1）

### 4.1 設計

```
verifyCaptchaIfRequired(required, token, remoteIp)
  ├─ !required → 何もしない
  ├─ provider 差し替えがあれば使う（テスト）
  ├─ NODE_ENV=production:
  │    ├─ TURNSTILE_SECRET_KEY 未設定 → CAPTCHA_UNCONFIGURED（500・fail closed）
  │    └─ TurnstileCaptchaProvider で siteverify
  │         ├─ success:true → 通過
  │         ├─ success:false → CAPTCHA_INVALID（400）
  │         └─ 通信失敗 / 非 2xx / JSON 不正 → CAPTCHA_PROVIDER_ERROR（503）
  └─ 非 production → NoopCaptchaProvider（常に通過）
```

### 4.2 API

```ts
export interface CaptchaProvider { verify(token: string | null, remoteIp?: string): Promise<boolean>; }
export class TurnstileCaptchaProvider implements CaptchaProvider { constructor(secret: string) {} }
export function setCaptchaProvider(next: CaptchaProvider | null): void;   // テスト用
```

- Turnstile の応答 `{"success": true|false, "error-codes": [...]}` を検証する。**`error-codes` はログに残さない**（設定ミスの情報を外へ出さない。§45）。
- タイムアウトは `AbortController`（`CAPTCHA_TIMEOUT_MS`、既定 3000ms）。HIBP と同じ流儀。

---

## 5. バックアップ／復元（9-A-2）

### 5.1 設計

```
pnpm backup [--out <dir>] [--keep <days>]
  1. pg_dump --format=custom --no-owner --no-privileges $DATABASE_URL > <tmp>
  2. AES-256-GCM（BACKUP_ENCRYPTION_KEY）で暗号化 → <dir>/backup-<ts>.dump.enc
  3. <tmp> を必ず削除（finally）
  4. <keep> 日より古い backup-*.dump.enc を削除（pruning）

pnpm restore --file <dir>/backup-<ts>.dump.enc [--database <name>]
  1. 復号 → <tmp>.dump
  2. pg_restore --clean --if-exists --no-owner --no-privileges -d <DATABASE_URL or --database>
  3. <tmp>.dump を必ず削除（finally）
```

### 5.2 ライブラリ API（テスト可能に）

```ts
// src/lib/ops/backup.ts
export function encryptBackup(plain: Buffer, keyBase64: string): Buffer;      // iv|tag|ciphertext
export function decryptBackup(encrypted: Buffer, keyBase64: string): Buffer;  // 改竄・鍵不一致で throw
export function backupFileName(date: Date): string;                           // backup-<ISO>.dump.enc
export function selectExpiredBackups(names: string[], now: Date, keepDays: number): string[];
export async function createBackup(opts: { outDir; key; databaseUrl; run? }): Promise<string>;
export async function pruneBackups(opts: { outDir; keepDays; now? }): Promise<string[]>;

// src/lib/ops/restore.ts
export async function restoreBackup(opts: { file; key; databaseUrl; run? }): Promise<void>;
```

- `run`（コマンド実行）を注入可能にし、**純関数部分はユニットテスト**、**実 `pg_dump`/`pg_restore` は統合テスト**でカバーする。
- 暗号化は `iv(12) || authTag(16) || ciphertext` の連結。AAD に `oauth-backup-v1` を付けて用途を固定する。
- ファイル権限は `0o600`。

### 5.3 復元テスト（DoD 直結）

統合テストで次を固定する。

1. 一時 DB を `createdb` で作成 → `pnpm db:migrate` 相当を流す（または既存テスト DB から `pg_dump` して復元）。
2. 検証用に 1 行（`roles` など）を入れる。
3. `createBackup` で暗号化バックアップを作る。
4. **別の一時 DB へ `restoreBackup`** し、その 1 行が存在することを確認。
5. 一時 DB を `dropdb` で削除。

> 実 DB を破壊しないため、復元先は必ず**一時 DB**にする（本番 DB へ誤って流さない）。

---

## 6. 監視・アラート（9-B）

### 6.1 閾値（`src/config/ops.ts`）

| キー | 既定 | 意味 |
|---|---|---|
| `ALERT_LOGIN_FAILED_BURST` | `30` / 300s | ログイン失敗の急増 |
| `ALERT_RATE_LIMITED_SPIKE` | `50` / 300s | 429（`rate_limited`）の急増 |
| `ALERT_OIDC_TOKEN_FAILED` | `20` / 300s | OIDC token 失敗の急増 |
| `ALERT_SERVER_ERROR` | `10` / 300s | 5xx（`*_failed` 系）の急増 |
| `BACKUP_RETENTION_DAYS` | `30` | バックアップ保持日数 |
| `CAPTCHA_TIMEOUT_MS` | `3000` | Turnstile のタイムアウト |

### 6.2 判定（純関数）

```ts
export type AlertMetrics = {
  loginFailed: number; rateLimited: number; oidcTokenFailed: number; serverErrors: number;
};
export type AlertDecision = { key: string; severity: 'warning' | 'critical'; observed: number; threshold: number };
export function evaluateAlerts(metrics: AlertMetrics, thresholds = OPS_THRESHOLDS): AlertDecision[];
```

- 判定は「閾値超過で `critical`、80% 超で `warning`」の 2 段。0 件は出さない。
- 出力は `logger.warn` / `logger.error` に `{ key, severity, observed, threshold }` のみ（PII・IP を入れない）。

### 6.3 集計クエリ（`security-events.ts` に追記）

```ts
export async function countRecentEventsByType(type: SecurityEventType, windowMs: number): Promise<number>;
export async function countRecentFailedEventTypes(windowMs: number): Promise<number>;  // *_failed 系
```

---

## 7. 実装ファイル一覧

| 種別 | パス |
|---|---|
| 設定 | `src/config/ops.ts` |
| ライブラリ | `src/lib/ops/backup.ts` / `restore.ts` / `alerting.ts` / `log-scan.ts` |
| クエリ追記 | `src/lib/db/queries/security-events.ts` |
| 既存変更 | `src/lib/auth/captcha.ts`（Turnstile） / `src/lib/env.ts`（`BACKUP_ENCRYPTION_KEY` / `CAPTCHA_TIMEOUT_MS`） / `.env.example` |
| スクリプト | `scripts/backup.ts` / `restore.ts` / `alert-check.ts` / `log-scan.ts` |
| デプロイ成果物 | `deploy/nginx/oauth.conf` / `deploy/cloudflare.md` / `deploy/log-security-checklist.md` |
| ドキュメント | `docs/phase9-運用ランブック.md` / `docs/phase9-バックアップ復元手順.md` / `docs/phase9-実装計画.md`（本書） / `docs/phase9-実行Todo.md` |
| CI | `.github/workflows/ci.yml`（build smoke ＋ Node matrix） |
| テスト | `src/test/unit/ops-backup.test.ts` / `ops-alerting.test.ts` / `ops-log-scan.test.ts` / `src/test/integration/ops-backup-restore.test.ts` / `alert-queries.test.ts` / `src/test/security/log-url-redaction.test.ts` / `captcha.test.ts`（更新） |

---

## 8. DoD（Phase 9）

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test`（unit+integration+security）/ `pnpm build` が green
- [ ] `pnpm backup` → `pnpm restore`（一時 DB）の**復元テストを 1 回実施済み**（統合テストで自動化）
- [ ] `pnpm alert:check` が閾値超過時に構造化ログを出し、未超過時に何も出さない
- [ ] `pnpm logs:scan` が token 付き URL を含むログを検出し、**値ではなく行番号**を報告する
- [ ] CAPTCHA: 本番で secret 未設定 → 500（fail closed）、通信失敗 → 503、成功 → 通過
- [ ] 認証トークン付き URL を `logger` が平文出力しない（テストで固定・P9-08e）
- [ ] `deploy/` の設定例と `deploy/log-security-checklist.md` が §17.2.1 の全対象（access / error / tracing / APM / CDN）を網羅
- [ ] ランブックに suspend / 復旧 / キーローテ / §54-55 手動復旧フローが記載されている
- [ ] CI green（build smoke ＋ Node 22/24 matrix ＋ 既存の lint/typecheck/test/gitleaks/audit）
- [ ] **ログ設定セキュリティチェック（運用 DoD）**: 本番デプロイ前に、access / error / tracing / APM / CDN の各設定が「認証トークンを含む query を平文保存しない」ことを**テストリクエストのログ実物**で確認し、デプロイ記録へ残す（D-39-07）

---

## 9. 参考

| ドキュメント | 内容 |
|---|---|
| `実装計画.md` §15 Phase 9 / §17.2.1 | 運用デプロイ・ログ漏洩対策の要求 |
| `実装Todo.md` §11 | P9-01〜P9-08 のトラッカー |
| `超本格アカウント・認証システム仕様書 v1.3.md` §52-55 / §17.2.1 | 正本 |
| `docs/phase8-risk-tests-実装計画.md` | 直近フェーズの計画スタイル |
| `docs/phase2.5-threat-model.md` | 脅威モデル（ログ漏洩の位置づけ） |
