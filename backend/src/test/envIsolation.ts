/**
 * Deterministic environment for the test suite.
 *
 * WHY THIS EXISTS: `config/env.ts` calls `import 'dotenv/config'` at module
 * load, so every test that transitively imports it inherited whatever
 * `backend/.env` happened to contain on the machine running it. Once an
 * operator configured real credentials there, two things broke at once:
 *
 *   1. Tests that pin the UNCONFIGURED behaviour of an optional credential
 *      (`accounts.test.ts`'s "authorization runs before any Auth Admin
 *      work", `privilegedPool.test.ts`'s "fails closed when unconfigured")
 *      started failing - not because the code regressed, but because the
 *      machine was configured differently.
 *
 *   2. Far worse, a test that got past the "unavailable" branch performed
 *      a REAL Supabase Auth Admin call with the real service-role key and
 *      created live Auth users in the production project.
 *
 * A test suite must never depend on, or reach, an operator's real
 * infrastructure. This module is loaded via `--import` BEFORE any test
 * module, so it runs before `config/env.ts` is first imported.
 *
 * It deliberately does NOT edit `backend/.env`: a developer's real local
 * secrets stay exactly where they are. It only shapes what this process
 * sees.
 */
import 'dotenv/config';

/**
 * Optional operator credentials. Their PRESENCE changes behaviour (an
 * adapter is built instead of returning null), so the suite pins them
 * absent and any test needing the configured path injects its own stub.
 * Deleted AFTER dotenv has loaded, which is why this module imports it
 * eagerly above rather than relying on load order.
 */
const OPERATOR_ONLY_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'PRIVILEGED_DATABASE_URL',
  'SUPABASE_STORAGE_ENDPOINT',
  'SUPABASE_STORAGE_REGION',
  'SUPABASE_STORAGE_ACCESS_KEY_ID',
  'SUPABASE_STORAGE_SECRET_ACCESS_KEY',
  'BOOTSTRAP_CEO_EMAIL',
  'BOOTSTRAP_CEO_PASSWORD',
  'BOOTSTRAP_CEO_NAME',
  // Permit Dropbox (Phase 4). A developer's real app credentials or storage
  // key must never reach a test; tests that need them inject synthetic ones.
  'DROPBOX_CLIENT_ID',
  'DROPBOX_CLIENT_SECRET',
  'DROPBOX_OAUTH_ORIGIN',
  'PERMIT_STORAGE_MASTER_KEY',
  'PERMIT_STORAGE_KEY_VERSION',
  'PERMIT_STORAGE_PREVIOUS_KEYS',
] as const;

/**
 * Required configuration, forced to values that are syntactically valid
 * but point at nothing real. Overriding rather than defaulting is
 * deliberate: it guarantees that a stubbed boundary which somehow escaped
 * its stub cannot reach a live database or project.
 */
const DETERMINISTIC_KEYS: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgresql://test-app-runtime:test@127.0.0.1:5432/test',
  MIGRATION_DATABASE_URL: 'postgresql://test-migration-owner:test@127.0.0.1:5432/test',
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-not-a-real-credential',
  SITE_TIMEZONE: 'Asia/Karachi',
  /*
    A test run's request volume must not depend on a production throttle.

    The mutation limiter is keyed by IP, and a route suite drives dozens
    of requests from 127.0.0.1 through one shared limiter - so the
    production default of 30 turns "this suite grew" into "an unrelated
    test now returns 429". The limiter itself, including its rejection
    behaviour and its sanitized 429, is proven directly in
    middleware/rateLimit.test.ts against its own instances, which do not
    read this value.
  */
  RATE_LIMIT_MUTATION_MAX: '1000',
};

for (const key of OPERATOR_ONLY_KEYS) delete process.env[key];
for (const [key, value] of Object.entries(DETERMINISTIC_KEYS)) process.env[key] = value;

/** Exported so a test can assert the isolation itself is in force. */
export const testEnvIsolation = {
  operatorOnlyKeys: OPERATOR_ONLY_KEYS,
  deterministicKeys: Object.keys(DETERMINISTIC_KEYS),
} as const;
