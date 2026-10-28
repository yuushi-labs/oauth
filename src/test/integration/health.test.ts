import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db/client';
import { GET as health } from '@/app/api/health/route';

/**
 * Phase 9（§53 / P9-04）: `GET /api/health`。
 *
 * 認証・CSRF を要求せず、DB 到達で 200 `{status:'ok'}`、到達不能で 503 `{status:'unavailable'}` を返す。
 * 応答にバージョン等の内部情報を含めない。
 */
describe('GET /api/health', () => {
  it('DB に到達できれば 200 と {status:ok}、内部情報は返さない', async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('DB に到達できなければ 503 と {status:unavailable}', async () => {
    const db = getDb();
    const spy = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connection refused'));
    const response = await health();
    spy.mockRestore();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });
});
