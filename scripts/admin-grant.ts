import 'dotenv/config';
import { getPool } from '@/lib/db/client';
import { applyRoleChange } from '@/lib/auth/admin-role';
import { findUserByEmailOrUsername, findUserById } from '@/lib/db/queries/users';
import { roleRank } from '@/lib/auth/admin-policy';
import { ROLE_IDS, type User } from '@/lib/db/schema';
import { ApiError } from '@/lib/errors';

const USAGE = `管理者の付与（Phase 7.5）

  pnpm admin:grant <email|username> [--role user|moderator|admin|superadmin] [--actor <email|id>]

  --role   付与する role（既定: admin）
  --actor  操作者（監査ログ用）。省略時は bootstrap とみなし警告を表示する。
`;

const ROLE_NAMES: Record<string, string> = {
  user: ROLE_IDS.user,
  moderator: ROLE_IDS.moderator,
  admin: ROLE_IDS.admin,
  superadmin: ROLE_IDS.superadmin,
};

function option(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]!);
  }
  return values;
}

async function resolveActor(value: string): Promise<User> {
  const actor = value.startsWith('usr_') ? await findUserById(value) : await findUserByEmailOrUsername(value);
  if (!actor || actor.deletedAt) throw new ApiError('ADMIN_NOT_FOUND', `操作者が見つかりません: ${value}`);
  if (roleRank(actor.roleId) < roleRank(ROLE_IDS.admin)) {
    throw new ApiError('FORBIDDEN', `操作者に管理者権限がありません: ${value}`);
  }
  return actor;
}

async function main(): Promise<void> {
  const [identifier] = process.argv.slice(2);
  if (!identifier || identifier.startsWith('--')) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const roleName = option('--role')[0] ?? 'admin';
  const roleId = ROLE_NAMES[roleName];
  if (!roleId) {
    process.stderr.write(`${USAGE}\n不明な role です: ${roleName}\n`);
    process.exitCode = 2;
    return;
  }

  const target = await findUserByEmailOrUsername(identifier);
  if (!target || target.deletedAt) {
    process.stderr.write(`ユーザーが見つかりません（削除済みを含む）: ${identifier}\n`);
    process.exitCode = 1;
    return;
  }

  const actorValue = option('--actor')[0];
  const actor = actorValue ? await resolveActor(actorValue) : null;

  // CLI は trusted operator として全 role を扱える（D-36-06）。
  const { previousRoleId, changed } = await applyRoleChange({
    target,
    roleId,
    maxRank: roleRank(ROLE_IDS.superadmin),
    actorUserId: actor?.id ?? null,
    ip: '',
    userAgent: 'admin-grant-cli',
  });

  if (!changed) {
    process.stdout.write(`変更はありません: ${target.email} (${target.username}) は既に ${roleId} です。\n`);
    return;
  }

  process.stdout.write(
    `role を変更しました: ${target.email} (${target.username}) ${previousRoleId} -> ${roleId}\n`,
  );
  if (!actor) {
    process.stdout.write(
      '注意: --actor が未指定のため監査ログ（admin_audit_logs）には記録していません。security_events にのみ記録しました。\n',
    );
  }
  if (roleRank(roleId) >= roleRank(ROLE_IDS.admin)) {
    process.stdout.write('このユーザーは管理 API を使う前に 2 段階認証を有効化する必要があります（§51）。\n');
  }
}

main()
  .then(() => getPool().end())
  .catch((error: unknown) => {
    if (error instanceof ApiError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return getPool().end();
    }
    process.stderr.write('role の変更に失敗しました。対象ユーザーとデータベースの状態を確認してください。\n');
    process.exitCode = 1;
    return getPool().end();
  });
