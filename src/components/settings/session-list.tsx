'use client';

import * as React from 'react';
import { MonitorSmartphone, Smartphone } from 'lucide-react';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { formatLocalDateTime, resolveTimeZone } from '@/lib/util/datetime';
import { m } from '@/messages/ja';

export type SessionRow = {
  id: string;
  device_name: string;
  os: string | null;
  ip_masked: string | null;
  last_seen_at: string;
  created_at: string;
  current: boolean;
};

function DeviceIcon({ current }: { current: boolean }) {
  const Icon = current ? MonitorSmartphone : Smartphone;
  return <Icon aria-hidden className="size-5 shrink-0 text-muted-fg" />;
}

/**
 * セッション一覧（§38 / D-30-08）。
 * 現在セッションはバッジ＋アイコン＋太線で他と区別する（色のみに依存しない・§42）。
 */
export function SessionList({
  sessions,
  timezone,
  onChanged,
  onSignOutCurrent,
}: {
  sessions: SessionRow[];
  timezone: string;
  onChanged: () => void | Promise<void>;
  onSignOutCurrent: () => void;
}) {
  const { push } = useToast();
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [confirmAll, setConfirmAll] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [error, setError] = React.useState('');
  const zone = resolveTimeZone(timezone);

  const others = sessions.filter((row) => !row.current);

  async function signOut(row: SessionRow) {
    setPendingId(row.id);
    setError('');
    try {
      const result = await apiClient.delete<{ was_current: boolean }>(`/api/auth/sessions/${row.id}`);
      setConfirmId(null);
      push({ variant: 'success', title: m('sessions.signOutResult') });
      if (result.was_current) {
        onSignOutCurrent();
        return;
      }
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('sessions.notFound'));
    } finally {
      setPendingId(null);
    }
  }

  async function logoutAll() {
    setPendingId('all');
    setError('');
    try {
      await apiClient.post('/api/auth/logout-all');
      setConfirmAll(false);
      onSignOutCurrent();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        setConfirmAll(false);
        setReauthOpen(true);
        return;
      }
      setError(caught instanceof ApiClientError ? caught.message : m('sessions.notFound'));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {sessions.map((row) => (
        <Card key={row.id} className={row.current ? 'border-primary' : undefined}>
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2">
              <DeviceIcon current={row.current} />
              <span className={row.current ? 'font-semibold' : 'font-medium'}>{row.device_name}</span>
              {row.current && (
                <span className="rounded-full bg-hover px-2 py-0.5 text-xs font-semibold text-fg">
                  {m('sessions.currentBadge')}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-muted-fg">
              {row.os && (
                <>
                  <dt>{m('sessions.osLabel')}</dt>
                  <dd>{row.os}</dd>
                </>
              )}
              {row.ip_masked && (
                <>
                  <dt>IP</dt>
                  <dd>{row.ip_masked}</dd>
                </>
              )}
              <dt>{m('sessions.lastSeen')}</dt>
              <dd>
                <time dateTime={row.last_seen_at}>{formatLocalDateTime(row.last_seen_at, zone)}</time>
              </dd>
              <dt>{m('sessions.createdAt')}</dt>
              <dd>
                <time dateTime={row.created_at}>{formatLocalDateTime(row.created_at, zone)}</time>
              </dd>
            </dl>
            <div className="mt-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={pendingId !== null}
                onClick={() => setConfirmId(row.id)}
              >
                {m('sessions.signOut')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {others.length === 0 && (
        <p className="text-sm text-muted-fg">{m('sessions.emptyOthers')}</p>
      )}

      <div>
        <Button variant="destructive" disabled={pendingId !== null} onClick={() => setConfirmAll(true)}>
          {m('sessions.signOutAll')}
        </Button>
      </div>

      <Dialog open={confirmId !== null} onOpenChange={(open) => !open && setConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m('sessions.signOut')}</DialogTitle>
            <DialogDescription>{m('sessions.signOut')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmId(null)}>
              {m('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId !== null}
              onClick={() => {
                const row = sessions.find((item) => item.id === confirmId);
                if (row) void signOut(row);
              }}
            >
              {m('sessions.signOut')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m('sessions.signOutAllConfirm')}</DialogTitle>
            <DialogDescription>{m('sessions.signOutAllDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmAll(false)}>
              {m('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={pendingId !== null} onClick={() => void logoutAll()}>
              {m('sessions.signOutAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        description={m('sessions.signOutAllDescription')}
        onReauthenticated={() => void logoutAll()}
      />
    </div>
  );
}