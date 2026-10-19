import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter, type FailedAttemptReservation } from '@/lib/auth/rate-limit';
import { createSession, getRequestClientIp } from '@/lib/auth/session';
import { buildClearedSocialClaimCookie, getSocialClaimCookieName, setAnonCookie, setSessionCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { verifyPassword } from '@/lib/auth/password';
import { findUserByEmailOrUsername } from '@/lib/db/queries/users';
import { ApiError } from '@/lib/errors';
import { consumeSocialClaim, peekSocialClaim } from '@/lib/auth/oauth/social-claim';
import { createSocialUser } from '@/lib/auth/oauth/complete-login';
import { createAccount, findAccountByProviderAccountId, touchAccountLastUsed } from '@/lib/auth/oauth/accounts';
import { notifyAccountChange, isFirstSessionFromDevice, notifyNewDeviceLogin } from '@/lib/auth/notifications';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
import { socialConfirmBodySchema } from '@/lib/validate/oauth';
import type { User } from '@/lib/db/schema';
import type { SocialClaim } from '@/lib/auth/oauth/social-claim';

export const dynamic = 'force-dynamic';

/**
 * ソーシャル連携の完了（Phase 4-B / §4.3）。
 *
 * `action: 'signup'`   … この email で social-only ユーザーを作る
 * `action: 'password'` … この email の password でログインし、連携する
 *
 * ★ 乗っ取り防御の中核（D-32-03 / D-32-18）:
 * - **password でログインできるのは `claim.emailOwnerId` のアカウントだけ**。
 *   email が一致しない・ユーザー名で代用した場合は 401。連携もログインも
 *   「social の email を持つアカウントで証明できた場合」だけ成立する。
 * - 完了時にも `(provider, provider_account_id)` を再確認する（TOCTOU・D-32-08）。
 *
 * ★ claim の消費タイミング（BUG-15）:
 * **peek → 検証 → 成功確定直前で消費** の順にする。先に消費すると、
 * password 誤り・通信断・CSRF の再送のたびに claim を失い、用户在
 * OAuth の最初からやり直すことになる。成功するまでは claim を残す。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: false }, async ({ body }) => {
    const parsed = socialConfirmBodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'リクエストの内容が不正です');
    const { action, password, identifier } = parsed.data;

    // claim token は **リクエストから**読む。`cookies()`（request scope）に依存しない。
    const token = request.cookies.get(getSocialClaimCookieName())?.value ?? null;
    if (!token) throw new ApiError('INVALID_STATE');

    const found = await findClaim(token);
    if (!found) throw new ApiError('INVALID_STATE');
    const { provider, claim } = found;

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';
    const providerLabel = OAUTH_PROVIDER_REGISTRY.find((p) => p.id === provider)?.label ?? provider;
    const base = { request, provider, claim, ip, userAgent, providerLabel };

    if (action === 'signup') {
      const created = await prepareSignup(base);
      await consumeClaimOrThrow(token, provider);
      await commitSignup({ ...base, created });
      return redirectToPath('/', true);
    }

    const verified = await verifyLogin({ ...base, identifier: identifier ?? '', password: password ?? '' });
    // ★ ここまで来て初めて claim を消費する（password が合って初めて）
    await consumeClaimOrThrow(token, provider);
    await commitLink({ ...base, user: verified.user });
    return redirectToPath('/', true);
  });
}

/** provider を引かず token だけで claim を探す（画面と完了 API の判定を揃える）。 */
async function findClaim(token: string): Promise<{ provider: SocialClaim['provider']; claim: SocialClaim } | null> {
  for (const provider of OAUTH_PROVIDER_REGISTRY) {
    const claim = await peekSocialClaim(token, provider.id);
    if (claim) return { provider: claim.provider, claim };
  }
  return null;
}

/** 2 つ目のリクエスト（リトライや並列送信）が来ても 1 度だけ通す。 */
async function consumeClaimOrThrow(token: string, provider: SocialClaim['provider']): Promise<void> {
  const consumed = await consumeSocialClaim(token, provider);
  if (!consumed) throw new ApiError('INVALID_STATE');
}

type ClaimInput = {
  request: NextRequest;
  provider: SocialClaim['provider'];
  claim: SocialClaim;
  ip: string;
  userAgent: string;
  providerLabel: string;
};

// ---------- signup ----------

async function prepareSignup(args: ClaimInput): Promise<{ user: User; accountId: string }> {
  const { claim } = args;

  if (!claim.emailVerified || !claim.providerEmail) {
    await recordSecurityEvent('login_failed', null, args.ip, args.userAgent, {
      provider: args.provider,
      error: 'email_not_verified',
    });
    throw new ApiError('ACCOUNT_NOT_LINKABLE');
  }
  if (claim.emailOwnerId) {
    // 発行時点では未所有だったのに所有者が現えた（競合）。email では統合しない。
    throw new ApiError('EMAIL_CONFLICT');
  }
  await assertNotAlreadyLinked(args.provider, claim.providerAccountId);

  return createSocialUser({
    provider: args.provider,
    identity: {
      providerAccountId: claim.providerAccountId,
      email: claim.providerEmail,
      emailVerified: claim.emailVerified,
      displayName: null,
    },
  });
}

async function commitSignup(args: ClaimInput & { created: { user: User; accountId: string } }): Promise<void> {
  const { created, provider, ip, userAgent } = args;
  await issueSession(args.request, created.user, ip, userAgent);
  await recordSecurityEvent('register', created.user.id, ip, userAgent, { provider });
  await recordSecurityEvent('oauth_linked', created.user.id, ip, userAgent, { provider });
}

// ---------- password ----------

async function verifyLogin(args: ClaimInput & { identifier: string; password: string }): Promise<{ user: User }> {
  const { claim, identifier, password, ip, userAgent, provider } = args;

  // ★ 連携の相手がいない場合は、この画面では password ログインさせない（D-32-18）
  if (!claim.emailOwnerId) throw new ApiError('ACCOUNT_LINK_OWNER_MISMATCH');
  await assertNotAlreadyLinked(provider, claim.providerAccountId);

  const reservations: FailedAttemptReservation[] = [];
  const release = async () => {
    await Promise.all(
      reservations.map((reservation) => rateLimiter.releaseReservation(reservation).catch(() => undefined)),
    );
  };

  try {
    // 既存の login 系レート制限をそのまま使う（account 単位の試行制限が効く・D-32-09）
    const ipLimit = await rateLimiter.check(
      rateLimitKeys.loginIp(ip),
      RATE_LIMITS.login.ip.window,
      RATE_LIMITS.login.ip.limit,
      RATE_LIMITS.login.ip.softLimit,
    );
    if (!ipLimit.allowed) {
      if (ipLimit.logRateLimited) {
        await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'social_confirm_ip' });
      }
      throw new ApiError('RATE_LIMITED');
    }

    for (const [key, limit] of [
      [rateLimitKeys.loginAccount(identifier), RATE_LIMITS.login.account],
      [rateLimitKeys.loginIpAccount(ip, identifier), RATE_LIMITS.login.ipAccount],
    ] as const) {
      const result = await rateLimiter.reserveFailedAttempt(key, limit.window, limit.limit, limit.softLimit);
      if (!result.allowed) {
        await release();
        throw new ApiError('RATE_LIMITED');
      }
      reservations.push(result.reservation);
    }

    const user = await findUserByEmailOrUsername(identifier);
    const passwordOk = user ? await verifyPassword(password, user.passwordHash ?? '') : false;

    // ★ `user.id !== claim.emailOwnerId` なら 401。email 入力を差し替えるだけで
    // 同じ password を使う別アカウントに入れるのを防ぐ（D-32-18）。
    // reason は返さないので列挙攻撃の材料にならない。
    if (!user || !passwordOk || user.id !== claim.emailOwnerId) {
      const reached = await Promise.all(
        reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, false)),
      );
      if (reached.some(Boolean)) {
        await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'social_confirm_failed' });
      }
      await recordSecurityEvent('login_failed', null, ip, userAgent, { provider });
      throw new ApiError('INVALID_CREDENTIALS');
    }

    await Promise.all(reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, true)));

    if (user.status !== 'active') {
      await recordSecurityEvent('login_failed', user.id, ip, userAgent, { provider });
      throw new ApiError('ACCOUNT_SUSPENDED');
    }

    return { user };
  } finally {
    await release();
  }
}

