import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
    count: integer('count').notNull(),
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rate_limit_hits_window_expires_at_idx').on(table.windowExpiresAt)],
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