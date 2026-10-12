import { cookies } from 'next/headers';
import { randomBytes, createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';

const SESSION_COOKIE = '__Host-auth_session';
const ANON_COOKIE = '__Host-auth_anon';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30日
const ANON_MAX_AGE = 30 * 60; // 30分

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
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
  cookieStore.set(ANON_COOKIE, `${csrfSecret}.${signed}`, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: ANON_MAX_AGE,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function clearAnonCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ANON_COOKIE, '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function readAnonCookie(): Promise<{ csrfSecret: string; signed: string } | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(ANON_COOKIE)?.value;
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  return { csrfSecret: value.slice(0, dot), signed: value.slice(dot + 1) };
}

export async function verifyAnonCookie(csrfSecret: string): Promise<boolean> {
  const env = getEnv();
  const anon = await readAnonCookie();
  if (!anon) return false;
  const expected = createHmac('sha256', env.CSRF_SECRET).update(csrfSecret).digest('hex');
  return anon.signed === expected && anon.csrfSecret === csrfSecret;
}

export function generateAnonCsrfSecret(): string {
  return randomBytes(32).toString('base64url');
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const ANON_COOKIE_NAME = ANON_COOKIE;