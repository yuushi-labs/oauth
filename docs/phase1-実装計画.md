# Phase 1 詳細実装計画 — メール/パスワード認証 完成

**作成日**: 2026-10-10  
**基準**: `phase1-audit-report.md` / `実装Todo.md` / `実装計画.md` v1.4 / `超本格アカウント・認証システム仕様書 v1.2.md`
**目的**: 監査で発見された不足を修正し、Phase 1 を完全完了させる

---

## 1. 作業スコープと優先順位

### Phase 1 で実装・修正する項目

| # | 領域 | タスク | 優先度 | 備考 |
|---|---|---|---|---|
| 1 | Session | `rotateSession()` の `replaced_by` 設定 | Critical | セッション追跡・固定攻撃検知に必須 |
| 2 | Email Change | `email/change/confirm` で `emailVerified: true` / 旧メール通知 / `oldEmailNotifiedAt` | Critical | 仕様§14・D-07準拠 |
| 3 | Account Delete | Phase 1 既存テーブルの無効化をトランザクションで実装 | Critical | §24準拠、Phase 4-6テーブルは依存タスクとして記録 |
| 4 | CSRF | 共通検証コアを抽出、Server Action アダプター追加 | Critical | P1-C-04a/b |
| 5 | Rate Limit | PG race condition 対策 / Redis 実装 / 設定追加 | High | P1-C-06/07 |
| 6 | Enum対策 | 登録時の重複メッセージ統一 | High | §46準拠 |
| 7 | Password Reset | 旧メール通知追加 | Medium | §15準拠 |
| 8 | Argon2id負荷テスト | 実測スクリプト作成・実行・記録 | Medium | P1-A-02 |
| 9 | Unit Tests | `password.test.ts` / `breached.test.ts` | High | P1-A-06/06a |
| 10 | Security Tests | `src/test/security/` 7ファイル作成 | Critical | DoD必須 |
| 11 | Integration Tests | `src/test/integration/` 作成 | High | |
| 12 | Test Scripts | `test:integration` / `test:security` 追加 | High | |
| 13 | Migration履歴修復 | `_journal.json` とDBの整合 | High | 既存データ保持 |

### Phase 1 で実装しない項目（Phase 2以降へ延期）

| 項目 | 担当フェーズ | 記録方法 |
|---|---|---|
| OAuth callback 例外設計 | Phase 4 | 計画に依存タスクとして記録 |
| `accounts` / `webauthn_credentials` / `totp` / `recovery_codes` 無効化 | Phase 4/5/6 | Phase 1で実装せず、削除APIへの連動タスクを記録 |
| HSTS/CSP/Permissions-Policy | Phase 2 | middleware 拡張として記録 |
| E2E tests (Playwright) | Phase 3/8 | 基盤のみ整備、実装は延期 |
| Redis レート制限の本格運用 | Phase 1-C 完了後 | 今回はフォールバック実装と並行動作確認まで |

---

## 2. 修正順序と依存関係

```
Phase 1-A テスト追加 (独立)
    ↓
Phase 1-B テスト追加 (独立)
    ↓
Session rotate 修正 (独立)
    ↓
Email change confirm 修正 (独立)
    ↓
Account delete 修正 (Session rotate 依存)
    ↓
CSRF 共通化 (全mutationエンドポイント影響)
    ↓
Rate Limit 修正 (全エンドポイント影響)
    ↓
Enum対策 修正 (register endpoint)
    ↓
Password reset 通知追加 (独立)
    ↓
Argon2id 負荷テスト (独立)
    ↓
Security/Integration テスト基盤構築
    ↓
全テスト実行・検証
    ↓
Migration履歴修復
    ↓
最終検証
```

---

## 3. ファイル別修正内容

### 3.1 `src/lib/auth/session.ts`

**修正**: `rotateSession()` で `replaced_by` 設定

