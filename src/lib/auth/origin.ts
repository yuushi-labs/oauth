export type OriginListName = 'CSRF_TRUSTED_ORIGINS' | 'ALLOWED_ORIGINS';

export function configuredOriginList(name: OriginListName): string[] {
  const raw = name === 'CSRF_TRUSTED_ORIGINS' ? process.env.CSRF_TRUSTED_ORIGINS : process.env.ALLOWED_ORIGINS;
  const configured = raw?.split(',').map((value) => value.trim()).filter(Boolean);
  const values = configured?.length ? configured : [process.env.NEXT_PUBLIC_APP_URL].filter(Boolean) as string[];
  return values.map((value) => {
    try { return new URL(value).origin; } catch { return ''; }
  }).filter(Boolean);
}

export function isTrustedOrigin(origin: string | null, referer?: string | null): boolean {
  const trusted = configuredOriginList('CSRF_TRUSTED_ORIGINS');
  if (!origin || origin === 'null') {
    if (!referer) return false;
    try { return trusted.includes(new URL(referer).origin); } catch { return false; }
  }
  try { return trusted.includes(new URL(origin).origin); } catch { return false; }
}
