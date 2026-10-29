import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/layout/auth-shell';
import { ResetPasswordForm } from '@/app/reset-password/reset-password-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.resetTitle') };

/**
 * GET は画面表示のみ。パスワードの変更は画面内の POST で行う（§25）。
 * この画面が指す URL は `POST /api/auth/password/forgot` が送る
 * `/reset-password?token=...`（BUG-1 で旧 `/password/reset` から修正済み）。
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <AuthShell
      title={m('auth.resetTitle')}
      description={m('auth.resetDescription')}
      footer={
        <p className="text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">
            {m('common.backToLogin')}
          </Link>
        </p>
      }
    >
      <ResetPasswordForm token={token ?? ''} />
    </AuthShell>
  );
}