```typescript
export async function rotateSession(
  oldToken: string,
  request: { headers: Headers },
): Promise<{ token: string; session: SessionData } | null> {
  const oldSession = await getSession(oldToken);
  if (!oldSession) return null;
  
  // 新セッション作成を先に行う
  const { token, session: newSession } = await createSession(oldSession.userId, request);
  
  // 旧セッションを無効化（replaced_by に新セッションIDを記録）
  await revokeSession(oldSession.id, 'rotation', newSession.id);
  
  return { token, session: newSession };
}
```

`revokeSession()` のシグネチャ変更: `revokeSession(id: string, reason: string, replacedBy?: string)`

### 3.2 `src/app/api/auth/email/change/confirm/route.ts`

**修正**:
1. `emailVerified: true` 設定追加
2. 旧メールへ `sendChangeNotificationEmail` 送信
3. `oldEmailNotifiedAt` 更新（通知成功時のみ）
4. トランザクションで email更新・token消費・notifiedAt更新を原子化

### 3.3 `src/app/api/auth/account/route.ts`

**修正**: Phase 1 既存テーブルの無効化
- `sessions`: 全revoke (既存 `revokeAllSessions` 使用)
- `email_verification_tokens` / `password_reset_tokens` / `email_change_requests`: 未使用分を `usedAt` 設定
- Phase 4-6 テーブル (`accounts`, `webauthn_credentials`, `totp`, `recovery_codes`) は存在しないためスキップ、依存タスクとして記録

### 3.4 `src/lib/auth/csrf.ts` / `src/lib/api/utils.ts`

**修正**: 共通検証コアの抽出

```typescript
// 共通コア（Requestオブジェクト非依存）
export async function validateCsrfCore(
  headers: Headers,
  session: SessionData | null,
): Promise<void> { ... }

// Route Handler 用アダプター
export async function withAuthPipeline(
  request: NextRequest,
  options: PipelineOptions,
  handler: (ctx: PipelineContext) => Promise<Response>,
): Promise<Response> { ... }

// Server Action 用アダプター
export async function withAuthActionPipeline(
  getHeaders: () => Headers,
  getSession: () => Promise<SessionData | null>,
  options: PipelineOptions,
  handler: (ctx: PipelineContext) => Promise<ActionResult>,
): Promise<ActionResult> { ... }
```

### 3.5 `src/lib/auth/rate-limit.ts`

**修正**: 
1. PG での race condition 対策: `UPDATE ... SET count = count + 1 WHERE ... RETURNING count` で原子的インクリメント
2. Redis 実装: `ioredis` または Upstash REST、Luaスクリプトで原子化
3. フォールバック: Redis 接続失敗時は PG に自動切替、制限を無効化しない

### 3.6 `src/config/rate-limits.ts`

**追加**:
```typescript
export const RATE_LIMITS = {
  // 既存
  register: { window: 3600_000, limit: 5 },
  login: { ip: {...}, account: {...}, ipAccount: {...} },
  forgot: { email: {...}, ip: {...} },
  resend: { user: {...}, ip: {...} },
  // 追加（Phase 1範囲）
  settings: { window: 60_000, limit: 120 },
  // Phase 4-6用はコメントアウトで定義のみ
  // oauth: { start: {...}, callback: {...} },
  // 2fa: { window: 300_000, limit: 10 },
  // passkey: { window: 300_000, limit: 30 },
} as const;
```

### 3.7 `src/app/api/auth/register/route.ts`

**修正**: 重複エラーを統一メッセージに
- 23505 (unique violation) を捕捉し、`VALIDATION_ERROR` + 統一メッセージで返す
- 既存実装は `EMAIL_TAKEN` を返している → 修正

---

## 4. テスト実装計画

### 4.1 Unit Tests (`src/test/unit/`)

| ファイル | テストケース |
|---|---|
| `password.test.ts` | hash形式 / salt独立性 / verify成功失敗 / rehash判定 / Unicode / 空白のみNG / 8文字/128文字/129文字境界 |
| `breached.test.ts` | 3ケース: 正常検出/漏洩拒否/timeout=fail-open許可（HIBPモック使用） |

