import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAndConsumeTotp = vi.hoisted(() => vi.fn());
const consumeRecoveryCode = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/totp', () => ({ verifyAndConsumeTotp }));
vi.mock('@/lib/auth/recovery-codes', () => ({ consumeRecoveryCode }));

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
  it('Phase 5 は ["password"] を返す', () => {
    expect(availableStrongReauthMethods(user)).toEqual(['password']);
  });
});

describe('requireStrongReauth', () => {
  it('再認証未了なら REAUTH_REQUIRED（コードを消費しない）', async () => {
    await expect(
      requireStrongReauth({ user, session: notReauthed, code: '123456' }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED', status: 401 });
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('再認証済み ＋ 正しい TOTP コードで成功（method=password）', async () => {
    verifyAndConsumeTotp.mockResolvedValue({ ok: true });
    const result = await requireStrongReauth({ user, session: reauthed, code: '123456' });
    expect(result).toEqual({ method: 'password' });
    expect(verifyAndConsumeTotp).toHaveBeenCalledWith({ userId: 'usr_1', code: '123456' });
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('再認証済み ＋ コード誤りは 400 INVALID_CODE', async () => {
    verifyAndConsumeTotp.mockResolvedValue({ ok: false, reason: 'invalid' });
    await expect(
      requireStrongReauth({ user, session: reauthed, code: '000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });

  it('6 桁でないコードはリカバリーコードとして扱う', async () => {
    consumeRecoveryCode.mockResolvedValue(true);
    const result = await requireStrongReauth({ user, session: reauthed, code: 'ABCDE-FGHIJ-KLMNO-PQRST' });
    expect(result).toEqual({ method: 'password' });
    expect(consumeRecoveryCode).toHaveBeenCalledWith('usr_1', 'ABCDE-FGHIJ-KLMNO-PQRST');
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
  });

  it('リカバリーコードが誤りでも 400 INVALID_CODE', async () => {
    consumeRecoveryCode.mockResolvedValue(false);
    await expect(
      requireStrongReauth({ user, session: reauthed, code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE', status: 400 });
  });
});

describe('検証器配列の拡張点（Phase 6 の布石・D-33-24）', () => {
  it('Phase 5 の既定配列は 1 件', () => {
    expect(strongReauthVerifiers).toHaveLength(1);
  });

  it('テスト用の 2 つ目の検証器を足すと、それだけで通る（ルート無変更）', async () => {
    // パスワード＋コードを一切使わない「Passkey 相当」の検証器。
    const passkeyVerifier: StrongReauthVerifier = async ({ code }) => code === 'PASSKEY-ASSERTION';

    const result = await requireStrongReauth(
      { user, session: notReauthed, code: 'PASSKEY-ASSERTION' },
      [passkeyVerifier],
    );

    expect(result).toEqual({ method: 'password' });
    // パスワード検証器は使われていない（= Passkey 単独で成立）
    expect(verifyAndConsumeTotp).not.toHaveBeenCalled();
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('先頭の検証器が false でも後続の検証器が成功すれば通る', async () => {
    const failing: StrongReauthVerifier = async () => false;
    const succeeding: StrongReauthVerifier = async () => true;
    const result = await requireStrongReauth(
      { user, session: reauthed, code: 'x' },
      [failing, succeeding],
    );
    expect(result).toEqual({ method: 'password' });
  });

  it('どの検証器も通らなければ INVALID_CODE', async () => {
    const failing: StrongReauthVerifier = async () => false;
    await expect(
      requireStrongReauth({ user, session: reauthed, code: 'x' }, [failing]),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });
});
