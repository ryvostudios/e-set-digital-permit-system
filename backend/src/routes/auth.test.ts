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
let mockMustChangePassword = false;
let mockProfileRows: Record<string, unknown>[] = [];
let mockPrivilegedRoles: string[] = [];

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;

before(() => {
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) {
      return { data: null, error: new Error('invalid token') };
    }
    return { data: { claims: { sub: AUTHENTICATED_USER_ID, email: 'user@example.com' } }, error: null };
  }) as typeof supabase.auth.getClaims;

  Pool.prototype.query = (async (text: unknown) => {
    const sql = String(text);
    if (sql.includes('FROM app_user_access')) {
      return { rows: appAccessState ? [{ state: appAccessState, must_change_password: mockMustChangePassword }] : [] };
    }
    if (sql.includes('FROM workforce_profiles')) return { rows: mockProfileRows };
    if (sql.includes('FROM privileged_access_events')) {
      return { rows: mockPrivilegedRoles.map((role) => ({ role, action: 'GRANTED' })) };
    }
    return { rows: grantedCapabilities.map((name) => ({ name })) };
  }) as unknown as typeof Pool.prototype.query;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
});

beforeEach(() => {
  grantedCapabilities = [];
  appAccessState = 'ACTIVE';
  mockMustChangePassword = false;
  mockProfileRows = [];
  mockPrivilegedRoles = [];
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
  mockProfileRows = [{
    display_name: 'Ayesha Khan',
    company_code: 'E_SET',
    company_name: 'E-SET',
    team_name: 'Maintenance',
    position_name: 'Technician',
  }];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      auth: { id: string };
      profile: unknown;
      privilegedRoles: string[];
      capabilities: string[];
    };
    assert.equal(body.auth.id, AUTHENTICATED_USER_ID);
    assert.deepEqual(body.capabilities.sort(), ['permit.create', 'permit.submit']);
    // The authoritative company travels with the profile, exactly as the
    // signing identity resolves it - never an email domain or a guess.
    assert.deepEqual(body.profile, {
      displayName: 'Ayesha Khan',
      company: { code: 'E_SET', name: 'E-SET' },
      teamName: 'Maintenance',
      positionName: 'Technician',
    });
    assert.deepEqual(body.privilegedRoles, []);
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

test('a privileged system account reports its roles and NO company, team or position', async () => {
  // CEO and E-SET SITE_MANAGER have no workforce profile at all, so
  // `/auth/me` reports a null profile rather than pretending they are
  // normal E-SET company members.
  mockProfileRows = [];
  mockPrivilegedRoles = ['SITE_MANAGER'];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    const body = (await res.json()) as { profile: unknown; privilegedRoles: string[] };
    assert.equal(body.profile, null);
    assert.deepEqual(body.privilegedRoles, ['SITE_MANAGER']);
  } finally {
    await close();
  }
});

test('a ZPL employee whose POSITION is called "Site Manager" holds no privileged role', async () => {
  // The position name is organizational data on the profile. Privileged
  // status comes only from the append-only grant log, which is empty
  // here - so the two can never be confused.
  mockProfileRows = [{
    display_name: 'Imran Malik',
    company_code: 'ZPL',
    company_name: 'ZPL',
    team_name: 'ZPL',
    position_name: 'Site Manager',
  }];
  mockPrivilegedRoles = [];
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    const body = (await res.json()) as {
      profile: { company: { code: string }; positionName: string };
      privilegedRoles: string[];
    };
    assert.equal(body.profile.positionName, 'Site Manager');
    assert.equal(body.profile.company.code, 'ZPL');
    assert.deepEqual(body.privilegedRoles, [], 'a position NAME never grants privileged access');
  } finally {
    await close();
  }
});
