# Phase 7 実装計画 — 管理者 / RBAC / 監査

> 対象: M7（`実装計画.md` v1.6 §15「Phase 7 — 管理者 / RBAC / 監査（1.5〜2日）」）
> 前提工程: Phase 6（M6 Passkey / WebAuthn）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-27
> 状態: **実装着手（M6 完了後）**
> 実行手順: `docs/phase7-実行Todo.md`

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | 仕様 §49（認可はサーバー側）/ §50（権限システム）/ §51（管理者アカウント）/ §61（監査ログ）を実装する。`requireRole()` ガード、管理者ポリシー（2FA 必須・セッション 8h・再認証・操作ログ）、管理 API 5 本、`admin_audit_logs`、一般ユーザーからの監査ログ遮断 |
| なぜやる | M7 の完成定義は「RBAC + 監査ログ + 管理者 secret 非露出 green」（計画 §19）。M8（完成）の前提 |
| 工数 | **約 17.5 時間（約 2.2 日）**。内訳は §13 |
| 追加依存 | **無し**（`roles` は Phase 0 で seed 済み。`@simplewebauthn/*` は Phase 6 導入済み） |
| migration | **1 本のみ** = `0019_admin_rbac_audit.sql`（`role_permissions` / `admin_audit_logs` の 2 テーブルを新規作成。既存テーブルは変更しない） |
| 新規ファイル | **12 ファイル**（migration 1 / ライブラリ 3 / クエリ 2 / 検証 1 / API 5）→ §7.1 |
| テスト | 新規 **6 ファイル** ＋ 既存 4 ファイルへの追記 → §11 |
| 既存仕様の変更 | **無し**。`createSession` に「管理者は短命セッション」を表すオプションを 1 つ足す（既定は従来どおり 30 日・D-35-03）。`errors.ts` に 4 コード追加 |
| 最大リスク | **管理者 API が secret（`password_hash` / TOTP secret / passkey 公開鍵）を返してしまうこと**（§51 / §45）。列を明示選択し、応答をテストで固定する（§10 R1） |
| セキュリティの核 | (1) 認可は**サーバー側のみ**（§49・フロントの `isAdmin` は信用しない）、(2) 管理者 API は **2FA 有効 ＋ 再認証**を必須（§51）、(3) 監査ログは `admin_audit_logs` に**別テーブル**で記録（§61）、(4) 一般ユーザーは監査ログを**読めない**（403）、(5) 自己操作（自分を停止・削除）を禁止してロックアウトを防ぐ |
| 前提（Phase 0〜6 の成果を再利用） | `roles` / `ROLE_IDS` / `ROLE_SEED` は Phase 0 で定義済み。`requireSettingsUser` はサーバー側ガードの前例。`recordSecurityEvent` は**通常ログ**用で、監査ログは別物として分離する |

---

## 1. 正典と参照関係

| 文書 | 章 | 本書での扱い |
|---|---|---|
| 仕様書 v1.3 | §49 認可 | すべての認可判定はサーバー側。IDOR / BOLA 対策 |
| 仕様書 v1.3 | §50 権限システム | `user` / `admin` を最低限。role/permission ベース |
| 仕様書 v1.3 | §51 管理者アカウント | 2FA 必須・Passkey 推奨・セッション短め・再認証・操作ログ。管理画面は PW / TOTP secret を表示しない |
| 仕様書 v1.3 | §61 監査ログ | 5 種アクション。一般ユーザーから閲覧不可 |
| 仕様書 v1.3 | §45 情報漏洩防止 | secret をログ・応答・metadata に出さない |
| 仕様書 v1.3 | §58 エラー | 統一形式・詳細を漏らさない |
| 実装計画 v1.6 | §7.2 roles / role_permissions | `role_permissions` は将来拡張（MVP 未使用・D-19） |
| 実装計画 v1.6 | §11.6 管理者エンドポイント（35〜38） | API 契約の正 |
| 実装計画 v1.6 | §15 Phase 7 | タスク・DoD の正 |
| `docs/phase6-実行Todo.md` | §18 引継ぎメモ | `GET /api/auth/2fa` と `GET /api/auth/passkey` を組み合わせて「2FA 必須・Passkey 推奨」を判定する方針 |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済み・2026-10-27 実地調査）

| 領域 | 現状 | 根拠 |
|---|---|---|
| `roles` テーブル | **ある**（4 行 seed 済み: user / moderator / admin / superadmin） | `drizzle/0000_01_roles.sql`, `src/lib/db/schema.ts:36` |
| `users.role_id` | **ある**（`roles.id` への FK・index あり） | `src/lib/db/schema.ts:55` |
| `role_permissions` | **無い**（MVP 未使用・D-19） | `drizzle/`, `実装計画.md:253` |
| `admin_audit_logs` | **無い** | `drizzle/` |
| `requireRole()` ガード | **無い**。`roles.ts` は OIDC クライアント管理用の `canManageAnyOidcClient` のみ | `src/lib/auth/roles.ts` |
| 管理者 API | **未実装**。`src/app/api/admin/` が無い | `ls src/app/api/` |
| 監査ログ記録 | **無い**。`recordSecurityEvent` は通常ログ（`security_events`）専用 | `src/lib/auth/security-events.ts` |
| セッション TTL | 30 日（絶対 90 日）固定。role で変える仕組みは無い | `src/lib/auth/session.ts:26` |
| 一般ユーザー向けセキュリティイベント閲覧 | **ある**（本人のイベントのみ・`listRecentSecurityEventsByUser`） | `src/lib/db/queries/security-events.ts` |
| 再認証 | **ある**（`checkReauth` 5 分猶予 ＋ `withAuthPipeline({ requireReauth: true })`） | `src/lib/auth/reauth.ts`, `src/lib/api/utils.ts` |
| 2FA / Passkey の状態取得 | **ある**（`findTotpByUserId` / `countCredentialsByUser`） | `src/lib/db/queries/totp.ts`, `src/lib/db/queries/webauthn.ts` |

