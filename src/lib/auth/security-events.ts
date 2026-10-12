import { getDb } from '@/lib/db/client';
import { securityEvents } from '@/lib/db/schema';

export async function recordSecurityEvent(
  type: string,
  userId: string | null,
  ip: string,
  userAgent: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  await db.insert(securityEvents).values({
    id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    userId,
    eventType: type,
    ip,
    userAgent,
    metadata,
    createdAt: new Date(),
  });
}