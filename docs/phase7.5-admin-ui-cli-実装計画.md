# Phase 7.5 実装計画 — 管理者の付与（管理者用 UI ＋ CLI）

> 対象: Phase 7（管理者 / RBAC / 監査）の運用ギャップを埋める追加フェーズ
> 前提工程: Phase 7（M7 管理者 / RBAC / 監査）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-27
> 状態: **実装着手**

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | 「誰を管理者にするか」を決める手段が無い問題を解消する。**管理者用 UI**（`/admin/users`）と **CLI**（`pnpm admin:grant`）の 2 経路で、既存ユーザーへ role を付与・変更できるようにする |
| なぜやる | Phase 7 は「管理者に何を要求するか」（2FA 必須・8h セッション・再認証・監査ログ）を実装したが、**role を付与する経路が DB 直接 UPDATE しか無い**。運用不能（§51 に任命手順の規定が無い） |
| 工数 | 約 8 時間 |
| 追加依存 | **無し** |
| migration | **不要**。`admin_audit_logs.action` / `security_events.event_type` は CHECK 無しの text。`users.role_id` は FK + index 済み |
| 新規ファイル | 計画 1 / ライブラリ 1 / API 1 / 画面 4 / CLI 1 / テスト 3 → §6 |
| 既存仕様の変更 | `AdminAuditAction` に 1 種、`SecurityEventType` に 1 種、`ERROR_CODES` に 1 種、`messages.ui` に管理者 UI 文言を追加。`SettingsNav` に管理者のみ表示のリンクを 1 本追加 |
| 最大リスク | **最後の管理者を降格させてロックアウトする**こと（§51）。自己降格禁止 ＋ 最後の管理者ガードで二重に防ぐ（D-36-02 / D-36-03） |

---

## 1. 背景

Phase 7 完了時点（`docs/phase-verification-report-2026-10-26.md`）で、以下が判明した。

- `users.role_id` を `role_admin` に**昇格させるコードパスが存在しない**。
  - 登録（`/api/auth/register`）とソーシャル初回（`complete-login.ts`）は `role_user` 固定。
  - `pnpm seed` は `roles` の 4 行を入れるだけで、ユーザーには付与しない。
  - 管理 API 5 本は role を変更しない。
- 仕様 §51 は「管理者に何を要求するか」のみ規定し、**任命手順を規定していない**。
- `実装計画.md` §7.2 は「MVP で使う role は user と admin の 2 種のみ」とするが、付与の運用は Phase 7 のスコープ外だった。

結果、管理者を作るには `UPDATE users SET role_id='role_admin' WHERE ...` を手で流すしかなく、監査ログも残らない。

---

## 2. スコープ

**やること**

1. `POST /api/admin/users/{id}/role` — 管理者が他ユーザーの role を変更する（API）。
2. `pnpm admin:grant <email|username> [--role <role>] [--actor <email|id>]` — CLI で付与する（初回 bootstrap 用）。
3. `/admin/users` — 管理者用 UI。ユーザー一覧 ＋ role 変更 ＋ 停止/解除 ＋ セッション失効 ＋ 論理削除。
4. `/admin/audit-logs` — 管理者用 UI。監査ログ閲覧（読み取り専用）。
5. `SettingsNav` に「管理」リンク（role ≥ admin のときだけ表示）。
6. 監査: 新アクション `admin_role_changed`、新イベント `admin_role_changed`。

**やらないこと**

- `role_permissions`（権限テーブル）の有効化。将来拡張のまま（D-19）。
- `superadmin` 固有の UI / API 制御。rank 3 は rank 比較で既に扱える。
- 管理画面からの「パスワード / TOTP secret の閲覧」（§51 で禁止）。

---

## 3. 決定事項（D-36-01 〜 D-36-08）

