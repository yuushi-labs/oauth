# Phase 8 実装計画 — リスク検知 ＋ セキュリティテスト完成（M8）

> 対象: 仕様 §17（Bot 対策）・§48（セキュリティテスト）・§57（不審ログイン検知）・§64（完成条件）
> 前提工程: Phase 7.6（M7.6 アカウント削除フロー）まで完了
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-28
> 状態: **実装着手前（設計）**
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**。

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | ①§57 の**不審ログイン検知の「構造」**（`risk.ts`）を実装し、スコアを 3 段階アクションへ写像する。②§48 の全カテゴリに **1:1 対応する green テスト**を確定させる。③テスト基盤（fixtures / fake timers / mock）を整える |
| なぜやる | M8 の完成条件は「§48 セキュリティテスト全件 green」＋「§57 の構造」。現状 §48 の多くは既存テストで充足済みだが、**正規ファイル名に 1:1 対応していない**（`auth.test.ts` / `session.test.ts` / `oauth-redirect.test.ts` / `oauth-replay.test.ts` / `risk.test.ts` が不在）。§57 は未着手 |
| 工数 | 約 12 時間（8-A リスク検知 4h / 8-B テスト完成 6h / 8-C 基盤 2h） |
| 追加依存 | **無し**（Playwright は導入しない・D-38-04） |
| migration | **無し**（`security_events.event_type` は CHECK 無しの text。新イベント種は定数追加のみ） |
| 新規ファイル | ライブラリ 2 / 設定 1 / テスト 6 / ヘルパ 1 → §7 |
| 最大リスク | §57 の「短時間多数地域」は**外部 geo-IP サービス前提**。本リポジトリは外部依存を持ち込まない方針のため、観測可能な代理指標（短時間の複数 `ip_hash`）へ読み替える（D-38-01）。この読み替えを文書化しないと「仕様未達」に見える |

---

## 1. 背景

Phase 7.6 完了時点で、M8 の残件は次の 2 つ。

1. **§57 不審ログイン検知**: `src/lib/auth/risk.ts` が存在しない。現状の「新規デバイス通知」（`notifications.ts` の `isFirstSessionFromDevice`）は**通知 1 種**だけで、スコアリングも 3 段階の応答（追加認証 / メール通知 / セッション保留）も無い。仕様は「**将来的にリスクベース認証を追加できるようにする**（構造）」を求めており、判定の入口と閾値の置き場を先に固定する必要がある。
2. **§48 テスト完成**: 119 ファイル / 812 テストが green だが、§48 のカテゴリと**正規ファイル名**が 1:1 でない。トラッカー（`実装Todo.md` §12）の `[ ]` が実ファイル名と対応しておらず、「§48 全件 green」を**機械的に証明できない**。テスト基盤（fixtures / fake timers）も各ファイルへ散在している。

---

## 2. スコープ

**やること**

1. `src/lib/auth/risk.ts` — ログイン試行のリスクを評価する純関数群（外部 I/O を持たない）。
2. `src/config/risk.ts` — 重み・閾値・アクション写像を集約。
3. `security_events` に `login_risk` を追加（metadata に `level` / `signals`。生 IP・PII は入れない）。
4. ログイン経路（`/api/auth/login`、2FA 昇格、OAuth コールバック）へ**通知のみ**で配線（既定）。
5. §48 の正規ファイル名を新設・統合し、トラッカーを 1:1 で green に更新。
6. テスト基盤: `src/test/helpers/fixtures.ts`、`src/test/helpers/rate-limit.ts`（fake store）、`src/test/helpers/totp.ts`。
7. 実 HTTP E2E: 登録→確認→ログイン→2FA→Passkey→設定→削除の**通し 1 本**（既存 `startTestAppServer` 方式）。

**やらないこと**

- リスクによる**実際のログイン拒否**（既定では行わない。`RISK_ENFORCEMENT` を有効化した環境でのみ challenge / hold を発火）。
- 外部 geo-IP / デバイスフィンガープリント / 機械学習。
- Playwright の導入（D-38-04）。
- CAPTCHA の実接続（Phase 9 のまま。`captcha.ts` の interface は既存を再利用）。

---

## 3. 決定事項（D-38-01 〜 D-38-07）

