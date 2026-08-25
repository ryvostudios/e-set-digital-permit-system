import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * Exercises the REAL Express app/router (`createApp`, `permitsRouter`,
 * `requireAuth`, `requireCapability`) over actual HTTP requests, to prove
 * the closure route's *wiring* - unauthenticated/unauthorized/authorized
 * behavior and which capability it checks - rather than its business
 * logic, which `domain/permits/service.test.ts` already covers.
 *
 * Only the two true external I/O boundaries are stubbed: Supabase token
 * verification (`supabase.auth.getClaims`) and the Postgres connection
 * (`Pool.prototype.query`/`connect`, both from the real `pg` package used
 * by `db/pool.ts`) - so no request in this file ever reaches a real
 * network or database. Nothing in the authorization architecture itself
 * (requireAuth, requireCapability, the route definitions) is bypassed,
 * mocked, or duplicated - it all runs for real against these two stubs.
 */

const VALID_TOKEN = 'route-test-valid-token';
const AUTHENTICATED_USER_ID = 'route-test-user-id';
const SOME_PERMIT_ID = '00000000-0000-0000-0000-000000000000';

let grantedCapabilities: string[] = [];

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;
const originalPoolConnect = Pool.prototype.connect;

before(() => {
  // Stub Supabase token verification: only VALID_TOKEN authenticates,
  // matching the { data, error } shape `requireAuth` reads.
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) {
      return { data: null, error: new Error('invalid token') };
    }
    return { data: { claims: { sub: AUTHENTICATED_USER_ID, email: null } }, error: null };
  }) as typeof supabase.auth.getClaims;

  // Stub the bare `Pool.query()` calls `resolveUserCapabilities` makes,
  // to return whichever capabilities the current test grants.
  Pool.prototype.query = (async () => ({
    rows: grantedCapabilities.map((name) => ({ name })),
  })) as unknown as typeof Pool.prototype.query;

  // Stub the transactional connection `withTransaction` (and so
  // `closePermit`) uses: every query on this fake client returns no
  // rows, so a request that reaches the handler resolves as "not_found"
  // (closePermit's own, real not-found handling) instead of touching a
  // real database.
  Pool.prototype.connect = (async () =>
    ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }) as unknown as PoolClient) as typeof Pool.prototype.connect;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
  Pool.prototype.connect = originalPoolConnect;
});

beforeEach(() => {
  grantedCapabilities = [];
});

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function closeRequest(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1/permits/${SOME_PERMIT_ID}/close`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 1 }),
  });
}

test('POST /permits/:id/close denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await closeRequest(url);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/close denies an authenticated actor without permit.close (403)', async () => {
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    const res = await closeRequest(url, VALID_TOKEN);
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/close lets an authenticated actor with permit.close reach the closure handler/service', async () => {
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    const res = await closeRequest(url, VALID_TOKEN);
    // Never short-circuited by either auth gate...
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    // ...and the fake DB backing this request has no matching permit, so
    // closePermit's own not-found outcome (404) is what proves control
    // actually reached the handler/service - not a stubbed-out auth
    // layer. Business-logic correctness of that outcome is covered in
    // domain/permits/service.test.ts, not here.
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('the close route is bound specifically to permit.close, not any other permit.* capability', async () => {
  grantedCapabilities = [
    'permit.create',
    'permit.submit',
    'permit.forward_hse',
    'permit.hse_review',
    'permit.fallback_approve',
  ];
  const { url, close } = await startServer();
  try {
    const res = await closeRequest(url, VALID_TOKEN);
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});
