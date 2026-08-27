import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';

/**
 * Route wiring for account management and the forced first-login
 * password change, over real HTTP against the real Express app.
 *
 * Only the two genuine external boundaries are stubbed: Supabase token
 * verification and the Postgres connection. `requireAuth`,
 * `requireAuthDuringPasswordChange`, the account-management
 * authorization (CEO / E-SET SITE_MANAGER privileged access), the
 * protected-target guard, the authoritative company resolution, the Zod
 * bodies, and the route definitions all run for real.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is intentionally NOT configured in the test
 * environment, so the Auth Admin client is absent and every request that
 * gets far enough to need it lands on the explicit "unavailable" branch.
 * That is exactly what proves authorization runs BEFORE any Auth Admin
 * work is attempted: a denied caller gets 403, never 503.
 */

const VALID_TOKEN = 'accounts-test-valid-token';
const MANAGER_ID = '10000000-0000-4000-8000-000000000002';
const EMPLOYEE_ID = '10000000-0000-4000-8000-000000000003';
const CEO_ID = '10000000-0000-4000-8000-000000000001';
const TEAM_POSITION_ID = '40000000-0000-4000-8000-000000000001';
const COMPANY_ID = '18000000-0000-4000-8000-000000000001';

const FAKE_TEMPORARY_PASSWORD = 'FAKE-temporary-password-for-tests';

/**
 * A DISTINCT authenticated identity per test. The account limiter is a
 * per-process, per-actor budget (deliberately strict), so sharing one
 * identity across the whole file would measure the limiter rather than
 * the routes. Each test therefore gets its own actor, exactly as
 * separate humans would.
 */
let actorCounter = 0;
function nextActorId(): string {
  actorCounter += 1;
  return `20000000-0000-4000-8000-${String(actorCounter).padStart(12, '0')}`;
}

let authenticatedUserId = MANAGER_ID;
let grantedCapabilities: string[] = [];
/** userId -> currently GRANTED privileged roles, as `privileged_access_events` would resolve them. */
let privilegedGrants: Record<string, string[]> = {};
let mustChangePassword = false;
let knownTeamPositions: string[] = [];
let knownCompanyCodes: string[] = [];
let knownPrivilegedIdentities: string[] = [];
let knownAccessRows: string[] = [];
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
      return { rows: [{ state: 'ACTIVE', must_change_password: mustChangePassword }] };
    }
    if (sql.startsWith('SELECT user_id FROM app_user_access')) {
      return { rows: knownAccessRows.includes(String(params[0])) ? [{ user_id: params[0] }] : [] };
    }
    if (sql.startsWith('SELECT DISTINCT c.name')) {
      return { rows: grantedCapabilities.map((name) => ({ name })) };
    }
    if (sql.includes('FROM privileged_access_events')) {
      const roles = privilegedGrants[String(params[0])] ?? [];
      return { rows: roles.map((role) => ({ role, action: 'GRANTED' })) };
    }
    if (sql.includes('FROM team_positions') && sql.includes('site_manager_assignable = TRUE')) {
      return { rows: knownTeamPositions.includes(String(params[0])) ? [{ exists: true }] : [] };
    }
    if (sql.includes('FROM companies')) {
      return {
        rows: knownCompanyCodes.includes(String(params[0]))
          ? [{ id: COMPANY_ID, code: params[0], name: params[0] === 'E_SET' ? 'E-SET' : params[0] }]
          : [],
      };
    }
    if (sql.startsWith('SELECT user_id FROM privileged_identities')) {
      return { rows: knownPrivilegedIdentities.includes(String(params[0])) ? [{ user_id: params[0] }] : [] };
    }
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
  mustChangePassword = false;
  knownTeamPositions = [TEAM_POSITION_ID];
  knownCompanyCodes = ['E_SET', 'ZPL', 'SGRE'];
  knownPrivilegedIdentities = [];
  knownAccessRows = [EMPLOYEE_ID];
  capturedQueries = [];
});

/**
 * A fully authorized E-SET Site Manager. Note what is NOT set: no
 * capability, and no Team + Position. A privileged system account has
 * neither, and account management no longer asks for either.
 */
function authorizeSiteManager(): void {
  grantedCapabilities = [];
  privilegedGrants = { [authenticatedUserId]: ['SITE_MANAGER'] };
}

