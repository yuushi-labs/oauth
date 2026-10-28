import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { messages } from '@/messages/ja';

/**
 * §18「変更系の通知」カテゴリの正規テスト（D-38-05）。
 *
 * 変更系の操作は **漏れなく通知メールを送る**。ここでは (a) 各ルートが
 * `sendChangeNotificationEmail` または `deliverEmailSafely` を通すこと、
 * (b) 通知本文に秘密情報（PW / token / TOTP / recovery / session / secret）が
 * 含まれないことを固定する（§45）。
 */
const CHANGE_ROUTES: Array<[string, string]> = [
  ['2fa/verify/route.ts', 'sendChangeNotificationEmail'],
  ['2fa/disable/route.ts', 'sendChangeNotificationEmail'],
  ['2fa/recovery-codes/regenerate/route.ts', 'sendChangeNotificationEmail'],
  ['passkey/register/verify/route.ts', 'sendChangeNotificationEmail'],
  ['passkey/[id]/route.ts', 'sendChangeNotificationEmail'],
  ['email/change/confirm/route.ts', 'sendChangeNotificationEmail'],
  ['password/set/route.ts', 'sendChangeNotificationEmail'],
  ['password/reset/route.ts', 'sendChangeNotificationEmail'],
  ['password/change/route.ts', 'sendChangeNotificationEmail'],
  ['logout-all/route.ts', 'sendChangeNotificationEmail'],
];

describe('Security - account change notifications (§18 / §45)', () => {
  it('変更系の全ルートが変更通知を送る', () => {
    for (const [relativePath, call] of CHANGE_ROUTES) {
      const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth', relativePath), 'utf8');
      expect(source, `${relativePath} は変更通知を送る`).toContain(call);
    }
  });

  it('★ 変更通知の本文に秘密情報を含まない（§45）', () => {
    const html = messages.emails.changeNotification.html({
      change: 'パスワード変更',
      time: '2026-10-24T00:00:00.000Z',
      ip: '203.0.113.10',
    });
    const text = messages.emails.changeNotification.text({
      change: 'パスワード変更',
      time: '2026-10-24T00:00:00.000Z',
      ip: '203.0.113.10',
    });
    const body = html + text;
    // 「パスワード」という語（変更内容の説明）は許すが、秘密値・内部識別子は出さない。
    expect(body).not.toMatch(/token/i);
    expect(body).not.toMatch(/totp|recovery/i);
    expect(body).not.toMatch(/csrf|secret/i);
    expect(body).not.toMatch(/sess_|evt_|usr_/);
    expect(body).not.toMatch(/hash/i);
  });

  it('★ セキュリティ通知（新規デバイス）の本文に秘密情報を含まない（§45）', () => {
    const html = messages.emails.securityNotification.html({
      device: 'Chrome on Windows',
      ip: '203.0.113.xxx',
      time: '2026-10-24T00:00:00.000Z',
    });
    const text = messages.emails.securityNotification.text({
      device: 'Chrome on Windows',
      ip: '203.0.113.xxx',
      time: '2026-10-24T00:00:00.000Z',
    });
    const body = html + text;
    expect(body).toContain('Chrome on Windows');
    expect(body).not.toMatch(/token/i);
    expect(body).not.toMatch(/totp|recovery/i);
    expect(body).not.toMatch(/csrf|secret/i);
  });
});
