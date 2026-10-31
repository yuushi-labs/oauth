import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { AuthShell } from '@/components/layout/auth-shell';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';
import { m } from '@/messages/ja';
import { turnstileSiteKey } from '@/lib/auth/captcha-config';

export const metadata: Metadata = { title: m('auth.forgotTitle') };

/** パスワード再設定の入口。応答は登録の有無で変わらない（§46）。 */
export default async function ForgotPasswordPage() {
  // site key と nonce はサーバ側で解決して渡す（BUG-11 / BUG-22）。
  const captchaSiteKey = turnstileSiteKey();
  const captchaNonce = (await headers()).get('x-nonce') ?? undefined;
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
      <ForgotPasswordForm captchaSiteKey={captchaSiteKey} captchaNonce={captchaNonce} />
    </AuthShell>
  );
}
