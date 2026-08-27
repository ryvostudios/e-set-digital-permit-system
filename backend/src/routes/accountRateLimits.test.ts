import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';

/**
 * Rate limiting on account management, exercised through the REAL route
 * stack and the REAL configured limiters.
 *
 * A SEPARATE FILE ON PURPOSE, for the same reason `permitFormRoutes.test.ts`
 * is separate: the limiters are per-process in-memory budgets, and a
 * test that deliberately sends 60+ requests would otherwise spend the
 * budget every other test in `accounts.test.ts` depends on. Node's test
 * runner gives each file its own process, so these start clean.
 *
 * WHY 503 IS THE SUCCESS CONDITION. `SUPABASE_SERVICE_ROLE_KEY` is not
 * configured in the test environment, so a fully authorized creation
 * reaches the Auth Admin boundary and stops there with 503. That is
 * exactly what these tests need: 503 proves the request passed
 * authentication, authorization AND the rate limiter. The assertions are
 * about what must NOT happen - 429 - not about Auth succeeding.
 */

const VALID_TOKEN = 'account-rate-limit-test-token';
const EMPLOYEE_ID = '10000000-0000-4000-8000-000000000003';
const TEAM_POSITION_ID = '40000000-0000-4000-8000-000000000001';
const COMPANY_ID = '18000000-0000-4000-8000-000000000001';
const FAKE_TEMPORARY_PASSWORD = 'FAKE-temporary-password-for-tests';

/** The business requirement: a legitimate admin session provisions this many people. */
const REQUIRED_SEQUENTIAL_CREATIONS = 60;

let actorCounter = 0;
function nextActorId(): string {
  actorCounter += 1;
  return `30000000-0000-4000-8000-${String(actorCounter).padStart(12, '0')}`;
}

let authenticatedUserId = nextActorId();
let grantedCapabilities: string[] = [];
let privilegedGrants: Record<string, string[]> = {};

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
    if (sql.includes('FROM app_user_access') && sql.startsWith('SELECT state')) {
      return { rows: [{ state: 'ACTIVE', must_change_password: false }] };
    }
    if (sql.startsWith('SELECT user_id FROM app_user_access')) {
      return { rows: String(params[0]) === EMPLOYEE_ID ? [{ user_id: params[0] }] : [] };
    }
    if (sql.startsWith('SELECT DISTINCT c.name')) {
      return { rows: grantedCapabilities.map((name) => ({ name })) };
    }
    if (sql.includes('FROM privileged_access_events')) {
      const roles = privilegedGrants[String(params[0])] ?? [];
      return { rows: roles.map((role) => ({ role, action: 'GRANTED' })) };
    }
    if (sql.includes('FROM team_positions') && sql.includes('site_manager_assignable = TRUE')) {
      return { rows: String(params[0]) === TEAM_POSITION_ID ? [{ exists: true }] : [] };
    }
    if (sql.includes('FROM companies')) {
      return { rows: [{ id: COMPANY_ID, code: params[0], name: 'E-SET' }] };
    }
    if (sql.startsWith('SELECT user_id FROM privileged_identities')) return { rows: [] };
    if (sql.includes('FROM workforce_profiles')) return { rows: [] };
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
  grantedCapabilities = [];
  privilegedGrants = {};
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

function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
    body: JSON.stringify(body),
  });
}

