import { createHmac, createPrivateKey, randomBytes } from 'node:crypto';
import Provider, { interactionPolicy } from 'oidc-provider';
import { getEnv } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { PostgresOidcAdapter } from '@/lib/oidc/adapter';
import { verifyClientSecretHash } from '@/lib/oidc/crypto';
import { attachOidcSecurityEvents } from '@/lib/oidc/events';
import { OIDC_SCOPES } from '@/lib/oidc/scopes';
import { subjectOwner } from '@/lib/oidc/subjects';
import { currentOidcAppSession } from '@/lib/oidc/session';

type UserClaims = {
  sub: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
};

export type Account = {
  accountId: string;
  claims: (use: string, scope: string, claims: Record<string, unknown>) => Promise<UserClaims>;
};

let providerPromise: Promise<InstanceType<typeof Provider>> | null = null;

export function getOidcProvider(): Promise<InstanceType<typeof Provider>> | null {
  const env = getEnv();
  if (!env.OIDC_ISSUER) return null;
  providerPromise ??= createProvider(env.OIDC_ISSUER, env.OIDC_JWKS_JSON, env.OIDC_ADAPTER_ENCRYPTION_KEY);
  return providerPromise;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.at(0);
  return (quote === "'" || quote === '"') && trimmed.endsWith(quote) ? trimmed.slice(1, -1) : trimmed;
}

