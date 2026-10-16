import { cookies } from 'next/headers';
import { randomBytes, createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { timingSafeEqualStr } from '@/lib/util/crypto';

const SESSION_COOKIE = '__Host-auth_session';
const ANON_COOKIE = '__Host-auth_anon';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30日
const ANON_MAX_AGE = 30 * 60; // 30分

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