### 4.2 Security Tests (`src/test/security/`)

| ファイル | テストケース |
|---|---|
| `uniq.test.ts` | 大文字小文字違い重複不可 / 論理削除済み再利用可 / partial indexで二重登録拒否 |
| `csrf.test.ts` | 正常/Origin偽装/token欠落/token不正 → Route Handler & Server Action 双方で検証 |
| `session-fixation.test.ts` | ログイン前後でsession ID変化 / 前session拒否 / 生token不在DB |
| `token-reuse.test.ts` | token再利用失敗 / 期限切れ / purpose流用不可 / 並行消費防止 |
| `token-expiry.test.ts` | 期限切れtoken拒否 / 再発行時の旧token失効 |
| `enumeration.test.ts` | 登録/ログイン/リセットで統一メッセージ / 存在有無を区別しない |
| `rate-limit.test.ts` | 閾値超過で429 / ウィンドウリセットで復帰 / 並行リクエストで漏れなし |
| `session-attr.test.ts` | Cookie属性 / DBはhashのみ / 生tokenなし / absolute expiry |

### 4.3 Integration Tests (`src/test/integration/`)

| ファイル | テストケース |
|---|---|
| `auth-flow.test.ts` | 登録→メール確認→ログイン→PW変更→ログアウト |
| `email-change.test.ts` | 登録→email変更→PWリセット→アカウント削除 |
| `security-events.test.ts` | 全エンドポイントで適切なイベント記録 |
| `token-lifecycle.test.ts` | token発行→消費→再利用拒否→期限切れ |

---

## 5. Migration履歴修復手順

### 現状分析
- DBには 0000-0005 のテーブルが全て存在
- `drizzle/meta/_journal.json` には 0000, 0001 のみ記録
- `drizzle_kigrations` テーブルは存在しない（drizzle-kit が作成していない）

### 修復手順

1. **現状バックアップ**: `_journal.json` をコピー
2. **適用済みmigrationの特定**: DBのテーブル・インデックス・制約から逆算
3. **正しい `_journal.json` 生成**: 0000-0005 全てのエントリを正しいhash・順序で作成
4. **検証**: 別DBで `pnpm db:migrate` が「適用済みスキップ」になることを確認
5. **本番反映**: 安全確認後、本番 `_journal.json` を置換

### 注意事項
- 既存データを削除しない
- `drizzle-kit migrate` を再実行してテーブル再作成しない
- hash値は生成済みSQLファイルから計算

---

## 6. Argon2id 負荷テスト

### スクリプト: `scripts/argon2-benchmark.ts`

```typescript
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { getEnv } from '@/lib/env';

async function benchmark() {
  const password = 'test-password-12345';
  const iterations = 10;
  
  // メモリ測定
  const memBefore = process.memoryUsage().heapUsed;
  
  // hash時間測定
  const hashStart = performance.now();
  const hashes = [];
  for (let i = 0; i < iterations; i++) {
    hashes.push(await hashPassword(password));
  }
  const hashTime = performance.now() - hashStart;
  
  // verify時間測定
  const verifyStart = performance.now();
  for (const h of hashes) {
    await verifyPassword(password, h);
  }
  const verifyTime = performance.now() - verifyStart;
  
  const memAfter = process.memoryUsage().heapUsed;
  
  console.log({
    params: getEnv().ARGON2_M ? { m: getEnv().ARGON2_M, t: getEnv().ARGON2_T, p: getEnv().ARGON2_P } : 'default',
    iterations,
    avgHashMs: hashTime / iterations,
    avgVerifyMs: verifyTime / iterations,
    memoryDeltaMB: (memAfter - memBefore) / 1024 / 1024,
  });
}
```

### 記録形式
```markdown
## Argon2id 負荷テスト実測 (YYYY-MM-DD)

- 環境: Node.js vXX, @node-rs/argon2 vX.X.X
- パラメータ: m=19456, t=2, p=1
- 反復: 10回
- 平均hash時間: XX ms
- 平均verify時間: XX ms
- メモリ増分: XX MB
- 判定: 目標達成 / 未達成（調整案: ...）
```

