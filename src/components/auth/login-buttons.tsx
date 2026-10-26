import { configuredOAuthProviders, oauthEnvKeys } from '@/lib/auth/oauth/registry';
import { SocialLoginButtons } from '@/components/auth/social-login-buttons';
import { PasskeyLoginButton } from '@/components/auth/passkey-login-button';
import { isPasskeyEnabled } from '@/lib/auth/passkey/config';

/**
 * ログインボタン（registry 駆動 ＋ Passkey・§12.2）。
 *
 * 認証方式は registry から自動生成し、**0 件なら領域ごと描画しない**（D-30-21）。
 * 鍵の組み合わせは registry の `envKeys` から取るので、provider を増やしても
 * このファイルを手直ししなくてよい。Passkey の有無は**サーバー側で env から判定**し、
 * 真偽値だけをクライアントへ渡す（BUG-11 / D-34-01）。
 */
export function LoginButtons({ returnTo }: { returnTo?: string }) {
  // サーバー側で env を判定し、**id と label だけ**をクライアントへ渡す。
  // client_secret などの機密値をバンドルへ載せない（§45）。
  const envSubset: Record<string, string | undefined> = {};
  for (const key of oauthEnvKeys()) envSubset[key] = process.env[key];

  const providers = configuredOAuthProviders(envSubset);
  const passkeyEnabled = isPasskeyEnabled();

  if (providers.length === 0 && !passkeyEnabled) return null;

  return (
    <div className="flex flex-col gap-3">
      {providers.length > 0 && (
        <SocialLoginButtons
          providers={providers.map((provider) => ({ id: provider.id, label: provider.label }))}
        />
      )}
      {passkeyEnabled && <PasskeyLoginButton returnTo={returnTo} />}
    </div>
  );
}