| # | 決定 | 理由 |
|---|---|---|
| D-36-01 | **API で付与できるのは rank ≤ `admin`（=2）まで**。`superadmin` は API では付与不可（CLI のみ） | `superadmin` は「将来拡張」の定義のみ（§50）。API 経由の権限昇格先を `admin` に閉じ、`superadmin` の扱いは運用判断に残す |
| D-36-02 | **自分自身の role は変更できない**。対象＝自分は 409 `CANNOT_TARGET_SELF`（既存コードを再利用） | 自己降格によるロックアウト防止。既存 `resolveAdminTarget` が既に保証する |
| D-36-03 | **最後の有効な管理者を降格できない** → 409 `LAST_ADMIN`（新コード） | 「有効な管理者」= `deleted_at IS NULL` かつ `status='active'` かつ rank ≥ admin。CLI の誤操作で管理者が 0 人になるのを防ぐ |
| D-36-04 | role 変更時に**セッションを失効させない** | 認可は全リクエストで `findUserById` を引き直す（`pipeline.ts:103`）。role 変更は次リクエストから即時反映されるため失効不要。失効させると昇格直後の管理者がログアウトされ UX を損なう |
| D-36-05 | 監査は `admin_audit_logs`（API）＋ `security_events`（API/CLI 共通）。CLI は `--actor` がある時だけ `admin_audit_logs` にも記録 | `admin_audit_logs.actor_user_id` は NOT NULL（D-35-08）。初回 bootstrap には actor が存在しないため、CLI は actor 任意・イベントは必須とする |
| D-36-06 | CLI は trusted operator として動く（`requireRole` を通らない）。`--role` は 4 種すべて許可 | CLI は DB 直アクセス権を持つ運用者専用。API の制約（D-36-01）と分ける |
| D-36-07 | 管理 UI の入口は `/admin/*`。`SettingsNav` には**role ≥ admin のときだけ**リンクを出す。認可はサーバー側（§49）で再判定する | フロントの表示制御は UX。認可は必ずサーバー側 |
| D-36-08 | 管理 UI の 2FA 未設定時は「有効化を促す案内」を出す（403 の連発にしない） | §51。`requireAdminAccess` と同じ判定をサーバー側で行い、UI で先回りする |

---

## 4. API 契約

### 4.1 `POST /api/admin/users/{id}/role`

| 項目 | 内容 |
|---|---|
| 認証 | `withAdminPipeline(request, 'mutation')`（再認証必須・role ≥ admin ＋ 2FA 有効） |
| body | `{ "role_id": "role_user" \| "role_moderator" \| "role_admin" }` |
| 200 | `{ success: true, data: { user: { id, role_id } } }` |
| 400 | `VALIDATION_ERROR`（未知の role / `role_superadmin`） |
| 403 | `FORBIDDEN` / `ADMIN_2FA_REQUIRED` |
| 404 | `ADMIN_NOT_FOUND`（不正形式・不存在・論理削除済み） |
| 409 | `CANNOT_TARGET_SELF`（自分自身） |
| 409 | `LAST_ADMIN`（最後の有効な管理者の降格） |
| 副作用 | `admin_audit_logs`（`admin_role_changed`, metadata `{ status: 新role, previous_role: 旧role }`）＋ `security_events`（`admin_role_changed`, user_id=対象） |

---

## 5. 変更点の詳細

### 5.1 `src/lib/auth/admin-role.ts`（新規）

```
ASSIGNABLE_ROLE_IDS = ['role_user','role_moderator','role_admin']   // API 用（D-36-01）
isAssignableRole(roleId, maxRank)                                    // rank で判定
countOtherUsableAdmins(excludeUserId)                                // D-36-03 の「有効な管理者」
changeUserRole({ target, newRoleId, maxRank, actorUserId })          // 検証 → 最後の管理者ガード → UPDATE
```

`changeUserRole` は `ApiError('LAST_ADMIN')` を投げる。route / CLI の双方が同じガードを通る。

### 5.2 エラーコード

