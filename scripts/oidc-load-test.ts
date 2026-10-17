/**
 * P25-E-01: OIDC エンドポイントのレート制限値を実 HTTP 負荷で検証する。
 *
 * 一時ポートで custom server（scripts/server.ts）を子プロセスとして起動し、各 OIDC
 * エンドポイントへ並列 HTTP リクエストを実送する。観測するのは以下:
 *   - 各エンドポイントで 429 が現れるか（= レート制限が実際に機能しているか）
 *   - 許可されたリクエストのレイテンシ分布（= レート制限判定自体のコスト）
 *   - 429 と許可が混在する場合の境界（= ウィンドウ計算が正しいか）
 *
 * 計測結果と結論は `docs/phase2.5-load-test.md` に記録する。
 *
 * 使い方:
 *   pnpm oidc:load --scenario <authorize|interaction|token|userinfo|revoke|all> [--concurrency N] [--requests N]
 *
 * 注意: 本スクリプトはローカル検証専用。計測のため最後にレート制限の記録を掃除する。
 * 本番・共有環境に対して実行しないこと。
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getPool } from '@/lib/db/client';
import { getEnv, resetEnvCache } from '@/lib/env';
import { RATE_LIMITS } from '@/config/rate-limits';

type Scenario = 'authorize' | 'interaction' | 'token' | 'userinfo' | 'revoke';
type Sample = { status: number; durationMs: number };

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitForReady(issuer: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(new URL('/.well-known/openid-configuration', issuer), { cache: 'no-store' });
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('server did not become ready');
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function summarize(name: string, samples: Sample[], elapsedMs: number): { allowed: number; limited: number; serverErrors: number } {
  const durations = samples.map((sample) => sample.durationMs);
  const allowedDurations = samples.filter((sample) => sample.status !== 429).map((sample) => sample.durationMs);
  const limited = samples.filter((sample) => sample.status === 429).length;
  const serverErrors = samples.filter((sample) => sample.status >= 500).length;
  process.stdout.write(
    [
      `## ${name}`,
      `- requests: ${samples.length}, wall clock ${elapsedMs.toFixed(0)} ms, throughput ${(samples.length / (elapsedMs / 1000)).toFixed(1)} req/s`,
      `- allowed latency p50=${percentile(allowedDurations, 0.5).toFixed(1)}ms p95=${percentile(allowedDurations, 0.95).toFixed(1)}ms`,
      `- limited (429): ${limited}`,
      `- 5xx: ${serverErrors}`,
      `- slowest allowed: ${Math.max(...durations, 0).toFixed(1)} ms`,
      '',
    ].join('\n'),
  );
  return { allowed: samples.length - limited, limited, serverErrors };
}

async function runBatch(name: string, request: () => Promise<Response>, concurrency: number, total: number): Promise<ReturnType<typeof summarize>> {
  const started = Date.now();
  const samples: Sample[] = [];
  let issued = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < total) {
        issued += 1;
        const begin = performance.now();
        try {
          const response = await request();
          samples.push({ status: response.status, durationMs: performance.now() - begin });
          await response.arrayBuffer();
        } catch (error) {
          samples.push({ status: 0, durationMs: performance.now() - begin });
          void error;
        }
      }
    }),
  );
  return summarize(name, samples, Date.now() - started);
}

/**
 * Rate limit counters are keyed by an HMAC, so a leftover counter from an earlier run cannot be
 * matched by prefix. The script therefore wipes the whole table. This is safe only because the
 * script is local-only and documented as such; never run it against a shared environment.
 */
async function clearRateLimits(): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM rate_limit_reservations');
  await pool.query('DELETE FROM rate_limit_hits');
}

