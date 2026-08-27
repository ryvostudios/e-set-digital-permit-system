import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../config/env.js';
import { isPrivilegedChannelConfigured } from '../db/privilegedPool.js';
import { getSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { testEnvIsolation } from './envIsolation.js';

/**
 * The isolation itself, pinned.
 *
 * Before this existed, whether the suite passed depended on what was in
 * the machine's `backend/.env` - and a configured service-role key made
 * one test create REAL Auth users in the live Supabase project. These
 * assertions fail loudly if that coupling ever returns, including if
 * someone removes the `--import` hook from the `test` script.
 */

test('operator-only credentials are absent no matter what backend/.env contains', () => {
  for (const key of testEnvIsolation.operatorOnlyKeys) {
    assert.equal(
      process.env[key],
      undefined,
      `${key} must not leak into the test process - the suite would stop being deterministic, and a real credential could reach a live project`,
    );
  }
});

test('the optional adapters those credentials gate therefore fail closed', () => {
  // Not "probably null": these are the exact branches other tests rely on.
  assert.equal(getSupabaseAdminClient(), null);
  assert.equal(isPrivilegedChannelConfigured(), false);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.PRIVILEGED_DATABASE_URL, undefined);
});

test('required configuration is deterministic and points at nothing real', () => {
  // A stub that escaped its boundary must not find a live host waiting.
  assert.match(env.DATABASE_URL, /127\.0\.0\.1/);
  // Optional in the schema, so prove it is present before matching it.
  assert.ok(env.MIGRATION_DATABASE_URL);
  assert.match(env.MIGRATION_DATABASE_URL, /127\.0\.0\.1/);
  assert.match(env.SUPABASE_URL, /test-project\.supabase\.co/);
  assert.equal(env.SITE_TIMEZONE, 'Asia/Karachi');
});