| # | 決定 | 理由 |
|---|---|---|
| D-38-01 | リスク判定は**外部 geo-IP サービスに依存しない**。自前で観測できるデータ（`sessions.ip_hash` / `device_name` / `security_events` の集計）だけで判定する。仕様 §57 の「短時間で複数地域」は「**短期間に複数の `ip_hash`**」と読み替える | リポジトリは「外部依存を持ち込まない」方針（Phase 3 の IP 国判定を不採用にした前例）。`sessions.ip_country` は常に `null` で、実 geo は存在しない。読み替えを本書に明記して仕様の意図（異常な移動の検知）を満たす |
| D-38-02 | 判定は **`score`（整数）→ 3 段階アクション**（`notify` / `challenge` / `hold`）へ写像する。重みと閾値は `src/config/risk.ts` に集約し、`risk.ts` にマジックナンバーを置かない | 仕様 §57「危険度が高い場合は追加認証・メール通知・セッション保留」を 1 か所で調整可能にする。閾値の散在は判定の再現性を壊す |
| D-38-03 | **既定は通知のみ（enforce しない）**。`RISK_ENFORCEMENT` 環境変数（既定 `'notify'`）で `'challenge'` / `'hold'` へ段階的に強化できる | 仕様は「追加**できる**構造」。既定で挙動を変えると既存の green テストを壊し、誤検知がログイン不能を生む。段階導入を可能にして §57 の意図を満たす |
| D-38-04 | E2E は **Playwright を導入せず**、既存の vitest ＋ 実 HTTP（`startTestAppServer`）方式を維持する | リポジトリには既に実 Route Handler / Cookie / 303 / Set-Cookie を検証する e2e 基盤がある。Playwright はブラウザバイナリと flaky を持ち込み、認証フローの被覆を増やさない。`実装計画.md` の「Playwright」表記は本決定で読み替える（要文書化） |
| D-38-05 | §48 の各カテゴリを**正規ファイル名に 1:1 対応**させる。`auth.test.ts` / `session.test.ts` / `oauth-redirect.test.ts` / `oauth-replay.test.ts` を新設し、既存の細分化テストは**残したうえで**正規ファイルから主要ケースを参照する | トラッカーの `[ ]` を実ファイルで機械的に閉じられるようにする。「§48 全件 green」の証明可能性を上げる |
| D-38-06 | テスト基盤は `src/test/helpers/fixtures.ts` に**ユーザー生成（通常 / 未検証 / suspended / PW 無し / admin）**を集約する。時間依存テストは `vi.useFakeTimers()` を使い、実時間待ちを禁止する | 各テストが個別に `INSERT INTO users ...` を書いており重複・不整合の温床。時間依存は flaky の主因（P8-07★） |
| D-38-07 | リスクイベントは `security_events` の新種 **`login_risk`** に記録し、metadata には `level` と `signals`（信号名の配列）だけを入れる。生 IP・UA 全文・PII は入れない | §21 のイベント記録要件を満たしつつ §45（秘密情報・PII 非ログ）を守る。信号名は列挙で扱い、自由文にしない |

---

## 4. リスク検知モジュール設計（8-A）

### 4.1 信号（signals）

すべて**呼び出し側が渡す観測値**から計算する（`risk.ts` は DB を触らない純関数）。

| 信号 | 入力 | 意味 | 既定重み |
|---|---|---|---|
| `new_device` | `ipHash` + `deviceName` が有効セッションに無い | §18 の新規デバイス | 20 |
| `new_ip` | `ipHash` が有効セッションに無い | 新しい IP | 10 |
| `rapid_distinct_ips` | 直近ウィンドウ内の**異なる `ip_hash` 数** ≥ 閾値 | §57「短時間で複数地域」の代理 | 30 |
| `failed_burst` | 直近ウィンドウ内の `login_failed` 件数 ≥ 閾値 | §57「大量ログイン試行」 | 30 |
| `automated_client` | UA が空 / 既知の自動化パターン | §57「自動化されたリクエスト」 | 25 |

### 4.2 アクション写像

| スコア | アクション | 意味 |
|---|---|---|
| `< notifyThreshold` | `allow` | 何もしない |
| `≥ notifyThreshold` | `notify` | メール通知（§18 の既存通知を再利用） |
| `≥ challengeThreshold` | `challenge` | 追加認証（2FA 保留セッションへ降格） |
| `≥ holdThreshold` | `hold` | セッション保留（ログインを保留し、確認を要求） |

