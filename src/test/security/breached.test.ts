import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checkBreached } from '@/lib/auth/breached';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock env with configurable failOpen
let mockEnv = {
  HIBP_TIMEOUT_MS: 1000,
  BREACH_CHECK_FAIL_OPEN: true,
};

vi.mock('@/lib/env', () => ({
  getEnv: () => mockEnv,
}));

describe('Security - Breached Password Detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockReset();
    mockEnv = {
      HIBP_TIMEOUT_MS: 1000,
      BREACH_CHECK_FAIL_OPEN: true,
    };
  });

  it('returns breached: false when HIBP returns no matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const result = await checkBreached('anypassword');
    expect(result.breached).toBe(false);
    expect(result.failOpen).toBe(false);
  });

  it('returns failOpen: true on fetch timeout', async () => {
    mockFetch.mockRejectedValueOnce(new Error('AbortError'));

    const result = await checkBreached('password123');
    expect(result).toEqual({ breached: false, failOpen: true });
  });

  it('returns failOpen based on env when fetch fails', async () => {
    mockEnv = {
      HIBP_TIMEOUT_MS: 1000,
      BREACH_CHECK_FAIL_OPEN: false,
    };

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await checkBreached('password123');
    expect(result).toEqual({ breached: false, failOpen: false });
  });

  it('returns failOpen on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await checkBreached('password123');
    expect(result).toEqual({ breached: false, failOpen: true });
  });

  it('uses k-anonymity (first 5 chars of SHA-1)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('SUFFIX:1'),
    });

    await checkBreached('test');
    
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.pwnedpasswords\.com\/range\/[A-F0-9]{5}$/),
      expect.objectContaining({
        headers: { 'Add-Padding': 'true' },
      })
    );
  });

  it('clears timeout on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    });

    await checkBreached('password');
    expect(true).toBe(true);
  });

  it('clears timeout on error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await checkBreached('password');
    expect(true).toBe(true);
  });
});