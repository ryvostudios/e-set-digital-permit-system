import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envSchema } from './env.js';

/**
 * Validates the schema/fail-fast rules directly via `safeParse`, not the
 * `env` singleton (which reads real `process.env` once at import time
 * and calls `process.exit` on failure - not something to trigger from a
 * test). This is the same schema `loadEnv()` actually parses with, so
 * these tests cover the real production fail-fast behavior, just
 * without the process-exit side effect wrapped around it.
 */

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/postgres',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
    SITE_TIMEZONE: 'UTC',
    ...overrides,
  };
}


test('envSchema accepts a minimal valid development configuration', () => {
  const result = envSchema.safeParse(baseEnv());
  assert.equal(result.success, true);
});

test('envSchema fails when DATABASE_URL is missing', () => {
  const result = envSchema.safeParse(baseEnv({ DATABASE_URL: undefined }));
  assert.equal(result.success, false);
});

test('envSchema rejects a non-postgres DATABASE_URL scheme (e.g. accidentally pointing at something else entirely)', () => {
  const result = envSchema.safeParse(baseEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' }));
  assert.equal(result.success, false);
});


test('envSchema fails when SITE_TIMEZONE is missing or not a real IANA zone', () => {
  assert.equal(envSchema.safeParse(baseEnv({ SITE_TIMEZONE: undefined })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ SITE_TIMEZONE: 'Not/AZone' })).success, false);
});

test('envSchema accepts a real IANA time zone', () => {
  assert.equal(envSchema.safeParse(baseEnv({ SITE_TIMEZONE: 'Asia/Karachi' })).success, true);
});

test('envSchema defaults NODE_ENV to development, DB_SSL to true, and PORT to 3001', () => {
  const result = envSchema.safeParse(baseEnv());
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.NODE_ENV, 'development');
  assert.equal(result.data.DB_SSL, true);
  assert.equal(result.data.PORT, 3001);
});

test('envSchema: production requires CORS_ALLOWED_ORIGINS to be set', () => {
  const result = envSchema.safeParse(baseEnv({ NODE_ENV: 'production', DB_SSL: 'true' }));
  assert.equal(result.success, false);
});

test('envSchema: production rejects a wildcard CORS origin, even alongside real ones', () => {
  const result = envSchema.safeParse(
    baseEnv({ NODE_ENV: 'production', DB_SSL: 'true', CORS_ALLOWED_ORIGINS: 'https://real.example.com,*' }),
  );
  assert.equal(result.success, false);
});

test('envSchema: production accepts a real, non-wildcard CORS origin list', () => {
  const result = envSchema.safeParse(
    baseEnv({
      NODE_ENV: 'production',
      DB_SSL: 'true',
      CORS_ALLOWED_ORIGINS: 'https://permits.example.com,https://staging.example.com',
    }),
  );
  assert.equal(result.success, true);
});

test('envSchema: production must not disable DB_SSL', () => {
  const result = envSchema.safeParse(
    baseEnv({ NODE_ENV: 'production', DB_SSL: 'false', CORS_ALLOWED_ORIGINS: 'https://permits.example.com' }),
  );
  assert.equal(result.success, false);
});

test('envSchema: development does not require CORS_ALLOWED_ORIGINS (falls back to the local dev origin in cors.ts)', () => {
  const result = envSchema.safeParse(baseEnv({ NODE_ENV: 'development' }));
  assert.equal(result.success, true);
});





