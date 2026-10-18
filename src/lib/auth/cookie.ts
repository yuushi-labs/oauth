import { cookies } from 'next/headers';
import { randomBytes, createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { timingSafeEqualStr } from '@/lib/util/crypto';

const SESSION_COOKIE = '__Host-auth_session';
const ANON_COOKIE = '__Host-auth_anon';
const SOCIAL_CLAIM_COOKIE = '__Host-auth_social_claim';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30日
const ANON_MAX_AGE = 30 * 60; // 30分
/** 連携の確認待ちの TTL。`oauth_social_claims` の expires_at と同じ 10 分。 */
const SOCIAL_CLAIM_MAX_AGE = 10 * 60;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// Browsers reject __Host- cookies unless Secure is set, which makes them
// unusable on the HTTP localhost origin used by `next dev`.
export function getSessionCookieName(): string {
  return isProduction() ? SESSION_COOKIE : 'auth_session';
}

export function getAnonCookieName(): string {
  return isProduction() ? ANON_COOKIE : 'auth_anon';
}

/**
 * 連携の確認待ち token は **Cookie で運ぶ**（D-32-05）。
 *
 * URL のクエリに載せると Referer やブラウザ履歴から漏れるため。DB には
 * SHA-256 だけ保存しているので、漏らしても claim の消費はできない。
 * provider からの top-level GET 遷移でセットし、アプリ内の POST でも送られる
 * （SameSite=Lax は top-level GET と同一オリジンのリクエストでは送る）。
 */
export function getSocialClaimCookieName(): string {
  return isProduction() ? SOCIAL_CLAIM_COOKIE : 'auth_social_claim';
}

/**
 * Route Handler からは `cookies()`（request scope）ではなく **レスポンスヘッダ** で
 * 書き込む。request scope が無い状態でルートを直接呼ぶテストでも使える。
 * 読む側はリクエストから直接読む（`cookies()` に依存しない）。
 */
export function buildSocialClaimCookie(token: string): string {
  const attributes = [
    `${getSocialClaimCookieName()}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SOCIAL_CLAIM_MAX_AGE}`,
  ];
  if (isProduction()) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * anon Cookie をレスポンスヘッダで書くための値（Route Handler 用・BUG-15）。
 *
 * Next.js 15 では Server Component の描画中は Cookie を**変更**できない。
 * そのため anon Cookie の発行は callback（Route Handler）で行い、
 * 確認画面は「既に存在する secret を読む」だけにする。
 */
export function buildAnonCookie(secret: string): string {
  const signature = createHmac('sha256', getEnv().CSRF_SECRET).update(secret).digest('hex');
  const attributes = [
    `${getAnonCookieName()}=${secret}.${signature}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ANON_MAX_AGE}`,
  ];
  if (isProduction()) attributes.push('Secure');
  return attributes.join('; ');
}

/** claim を消すための Set-Cookie 値（Max-Age=0）。 */
export function buildClearedSocialClaimCookie(): string {
  const attributes = [`${getSocialClaimCookieName()}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProduction()) attributes.push('Secure');
  return attributes.join('; ');
}

export async function readSocialClaimCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(getSocialClaimCookieName())?.value ?? null;
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(getSessionCookieName(), token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export async function setAnonCookie(csrfSecret: string): Promise<void> {
  const env = getEnv();
  const signed = createHmac('sha256', env.CSRF_SECRET).update(csrfSecret).digest('hex');
  const cookieStore = await cookies();
  cookieStore.set(getAnonCookieName(), `${csrfSecret}.${signed}`, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: ANON_MAX_AGE,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(getSessionCookieName(), '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function clearAnonCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(getAnonCookieName(), '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function readAnonCookie(): Promise<{ csrfSecret: string; signed: string } | null> {
  const cookieStore = await cookies();
  return parseAnonCookie(cookieStore.get(getAnonCookieName())?.value ?? null);
}

function parseAnonCookie(value: string | null): { csrfSecret: string; signed: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  return { csrfSecret: value.slice(0, dot), signed: value.slice(dot + 1) };
}

export function getAnonCsrfSecret(cookieValue: string | null): string | null {
  const anon = parseAnonCookie(cookieValue);
  if (!anon) return null;
  const env = getEnv();
  const expected = createHmac('sha256', env.CSRF_SECRET).update(anon.csrfSecret).digest('hex');
  return timingSafeEqualStr(anon.signed, expected) ? anon.csrfSecret : null;
}

export async function verifyAnonCookie(csrfSecret: string): Promise<boolean> {
  const anon = await readAnonCookie();
  return Boolean(anon && getAnonCsrfSecret(`${anon.csrfSecret}.${anon.signed}`) === csrfSecret);
}

export function generateAnonCsrfSecret(): string {
  return randomBytes(32).toString('base64url');
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const ANON_COOKIE_NAME = ANON_COOKIE;