---

## 7. テスト環境・DB分離

### 環境変数
```env
# .env.test (gitignore 対象)
TEST_DATABASE_URL=postgresql://app:app@localhost:5433/app_test
```

### テストセットアップ (`vitest.setup.ts`)
```typescript
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/db/client';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

let testDb: any;

beforeAll(async () => {
  // テスト専用DB作成・migrate
  testDb = await setupTestDatabase();
});

beforeEach(async () => {
  // トランザクション開始 or テーブルTRUNCATE
  await truncateAllTables(testDb);
});

afterAll(async () => {
  // テストDB削除 or 接続終了
  await teardownTestDatabase(testDb);
});
```

### モック化
- Resend: `vi.mock('@/lib/auth/email/send')` で送信を捕捉
- HIBP: `vi.mock('@/lib/auth/breached')` で応答を制御
- fetch: `vi.stubGlobal('fetch', mockFetch)` で外部通信遮断

---

## 8. package.json scripts 更新

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run src/test/unit",
    "test:integration": "vitest run src/test/integration",
    "test:security": "vitest run src/test/security",
    "test:all": "pnpm test:unit && pnpm test:integration && pnpm test:security",
    "bench:argon2": "tsx scripts/argon2-benchmark.ts"
  }
}
```

---

## 9. 完了条件（DoD）

| 項目 | 確認方法 |
|---|---|
| 全実装タスク完了 | 該当ファイル修正・コミット済み |
| Unit tests pass | `pnpm test:unit` green |
| Security tests pass | `pnpm test:security` green (7ファイル) |
| Integration tests pass | `pnpm test:integration` green |
| Lint/Typecheck pass | `pnpm lint` 0 errors / `pnpm typecheck` green |
| Build pass | `pnpm build` success |
| DB migration 整合 | `pnpm db:migrate` が「適用済み」でスキップ |
| Argon2id実測記録 | `scripts/argon2-benchmark.ts` 実行結果をドキュメント化 |
| Todo更新 | 完了タスクのみ `[x]` |
| 未解決事項の記録 | Critical/High を残し、理由・対応策を明記 |

---

## 10. リスクと対策

| リスク | 影響度 | 対策 |
|---|---|---|
| Migration履歴修復でDB破損 | Critical | 別DBで検証済み手順のみ本番適用、バックアップ必須 |
| Redis導入でCI/ローカル環境が複雑化 | Medium | PGフォールバックをデフォルト、Redisは任意 |
| Server Action アダプターが未使用のまま | Medium | 最小実装でテスト通過を確認、Phase 3で本格利用 |
| 負荷テストで100ms超過 | Low | 実測値を記録し、調整案を提示（セキュリティ水準維持） |
| 並行テストのflaky | Medium | トランザクション分離・固定シード・リトライで安定化 |

---

## 11. 判断が必要な事項（仕様確認）

1. **登録時の重複エラー**: 仕様§46「統一メッセージ」に従い、23505を `VALIDATION_ERROR` に変換してよいか？ 既存実装は `EMAIL_TAKEN` だが、列挙攻撃対策で統一すべき。

2. **password/change の現行セッションrevoke**: D-03「全セッション revoke（現行含む）」に従い現行を残すか、仕様「他セッション」に従い現行を保持するか？ → D-03優先で現行含む全revoke維持。

3. **Account delete での Phase 4-6 テーブル**: 存在しないテーブルへの参照を避け、削除API内で条件分岐するか、共通関数で `try-catch` するか？ → 存在チェック付き共通関数で実装。

---

## 12. 進捗管理

各タスク完了時に `実装Todo.md` の該当チェックボックスを `[x]` に更新する。未完了タスクは `[ ]` のまま残す。

最終判定は「13. Phase 1の最終判定」の全項目確認後に行う。
