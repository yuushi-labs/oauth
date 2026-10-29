import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/layout/auth-shell';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.forgotTitle') };

/** パスワード再設定の入口。応答は登録の有無で変わらない（§46）。 */
export default async function ForgotPasswordPage() {
  return (
    <AuthShell
      title={m('auth.forgotTitle')}
      description={m('auth.forgotDescription')}
      footer={
        <p className="text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">
            {m('common.backToLogin')}
          </Link>
        </p>
      }
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
