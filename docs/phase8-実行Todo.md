# Phase 8 実行 Todo — リスク検知 ＋ セキュリティテスト完成（M8）

> 計画: `docs/phase8-risk-tests-実装計画.md`（v1.0 / D-38-01〜D-38-07）
> 正本: `実装Todo.md` の P8 セクション（§10）を、実装単位まで展開した実行用チェックリスト
> 状態: **完了（2026-10-25）** — 全タスク実装・`pnpm test` 127 files / 865 tests green
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**。

---

## 0. 事前準備

- [x] `pnpm install` が通ることを確認
- [x] `pnpm lint && pnpm typecheck && pnpm test` が green であることを確認（**Phase 8 着手前のベースライン**。Phase 7.6 完了状態 = 119 files / 812 tests）
- [x] `pnpm db:verify-migrations` が green（最新は `0022`）
- [x] `pnpm seed` 済み（`roles` に 4 行）
- [x] ブランチを切る（`feat/phase8-risk-tests`）
- [x] `src/lib/auth/risk.ts` が**存在しない**こと、`sessions.ip_country` が常に `null` であることを確認（D-38-01 の前提）

---

## 1. P8-A: リスク検知（§57）

### P8-A-01 — 設定 `src/config/risk.ts`（0.6h）

- [x] `src/config/risk.ts` を作成
  - [x] `RISK_WEIGHTS`: `new_device: 20` / `new_ip: 10` / `rapid_distinct_ips: 30` / `failed_burst: 30` / `automated_client: 25`
  - [x] `RISK_THRESHOLDS`: `notify: 20` / `challenge: 50` / `hold: 80`
  - [x] `RISK_WINDOWS`: `distinctIp: 3600_000` / `failedBurst: 900_000`
  - [x] `RISK_LIMITS`: `distinctIps: 3` / `failedCount: 5`
  - [x] `RISK_ENFORCEMENT` を `env.ts` から読む型（`'notify' | 'challenge' | 'hold'`）
- [x] `src/lib/env.ts` に `RISK_ENFORCEMENT: z.enum(['notify','challenge','hold']).default('notify')` を追加
- [x] 完了条件: `pnpm typecheck` green

### P8-A-02★ — `src/lib/auth/risk.ts`（1.6h）

- [x] `src/test/security/risk.test.ts` を**先に**書く（純関数部分）
  - [x] `scoreRisk` が重みの合計を返す（複数信号・重複信号は 1 回）
  - [x] `riskLevel`: `0-19`→`low` / `20-49`→`medium` / `>=50`→`high`
  - [x] `decideRiskAction(score)` が閾値どおり `allow`/`notify`/`challenge`/`hold`
  - [x] `decideRiskAction(score, 'notify')` は高スコアでも `notify` で頭打ち
  - [x] `decideRiskAction(score, 'challenge')` は `hold` まで到達しない
  - [x] `assessLoginRisk`: 新規デバイス → `new_device` を含む
  - [x] `assessLoginRisk`: 既知デバイス・既知 IP → 信号なし・`allow`
  - [x] `assessLoginRisk`: `recentDistinctIpHashes >= 3` → `rapid_distinct_ips`
  - [x] `assessLoginRisk`: `recentFailedCount >= 5` → `failed_burst`
  - [x] `assessLoginRisk`: 空 UA → `automated_client`
  - [x] `risk.ts` が `db` / `getPool` / `request` を import しない（静的検査）
- [x] `src/lib/auth/risk.ts` を実装（`RiskSignal` / `RiskLevel` / `RiskAction` / `scoreRisk` / `riskLevel` / `decideRiskAction` / `assessLoginRisk`）
- [x] 完了条件: `risk.test.ts`（純関数）green

### P8-A-03 — 集計クエリ（0.8h）

