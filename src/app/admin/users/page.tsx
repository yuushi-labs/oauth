import { requireAdminUser } from '@/app/admin/layout';
import { listAdminUsers } from '@/lib/db/queries/admin';
import { AdminUsersPanel } from '@/app/admin/users/admin-users-panel';
import type { Metadata } from 'next';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('admin.users') };

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * ユーザー管理（Phase 7.5 / §51）。
 *
 * 一覧は `listAdminUsers`（secret 列を選択しない）。権限変更・停止・失効・削除は
 * クライアントから管理 API を叩く。ここでは初期表示のデータだけを渡す。
 */
export default async function AdminUsersPage() {
  const { user } = await requireAdminUser();
  const { users, total } = await listAdminUsers({ limit: PAGE_SIZE, offset: 0 });

  return (
    <main id="main-content" className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">{m('admin.users')}</h1>
        <p className="mt-1 text-sm text-muted-fg">{m('admin.usersHint')}</p>
      </header>
      <AdminUsersPanel
        currentUserId={user.id}
        initialUsers={users.map((row) => ({
          id: row.id,
          username: row.username,
          email: row.email,
          email_verified: row.emailVerified,
          status: row.status,
          role_id: row.roleId,
          created_at: row.createdAt.toISOString(),
          has_password: row.hasPassword,
          has_2fa: row.has2fa,
          passkey_count: row.passkeyCount,
        }))}
        total={total}
      />
    </main>
  );
}
