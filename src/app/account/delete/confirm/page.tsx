import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/layout/auth-shell';
import { AccountDeleteConfirmForm } from '@/app/account/delete/confirm/account-delete-confirm-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('accountDelete.confirmTitle') };

/**
 * メール確認による退会の確定画面（§24）。
 *
 * `POST /api/auth/account/delete/request` が送るメール内 URL は
 * `/api/auth/account/delete/confirm?token=...`。その GET は 303 でこのページへ転送する。
 * ここでの確定は POST のみ（§25）。
 */
export default async function AccountDeleteConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <AuthShell
      title={m('accountDelete.confirmTitle')}
      description={m('accountDelete.warningBody')}
      footer={
        <p className="text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">
            {m('common.backToLogin')}
          </Link>
        </p>
      }
    >
      <AccountDeleteConfirmForm token={token ?? ''} />
    </AuthShell>
  );
}
