import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAndConsumeTotp = vi.hoisted(() => vi.fn());
const consumeRecoveryCode = vi.hoisted(() => vi.fn());
const countCredentialsByUser = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/totp', () => ({ verifyAndConsumeTotp }));
vi.mock('@/lib/auth/recovery-codes', () => ({ consumeRecoveryCode }));
vi.mock('@/lib/db/queries/webauthn', () => ({
  countCredentialsByUser,
  findCredentialByCredentialId: vi.fn(),
  advanceSignCount: vi.fn(),
}));

import {
  availableStrongReauthMethods,
  requireStrongReauth,
  strongReauthVerifiers,
  type StrongReauthVerifier,
} from '@/lib/auth/strong-reauth';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

const user = { id: 'usr_1', username: 'alice', email: 'alice@example.com' } as unknown as User;

function session(reauthVerifiedAt: string | null): SessionData {
  return {
    id: 'ses_1',
    userId: 'usr_1',
    sessionHash: 'hash',
    csrfSecret: 'csrf',
    userAgent: 'vitest',
    ip: '203.0.113.10',
    ipMasked: '203.0.113.xxx',
    ipHash: 'iphash',
    deviceName: 'vitest',
    reauthVerifiedAt,
    totpPending: false,
  };
}

const reauthed = session(new Date().toISOString());
const notReauthed = session(null);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('availableStrongReauthMethods', () => {
  it('Passkey が無ければ ["password"]', async () => {
    countCredentialsByUser.mockResolvedValue(0);
    expect(await availableStrongReauthMethods(user)).toEqual(['password']);
  });

  it('Passkey が 1 件以上あれば ["password", "passkey"]（D-34-11）', async () => {
    countCredentialsByUser.mockResolvedValue(2);
    expect(await availableStrongReauthMethods(user)).toEqual(['password', 'passkey']);
  });
});

describe('requireStrongReauth', () => {
  it('再認証未了・コードなしなら REAUTH_REQUIRED（コードを消費しない）', async () => {
    await expect(
      requireStrongReauth({ user, session: notReauthed, body: { code: '123456' } }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED', status: 401 });
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('再認証済み ＋ 正しい TOTP コードで成功（method=password）', async () => {
    verifyAndConsumeTotp.mockResolvedValue({ ok: true });
    const result = await requireStrongReauth({ user, session: reauthed, body: { code: '123456' } });
    expect(result).toEqual({ method: 'password' });
    expect(verifyAndConsumeTotp).toHaveBeenCalledWith({ userId: 'usr_1', code: '123456' });
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('再認証済み ＋ コード誤りは 400 INVALID_CODE', async () => {
    verifyAndConsumeTotp.mockResolvedValue({ ok: false, reason: 'invalid' });
    await expect(
      requireStrongReauth({ user, session: reauthed, body: { code: '000000' } }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });

  it('6 桁でないコードはリカバリーコードとして扱う', async () => {
    consumeRecoveryCode.mockResolvedValue(true);
    const result = await requireStrongReauth({
      user,
      session: reauthed,
      body: { code: 'ABCDE-FGHIJ-KLMNO-PQRST' },
    });
    expect(result).toEqual({ method: 'password' });
    expect(consumeRecoveryCode).toHaveBeenCalledWith('usr_1', 'ABCDE-FGHIJ-KLMNO-PQRST');
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
  });

  it('リカバリーコードが誤りでも 400 INVALID_CODE', async () => {
    consumeRecoveryCode.mockResolvedValue(false);
    await expect(
      requireStrongReauth({ user, session: reauthed, body: { code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' } }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });
});

describe('検証器配列（D-33-24 / D-34-11）', () => {
  it('Phase 6 の既定配列は 2 件（password → passkey）', () => {
    expect(strongReauthVerifiers).toHaveLength(2);
  });

  it('Passkey 検証器だけを渡すと、それだけで通る（method=passkey）', async () => {
    const passkeyVerifier: StrongReauthVerifier = async () => 'passkey';
    const result = await requireStrongReauth(
      { user, session: notReauthed, body: {} },
      [passkeyVerifier],
    );
    expect(result).toEqual({ method: 'passkey' });
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('先頭の検証器が null でも後続の検証器が成功すれば通る', async () => {
    const failing: StrongReauthVerifier = async () => null;
    const succeeding: StrongReauthVerifier = async () => 'passkey';
    const result = await requireStrongReauth(
      { user, session: notReauthed, body: {} },
      [failing, succeeding],
    );
    expect(result).toEqual({ method: 'passkey' });
  });

  it('どの検証器も通らず再認証未了なら REAUTH_REQUIRED', async () => {
    const failing: StrongReauthVerifier = async () => null;
    await expect(
      requireStrongReauth({ user, session: notReauthed, body: {} }, [failing]),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('どの検証器も通らず再認証済みなら INVALID_CODE', async () => {
    const failing: StrongReauthVerifier = async () => null;
    await expect(
      requireStrongReauth({ user, session: reauthed, body: { code: 'x' } }, [failing]),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });
});