function get(url: string, path: string): Promise<Response> {
  return fetch(`${url}/api/v1${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
}

function authorizeAs(role: 'CEO' | 'SITE_MANAGER'): void {
  grantedCapabilities = [];
  privilegedGrants = { [authenticatedUserId]: [role] };
}

/** A distinct employee each time, exactly as a real onboarding batch would be. */
function createBody(index: number): Record<string, unknown> {
  return {
    email: `employee${index}@example.com`,
    temporaryPassword: FAKE_TEMPORARY_PASSWORD,
    displayName: `Employee Number ${index}`,
    companyCode: 'E_SET',
    teamPositionId: TEAM_POSITION_ID,
  };
}

// ---------------------------------------------------------------------
// The business requirement: no quota on employee creation
// ---------------------------------------------------------------------

for (const role of ['CEO', 'SITE_MANAGER'] as const) {
  const label = role === 'CEO' ? 'a CEO' : 'a System Site Manager';

  test(`${label} can create ${REQUIRED_SEQUENTIAL_CREATIONS} employees sequentially without ever being rate limited`, async () => {
    const { url, close } = await startServer();
    try {
      authorizeAs(role);
      for (let index = 1; index <= REQUIRED_SEQUENTIAL_CREATIONS; index += 1) {
        const response = await post(url, '/admin/employees', createBody(index));
        assert.notEqual(response.status, 429, `creation ${index} of ${REQUIRED_SEQUENTIAL_CREATIONS} was rate limited`);
        // 503 is the Auth Admin boundary in this environment - the request
        // got all the way past authorization, which is the point.
        assert.equal(response.status, 503, `creation ${index} should reach the Auth boundary`);
      }
    } finally {
      await close();
    }
  });
}

test('the 61st creation is not refused merely for being the 61st - there is no business quota', async () => {
  const { url, close } = await startServer();
  try {
    authorizeAs('CEO');
    for (let index = 1; index <= REQUIRED_SEQUENTIAL_CREATIONS; index += 1) {
      await post(url, '/admin/employees', createBody(index));
    }
    // The boundary the old default made people believe in. Nothing about
    // the number 60 means anything to this system.
    const sixtyFirst = await post(url, '/admin/employees', createBody(61));
    assert.notEqual(sixtyFirst.status, 429, 'the 61st creation must not be a cliff edge');
    assert.equal(sixtyFirst.status, 503);

    const seventieth = await post(url, '/admin/employees', createBody(70));
    assert.notEqual(seventieth.status, 429);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Abuse protection is still real
// ---------------------------------------------------------------------

test('sustained abuse well past the configured threshold IS rate limited', async () => {
  // Not "eventually, somewhere" - the budget is finite and this proves
  // where it ends. One request past the configured write limit is 429.
  const limit = env.RATE_LIMIT_MANAGER_ACCOUNT_MAX;
  const { url, close } = await startServer();
  try {
    authorizeAs('CEO');
    let refusedAt: number | null = null;
    for (let index = 1; index <= limit + 5; index += 1) {
      const response = await post(url, '/admin/employees', createBody(index));
      if (response.status === 429) {
        refusedAt = index;
        break;
      }
    }
    assert.equal(refusedAt, limit + 1, `abuse must be refused at request ${limit + 1}`);
    // And it stays refused within the window rather than recovering.
    assert.equal((await post(url, '/admin/employees', createBody(999))).status, 429);
  } finally {
    await close();
  }
});

test('the configured write budget clears a real onboarding session with headroom', () => {
  // A guard on the configuration itself, so a future tightening cannot
  // silently reintroduce the failure this run exists to fix.
  assert.ok(
    env.RATE_LIMIT_MANAGER_ACCOUNT_MAX >= 100,
    'manager writes must comfortably exceed a 60-employee session',
  );
  assert.ok(
    env.RATE_LIMIT_MANAGER_ACCOUNT_MAX > REQUIRED_SEQUENTIAL_CREATIONS,
    'the write budget must exceed the required session size',
  );
  // Still a limit. Removing it entirely is not the fix.
  assert.ok(Number.isFinite(env.RATE_LIMIT_MANAGER_ACCOUNT_MAX));
  // The coarse per-IP backstop must be able to carry that session too,
  // or the write budget would be unreachable in practice.
  assert.ok(env.RATE_LIMIT_GLOBAL_MAX > REQUIRED_SEQUENTIAL_CREATIONS * 2);
});

// ---------------------------------------------------------------------
// Budgets are per authenticated manager, and reads are budgeted apart
// ---------------------------------------------------------------------

test('two managers hold independent budgets - one cannot exhaust the other', async () => {
  const { url, close } = await startServer();
  try {
    // The first manager spends their entire write budget.
    const firstManager = authenticatedUserId;
    authorizeAs('CEO');
    for (let index = 1; index <= env.RATE_LIMIT_MANAGER_ACCOUNT_MAX; index += 1) {
      await post(url, '/admin/employees', createBody(index));
    }
    assert.equal((await post(url, '/admin/employees', createBody(1))).status, 429, 'the first manager is spent');

    // A different authenticated manager is unaffected.
    authenticatedUserId = nextActorId();
    assert.notEqual(authenticatedUserId, firstManager);
    authorizeAs('SITE_MANAGER');
    const other = await post(url, '/admin/employees', createBody(1));
    assert.notEqual(other.status, 429, 'a second manager must not inherit the first exhausted budget');
    assert.equal(other.status, 503);
  } finally {
    await close();
  }
});

test('browsing the directory does not consume the employee-creation budget', async () => {
  // The failure that made this limit unusable in practice: reads and
  // writes shared one budget, so opening the employee list and viewing a
  // few people spent the allowance a legitimate creation then needed.
  const { url, close } = await startServer();
  try {
    authorizeAs('CEO');
    for (let index = 0; index < 40; index += 1) {
      const listed = await get(url, '/admin/employees');
      assert.notEqual(listed.status, 429, 'reading the directory must not be rate limited this quickly');
      const audit = await get(url, '/admin/audit-logs');
      assert.notEqual(audit.status, 429, 'reading the audit log must not be rate limited this quickly');
    }

    // 80 reads later, the write budget is untouched and a full onboarding
    // session still succeeds.
    for (let index = 1; index <= REQUIRED_SEQUENTIAL_CREATIONS; index += 1) {
      const response = await post(url, '/admin/employees', createBody(index));
      assert.notEqual(response.status, 429, `creation ${index} was refused after ordinary browsing`);
    }
  } finally {
    await close();
  }
});

test('a manager password reset still shares the write budget rather than getting a free one', async () => {
  // Employee creation and password reset are both privileged Auth Admin
  // writes; loosening creation must not have quietly created an
  // unbudgeted path to reset abuse.
  const { url, close } = await startServer();
  try {
    authorizeAs('CEO');
    for (let index = 1; index <= env.RATE_LIMIT_MANAGER_ACCOUNT_MAX; index += 1) {
      await post(url, '/admin/employees', createBody(index));
    }
    const reset = await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, {
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
    });
    assert.equal(reset.status, 429, 'reset must draw on the same exhausted write budget');
  } finally {
    await close();
  }
});
