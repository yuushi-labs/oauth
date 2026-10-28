# Phase 8 実行 Todo — リスク検知 ＋ セキュリティテスト完成（M8）

> 計画: `docs/phase8-risk-tests-実装計画.md`（v1.0 / D-38-01〜D-38-07）
> 正本: `実装Todo.md` の P8 セクション（§10）を、実装単位まで展開した実行用チェックリスト
> 状態: **実装着手前**
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**。

---

## 0. 事前準備

- [ ] `pnpm install` が通ることを確認
- [ ] `pnpm lint && pnpm typecheck && pnpm test` が green であることを確認（**Phase 8 着手前のベースライン**。Phase 7.6 完了状態 = 119 files / 812 tests）
- [ ] `pnpm db:verify-migrations` が green（最新は `0022`）
- [ ] `pnpm seed` 済み（`roles` に 4 行）
- [ ] ブランチを切る（`feat/phase8-risk-tests`）
- [ ] `src/lib/auth/risk.ts` が**存在しない**こと、`sessions.ip_country` が常に `null` であることを確認（D-38-01 の前提）

---

## 1. P8-A: リスク検知（§57）

### P8-A-01 — 設定 `src/config/risk.ts`（0.6h）

- [ ] `src/config/risk.ts` を作成
  - [ ] `RISK_WEIGHTS`: `new_device: 20` / `new_ip: 10` / `rapid_distinct_ips: 30` / `failed_burst: 30` / `automated_client: 25`
  - [ ] `RISK_THRESHOLDS`: `notify: 20` / `challenge: 50` / `hold: 80`
  - [ ] `RISK_WINDOWS`: `distinctIp: 3600_000` / `failedBurst: 900_000`
  - [ ] `RISK_LIMITS`: `distinctIps: 3` / `failedCount: 5`
  - [ ] `RISK_ENFORCEMENT` を `env.ts` から読む型（`'notify' | 'challenge' | 'hold'`）
- [ ] `src/lib/env.ts` に `RISK_ENFORCEMENT: z.enum(['notify','challenge','hold']).default('notify')` を追加
- [ ] 完了条件: `pnpm typecheck` green

### P8-A-02★ — `src/lib/auth/risk.ts`（1.6h）

- [ ] `src/test/security/risk.test.ts` を**先に**書く（純関数部分）
  - [ ] `scoreRisk` が重みの合計を返す（複数信号・重複信号は 1 回）
  - [ ] `riskLevel`: `0-19`→`low` / `20-49`→`medium` / `>=50`→`high`
  - [ ] `decideRiskAction(score)` が閾値どおり `allow`/`notify`/`challenge`/`hold`
  - [ ] `decideRiskAction(score, 'notify')` は高スコアでも `notify` で頭打ち
  - [ ] `decideRiskAction(score, 'challenge')` は `hold` まで到達しない
  - [ ] `assessLoginRisk`: 新規デバイス → `new_device` を含む
  - [ ] `assessLoginRisk`: 既知デバイス・既知 IP → 信号なし・`allow`
  - [ ] `assessLoginRisk`: `recentDistinctIpHashes >= 3` → `rapid_distinct_ips`
  - [ ] `assessLoginRisk`: `recentFailedCount >= 5` → `failed_burst`
  - [ ] `assessLoginRisk`: 空 UA → `automated_client`
  - [ ] `risk.ts` が `db` / `getPool` / `request` を import しない（静的検査）
- [ ] `src/lib/auth/risk.ts` を実装（`RiskSignal` / `RiskLevel` / `RiskAction` / `scoreRisk` / `riskLevel` / `decideRiskAction` / `assessLoginRisk`）
- [ ] 完了条件: `risk.test.ts`（純関数）green

### P8-A-03 — 集計クエリ（0.8h）

- [ ] `src/test/integration/risk-queries.test.ts` を**先に**書く（実 DB）
  - [ ] `countDistinctRecentIpHashes(userId, windowMs)` が重複を除いた件数を返す
  - [ ] `countRecentFailedLogins(userId, windowMs)` が `login_failed` のみ数える
  - [ ] ウィンドウ外の行を数えない（fake timers で時刻を進める）
- [ ] `src/lib/db/queries/security-events.ts` に上記 2 関数を追加
- [ ] 完了条件: `risk-queries.test.ts` green

### P8-A-04 — イベント種と配線（1.0h）

- [ ] `src/lib/db/schema.ts` の `SECURITY_EVENT_TYPES` に **`login_risk`** を追加
- [ ] `src/messages/ja.ts` の `securityEvents` に `login_risk: '不審なログインを検知'` を追加
- [ ] `src/test/security/security-events-coverage.test.ts` に `login_risk` の記録を追加
- [ ] `src/app/api/auth/login/route.ts`（2FA 無し）: セッション発行前に `assessLoginRisk` → `login_risk` 記録 → `notify` なら既存通知
- [ ] `src/app/api/auth/login/route.ts`（2FA 有り）: 保留セッション発行時に評価・記録
- [ ] `src/app/api/auth/2fa/challenge/verify/route.ts`: 昇格時に評価（既存通知と統合）
- [ ] `src/app/api/auth/oauth/[provider]/callback/route.ts`: セッション発行時に評価
- [ ] `src/app/api/auth/passkey/login/verify/route.ts`: セッション発行時に評価
- [ ] 完了条件: 既存の `new-device-notification.test.ts` / `login` 系テストが**緑のまま**（既定 notify で挙動不変）

### P8-A-05★ — `risk.test.ts`（配線・回帰）（1.0h）

