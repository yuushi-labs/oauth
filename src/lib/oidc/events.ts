import type { IncomingMessage } from 'node:http';
import type Provider from 'oidc-provider';
import { getClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import type { SecurityEventType } from '@/lib/db/schema';
import { logger, redactText } from '@/lib/util/logger';

type OidcEventContext = {
  req?: IncomingMessage;
  oidc?: { client?: { clientId?: string }; session?: { accountId?: string } };
};

type ProviderEvent = {
  event: string;
  type: SecurityEventType;
  endpoint: string;
};

const ERROR_EVENTS: ProviderEvent[] = [
  { event: 'authorization.error', type: 'oidc_authorize_denied', endpoint: 'authorize' },
  { event: 'grant.error', type: 'oidc_token_failed', endpoint: 'token' },
  { event: 'revocation.error', type: 'oidc_token_failed', endpoint: 'revocation' },
  { event: 'userinfo.error', type: 'oidc_token_failed', endpoint: 'userinfo' },
];

const REVOCATION_EVENTS: ProviderEvent[] = [
  { event: 'grant.revoked', type: 'oidc_token_revoked', endpoint: 'revoke' },
];

function rawRequest(ctx: unknown): IncomingMessage | undefined {
  const context = ctx as OidcEventContext;
  return context?.req;
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (typeof raw === 'string') headers.set(key, raw);
    else if (Array.isArray(raw)) headers.set(key, raw.join(', '));
  }
  return headers;
}

function errorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const { error: code, error_description: description } = error as { error?: unknown; error_description?: unknown };
  return {
    ...(typeof code === 'string' ? { oauthError: code } : {}),
    ...(typeof description === 'string' ? { errorDescription: redactText(description).slice(0, 200) } : {}),
  };
}

async function record(type: SecurityEventType, endpoint: string, ctx: unknown, error?: unknown): Promise<void> {
  try {
    const context = (ctx ?? {}) as OidcEventContext;
    const req = rawRequest(ctx);
    const clientId = context.oidc?.client?.clientId ?? null;
    const userId = context.oidc?.session?.accountId ?? null;
    await recordSecurityEvent(
      type,
      userId,
      req ? getClientIp(nodeHeaders(req), req.socket.remoteAddress) : '',
      req ? (req.headers['user-agent'] ?? '') : '',
      { endpoint, ...(clientId ? { clientId } : {}), ...errorMetadata(error) },
    );
  } catch (cause) {
    logger.error('oidc security event could not be recorded', { endpoint, type, cause: String(cause) });
  }
}

export function attachOidcSecurityEvents(provider: Provider): void {
  for (const { event, type, endpoint } of ERROR_EVENTS) {
    provider.on(event, (ctx, error) => {
      void record(type, endpoint, ctx, error);
    });
  }
  for (const { event, type, endpoint } of REVOCATION_EVENTS) {
    provider.on(event, (ctx) => {
      void record(type, endpoint, ctx);
    });
  }
}