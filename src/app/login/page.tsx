import { AuthForm } from '@/app/auth-form';
import { m, type UiMessagePath } from '@/messages/ja';

/** OAuth コールバックが `?error=` で返しうる値だけを受け付ける（§12.2）。 */
const OAUTH_ERROR_PATHS: readonly UiMessagePath[] = [
  'oauth.errors.cancelled',
  'oauth.errors.account_not_linkable',
  'oauth.errors.link_required',
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

  return <AuthForm mode="login" returnTo={returnTo} oauthError={oauthError} />;
}
