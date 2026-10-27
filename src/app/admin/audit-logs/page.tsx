import { requireAdminUser } from '@/app/admin/layout';
import { listAdminAuditLogs } from '@/lib/db/queries/audit-logs';
import { Card, CardContent } from '@/components/ui/card';
import { formatLocalDateTime } from '@/lib/util/datetime';
import { m, messages } from '@/messages/ja';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const ACTION_LABELS = messages.ui.admin.actionLabels;

/**
 * 監査ログ閲覧（Phase 7.5 / §61）。
 *
 * `admin_audit_logs` のみを表示する。読み取り専用で、`ip` / `user_agent` は出さず
 * マスク済み IP だけを出す（§45・D-35-07）。
 */
export default async function AdminAuditLogsPage() {
  await requireAdminUser();
  const { logs, total } = await listAdminAuditLogs({ limit: PAGE_SIZE, offset: 0 });

  const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

  return (
    <main className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">{m('admin.auditLogs')}</h1>
        <p className="mt-1 text-sm text-muted-fg">{m('admin.auditLogsHint')}</p>
      </header>

      {logs.length === 0 ? (
        <p className="text-sm text-muted-fg">{m('admin.noAuditLogs')}</p>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-fg">
                  <th className="px-4 py-2 font-medium">{m('admin.action')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.actor')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.target')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.ipMasked')}</th>
                  <th className="px-4 py-2 font-medium">{m('admin.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{actionLabel(log.action)}</p>
                      <p className="text-xs text-muted-fg">
                        {formatLocalDateTime(log.createdAt)}
                      </p>
                    </td>
                    <td className="px-4 py-3">{log.actorUsername ?? log.actorUserId}</td>
                    <td className="px-4 py-3">
                      {log.targetUsername ?? log.targetUserId ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-fg">{log.ipMasked ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-muted-fg">
                      {log.metadata ? JSON.stringify(log.metadata) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-fg">{m('admin.totalCount', { n: total })}</p>
    </main>
  );
}
