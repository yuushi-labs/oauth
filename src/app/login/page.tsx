import type { Metadata } from 'next';
import { AuthForm } from '@/app/auth-form';
import { LoginButtons } from '@/components/auth/login-buttons';
import { m, type UiMessagePath } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.loginTitle') };

/** OAuth コールバックが `?error=` で返しうる値だけを受け付ける（§12.2）。 */
const OAUTH_ERROR_PATHS: readonly UiMessagePath[] = [
  'oauth.errors.cancelled',
  'oauth.errors.account_not_linkable',
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const { returnTo, error } = await searchParams;
  const oauthError = OAUTH_ERROR_PATHS.includes(error as UiMessagePath)
    ? m(error as UiMessagePath)
    : undefined;

  return (
    // `LoginButtons` は process.env を読むため**サーバーコンポーネントのまま**渡す。
    // クライアントコンポーネント（AuthForm）側から import するとブラウザでは
    // env を読めず 0 件になり、hydration mismatch になる（BUG-11）。
    <AuthForm
      mode="login"
      returnTo={returnTo}
      oauthError={oauthError}
      socialSlot={<LoginButtons returnTo={returnTo} />}
    />
  );
}
