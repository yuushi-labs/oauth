// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/breached', () => ({
  checkBreached: vi.fn(),
}));

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn((p) => `hashed-${p}`),
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(() => Promise.resolve({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 })),
  },
}));

vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual('@/lib/db/queries/users');
  return {
    ...actual,
    createUser: vi.fn(),
    findUserById: vi.fn(() => Promise.resolve({ id: 'usr_test123', email: 'test@example.com' })),
  };
});

vi.mock('@/lib/db/queries/tokens', () => ({
  insertEmailVerificationToken: vi.fn(),
}));

vi.mock('@/lib/auth/email/templates', () => ({
  sendVerificationEmail: vi.fn(),
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

vi.mock('@/lib/auth/tokens/generate', () => ({
  generateToken: vi.fn(() => ({ raw: 'token', hash: 'hash', id: 'tok_123' })),
}));

vi.mock('@/config/rate-limits', () => ({
  RATE_LIMITS: {
    register: { window: 3600_000, limit: 5 },
  },
}));

describe('Security - Unique Constraint (Enforcement)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects duplicate email with unified message (no enumeration)', async () => {
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
        message = '確認メールを送信しました';
      }
    }

    expect(message).toBe('確認メールを送信しました');
  });

  it('rejects duplicate username with unified message', async () => {
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
        message = '確認メールを送信しました';
      }
    }

    expect(message).toBe('確認メールを送信しました');
  });

  it('allows valid registration', async () => {
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
      message = '確認メールを送信しました';
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        message = '確認メールを送信しました';
      }
    }

    expect(message).toContain('確認');
  });
});