async function commitLink(args: ClaimInput & { user: User }): Promise<void> {
  const { claim, provider, user, ip, userAgent } = args;

  const account = await createAccount({
    userId: user.id,
    provider,
    providerAccountId: claim.providerAccountId,
    providerEmail: claim.providerEmail,
  });
  await touchAccountLastUsed(account.id);
  await recordSecurityEvent('oauth_linked', user.id, ip, userAgent, { provider });
  await notifyAccountChange({
    userId: user.id,
    userEmail: user.email,
    action: 'link',
    provider,
    ip,
    userAgent,
  });
  await issueSession(args.request, user, ip, userAgent);
}

// ---------- 共通 ----------

/** 完了時にも他の誰かが同じ外部 ID を紐付けていないか確認する（TOCTOU・D-32-08）。 */
async function assertNotAlreadyLinked(
  provider: SocialClaim['provider'],
  providerAccountId: string,
): Promise<void> {
  const taken = await findAccountByProviderAccountId(provider, providerAccountId);
  if (taken) throw new ApiError('ACCOUNT_LINKED_ELSEWHERE');
}

/** 完了後は必ず新しいセッションを発行する（セッション固定対策・§6.2 / D-32-10）。 */
async function issueSession(
  request: NextRequest,
  user: User,
  ip: string,
  userAgent: string,
): Promise<void> {
  const { token, session } = await createSession(user.id, request, { reauthVerified: true });
  await setSessionCookie(token);
  await setAnonCookie(session.csrfSecret);

  try {
    const isNewDevice = await isFirstSessionFromDevice(
      user.id,
      session.id,
      session.ipHash,
      session.deviceName,
    );
    if (isNewDevice) {
      await notifyNewDeviceLogin({
        userId: user.id,
        userEmail: user.email,
        deviceName: session.deviceName,
        ipMasked: session.ipMasked,
        ipCountry: null,
        occurredAt: new Date(),
        ip,
        userAgent,
      });
    }
  } catch {
    // 通知の失敗でログインを失敗させない（best-effort）
  }
}

function redirectToPath(path: string, clearClaim = false): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';
  return NextResponse.redirect(new URL(path, base), {
    status: 303,
    headers: {
      'Cache-Control': 'no-store',
      // 完了したら claim を消す（使い切り・D-32-06）
      ...(clearClaim ? { 'Set-Cookie': buildClearedSocialClaimCookie() } : {}),
    },
  });
}