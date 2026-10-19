import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { randomToken, sha256Hex } from '@/lib/util/crypto';
import type { Identity } from './types';

/**
 * social-only ユーザーの username を決める（§4.5 / D-32-11）。
 *
 * **実測（BUG-14）**: 旧実装は表示名の非 ASCII 文字をすべて `_` に置換していた。
 * 表示名「ミカさん」→ `___` で、長さの最小値 3 を通してしまい、
 * 「名前」ではない `___` という username が作られていた。
 *
 * 決定規則（ユーザー指定）:
 * 1. 表示名を ASCII 化して使う
 * 2. 無効なら email のローカル部を ASCII 化して使う
 * 3. それでも無効なら `user_` + ハッシュ 8 桁
 */

/**
 * `usernameSchema`（3〜32 文字・`[A-Za-z0-9_-]`）に加え、**名前として成立するか**も見る。
 * `___` を弾くのがこの関数の目的。
 */
export function isAcceptableUsername(value: string): boolean {
  if (value.length < 3 || value.length > 32) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  // 英数字が 1 文字も無い名前は「名前」ではない（アンダースコアだけ／ハイフンだけ）
  if (!/[A-Za-z0-9]/.test(value)) return false;
  // 先頭の区切り記号は読みにくい（`_foo` / `-foo`）
  if (/^[_-]/.test(value)) return false;
  return true;
}

/** 非 ASCII を除去し、連続する区切り記号を 1 つに畳んで前後の区切り記号を落とす。 */
export function toAsciiUsername(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/[_-]{2,}/g, '_')
    .replace(/^[_-]+/, '')
    .replace(/[_-]+$/, '')
    .slice(0, 32);
}

function localPart(email: string): string {
  return email.split('@')[0] ?? '';
}

/**
 * username の候補を「表示名 → email ローカル部」の順で返す。
 * どちらも無効なら空配列（呼び出し側はフォールバックを使う）。
 */
export function usernameCandidates(identity: Identity): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const source of [identity.displayName ?? '', localPart(identity.email ?? '')]) {
    if (!source) continue;
    const ascii = toAsciiUsername(source);
    if (!ascii || seen.has(ascii)) continue;
    seen.add(ascii);
    if (isAcceptableUsername(ascii)) candidates.push(ascii);
  }

  return candidates;
}

/** どの候補も使えないときの決定的なフォールバック。 */
export function fallbackUsername(identity: Identity): string {
  const seed = identity.email ?? identity.providerAccountId;
  return `user_${sha256Hex(seed).slice(0, 8)}`;
}

/**
 * 衝突を避けて username を払い出す。
 * 表示名 → email ローカル部 → フォールバックの順で試し、各候補は最大 12 回引き直す。
 */
export async function allocateUsername(identity: Identity): Promise<string> {
  const ordered = [...usernameCandidates(identity), fallbackUsername(identity)];
  const db = getDb();

  for (const candidate of ordered) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const name = attempt === 0 ? candidate : `${candidate}${randomToken(3).slice(0, 4)}`.slice(0, 32);
      if (!isAcceptableUsername(name)) continue;
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, name))
        .limit(1);
      if (!taken) return name;
    }
  }

  return `user_${randomToken(6).slice(0, 8)}`;
}