`RISK_ENFORCEMENT` はアクションの**上限**を決める: `'notify'`（既定）= どれだけ高くても `notify` 止まり、`'challenge'` = `challenge` まで、`'hold'` = 全段階。

### 4.3 API（純関数）

```ts
export type RiskSignal = 'new_device' | 'new_ip' | 'rapid_distinct_ips' | 'failed_burst' | 'automated_client';
export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskAction = 'allow' | 'notify' | 'challenge' | 'hold';

export function scoreRisk(signals: RiskSignal[]): number;
export function riskLevel(score: number): RiskLevel;
export function decideRiskAction(score: number, enforcement?: RiskEnforcement): RiskAction;
export function assessLoginRisk(input: LoginRiskInput): { score: number; level: RiskLevel; action: RiskAction; signals: RiskSignal[] };
```

`assessLoginRisk` は信号の**判定に必要な観測値**（`activeSessions`, `recentDistinctIpHashes`, `recentFailedCount`, `userAgent`）を受け取り、DB へは触らない。DB 集計は呼び出し側（ログイン経路）が `queries` で行い、その結果を渡す。

### 4.4 配線（既定 = notify のみ）

| 経路 | 配線 |
|---|---|
| `POST /api/auth/login`（2FA 無し） | セッション発行前に `assessLoginRisk` → `login_risk` を記録 → `action==='notify'` なら既存の `notifyNewDeviceLogin` を呼ぶ |
| `POST /api/auth/login`（2FA 有り） | 保留セッション発行時に評価し、`login_risk` を記録（昇格時に通知） |
| `POST /api/auth/oauth/{provider}/callback` | 新規セッション発行時に評価（既存の新規デバイス通知と統合） |
| `POST /api/auth/passkey/login/verify` | 同上 |

**既存挙動を変えない**: `RISK_ENFORCEMENT='notify'`（既定）では `challenge` / `hold` は発火しない。既存の「新規デバイス通知」は `new_device` 信号が `notify` 域に入るため**そのまま維持**される（回帰テストで固定）。

---

## 5. §48 テスト完成マトリクス（8-B）

> 「新設」= 本フェーズで追加。「既存」= 既に green。既存の細分化ファイルは**削除しない**。

| 仕様 §48 カテゴリ | 正規ファイル | 主要ケース | 状態 |
|---|---|---|---|
| 認証 | `src/test/security/auth.test.ts` | 正 PW / 誤 PW / 存在しない email / 未認証 email / セッション期限切れ / ログアウト後の API 拒否 | **新設**（ケースは既存テストに存在。集約して正規名を付す） |
| 一意制約 | `src/test/security/uniq.test.ts` | 大文字小文字違いで重複不可 / 論理削除済みは再利用可 / partial index | 既存 |
| パスワード | `src/test/unit/password.test.ts` | 7 文字拒否 / 8 OK / 128 OK / 129 拒否 / Unicode / 空白のみ拒否 / reset 再利用拒否 | 既存 |
| 漏洩 PW | `src/test/unit/breached.test.ts` | 検出 / 拒否 / timeout = fail-open | 既存 |
| OAuth state | `src/test/security/oauth-state.test.ts` | state 改ざん / 欠落 | 既存 |
| OAuth nonce | `src/test/security/oauth-nonce.test.ts` | nonce 改ざん | 既存 |
| OAuth PKCE | `src/test/security/oauth-pkce.test.ts` | verifier 不一致 / downgrade | 既存 |
| OAuth redirect | `src/test/security/oauth-redirect.test.ts` | `redirect_uri` 改ざん / 未登録 / open redirect 拒否 | **新設** |
| OAuth replay | `src/test/security/oauth-replay.test.ts` | code 再利用 / 並行交換で成功 1 件 | **新設** |
| アカウントリンク | `src/test/security/account-linking.test.ts` | email 一致の自動統合拒否 | 既存 |
| セッション | `src/test/security/session.test.ts` | Cookie 属性 / fixation（前後で ID 変化）/ logout-all 後の旧 Cookie 拒否 / DB は hash 保存 | **新設**（`session-attr` / `session-management` を包含） |
| Web | `src/test/security/web.test.ts` | XSS / CSRF / SQLi / Open Redirect / Clickjacking / CORS / Header | 既存 |
| 2FA | `src/test/security/2fa.test.ts` | TOTP 誤入力 / 回避試行 / recovery 再利用 / 無効化時再認証 | 既存 |
| 2FA 並行 | `src/test/security/2fa-concurrent-replay.test.ts` | 同一 TOTP 2 並行 → 成功 1 件 | 既存 |
| Passkey | `src/test/security/webauthn-*.test.ts` | challenge 再利用 / origin / rpID / 削除済み / sign count | 既存 |
| RBAC / 管理者 | `src/test/security/{rbac,admin,audit-access,idor}.test.ts` | 権限判定 / secret 非露出 / 監査遮断 / IDOR | 既存 |
| **リスク検知（§57）** | `src/test/security/risk.test.ts` | 新規デバイス / 複数 IP / 大量試行 / 自動化 UA / 3 段階写像 / 既定 notify のみ | **新設** |
| ログ秘匿（§45） | `src/test/security/log-redaction.test.ts` | PW / hash / client secret / token / TOTP secret / session token | 既存（計画の `unit/log-redaction` 表記を本ファイルへ読み替え） |
| 通知イベント（§18） | `src/test/unit/notify-events.test.ts` | 変更系 9 種の通知が漏れなく発火 / 本文に秘密が無い | **新設** |
| その他単体 | `src/test/unit/{id,time,ip,crypto}.test.ts` | prefix 付き ULID / UTC / IP mask / AES-GCM | 既存 |
| E2E 通し | `src/test/e2e/auth-journey.test.ts` | 登録→確認→ログイン→2FA→Passkey→設定→削除 | **新設** |

