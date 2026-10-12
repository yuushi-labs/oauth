// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { getDb } from '@/lib/db/client';

vi.mock('@/lib/db/client', async () => {
  const actual = await vi.importActual('@/lib/db/client');
  return {
    ...actual,
    getDb: vi.fn(() => ({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    })),
  };
});

describe('Security - Token Reuse Prevention', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('verifyAndConsumeToken rejects already consumed token', async () => {
    const { getDb } = await import('@/lib/db/client');
    getDb.mockReturnValueOnce({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ 
          id: 'tok_123', userId: 'usr_test123', tokenHash: 'hashed-token', usedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) 
        }])) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    });

    const result = await verifyAndConsumeToken('hashed-token', 'email_verification');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('already_used');
  });

  it('verifyAndConsumeToken rejects expired token', async () => {
    const { getDb } = await import('@/lib/db/client');
    getDb.mockReturnValueOnce({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ 
          id: 'tok_123', userId: 'usr_test123', tokenHash: 'hashed-token', usedAt: null, expiresAt: new Date(Date.now() - 3600000) 
        }])) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    });

    const result = await verifyAndConsumeToken('hashed-token', 'email_verification');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('verifyAndConsumeToken consumes valid token', async () => {
    const { getDb } = await import('@/lib/db/client');
    getDb.mockReturnValueOnce({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ 
          id: 'tok_123', userId: 'usr_test123', tokenHash: 'hashed-token', usedAt: null, expiresAt: new Date(Date.now() + 3600000) 
        }])) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    });

    const result = await verifyAndConsumeToken('hashed-token', 'email_verification');
    expect(result.valid).toBe(true);
    expect(result.userId).toBe('usr_test123');
  });

  it('verifyAndConsumeToken returns invalid for non-existent token', async () => {
    const { getDb } = await import('@/lib/db/client');
    getDb.mockReturnValueOnce({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    });

    const result = await verifyAndConsumeToken('hashed-nonexistent', 'email_verification');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('concurrent consume attempts only succeed once', async () => {
    let callCount = 0;
    const { getDb } = await import('@/lib/db/client');
    getDb.mockImplementation(() => ({
      transaction: vi.fn(async (fn) => fn({
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ 
          limit: vi.fn(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve([{ 
                id: 'tok_123', userId: 'usr_test123', tokenHash: 'hashed-token', usedAt: null, expiresAt: new Date(Date.now() + 3600000) 
              }]);
            }
            return Promise.resolve([{ 
              id: 'tok_123', userId: 'usr_test123', tokenHash: 'hashed-token', usedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) 
            }]);
          })
        })) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })),
    }));

    const [result1, result2] = await Promise.all([
      verifyAndConsumeToken('hashed-token', 'email_verification'),
      verifyAndConsumeToken('hashed-token', 'email_verification'),
    ]);

    const validResults = [result1, result2].filter(r => r.valid);
    expect(validResults.length).toBe(1);
  });
});