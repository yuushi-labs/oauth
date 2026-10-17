const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes every value interpolated into server-rendered HTML (consent screen, connection test). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);
}
