'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import { SessionList, type SessionRow } from '@/components/settings/session-list';
import { Alert, AlertDescription } from '@/components/ui/alert';

type SessionsResponse = { sessions: SessionRow[]; timezone: string };

/**
 * セッション画面のクライアント部分。初回表示は Server Component の値を渡し、
 * 以降（個別/全体ログアウト後）は `GET /api/auth/sessions` を取り直す。
 */
export function SessionsPanel({
  initialSessions,
  timezone,
}: {
  initialSessions: SessionRow[];
  timezone: string;
}) {
  const router = useRouter();
  const [sessions, setSessions] = React.useState(initialSessions);
  const [zone, setZone] = React.useState(timezone);
  const [loadError, setLoadError] = React.useState('');
  // 初回表示は Server Component の値（hydration mismatch を避ける）。
  // 個別/全体ログアウト後に GET /api/auth/sessions で取り直す。
  void router;

  const refresh = React.useCallback(async () => {
    try {
      const data = await apiClient.get<SessionsResponse>('/api/auth/sessions');
      setSessions(data.sessions);
      setZone(data.timezone);
      setLoadError('');
    } catch {
      setLoadError('セッション一覧を更新できませんでした。再読み込みしてください。');
    }
  }, []);

  return (
    <>
      {loadError && (
        <Alert variant="warning">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      <SessionList
        sessions={sessions}
        timezone={zone}
        onChanged={refresh}
        onSignOutCurrent={() => {
          // 現在のセッションを失効したのでログイン画面へ
          router.replace('/login');
          router.refresh();
        }}
      />
    </>
  );
}