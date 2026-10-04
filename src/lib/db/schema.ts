import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;