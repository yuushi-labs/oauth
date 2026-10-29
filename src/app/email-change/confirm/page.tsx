import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/layout/auth-shell';
import { EmailChangeForm } from '@/app/email-change/confirm/email-change-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.emailChangeTitle') };

/**
 * `POST /api/auth/email/change` が送るメール内 URL は
 * `/api/auth/email/change/confirm?token=...`。その GET は 303 でこのページに
 * 転送される（BUG-2 で GET ハンドラを追加）。ここでの確定は POST のみ（§25）。
 */
export default async function EmailChangeConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <AuthShell
      title={m('auth.emailChangeTitle')}
      description={m('auth.emailChangeDescription')}
      footer={
        <p className="text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">
            {m('common.backToLogin')}
          </Link>
        </p>
      }
    >
      <EmailChangeForm token={token ?? ''} />
    </AuthShell>
  );
}