**結論**: 「入れる場所」は既に用意されている（role 列・再認証・2FA/Passkey の状態取得・セッション失効・論理削除）。足すのは **(1) 2 テーブル、(2) `requireRole()` と管理者ポリシー、(3) 監査ログ記録、(4) 管理 API 5 本、(5) 一般ユーザーからの遮断**。

### 2.2 目的（各々に完了定義を付ける）

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | **サーバー側の role 判定**（§49/§50） | `requireRole(user, 'admin')` が 403 を投げ、フロントの表示だけでは通らない（`rbac.test.ts`） |
| 2 | **管理者は 2FA 必須**（§51） | 2FA 無効の管理者が管理 API を叩くと 403 `ADMIN_2FA_REQUIRED`（`admin.test.ts`） |
| 3 | **管理者セッションは短命**（§51） | 管理者のログインで `expires_at` が 8 時間後になる（`admin.test.ts`） |
| 4 | **管理操作は再認証必須**（§51） | 再認証未了で管理 API → 401 `REAUTH_REQUIRED`（`admin.test.ts`） |
| 5 | **secret を一切返さない**（§51/§45） | `GET /api/admin/users` の応答に `password_hash` / TOTP secret / passkey 公開鍵 / `credential_id` が 1 件も現れない（`admin.test.ts`・DoD 直結★） |
| 6 | **監査ログを別テーブルに記録**（§61） | suspend / unsuspend / session revoke / delete / view の 5 アクションが `admin_audit_logs` に入る（`audit-access.test.ts`） |
| 7 | **一般ユーザーは監査ログを読めない**（§61） | 一般ユーザーの `GET /api/admin/audit-logs` は 403。SQL も管理者のみ（`audit-access.test.ts`・DoD 直結★） |
| 8 | **停止は対象の全セッションを失効**（§23） | suspend 後にそのユーザーのセッションが 401（`admin.test.ts`） |
| 9 | **自己ロックアウト防止** | 自分自身の suspend / delete は 409（`admin.test.ts`） |
| 10 | `role_permissions` を将来拡張として定義（§50・D-19） | テーブルが存在し、MVP では参照しない（migration 検証） |

---

## 3. スコープ

### 3.1 本フェーズで実装する

- `role_permissions` / `admin_audit_logs` テーブルと migration `0019_admin_rbac_audit.sql`
- `requireRole()` ガード（server-side のみ・§49/§50）
- 管理者ポリシー（§51）: 2FA 必須・セッション 8h・再認証・管理操作ログ
- `src/lib/auth/audit.ts`（5 種アクション）
- 管理 API 5 本（`GET /api/admin/users` / `suspend` / `unsuspend` / `sessions/revoke` / `delete` / `audit-logs`）
- 一般ユーザーから監査ログを遮断（API 403 ＋ クエリは管理者専用）
- 新エラーコード（`FORBIDDEN` / `ADMIN_2FA_REQUIRED` / `CANNOT_TARGET_SELF` / `ADMIN_NOT_FOUND`）

### 3.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 理由 | 引継ぎ先 |
|---|---|---|
| 管理画面（`/admin` の UI） | 仕様 §34 のフロントエンド画面一覧に含まれない。計画 §11.6 も API のみを規定 | 必要になった時点で別途 |
| `role_permissions` の権限判定 | MVP では未使用（D-19）。role 名の集合で判定する | 将来拡張 |
| `moderator` / `superadmin` の権限付与・判定 | 定義のみ（D-19）。rank 比較では admin 以上として扱うが、付与 UI・専用テストは作らない | 将来拡張 |
| DB ロール分離（`§52` の「DB ユーザーに最小権限」） | アプリ DB ユーザーの権限分離は運用デプロイ（Phase 9）の作業 | Phase 9 |
| 監査ログの保持期間・アーカイブ | §61 に期間の規定なし。`purge-expired` の対象にもしない | Phase 9（運用） |
| 管理者の Passkey 推奨表示 | 「推奨」は必須ではない（計画 §15 凡例） | 任意 |

---

## 4. 前提・着手前チェック

- `pnpm install` / `pnpm lint && pnpm typecheck && pnpm test` が green（**Phase 6 完了状態**）
- `pnpm db:verify-migrations` が green（最新は `0018`）
- `pnpm seed` 済み（`roles` に 4 行）
- テスト用に「管理者ユーザー（2FA 有効）」と「一般ユーザー」を作れること

---

## 5. 決定事項（D-35-01 〜 D-35-12）