async function createProvider(issuer: string, jwksJson?: string, adapterKey?: string) {
  if (!jwksJson || !adapterKey) {
    throw new Error('OIDC_ISSUER requires OIDC_JWKS_JSON and OIDC_ADAPTER_ENCRYPTION_KEY');
  }
  const issuerUrl = new URL(issuer);
  if (issuerUrl.pathname !== '/' || issuerUrl.search || issuerUrl.hash
    || issuerUrl.origin !== new URL(getEnv().NEXT_PUBLIC_APP_URL).origin) {
    throw new Error('OIDC_ISSUER must be the fixed origin configured in NEXT_PUBLIC_APP_URL');
  }
  const jwks = JSON.parse(stripWrappingQuotes(jwksJson)) as { keys?: Array<Record<string, unknown>> };
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('OIDC_JWKS_JSON must contain at least one signing key');
  }
  const kids = new Set<string>();
  let privateSigningKeys = 0;
  for (const key of jwks.keys) {
    if (key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || typeof key.kid !== 'string' || kids.has(key.kid)) {
      throw new Error('OIDC keys must be unique RSA RS256 signing JWKs with kid');
    }
    kids.add(key.kid);
    if (key.d) {
      privateSigningKeys += 1;
      createPrivateKey({ key, format: 'jwk' });
    }
  }
  if (privateSigningKeys !== 1) {
    throw new Error('OIDC_JWKS_JSON must contain one private signing key plus optional retained public keys');
  }
  if (Buffer.from(adapterKey, 'base64').length !== 32) {
    throw new Error('OIDC_ADAPTER_ENCRYPTION_KEY must decode to 32 bytes');
  }
  if (process.env.NODE_ENV === 'production' && new URL(issuer).protocol !== 'https:') {
    throw new Error('OIDC_ISSUER must use HTTPS in production');
  }
  if (process.env.NODE_ENV === 'production' && /(?:^|,)\s*oidc-provider[\s*:,-]/iu.test(process.env.DEBUG ?? '')) {
    throw new Error('DEBUG must not enable oidc-provider namespaces in production: its logs are not redacted');
  }

  const pool = getPool();
  const production = process.env.NODE_ENV === 'production';
  const cookieKey = createHmac('sha256', process.env.SESSION_PEPPER ?? '').update('oidc-provider-cookie-v1').digest('base64url');
  const policy = interactionPolicy.base();
  policy.get('login').checks.add(new interactionPolicy.Check(
    'app_session',
    'An active application session is required for authorization',
    async (ctx) => {
      const appSession = await currentOidcAppSession(ctx.req);
      if (!appSession) return true;
      const { accountId } = ctx.oidc.session;
      if (typeof accountId !== 'string') return false;
      return (await subjectOwner(accountId)) !== appSession.id;
    },
  ));
  const config: Record<string, unknown> = {
    adapter: (model: string) => new PostgresOidcAdapter(model),
    jwks,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    scopes: [...OIDC_SCOPES],
    claims: {
      openid: ['sub', 'auth_time'],
      profile: ['name', 'preferred_username', 'picture'],
      email: ['email', 'email_verified'],
    },
    subjectTypes: ['public'],
    idTokenSigningAlgValues: ['RS256'],
    clientAuthMethods: ['client_secret_basic', 'none'],
    pkce: { required: () => true },
    ttl: { AuthorizationCode: 300, AccessToken: 600, IdToken: 300, Interaction: 300, Grant: 2_592_000 },
    routes: {
      authorization: '/oauth2/authorize',
      token: '/oauth2/token',
      userinfo: '/oauth2/userinfo',
      revocation: '/oauth2/revoke',
      jwks: '/oauth2/jwks',
    },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      backchannelLogout: { enabled: false },
      ciba: { enabled: false },
      mTLS: { enabled: false },
      attestClientAuth: { enabled: false },
      clientIdMetadataDocument: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      encryption: { enabled: false },
      fapi: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      introspection: { enabled: false },
      jwtIntrospection: { enabled: false },
      jwtResponseModes: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      registration: { enabled: false },
      registrationManagement: { enabled: false },
      richAuthorizationRequests: { enabled: false },
      resourceIndicators: { enabled: false },
      requestObjects: { enabled: false },
      rpMetadataChoices: { enabled: false },
      jwtUserinfo: { enabled: false },
      webMessageResponseMode: { enabled: false },
      openid4vci: { enabled: false },
      revocation: { enabled: true },
    },
    cookies: {
      names: {
        session: production ? '__Host-oidc_session' : 'oidc_session',
        interaction: production ? '__Host-oidc_interaction' : 'oidc_interaction',
        resume: production ? '__Host-oidc_resume' : 'oidc_resume',
      },
      keys: [cookieKey],
      long: { httpOnly: true, sameSite: 'lax', secure: production, path: '/' },
      short: { httpOnly: true, sameSite: 'lax', secure: production, path: '/' },
    },
    interactions: {
      policy,
      url: (_ctx: unknown, interaction: { uid: string }) => `/oauth2/interaction/${encodeURIComponent(interaction.uid)}`,
    },
    clientBasedCORS: async (_ctx: unknown, origin: string, client: { clientId: string }) => {
      const result = await pool.query<{ allowed: boolean }>(
        `SELECT $2 = ANY(web_origins) AS allowed FROM oauth_clients
         WHERE client_id = $1 AND client_type = 'public' AND active = true AND revoked_at IS NULL`,
        [client.clientId, origin],
      );
      return result.rows[0]?.allowed === true;
    },
    findAccount: async (ctx: unknown, subject: string): Promise<Account | undefined> => {
      const clientId = (ctx as { oidc?: { client?: { clientId?: string } } }).oidc?.client?.clientId;
      if (!clientId) return undefined;
      const owner = await subjectOwner(subject);
      if (!owner) return undefined;
      const result = await pool.query<{
        id: string; username: string; email: string; email_verified: boolean;
        display_name: string | null; avatar_url: string | null; status: string; deleted_at: Date | null;
      }>(
        `SELECT id, username, email, email_verified, display_name, avatar_url, status, deleted_at
         FROM users WHERE id = $1 AND status = 'active' AND email_verified = true AND deleted_at IS NULL`,
        [owner],
      );
      const user = result.rows[0];
      if (!user) return undefined;
      await pool.query(
        `UPDATE oidc_user_grants SET last_used_at = now()
         WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`, [user.id, clientId],
      );
      return {
        accountId: subject,
        claims: async (_use, scope) => {
          const granted = new Set(scope.split(/\s+/u));
          const claims: UserClaims = { sub: subject };
          if (granted.has('profile')) {
            claims.name = user.display_name || user.username;
            claims.preferred_username = user.username;
            if (user.avatar_url) {
              try {
                if (new URL(user.avatar_url).protocol === 'https:') claims.picture = user.avatar_url;
              } catch { /* Invalid stored profile URLs are not emitted as claims. */ }
            }
          }
          if (granted.has('email')) {
            // メール送受信の廃止（Phase 10 / D-40-06）により、登録時のメール所有確認手段が無い。
            // `email_verified=true` は「所有確認済み」の標準的な意味（OIDC Core）を持ち、未確認の
            // アドレスに付けるとメール一致で照合する RP のアカウント乗っ取りに繋がる。よって
            // `email` は本人が設定した識別子として返しつつ、`email_verified` は常に false にする。
            claims.email = user.email;
            claims.email_verified = false;
          }
          return claims;
        },
      };
    },
  };
  const provider = new Provider(issuer, config);
  Object.defineProperty(provider.Client.prototype, 'compareClientSecret', {
    configurable: true,
    writable: true,
    value(this: { clientSecret?: string }, actual: string): boolean {
      return typeof this.clientSecret === 'string' && verifyClientSecretHash(this.clientSecret, actual);
    },
  });
  attachOidcSecurityEvents(provider);
  return provider;
}