---

## 6. 実 HTTP E2E（8-B）

`startTestAppServer({ dev: true, oidc: false })` を使い、1 ファイルで通しを検証する。既存の `phase3-screens` / `oauth-flow` と同じ方式。

| ステップ | 検証 |
|---|---|
| 登録 | 201 / 確認メールが memory transport に届く |
| 確認 | トークン消費で `email_verified` が真 |
| ログイン | `__Host-` Cookie が付く / 誤 PW は 401 |
| 2FA | 保留セッション発行 → challenge/verify で昇格 |
| Passkey | 登録 → ログイン（`webauthn-mock` 使用） |
| 設定 | セッション一覧・全ログアウト |
| 削除 | メール確認 → 削除 → 再ログインが 403 |

---

## 7. 実装ファイル一覧

| 種別 | パス |
|---|---|
| ライブラリ | `src/lib/auth/risk.ts`（新規） |
| 設定 | `src/config/risk.ts`（新規） |
| 変更 | `src/lib/db/schema.ts`（`login_risk` 追加）/ `src/messages/ja.ts` / `src/lib/env.ts`（`RISK_ENFORCEMENT`）/ `src/app/api/auth/login/route.ts` / `.../2fa/challenge/verify/route.ts` / `.../oauth/[provider]/callback/route.ts` / `.../passkey/login/verify/route.ts` / `src/lib/db/queries/security-events.ts`（集計クエリ） |
| テスト（新規） | `src/test/security/risk.test.ts` / `auth.test.ts` / `session.test.ts` / `oauth-redirect.test.ts` / `oauth-replay.test.ts` / `src/test/unit/notify-events.test.ts` / `src/test/e2e/auth-journey.test.ts` |
| ヘルパ（新規） | `src/test/helpers/fixtures.ts` / `rate-limit.ts` / `totp.ts` |
| migration | **不要** |

---

## 8. DoD（Phase 8）

- [ ] `src/test/security/risk.test.ts` green（§57 の 3 段階写像・既定 notify のみ・信号判定）
- [ ] §48 の全カテゴリが**正規ファイル名で green**（§5 のマトリクスを 1:1 で充足）
- [ ] E2E 通し（`auth-journey.test.ts`）green
- [ ] `pnpm test` / `pnpm test:security` / `pnpm test:e2e` が全て green
- [ ] `RISK_ENFORCEMENT` 既定（`'notify'`）で既存ログイン挙動が不変（回帰テスト green）
- [ ] `pnpm lint` 0 error / `pnpm typecheck` 0 error
- [ ] `実装Todo.md` §12 のトラッカーを実ファイル名で `[x]` に更新
