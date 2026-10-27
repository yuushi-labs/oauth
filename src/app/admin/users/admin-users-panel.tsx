'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { formatLocalDateTime } from '@/lib/util/datetime';
import { m, messages } from '@/messages/ja';

export type AdminUserRow = {
  id: string;
  username: string;
  email: string;
  email_verified: boolean;
  status: string;
  role_id: string;
  created_at: string;
  has_password: boolean;
  has_2fa: boolean;
  passkey_count: number;
};

type PendingAction = { kind: 'role'; roleId: string } | { kind: 'suspend' | 'unsuspend' | 'revoke' | 'delete' };

const ROLE_LABELS = messages.ui.admin.roleLabels;

/** API から付与できる role（rank ≤ admin・D-36-01）。`superadmin` は CLI 専用。 */
const ASSIGNABLE_ROLES = ['role_user', 'role_moderator', 'role_admin'];

/**
 * ユーザー管理パネル（Phase 7.5）。
 *
 * 権限変更・停止・解除・セッション失効・論理削除を管理 API 経由で行う。
 * いずれも再認証が要るので、`REAUTH_REQUIRED` を受けたら `ReauthDialog` を開いて再試行する。
 * 自分自身の行はサーバ側で 409 になるため、ボタンを無効化して先回りする（D-36-02）。
 */
export function AdminUsersPanel({
  currentUserId,
  initialUsers,
  total,
}: {
  currentUserId: string;
  initialUsers: AdminUserRow[];
  total: number;
}) {
  const [rows, setRows] = React.useState(initialUsers);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<{ userId: string; action: PendingAction } | null>(null);

  async function refresh() {
    const data = await apiClient.get<{ users: AdminUserRow[]; total: number }>('/api/admin/users');
    setRows(data.users);
  }

  async function run(userId: string, action: PendingAction) {
    setBusyId(userId);
    setError('');
    setMessage('');
    try {
      if (action.kind === 'role') {
        await apiClient.post(`/api/admin/users/${userId}/role`, { role_id: action.roleId });
        setMessage(m('admin.roleChanged'));
      } else if (action.kind === 'suspend') {
        await apiClient.post(`/api/admin/users/${userId}/suspend`, {});
        setMessage(m('admin.suspended'));
      } else if (action.kind === 'unsuspend') {
        await apiClient.post(`/api/admin/users/${userId}/unsuspend`, {});
        setMessage(m('admin.unsuspended'));
      } else if (action.kind === 'revoke') {
        await apiClient.post(`/api/admin/users/${userId}/sessions/revoke`, {});
        setMessage(m('admin.sessionsRevoked'));
      } else {
        await apiClient.post(`/api/admin/users/${userId}/delete`, {});
        setMessage(m('admin.deleted'));
      }
      await refresh();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        setPending({ userId, action });
      } else {
        setError(caught instanceof ApiClientError ? caught.message : m('common.error'));
      }
    } finally {
      setBusyId(null);
    }
  }

  const label = (roleId: string) => ROLE_LABELS[roleId] ?? roleId;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert variant="success" size="sm">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg">{m('admin.noUsers')}</p>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-fg">
                  <th className="px-4 py-2 font-medium">{m('admin.user')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.status')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.role')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.twoFactor')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.createdAt')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelf = row.id === currentUserId;
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id} className="border-b border-border align-top last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium">{row.username}</p>
                        <p className="text-xs text-muted-fg">{row.email}</p>
                      </td>
                      <td className="px-4 py-3">{row.status}</td>
                      <td className="px-4 py-3">
                        <select
                          aria-label={m('admin.changeRole')}
                          className="h-8 rounded-md border border-border bg-card px-2 text-sm"
                          value={row.role_id}
                          disabled={busy || isSelf || !ASSIGNABLE_ROLES.includes(row.role_id)}
                          onChange={(event) => void run(row.id, { kind: 'role', roleId: event.target.value })}
                        >
                          {(ASSIGNABLE_ROLES.includes(row.role_id)
                            ? ASSIGNABLE_ROLES
                            : [...ASSIGNABLE_ROLES, row.role_id]
                          ).map((roleId) => (
                            <option key={roleId} value={roleId}>
                              {label(roleId)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        {row.has_2fa ? m('admin.enabled') : m('admin.disabled')}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-fg">
                        {formatLocalDateTime(row.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {row.status === 'suspended' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void run(row.id, { kind: 'unsuspend' })}
                            >
                              {m('admin.unsuspend')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || isSelf}
                              onClick={() => void run(row.id, { kind: 'suspend' })}
                            >
                              {m('admin.suspend')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void run(row.id, { kind: 'revoke' })}
                          >
                            {m('admin.revokeSessions')}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy || isSelf}
                            onClick={() => {
                              if (window.confirm(m('admin.confirmDelete'))) {
                                void run(row.id, { kind: 'delete' });
                              }
                            }}
                          >
                            {m('admin.delete')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-fg">{m('admin.totalCount', { n: total })}</p>

      <ReauthDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onReauthenticated={async () => {
          if (pending) await run(pending.userId, pending.action);
        }}
      />
    </div>
  );
}
