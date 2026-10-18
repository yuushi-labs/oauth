import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, users, type User } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { newId } from '@/lib/util/id';
import { randomToken } from '@/lib/util/crypto';
import { createAccount, findAccountByProviderAccountId, touchAccountLastUsed } from './accounts';
import type { Identity } from './types';
import type { SocialProvider } from '@/lib/db/schema';

/**
 * login intent の判定（§11 / §12.2）。
 *
 * **email 一致での自動統合はしない**（§11）。email は「同じ人かどうか」の手がかりには
 * なるが、信頼できる同一性の証拠ではない。login は次の 3 分岐に固定する:
 *
 * 1. `(provider, provider_account_id)` が既にある → **そのユーザーでログイン**
 * 2. 未紐付けかつ email が既存ユーザーと一致 → **停止して link を誘導**（統合しない）
 * 3. 未紐付けかつ email 一致なし → **social-only ユーザーを新規作成**
 */

export type LoginOutcome =
  | { kind: 'login'; user: User; accountId: string }
  | { kind: 'register'; user: User; accountId: string }
  | { kind: 'link_required' }
  | { kind: 'not_linkable' }
  | { kind: 'suspended' };

export async function completeLogin(args: {
  provider: SocialProvider;
  identity: Identity;
}): Promise<LoginOutcome> {
  const { provider, identity } = args;

  const existing = await findAccountByProviderAccountId(provider, identity.providerAccountId);
  if (existing) {
    const user = await findUserById(existing.userId);
    if (!user) return { kind: 'suspended' };
    // suspended / deleted / pending_email は 모두ログインさせない。
    // 論理削除済みユーザーの external ID を別人が使い継ぐことは許さない（D-31-09）。
    if (user.status !== 'active') return { kind: 'suspended' };

    await touchAccountLastUsed(existing.id);
    return { kind: 'login', user, accountId: existing.id };
  }

  // 未検証 email・email 不明では新規登録しない（乗っ取りの入口になる・D-31-08）。
  if (!identity.emailVerified || !identity.email) return { kind: 'not_linkable' };

  if (await findLiveUserByEmail(identity.email)) return { kind: 'link_required' };

  // social-only ユーザー。`password_hash` は NULL のまま。
  // CHECK 制約により active にするには email_verified = true が必須（D-31-11）。
  const user = await createUser({
    id: newId('usr'),
    username: await allocateUsername(identity),
    email: identity.email,
    emailVerified: true,
    passwordHash: null,
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });

  const account = await createAccount({
    userId: user.id,
    provider,
    providerAccountId: identity.providerAccountId,
    providerEmail: identity.email,
  });

  return { kind: 'register', user, accountId: account.id };
}

async function findUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** 論理削除済みは email 再利用の衝突対象から外す（users の partial unique index と同じ考え方・D-04）。 */
async function findLiveUserByEmail(email: string): Promise<User | null> {
  const [row] = await getDb()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) return null;
  return row.status === 'deleted' || row.deletedAt ? null : row;
}

/**
 * social-only ユーザーの username を払い出す。
 *
 * 既存の usernameSchema（3〜32 文字・英数字/ハイフン/アンダースコア）に合わせ、
 * 表示名や local-part を材料にする。衝突したらランダム suffix で数回引き直す。
 */
async function allocateUsername(identity: Identity): Promise<string> {
  const base = sanitizeUsername(identity.displayName ?? identity.email ?? 'user');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${randomToken(3).slice(0, 4)}`.slice(0, 32);
    const taken = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    if (!taken.length) return candidate;
  }
  return `user_${newId('usr').slice(-8).toLowerCase()}`;
}

function sanitizeUsername(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  return cleaned.length >= 3 ? cleaned : `user_${newId('usr').slice(-8).toLowerCase()}`;
}