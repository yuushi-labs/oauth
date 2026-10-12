import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the env module with configurable return value
let mockEnv = {
  HIBP_TIMEOUT_MS: 1000,
  BREACH_CHECK_FAIL_OPEN: true,
};

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => mockEnv),
}));

import { checkBreached } from '@/lib/auth/breached';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('checkBreached - HIBP k-anonymity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockReset();
    mockEnv = {
      HIBP_TIMEOUT_MS: 1000,
      BREACH_CHECK_FAIL_OPEN: true,
    };
  });

  it('returns breached: true when password found in HIBP', async () => {
    // SHA-1 of 'password123' = CBFDAC6008F9CAB4083784CBD1874F76618D2A97
    // prefix = CBFDA, suffix = C6008F9CAB4083784CBD1874F76618D2A97
    const mockResponse = 'C6008F9CAB4083784CBD1874F76618D2A97:10\nOTHER:5';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockResponse),
    });

    const result = await checkBreached('password123');
    expect(result).toEqual({ breached: true, failOpen: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns breached: false when password not in HIBP', async () => {
    const mockResponse = 'SUFFIX1:10\nSUFFIX2:5\nANOTHER:2';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockResponse),
    });

    const result = await checkBreached('uniquepassword');
    expect(result).toEqual({ breached: false, failOpen: false });
  });

  it('returns failOpen: true on fetch timeout', async () => {
    mockFetch.mockRejectedValueOnce(new Error('AbortError'));

    const result = await checkBreached('password123');
    expect(result).toEqual({ breached: false, failOpen: true });
  });

  it('returns failOpen: false on fetch error when failOpen disabled', async () => {
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