| ID | 論点 | 決定 | 理由 |
|---|---|---|---|
| D-35-01 | `requireRole()` の判定方式 | role **rank** の比較（`user`=0 / `moderator`=1 / `admin`=2 / `superadmin`=3）。`requireRole(user, 'admin')` は rank 2 以上を許可 | §50「将来 moderator/superadmin へ拡張できる設計」。role 名の集合より拡張に強い |
| D-35-02 | 認可の場所 | **サーバー側のみ**。管理 API は必ず `requireRole` を通す。フロントの `isAdmin` は認可に使わない | §49。IDOR/BOLA 対策 |
| D-35-03 | 管理者セッションの TTL | **8 時間**（絶対も 8 時間）。`createSession` に `sessionMaxAgeSeconds` オプションを足し、ログイン時に role から決める。既定は従来どおり 30 日 / 90 日 | §51「セッション短め」。既存呼び出しの挙動を変えない |
| D-35-04 | 管理者の 2FA 必須の適用点 | **管理 API の入口**（`requireAdminAccess`）で「2FA 有効」を必須にする。ログイン自体は止めない | ログインを止めると 2FA 未設定の管理者が恒久ロックアウトされる。API で fail closed にする |
| D-35-05 | 管理 API の再認証 | 管理 API は **GET を含めすべて** `requireReauth: true`（5 分猶予） | §51「再認証」。一覧・監査ログも機微情報なので例外を作らない |
| D-35-06 | `admin_user_viewed` の記録点 | `GET /api/admin/users` の成功時に 1 件（metadata に `count`）。専用の詳細 API は作らない | 計画 §11.6 に詳細 API が無い。5 アクションを全て記録できる最小構成 |
| D-35-07 | 監査ログの保存先 | `admin_audit_logs` に**別テーブル**で保存。`security_events` には入れない | §61「通常のセキュリティログとは別」 |
| D-35-08 | 監査ログの actor / target | `actor_user_id` / `target_user_id` は nullable（FK, `ON DELETE SET NULL`）。表示名は追記時に `actor_username` / `target_username` へ**スナップショット**する | 当初は「論理削除のみ運用なので `actor_user_id` は NOT NULL」としたが、保持期間経過後の**物理削除**（§24 / D-36-09）で FK が切れるため D-36-09 で緩和。監査証跡は表示名スナップショットで保持する |
| D-35-09 | 監査ログの metadata | `count` / `reason` / `status` など**許可キーだけ**を残す（`security_events` と同じ方針）。secret は入れない | §45 |
| D-35-10 | 自己操作の禁止 | 自分自身の suspend / delete は **409 `CANNOT_TARGET_SELF`** | 管理者が自分を停止・削除してロックアウトされるのを防ぐ |
| D-35-11 | 対象が見つからない場合 | 存在しない・論理削除済みの user への操作は **404 `ADMIN_NOT_FOUND`**（他人の存在を教えない） | §49 |
| D-35-12 | 新エラーコード | `FORBIDDEN`(403) / `ADMIN_2FA_REQUIRED`(403) / `CANNOT_TARGET_SELF`(409) / `ADMIN_NOT_FOUND`(404) を `ERROR_CODES` / `ERROR_STATUS` / `DEFAULT_MESSAGES` / `ja.ts` に追加 | §58。AGENTS.md の「新コードは 3 か所すべてに足す」 |

### 5.1 却下した代替案（なぜ採らなかったか）

| 代替案 | 却下理由 |
|---|---|
| ログイン時に管理者の 2FA 未設定を拒否 | 恒久ロックアウト。2FA を設定する導線が無くなる（D-35-04） |
| `requireRole` を role 名の集合で判定 | `moderator`/`superadmin` の拡張時に各所を書き換える必要がある（D-35-01） |
| 監査ログを `security_events` に統合 | §61 が「別の監査ログ」と明記。一般ユーザーの本人イベント閲覧と混ざる（D-35-07） |
| 管理 API を再認証不要にする | §51 に反する（D-35-05） |
| 管理者一覧で role を join して name を返す | 追加クエリ・N+1 を避け、`role_id` を返す（`ROLE_IDS` はクライアントも知っている） |

---

## 6. データモデル

### 6.1 migration `drizzle/0019_admin_rbac_audit.sql`

**新規 2 テーブルのみ。既存テーブルの変更は無い。**

```sql
CREATE TABLE "role_permissions" (
  "role_id" text NOT NULL,
  "permission" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_permission_pk"
  PRIMARY KEY ("role_id","permission");
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk"
  FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_user_id" text NOT NULL,
  "action" text NOT NULL,
  "target_user_id" text,
  "target_session_id" text,
  "ip" text,
  "ip_masked" text,
  "user_agent" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_target_user_id_users_id_fk"
  FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_user_id_idx" ON "admin_audit_logs" USING btree ("actor_user_id");
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_user_id_idx" ON "admin_audit_logs" USING btree ("target_user_id");
```

> **down**: `0019` の down は `DROP TABLE admin_audit_logs; DROP TABLE role_permissions;`（依存が無いので順序は任意）。`verify-migrations.ts` の自動生成が扱える `CREATE TABLE` / `ADD CONSTRAINT` / `CREATE INDEX` のみで構成する。

### 6.2 設計上の判断

