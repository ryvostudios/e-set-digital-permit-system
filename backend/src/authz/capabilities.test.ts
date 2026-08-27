import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { QueryFn } from '../db/pool.js';
import { resolveUserCapabilities, resolveUserIdsWithCapabilities } from './capabilities.js';

/**
 * Capability resolution must read ONLY the caller's current Team +
 * Position assignment. Migration 0019 keeps every assignment a user has
 * ever held and marks retired ones with `ended_at`, so a missing filter
 * here would silently let a transferred employee keep the authority of
 * every role they ever occupied - a CRO who moved to Civil would still
 * be able to close permits.
 */

const USER = '10000000-0000-4000-8000-000000000001';

let captured: Array<{ sql: string; params: unknown[] }> = [];
let capabilityRows: Array<{ name: string }> = [];

const originalPoolQuery = Pool.prototype.query;

before(() => {
  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    captured.push({ sql: String(text), params });
    return { rows: capabilityRows };
  }) as unknown as typeof Pool.prototype.query;
});

after(() => {
  Pool.prototype.query = originalPoolQuery;
});

beforeEach(() => {
  captured = [];
  capabilityRows = [];
});

test('resolveUserCapabilities reads only the CURRENT assignment', async () => {
  capabilityRows = [{ name: 'permit.create' }, { name: 'permit.submit' }];
  const capabilities = await resolveUserCapabilities(USER);
  assert.deepEqual([...capabilities].sort(), ['permit.create', 'permit.submit']);

  const sql = captured[0]?.sql ?? '';
  assert.match(sql, /utp\.ended_at IS NULL/, 'retired assignments must not grant anything');
  assert.deepEqual(captured[0]?.params, [USER], 'the user is always a bound parameter');
  // Authorization never consults a role label, a name, or Auth metadata.
  assert.doesNotMatch(sql, /privileged|user_metadata|email|display_name/i);
});

test('a user with no current assignment resolves to no capabilities, never an error', async () => {
  capabilityRows = [];
  assert.equal((await resolveUserCapabilities(USER)).size, 0);
});

test('resolveUserIdsWithCapabilities also excludes retired assignments', async () => {
  // A transferred employee must drop out of the CRO/HSE notification
  // queue immediately, not keep receiving permits for a role they left.
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const queryFn = (async (text: string, params: unknown[] = []) => {
    seen.push({ sql: String(text), params });
    return { rows: [{ user_id: USER }] };
  }) as unknown as QueryFn;

  assert.deepEqual(await resolveUserIdsWithCapabilities(['permit.cro_review'], queryFn), [USER]);
  assert.match(seen[0]?.sql ?? '', /utp\.ended_at IS NULL/);
  assert.deepEqual(seen[0]?.params, [['permit.cro_review']]);
});

test('an empty capability list short-circuits without touching the database', async () => {
  let called = false;
  const queryFn = (async () => { called = true; return { rows: [] }; }) as unknown as QueryFn;
  assert.deepEqual(await resolveUserIdsWithCapabilities([], queryFn), []);
  assert.equal(called, false);
});
