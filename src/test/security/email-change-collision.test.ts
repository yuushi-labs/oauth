import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  DEFAULT_ROLE_ID,
  emailChangeRequests,
  securityEvents,
  sessions,
  users,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { insertEmailChangeRequest } from '@/lib/db/queries/tokens';
import { generateToken } from '@/lib/auth/tokens/generate';
import { POST as confirmEmailChange } from '@/app/api/auth/email/change/confirm/route';
import { useMemoryEmail, restoreResendEmail } from '@/test/helpers/email';

/**
 * §14 / §46: confirming an email change to an address that already belongs to another account
 * must be rejected as a conflict (409). Before the fix the UPDATE hit `users_email_lower_uniq`
 * and surfaced as an unhandled 500, leaking both the failure and the target address into the
 * error log, and burning the one-time token so the user could not retry.
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-email-collision';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43))
  .update(anonSecret)
  .digest('hex');

const createdUserIds: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(email: string): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: true,
    passwordHash: 'hash',
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

function confirmRequest(token: string): NextRequest {
  return new NextRequest(new Request(`${appUrl}/api/auth/email/change/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'vitest',
    },
    body: JSON.stringify({ token }),
  }));
}

async function pendingRequest(userId: string, newEmail: string): Promise<{ raw: string; id: string }> {
  const { raw, hash, id } = generateToken();
  await insertEmailChangeRequest({
    id,
    userId,
    tokenHash: hash,
    purpose: 'email_change',
    newEmail,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  return { raw, id };
}

beforeEach(() => {
  useMemoryEmail();
});

afterEach(() => {
  restoreResendEmail();
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - email change collision (spec 14/46)', () => {
  it('既存アカウントのアドレスへの確定は 409 を返し、500 にしない', async () => {
    const ownerEmail = `${uniq('owner')}@example.com`;
    const victimEmail = `${uniq('victim')}@example.com`;
    const ownerId = await makeUser(ownerEmail);
    await makeUser(victimEmail);

    const { raw, id } = await pendingRequest(ownerId, victimEmail);

    const response = await confirmEmailChange(confirmRequest(raw));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('EMAIL_CONFLICT');

    const db = getDb();
    const [owner] = await db.select().from(users).where(eq(users.id, ownerId)).limit(1);
    expect(owner!.email).toBe(ownerEmail);

    // 衝突時はトークンを消費しない（ユーザーが別アドレスでやり直せる）。
    const [request] = await db.select().from(emailChangeRequests).where(eq(emailChangeRequests.id, id)).limit(1);
    expect(request!.usedAt).toBeNull();
  });

  it('大文字小文字を無視して衝突を検出する（lower(email) 一意制約と同じ意味）', async () => {
    const ownerEmail = `${uniq('owner')}@example.com`;
    const victimEmail = `${uniq('victim')}@example.com`;
    const ownerId = await makeUser(ownerEmail);
    await makeUser(victimEmail);

    const { raw } = await pendingRequest(ownerId, victimEmail.toUpperCase());

    const response = await confirmEmailChange(confirmRequest(raw));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('EMAIL_CONFLICT');
  });

  it('自分自身の現行アドレスへの確定も衝突として扱う（別アカウントではないので 409 にはしない）', async () => {
    const ownerEmail = `${uniq('owner')}@example.com`;
    const ownerId = await makeUser(ownerEmail);

    const { raw } = await pendingRequest(ownerId, ownerEmail);

    // 自分の行を自分で更新するだけなので一意制約違反にはならない。
    const response = await confirmEmailChange(confirmRequest(raw));
    expect(response.status).toBe(200);
  });
});
