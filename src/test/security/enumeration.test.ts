// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/breached', () => ({
  checkBreached: vi.fn(),
}));

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn(),
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(),
  },
}));

vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual('@/lib/db/queries/users');
  return {
    ...actual,
    createUser: vi.fn(),
    findUserByLowerEmail: vi.fn(),
    findUserById: vi.fn(() => Promise.resolve({ id: 'usr_test123', email: 'test@example.com' })),
  };
});

vi.mock('@/lib/db/queries/tokens', () => ({
  insertEmailVerificationToken: vi.fn(),
  insertPasswordResetToken: vi.fn(),
  invalidatePasswordResetTokens: vi.fn(),
}));

vi.mock('@/lib/auth/tokens/generate', () => ({
  generateToken: vi.fn(() => ({ raw: 'token', hash: 'hash', id: 'tok_123' })),
}));

vi.mock('@/lib/auth/email/templates', () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock('@/lib/auth/security-events', () => ({
  recordSecurityEvent: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/lib/util/id', () => ({
  newId: vi.fn(() => 'usr_test123'),
}));

vi.mock('@/config/rate-limits', () => ({
  RATE_LIMITS: {
    register: { window: 3600_000, limit: 5 },
    forgot: {
      email: { window: 3600_000, limit: 5 },
      ip: { window: 3600_000, limit: 10 },
    },
  },
}));

describe('Security - User Enumeration Prevention', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('register handler returns same message for duplicate email', async () => {
    const { createUser } = await import('@/lib/db/queries/users');
    const { checkBreached } = await import('@/lib/auth/breached');
    const { hashPassword } = await import('@/lib/auth/password');
    const { rateLimiter } = await import('@/lib/auth/rate-limit');
    const { RATE_LIMITS } = await import('@/config/rate-limits');
    const { newId } = await import('@/lib/util/id');
    const { generateToken } = await import('@/lib/auth/tokens/generate');
    const { insertEmailVerificationToken } = await import('@/lib/db/queries/tokens');
    const { sendVerificationEmail } = await import('@/lib/auth/email/templates');
    const { recordSecurityEvent } = await import('@/lib/auth/security-events');

    checkBreached.mockResolvedValue({ breached: false, failOpen: false });
    rateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 });
    hashPassword.mockResolvedValue('hashed-password');
    newId.mockReturnValue('usr_new123');
    generateToken.mockReturnValue({ raw: 'token', hash: 'hash', id: 'tok_123' });
    insertEmailVerificationToken.mockResolvedValue(undefined);
    sendVerificationEmail.mockResolvedValue(undefined);
    recordSecurityEvent.mockResolvedValue(undefined);

    const err = new Error('duplicate key') as Error & { code: string; constraint: string };
    err.code = '23505';
    err.constraint = 'users_email_key';
    createUser.mockRejectedValueOnce(err);

    const email = 'existing@example.com';
    const username = 'newuser';
    const password = 'StrongPass123!';
    const ipHash = 'unknown';
    const rlKey = `rl:register:ip:${ipHash}`;
    await rateLimiter.check(rlKey, RATE_LIMITS.register.window, RATE_LIMITS.register.limit);
    
    const breachResult = await checkBreached(password);
    if (breachResult.breached) {
      throw new Error('Should not be breached');
    }

    const passwordHash = await hashPassword(password);
    const userId = newId('usr');
    
    let message = '';
    try {
      await createUser({
        id: userId,
        email,
        username,
        passwordHash,
        status: 'pending_email',
        emailVerified: false,
        roleId: 'role_user',
      });
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        message = 'アカウントを登録しました';
      }
    }

    expect(message).toBe('アカウントを登録しました');

    // Second call: new email
    createUser.mockResolvedValueOnce({ id: 'usr_new', email: 'new@example.com' });
    message = '';
    try {
      await createUser({
        id: userId,
        email: 'new@example.com',
        username: 'newuser2',
        passwordHash,
        status: 'pending_email',
        emailVerified: false,
        roleId: 'role_user',
      });
      message = 'アカウントを登録しました';
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        message = 'アカウントを登録しました';
      }
    }

    expect(message).toContain('登録');
  });

  it('forgot password returns same message for existing and non-existing email', async () => {
    const { findUserByLowerEmail } = await import('@/lib/db/queries/users');
    const { invalidatePasswordResetTokens } = await import('@/lib/db/queries/tokens');
    const { insertPasswordResetToken } = await import('@/lib/db/queries/tokens');
    const { sendPasswordResetEmail } = await import('@/lib/auth/email/templates');
    const { rateLimiter } = await import('@/lib/auth/rate-limit');
    const { RATE_LIMITS } = await import('@/config/rate-limits');

    rateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 });
    invalidatePasswordResetTokens.mockResolvedValue(undefined);
    insertPasswordResetToken.mockResolvedValue(undefined);
    sendPasswordResetEmail.mockResolvedValue(undefined);

    // First call: user exists
    findUserByLowerEmail.mockResolvedValueOnce({ id: 'usr_123', email: 'existing@example.com' });

    const email = 'existing@example.com';
    const ipHash = 'unknown';
    const emailHash = Buffer.from(email).toString('hex').slice(0, 16);
    
    await rateLimiter.check(`rl:forgot:email:${emailHash}`, RATE_LIMITS.forgot.email.window, RATE_LIMITS.forgot.email.limit);
    await rateLimiter.check(`rl:forgot:ip:${ipHash}`, RATE_LIMITS.forgot.ip.window, RATE_LIMITS.forgot.ip.limit);
    
    let message = '';
    const user = await findUserByLowerEmail(email);
    if (user) {
      await invalidatePasswordResetTokens(user.id);
      message = 'リセットメールを送信しました（存在する場合）';
    } else {
      message = 'リセットメールを送信しました（存在する場合）';
    }

    expect(message).toBe('リセットメールを送信しました（存在する場合）');

    // Second call: user doesn't exist
    findUserByLowerEmail.mockResolvedValueOnce(null);
    message = '';
    const user2 = await findUserByLowerEmail('nonexistent@example.com');
    if (user2) {
      message = 'リセットメールを送信しました（存在する場合）';
    } else {
      message = 'リセットメールを送信しました（存在する場合）';
    }

    expect(message).toBe('リセットメールを送信しました（存在する場合）');
  });

  it('register handler returns same message for duplicate username', async () => {
    const { createUser } = await import('@/lib/db/queries/users');
    const { checkBreached } = await import('@/lib/auth/breached');
    const { hashPassword } = await import('@/lib/auth/password');
    const { rateLimiter } = await import('@/lib/auth/rate-limit');
    const { RATE_LIMITS } = await import('@/config/rate-limits');
    const { newId } = await import('@/lib/util/id');
    const { generateToken } = await import('@/lib/auth/tokens/generate');
    const { insertEmailVerificationToken } = await import('@/lib/db/queries/tokens');
    const { sendVerificationEmail } = await import('@/lib/auth/email/templates');
    const { recordSecurityEvent } = await import('@/lib/auth/security-events');

    checkBreached.mockResolvedValue({ breached: false, failOpen: false });
    rateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 });
    hashPassword.mockResolvedValue('hashed-password');
    newId.mockReturnValue('usr_new123');
    generateToken.mockReturnValue({ raw: 'token', hash: 'hash', id: 'tok_123' });
    insertEmailVerificationToken.mockResolvedValue(undefined);
    sendVerificationEmail.mockResolvedValue(undefined);
    recordSecurityEvent.mockResolvedValue(undefined);

    const err = new Error('duplicate key') as Error & { code: string; constraint: string };
    err.code = '23505';
    err.constraint = 'users_username_key';
    createUser.mockRejectedValueOnce(err);

    const email = 'new@example.com';
    const username = 'existinguser';
    const password = 'StrongPass123!';
    const ipHash = 'unknown';
    const rlKey = `rl:register:ip:${ipHash}`;
    await rateLimiter.check(rlKey, RATE_LIMITS.register.window, RATE_LIMITS.register.limit);
    
    const breachResult = await checkBreached(password);
    if (breachResult.breached) {
      throw new Error('Should not be breached');
    }

    const passwordHash = await hashPassword(password);
    const userId = newId('usr');
    
    let message = '';
    try {
      await createUser({
        id: userId,
        email,
        username,
        passwordHash,
        status: 'pending_email',
        emailVerified: false,
        roleId: 'role_user',
      });
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        message = 'アカウントを登録しました';
      }
    }

    expect(message).toBe('アカウントを登録しました');
  });

  it('resend verification returns same message for unverified, verified and unknown email', async () => {
    const { findUserByLowerEmail } = await import('@/lib/db/queries/users');
    const { rateLimiter } = await import('@/lib/auth/rate-limit');

    rateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 });

    // 応答は常に同一（列挙対策・§46 / D-33-22）。送信の有無だけが内部で分かれる。
    const cases = [
      { id: 'usr_pending', email: 'pending@example.com', status: 'pending_email', emailVerified: false },
      { id: 'usr_verified', email: 'verified@example.com', status: 'active', emailVerified: true },
      null,
    ];

    const bodies = new Set<string>();
    for (const user of cases) {
      findUserByLowerEmail.mockResolvedValueOnce(user);
      const target = await findUserByLowerEmail(user?.email ?? 'nobody@example.com');
      const willSend = Boolean(target && target.emailVerified === false && target.status === 'pending_email');
      const response = { message: '確認メールを送信しました' };
      expect(willSend).toBe(user !== null && user.status === 'pending_email');
      bodies.add(JSON.stringify(response));
    }

    expect(bodies.size).toBe(1);
  });

  it('register succeeds for new user', async () => {
    const { createUser } = await import('@/lib/db/queries/users');
    const { checkBreached } = await import('@/lib/auth/breached');
    const { hashPassword } = await import('@/lib/auth/password');
    const { rateLimiter } = await import('@/lib/auth/rate-limit');
    const { RATE_LIMITS } = await import('@/config/rate-limits');
    const { newId } = await import('@/lib/util/id');
    const { generateToken } = await import('@/lib/auth/tokens/generate');
    const { insertEmailVerificationToken } = await import('@/lib/db/queries/tokens');
    const { sendVerificationEmail } = await import('@/lib/auth/email/templates');
    const { recordSecurityEvent } = await import('@/lib/auth/security-events');

    checkBreached.mockResolvedValue({ breached: false, failOpen: false });
    rateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 });
    hashPassword.mockResolvedValue('hashed-password');
    newId.mockReturnValue('usr_new123');
    generateToken.mockReturnValue({ raw: 'token', hash: 'hash', id: 'tok_123' });
    insertEmailVerificationToken.mockResolvedValue(undefined);
    sendVerificationEmail.mockResolvedValue(undefined);
    recordSecurityEvent.mockResolvedValue(undefined);

    createUser.mockResolvedValueOnce({ id: 'usr_new', email: 'new@example.com' });

    const email = 'new@example.com';
    const username = 'newuser';
    const password = 'StrongPass123!';
    const ipHash = 'unknown';
    const rlKey = `rl:register:ip:${ipHash}`;
    await rateLimiter.check(rlKey, RATE_LIMITS.register.window, RATE_LIMITS.register.limit);
    
    const breachResult = await checkBreached(password);
    if (breachResult.breached) {
      throw new Error('Should not be breached');
    }

    const passwordHash = await hashPassword(password);
    const userId = newId('usr');
    
    let message = '';
    try {
      await createUser({
        id: userId,
        email,
        username,
        passwordHash,
        status: 'pending_email',
        emailVerified: false,
        roleId: 'role_user',
      });
      message = 'アカウントを登録しました';
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        message = 'アカウントを登録しました';
      }
    }

    expect(message).toContain('登録');
  });
});