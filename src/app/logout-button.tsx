'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, resetCsrfCache } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessage, m } from '@/messages/ja';

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/api/auth/logout');
      // セッションが変わるので CSRF トークンのキャッシュを捨てる（D-30-22）
      resetCsrfCache();
      router.replace('/login');
      router.refresh();
    } catch (caught) {
      setError(errorMessage('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="outline" onClick={() => void logout()} loading={busy}>
        {m('auth.logout')}
      </Button>
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
