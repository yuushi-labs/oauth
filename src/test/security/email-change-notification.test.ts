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
 * §14 step 6: after the new address is confirmed, the *old* address must receive a
 * change notification. The confirm handler updated `users.email` first and then read the
 * user back, so the comparison `user.email !== newEmail` was always false and the
 * notification (and `old_email_notified_at`) never happened.
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-email-change';
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

let mail: ReturnType<typeof useMemoryEmail>;

beforeEach(() => {
  mail = useMemoryEmail();
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

describe('Security - email change notifies the old address (spec 14)', () => {
  it('確認後、旧メールアドレスへ変更通知を送り old_email_notified_at を記録する', async () => {
    const oldEmail = `${uniq('old')}@example.com`;
    const newEmail = `${uniq('new')}@example.com`;
    const userId = await makeUser(oldEmail);

    const { raw, hash, id } = generateToken();
    await insertEmailChangeRequest({
      id,
      userId,
      tokenHash: hash,
      purpose: 'email_change',
      newEmail,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const response = await confirmEmailChange(confirmRequest(raw));
    expect(response.status).toBe(200);

    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row!.email).toBe(newEmail);

    // The notification must go to the OLD address, not the new one.
    const toOld = mail.outbox.filter((email) => email.to === oldEmail);
    expect(toOld).toHaveLength(1);

    const [request] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.id, id))
      .limit(1);
    expect(request!.oldEmailNotifiedAt).not.toBeNull();
  });
});
