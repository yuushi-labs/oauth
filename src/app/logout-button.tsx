'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type CsrfResponse = { success: boolean; data?: { csrfToken?: string } };

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    setError('');
    try {
      const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json()) as CsrfResponse;
      const token = csrf.data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('csrf');
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
      });
      if (!response.ok) throw new Error('logout');
      router.replace('/login');
      router.refresh();
    } catch {
      setError('ログアウトに失敗しました。再度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button className="rounded-md border border-border px-4 py-2 font-medium" type="button" onClick={logout} disabled={busy}>
        {busy ? '処理中…' : 'ログアウト'}
      </button>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