| 論点 | 決定 | 理由 |
|---|---|---|
| `role_permissions` の主キー | **複合主キー `(role_id, permission)`**。`id` 列を持たない | 権限は「role に permission を付ける」関係。重複を構造で防ぐ |
| `admin_audit_logs.id` | **`aud_` + ULID**（`newId('aud')`） | D-22 の `prefix_` + ULID 規約。`ID_PREFIXES` に `aud` を追加 |
| `actor_user_id` | **NOT NULL** ＋ FK（no action） | 監査の主体が無いログは無意味。物理削除しないので FK は保持できる |
| `target_user_id` | **nullable** ＋ FK（no action） | `admin_user_viewed`（一覧）は特定の対象を持たない |
| `action` | `text`（CHECK なし・アプリ層で `ADMIN_AUDIT_ACTIONS` に限定） | CHECK を付けると migration の down 生成が複雑になる（Phase 5/6 と同じ判断） |
| `ip` / `ip_masked` | 両方保存（`security_events` と同じ） | §20。生 IP は異常アクセス判定、表示は masked |
| `metadata` | `jsonb`（許可キーのみ） | §45 |
| インデックス | `created_at` / `actor_user_id` / `target_user_id` | 監査ログの閲覧は時系列・actor 別・対象別が主 |

### 6.3 `src/lib/db/schema.ts` への追加

```ts
export const ADMIN_AUDIT_ACTIONS = [
  'admin_user_viewed',
  'admin_user_suspended',
  'admin_user_unsuspended',
  'admin_session_revoked',
  'admin_account_deleted',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').notNull().references(() => users.id),
    action: text('action').notNull(),
    targetUserId: text('target_user_id').references(() => users.id),
    targetSessionId: text('target_session_id'),
    ip: text('ip'),
    ipMasked: text('ip_masked'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('admin_audit_logs_created_at_idx').on(table.createdAt),
    index('admin_audit_logs_actor_user_id_idx').on(table.actorUserId),
    index('admin_audit_logs_target_user_id_idx').on(table.targetUserId),
  ],
);

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
```

### 6.4 `scripts/verify-migrations.ts` への期待値追加

```ts
['role_permissions テーブルが存在する（migration 0019）', afterUp.tables.includes('role_permissions')],
['admin_audit_logs テーブルが存在する（migration 0019）', afterUp.tables.includes('admin_audit_logs')],
['role_permissions は roles への外部キーを持つ',
  Object.values(afterUp.foreignKeys).flat().includes('role_permissions_role_id_roles_id_fk')],
['admin_audit_logs は users への外部キーを 2 本持つ',
  Object.values(afterUp.foreignKeys).flat().includes('admin_audit_logs_actor_user_id_users_id_fk')
  && Object.values(afterUp.foreignKeys).flat().includes('admin_audit_logs_target_user_id_users_id_fk')],
['admin_audit_logs に created_at の index がある',
  (afterUp.indexes.admin_audit_logs ?? []).includes('admin_audit_logs_created_at_idx')],
```

---

## 7. 実装設計

### 7.1 新規ファイル一覧（12）

| # | パス | 種別 | 内容 |
|---|---|---|---|
| 1 | `drizzle/0019_admin_rbac_audit.sql` | migration | `role_permissions` / `admin_audit_logs` |
| 2 | `src/lib/auth/admin-policy.ts` | lib | `requireRole` / `hasRoleAtLeast` / `roleRank` / `requireAdminAccess` / `isAdminRole` |
| 3 | `src/lib/auth/audit.ts` | lib | `recordAdminAudit`（5 アクション・metadata フィルタ） |
| 4 | `src/lib/db/queries/admin.ts` | query | 管理者一覧（secret 非選択）・停止・再開・論理削除 |
| 5 | `src/lib/db/queries/audit-logs.ts` | query | 監査ログの一覧（管理者専用） |
| 6 | `src/lib/validate/admin.ts` | validate | zod（`listQuerySchema` / `targetIdParamSchema`） |
| 7 | `src/app/api/admin/users/route.ts` | API | `GET` 一覧（`admin_user_viewed`） |
| 8 | `src/app/api/admin/users/[id]/suspend/route.ts` | API | `POST` 停止 |
| 9 | `src/app/api/admin/users/[id]/unsuspend/route.ts` | API | `POST` 再開 |
| 10 | `src/app/api/admin/users/[id]/sessions/revoke/route.ts` | API | `POST` 全セッション失効 |
| 11 | `src/app/api/admin/users/[id]/delete/route.ts` | API | `POST` 論理削除 |
| 12 | `src/app/api/admin/audit-logs/route.ts` | API | `GET` 監査ログ一覧 |

### 7.2 変更する既存ファイル

| # | パス | 変更 |
|---|---|---|
| 1 | `src/lib/db/schema.ts` | `ADMIN_AUDIT_ACTIONS` / `rolePermissions` / `adminAuditLogs` を追加 |
| 2 | `src/lib/util/id.ts` | `ID_PREFIXES` に **`aud`** を追加 |
| 3 | `src/lib/errors.ts` | `FORBIDDEN` / `ADMIN_2FA_REQUIRED` / `CANNOT_TARGET_SELF` / `ADMIN_NOT_FOUND` を 3 か所に追加 |
| 4 | `src/messages/ja.ts` | 上記 4 コードの既定メッセージ |
| 5 | `src/lib/auth/session.ts` | `createSession` / `createSessionInternal` に `sessionMaxAgeSeconds` オプション（既定 30 日） |
| 6 | `src/app/api/auth/login/route.ts` | role が admin 以上なら 8 時間セッションで発行 |
| 7 | `src/config/rate-limits.ts` | `admin.read` / `admin.mutation` を追加 |
| 8 | `src/lib/auth/rate-limit-keys.ts` | `adminUser(userId)` を追加 |
| 9 | `scripts/verify-migrations.ts` | 期待値 5 件を追加 |
| 10 | `src/test/unit/roles.test.ts` | rank / `requireRole` のケースを追加 |

