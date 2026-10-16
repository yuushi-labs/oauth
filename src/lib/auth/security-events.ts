import { getDb } from '@/lib/db/client';
import { securityEvents, type SecurityEventType } from '@/lib/db/schema';
import { maskIp } from '@/lib/util/ip';

export async function recordSecurityEvent(
  type: SecurityEventType,
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
    ipMasked: ip ? maskIp(ip) : null,
    userAgent,
    metadata,
    createdAt: new Date(),
  });
}
