import { afterEach, describe, expect, it } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { getDb } from '@/lib/db/client';
import { eq } from 'drizzle-orm';
import { totp } from '@/lib/db/schema';
import { createUser, softDeleteUser } from '@/lib/db/queries/users';
import {
  generateTotpSecret,
  verifyAndConsumeTotp,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '@/lib/auth/totp';
import { upsertTotpPending, enableTotp, findTotpByUserId } from '@/lib/db/queries/totp';
import { decryptTotpSecret } from '@/lib/auth/totp-crypto';

/**
 * Phase 5: TOTP 2FA（実 PostgreSQL）。
 *
 * 有効化は setup（保留行 enabled=false）→ verify の 2 段。`verifyAndConsumeTotp` は
 * 通常検証では有効行のみを対象にするが、有効化フローでは保留行を検証する必要がある
 * （`allowPending`）。この境界を固定する。
 */

const createdUsers: string[] = [];
let seq = 0;

async function newUser(tag: string): Promise<string> {
  const id = `usr_${tag}${Date.now().toString(36)}${(seq += 1)}`;
  await createUser({ id, email: `${id}@example.com`, username: id, emailVerified: true, status: 'active', roleId: 'role_user' });
  createdUsers.push(id);
  return id;
}

function codeFor(base32: string, timestamp: number): string {
  return new TOTP({ secret: Secret.fromBase32(base32), digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS, algorithm: 'SHA1' }).generate({ timestamp });
}

afterEach(async () => {
  const db = getDb();
  for (const userId of createdUsers) {
    await db.delete(totp).where(eq(totp.userId, userId));
    await softDeleteUser(userId);
  }
  createdUsers.length = 0;
});

describe('Security - TOTP 2FA', () => {
  it('setup で保存した secret は暗号化され、復号すると base32 に戻る', async () => {
    const userId = await newUser('enc');
    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);

    const row = await findTotpByUserId(userId);
    expect(row).not.toBeNull();
    expect(row!.secretEncrypted).not.toContain(base32);
    expect(decryptTotpSecret(row!.secretEncrypted)).toBe(base32);
    expect(row!.enabled).toBe(false);
  });

  it('有効化フロー: enabled=false の保留行でも正しいコードで消費できる（allowPending）', async () => {
    const userId = await newUser('enable');
    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);

    const now = Date.now();
    const result = await verifyAndConsumeTotp({ userId, code: codeFor(base32, now), now: new Date(now), allowPending: true });
    expect(result.ok).toBe(true);

    await enableTotp(userId);
    const row = await findTotpByUserId(userId);
    expect(row!.enabled).toBe(true);
    expect(row!.confirmedAt).not.toBeNull();
  });

  it('通常検証: 有効化前の保留行は allowPending 無しでは拒否される（回帰防止）', async () => {
    const userId = await newUser('pending');
    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);

    const now = Date.now();
    const result = await verifyAndConsumeTotp({ userId, code: codeFor(base32, now), now: new Date(now) });
    expect(result.ok).toBe(false);
    // 失敗時に enabled へ切り替わっていないこと
    const row = await findTotpByUserId(userId);
    expect(row!.enabled).toBe(false);
  });

  it('誤ったコードは拒否される', async () => {
    const userId = await newUser('wrong');
    const { encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);
    await enableTotp(userId);

    const result = await verifyAndConsumeTotp({ userId, code: '000000' });
    expect(result.ok).toBe(false);
  });

  it('同じコードの並行送信は 1 本だけ成功する（T3 / D-33-04）', async () => {
    const userId = await newUser('race');
    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);
    await enableTotp(userId);

    const now = Date.now();
    const code = codeFor(base32, now);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyAndConsumeTotp({ userId, code, now: new Date(now) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('last_used_counter の巻き戻し（古い counter）は拒否される（T13）', async () => {
    const userId = await newUser('rollback');
    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(userId, encrypted);
    await enableTotp(userId);

    const now = Date.now();
    const current = codeFor(base32, now);
    const previous = codeFor(base32, now - TOTP_PERIOD_SECONDS * 1000);

    expect((await verifyAndConsumeTotp({ userId, code: current, now: new Date(now) })).ok).toBe(true);
    // 古い counter は last_used_counter < c を満たさない → 拒否
    expect((await verifyAndConsumeTotp({ userId, code: previous, now: new Date(now) })).ok).toBe(false);
  });

  it('TOTP 行が無いユーザーは検証できない', async () => {
    const userId = await newUser('none');
    const result = await verifyAndConsumeTotp({ userId, code: '123456' });
    expect(result.ok).toBe(false);
  });
});
