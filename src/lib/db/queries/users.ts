import { sql, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users, type User, type NewUser } from '@/lib/db/schema';

export async function findUserByEmail(email: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

export async function findUserByLowerEmail(email: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

export async function findUserByLowerUsername(username: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

export async function findUserByEmailOrUsername(value: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${value.toLowerCase()}`)
    .limit(1);
  if (row) return row;
  const [row2] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${value.toLowerCase()}`)
    .limit(1);
  return row2 ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function createUser(data: NewUser): Promise<User> {
  const db = getDb();
  const [row] = await db.insert(users).values(data).returning();
  return row!;
}

export async function updateUser(
  id: string,
  data: Partial<Omit<NewUser, 'id'>>,
): Promise<User> {
  const db = getDb();
  const [row] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return row!;
}

export async function softDeleteUser(id: string): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, id));
}