import { z } from 'zod';
import { hasDisallowedScope, isOidcClientType, isOidcScope, type OidcClientType, type OidcScope } from '@/lib/oidc/scopes';

const MAX_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 20;
const MAX_WEB_ORIGINS = 10;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export class ClientValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`OIDC client の入力が不正です: ${issues.join(', ')}`);
    this.name = 'ClientValidationError';
    this.issues = issues;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Client names and operator names are rendered as consent-screen text, so control characters are rejected. */
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), { message: '制御文字は使用できません' });

export const clientTypeSchema = z.enum(['public', 'confidential']);

export const clientInputSchema = z.object({
  name: displayNameSchema,
  operator: displayNameSchema,
  clientType: clientTypeSchema,
  redirectUris: z.array(z.string().min(1, 'リダイレクト URI が空です')).min(1, 'リダイレクト URI が 1 つ以上必要です').max(MAX_REDIRECT_URIS),
  scopes: z.array(z.string()).min(1, '許可 scope が 1 つ以上必要です').max(3),
  webOrigins: z.array(z.string().min(1, 'Web origin が空です')).max(MAX_WEB_ORIGINS).default([]),
});

export type ClientInput = z.infer<typeof clientInputSchema>;
export type ClientUpdateInput = Omit<ClientInput, 'clientType'>;

function allowHttpForLoopback(hostname: string): boolean {
  return isLoopbackHost(hostname) && process.env.NODE_ENV !== 'production';
}

/**
 * Redirect URIs must be exact-match HTTPS endpoints. Loopback clients (native apps and local
 * development) are the only exception allowed to use plain HTTP, and never in production.
 */
export function validateRedirectUri(uri: string): string {
  const issues: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ClientValidationError([`リダイレクト URI が URL として解釈できません: ${uri}`]);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === 'http:') {
    if (!loopback) issues.push('リダイレクト URI は https が必要です（http は loopback のみ許可）');
    else if (process.env.NODE_ENV === 'production') issues.push('本番環境では loopback の http リダイレクト URI は使えません');
  } else if (parsed.protocol !== 'https:') {
    issues.push('リダイレクト URI は https のみ許可されます');
  }
  if (parsed.username || parsed.password) issues.push('リダイレクト URI にユーザ情報を含められません');
  if (parsed.hash) issues.push('リダイレクト URI に fragment を含められません');
  if (issues.length) throw new ClientValidationError([`安全でないリダイレクト URI: ${uri} (${issues.join(' / ')})`]);
  return parsed.toString();
}

export function validateWebOrigin(origin: string): string {
  const issues: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ClientValidationError([`Web origin が URL として解釈できません: ${origin}`]);
  }
  if (parsed.origin !== origin) issues.push('Web origin は scheme://host[:port] のみ指定してください');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) issues.push('Web origin にパス・クエリ・fragment は指定できません');
  if (parsed.protocol === 'http:' && !(allowHttpForLoopback(parsed.hostname) && isLoopbackHost(parsed.hostname))) {
    issues.push('Web origin は https が必要です（http は loopback のみ許可）');
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    issues.push('Web origin は https のみ許可されます');
  }
  if (issues.length) throw new ClientValidationError([`安全でない Web origin: ${origin} (${issues.join(' / ')})`]);
  return parsed.origin;
}

export function parseScopes(value: string | string[] | undefined): OidcScope[] {
  const requested = Array.isArray(value) ? value : (value ?? '').split(/[\s,]+/u);
  const scopes = [...new Set(requested.map((scope) => scope.trim()).filter(Boolean))];
  if (!scopes.includes('openid')) throw new ClientValidationError(['許可 scope には openid が必要です']);
  if (hasDisallowedScope(scopes)) throw new ClientValidationError(['許可できない scope が含まれます']);
  return scopes.filter(isOidcScope);
}

export function parseClientType(value: string | undefined): OidcClientType {
  if (!isOidcClientType(value)) throw new ClientValidationError(['種別は public または confidential です']);
  return value;
}

function normalizeUris(values: string[], validate: (value: string) => string): string[] {
  return [...new Set(values.map((value) => validate(value.trim())).filter(Boolean))];
}

/** Validates and normalizes client creation input shared by the CLI and the web console. */
export function parseClientInput(input: unknown): ClientInput {
  const parsed = clientInputSchema.safeParse(input);
  if (!parsed.success) throw new ClientValidationError(parsed.error.issues.map((issue) => issue.message));
  const raw = parsed.data;
  const redirectUris = normalizeUris(raw.redirectUris, validateRedirectUri);
  if (redirectUris.length === 0) throw new ClientValidationError(['リダイレクト URI が 1 つ以上必要です']);
  const scopes = parseScopes(raw.scopes);
  const webOrigins = normalizeUris(raw.webOrigins, validateWebOrigin);
  if (raw.clientType === 'confidential' && webOrigins.length > 0) {
    throw new ClientValidationError(['confidential クライアントに Web origin を登録できません']);
  }
  return { name: raw.name, operator: raw.operator, clientType: raw.clientType, redirectUris, scopes, webOrigins };
}

/** Console-only rule: browser clients without an origin can never pass the provider CORS check. */
export function requireWebOriginForPublicClient(clientType: OidcClientType, webOrigins: readonly string[]): void {
  if (clientType === 'public' && webOrigins.length === 0) {
    throw new ClientValidationError(['ブラウザから呼び出す public クライアントには Web origin が必要です']);
  }
}

/** Validates an update. `clientType` is intentionally immutable after creation (D-26-04). */
export function parseClientUpdateInput(input: unknown, clientType: OidcClientType): ClientUpdateInput {
  const parsed = clientInputSchema.omit({ clientType: true }).safeParse(input);
  if (!parsed.success) throw new ClientValidationError(parsed.error.issues.map((issue) => issue.message));
  const raw = parsed.data;
  const redirectUris = normalizeUris(raw.redirectUris, validateRedirectUri);
  if (redirectUris.length === 0) throw new ClientValidationError(['リダイレクト URI が 1 つ以上必要です']);
  const scopes = parseScopes(raw.scopes);
  const webOrigins = normalizeUris(raw.webOrigins, validateWebOrigin);
  if (clientType === 'confidential' && webOrigins.length > 0) {
    throw new ClientValidationError(['confidential クライアントに Web origin を登録できません']);
  }
  return { name: raw.name, operator: raw.operator, redirectUris, scopes, webOrigins };
}

/** Exact redirect URI required for the in-app connection test. The user adds it manually (D-26-06). */
export function connectionTestRedirectUri(appUrl: string): string {
  const base = new URL(appUrl);
  return new URL('/settings/applications/test/callback', base.origin).toString();
}

export function isRegisteredRedirectUri(redirectUris: readonly string[], candidate: string): boolean {
  return redirectUris.some((uri) => uri === candidate);
}

export function redirectUriAllowedForLoopback(uri: string): boolean {
  try {
    return allowHttpForLoopback(new URL(uri).hostname);
  } catch {
    return false;
  }
}
