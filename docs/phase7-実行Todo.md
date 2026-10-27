# Phase 7 実行 Todo — 管理者 / RBAC / 監査

> 計画: `docs/phase7-admin-rbac-audit-実装計画.md`（v1.0 / D-35-01〜D-35-12）
> 正本: `実装Todo.md` の P7 セクションを、実装単位まで展開した実行用チェックリスト
> 状態: **完了（2026-10-27）**
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**（R1 / R2 の対策）。

---

## 0. 事前準備

- [x] `pnpm install` が通ることを確認
- [x] `pnpm lint && pnpm typecheck && pnpm test` が green であることを確認（**Phase 7 着手前のベースライン**。Phase 6 完了状態 = 103 files / 707 tests）
- [x] `pnpm db:verify-migrations` が green（最新は `0018`）
- [x] `pnpm seed` 済み（`roles` に 4 行）
- [x] ブランチを切る（`feat/phase7-admin-rbac-audit`）
- [x] テスト用の「管理者（2FA 有効）」を作るヘルパーを用意できることを確認

---

## 1. P7-A: 基盤

### P7-A-01 — migration と schema（1.4h）

- [x] `drizzle/0019_admin_rbac_audit.sql` を作成（計画 §6.1 の SQL をそのまま）
- [x] `src/lib/db/schema.ts` に `ADMIN_AUDIT_ACTIONS` / `rolePermissions` / `adminAuditLogs` を追加（計画 §6.3）
- [x] `role_permissions` は `primaryKey({ columns: [table.roleId, table.permission] })` を**明示**
- [x] `src/lib/util/id.ts` の `ID_PREFIXES` に **`aud`** を追加（D-22）
- [x] `scripts/verify-migrations.ts` に期待値 5 件を追加（計画 §6.4）
- [x] `pnpm db:generate` を実行し、生成差分が無い（= 手書き SQL と一致する）ことを確認
- [x] `pnpm db:migrate` が通る
- [x] `pnpm db:verify-migrations` が green（up / down / 往復 / restore）
- [x] 完了条件: `pnpm db:verify-migrations` green

### P7-A-02 — エラーコード（0.4h）

- [x] `src/lib/errors.ts` の `ERROR_CODES` に `FORBIDDEN` / `ADMIN_2FA_REQUIRED` / `CANNOT_TARGET_SELF` / `ADMIN_NOT_FOUND` を追加
- [x] `ERROR_STATUS` に 403 / 403 / 409 / 404 を追加
- [x] `DEFAULT_MESSAGES` に日本語メッセージを追加
- [x] `src/messages/ja.ts` の `errors` に同じ 4 件を追加（`ERROR_CODES` と 1 対 1）
- [x] `src/test/unit/errors.test.ts` に status の検証を追加
- [x] 完了条件: `errors.test.ts` green

### P7-A-03★ — `admin-policy.ts`（1.2h）

- [x] `src/test/unit/admin-policy.test.ts` を**先に**書く
  - [ ] `roleRank` が user=0 / moderator=1 / admin=2 / superadmin=3、未知は -1
  - [ ] `isAdminRole` が admin / superadmin のみ true
  - [ ] `hasRoleAtLeast` の境界
  - [ ] `requireRole(user, 'admin')` が一般ユーザーで `FORBIDDEN` を throw
  - [ ] `requireAdminAccess` が 2FA 無効で `ADMIN_2FA_REQUIRED` を throw
  - [ ] `admin-policy.ts` が `request` / `headers` を受け取らない（引数に無い）
- [x] `src/lib/auth/admin-policy.ts` を実装（`roleRank` / `isAdminRole` / `hasRoleAtLeast` / `requireRole` / `requireAdminAccess`）
- [x] 完了条件: `admin-policy.test.ts` green

### P7-A-04 — `audit.ts`（1.0h）

- [x] `src/test/unit/audit.test.ts` を**先に**書く
  - [ ] `recordAdminAudit` が `aud_` prefix の ID を作る
  - [ ] `ipMasked` が mask される
  - [ ] metadata は許可キー（`count` / `reason` / `status` / `sessions`）のみ保存
  - [ ] DB 例外を握って throw しない（`logger.error` は呼ぶ）
- [x] `src/lib/auth/audit.ts` を実装
- [x] 完了条件: `audit.test.ts` green

### P7-A-05 — クエリ層（1.4h）

- [x] `src/test/integration/admin-queries.test.ts` を**先に**書く（実 DB）
  - [ ] `listAdminUsers` の select に `password_hash` / `secret_encrypted` / `public_key` / `credential_id` が**含まれない**
  - [ ] `has_password` / `has_2fa` / `passkey_count` が正しい
  - [ ] `total` が一致する
  - [ ] `findAdminTarget` が論理削除済みを返さない
  - [ ] `suspendUser` / `unsuspendUser`（email 未確認は `pending_email` に戻る）
  - [ ] `listAdminAuditLogs` が `admin_audit_logs` のみを返す
- [x] `src/lib/db/queries/admin.ts` を実装
- [x] `src/lib/db/queries/audit-logs.ts` を実装
- [x] 完了条件: `admin-queries.test.ts` green

### P7-A-06 — 検証とレート制限（0.6h）

- [x] `src/lib/validate/admin.ts`（`listQuerySchema` / `targetIdParamSchema`）
- [x] `src/config/rate-limits.ts` に `admin.read` / `admin.mutation` を追加
- [x] `src/lib/auth/rate-limit-keys.ts` に `adminUser(userId)` を追加
- [x] 完了条件: `pnpm typecheck` が通る

---

## 2. P7-B: API