### 7.3 モジュール仕様

#### 7.3.1 `src/lib/auth/admin-policy.ts`

```ts
const ROLE_RANK: Record<string, number> = {
  [ROLE_IDS.user]: 0,
  [ROLE_IDS.moderator]: 1,
  [ROLE_IDS.admin]: 2,
  [ROLE_IDS.superadmin]: 3,
};

export function roleRank(roleId: string): number { return ROLE_RANK[roleId] ?? -1; }
export function isAdminRole(roleId: string): boolean { return roleRank(roleId) >= ROLE_RANK[ROLE_IDS.admin]; }
export function hasRoleAtLeast(user: RoleRef | null | undefined, minimum: string): boolean {
  return Boolean(user) && roleRank(user!.roleId) >= roleRank(minimum);
}
export function requireRole(user: RoleRef | null | undefined, minimum: string): void {
  if (!hasRoleAtLeast(user, minimum)) throw new ApiError('FORBIDDEN', 'この操作を行う権限がありません');
}
/** 管理 API の共通ガード: role ≥ admin ＋ 2FA 有効（§51・D-35-04）。 */
export async function requireAdminAccess(user: User): Promise<void> {
  requireRole(user, ROLE_IDS.admin);
  const totp = await findTotpByUserId(user.id);
  if (!totp?.enabled) throw new ApiError('ADMIN_2FA_REQUIRED', '管理者は 2 段階認証の有効化が必要です');
}
```

- **request / headers を受け取らない**（§49。判定材料はセッション由来の `user` のみ）。
- `requireAdminAccess` は DB を引くため非同期。

#### 7.3.2 `src/lib/auth/audit.ts`

```ts
const ALLOWED_METADATA_KEYS = new Set(['count', 'reason', 'status', 'sessions']);

export async function recordAdminAudit(input: {
  action: AdminAuditAction;
  actorUserId: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
  ip: string;
  userAgent: string;
  metadata?: Record<string, unknown>;
}): Promise<void>;
```

- `id` は `newId('aud')`。`ipMasked` は `maskIp(ip)`。
- metadata は `ALLOWED_METADATA_KEYS` のみ通す（§45）。
- **失敗しても呼び出し元を失敗させない**（記録の失敗で操作を巻き戻さない）。ただし `logger.error` で検知可能にする。

#### 7.3.3 `src/lib/db/queries/admin.ts`

| 関数 | 内容 |
|---|---|
| `listAdminUsers({ limit, offset })` | **明示的に列を選ぶ**。`id` / `username` / `email` / `email_verified` / `status` / `role_id` / `created_at` / `deleted_at` ＋ `has_password`（`password_hash IS NOT NULL`）＋ `has_2fa`（totp.enabled）＋ `passkey_count`。**`password_hash` / TOTP secret / passkey 公開鍵は選択しない** |
| `findAdminTarget(id)` | `deleted_at IS NULL` の user を返す（無ければ null・D-35-11） |
| `suspendUser(id)` | `status='suspended'` に更新 |
| `unsuspendUser(id)` | `email_verified` なら `status='active'`、でなければ `pending_email` に戻す |
| `deleteUserByAdmin(id)` | `softDeleteUser` を再利用 |

#### 7.3.4 `src/lib/db/queries/audit-logs.ts`

- `listAdminAuditLogs({ limit, offset })`: `admin_audit_logs` のみを select（時系列降順）。`actor` / `target` の email は join で最小限（`username` のみ）。**呼び出しは管理 API からのみ**。

#### 7.3.5 `src/lib/validate/admin.ts`

- `listQuerySchema`: `limit`（1〜100・既定 50）/ `offset`（≥0・既定 0）。
- `targetIdParamSchema`: `id` が `usr_` prefix ＋ ULID（`parseId` を再利用）。

---

## 8. API 契約

すべて `withAuthPipeline(request, { requireAuth: true, requireReauth: true }, ...)` を通し、ハンドラ先頭で `requireAdminAccess(user)` を呼ぶ（§8.4・D-35-05）。

### 8.1 `GET /api/admin/users` — 一覧

- レート制限: `admin.read`（120/分・soft 60）。
- 応答 `data`: `{ users: [{ id, username, email, email_verified, status, role_id, created_at, deleted_at, has_password, has_2fa, passkey_count }], total }`。
- **secret は含めない**（★）。
- 成功時に `recordAdminAudit({ action: 'admin_user_viewed', ..., metadata: { count } })`。

### 8.2 `POST /api/admin/users/{id}/suspend` — 停止

- 対象が自分 → 409 `CANNOT_TARGET_SELF`。対象が無い → 404 `ADMIN_NOT_FOUND`。
- `suspendUser` → `revokeAllSessions(target, 'admin_revoke')` → `recordAdminAudit('admin_user_suspended', metadata:{ status:'suspended' })`。
- 応答: `{ user: { id, status } }`。

### 8.3 `POST /api/admin/users/{id}/unsuspend` — 再開

- 対象が無い → 404。`unsuspendUser` → `recordAdminAudit('admin_user_unsuspended')`。

### 8.4 `POST /api/admin/users/{id}/sessions/revoke` — 全セッション失効

- 対象が無い → 404。`revokeAllSessions(target, 'admin_revoke')` → `recordAdminAudit('admin_session_revoked')`。