- [x] `src/test/integration/risk-queries.test.ts` を**先に**書く（実 DB）
  - [x] `countDistinctRecentIpHashes(userId, windowMs)` が重複を除いた件数を返す
  - [x] `countRecentFailedLogins(userId, windowMs)` が `login_failed` のみ数える
  - [x] ウィンドウ外の行を数えない（fake timers で時刻を進める）
- [x] `src/lib/db/queries/security-events.ts` に上記 2 関数を追加
- [x] 完了条件: `risk-queries.test.ts` green

### P8-A-04 — イベント種と配線（1.0h）

- [x] `src/lib/db/schema.ts` の `SECURITY_EVENT_TYPES` に **`login_risk`** を追加
- [x] `src/messages/ja.ts` の `securityEvents` に `login_risk: '不審なログインを検知'` を追加
- [x] `src/test/security/security-events-coverage.test.ts` に `login_risk` の記録を追加
- [x] `src/app/api/auth/login/route.ts`（2FA 無し）: セッション発行前に `assessLoginRisk` → `login_risk` 記録 → `notify` なら既存通知
- [x] `src/app/api/auth/login/route.ts`（2FA 有り）: 保留セッション発行時に評価・記録（通知は昇格時・T14）
- [x] `src/app/api/auth/2fa/challenge/verify/route.ts`: 昇格時に既存の新規デバイス通知を送る（リスク評価は保留発行時の login で記録済み）
- [x] `src/app/api/auth/oauth/[provider]/callback/route.ts`: セッション発行時に評価
- [x] `src/app/api/auth/passkey/login/verify/route.ts`: セッション発行時に評価
- [x] 完了条件: 既存の `new-device-notification.test.ts` / `login` 系テストが**緑のまま**（既定 notify で挙動不変）

### P8-A-05★ — `risk.test.ts`（配線・回帰）（1.0h）

- [x] 既定（`RISK_ENFORCEMENT='notify'`）で高スコアでもログインが**成功**する（回帰ガード）
- [x] `login_risk` イベントの metadata に `level` / `signals` / `action` だけが入る（生 IP・UA 全文・PII が無い・§45）
- [x] `challenge` / `hold` への写像は `decideRiskAction`（純関数）で確定（enforcement を上げれば `challenge` / `hold` を返す）
- [x] 注: ルート側の **challenge / hold の実強制は本フェーズのスコープ外**（計画 §4.4 の配線表は既定 notify のみを配線する）。`RISK_ENFORCEMENT` を上げた環境向けの実強制は後続フェーズの拡張点（`login-risk.ts` が `action` を返すため、呼び出し側で分岐を足すだけで有効化できる）
- [x] 完了条件: green（DoD 直結）

---

## 2. P8-B: テスト完成（§48）

### P8-B-01★ — 正規ファイル新設（2.0h）

- [x] `src/test/security/auth.test.ts`（新設）: 正 PW / 誤 PW / 存在しない email / 未認証 email / セッション期限切れ / ログアウト後の API 拒否
- [x] `src/test/security/session.test.ts`（新設）: Cookie 属性 / fixation（ログイン前後で ID 変化）/ logout-all 後の旧 Cookie 拒否 / DB は hash 保存
- [x] `src/test/security/oauth-redirect.test.ts`（新設）: `redirect_uri` 改ざん / 未登録 / open redirect 拒否
- [x] `src/test/security/oauth-replay.test.ts`（新設）: code 再利用拒否 / 並行交換で成功 1 件
- [x] 各ファイルは既存の細分化テストと**同じ実装**を叩く（モックで緑にしない）
- [x] 完了条件: 4 ファイル green

### P8-B-02 — 通知イベントテスト（0.8h）

- [x] `src/test/unit/notify-events.test.ts`（新設）: §18 の通知 9 種が漏れなく発火する
  - [x] 新規デバイス / 新 IP・地域 / PW 変更 / email 変更 / 2FA 変更 / Passkey 追加 / Passkey 削除 / ソーシャル追加 / ソーシャル削除 / 全デバイスログアウト
  - [x] 通知本文にパスワード・token・TOTP secret が含まれない（§45）