async function main(): Promise<void> {
  const configuredIssuer = process.env.OIDC_ISSUER;
  if (!configuredIssuer || !process.env.OIDC_JWKS_JSON || !process.env.OIDC_ADAPTER_ENCRYPTION_KEY) {
    process.stderr.write('OIDC_ISSUER / OIDC_JWKS_JSON / OIDC_ADAPTER_ENCRYPTION_KEY are required. Configure them in .env first.\n');
    process.exitCode = 2;
    return;
  }
  resetEnvCache();

  const scenarioArg = process.argv[2]?.startsWith('--') ? option('--scenario', 'all') : (process.argv[2] ?? 'all');
  const requested = scenarioArg as Scenario | 'all';
  const concurrency = Number(option('--concurrency', '16'));
  const requestsByScenario: Record<Scenario, number> = {
    authorize: RATE_LIMITS.oidc.authorize.limit * 3,
    interaction: RATE_LIMITS.oidc.interaction.limit * 3,
    token: RATE_LIMITS.oidc.token.limit * 3,
    userinfo: RATE_LIMITS.oidc.userinfo.limit * 3,
    revoke: RATE_LIMITS.oidc.revoke.limit * 3,
  };
  const requestsOverride = Number(option('--requests', '0'));
  const defaultRequests = requested === 'all' ? requestsByScenario.authorize : requestsByScenario[requested];
  const scenarioRequests = requestsOverride > 0 ? requestsOverride : defaultRequests;

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  // Dev mode is used because the OIDC handler runs ahead of Next.js and the measurement targets
  // the provider's own rate limiting, not Next.js rendering performance.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(projectRoot, 'scripts/server.ts'), 'dev'],
    {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', OIDC_ISSUER: issuer, NEXT_PUBLIC_APP_URL: issuer, CSRF_TRUSTED_ORIGINS: issuer },
      stdio: process.env.LOAD_TEST_VERBOSE ? 'inherit' : 'ignore',
    },
  );
  child.on('error', (error) => { process.stderr.write(`failed to start server: ${error.message}\n`); });
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && code !== 0) process.stderr.write(`server exited: code=${code} signal=${signal}\n`);
  });

  process.stdout.write(`# OIDC rate limit load test\n\n- issuer: ${issuer} (ephemeral server)\n- concurrency: ${concurrency}\n- requests per scenario: ${scenarioRequests}\n\n`);

  try {
    await waitForReady(issuer, child);
    await clearRateLimits();

    const scenarios: Scenario[] = requested === 'all' ? ['authorize', 'interaction', 'token', 'userinfo', 'revoke'] : [requested];
    const results: string[] = [];

    for (const scenario of scenarios) {
      const requests = scenarioRequests || RATE_LIMITS.oidc[scenario].limit * 3;
      const url = requestUrl(scenario, issuer);
      const init = requestInit(scenario);
      const summary = await runBatch(scenario, () => fetch(url, { ...init, redirect: 'manual' }), concurrency, requests);
      const limit = RATE_LIMITS.oidc[scenario];
      results.push(`| ${scenario} | ${(limit.window / 1000).toFixed(0)}s | ${limit.limit} | ${requests} | ${summary.allowed} | ${summary.limited} | ${summary.serverErrors} |`);
      await clearRateLimits();
    }

    process.stdout.write('| scenario | window | configured limit | requests | allowed | 429 | 5xx |\n');
    process.stdout.write('|---|---|---|---|---|---|---|\n');
    process.stdout.write(`${results.join('\n')}\n`);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
    await clearRateLimits();
    await getPool().end();
  }
}

/**
 * The requests are deliberately incomplete OIDC calls: the provider-side rate limiter runs before
 * protocol validation, so we observe the limiter without needing valid codes or tokens.
 */
function requestUrl(scenario: Scenario, issuer: string): string {
  const url = new URL('/oauth2/authorize', issuer);
  switch (scenario) {
    case 'interaction':
      // A malformed uid still reaches the interaction limiter, which runs before validation.
      url.pathname = '/oauth2/interaction/load-test-invalid-uid';
      return url.toString();
    case 'token':
      url.pathname = '/oauth2/token';
      return url.toString();
    case 'userinfo':
      url.pathname = '/oauth2/userinfo';
      return url.toString();
    case 'revoke':
      url.pathname = '/oauth2/revoke';
      return url.toString();
    case 'authorize':
      return url.toString();
  }
}

function requestInit(scenario: Scenario): RequestInit {
  const headers: Record<string, string> = {};
  if (scenario === 'token') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    return { method: 'POST', headers, body: 'grant_type=authorization_code&code=load&client_id=cli_loadtest' };
  }
  if (scenario === 'revoke') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers.authorization = `Basic ${Buffer.from('cli_loadtest:sec_load').toString('base64')}`;
    return { method: 'POST', headers, body: 'token=load&client_id=cli_loadtest' };
  }
  if (scenario === 'userinfo') headers.authorization = 'Bearer load-token';
  return { method: 'GET', headers };
}

void main().catch((error: unknown) => {
  process.stderr.write(`load test failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
