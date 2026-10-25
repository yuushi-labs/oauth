/**
 * Reads the PostgreSQL SQLSTATE from a thrown error.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError`, so the code lives on
 * `error.cause.code` rather than `error.code`. Checking only the top level misses every
 * constraint violation and turns a handled duplicate into a 500.
 */
export function getSqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return getSqlState(error.cause);
  return null;
}

/** Unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return getSqlState(error) === '23505';
}