### 8.5 `POST /api/admin/users/{id}/delete` — 論理削除

- 対象が自分 → 409。対象が無い → 404。
- `softDeleteUser` → `revokeAllSessions` → `invalidateAllUserTokens` → `revokeUserOidcGrants` → `recordAdminAudit('admin_account_deleted')`。

### 8.6 `GET /api/admin/audit-logs` — 監査ログ一覧

- レート制限: `admin.read`。
- 応答 `data`: `{ logs: [{ id, action, actor_user_id, actor_username, target_user_id, target_username, ip_masked, metadata, created_at }], total }`。
- **`admin_audit_logs` のみ**を返す（`security_events` は含めない・§61）。

### 8.7 エラーコード一覧（Phase 7 で使う）

| コード | status | 用途 |
|---|---|---|
| `FORBIDDEN` | 403 | role 不足 |
| `ADMIN_2FA_REQUIRED` | 403 | 管理者の 2FA 未設定 |
| `CANNOT_TARGET_SELF` | 409 | 自分自身への suspend / delete |
| `ADMIN_NOT_FOUND` | 404 | 対象 user が無い / 論理削除済み |
| `REAUTH_REQUIRED` | 401 | 再認証未了（既存） |
| `SESSION_EXPIRED` | 401 | セッション無効（既存） |
| `RATE_LIMITED` | 429 | レート超過（既存） |

---

## 9. フロー設計

### 9.1 管理者一覧（GET）

`withAuthPipeline(requireAuth, requireReauth)` → `requireAdminAccess(user)`（role ≥ admin ＋ 2FA 有効）→ レート制限 → `listAdminUsers` → `recordAdminAudit('admin_user_viewed')` → 応答。

### 9.2 停止（POST）

`withAuthPipeline(requireAuth, requireReauth)` → `requireAdminAccess` → レート制限 → `findAdminTarget(id)`（無ければ 404）→ 自分なら 409 → `suspendUser` → `revokeAllSessions` → 監査ログ → 応答。

### 9.3 一般ユーザーの監査ログ遮断

`requireAdminAccess` が `FORBIDDEN`（403）を投げる。`admin_audit_logs` を読む関数は `audit-logs.ts` に閉じ、管理 API 以外から呼ばない（`audit-access.test.ts` が静的検査）。

---

## 10. セキュリティ設計（脅威モデル）

### 10.1 §45（情報漏洩防止）のチェック

| 対象 | 対策 |
|---|---|
| `password_hash` | 一覧の select に含めない。応答のテストで固定（★） |
| TOTP secret | `has_2fa`（boolean）だけを返す。`totp.secret_encrypted` は選択しない |
| passkey 公開鍵 / `credential_id` | `passkey_count`（数値）だけを返す |
| 監査ログの metadata | 許可キーのみ（D-35-09） |
| ログ出力 | `logger` の `SENSITIVE_KEYS` は既存のまま（secret を新たにログに出さない） |

### 10.2 追加の脅威

| # | 脅威 | 対策 |
|---|---|---|
| T1 | フロントの `isAdmin` を偽装して管理 API を叩く | サーバー側で `requireRole`（§49・D-35-02） |
| T2 | 一般ユーザーが監査ログを読む | `requireAdminAccess` が 403。SQL も管理 API 専用（§61） |
| T3 | 2FA 未設定の管理者が管理 API を使う | `ADMIN_2FA_REQUIRED`（403・D-35-04） |
| T4 | セッション窃取だけで管理操作 | 再認証必須（D-35-05） |
| T5 | 管理者が自分を停止・削除 | 409 `CANNOT_TARGET_SELF`（D-35-10） |
| T6 | 存在しない user の存在確認 | 404 `ADMIN_NOT_FOUND`（D-35-11） |
| T7 | 停止後もセッションが生きている | `revokeAllSessions`（§23） |
| T8 | 監査ログの改ざん | 追記のみ（更新・削除の API を作らない） |
| T9 | 総当たり | `admin.read` / `admin.mutation` のレート制限 |

---

## 11. テスト設計

### 11.1 新規テストファイル（6）

| # | パス | 種別 | 内容 |
|---|---|---|---|
| 1 | `src/test/security/rbac.test.ts`★ | security | `requireRole` / `roleRank` / `isAdminRole`。一般ユーザーで管理 API が 403。管理者で 200（2FA 有効・再認証済み） |
| 2 | `src/test/security/admin.test.ts`★ | security | 一覧の **secret 非露出**（`password_hash` / secret / 公開鍵が出ない）。2FA 未設定で 403。再認証未了で 401。自己 suspend/delete で 409。suspend で対象セッション失効。管理者ログインの 8h セッション |
| 3 | `src/test/security/audit-access.test.ts`★ | security | 5 アクションが `admin_audit_logs` に入る。一般ユーザーは監査ログを読めない（403）。`security_events` と混ざらない。静的検査（管理 API 以外が `listAdminAuditLogs` を呼ばない） |
| 4 | `src/test/integration/admin-queries.test.ts` | integration | `listAdminUsers` が secret 列を選択しない（実 DB）。`suspendUser` / `unsuspendUser` / `findAdminTarget` の owner/削除済みの扱い。`total` の一致 |
| 5 | `src/test/unit/admin-policy.test.ts` | unit | rank 比較。`requireRole` の throw。`isAdminRole`。request/headers を受け取らない |
| 6 | `src/test/unit/audit.test.ts` | unit | `recordAdminAudit` が `aud_` ID・masked IP・許可 metadata のみを保存。失敗を握る |