すべて `withAuthPipeline(request, { requireAuth: true, requireReauth: true }, ...)` ＋ 先頭で `requireAdminAccess(user)`。

### P7-B-01★ — `GET /api/admin/users`（1.8h）

- [x] `src/test/security/admin.test.ts` を**先に**書く（一覧部分）
  - [ ] 管理者（2FA 有効・再認証済み）で 200
  - [ ] 応答に `password_hash` / TOTP secret / `public_key` / `credential_id` が**現れない**（★）
  - [ ] 一般ユーザーで 403
  - [ ] 2FA 未設定の管理者で 403 `ADMIN_2FA_REQUIRED`
  - [ ] 再認証未了で 401 `REAUTH_REQUIRED`
  - [ ] `admin_user_viewed` が `admin_audit_logs` に入る
- [x] `src/app/api/admin/users/route.ts` を実装
- [x] 完了条件: `admin.test.ts`（一覧）green

### P7-B-02 — `POST .../suspend`（1.4h）

- [x] テストを**先に**書く（停止部分）
  - [ ] 停止で `status='suspended'`
  - [ ] 対象の全セッションが失効（以後 401）
  - [ ] `admin_user_suspended` が記録される
  - [ ] 自分自身で 409 `CANNOT_TARGET_SELF`
  - [ ] 存在しない ID で 404 `ADMIN_NOT_FOUND`
- [x] `src/app/api/admin/users/[id]/suspend/route.ts` を実装
- [x] 完了条件: green

### P7-B-03 — `POST .../unsuspend`（0.8h）

- [x] テストを**先に**書く
- [x] `src/app/api/admin/users/[id]/unsuspend/route.ts` を実装
- [x] 完了条件: green

### P7-B-04 — `POST .../sessions/revoke`（0.8h）

- [x] テストを**先に**書く（`admin_session_revoked` が入る）
- [x] `src/app/api/admin/users/[id]/sessions/revoke/route.ts` を実装
- [x] 完了条件: green

### P7-B-05 — `POST .../delete`（1.3h）

- [x] テストを**先に**書く
  - [ ] 論理削除（`status='deleted'` / `deleted_at`）
  - [ ] 全セッション失効 ＋ トークン失効 ＋ OIDC grant 失効
  - [ ] `admin_account_deleted` が記録される
  - [ ] 自分自身で 409
- [x] `src/app/api/admin/users/[id]/delete/route.ts` を実装
- [x] 完了条件: green

### P7-B-06★ — `GET /api/admin/audit-logs`（1.4h）

- [x] `src/test/security/audit-access.test.ts` を**先に**書く
  - [ ] 管理者で 200・`admin_audit_logs` のみ
  - [ ] 一般ユーザーで 403（★）
  - [ ] 応答に secret が現れない
  - [ ] `listAdminAuditLogs` が管理 API 以外から import されていない（静的検査）
- [x] `src/app/api/admin/audit-logs/route.ts` を実装
- [x] 完了条件: `audit-access.test.ts` green

---

## 3. P7-C: ポリシーとテスト

### P7-C-01 — 管理者の 8h セッション（1.2h）

- [x] `src/lib/auth/session.ts` の `createSession` / `createSessionInternal` に `sessionMaxAgeSeconds` オプション（既定 30 日）
- [x] `src/app/api/auth/login/route.ts` で role が admin 以上なら 8 時間で発行
- [x] テスト（`admin.test.ts`）: 管理者ログインの `expires_at` が約 8 時間後
- [x] 完了条件: green（既存の一般ユーザーのセッションは 30 日のまま）

### P7-C-02★ — `rbac.test.ts`（1.0h）

- [x] 一般ユーザーの管理 API 5 本がすべて 403
- [x] 管理者で 200 / 204 相当
- [x] `requireRole` が request / headers を参照しない（静的検査）
- [x] 完了条件: green（DoD 直結）

### P7-C-03★ — `audit-access.test.ts` の遮断検査（1.0h）

- [x] 5 アクションが `admin_audit_logs` に入る（suspend / unsuspend / sessions revoke / delete / view）
- [x] `security_events` と混ざらない
- [x] 一般ユーザーは読めない
- [x] 完了条件: green（DoD 直結）

### P7-C-04 — 既存テストへの追記（0.8h）

- [x] `roles.test.ts` / `errors.test.ts` / `schema.test.ts` / `rate-limit.test.ts`
- [x] 完了条件: `pnpm test` 全体 green

---

## 4. 品質ゲート

- [x] `pnpm lint`（0 errors）
- [x] `pnpm typecheck`
- [x] `pnpm test`（全 green）
- [x] `pnpm build`
- [x] `pnpm db:verify-migrations`（0019 の up/down/往復）
- [x] §20.3 DoD チェックリスト（計画書）
  - [ ] 新規 API が `withAuthPipeline` / レート制限 / `require*` ガードを通っているか
  - [ ] secret がログ・応答・metadata に漏れていないか（§45）
  - [ ] 認可をサーバー側で行っているか（§49）
  - [ ] `security_events` / `admin_audit_logs` へ記録しているか
  - [ ] 新テーブル/列に制約・index・migration があるか
  - [ ] mutation が POST/PUT/PATCH/DELETE か（§25）
  - [ ] エラーが統一形式（§58）か

---

## 5. ドキュメント更新

- [x] `実装Todo.md` の P7-01b〜P7-09 を完了に更新（`role_permissions` はテーブルのみ・判定は未使用と注記）
- [x] `AGENTS.md` の到達点を M7 完了へ更新（次は Phase 8）
- [x] `README.md` の実装状況表と Phase 7 実装詳細節を追記
