import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter, type FailedAttemptReservation } from '@/lib/auth/rate-limit';
import { getRequestClientIp } from '@/lib/auth/session';
import { createSession } from '@/lib/auth/session';
import {
  buildClearedSocialClaimCookie,
  getSocialClaimCookieName,
  setSessionCookie,
  setAnonCookie,
} from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { verifyPassword } from '@/lib/auth/password';
import { findUserByEmailOrUsername } from '@/lib/db/queries/users';
import { ApiError } from '@/lib/errors';
import { consumeSocialClaim } from '@/lib/auth/oauth/social-claim';
import { createSocialUser } from '@/lib/auth/oauth/complete-login';
import { findAccountByProviderAccountId, createAccount, touchAccountLastUsed } from '@/lib/auth/oauth/accounts';
import { notifyAccountChange, isFirstSessionFromDevice, notifyNewDeviceLogin } from '@/lib/auth/notifications';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
import { socialConfirmBodySchema } from '@/lib/validate/oauth';
import type { User } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/**
 * ソーシャル連携の完了（Phase 4-B / §4.3）。
 *
 * `action: 'signup'`   … この email で social-only ユーザーを作る
 * `action: 'password'` … password でログインし、**email が claim と一致したときだけ**連携する
 *
 * ★ 乗っ取り防御の中核（D-32-03 / D-32-18）:
 * - **password でログインできるのは `claim.emailOwnerId` のアカウントだけ**。
 *   別の email / ユーザー名でも password が偶然一致してもログインさせない。
 *   同じ password を使うユーザーがいると、email の入力を差し替えただけで
 *   そのアカウントに入れてしまうため（D-32-18）。
 * - つまり連携もログインも **「social の email を持つアカウント」で证明了場合だけ**。
 * - 完了時にも `(provider, provider_account_id)` を再確認する（TOCTOU・D-32-08）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: false }, async ({ body }) => {
    const parsed = socialConfirmBodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR');
    const { action, password, identifier } = parsed.data;

    // claim token は **リクエストから**読む。`cookies()`（request scope）に依存しないので
    // ルートを直接呼ぶテストできる。
    const token = request.cookies.get(getSocialClaimCookieName())?.value ?? null;
    if (!token) throw new ApiError('INVALID_STATE');

    // provider は body から受け取らない。token に紐づく claim から解決する。
    // 遷移や body を改竄しても別 provider の claim にすり替わらない。
    const provider = await detectClaimProvider(token);
    if (!provider) throw new ApiError('INVALID_STATE');

    const claim = await consumeSocialClaim(token, provider);
    if (!claim) throw new ApiError('INVALID_STATE');

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';
    const providerLabel = OAUTH_PROVIDER_REGISTRY.find((p) => p.id === provider)?.label ?? provider;

    if (action === 'signup') {
      return completeSignup({ request, provider, claim, ip, userAgent, providerLabel });
    }
    return completePasswordLogin({
      request,
      provider,
      claim,
      identifier: identifier ?? '',
      password: password ?? '',
      ip,
      userAgent,
      providerLabel,
    });
  });
}

/** claim の token から provider を取り出す（画面も完了処理も同じ判定を使う）。 */
export async function detectClaimProvider(token: string) {
  const { peekSocialClaim } = await import('@/lib/auth/oauth/social-claim');
  const providers = OAUTH_PROVIDER_REGISTRY.map((p) => p.id);
  for (const id of providers) {
    const found = await peekSocialClaim(token, id);
    if (found) return found.provider;
  }
  return null;
}

type ClaimInput = {
  provider: 'google' | 'github' | 'discord';
  claim: {
    provider: 'google' | 'github' | 'discord';
    providerAccountId: string;
    providerEmail: string | null;
    emailVerified: boolean;
    emailOwnerId: string | null;
  };
  ip: string;
  userAgent: string;
  providerLabel: string;
};

async function completeSignup(args: ClaimInput & { request: NextRequest }): Promise<NextResponse> {
  const { provider, claim, ip, userAgent, providerLabel } = args;

  if (!claim.emailVerified || !claim.providerEmail) {
    await recordSecurityEvent('login_failed', null, ip, userAgent, {
      provider,
      error: 'email_not_verified',
    });
    throw new ApiError('ACCOUNT_NOT_LINKABLE');
  }
  if (claim.emailOwnerId) {
    // 発行時点では未所有だったのに完了時に所有者が現えた（競合）。email では統合しない。
    throw new ApiError('EMAIL_CONFLICT');
  }
  await assertNotAlreadyLinked(provider, claim.providerAccountId);

  const { user, accountId } = await createSocialUser({
    provider,
    identity: {
      providerAccountId: claim.providerAccountId,
      email: claim.providerEmail,
      emailVerified: claim.emailVerified,
      displayName: null,
    },
  });

  await issueSession(args.request, user, ip, userAgent);
  await recordSecurityEvent('register', user.id, ip, userAgent, { provider });
  await recordSecurityEvent('oauth_linked', user.id, ip, userAgent, { provider });
  return redirectToPath('/', true);
}

async function completePasswordLogin(
  args: ClaimInput & { request: NextRequest; identifier: string; password: string },
): Promise<NextResponse> {
  const { provider, claim, identifier, password, ip, userAgent } = args;

  // 完了前に不一致なら 409 にする（claim は消費済みなので、画面を再読込してもう一度試せる）
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

    // ★ ログイン対象を `claim.emailOwnerId` に固定する。
    // 別の email / ユーザー名を指定されても、その password が一致してもログインさせない
    // （D-32-18）。email の入力を差し替えるだけで別のアカウントに入れるのを防ぐ。
    if (!claim.emailOwnerId) {
      // この email を持つアカウントが存在しない = 連携の相手が無いので、
      // この画面では password ログインできない（signup か /login へ誘導する）
      throw new ApiError('ACCOUNT_LINK_OWNER_MISMATCH');
    }

    const user = await findUserByEmailOrUsername(identifier);
    const valid = user ? await verifyPassword(password, user.passwordHash ?? '') : false;

    if (!user || !valid || user.id !== claim.emailOwnerId) {
      const reached = await Promise.all(
        reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, false)),
      );
      if (reached.some(Boolean)) {
        await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'social_confirm_failed' });
      }
      // 列挙攻撃対策：どの email のアカウントだったかは教えない。
      // 「他のアカウントだった」という事実も返さない。
      await recordSecurityEvent('login_failed', null, ip, userAgent, { provider });
      throw new ApiError('INVALID_CREDENTIALS');
    }

    await Promise.all(reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, true)));

    if (user.status !== 'active') {
      await recordSecurityEvent('login_failed', user.id, ip, userAgent, { provider });
      throw new ApiError('ACCOUNT_SUSPENDED');
    }

    // 上で `user.id === claim.emailOwnerId` を確認済みなので、ここは常に連携になる
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
    return redirectToPath('/', true);
  } finally {
    await release();
  }
}

/** 完了時にも他の誰かが同じ外部 ID を紐付けていないか確認する（TOCTOU・D-32-08）。 */
async function assertNotAlreadyLinked(
  provider: 'google' | 'github' | 'discord',
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