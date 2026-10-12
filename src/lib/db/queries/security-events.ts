import { getDb } from '@/lib/db/client';
import { securityEvents, type NewSecurityEvent } from '@/lib/db/schema';

export async function insertSecurityEvent(data: NewSecurityEvent): Promise<void> {
  const db = getDb();
  await db.insert(securityEvents).values(data);
}