### 11.2 既存テストへの追記

| # | パス | 追記 |
|---|---|---|
| 1 | `src/test/unit/roles.test.ts` | rank / `isAdminRole` / `hasRoleAtLeast` |
| 2 | `src/test/unit/errors.test.ts` | 新 4 コードの status |
| 3 | `src/test/unit/schema.test.ts` | `role_permissions` / `admin_audit_logs` の列・PK・index |
| 4 | `src/test/unit/id.test.ts` | `aud` prefix（既存のループが自動で覆う） |
| 5 | `src/test/security/rate-limit.test.ts` | `RATE_LIMITS.admin` を追加 |

### 11.3 静的な検査（回帰防止）

- 管理 API 以外が `listAdminAuditLogs` を import しない（`audit-access.test.ts`）。
- `listAdminUsers` の select に `passwordHash` / `secretEncrypted` / `publicKey` / `credentialId` が現れない（grep）。
- `requireRole` / `requireAdminAccess` が `request` / `headers` を参照しない。

### 11.4 テストの実装方式

- 実 DB を使う（`fileParallelism: false`）。Route Handler を直接呼ぶ（`passkey-http.ts` と同じ方式）。cookie 書込みは `vi.mock('next/headers')`。
- 管理者ユーザーは `createUser({ roleId: ROLE_IDS.admin })` ＋ TOTP 行（`enabled=true`）を作る。再認証は `markReauthed` 相当で `reauth_verified_at` を更新する。
- 一般ユーザーは `roleId: ROLE_IDS.user`。

---

## 12. UI 設計

**本フェーズは UI を作らない**（§3.2）。仕様 §34 のフロントエンド画面一覧に管理画面は含まれず、計画 §11.6 も API のみを規定するため。

---

## 13. タスク分解と工数

`実装Todo.md` の P7 セクションを起点に、実装順に分解する。★ は DoD 直結。

### 13.1 P7-A: 基盤（6.0h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P7-A-01 | `drizzle/0019_admin_rbac_audit.sql` ＋ `schema.ts` ＋ `id.ts` ＋ `verify-migrations.ts` 期待値 | — | 1.4h | `pnpm db:migrate` / `db:verify-migrations` green |
| P7-A-02 | `errors.ts` に 4 コード ＋ `ja.ts` | — | 0.4h | `errors.test.ts` green |
| P7-A-03★ | `admin-policy.ts`（rank / `requireRole` / `requireAdminAccess`） | A-02 | 1.2h | `admin-policy.test.ts` / `rbac.test.ts` green |
| P7-A-04 | `audit.ts`（`recordAdminAudit`） | A-01 | 1.0h | `audit.test.ts` green |
| P7-A-05 | `db/queries/admin.ts` / `audit-logs.ts` | A-01 | 1.4h | `admin-queries.test.ts` green |
| P7-A-06 | `validate/admin.ts` ＋ `rate-limits` / `rate-limit-keys` | — | 0.6h | 型が通る |

### 13.2 P7-B: API（7.5h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P7-B-01★ | `GET /api/admin/users`（secret 非露出・`admin_user_viewed`） | A-03, A-05 | 1.8h | `admin.test.ts`（一覧）green |
| P7-B-02 | `POST .../suspend`（監査・全セッション失効・自己禁止） | B-01 | 1.4h | `admin.test.ts`（停止）green |
| P7-B-03 | `POST .../unsuspend` | B-02 | 0.8h | green |
| P7-B-04 | `POST .../sessions/revoke` | B-02 | 0.8h | green |
| P7-B-05 | `POST .../delete`（論理削除・全トークン失効・自己禁止） | B-02 | 1.3h | green |
| P7-B-06★ | `GET /api/admin/audit-logs`（管理者のみ・`admin_audit_logs` のみ） | A-05 | 1.4h | `audit-access.test.ts` green |

### 13.3 P7-C: ポリシーとテスト（4.0h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P7-C-01 | `createSession` の `sessionMaxAgeSeconds` ＋ login の 8h セッション | A-03 | 1.2h | `admin.test.ts`（8h）green |
| P7-C-02★ | `rbac.test.ts` | B-01 | 1.0h | green（DoD 直結） |
| P7-C-03★ | `audit-access.test.ts`（遮断の静的検査含む） | B-06 | 1.0h | green（DoD 直結） |
| P7-C-04 | 既存テストへの追記（§11.2） | C-02 | 0.8h | 全 green |

### 13.4 合計

| 区分 | 工数 |
|---|---|
| P7-A 基盤 | 6.0h |
| P7-B API | 7.5h |
| P7-C ポリシー / テスト | 4.0h |
| **合計** | **17.5h（約 2.2 日）** |

> 計画 `実装計画.md` §15 の見積もり「1.5〜2 日」と整合（UI を作らないため上振れは小さい）。

---

## 14. 完了定義（DoD）

### 14.1 機能

- [ ] 管理者（role ≥ admin・2FA 有効・再認証済み）が `GET /api/admin/users` でユーザー一覧を取得できる
- [ ] 管理者が suspend / unsuspend / sessions revoke / delete を実行できる
- [ ] suspend / delete で対象の全セッションが失効する
- [ ] 管理者が `GET /api/admin/audit-logs` で監査ログを取得できる
- [ ] 管理者のログインセッションは 8 時間で失効する