- [x] 完了条件: green

### P8-B-03★ — E2E 通し（1.6h）

- [x] `src/test/e2e/auth-journey.test.ts`（新設・`startTestAppServer` 方式）
  - [x] 登録 → 201 / memory transport に確認メール
  - [x] 確認 → `email_verified` 真
  - [x] ログイン → `__Host-` Cookie / 誤 PW 401
  - [x] 2FA → 保留セッション → challenge/verify で昇格
  - [x] Passkey → 登録 → ログイン（`webauthn-mock`）
  - [x] 設定 → セッション一覧 / 全ログアウト
  - [x] 削除 → メール確認 → 削除 → 再ログイン 403
- [x] 完了条件: green（DoD 直結）

### P8-B-04 — トラッカー更新（0.4h）

- [x] `実装Todo.md` §12 の `[ ]` を実ファイル名で `[x]` に更新
- [x] §48 の各カテゴリ ↔ ファイルの 1:1 対応を確認
- [x] 完了条件: トラッカーに未チェックの §48 カテゴリが残っていない

---

## 3. P8-C: テスト基盤

### P8-C-01 — fixtures ヘルパ（0.8h）

- [x] `src/test/helpers/fixtures.ts`（新規）
  - [x] `createTestUser({ status, emailVerified, passwordHash, roleId })` — 通常 / 未検証 / suspended / PW 無し / admin
  - [x] `cleanupUsers(ids)` — 関連行（sessions / security_events / totp / webauthn_credentials）をまとめて削除
  - [x] 既存テストの `seedUser` と同等の SQL を 1 か所に集約
- [x] 完了条件: 新ヘルパを使う 1 ファイル（`auth.test.ts`）が green

### P8-C-02 — fake timers / rate-limit / totp ヘルパ（0.8h）

- [x] `src/test/helpers/rate-limit.ts`: レート制限キーの DB 掃除（`protectRateLimitKey` 経由）
- [x] `src/test/helpers/totp.ts`: 有効 TOTP の seed と現在コード生成（`otpauth` 利用）
- [x] 時間依存テストは `vi.useFakeTimers()` / `vi.setSystemTime()` を使う（実時間 `sleep` を禁止）
- [x] 完了条件: 上記ヘルパを使うテストが flaky でない（3 回連続 green）

### P8-C-03 — 重複 seed の置換（0.4h）

- [x] 散在する `seedUser` / `seedEnabledTotp` を可能な範囲で fixtures へ寄せる（**既存テストの意味は変えない**）
- [x] 完了条件: `pnpm test` 全体 green

---

## 4. 品質ゲート

- [x] `pnpm lint`（0 error / 0 warning）
- [x] `pnpm typecheck`
- [x] `pnpm test`（全 green）
- [x] `pnpm test:security` / `pnpm test:e2e`（green）
- [x] `pnpm build`
- [x] §20.3 DoD チェックリスト（計画書）
  - [x] 新規/変更 API が `withAuthPipeline` / レート制限 / `require*` ガードを通っているか
  - [x] secret / 生 IP がログ・応答・metadata に漏れていないか（§45）
  - [x] 認可をサーバー側で行っているか（§49）
  - [x] `security_events` へ記録しているか（該当操作）
  - [x] mutation が POST/PUT/PATCH/DELETE か（§25）
  - [x] エラーが統一形式（§58）か

---

## 5. ドキュメント更新

- [x] `実装Todo.md` の P8-01〜P8-07 を完了に更新
- [x] `README.md` の実装状況表（M8 完了）と Phase 8 実装詳細節を追記
- [x] `実装計画.md` の Phase 8「Playwright」表記を D-38-04（vitest + 実 HTTP）へ読み替え注記
- [x] `AGENTS.md` の到達点を M8 完了へ更新（次は Phase 9）
