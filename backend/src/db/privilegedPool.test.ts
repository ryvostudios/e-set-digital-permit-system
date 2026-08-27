import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closePrivilegedPool,
  createPrivilegedAccessAdmin,
  isPrivilegedChannelConfigured,
} from './privilegedPool.js';

/**
 * The privileged channel is a SEPARATE database login used for exactly
 * one thing. These tests pin the two properties that make it a security
 * boundary rather than a convenience: it fails closed when unconfigured,
 * and its surface is too narrow to be reused for anything else.
 *
 * `PRIVILEGED_DATABASE_URL` is intentionally NOT set in the test
 * environment, which is precisely the unconfigured case.
 */

test('an unconfigured privileged channel is unavailable, never a silent success', async () => {
  assert.equal(process.env.PRIVILEGED_DATABASE_URL, undefined, 'the test env must not configure it');
  assert.equal(isPrivilegedChannelConfigured(), false);
  // Null, not a no-op adapter: callers are forced to fail closed
  // explicitly rather than accidentally treating "did nothing" as "ok".
  assert.equal(createPrivilegedAccessAdmin(), null);
});

test('the module exposes only the two privileged operations - no pool, no client, no generic query', async () => {
  const module = await import('./privilegedPool.js');
  assert.deepEqual(Object.keys(module).sort(), [
    'closePrivilegedPool',
    'createPrivilegedAccessAdmin',
    'isPrivilegedChannelConfigured',
  ]);
  // Nothing here hands out a connection or a generic executor a permit,
  // account, or notification service could reach through. The only
  // "pool" export is the shutdown hook, which takes no arguments and
  // returns nothing.
  for (const name of Object.keys(module)) {
    assert.doesNotMatch(name, /client|query|exec|getPool|^pool/i);
  }
  assert.equal(module.closePrivilegedPool.length, 0);
});

test('the adapter interface carries no role argument at all', () => {
  // Compile-time shape, asserted at runtime: a caller supplies actor and
  // target only. SITE_MANAGER is fixed inside the database function, so
  // no argument from this process can produce a CEO grant.
  const admin = createPrivilegedAccessAdmin();
  if (admin) {
    assert.equal(admin.recordSiteManagerGrant.length, 2);
    assert.equal(admin.recordSiteManagerRevoke.length, 2);
  }
});

test('closing an unconfigured privileged pool is safe', async () => {
  await closePrivilegedPool();
});