`LAST_ADMIN`（409・「最後の管理者は降格できません。」）を `ERROR_CODES` / `ERROR_STATUS` / `DEFAULT_MESSAGES` / `messages.errors` の 4 か所に追加（AGENTS.md の規約）。

### 5.3 監査アクション / イベント

- `ADMIN_AUDIT_ACTIONS` に `admin_role_changed` を追加（5 → 6）。
- `SECURITY_EVENT_TYPES` に `admin_role_changed` を追加。
- `messages.ui.security.eventLabels` に `admin_role_changed` のラベルを追加。
- `ALLOWED_METADATA_KEYS` に `role` / `previous_role` を追加（`role` は secret ではない）。

### 5.4 CLI `scripts/admin-grant.ts`

```
pnpm admin:grant <email|username> [--role user|moderator|admin|superadmin] [--actor <email|id>]
```

- 対象は `findUserByEmailOrUsername`。論理削除済みはエラー。
- `--role` 既定 `admin`。
- `--actor` があれば実在の管理者（rank ≥ admin）であることを確認し、`admin_audit_logs` に記録。
- 無ければ `security_events` にのみ記録し、その旨を警告表示（bootstrap）。
- 最後の管理者ガードを通す（D-36-03）。
- 成功時は `email / username / 旧role → 新role` を表示。

### 5.5 管理 UI

- `src/app/admin/layout.tsx` — `requireAdminUser()` で guard。2FA 未設定なら案内のみ。
- `src/app/admin/users/page.tsx` ＋ `admin-users-panel.tsx`（client）— 一覧・role 変更・停止/解除・セッション失効・論理削除。`REAUTH_REQUIRED` で `ReauthDialog`。
- `src/app/admin/audit-logs/page.tsx` — 監査ログの読み取り専用テーブル。
- `src/app/settings/settings-nav.tsx` — `isAdmin` prop が真のときだけ `/admin/users` リンクを追加。

---

## 6. ファイル一覧

| 種別 | パス |
|---|---|
| 計画 | `docs/phase7.5-admin-ui-cli-実装計画.md`（本書） |
| ライブラリ | `src/lib/auth/admin-role.ts` |
| 検証 | `src/lib/validate/admin.ts`（追記） |
| クエリ | `src/lib/db/queries/admin.ts`（追記: `setUserRole` / `countOtherUsableAdmins`） |
| API | `src/app/api/admin/users/[id]/role/route.ts` |
| CLI | `scripts/admin-grant.ts`（＋ `package.json` の `admin:grant`） |
| 画面 | `src/app/admin/layout.tsx` / `src/app/admin/users/page.tsx` / `src/app/admin/users/admin-users-panel.tsx` / `src/app/admin/audit-logs/page.tsx` |
| テスト | `src/test/security/admin-role.test.ts` / `src/test/integration/admin-role-cli.test.ts` / `src/test/unit/admin-role.test.ts` |

---

## 7. テスト方針

| 対象 | 検証 |
|---|---|
| API 認可 | 一般ユーザー 403 / 2FA 未設定 403 / 再認証切れ 401 |
| API 正常 | role 変更が DB に反映、監査ログとイベントが記録される |
| API 異常 | 未知 role 400 / `role_superadmin` 400 / 自分自身 409 / 不存在 404 |
| 最後の管理者 | 唯一の管理者の降格が 409 `LAST_ADMIN` |
| CLI | 既存ユーザーの昇格、`--role user` の降格、`--actor` の監査記録、最後の管理者ガード |
| 静的 | 管理 UI / API が secret 列を返さない |

---

## 8. 完了定義（DoD）

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` green
- [ ] CLI で既存ユーザーを管理者にできる（手動確認）
- [ ] 管理 UI から role を変更でき、一般ユーザーはアクセスできない
- [ ] 最後の管理者を降格できない
- [ ] 監査ログに `admin_role_changed` が残る
