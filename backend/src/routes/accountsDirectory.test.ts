import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * Route wiring for the three READ-ONLY administrative directory
 * endpoints, over real HTTP against the real Express app.
 *
 * Only the two genuine external boundaries are stubbed (Supabase token
 * verification and the Postgres connection); `requireAuth`, the
 * privileged-access authorization, the Zod query schema and the route
 * definitions all run for real. What these tests establish is the
 * authorization boundary: a normal employee sees none of this, a Site
 * Manager sees the employee directory and the organization but NOT the
 * Site Manager tier, and a CEO sees all three.
 */

const VALID_TOKEN = 'accounts-directory-test-valid-token';

let actorCounter = 0;
function nextActorId(): string {
  actorCounter += 1;
  return `30000000-0000-4000-8000-${String(actorCounter).padStart(12, '0')}`;
}

let authenticatedUserId = nextActorId();
let privilegedGrants: Record<string, string[]> = {};
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;
const originalPoolConnect = Pool.prototype.connect;

before(() => {
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) return { data: null, error: new Error('invalid token') };
    return { data: { claims: { sub: authenticatedUserId, email: null } }, error: null };
  }) as typeof supabase.auth.getClaims;

  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).trim();
    capturedQueries.push({ sql, params });

    if (sql.includes('FROM app_user_access') && sql.startsWith('SELECT state')) {
      return { rows: [{ state: 'ACTIVE', must_change_password: false }] };
    }
    if (sql.startsWith('SELECT DISTINCT ON (role)') && sql.includes('FROM privileged_access_events')) {
      const roles = privilegedGrants[String(params[0])] ?? [];
      return { rows: roles.map((role) => ({ role, action: 'GRANTED' })) };
    }
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '1' }] };
    if (sql.includes('FROM app_user_access a')) {
      return {
        rows: [
          {
            user_id: '10000000-0000-4000-8000-000000000009',
            state: 'ACTIVE',
            must_change_password: false,
            display_name: 'Ali Khan',
            company_code: 'ZPL',
            company_name: 'ZPL',
            team_name: 'ZPL',
            position_name: 'Site Manager',
            team_position_id: '40000000-0000-4000-8000-000000000001',
            view_all_permits: false,
          },
        ],
      };
    }
    if (sql.includes('FROM team_positions tp')) {
      return {
        rows: [
          {
            company_code: 'E_SET',
            company_name: 'E-SET',
            team_name: 'E-BOP',
            position_name: 'CRO',
            team_position_id: '40000000-0000-4000-8000-000000000002',
          },
        ],
      };
    }
    if (sql.includes('FROM privileged_identities pi')) {
      return { rows: [{ user_id: 'u-1', display_name: 'Sara Ahmed', active: true, account_state: 'ACTIVE' }] };
    }
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;

  Pool.prototype.connect = (async () =>
    ({ query: async () => ({ rows: [] }), release: () => {} }) as unknown as PoolClient) as typeof Pool.prototype.connect;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
  Pool.prototype.connect = originalPoolConnect;
});

beforeEach(() => {
  authenticatedUserId = nextActorId();
  privilegedGrants = {};
  capturedQueries = [];
});

function authorizeSiteManager(): void {
  privilegedGrants = { [authenticatedUserId]: ['SITE_MANAGER'] };
}

function authorizeCeo(): void {
  privilegedGrants = { [authenticatedUserId]: ['CEO'] };
}

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

function get(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'GET', headers });
}

const DIRECTORY_PATHS = ['/admin/employees', '/admin/organization', '/admin/site-managers'];

test('every directory endpoint requires authentication', async () => {
  const { url, close } = await startServer();
  try {
    for (const path of DIRECTORY_PATHS) {
      assert.equal((await get(url, path)).status, 401, path);
      assert.equal((await get(url, path, 'not-a-real-token')).status, 401, path);
    }
  } finally {
    await close();
  }
});

test('a normal employee is denied every directory endpoint', async () => {
  const { url, close } = await startServer();
  try {
    for (const path of DIRECTORY_PATHS) {
      const response = await get(url, path, VALID_TOKEN);
      assert.equal(response.status, 403, path);
      assert.equal(((await response.json()) as { error: string }).error, 'forbidden');
    }
  } finally {
    await close();
  }
});

test('a Site Manager may read the employee directory and the organization', async () => {
  const { url, close } = await startServer();
  try {
    authorizeSiteManager();

    const employees = await get(url, '/admin/employees', VALID_TOKEN);
    assert.equal(employees.status, 200);
    const employeeBody = (await employees.json()) as {
      employees: Array<Record<string, unknown>>;
      pagination: { page: number; pageSize: number; totalCount: number; totalPages: number };
    };
    assert.equal(employeeBody.employees.length, 1);
    assert.deepEqual(employeeBody.pagination, { page: 1, pageSize: 25, totalCount: 1, totalPages: 1 });
    // Never an email, never credential internals.
    assert.ok(!JSON.stringify(employeeBody).includes('email'));

    const organization = await get(url, '/admin/organization', VALID_TOKEN);
    assert.equal(organization.status, 200);
    const organizationBody = (await organization.json()) as { companies: Array<{ code: string }> };
    assert.deepEqual(organizationBody.companies.map((company) => company.code), ['E_SET']);
  } finally {
    await close();
  }
});

test('a Site Manager may NOT read the Site Manager tier - that is CEO-only', async () => {
  const { url, close } = await startServer();
  try {
    authorizeSiteManager();
    const response = await get(url, '/admin/site-managers', VALID_TOKEN);
    assert.equal(response.status, 403);
  } finally {
    await close();
  }
});

test('the CEO may read the Site Manager tier', async () => {
  const { url, close } = await startServer();
  try {
    authorizeCeo();
    const response = await get(url, '/admin/site-managers', VALID_TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as unknown, {
      siteManagers: [{ userId: 'u-1', displayName: 'Sara Ahmed', active: true, accountState: 'ACTIVE' }],
    });
  } finally {
    await close();
  }
});

test('the employee directory rejects an unknown query parameter', async () => {
  const { url, close } = await startServer();
  try {
    authorizeSiteManager();
    const response = await get(url, '/admin/employees?role=CEO', VALID_TOKEN);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'invalid_request');
  } finally {
    await close();
  }
});

test('the employee directory rejects an out-of-range page size', async () => {
  const { url, close } = await startServer();
  try {
    authorizeSiteManager();
    assert.equal((await get(url, '/admin/employees?pageSize=5000', VALID_TOKEN)).status, 400);
    assert.equal((await get(url, '/admin/employees?page=0', VALID_TOKEN)).status, 400);
  } finally {
    await close();
  }
});

test('directory authorization is resolved before any directory query runs', async () => {
  const { url, close } = await startServer();
  try {
    await get(url, '/admin/employees', VALID_TOKEN);
    assert.ok(
      !capturedQueries.some((entry) => entry.sql.includes('FROM workforce_profiles wp')),
      'a denied caller must never cause the directory query to run',
    );
  } finally {
    await close();
  }
});

test('/admin/employees is matched as a literal path, not as an :id lookup', async () => {
  const { url, close } = await startServer();
  try {
    authorizeSiteManager();
    const response = await get(url, '/admin/employees', VALID_TOKEN);
    // The :id route would have rejected "employees" as a non-UUID (400),
    // or answered 404; a 200 list proves registration order is correct.
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});
