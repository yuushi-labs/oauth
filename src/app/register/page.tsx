import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { AuthForm } from '@/app/auth-form';
import { m } from '@/messages/ja';
import { turnstileSiteKey } from '@/lib/auth/captcha-config';

export const metadata: Metadata = { title: m('auth.registerTitle') };

export default async function RegisterPage() {
  // site key と nonce はサーバ側で解決して渡す（BUG-11 / BUG-22）。
  const captchaSiteKey = turnstileSiteKey();
  const captchaNonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <AuthForm mode="register" captchaSiteKey={captchaSiteKey} captchaNonce={captchaNonce} />
  );
}
