import type { Metadata } from 'next';
import { AuthShell } from '@/components/layout/auth-shell';
import { VerifyEmailForm } from '@/app/verify-email-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.verifyTitle') };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <AuthShell title={m('auth.verifyTitle')} description={m('auth.verifyDescription')}>
      <VerifyEmailForm token={token ?? ''} />
    </AuthShell>
  );
}