- [ ] 既定（`RISK_ENFORCEMENT='notify'`）で高スコアでもログインが**成功**する（回帰ガード）
- [ ] `login_risk` イベントの metadata に `level` と `signals` だけが入る（生 IP・UA 全文・PII が無い・§45）
- [ ] `challenge` 強制時（env 上書き）に 2FA 保留セッションへ降格する
- [ ] 完了条件: green（DoD 直結）

---

## 2. P8-B: テスト完成（§48）

### P8-B-01★ — 正規ファイル新設（2.0h）

- [ ] `src/test/security/auth.test.ts`（新設）: 正 PW / 誤 PW / 存在しない email / 未認証 email / セッション期限切れ / ログアウト後の API 拒否
- [ ] `src/test/security/session.test.ts`（新設）: Cookie 属性 / fixation（ログイン前後で ID 変化）/ logout-all 後の旧 Cookie 拒否 / DB は hash 保存
- [ ] `src/test/security/oauth-redirect.test.ts`（新設）: `redirect_uri` 改ざん / 未登録 / open redirect 拒否
- [ ] `src/test/security/oauth-replay.test.ts`（新設）: code 再利用拒否 / 並行交換で成功 1 件
- [ ] 各ファイルは既存の細分化テストと**同じ実装**を叩く（モックで緑にしない）
- [ ] 完了条件: 4 ファイル green

### P8-B-02 — 通知イベントテスト（0.8h）

- [ ] `src/test/unit/notify-events.test.ts`（新設）: §18 の通知 9 種が漏れなく発火する
  - [ ] 新規デバイス / 新 IP・地域 / PW 変更 / email 変更 / 2FA 変更 / Passkey 追加 / Passkey 削除 / ソーシャル追加 / ソーシャル削除 / 全デバイスログアウト
  - [ ] 通知本文にパスワード・token・TOTP secret が含まれない（§45）
- [ ] 完了条件: green

### P8-B-03★ — E2E 通し（1.6h）

- [ ] `src/test/e2e/auth-journey.test.ts`（新設・`startTestAppServer` 方式）
  - [ ] 登録 → 201 / memory transport に確認メール
  - [ ] 確認 → `email_verified` 真
  - [ ] ログイン → `__Host-` Cookie / 誤 PW 401
  - [ ] 2FA → 保留セッション → challenge/verify で昇格
  - [ ] Passkey → 登録 → ログイン（`webauthn-mock`）
  - [ ] 設定 → セッション一覧 / 全ログアウト
  - [ ] 削除 → メール確認 → 削除 → 再ログイン 403
- [ ] 完了条件: green（DoD 直結）

### P8-B-04 — トラッカー更新（0.4h）

- [ ] `実装Todo.md` §12 の `[ ]` を実ファイル名で `[x]` に更新
- [ ] §48 の各カテゴリ ↔ ファイルの 1:1 対応を確認
- [ ] 完了条件: トラッカーに未チェックの §48 カテゴリが残っていない

---

## 3. P8-C: テスト基盤

### P8-C-01 — fixtures ヘルパ（0.8h）

- [ ] `src/test/helpers/fixtures.ts`（新規）
  - [ ] `createTestUser({ status, emailVerified, passwordHash, roleId })` — 通常 / 未検証 / suspended / PW 無し / admin
  - [ ] `cleanupUsers(ids)` — 関連行（sessions / security_events / totp / webauthn_credentials）をまとめて削除
  - [ ] 既存テストの `seedUser` と同等の SQL を 1 か所に集約
- [ ] 完了条件: 新ヘルパを使う 1 ファイル（`auth.test.ts`）が green

### P8-C-02 — fake timers / rate-limit / totp ヘルパ（0.8h）

- [ ] `src/test/helpers/rate-limit.ts`: レート制限キーの DB 掃除（`protectRateLimitKey` 経由）
- [ ] `src/test/helpers/totp.ts`: 有効 TOTP の seed と現在コード生成（`otpauth` 利用）
- [ ] 時間依存テストは `vi.useFakeTimers()` / `vi.setSystemTime()` を使う（実時間 `sleep` を禁止）
- [ ] 完了条件: 上記ヘルパを使うテストが flaky でない（3 回連続 green）

### P8-C-03 — 重複 seed の置換（0.4h）

- [ ] 散在する `seedUser` / `seedEnabledTotp` を可能な範囲で fixtures へ寄せる（**既存テストの意味は変えない**）
- [ ] 完了条件: `pnpm test` 全体 green

---

## 4. 品質ゲート

- [ ] `pnpm lint`（0 error / 0 warning）
- [ ] `pnpm typecheck`
- [ ] `pnpm test`（全 green）
- [ ] `pnpm test:security` / `pnpm test:e2e`（green）
- [ ] `pnpm build`
- [ ] §20.3 DoD チェックリスト（計画書）
  - [ ] 新規/変更 API が `withAuthPipeline` / レート制限 / `require*` ガードを通っているか
  - [ ] secret / 生 IP がログ・応答・metadata に漏れていないか（§45）
  - [ ] 認可をサーバー側で行っているか（§49）
  - [ ] `security_events` へ記録しているか（該当操作）
  - [ ] mutation が POST/PUT/PATCH/DELETE か（§25）
  - [ ] エラーが統一形式（§58）か

---

## 5. ドキュメント更新

- [ ] `実装Todo.md` の P8-01〜P8-07 を完了に更新
- [ ] `README.md` の実装状況表（M8 完了）と Phase 8 実装詳細節を追記
- [ ] `実装計画.md` の Phase 8「Playwright」表記を D-38-04（vitest + 実 HTTP）へ読み替え注記
- [ ] `AGENTS.md` の到達点を M8 完了へ更新（次は Phase 9）