test('envSchema accepts the new sb_publishable_ key format', () => {
  const result = envSchema.safeParse(baseEnv({ SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdef1234567890' }));
  assert.equal(result.success, true);
});

// --- TRUST_PROXY_CIDRS ---

// --- same-class review: other previously-unbounded numeric config ---

test('envSchema PORT: accepts the valid TCP port range boundaries and rejects outside it', () => {
  assert.equal(envSchema.safeParse(baseEnv({ PORT: '1' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ PORT: '65535' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ PORT: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ PORT: '65536' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ PORT: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

test('envSchema DB_POOL_MAX: accepts 1..100 and rejects zero, negative, and above-maximum values', () => {
  assert.equal(envSchema.safeParse(baseEnv({ DB_POOL_MAX: '1' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_POOL_MAX: '100' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_POOL_MAX: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ DB_POOL_MAX: '-1' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ DB_POOL_MAX: '101' })).success, false);
});

test('envSchema DB_IDLE_TIMEOUT_MS: accepts 0 (pg\'s documented "disabled" value) through the 1-hour maximum, rejects a timer-overflow value', () => {
  assert.equal(envSchema.safeParse(baseEnv({ DB_IDLE_TIMEOUT_MS: '0' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_IDLE_TIMEOUT_MS: '3600000' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_IDLE_TIMEOUT_MS: '3600001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ DB_IDLE_TIMEOUT_MS: '-1' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ DB_IDLE_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

test('envSchema DB_CONNECTION_TIMEOUT_MS: accepts 0 through the 1-minute maximum, rejects above it', () => {
  assert.equal(envSchema.safeParse(baseEnv({ DB_CONNECTION_TIMEOUT_MS: '0' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_CONNECTION_TIMEOUT_MS: '60000' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ DB_CONNECTION_TIMEOUT_MS: '60001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ DB_CONNECTION_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

test('envSchema: TRUST_PROXY_CIDRS defaults to unset (trust proxy disabled)', () => {
  const result = envSchema.safeParse(baseEnv());
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.TRUST_PROXY_CIDRS, undefined);
});

test('envSchema accepts a single trusted proxy IP, a CIDR block, and a preset name', () => {
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.0.5' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.1.0/24' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: 'loopback' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '::1' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: 'fd00::/8' })).success, true);
});

test('envSchema accepts a comma-separated list of multiple trusted proxies', () => {
  const result = envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.0.5, 10.0.1.0/24 ,loopback' }));
  assert.equal(result.success, true);
});

test('envSchema rejects a wildcard/full-range TRUST_PROXY_CIDRS - it must never mean "trust everything"', () => {
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '*' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '0.0.0.0/0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '::/0' })).success, false);
});

test('envSchema rejects every equivalent /0 representation in TRUST_PROXY_CIDRS, not just the canonical spellings', () => {
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '0.0.0.0/00' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '0.0.0.1/0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '::1/0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '0000::/0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '0:0:0:0:0:0:0:0/0' })).success, false);
  // A legitimate, specific proxy address alongside one /0 entry must
  // still fail closed as a whole - one universal-trust entry poisons
  // the entire allowlist, it isn't silently dropped in favor of the
  // valid ones.
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.0.5,0.0.0.0/0' })).success, false);
});

test('envSchema rejects a garbage TRUST_PROXY_CIDRS entry (not an IP, not a CIDR, not a preset)', () => {
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: 'not-an-address' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.0.5,garbage' })).success, false);
});

test('envSchema rejects a malformed CIDR block (bad prefix length)', () => {
  assert.equal(envSchema.safeParse(baseEnv({ TRUST_PROXY_CIDRS: '10.0.0.0/99' })).success, false);
});

// --- rate limiting: window ---

test('envSchema: rate-limit tuning vars have sensible defaults and coerce numeric strings', () => {
  const defaultResult = envSchema.safeParse(baseEnv());
  assert.equal(defaultResult.success, true);
  if (defaultResult.success) {
    assert.equal(defaultResult.data.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(defaultResult.data.RATE_LIMIT_GLOBAL_MAX, 1_200);
    assert.equal(defaultResult.data.RATE_LIMIT_MUTATION_MAX, 30);
  }

  const overridden = envSchema.safeParse(
    baseEnv({ RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_GLOBAL_MAX: '50', RATE_LIMIT_MUTATION_MAX: '5' }),
  );
  assert.equal(overridden.success, true);
  if (overridden.success) {
    assert.equal(overridden.data.RATE_LIMIT_WINDOW_MS, 60_000);
    assert.equal(overridden.data.RATE_LIMIT_GLOBAL_MAX, 50);
    assert.equal(overridden.data.RATE_LIMIT_MUTATION_MAX, 5);
  }
});

test('envSchema rejects a non-positive rate-limit value', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: '-5' })).success, false);
});

test('envSchema RATE_LIMIT_WINDOW_MS: accepts the documented min (1,000ms) and max (3,600,000ms) boundaries', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '1000' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '3600000' })).success, true);
});

test('envSchema RATE_LIMIT_WINDOW_MS: rejects below the minimum and above the maximum', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '999' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '3600001' })).success, false);
});

test('envSchema RATE_LIMIT_WINDOW_MS: rejects zero, negative, and fractional values', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '-1000' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '1000.5' })).success, false);
});

test('envSchema RATE_LIMIT_WINDOW_MS: rejects a Node setTimeout/setInterval-overflow value (32-bit signed int max is 2,147,483,647ms)', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: '2147483648' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_WINDOW_MS: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

// --- rate limiting: request-count limits ---

test('envSchema RATE_LIMIT_GLOBAL_MAX: accepts the documented min (1) and max (10,000) boundaries', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: '1' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: '10000' })).success, true);
});

test('envSchema RATE_LIMIT_GLOBAL_MAX: rejects above the maximum and non-integer/unsafe values', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: '10001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: '5.5' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_GLOBAL_MAX: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

test('envSchema RATE_LIMIT_MUTATION_MAX: accepts the documented min (1) and max (1,000) boundaries', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: '1' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: '1000' })).success, true);
});

test('envSchema RATE_LIMIT_MUTATION_MAX: rejects above the maximum, fractional, and unsafe values', () => {
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: '1001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: '2.5' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MUTATION_MAX: String(Number.MAX_SAFE_INTEGER) })).success, false);
});

