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
  'email_verified',
  '2fa_enabled',
  '2fa_disabled',
  'passkey_added',
  'passkey_removed',
  'oauth_linked',
  'oauth_unlinked',
  'session_revoked',
  'account_deleted',
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

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type EmailChangeRequest = typeof emailChangeRequests.$inferSelect;
export type NewEmailChangeRequest = typeof emailChangeRequests.$inferInsert;
export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
export type RateLimitHit = typeof rateLimitHits.$inferSelect;
export type RateLimitReservation = typeof rateLimitReservations.$inferSelect;