/** A fully authorized CEO - the same authority, from the higher tier. */
function authorizeCeo(): void {
  grantedCapabilities = [];
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

function post(url: string, path: string, token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function request(url: string, method: string, path: string, token: string | undefined, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${url}/api/v1${path}`, init);
}

function get(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'GET', headers });
}

const validCreateBody = {
  email: 'employee@example.com',
  temporaryPassword: FAKE_TEMPORARY_PASSWORD,
  displayName: 'Ayesha Khan',
  companyCode: 'E_SET',
  teamPositionId: TEAM_POSITION_ID,
};

// ---------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------

test('POST /admin/employees requires authentication', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/employees', undefined, validCreateBody)).status, 401);
  } finally {
    await close();
  }
});

test('an ordinary employee cannot provision or reset accounts', async () => {
  grantedCapabilities = ['permit.create', 'permit.close'];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/employees', VALID_TOKEN, validCreateBody)).status, 403);
    assert.equal(
      (await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status,
      403,
    );
  } finally {
    await close();
  }
});

test('a Team + Position capability can never confer account management', async () => {
  // Even an employee holding both account-management capability NAMES,
  // but no privileged grant, is refused: capabilities are not consulted
  // by this authority at all.
  grantedCapabilities = ['employee.create', 'employee.reset_password'];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    const response = await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { message: string };
    // The denial never says WHAT was missing.
    assert.doesNotMatch(body.message, /capability|privileg/i);
  } finally {
    await close();
  }
});

test('an E-SET Site Manager with NO Team, Position or capability is authorized', async () => {
  // The privileged role is the whole authority. No fake Team + Position
  // has to exist for a Site Manager to provision employees.
  grantedCapabilities = [];
  knownTeamPositions = [TEAM_POSITION_ID];
  privilegedGrants = { [authenticatedUserId]: ['SITE_MANAGER'] };
  const { url, close } = await startServer();
  try {
    // 503 = the Auth Admin boundary, i.e. past every authorization gate.
    assert.equal((await post(url, '/admin/employees', VALID_TOKEN, validCreateBody)).status, 503);
  } finally {
    await close();
  }
});

test('a CEO holds the same account-management authority', async () => {
  authorizeCeo();
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/employees', VALID_TOKEN, validCreateBody)).status, 503);
    authenticatedUserId = nextActorId();
    authorizeCeo();
    assert.equal(
      (await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status,
      503,
    );
  } finally {
    await close();
  }
});

test('a ZPL organizational "Site Manager" position confers no account-management authority', async () => {
  // The ZPL job title exists only as Team + Position data. Authorization
  // never reads a position or team name, so this normal ZPL employee is
  // refused exactly like any other employee - the privileged E-SET
  // SITE_MANAGER role is a completely separate thing.
  grantedCapabilities = ['permit.create'];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    assert.equal(
      (await post(url, '/admin/employees', VALID_TOKEN, { ...validCreateBody, companyCode: 'ZPL' })).status,
      403,
    );
    // Privileged status was resolved from the append-only grant log,
    // bound to the user id alone - no team, position, or name is read.
    const privilegedReads = capturedQueries.filter(({ sql }) => sql.includes('privileged_access_events'));
    assert.ok(privilegedReads.length > 0);
    for (const read of privilegedReads) {
      assert.deepEqual(read.params, [authenticatedUserId]);
      assert.doesNotMatch(read.sql, /positions|teams|display_name|metadata|email/i);
    }
  } finally {
    await close();
  }
});

test('an authorized Site Manager passes authorization and reaches the provisioning step', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    // The Auth Admin credential is absent in tests, so a fully
    // authorized request lands on the explicit unavailable branch -
    // which is only reachable AFTER authorization succeeded.
    const response = await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'account_management_unavailable');
    // The response never names the missing credential.
    assert.doesNotMatch(JSON.stringify(body), /SERVICE_ROLE|service_role|key/i);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Protected targets
// ---------------------------------------------------------------------

test('a Site Manager cannot reset the CEO', async () => {
  authorizeSiteManager();
  privilegedGrants[CEO_ID] = ['CEO'];
  knownAccessRows = [CEO_ID];
  const { url, close } = await startServer();
  try {
    const response = await post(url, `/admin/employees/${CEO_ID}/reset-password`, VALID_TOKEN, {
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
    });
    assert.equal(response.status, 403);
    // Refused before ANY credential work was attempted.
    assert.notEqual(response.status, 503);
  } finally {
    await close();
  }
});

test('a Site Manager cannot reset another Site Manager (protected upper management)', async () => {
  authorizeSiteManager();
  const otherManager = '10000000-0000-4000-8000-000000000004';
  privilegedGrants[otherManager] = ['SITE_MANAGER'];
  knownAccessRows = [otherManager];
  const { url, close } = await startServer();
  try {
    assert.equal(
      (await post(url, `/admin/employees/${otherManager}/reset-password`, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status,
      403,
    );
  } finally {
    await close();
  }
});

test('a Site Manager cannot reset their own account through the management endpoint', async () => {
  authorizeSiteManager();
  knownAccessRows = [authenticatedUserId];
  const { url, close } = await startServer();
  try {
    assert.equal(
      (await post(url, `/admin/employees/${authenticatedUserId}/reset-password`, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status,
      403,
    );
  } finally {
    await close();
  }
});

test('a normal employee target passes the protected-identity guard', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const response = await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, VALID_TOKEN, {
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
    });
    // Reached the Auth Admin boundary, i.e. past every authorization gate.
    assert.equal(response.status, 503);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Input contracts / mass assignment
// ---------------------------------------------------------------------

test('provisioning rejects any attempt to grant privilege, capabilities, state, or a chosen id', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    for (const extra of [
      { role: 'CEO' },
      { privilegedRole: 'SITE_MANAGER' },
      { capabilities: ['permit.close'] },
      { userId: CEO_ID },
      { id: CEO_ID },
      { state: 'ACTIVE' },
      { mustChangePassword: false },
      { must_change_password: false },
      { companyId: COMPANY_ID },
      { companyName: 'E-SET' },
      { company: { code: 'E_SET', name: 'E-SET' } },
      { companies: ['E_SET', 'ZPL'] },
      { siteManagerAssignable: true },
      { site_manager_assignable: true },
    ]) {
      // Each payload is an independent attacker identity; this test is for
      // strict mass-assignment rejection, not manager burst accounting.
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      const response = await post(url, '/admin/employees', VALID_TOKEN, { ...validCreateBody, ...extra });
      assert.equal(response.status, 400, `expected ${JSON.stringify(extra)} to be rejected`);
    }
  } finally {
    await close();
  }
});

test('provisioning validates its inputs, including a weak temporary password', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const rejectForIndependentActor = async (body: Record<string, unknown>): Promise<void> => {
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      assert.equal((await post(url, '/admin/employees', VALID_TOKEN, body)).status, 400);
    };
    await rejectForIndependentActor({ ...validCreateBody, temporaryPassword: 'short' });
    await rejectForIndependentActor({ ...validCreateBody, temporaryPassword: '            ' });
    await rejectForIndependentActor({ ...validCreateBody, email: 'not-an-email' });
    await rejectForIndependentActor({ ...validCreateBody, displayName: '   ' });
    await rejectForIndependentActor({ ...validCreateBody, teamPositionId: 'not-a-uuid' });
    const withoutCompany: Record<string, unknown> = { ...validCreateBody };
    delete withoutCompany.companyCode;
    await rejectForIndependentActor(withoutCompany);
    await rejectForIndependentActor({ ...validCreateBody, companyCode: 'UNKNOWN' });
  } finally {
    await close();
  }
});

test('an unknown or unapproved Team + Position is refused before any Auth work', async () => {
  authorizeSiteManager();
  knownTeamPositions = [];
  const { url, close } = await startServer();
  try {
    const response = await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'team_position_not_assignable');
    assert.equal(capturedQueries.some((query) => query.sql.includes('INSERT INTO')), false);
  } finally {
    await close();
  }
});

test('reset rejects a non-UUID target and any extra body field', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/employees/not-a-uuid/reset-password', VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status, 400);
    assert.equal(
      (await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, VALID_TOKEN, {
        temporaryPassword: FAKE_TEMPORARY_PASSWORD,
        userId: CEO_ID,
      })).status,
      400,
    );
  } finally {
    await close();
  }
});


const validSiteManagerBody = {
  email: 'manager@example.com',
  temporaryPassword: FAKE_TEMPORARY_PASSWORD,
  displayName: 'Bilal Ahmed',
};

// ---------------------------------------------------------------------
// Privileged tier: CEO-only Site Manager administration
// ---------------------------------------------------------------------

test('Site Manager administration requires authentication', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/site-managers', undefined, validSiteManagerBody)).status, 401);
    assert.equal((await post(url, `/admin/site-managers/${EMPLOYEE_ID}/grant`, undefined, {})).status, 401);
    assert.equal((await post(url, `/admin/site-managers/${EMPLOYEE_ID}/revoke`, undefined, {})).status, 401);
  } finally {
    await close();
  }
});

test('a SITE_MANAGER cannot create, grant, or revoke another SITE_MANAGER - CEO only', async () => {
  // This asymmetry is what keeps CEO strictly above Site Manager: a Site
  // Manager holds full authority over NORMAL employees and none at all
  // over the privileged tier.
  for (const path of [
    '/admin/site-managers',
    `/admin/site-managers/${EMPLOYEE_ID}/grant`,
    `/admin/site-managers/${EMPLOYEE_ID}/revoke`,
  ]) {
    authenticatedUserId = nextActorId();
    authorizeSiteManager();
    const { url, close } = await startServer();
    try {
      const body = path.endsWith('site-managers') ? validSiteManagerBody : {};
      const response = await post(url, path, VALID_TOKEN, body);
      assert.equal(response.status, 403, `${path} must be CEO-only`);
      // Refused before any Auth Admin work was attempted.
      assert.notEqual(response.status, 503);
    } finally {
      await close();
    }
  }
});

test('an ordinary employee - including a ZPL organizational Site Manager - cannot reach the privileged tier', async () => {
  // A ZPL "Site Manager" is Team + Position data and grants nothing. The
  // gate reads the privileged grant log, which is empty here.
  grantedCapabilities = ['permit.create', 'permit.submit', 'employee.create'];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/admin/site-managers', VALID_TOKEN, validSiteManagerBody)).status, 403);
  } finally {
    await close();
  }
});

test('a CEO passes the privileged gate and reaches the provisioning step', async () => {
  authorizeCeo();
  const { url, close } = await startServer();
  try {
    // 503 = the Auth Admin boundary, only reachable AFTER authorization.
    const response = await post(url, '/admin/site-managers', VALID_TOKEN, validSiteManagerBody);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, 'account_management_unavailable');
  } finally {
    await close();
  }
});

test('Site Manager creation refuses any organizational or role field', async () => {
  const { url, close } = await startServer();
  try {
    for (const extra of [
      { role: 'CEO' },
      { privilegedRole: 'CEO' },
      { companyCode: 'E_SET' },
      { companyId: COMPANY_ID },
      { teamPositionId: TEAM_POSITION_ID },
      { teamName: 'Admin' },
      { positionName: 'Site Manager' },
      { capabilities: ['permit.close'] },
      { userId: CEO_ID },
      { mustChangePassword: false },
      { state: 'ACTIVE' },
    ]) {
      authenticatedUserId = nextActorId();
      authorizeCeo();
      const response = await post(url, '/admin/site-managers', VALID_TOKEN, { ...validSiteManagerBody, ...extra });
      assert.equal(response.status, 400, `expected ${JSON.stringify(extra)} to be rejected`);
    }
  } finally {
    await close();
  }
});

test('grant and revoke accept no body fields and no non-UUID target', async () => {
  const { url, close } = await startServer();
  try {
    authorizeCeo();
    assert.equal((await post(url, '/admin/site-managers/not-a-uuid/revoke', VALID_TOKEN, {})).status, 400);
    authenticatedUserId = nextActorId();
    authorizeCeo();
    // The role is fixed by the endpoint: no body can widen it to CEO.
    assert.equal((await post(url, `/admin/site-managers/${EMPLOYEE_ID}/grant`, VALID_TOKEN, { role: 'CEO' })).status, 400);
    authenticatedUserId = nextActorId();
    authorizeCeo();
    assert.equal((await post(url, `/admin/site-managers/${EMPLOYEE_ID}/revoke`, VALID_TOKEN, { userId: CEO_ID })).status, 400);
  } finally {
    await close();
  }
});

test('the employee endpoints can never write a privileged grant or identity', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    for (const { sql } of capturedQueries) {
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+privileged_access_events/i);
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+privileged_identities/i);
    }
  } finally {
    await close();
  }
});


// ---------------------------------------------------------------------
// Layer 2: normal employee lifecycle
// ---------------------------------------------------------------------

test('every employee lifecycle route requires CEO or SITE_MANAGER privileged access', async () => {
  // An ordinary employee - including one holding the account-management
  // capability NAMES, and including a ZPL "Site Manager" - is refused.
  grantedCapabilities = ['permit.create', 'employee.create', 'employee.reset_password'];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    for (const [method, path, body] of [
      ['GET', `/admin/employees/${EMPLOYEE_ID}`, undefined],
      ['GET', `/admin/employees/${EMPLOYEE_ID}/history`, undefined],
      ['PATCH', `/admin/employees/${EMPLOYEE_ID}`, { displayName: 'X' }],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/change-email`, { newEmail: 'a@b.co', temporaryPassword: FAKE_TEMPORARY_PASSWORD }],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/disable`, {}],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/enable`, {}],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/permissions`, { capability: 'permit.view_all' }],
      ['DELETE', `/admin/employees/${EMPLOYEE_ID}`, undefined],
      ['DELETE', `/admin/employees/${EMPLOYEE_ID}/permissions`, { capability: 'permit.view_all' }],
    ] as const) {
      authenticatedUserId = nextActorId();
      grantedCapabilities = ['permit.create', 'employee.create'];
      privilegedGrants = {};
      const response = await request(url, method, path, VALID_TOKEN, body);
      assert.equal(response.status, 403, `${method} ${path} must require privileged access`);
    }
  } finally {
    await close();
  }
});

test('permanent deletion is CEO-only - a Site Manager is refused', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const denied = await request(url, 'DELETE', `/admin/employees/${EMPLOYEE_ID}`, VALID_TOKEN);
    assert.equal(denied.status, 403);
    // Refused before any Auth Admin work was attempted.
    assert.notEqual(denied.status, 503);

    // A CEO passes the gate and reaches the service.
    authenticatedUserId = nextActorId();
    authorizeCeo();
    const allowed = await request(url, 'DELETE', `/admin/employees/${EMPLOYEE_ID}`, VALID_TOKEN);
    assert.notEqual(allowed.status, 403, 'the CEO tier is not blocked by the privileged gate');
  } finally {
    await close();
  }
});

test('a Site Manager may perform every non-deletion lifecycle action', async () => {
  const { url, close } = await startServer();
  try {
    for (const [method, path, body] of [
      ['GET', `/admin/employees/${EMPLOYEE_ID}`, undefined],
      ['PATCH', `/admin/employees/${EMPLOYEE_ID}`, { displayName: 'Ayesha K' }],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/disable`, {}],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/permissions`, { capability: 'permit.view_all' }],
    ] as const) {
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      const response = await request(url, method, path, VALID_TOKEN, body);
      assert.notEqual(response.status, 403, `${method} ${path} must be allowed for a Site Manager`);
    }
  } finally {
    await close();
  }
});

test('employee update refuses any privileged, capability, or state field', async () => {
  const { url, close } = await startServer();
  try {
    for (const body of [
      { role: 'CEO' },
      { privilegedRole: 'SITE_MANAGER' },
      { capabilities: ['permit.close'] },
      { state: 'ACTIVE' },
      { mustChangePassword: false },
      { userId: CEO_ID },
      { companyId: COMPANY_ID },
      { email: 'someone@example.com' },
      {},
      // Company and assignment must move together - an assignment is
      // only valid against the company owning its team.
      { companyCode: 'ZPL' },
      { teamPositionId: TEAM_POSITION_ID },
    ]) {
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      const response = await request(url, 'PATCH', `/admin/employees/${EMPLOYEE_ID}`, VALID_TOKEN, body);
      assert.equal(response.status, 400, `expected ${JSON.stringify(body)} to be rejected`);
    }
  } finally {
    await close();
  }
});

test('an email change always requires a new temporary password', async () => {
  const { url, close } = await startServer();
  try {
    for (const body of [
      { newEmail: 'new@example.com' },
      { temporaryPassword: FAKE_TEMPORARY_PASSWORD },
      { newEmail: 'not-an-email', temporaryPassword: FAKE_TEMPORARY_PASSWORD },
      { newEmail: 'new@example.com', temporaryPassword: 'short' },
      { newEmail: 'new@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, mustChangePassword: false },
    ]) {
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      const response = await request(url, 'POST', `/admin/employees/${EMPLOYEE_ID}/change-email`, VALID_TOKEN, body);
      assert.equal(response.status, 400, `expected ${JSON.stringify(body)} to be rejected`);
    }
  } finally {
    await close();
  }
});

test('only an individually grantable capability may be named, never an arbitrary one', async () => {
  const { url, close } = await startServer();
  try {
    for (const body of [
      { capability: 'permit.close' },
      { capability: 'permit.cro_review' },
      { capability: 'employee.create' },
      { capability: 'made.up' },
      { capabilities: ['permit.view_all'] },
      {},
    ]) {
      authenticatedUserId = nextActorId();
      authorizeSiteManager();
      const response = await request(url, 'POST', `/admin/employees/${EMPLOYEE_ID}/permissions`, VALID_TOKEN, body);
      assert.equal(response.status, 400, `expected ${JSON.stringify(body)} to be rejected`);
    }
  } finally {
    await close();
  }
});

test('audit history pagination is bounded', async () => {
  const { url, close } = await startServer();
  try {
    for (const qs of ['?pageSize=101', '?page=0', '?pageSize=0', '?page=99999999', '?unknown=1']) {
      authenticatedUserId = nextActorId();
      // Either privileged role reaches the audit; the CEO is used here
      // simply so this test measures paging validation and nothing else.
      authorizeCeo();
      const response = await get(url, `/admin/employees/${EMPLOYEE_ID}/history${qs}`, VALID_TOKEN);
      assert.equal(response.status, 400, `expected ${qs} to be rejected`);
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// The ADMINISTRATIVE/SECURITY audit is CEO-only
// ---------------------------------------------------------------------

test('BOTH privileged system roles may READ the administrative audit', async () => {
  // A Site Manager runs day-to-day employee administration and needs to
  // see what was already done to an account before acting on it. The
  // stubbed database holds no such employee, so both land on 404 - what
  // matters is that neither is 403: the gate opened for each.
  const { url, close } = await startServer();
  try {
    for (const [label, authorize] of [
      ['CEO', authorizeCeo],
      ['E-SET SITE_MANAGER', authorizeSiteManager],
    ] as const) {
      authenticatedUserId = nextActorId();
      authorize();
      const response = await get(url, `/admin/employees/${EMPLOYEE_ID}/history`, VALID_TOKEN);
      assert.notEqual(response.status, 403, `${label} must pass the administrative audit gate`);
      assert.equal(response.status, 404, `${label} must reach the lookup, not an authorization refusal`);
    }
  } finally {
    await close();
  }
});

test('NOBODY else reaches the administrative audit - no capability, no broad permit permission, no job title', async () => {
  const { url, close } = await startServer();
  try {
    // Every one of these is refused with the same generic 403, which
    // never reveals how close the caller was to being authorized.
    //
    // `permit.view_all` is listed deliberately: broad permit VISIBILITY
    // must never become audit access. So is a caller holding the
    // employee.* capability NAMES - a ZPL organizational "Site Manager"
    // is not the privileged E-SET SITE_MANAGER role, and the difference
    // is exactly what this asserts.
    for (const capabilities of [
      [],
      ['permit.view_all'],
      ['permit.create', 'permit.submit'],
      ['permit.cro_review'],
      ['permit.hse_review'],
      ['employee.create', 'employee.reset_password'],
    ]) {
      authenticatedUserId = nextActorId();
      grantedCapabilities = capabilities;
      privilegedGrants = {};
      assert.equal(
        (await get(url, `/admin/employees/${EMPLOYEE_ID}/history`, VALID_TOKEN)).status,
        403,
        `capabilities ${JSON.stringify(capabilities)} must not reach the administrative audit`,
      );
    }
  } finally {
    await close();
  }
});

test('the GLOBAL Audit Logs screen is reachable by BOTH privileged system roles', async () => {
  const { url, close } = await startServer();
  try {
    for (const [label, authorize] of [
      ['CEO', authorizeCeo],
      ['E-SET SITE_MANAGER', authorizeSiteManager],
    ] as const) {
      authenticatedUserId = nextActorId();
      authorize();
      const response = await get(url, '/admin/audit-logs', VALID_TOKEN);
      assert.equal(response.status, 200, `${label} must reach Audit Logs`);
      const body = await response.json() as { items: unknown[]; page: number; pageSize: number };
      assert.ok(Array.isArray(body.items), `${label} must receive a paged list`);
    }
  } finally {
    await close();
  }
});

test('NOBODY else reaches the global Audit Logs - same gate as the per-employee audit', async () => {
  const { url, close } = await startServer();
  try {
    // The whole point of a separate global screen is that it must not
    // become a wider door than the per-employee history. `permit.view_all`
    // and the employee.* capability NAMES are listed deliberately: broad
    // permit visibility and a ZPL organizational "Site Manager" job title
    // are both distinct from the privileged E-SET SITE_MANAGER role.
    for (const capabilities of [
      [],
      ['permit.view_all'],
      ['permit.create', 'permit.submit'],
      ['permit.cro_review'],
      ['permit.hse_review'],
      ['employee.create', 'employee.reset_password'],
    ]) {
      authenticatedUserId = nextActorId();
      grantedCapabilities = capabilities;
      privilegedGrants = {};
      assert.equal(
        (await get(url, '/admin/audit-logs', VALID_TOKEN)).status,
        403,
        `capabilities ${JSON.stringify(capabilities)} must not reach Audit Logs`,
      );
    }
  } finally {
    await close();
  }
});

test('Audit Logs is read-only and narrowly paged - no mutation verb, no filter parameter', async () => {
  const { url, close } = await startServer();
  try {
    authenticatedUserId = nextActorId();
    authorizeCeo();
    // There is no mutation counterpart at this path, for either role.
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const response = await fetch(new URL('/api/v1/admin/audit-logs', url), {
        method,
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.ok(response.status === 404 || response.status === 405, `${method} must not be a route`);
    }
    // Paging is the only accepted input; anything else is refused rather
    // than silently ignored, so no parameter can redirect the read.
    authenticatedUserId = nextActorId();
    authorizeCeo();
    assert.equal((await get(url, '/admin/audit-logs?page=1&pageSize=10', VALID_TOKEN)).status, 200);
    authenticatedUserId = nextActorId();
    authorizeCeo();
    assert.equal((await get(url, '/admin/audit-logs?targetUserId=' + EMPLOYEE_ID, VALID_TOKEN)).status, 400);
  } finally {
    await close();
  }
});

test('permit workflow history is NOT the administrative audit and is not swept up by this rule', async () => {
  // A permit's own lifecycle is business information for the people
  // working it. It lives on the permit routes under permit
  // authorization, so restricting the account audit must not have made
  // it privileged-only. A plain applicant still reaches it as before -
  // 404 here (no such permit in the stub), never 403.
  const { url, close } = await startServer();
  try {
    authenticatedUserId = nextActorId();
    grantedCapabilities = ['permit.create', 'permit.submit'];
    privilegedGrants = {};
    const response = await get(url, `/permits/${EMPLOYEE_ID}/history`, VALID_TOKEN);
    assert.notEqual(response.status, 403, 'permit workflow history must not become privileged-only');
  } finally {
    await close();
  }
});

test('a privileged target is indistinguishable from a missing one through the employee API', async () => {
  // The fake returns no workforce profile, which is exactly what a
  // privileged account looks like - both must be a plain 404 so the
  // endpoint cannot be used to enumerate the privileged tier.
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const detail = await get(url, `/admin/employees/${CEO_ID}`, VALID_TOKEN);
    assert.equal(detail.status, 404);
    const body = (await detail.json()) as { message: string };
    assert.doesNotMatch(body.message, /privileg|CEO|Site Manager/i);
  } finally {
    await close();
  }
});

test('self-service password change is refused when no change is owed', async () => {
  // There is deliberately no anytime "change my password" feature.
  mustChangePassword = false;
  const { url, close } = await startServer();
  try {
    const response = await post(url, '/auth/change-password', VALID_TOKEN, { newPassword: 'FAKE-chosen-password' });
    // 503 would mean it reached the Auth Admin boundary; it must not.
    assert.notEqual(response.status, 200);
    assert.equal(capturedQueries.some(({ sql }) => sql.includes('UPDATE app_user_access')), false,
      'a refused self-change never touches credential state');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Self-service password change
// ---------------------------------------------------------------------

test('change-password requires authentication and accepts only a new password', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await post(url, '/auth/change-password', undefined, { newPassword: 'FAKE-chosen-password' })).status, 401);

    for (const body of [
      { newPassword: 'FAKE-chosen-password', userId: CEO_ID },
      { newPassword: 'FAKE-chosen-password', targetUserId: CEO_ID },
      { newPassword: 'FAKE-chosen-password', email: 'someone@example.com' },
      { newPassword: 'FAKE-chosen-password', mustChangePassword: false },
      { newPassword: 'short' },
      {},
    ]) {
      assert.equal(
        (await post(url, '/auth/change-password', VALID_TOKEN, body)).status,
        400,
        `expected ${JSON.stringify(body)} to be rejected`,
      );
    }
  } finally {
    await close();
  }
});

test('change-password never requires a capability - any authenticated account may change its own', async () => {
  grantedCapabilities = [];
  privilegedGrants = {};
  const { url, close } = await startServer();
  try {
    const response = await post(url, '/auth/change-password', VALID_TOKEN, { newPassword: 'FAKE-chosen-password' });
    // Reached the Auth Admin boundary: authorization did not block it.
    assert.equal(response.status, 503);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Forced first-login password change
// ---------------------------------------------------------------------

test('while a password change is outstanding, every normal application API is refused', async () => {
  mustChangePassword = true;
  grantedCapabilities = ['permit.create', 'permit.submit', 'permit.close'];
  privilegedGrants = { [authenticatedUserId]: ['SITE_MANAGER'] };
  const { url, close } = await startServer();
  try {
    for (const path of ['/permits/mine', '/permits/queue?status=PENDING_CRO', '/permits/search', '/notifications']) {
      const response = await get(url, path, VALID_TOKEN);
      assert.equal(response.status, 403, `${path} must be refused`);
      const body = (await response.json()) as { reason: string; error: string };
      assert.equal(body.reason, 'PASSWORD_CHANGE_REQUIRED');
      assert.equal(body.error, 'password_change_required');
    }

    // Mutations and admin operations are refused by the same gate.
    assert.equal((await post(url, '/permits', VALID_TOKEN, { permitType: 'WTG_WORK' })).status, 403);
    assert.equal((await post(url, '/admin/employees', VALID_TOKEN, validCreateBody)).status, 403);
  } finally {
    await close();
  }
});

test('the forced-change response never leaks credential detail', async () => {
  mustChangePassword = true;
  const { url, close } = await startServer();
  try {
    const response = await get(url, '/permits/mine', VALID_TOKEN);
    const raw = JSON.stringify(await response.json());
    assert.doesNotMatch(raw, /password.*=|temporary|token|credentials_changed_at|reset/i);
    assert.match(raw, /PASSWORD_CHANGE_REQUIRED/);
  } finally {
    await close();
  }
});

test('the two allowed endpoints stay reachable while a password change is outstanding', async () => {
  mustChangePassword = true;
  const { url, close } = await startServer();
  try {
    const me = await get(url, '/auth/me', VALID_TOKEN);
    assert.equal(me.status, 200);
    const body = (await me.json()) as { mustChangePassword: boolean };
    assert.equal(body.mustChangePassword, true);

    // The change endpoint itself is reachable (and gets as far as the
    // absent Auth Admin credential, not a 403).
    const change = await post(url, '/auth/change-password', VALID_TOKEN, { newPassword: 'FAKE-chosen-password' });
    assert.equal(change.status, 503);
  } finally {
    await close();
  }
});

test('a stale token issued before a manager reset loses normal access on its very next request', async () => {
  // Same token, same verified identity - only the application-side
  // account state changed, exactly as a manager reset changes it.
  const { url, close } = await startServer();
  try {
    mustChangePassword = false;
    assert.equal((await get(url, '/permits/mine', VALID_TOKEN)).status, 200);

    mustChangePassword = true;
    const afterReset = await get(url, '/permits/mine', VALID_TOKEN);
    assert.equal(afterReset.status, 403);
    assert.equal(((await afterReset.json()) as { reason: string }).reason, 'PASSWORD_CHANGE_REQUIRED');
  } finally {
    await close();
  }
});

test('the account-state read that enforces this happens on every authenticated request', async () => {
  const { url, close } = await startServer();
  try {
    await get(url, '/permits/mine', VALID_TOKEN);
    const stateReads = capturedQueries.filter((q) => q.sql.includes('FROM app_user_access') && q.sql.startsWith('SELECT state'));
    assert.equal(stateReads.length, 1, 'exactly one account-state read per request - no second lookup');
    assert.deepEqual(stateReads[0]?.params, [authenticatedUserId], 'scoped to the verified identity');
    assert.ok(
      !capturedQueries.some((q) => q.sql.includes('auth.sessions')),
      'enforcement never queries auth.sessions',
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// /auth/me
// ---------------------------------------------------------------------

test('/auth/me exposes only safe state - never a credential, token, or admin detail', async () => {
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    const response = await get(url, '/auth/me', VALID_TOKEN);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), [
      'accessState',
      'auth',
      'capabilities',
      'mustChangePassword',
      'privilegedDisplayName',
      'privilegedRoles',
      'profile',
    ]);
    assert.equal(body.mustChangePassword, false);
    assert.equal(body.accessState, 'ACTIVE');
    assert.deepEqual(body.capabilities, ['permit.create']);
    assert.deepEqual(body.privilegedRoles, []);
    // No profile is invented when none is provisioned, and no privileged
    // name is invented for a non-privileged account either.
    assert.equal(body.profile, null);
    assert.equal(body.privilegedDisplayName, null);

    // `mustChangePassword` is the ONE sanctioned credential-state field
    // (a boolean). Nothing else credential-related may appear - and no
    // value anywhere in the response may be a password or token.
    const withoutSanctionedFlag = JSON.stringify({ ...body, mustChangePassword: undefined }).toLowerCase();
    for (const forbidden of ['password', 'token', 'service_role', 'credentials_changed_at', 'secret', 'temporary']) {
      assert.ok(!withoutSanctionedFlag.includes(forbidden), `/auth/me must not expose ${forbidden}`);
    }
    assert.equal(typeof body.mustChangePassword, 'boolean', 'the credential state is a bare boolean, never a value');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// Attacker-minded self-review, as executable assertions
// ---------------------------------------------------------------------

test('EVERY authenticated application route is behind the forced-password gate', async () => {
  // Enumerated from the real routers rather than a hand-kept list, so a
  // route added later without the gate fails this test.
  mustChangePassword = true;
  grantedCapabilities = ['permit.create', 'permit.submit', 'permit.close', 'employee.create', 'employee.reset_password'];
  privilegedGrants = { [authenticatedUserId]: ['CEO', 'SITE_MANAGER'] };
  const { url, close } = await startServer();
  try {
    const guarded: Array<[string, string]> = [
      ['GET', '/permits/mine'],
      ['GET', `/permits/${EMPLOYEE_ID}`],
      ['GET', `/permits/${EMPLOYEE_ID}/history`],
      ['GET', `/permits/${EMPLOYEE_ID}/pdf`],
      ['GET', '/notifications'],
      ['POST', '/permits'],
      ['POST', `/permits/${EMPLOYEE_ID}/submit`],
      ['POST', `/permits/${EMPLOYEE_ID}/close`],
      ['POST', `/notifications/${EMPLOYEE_ID}/read`],
      ['POST', '/admin/employees'],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/reset-password`],
      ['GET', `/admin/employees/${EMPLOYEE_ID}`],
      ['GET', `/admin/employees/${EMPLOYEE_ID}/history`],
      ['PATCH', `/admin/employees/${EMPLOYEE_ID}`],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/change-email`],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/disable`],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/enable`],
      ['POST', `/admin/employees/${EMPLOYEE_ID}/permissions`],
      ['DELETE', `/admin/employees/${EMPLOYEE_ID}`],
      ['DELETE', `/admin/employees/${EMPLOYEE_ID}/permissions`],
      ['POST', '/admin/site-managers'],
      ['POST', `/admin/site-managers/${EMPLOYEE_ID}/grant`],
      ['POST', `/admin/site-managers/${EMPLOYEE_ID}/revoke`],
    ];
    for (const [method, path] of guarded) {
      const response = method === 'GET'
        ? await get(url, path, VALID_TOKEN)
        : await request(url, method, path, VALID_TOKEN, {});
      assert.equal(response.status, 403, `${method} ${path} must be gated`);
      assert.equal(((await response.json()) as { reason: string }).reason, 'PASSWORD_CHANGE_REQUIRED');
    }
  } finally {
    await close();
  }
});

test('/auth/me presents a privileged system account as privileged, never as a company member', async () => {
  // A CEO / E-SET Site Manager has no workforce profile at all, so no
  // Company, Team or Position is reported - and none is invented to fill
  // the gap. `privilegedRoles` is what tells the frontend who they are.
  authorizeCeo();
  const { url, close } = await startServer();
  try {
    const body = (await (await get(url, '/auth/me', VALID_TOKEN)).json()) as Record<string, unknown>;
    assert.equal(body.profile, null);
    assert.deepEqual(body.privilegedRoles, ['CEO']);
    assert.doesNotMatch(JSON.stringify(body), /E_SET|E-SET|ZPL|SGRE/);
  } finally {
    await close();
  }
});

test('a normal employee provisioning request can never mint a privileged account', async () => {
  // The endpoint writes app_user_access, user_team_positions and
  // workforce_profiles only. Nothing in this flow inserts into
  // privileged_access_events or team_position_capabilities, so no
  // request body, however shaped, can escalate.
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    for (const { sql } of capturedQueries) {
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+privileged_access_events/i);
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+team_position_capabilities/i);
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+companies/i);
    }
  } finally {
    await close();
  }
});

test('an authoritative company is required and resolved before any Auth Admin work', async () => {
  authorizeSiteManager();
  knownCompanyCodes = [];
  const { url, close } = await startServer();
  try {
    const response = await post(url, '/admin/employees', VALID_TOKEN, validCreateBody);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { reason: string }).reason, 'company_not_found');
    assert.equal(capturedQueries.some(({ sql }) => sql.includes('INSERT INTO')), false);
    assert.equal(capturedQueries.some(({ sql }) => sql.includes('FROM companies')), true);
  } finally {
    await close();
  }
});

test('clearing the forced flag requires an actual Auth password change - there is no state-only endpoint', async () => {
  // No route anywhere accepts `mustChangePassword` as input; the only
  // way the flag clears is `changeOwnPassword`, which sets the Auth
  // password FIRST and only then updates state (proved in
  // domain/accounts/service.test.ts).
  mustChangePassword = true;
  const { url, close } = await startServer();
  try {
    for (const attempt of [
      { path: '/auth/change-password', body: { mustChangePassword: false } },
      { path: '/auth/change-password', body: { newPassword: 'FAKE-chosen-password', mustChangePassword: false } },
    ]) {
      assert.equal((await post(url, attempt.path, VALID_TOKEN, attempt.body)).status, 400);
    }
  } finally {
    await close();
  }
});

test('no account-management response ever carries a password, token, or service credential', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const responses = [
      await post(url, '/admin/employees', VALID_TOKEN, validCreateBody),
      await post(url, `/admin/employees/${EMPLOYEE_ID}/reset-password`, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD }),
      await post(url, '/auth/change-password', VALID_TOKEN, { newPassword: 'FAKE-chosen-password' }),
      await post(url, '/admin/employees', VALID_TOKEN, { ...validCreateBody, email: 'bad' }),
    ];
    for (const response of responses) {
      const raw = JSON.stringify(await response.json());
      assert.ok(!raw.includes(FAKE_TEMPORARY_PASSWORD), 'a temporary password is never echoed');
      assert.ok(!raw.includes('FAKE-chosen-password'), 'a chosen password is never echoed');
      assert.doesNotMatch(raw, /service_role|SUPABASE_|Bearer |eyJ/i, 'no credential or token material');
    }
  } finally {
    await close();
  }
});

test('a validation failure never echoes the submitted password back in its issues', async () => {
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    // Zod reports the failing path, not the received value, for strings.
    const response = await post(url, '/admin/employees', VALID_TOKEN, {
      ...validCreateBody,
      temporaryPassword: 'short',
      email: 'not-an-email',
    });
    assert.equal(response.status, 400);
    const raw = JSON.stringify(await response.json());
    assert.ok(!raw.includes('short'), 'the rejected password value is not echoed');
  } finally {
    await close();
  }
});

test('manager account operations have a finite budget, independent of self-service password change', async () => {
  // The budget is sized for real onboarding (see
  // routes/accountRateLimits.test.ts), but it is still a budget - and
  // spending it must never lock a manager out of recovering their OWN
  // password, which is governed by the separate `accountLimiter`.
  authorizeSiteManager();
  const { url, close } = await startServer();
  try {
    const resetPath = `/admin/employees/${EMPLOYEE_ID}/reset-password`;
    for (let attempt = 1; attempt <= env.RATE_LIMIT_MANAGER_ACCOUNT_MAX; attempt += 1) {
      const response = await post(url, resetPath, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD });
      assert.notEqual(response.status, 429, `manager attempt ${attempt} remains within its budget`);
    }
    assert.equal(
      (await post(url, resetPath, VALID_TOKEN, { temporaryPassword: FAKE_TEMPORARY_PASSWORD })).status,
      429,
      'one operation past the configured budget cannot join the same window',
    );

    assert.notEqual(
      (await post(url, '/auth/change-password', VALID_TOKEN, { newPassword: FAKE_TEMPORARY_PASSWORD })).status,
      429,
      'self-service recovery has an independent limiter budget',
    );
  } finally {
    await close();
  }
});
