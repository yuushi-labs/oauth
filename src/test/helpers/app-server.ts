import type { Server } from 'node:http';
import { freePort } from './http';
import { resetEnvCache } from '@/lib/env';

export type TestAppServer = {
  origin: string;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Starts the real application server (Next + the OIDC handler) in-process and returns its
 * origin, so tests can drive Route Handlers and screens over real HTTP instead of importing
 * the handlers and calling them directly. That is the only way to assert cookies, 303
 * redirects, Cache-Control and Set-Cookie behaviour.
 *
 * Reuses `scripts/server.ts#startServer`, the same entry point `pnpm dev` uses.
 */
export async function startTestAppServer(options: { dev?: boolean; oidc?: boolean } = {}): Promise<TestAppServer> {
  const { startServer } = await import('../../../scripts/server');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  process.env.NEXT_PUBLIC_APP_URL = origin;
  process.env.CSRF_TRUSTED_ORIGINS = origin;
  process.env.ALLOWED_ORIGINS = origin;

  if (options.oidc) {
    // The provider refuses to boot unless the issuer origin matches the app URL, so keep
    // the two in sync and supply throwaway signing keys.
    const { generateTestOidcKeys } = await import('./oidc-keys');
    const keys = generateTestOidcKeys();
    process.env.OIDC_ISSUER = origin;
    process.env.OIDC_JWKS_JSON = keys.jwks;
    process.env.OIDC_ADAPTER_ENCRYPTION_KEY = keys.adapterKey;
  } else {
    // Without keys the provider stays off; these tests only exercise Next routes and screens.
    delete process.env.OIDC_ISSUER;
  }
  resetEnvCache();

  const dev = options.dev ?? true;
  const { server } = await startServer({ dev, port, hostname: '127.0.0.1' });

  return {
    origin,
    port,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }) as Promise<void>,
  };
}

export type { Server };