### 14.2 セキュリティ（§49 / §50 / §51 / §61）

- [ ] 一般ユーザーの管理 API は 403（`rbac.test.ts`）
- [ ] 管理者 API が secret（`password_hash` / TOTP secret / passkey 公開鍵 / `credential_id`）を**一切返さない**（`admin.test.ts`・★）
- [ ] 2FA 未設定の管理者は 403 `ADMIN_2FA_REQUIRED`（`admin.test.ts`）
- [ ] 再認証未了の管理 API は 401 `REAUTH_REQUIRED`（`admin.test.ts`）
- [ ] 一般ユーザーは監査ログを読めない（`audit-access.test.ts`・★）
- [ ] 監査ログは `admin_audit_logs` にのみ記録され、`security_events` と混ざらない（`audit-access.test.ts`）
- [ ] 自分自身の suspend / delete は 409（`admin.test.ts`）
- [ ] `requireRole` が request / headers を参照しない（静的検査）

### 14.3 品質ゲート（各 PR）

- [ ] `pnpm lint`（0 errors）
- [ ] `pnpm typecheck`
- [ ] `pnpm test`（既存＋Phase 7 の新規が green）
- [ ] `pnpm build`
- [ ] `pnpm db:verify-migrations`（0019 の up/down/往復）
- [ ] §20.3 の DoD チェックリスト（計画書）を全項目確認

---

## 15. リスクと対策

| # | リスク | 影響 | 確率 | 対策 |
|---|---|---|---|---|
| R1★ | 管理者 API が secret を返す | §51/§45 違反。重大 | 中 | `listAdminUsers` で**列を明示選択**。`admin.test.ts` で応答を固定（最初に書く） |
| R2★ | 一般ユーザーが監査ログを読める | §61 違反 | 中 | `requireAdminAccess` を全管理 API の先頭に。静的検査で `listAdminAuditLogs` の import 元を限定 |
| R3 | `sessionMaxAgeSeconds` の追加で既存セッションが壊れる | 手戻り | 低 | 既定値を従来どおりにし、既存呼び出しは無変更。`admin.test.ts` で 8h のみ検証 |
| R4 | `role_permissions` の複合主キーが drizzle で生成できない | migration 不一致 | 低 | `primaryKey({ columns: [...] })` を明示。`db:generate` の差分ゼロを確認 |
| R5 | suspend した管理者自身がロックアウト | 運用障害 | 中 | 自己操作を 409 で禁止（D-35-10） |
| R6 | 監査ログ記録の失敗で管理操作が失敗 | 可用性 | 低 | `recordAdminAudit` は失敗を握り、`logger.error` で検知 |
| R7 | 2FA 必須でテストの管理者が使えない | テストが書けない | 中 | テストヘルパーで TOTP 行を `enabled=true` で作る |
| R8 | レート制限キーの散在 | 保守性 | 低 | `rateLimitKeys.adminUser` に集約 |

---

## 16. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク | テスト |
|---|---|---|---|
| 認可はサーバー側 | §49 | P7-A-03, B-01〜B-06 | `rbac.test.ts` |
| 権限は role ベース・拡張可能 | §50 | P7-A-01, A-03 | `admin-policy.test.ts`, `schema.test.ts` |
| 管理者は 2FA 必須 | §51 | P7-A-03 | `admin.test.ts` |
| 管理者セッションは短命 | §51 | P7-C-01 | `admin.test.ts` |
| 管理操作は再認証 | §51 | P7-B-01〜B-06 | `admin.test.ts` |
| 管理画面は secret を表示しない | §51 | P7-B-01 | `admin.test.ts` |
| 監査ログは別テーブル・5 アクション | §61 | P7-A-04, B-01〜B-06 | `audit-access.test.ts` |
| 監査ログは一般ユーザーから閲覧不可 | §61 | P7-B-06 | `audit-access.test.ts` |
| secret を応答に出さない | §45 | P7-A-05, B-01 | `admin.test.ts` |
| 停止でセッション失効 | §23 | P7-B-02 | `admin.test.ts` |
| エラーは統一形式 | §58 | P7-A-02 | `errors.test.ts` |
| `role_permissions` は将来拡張 | §50 / D-19 | P7-A-01 | `schema.test.ts`, migration 検証 |

---

## 17. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-27 | 初版。`実装計画.md` §15 と仕様 §49 / §50 / §51 / §61 に基づき、DB・ガード・ポリシー・API・監査・テスト・工数を確定。D-35-01〜D-35-12 を新規採番。UI はスコープ外（§34 に管理画面が無い） |

---

## 18. 次フェーズへの引継ぎメモ

- **Phase 8（リスク検知）**: `security_events` の集計（`failed_logins`）を使う。監査ログ（`admin_audit_logs`）とは分離したまま。
- **Phase 8-B（テスト完成）**: 管理画面 UI を作る場合は Playwright で。API は本フェーズで完成済み。
- **Phase 9（運用）**: 監査ログの保持期間・アーカイブをランブックに追記する。`purge-expired` の対象にするかは運用判断（§61 に期間規定なし）。
- **`実装Todo.md`**: P7-01b〜P7-09 を本フェーズで完了に更新。`role_permissions` はテーブルのみ作成（判定は未使用）と注記。
- **`README.md` / `AGENTS.md`**: Phase 7 完了時に「現在の到達点」を M7 完了へ更新し、実装詳細節を追記する。
