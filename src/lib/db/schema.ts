import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  bigint,
  uuid,
} from 'drizzle-orm/pg-core';

export const USER_STATUSES = ['pending_email', 'active', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_IDS = {
  user: 'role_user',
  moderator: 'role_moderator',
  admin: 'role_admin',
  superadmin: 'role_superadmin',
} as const;

export const DEFAULT_ROLE_ID = ROLE_IDS.user;

export const ROLE_SEED: ReadonlyArray<{ id: string; name: string; description: string }> = [
  { id: ROLE_IDS.user, name: 'user', description: '一般ユーザー' },
  { id: ROLE_IDS.moderator, name: 'moderator', description: 'モデレーター（将来拡張）' },
  { id: ROLE_IDS.admin, name: 'admin', description: '管理者' },
  { id: ROLE_IDS.superadmin, name: 'superadmin', description: '最上位管理者（将来拡張）' },
];

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    status: text('status').notNull().default('pending_email'),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // 通常 UNIQUE は付けない。論理削除済み email / username の再利用を妨げるため（D-04）
    uniqueIndex('users_username_lower_uniq')
      .on(sql`lower(${table.username})`)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('users_email_lower_uniq')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} is null`),
    check('users_status_chk', sql`${table.status} in ('pending_email', 'active', 'suspended', 'deleted')`),
    check(
      'users_status_email_verified_chk',
      sql`${table.status} <> 'active' or ${table.emailVerified} = true`,
    ),
    index('users_role_id_idx').on(table.roleId),
    index('users_deleted_at_idx').on(table.deletedAt),
  ],
);

/** セッション無効化理由（§7.4） */
export const REVOKE_REASONS = [
  'logout',
  'logout_all',
  'password_change',
  'password_reset',
  'admin',
  'account_delete',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionHash: text('session_hash').notNull(),
    csrfSecret: text('csrf_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: text('replaced_by'),
    revokeReason: text('revoke_reason'),
    ipHash: text('ip_hash'),
    ipMasked: text('ip_masked'),
    userAgent: text('user_agent').notNull(),
    deviceName: text('device_name'),
    ipCountry: text('ip_country'),
    reauthVerifiedAt: timestamp('reauth_verified_at', { withTimezone: true }),
    totpPending: boolean('totp_pending').notNull().default(false),
    passkeyPending: text('passkey_pending'),
  },
  (table) => [
    uniqueIndex('sessions_session_hash_uniq').on(table.sessionHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
    index('sessions_revoked_at_idx').on(table.revokedAt),
  ],
);

export const SOCIAL_PROVIDERS = ['google', 'github', 'discord'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

const SOCIAL_PROVIDER_SQL_LIST = sql.raw(
  SOCIAL_PROVIDERS.map((provider) => `'${provider}'::text`).join(', '),
);

/**
 * 外部 ID との紐付け（§10 / §11）。
 *
 * - `UNIQUE (provider, provider_account_id)` は**論理削除後も保持**する。ユーザー削除は
 *   `users.deleted_at` による論理削除なので `ON DELETE CASCADE` は発火せず、保持期間中は
 *   同じ外部 ID の再登録を拒否し続ける（D-31-09）。解放は users のパージ時。
 * - refresh token 列は**持たない**（D-06: refresh token を求めない・保存しない）。
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** provider ごとに独立した外部 ID。数値 ID も文字列で保存する（D-31-10）。 */
    providerAccountId: text('provider_account_id').notNull(),
    /** リンク時点の email。新規登録可否の判断材料（自動統合には使わない・§11）。 */
    providerEmail: text('provider_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('accounts_provider_chk', sql`${table.provider} in (${SOCIAL_PROVIDER_SQL_LIST})`),
    uniqueIndex('accounts_provider_account_uniq').on(table.provider, table.providerAccountId),
    index('accounts_user_id_idx').on(table.userId),
  ],
);

export const OAUTH_INTENTS = ['login', 'link'] as const;
export type OAuthIntentValue = (typeof OAUTH_INTENTS)[number];

/**
 * ソーシャル連携の確認待ち（Phase 4-B / D-32-05）。
 *
 * callback の時点で「紐付きが無い」と分かったとき、完了に必要な情報を保持する。
 * 利用者はここで「新規登録する」または「パスワードでログインして連携する」を選ぶ。
 *
 * - **生の token は保存しない**。Cookie に生 token、DB には SHA-256 だけ入れる。
 * - **消費は UPDATE**（`consumed_at IS NULL` を条件に含める）。使い切りになる。
 * - `email_owner_id` は**発行時点で確定**する。完了時に email を引き直すと、
 *   発行と完了の間に所有者が変わった場合に判定が揺れる（D-32-07）。
 * - URL には載せない。Cookie で運ぶので Referer や履歴から漏れない（D-32-05）。
 */
export const oauthSocialClaims = pgTable(
  'oauth_social_claims',
  {
    stateHash: text('state_hash').primaryKey(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    providerEmail: text('provider_email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** この email を持つ既存ユーザー。該当なしは NULL（= 新規登録できる） */
    emailOwnerId: text('email_owner_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    check('oauth_social_claims_provider_chk', sql`${table.provider} in (${SOCIAL_PROVIDER_SQL_LIST})`),
    index('oauth_social_claims_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * OAuth 認可リクエストの状態（§12.2 / D-31-05）。
 *
 * - **生の state は保存しない**。SHA-256 だけ stored し、`consumeOAuthState` で引く。
 * - **消費は UPDATE で行う**（`consumed_at IS NULL` を条件に含める）。2 回目以降は 0 行更新に
 *   なるので、認可コードの再利用（replay）は DB 側で 1 回限りとして強制される。
 * - `code_verifier` は平文。TTL 10 分・1 回限りの使い捨てで、同じ時点の `code` も失効済み
 *   なので、DB 侵害時に両方を揃えてもフロー完了には到達できない。暗号化の余地は Phase 5 の鍵に残す。
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    provider: text('provider').notNull(),
    intent: text('intent').notNull().default('login'),
    /** link のときだけ入る。callback で現セッションの user と照合する（D-31-15）。 */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    /** 同一オリジンの相対パスのみ。絶対 URL は保存前に null へ落とす（open redirect 対策）。 */
    redirectTo: text('redirect_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    check('oauth_states_provider_chk', sql`${table.provider} in (${SOCIAL_PROVIDER_SQL_LIST})`),
    check('oauth_states_intent_chk', sql`${table.intent} in ('login', 'link')`),
    index('oauth_states_expires_at_idx').on(table.expiresAt),
    index('oauth_states_user_id_idx').on(table.userId),
  ],
);

export const TOKEN_PURPOSES = [
  'email_verification',
  'password_reset',
  'email_change',
] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('email_verification_tokens_user_id_idx').on(table.userId),
    index('email_verification_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_tokens_user_id_idx').on(table.userId),
    index('password_reset_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export const emailChangeRequests = pgTable(
  'email_change_requests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    newEmail: text('new_email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    oldEmailNotifiedAt: timestamp('old_email_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('email_change_requests_user_id_idx').on(table.userId),
    index('email_change_requests_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * セルフサービス退会のメール確認待ち（§24）。
 *
 * `/settings/account` の削除フローは、2FA / Passkey / メール確認のいずれか 1 つで
 * 本人確認する。メール確認を選んだ場合はこの行にトークンを発行し、メール内リンクの
 * 消費（`used_at` を 1 文 UPDATE で埋める・D-16）をもって削除を確定する。
 * 未消費の行は削除要求をやり直すたびに無効化する（`invalidateAccountDeletionRequests`）。
 */
export const accountDeletionRequests = pgTable(
  'account_deletion_requests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_deletion_requests_user_id_idx').on(table.userId),
    index('account_deletion_requests_expires_at_idx').on(table.expiresAt),
  ],
);

export const SECURITY_EVENT_TYPES = [
  'register',
  'login_success',
  'login_failed',
  'logout',
  'password_changed',
  'password_reset',
  'email_changed',
  'email_change_notification_failed',
  'security_notification_failed',
  'new_device_login',
  'login_risk',
  'email_verified',
  '2fa_enabled',
  '2fa_disabled',
  'passkey_added',
  'passkey_removed',
  'oauth_linked',
  'oauth_unlinked',
  'session_revoked',
  'account_deleted',
  'account_deletion_requested',
  'account_suspended',
  'account_unsuspended',
  'role_changed',
  'breach_check_fail_open',
  'rate_limited',
  'captcha_challenged',
  'oidc_authorize_denied',
  'oidc_consent_granted',
  'oidc_consent_denied',
  'oidc_client_registered',
  'oidc_client_revoked',
  'oidc_client_secret_rotated',
  'oidc_client_updated',
  'oidc_grant_revoked',
  'oidc_token_revoked',
  'oidc_token_failed',
  'oidc_account_blocked',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export const securityEvents = pgTable(
  'security_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    ip: text('ip'),
    ipMasked: text('ip_masked'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('security_events_event_type_created_at_idx').on(table.eventType, table.createdAt),
    index('security_events_user_id_created_at_idx').on(table.userId, table.createdAt),
  ],
);

/** ユーザー設定（§40 テーマ / §60 タイムゾーン）。行が無い場合は既定値を使う。 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: text('theme').notNull().default('system'),
    language: text('language').notNull().default('ja'),
    // 既定は Asia/Tokyo（§60 の例に合わせる。想定利用者は日本）。
    timezone: text('timezone').notNull().default('Asia/Tokyo'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_preferences_theme_chk', sql`${table.theme} in ('system', 'light', 'dark')`),
  ],
);

export const rateLimitHits = pgTable(
  'rate_limit_hits',
  {
    key: text('key').primaryKey(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    failedCount: integer('failed_count').notNull().default(0),
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rate_limit_hits_window_expires_at_idx').on(table.windowExpiresAt)],
);

export const rateLimitReservations = pgTable(
  'rate_limit_reservations',
  {
    reservationId: uuid('reservation_id').primaryKey().defaultRandom(),
    key: text('key').notNull().references(() => rateLimitHits.key, { onDelete: 'cascade' }),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    index('rate_limit_reservations_key_generation_idx').on(table.key, table.generation),
    index('rate_limit_reservations_expires_at_idx').on(table.expiresAt),
  ],
);

export const OIDC_SCOPES = ['openid', 'profile', 'email'] as const;
export type OidcScope = (typeof OIDC_SCOPES)[number];
export const OIDC_CLIENT_TYPES = ['public', 'confidential'] as const;
export type OidcClientType = (typeof OIDC_CLIENT_TYPES)[number];

const OIDC_SCOPE_SQL_LIST = sql.raw(OIDC_SCOPES.map((scope) => `'${scope}'::text`).join(', '));
const OIDC_CLIENT_TYPE_SQL_LIST = sql.raw(OIDC_CLIENT_TYPES.map((type) => `'${type}'::text`).join(', '));

export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    name: text('name').notNull(),
    operator: text('operator').notNull().default(''),
    clientType: text('client_type').notNull(),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    allowedScopes: text('allowed_scopes').array().notNull().default(sql`ARRAY['openid']::text[]`),
    webOrigins: text('web_origins').array().notNull().default(sql`ARRAY[]::text[]`),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull(),
    secretHash: text('secret_hash'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('oauth_clients_active_idx').on(table.active),
    index('oauth_clients_owner_user_id_idx').on(table.ownerUserId),
    check('oauth_clients_type_chk', sql`${table.clientType} in (${OIDC_CLIENT_TYPE_SQL_LIST})`),
    check('oauth_clients_openid_required_chk', sql`'openid' = ANY(${table.allowedScopes})`),
    check('oauth_clients_scope_allowlist_chk', sql`${table.allowedScopes} <@ ARRAY[${OIDC_SCOPE_SQL_LIST}]::text[]`),
    check(
      'oauth_clients_secret_type_chk',
      sql`(${table.clientType} = 'public' AND ${table.secretHash} IS NULL AND ${table.tokenEndpointAuthMethod} = 'none') OR (${table.clientType} = 'confidential' AND ${table.secretHash} IS NOT NULL AND ${table.tokenEndpointAuthMethod} = 'client_secret_basic')`,
    ),
    check('oauth_clients_active_revoked_chk', sql`NOT ${table.active} OR ${table.revokedAt} IS NULL`),
  ],
);

export const oidcArtifacts = pgTable(
  'oidc_artifacts',
  {
    model: text('model').notNull(),
    idHash: text('id_hash').notNull(),
    grantIdHash: text('grant_id_hash'),
    uidHash: text('uid_hash'),
    userCodeHash: text('user_code_hash'),
    payloadCiphertext: text('payload_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.idHash], name: 'oidc_artifacts_pk' }),
    index('oidc_artifacts_expiry_idx').on(table.expiresAt),
    index('oidc_artifacts_grant_idx').on(table.model, table.grantIdHash),
    index('oidc_artifacts_uid_idx').on(table.model, table.uidHash),
    index('oidc_artifacts_user_code_idx').on(table.model, table.userCodeHash),
  ],
);

export const oidcUserGrants = pgTable(
  'oidc_user_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('oidc_user_grants_user_client_uniq').on(table.userId, table.clientId),
    index('oidc_user_grants_user_idx').on(table.userId, table.revokedAt),
  ],
);

export const oidcUserSubjects = pgTable(
  'oidc_user_subjects',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    subject: text('subject').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId], name: 'oidc_user_subjects_pk' }),
  ],
);

export const totp = pgTable('totp', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text('secret_encrypted').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  lastUsedCounter: bigint('last_used_counter', { mode: 'number' }).default(-1).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recovery_codes_code_hash_uniq').on(table.codeHash),
    index('recovery_codes_user_id_idx').on(table.userId),
  ],
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type OAuthState = typeof oauthStates.$inferSelect;
export type NewOAuthState = typeof oauthStates.$inferInsert;
export type OAuthSocialClaim = typeof oauthSocialClaims.$inferSelect;
export type NewOAuthSocialClaim = typeof oauthSocialClaims.$inferInsert;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type EmailChangeRequest = typeof emailChangeRequests.$inferSelect;
export type NewEmailChangeRequest = typeof emailChangeRequests.$inferInsert;
export type AccountDeletionRequest = typeof accountDeletionRequests.$inferSelect;
export type NewAccountDeletionRequest = typeof accountDeletionRequests.$inferInsert;
export type SecurityEvent = typeof securityEvents.$inferSelect;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
export type RateLimitHit = typeof rateLimitHits.$inferSelect;
export type RateLimitReservation = typeof rateLimitReservations.$inferSelect;
export type Totp = typeof totp.$inferSelect;
export type NewTotp = typeof totp.$inferInsert;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type NewRecoveryCode = typeof recoveryCodes.$inferInsert;

/**
 * Passkey（WebAuthn credential）。公開鍵のみを保存し、秘密鍵は端末から出ない（§12）。
 * `id` は内部 ID（`wac_` + ULID）で、外部由来の `credential_id` を URL に出さないため分けている。
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).default(0).notNull(),
    transports: jsonb('transports').$type<string[]>(),
    aaguid: text('aaguid'),
    deviceName: text('device_name'),
    backedUp: boolean('backed_up').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webauthn_credentials_credential_id_uniq').on(table.credentialId),
    index('webauthn_credentials_user_id_idx').on(table.userId),
  ],
);

/** WebAuthn の challenge（登録・認証）。TTL 5 分・1 回限り消費（D-34-05）。 */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('webauthn_challenges_expires_at_idx').on(table.expiresAt),
    index('webauthn_challenges_user_id_idx').on(table.userId),
  ],
);

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
export type NewWebauthnChallenge = typeof webauthnChallenges.$inferInsert;

/** 管理者の監査ログで記録するアクション（§61・D-35-07）。 */
export const ADMIN_AUDIT_ACTIONS = [
  'admin_user_viewed',
  'admin_user_suspended',
  'admin_user_unsuspended',
  'admin_session_revoked',
  'admin_account_deleted',
  'admin_role_changed',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/**
 * role → permission の対応（§50）。**MVP では使用しない**（将来拡張用・D-19）。
 * 権限判定は `admin-policy.ts` の role rank で行う。
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

/**
 * 管理者操作の監査ログ（§61）。通常の `security_events` とは**別テーブル**で、
 * 一般ユーザーからは閲覧できない（D-35-07）。追記のみ（更新・削除の API を作らない）。
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: text('id').primaryKey(),
    // 保持期間経過後にユーザーを物理削除すると FK が切れるため、actor/target の
    // 表示名を追記時にスナップショットする（監査証跡を残す・D-35-08 の緩和）。
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorUsername: text('actor_username'),
    action: text('action').notNull(),
    targetUserId: text('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetUsername: text('target_username'),
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

export type RolePermission = typeof rolePermissions.$inferSelect;
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLogs.$inferInsert;
