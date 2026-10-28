import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — liveness / readiness（§53・P9-04）。
 *
 * 認証・CSRF を要求しない。LB・監視・デプロイの疎通確認に使う。
 * DB に `SELECT 1` を投げ、到達できなければ 503 を返す（readiness）。
 * 応答にバージョンや内部情報は含めない（§45）。
 */
export async function GET() {
  try {
    await getDb().execute(sql`SELECT 1`);
    return NextResponse.json(
      { status: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
