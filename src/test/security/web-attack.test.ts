import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { users } from '@/lib/db/schema';

describe('Phase 2 web attack regressions', () => {
  it('renders untrusted strings as text rather than executable HTML', () => {
    const payload = '<script>window.compromised=true</script>';
    const html = renderToStaticMarkup(createElement('p', null, payload));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('keeps SQL injection payloads as bound values in Drizzle queries', () => {
    const payload = "' OR 1=1 --";
    const query = new PgDialect().sqlToQuery(eq(users.email, payload));
    expect(query.sql).toContain('$1');
    expect(query.sql).not.toContain(payload);
    expect(query.params).toContain(payload);
  });
});
