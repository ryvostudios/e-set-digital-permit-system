import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * Exercises the real `/auth/me` route wiring over HTTP, mirroring
 * `routes/permits.test.ts`'s approach: only the two true I/O boundaries
 * (Supabase token verification, the Postgres connection used by
 * `resolveUserCapabilities`) are stubbed - `requireAuth` and capability
 * resolution run for real.
 */

const VALID_TOKEN = 'auth-me-test-valid-token';
const AUTHENTICATED_USER_ID = 'auth-me-test-user-id';

let grantedCapabilities: string[] = [];
let appAccessState: 'ACTIVE' | 'DISABLED' | null = 'ACTIVE';

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;

before(() => {
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) {
      return { data: null, error: new Error('invalid token') };
    }
    return { data: { claims: { sub: AUTHENTICATED_USER_ID, email: 'user@example.com' } }, error: null };
  }) as typeof supabase.auth.getClaims;

  Pool.prototype.query = (async (text: unknown) => ({
    rows: String(text).includes('FROM app_user_access')
      ? (appAccessState ? [{ state: appAccessState }] : [])
      : grantedCapabilities.map((name) => ({ name })),
  })) as unknown as typeof Pool.prototype.query;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
});

beforeEach(() => {
  grantedCapabilities = [];
  appAccessState = 'ACTIVE';
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

test('GET /auth/me denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('GET /auth/me returns identity plus the caller\'s currently resolved capabilities', async () => {
  grantedCapabilities = ['permit.create', 'permit.submit'];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { auth: { id: string }; capabilities: string[] };
    assert.equal(body.auth.id, AUTHENTICATED_USER_ID);
    assert.deepEqual(body.capabilities.sort(), ['permit.create', 'permit.submit']);
  } finally {
    await close();
  }
});

test('GET /auth/me returns an empty capabilities array for a user with none (default-deny, not an error)', async () => {
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { capabilities: string[] };
    assert.deepEqual(body.capabilities, []);
  } finally {
    await close();
  }
});

test('GET /auth/me immediately rejects a valid token for a DISABLED user even if capabilities exist', async () => {
  appAccessState = 'DISABLED';
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('GET /auth/me fails closed when application access state is missing', async () => {
  appAccessState = null;
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});
