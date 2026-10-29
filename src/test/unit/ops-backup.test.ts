import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  BackupKeyError,
  backupFileName,
  decryptBackup,
  encryptBackup,
  parseBackupDate,
  selectExpiredBackups,
} from '@/lib/ops/backup';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('Phase 9 - backup encryption', () => {
  it('round-trips a payload', () => {
    const plain = Buffer.from('pg dump payload', 'utf8');
    const encrypted = encryptBackup(plain, KEY);
    expect(decryptBackup(encrypted, KEY).toString('utf8')).toBe('pg dump payload');
  });

  it('does not leave the plaintext in the ciphertext', () => {
    const plain = Buffer.from('SUPER-SECRET-DUMP', 'utf8');
    expect(encryptBackup(plain, KEY).toString('utf8')).not.toContain('SUPER-SECRET-DUMP');
  });

  it('rejects a different key', () => {
    const encrypted = encryptBackup(Buffer.from('data'), KEY);
    expect(() => decryptBackup(encrypted, OTHER_KEY)).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const encrypted = encryptBackup(Buffer.from('data'), KEY);
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptBackup(encrypted, KEY)).toThrow();
  });

  it('rejects a truncated payload', () => {
    expect(() => decryptBackup(Buffer.alloc(4), KEY)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptBackup(Buffer.from('data'), Buffer.from('short').toString('base64'))).toThrow();
  });

  it('exports a BackupKeyError for a missing key', () => {
    expect(new BackupKeyError().message).toContain('BACKUP_ENCRYPTION_KEY');
  });
});

describe('Phase 9 - backup naming and retention', () => {
  it('names backups backup-<ISO>.dump.enc', () => {
    const name = backupFileName(new Date('2026-10-29T01:02:03.456Z'));
    expect(name).toBe('backup-2026-10-29T01-02-03-456Z.dump.enc');
  });

  it('parses the timestamp back from the file name', () => {
    const date = new Date('2026-10-29T01:02:03.456Z');
    expect(parseBackupDate(backupFileName(date))?.toISOString()).toBe(date.toISOString());
  });

  it('returns null for unrelated names', () => {
    expect(parseBackupDate('readme.txt')).toBeNull();
    expect(parseBackupDate('backup-notadate.dump.enc')).toBeNull();
  });

  it('keeps backups within the retention window and expires older ones', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const fresh = backupFileName(new Date('2026-10-28T00:00:00.000Z')); // 1 日前
    const edge = backupFileName(new Date('2026-09-29T00:00:00.000Z')); // ちょうど 30 日
    const old = backupFileName(new Date('2026-09-28T00:00:00.000Z')); // 31 日前
    expect(selectExpiredBackups([fresh, edge, old], now, 30)).toEqual([old]);
  });

  it('ignores names that are not backups', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    expect(selectExpiredBackups(['notes.txt', 'backup-.dump.enc'], now, 30)).toEqual([]);
  });
});