test('envSchema sizes manager budgets for real onboarding, with reads budgeted apart from writes', () => {
  const defaulted = envSchema.safeParse(baseEnv());
  assert.equal(defaulted.success, true);
  if (defaulted.success) {
    assert.equal(defaulted.data.RATE_LIMIT_ACCOUNT_MAX, 10);
    // There is no business quota on employee creation, so the manager
    // WRITE budget must clear a 60-employee session with real headroom.
    assert.equal(defaulted.data.RATE_LIMIT_MANAGER_ACCOUNT_MAX, 120);
    assert.ok(defaulted.data.RATE_LIMIT_MANAGER_ACCOUNT_MAX >= 100);
    // Reads are budgeted separately so browsing cannot consume it.
    assert.equal(defaulted.data.RATE_LIMIT_MANAGER_READ_MAX, 300);
    assert.ok(defaulted.data.RATE_LIMIT_MANAGER_READ_MAX > defaulted.data.RATE_LIMIT_MANAGER_ACCOUNT_MAX);
    // The coarse per-IP backstop must still be able to carry that session.
    assert.ok(defaulted.data.RATE_LIMIT_GLOBAL_MAX >= 1_000);
  }
  // Still bounded on both sides: never unlimited, never zero.
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_ACCOUNT_MAX: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_ACCOUNT_MAX: '1001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_ACCOUNT_MAX: '150' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_READ_MAX: '0' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_READ_MAX: '5001' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({ RATE_LIMIT_MANAGER_READ_MAX: '400' })).success, true);
});

// --- Auth-admin and Storage credentials ---





test('envSchema: SUPABASE_DOCUMENT_BUCKET defaults when unset and accepts an override', () => {
  const defaultResult = envSchema.safeParse(baseEnv());
  assert.equal(defaultResult.success, true);
  if (defaultResult.success) assert.equal(defaultResult.data.SUPABASE_DOCUMENT_BUCKET, 'issued-permit-documents');

  const overridden = envSchema.safeParse(baseEnv({ SUPABASE_DOCUMENT_BUCKET: 'my-custom-bucket' }));
  assert.equal(overridden.success, true);
  if (overridden.success) assert.equal(overridden.data.SUPABASE_DOCUMENT_BUCKET, 'my-custom-bucket');
});

test('production Supabase URL and CORS allow only canonical credential-free HTTPS origins', () => {
  const production = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.com' };
  assert.equal(envSchema.safeParse(baseEnv(production)).success, true);
  for (const CORS_ALLOWED_ORIGINS of [
    'http://app.example.com',
    'https://user:password@app.example.com',
    'https://app.example.com/path',
    'https://app.example.com?x=1',
    'https://app.example.com#fragment',
  ]) assert.equal(envSchema.safeParse(baseEnv({ ...production, CORS_ALLOWED_ORIGINS })).success, false);
  const canonical = envSchema.safeParse(baseEnv({ ...production, CORS_ALLOWED_ORIGINS: 'https://APP.EXAMPLE.COM:443/' }));
  assert.equal(canonical.success, true);
});

test('development keeps localhost HTTP usable while storage S3 credentials are all-or-none', () => {
  assert.equal(envSchema.safeParse(baseEnv({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' })).success, true);
  assert.equal(envSchema.safeParse(baseEnv({ SUPABASE_STORAGE_ENDPOINT: 'https://storage.example.com' })).success, false);
  assert.equal(envSchema.safeParse(baseEnv({
    SUPABASE_STORAGE_ENDPOINT: 'https://storage.example.com',
    SUPABASE_STORAGE_REGION: 'local',
    SUPABASE_STORAGE_ACCESS_KEY_ID: 'storage-access',
    SUPABASE_STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
  })).success, true);
});

test('Permit authentication configuration has no Supabase Auth dependency', () => {
  const result = envSchema.parse({ DATABASE_URL: 'postgresql://local:local@127.0.0.1/test', SITE_TIMEZONE: 'UTC' });
  for (const key of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_AUTH_ADMIN_TIMEOUT_MS']) {
    assert.equal(key in result, false);
  }
});

test('envSchema validates read-only previous storage keys for rotation without echoing them', async () => {
  const { randomBytes } = await import('node:crypto');
  const active = randomBytes(32).toString('base64');
  const previous = randomBytes(32).toString('base64');
  const withKeys = (value: string | undefined, master: string | null = active) =>
    envSchema.safeParse(baseEnv({ PERMIT_STORAGE_MASTER_KEY: master ?? undefined, PERMIT_STORAGE_KEY_VERSION: '2', PERMIT_STORAGE_PREVIOUS_KEYS: value }));
  assert.equal(withKeys(`1:${previous}`).success, true);
  assert.equal(withKeys(undefined).success, true);
  for (const bad of [`2:${previous}`, `1:${active}`, 'garbage', `1:${previous},1:${randomBytes(32).toString('base64')}`]) {
    const result = withKeys(bad);
    assert.equal(result.success, false);
    assert.ok(!JSON.stringify(result.error).includes(previous) && !JSON.stringify(result.error).includes(active));
  }
  assert.equal(withKeys(`1:${previous}`, null).success, false, 'previous keys need an active key');
  for (const version of ['__proto__', 'constructor', '', ' 2']) {
    assert.equal(envSchema.safeParse(baseEnv({ PERMIT_STORAGE_MASTER_KEY: active, PERMIT_STORAGE_KEY_VERSION: version })).success,
      false, `active key version ${JSON.stringify(version)} refused`);
  }
});
