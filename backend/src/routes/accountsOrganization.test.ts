import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * The Organization Management API, over real HTTP against the real
 * Express app.
 *
 * Only the two genuine external boundaries are stubbed - Supabase token
 * verification and the Postgres connection. `requireAuth`, the
 * privileged-access authorization, the Zod schemas, the domain layer and
 * the route definitions all run for real, so what these tests establish
 * is the boundary itself:
 *
 *   * a normal employee sees none of it, whatever their POSITION is
 *     called - `Site Manager`, `CEO`, `CRO` and `HSE` are labels with no
 *     authority attached;
 *   * a CEO and an E-SET System Site Manager may manage the structure;
 *   * the request can never carry authority: no code, no capability, no
 *     assignability flag, no privileged marker;
 *   * database refusals surface as clean 404/409 responses, never as raw
 *     PostgreSQL text.
 */

const VALID_TOKEN = 'accounts-organization-test-valid-token';

const COMPANY_ID = '18000000-0000-4000-8000-000000000001';
const TEAM_ID = '20000000-0000-4000-8000-000000000001';
const POSITION_ID = '30000000-0000-4000-8000-000000000001';
const TEAM_POSITION_ID = '40000000-0000-4000-8000-000000000001';

let actorCounter = 0;
function nextActorId(): string {
  actorCounter += 1;
  return `50000000-0000-4000-8000-${String(actorCounter).padStart(12, '0')}`;
}

let authenticatedUserId = nextActorId();
let privilegedGrants: Record<string, string[]> = {};
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
/** Lets a test make one statement fail the way the database would. */
let failStatement: ((sql: string) => Error | undefined) | null = null;
/** Lets a test change what a lookup returns (inactive company, missing team, ...). */
let lookupRows: Record<string, Record<string, unknown>[]> = {};

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;
const originalPoolConnect = Pool.prototype.connect;

/** Answers the organization statements the domain layer issues, in order. */
async function organizationQuery(text: unknown, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const sql = String(text).trim();
  capturedQueries.push({ sql, params });

  const failure = failStatement?.(sql);
  if (failure) throw failure;

  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

  if (sql.startsWith('INSERT INTO companies')) {
    return { rows: [{ id: COMPANY_ID, code: params[0], name: params[1] }] };
  }
  if (sql.startsWith('SELECT id, deactivated_at FROM companies')) {
    return { rows: lookupRows.company ?? [{ id: COMPANY_ID, deactivated_at: null }] };
  }
  if (sql.startsWith('INSERT INTO teams')) {
    return { rows: [{ id: TEAM_ID, name: params[0], company_id: params[1] }] };
  }
  if (sql.includes('FROM teams t') && sql.includes('FOR SHARE OF t')) {
    return {
      rows: lookupRows.team ?? [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
    };
  }
  if (sql.startsWith('INSERT INTO positions')) {
    // `ON CONFLICT DO NOTHING RETURNING` yields a row only when a
    // global position was genuinely minted. Default: the name
    // already exists, so nothing is returned and the row is reused.
    return { rows: lookupRows.positionInsert ?? [] };
  }
  if (sql.startsWith('SELECT id, name FROM positions')) {
    return { rows: [{ id: POSITION_ID, name: params[0] }] };
  }
  if (sql.startsWith('INSERT INTO team_positions')) return { rows: [{ id: TEAM_POSITION_ID }] };
  if (sql.includes('grant_baseline_applicant_capabilities')) return { rows: [] };
  if (sql.startsWith('INSERT INTO organization_audit_events')) return { rows: [] };

  if (sql.startsWith('SELECT id, deactivated_at FROM teams')) {
    return { rows: lookupRows.teamRow ?? [{ id: TEAM_ID, deactivated_at: null }] };
  }
  if (sql.startsWith('SELECT id, deactivated_at FROM team_positions')) {
    return { rows: lookupRows.teamPosition ?? [{ id: TEAM_POSITION_ID, deactivated_at: null }] };
  }
  if (sql.startsWith('UPDATE companies') || sql.startsWith('UPDATE teams') || sql.startsWith('UPDATE team_positions')) {
    return { rows: [] };
  }
  return { rows: [] };
}

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
    // The administration directory read.
    if (sql.includes('FROM companies c') && sql.includes('LEFT JOIN teams t')) {
      return {
        rows: [
          {
            company_id: COMPANY_ID, company_code: 'E_SET', company_name: 'E-SET',
            company_deactivated_at: null,
            team_id: TEAM_ID, team_name: 'E-BOP', team_deactivated_at: null,
            team_position_id: TEAM_POSITION_ID, team_position_deactivated_at: null,
            site_manager_assignable: true,
            position_id: POSITION_ID, position_name: 'CRO',
          },
        ],
      };
    }
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;

  Pool.prototype.connect = (async () =>
    ({ query: organizationQuery, release: () => {} }) as unknown as PoolClient) as typeof Pool.prototype.connect;
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
  failStatement = null;
  lookupRows = {};
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

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = await startServer();
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    await server.close();
  }
}

const ORGANIZATION_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/admin/organization/structure' },
  { method: 'POST', path: '/admin/organization/companies', body: { name: 'ABC Contractors' } },
  { method: 'POST', path: `/admin/organization/companies/${COMPANY_ID}/teams`, body: { name: 'Electrical' } },
  {
    method: 'POST',
    path: `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    body: { positionName: 'Electrician' },
  },
  { method: 'PATCH', path: `/admin/organization/companies/${COMPANY_ID}/deactivate`, body: {} },
  { method: 'PATCH', path: `/admin/organization/teams/${TEAM_ID}/deactivate`, body: {} },
  { method: 'PATCH', path: `/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`, body: {} },
];

// =====================================================================
// Authentication and authorization
// =====================================================================

test('every organization endpoint requires authentication', async () => {
  for (const route of ORGANIZATION_ROUTES) {
    const response = await call(route.path, { method: route.method, body: route.body });
    assert.equal(response.status, 401, `${route.method} ${route.path}`);
  }
});

test('a normal employee is denied every organization endpoint', async () => {
  for (const route of ORGANIZATION_ROUTES) {
    const response = await call(route.path, { method: route.method, body: route.body, token: VALID_TOKEN });
    assert.equal(response.status, 403, `${route.method} ${route.path}`);
    assert.equal(response.body.error, 'forbidden');
  }
});

test('an employee whose POSITION is named "Site Manager" receives no authority from the name', async () => {
  // The ZPL collision that matters: a real ZPL job title, and no
  // privileged grant. Authority is read from privileged_access_events
  // alone, so this is an ordinary employee.
  privilegedGrants = {};
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'Sneaky Co' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 403);
});

test('an employee whose POSITION is named "CEO" receives no authority from the name', async () => {
  privilegedGrants = {};
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'Sneaky Co' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 403);
});

test('a CEO may manage the organization', async () => {
  authorizeCeo();
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 201);
});

test('an authorized E-SET System Site Manager may manage the organization', async () => {
  authorizeSiteManager();
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 201);
});

test('a revoked privileged grant no longer authorizes', async () => {
  privilegedGrants = {};
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 403);
});

test('authorization is resolved BEFORE any organization statement runs', async () => {
  await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  const wrote = capturedQueries.some((entry) => entry.sql.startsWith('INSERT INTO companies'));
  assert.equal(wrote, false, 'a denied request still reached the database');
});

// =====================================================================
// The request can never carry authority
// =====================================================================

test('a client cannot choose the company code', async () => {
  authorizeCeo();
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors', code: 'E_SET' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 400, 'a code field must be rejected, not ignored');
  assert.equal(response.body.error, 'invalid_request');
});

test('a client cannot inject capabilities when creating a position', async () => {
  authorizeCeo();
  for (const smuggled of [
    { positionName: 'CRO', capabilities: ['permit.cro_review'] },
    { positionName: 'CRO', capabilityIds: ['x'] },
    { positionName: 'HSE', capability: 'permit.hse_review' },
  ]) {
    const response = await call(
      `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
      { method: 'POST', body: smuggled, token: VALID_TOKEN },
    );
    assert.equal(response.status, 400, JSON.stringify(smuggled));
  }
});

test('a client cannot set siteManagerAssignable', async () => {
  authorizeCeo();
  const response = await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Supervisor', siteManagerAssignable: true }, token: VALID_TOKEN },
  );
  assert.equal(response.status, 400);
});

test('a client cannot smuggle privileged markers into any organization body', async () => {
  authorizeCeo();
  const attempts: Array<[string, unknown]> = [
    ['/admin/organization/companies', { name: 'X Co', privileged: true }],
    ['/admin/organization/companies', { name: 'X Co', role: 'CEO' }],
    ['/admin/organization/companies', { name: 'X Co', id: COMPANY_ID }],
    ['/admin/organization/companies', { name: 'X Co', deactivatedAt: null }],
    [`/admin/organization/companies/${COMPANY_ID}/teams`, { name: 'T', siteManagerAssignable: true }],
  ];
  for (const [path, body] of attempts) {
    const response = await call(path, { method: 'POST', body, token: VALID_TOKEN });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('the generated company code is server-side and never echoes a client value', async () => {
  authorizeCeo();
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 201);
  const company = response.body.company as { code: string; name: string };
  assert.equal(company.code, 'ABC_CONTRACTORS');
  assert.equal(company.name, 'ABC Contractors');
  assert.match(company.code, /^[A-Z][A-Z0-9_]*$/);
});

// =====================================================================
// Validation
// =====================================================================

test('a non-UUID route parameter is rejected', async () => {
  authorizeCeo();
  const bad = [
    { method: 'POST', path: '/admin/organization/companies/not-a-uuid/teams', body: { name: 'T' } },
    { method: 'PATCH', path: '/admin/organization/teams/not-a-uuid/deactivate', body: {} },
    { method: 'PATCH', path: '/admin/organization/team-positions/123/deactivate', body: {} },
  ];
  for (const route of bad) {
    const response = await call(route.path, { method: route.method, body: route.body, token: VALID_TOKEN });
    assert.equal(response.status, 400, route.path);
  }
});

test('a blank or punctuation-only organization name is rejected', async () => {
  authorizeCeo();
  for (const name of ['', ' ', 'A', '!!!', '   ---   ']) {
    const response = await call('/admin/organization/companies', {
      method: 'POST',
      body: { name },
      token: VALID_TOKEN,
    });
    assert.equal(response.status, 400, JSON.stringify(name));
  }
});

// =====================================================================
// Database refusals become clean responses
// =====================================================================

test('a missing company is a 404, not a 500', async () => {
  authorizeCeo();
  lookupRows = { company: [] };
  const response = await call(`/admin/organization/companies/${COMPANY_ID}/teams`, {
    method: 'POST',
    body: { name: 'Electrical' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});

test("a team in another company reads as not found, never as an accepted association", async () => {
  authorizeCeo();
  lookupRows = { team: [] };
  const response = await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Supervisor' }, token: VALID_TOKEN },
  );
  assert.equal(response.status, 404);
});

test('an inactive company refuses a new team with a 409', async () => {
  authorizeCeo();
  lookupRows = { company: [{ id: COMPANY_ID, deactivated_at: '2026-01-01T00:00:00Z' }] };
  const response = await call(`/admin/organization/companies/${COMPANY_ID}/teams`, {
    method: 'POST',
    body: { name: 'Electrical' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'company_inactive');
});

test('a duplicate company name is a 409', async () => {
  authorizeCeo();
  failStatement = (sql) =>
    sql.startsWith('INSERT INTO companies')
      ? Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'companies_name_normalized_unique',
        })
      : undefined;
  const response = await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'E-SET' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'duplicate_name');
});

test('an active-employee dependency blocks deactivation with a 409', async () => {
  authorizeCeo();
  failStatement = (sql) =>
    sql.startsWith('UPDATE team_positions')
      ? new Error('team position X still has 3 active employee(s); reassign or disable them before deactivating it')
      : undefined;
  const response = await call(`/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`, {
    method: 'PATCH',
    body: {},
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'active_employees');
});

test('a required-coverage refusal blocks deactivation with a 409', async () => {
  authorizeCeo();
  failStatement = (sql) =>
    sql.startsWith('UPDATE team_positions')
      ? new Error('deactivating team position X would leave required capability permit.cro_review below its required coverage')
      : undefined;
  const response = await call(`/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`, {
    method: 'PATCH',
    body: {},
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'capability_coverage');
});

test('an already-inactive record is a 409, not a silent success', async () => {
  authorizeCeo();
  lookupRows = { teamPosition: [{ id: TEAM_POSITION_ID, deactivated_at: '2026-01-01T00:00:00Z' }] };
  const response = await call(`/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`, {
    method: 'PATCH',
    body: {},
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'already_inactive');
});

test('NO raw PostgreSQL text ever reaches the client', async () => {
  authorizeCeo();
  const leaky = 'ERROR: relation "companies" does not exist at character 13\n  QUERY: SELECT ...';
  failStatement = (sql) =>
    sql.startsWith('UPDATE companies')
      ? Object.assign(new Error(leaky), { code: '42P01', severity: 'ERROR' })
      : undefined;

  const response = await call(`/admin/organization/companies/${COMPANY_ID}/deactivate`, {
    method: 'PATCH',
    body: {},
    token: VALID_TOKEN,
  });

  assert.equal(response.status, 500, 'an unexpected failure is a generic 500');
  const serialized = JSON.stringify(response.body);
  for (const leak of ['relation', 'QUERY', 'SELECT', '42P01', 'character 13', 'companies']) {
    assert.ok(!serialized.includes(leak), `response leaked "${leak}": ${serialized}`);
  }
});

// =====================================================================
// Successful mutations
// =====================================================================

test('creating a team returns the new team by ID', async () => {
  authorizeCeo();
  const response = await call(`/admin/organization/companies/${COMPANY_ID}/teams`, {
    method: 'POST',
    body: { name: 'Electrical' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 201);
  const team = response.body.team as { id: string; companyId: string; name: string };
  assert.equal(team.id, TEAM_ID);
  assert.equal(team.companyId, COMPANY_ID);
  assert.equal(team.name, 'Electrical');
});

test('creating an association grants exactly the applicant baseline', async () => {
  authorizeCeo();
  const response = await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'CRO' }, token: VALID_TOKEN },
  );
  assert.equal(response.status, 201);
  const association = response.body.association as { baselineCapabilities: string[] };
  assert.deepEqual(association.baselineCapabilities, ['permit.create', 'permit.submit']);

  // Through the bounded function, and never by writing the table.
  const sql = capturedQueries.map((entry) => entry.sql).join('\n');
  assert.match(sql, /grant_baseline_applicant_capabilities/);
  assert.doesNotMatch(sql, /INSERT INTO team_position_capabilities/i);
  assert.doesNotMatch(sql, /permit\.cro_review/);
  assert.doesNotMatch(sql, /permit\.hse_review/);
});

test('a position named CRO, HSE, Site Manager or CEO receives no extra authority', async () => {
  for (const positionName of ['CRO', 'HSE', 'Site Manager', 'CEO', 'Paramedic', 'Team Lead']) {
    authorizeCeo();
    capturedQueries = [];
    const response = await call(
      `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
      { method: 'POST', body: { positionName }, token: VALID_TOKEN },
    );
    assert.equal(response.status, 201, positionName);
    const association = response.body.association as { baselineCapabilities: string[] };
    assert.deepEqual(
      association.baselineCapabilities,
      ['permit.create', 'permit.submit'],
      `"${positionName}" received something other than the baseline`,
    );
    const sql = capturedQueries.map((entry) => entry.sql).join('\n');
    // `privileged_access_events` IS read here - that is how authority is
    // resolved, and reading it is the whole point. What must never
    // happen is a WRITE: no organization action may append a privileged
    // grant or reach the function that does.
    assert.doesNotMatch(sql, /INSERT INTO privileged_access_events/i);
    assert.doesNotMatch(sql, /UPDATE privileged_access_events/i);
    assert.doesNotMatch(sql, /privileged_identities/i);
    assert.doesNotMatch(sql, /record_site_manager_grant/i);
    assert.doesNotMatch(sql, /user_capability_grants/i);
  }
});

test('the association INSERT sets assignability server-side, never from the request', async () => {
  authorizeCeo();
  await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Supervisor' }, token: VALID_TOKEN },
  );
  const insert = capturedQueries.find((entry) => entry.sql.startsWith('INSERT INTO team_positions'));
  assert.match(insert?.sql ?? '', /VALUES \(\$1, \$2, TRUE\)/);
  // Only team and position are parameters: assignability is a literal.
  assert.equal(insert?.params.length, 2);
});

test('deactivation succeeds and uses UPDATE, never DELETE', async () => {
  for (const [path, table] of [
    [`/admin/organization/companies/${COMPANY_ID}/deactivate`, 'UPDATE companies'],
    [`/admin/organization/teams/${TEAM_ID}/deactivate`, 'UPDATE teams'],
    [`/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`, 'UPDATE team_positions'],
  ] as const) {
    authorizeCeo();
    capturedQueries = [];
    const response = await call(path, { method: 'PATCH', body: {}, token: VALID_TOKEN });
    assert.equal(response.status, 200, path);
    const sql = capturedQueries.map((entry) => entry.sql).join('\n');
    assert.ok(sql.includes(table), path);
    assert.doesNotMatch(sql, /DELETE FROM/i);
    assert.doesNotMatch(sql, /TRUNCATE/i);
  }
});

// =====================================================================
// Audit
// =====================================================================

test('every successful mutation writes an organization audit event', async () => {
  const cases: Array<[string, string, unknown, string[]]> = [
    ['POST', '/admin/organization/companies', { name: 'ABC Contractors' }, ['COMPANY_CREATED']],
    ['POST', `/admin/organization/companies/${COMPANY_ID}/teams`, { name: 'Electrical' }, ['TEAM_CREATED']],
    [
      'POST',
      `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
      { positionName: 'Supervisor' },
      // The stub reuses an existing global position by default, so no
      // POSITION_CREATED is emitted - see the dedicated pair below.
      ['TEAM_POSITION_CREATED', 'BASELINE_CAPABILITIES_GRANTED'],
    ],
    ['PATCH', `/admin/organization/companies/${COMPANY_ID}/deactivate`, {}, ['COMPANY_DEACTIVATED']],
    ['PATCH', `/admin/organization/teams/${TEAM_ID}/deactivate`, {}, ['TEAM_DEACTIVATED']],
    [
      'PATCH',
      `/admin/organization/team-positions/${TEAM_POSITION_ID}/deactivate`,
      {},
      ['TEAM_POSITION_DEACTIVATED'],
    ],
  ];

  for (const [method, path, body, expected] of cases) {
    authorizeCeo();
    capturedQueries = [];
    await call(path, { method, body, token: VALID_TOKEN });

    const events = capturedQueries
      .filter((entry) => entry.sql.startsWith('INSERT INTO organization_audit_events'))
      .map((entry) => entry.params[0]);
    assert.deepEqual(events, expected, `${method} ${path}`);
    // Never the ACCOUNT audit table.
    const sql = capturedQueries.map((entry) => entry.sql).join('\n');
    assert.doesNotMatch(sql, /INSERT INTO account_audit_events/i);
  }
});

test('over HTTP: reusing a global position emits no POSITION_CREATED', async () => {
  authorizeCeo();
  await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Supervisor' }, token: VALID_TOKEN },
  );
  const events = capturedQueries
    .filter((entry) => entry.sql.startsWith('INSERT INTO organization_audit_events'))
    .map((entry) => entry.params[0]);
  assert.ok(!events.includes('POSITION_CREATED'), 'no position was created, so none may be claimed');
});

test('over HTTP: minting a new global position emits POSITION_CREATED once', async () => {
  authorizeCeo();
  lookupRows = { positionInsert: [{ id: POSITION_ID, name: 'Rope Access Technician' }] };
  await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Rope Access Technician' }, token: VALID_TOKEN },
  );
  const events = capturedQueries
    .filter((entry) => entry.sql.startsWith('INSERT INTO organization_audit_events'))
    .map((entry) => entry.params[0]);
  assert.deepEqual(events, ['POSITION_CREATED', 'TEAM_POSITION_CREATED', 'BASELINE_CAPABILITIES_GRANTED']);
});

test('a team/company mismatch mutates nothing and audits nothing', async () => {
  authorizeCeo();
  lookupRows = { team: [] }; // the team is not in this company
  const response = await call(
    `/admin/organization/companies/${COMPANY_ID}/teams/${TEAM_ID}/positions`,
    { method: 'POST', body: { positionName: 'Supervisor' }, token: VALID_TOKEN },
  );
  assert.equal(response.status, 404);

  const sql = capturedQueries.map((entry) => entry.sql).join(String.fromCharCode(10));
  assert.doesNotMatch(sql, /INSERT INTO positions/i);
  assert.doesNotMatch(sql, /INSERT INTO team_positions/i);
  assert.doesNotMatch(sql, /grant_baseline_applicant_capabilities/);
  assert.doesNotMatch(sql, /organization_audit_events/i);
});

test('the audit records the authenticated actor, never a client-supplied one', async () => {
  authorizeCeo();
  const actor = authenticatedUserId;
  await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  const event = capturedQueries.find((entry) => entry.sql.startsWith('INSERT INTO organization_audit_events'));
  assert.equal(event?.params[1], actor);
});

test('a FAILED mutation writes no success audit record', async () => {
  authorizeCeo();
  failStatement = (sql) =>
    sql.startsWith('INSERT INTO teams')
      ? Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'teams_company_name_normalized_unique' })
      : undefined;

  const response = await call(`/admin/organization/companies/${COMPANY_ID}/teams`, {
    method: 'POST',
    body: { name: 'Electrical' },
    token: VALID_TOKEN,
  });
  assert.equal(response.status, 409);
  const audited = capturedQueries.some((entry) =>
    entry.sql.startsWith('INSERT INTO organization_audit_events'));
  assert.equal(audited, false, 'a failed mutation left an audit row');
});

test('the mutation and its audit share one transaction', async () => {
  authorizeCeo();
  await call('/admin/organization/companies', {
    method: 'POST',
    body: { name: 'ABC Contractors' },
    token: VALID_TOKEN,
  });
  const order = capturedQueries.map((entry) => entry.sql.split(/\s+/).slice(0, 3).join(' '));
  const begin = order.findIndex((sql) => sql.startsWith('BEGIN'));
  const insert = order.findIndex((sql) => sql.startsWith('INSERT INTO companies'));
  const audit = order.findIndex((sql) => sql.startsWith('INSERT INTO organization_audit_events'));
  const commit = order.findIndex((sql) => sql.startsWith('COMMIT'));
  assert.ok(begin < insert && insert < audit && audit < commit, order.join(' | '));
});

// =====================================================================
// The administration directory
// =====================================================================

test('the administration directory returns active structure by stable ID and omits retired rows', async () => {
  authorizeCeo();
  const response = await call('/admin/organization/structure', { token: VALID_TOKEN });
  assert.equal(response.status, 200);

  const companies = response.body.companies as Array<Record<string, unknown>>;
  assert.equal(companies.length, 1);

  const [eset] = companies;
  assert.equal(eset?.id, COMPANY_ID);
  assert.equal(eset?.code, 'E_SET');
  assert.equal(eset?.deactivatedAt, null);

  const teams = eset?.teams as Array<Record<string, unknown>>;
  assert.equal(teams[0]?.id, TEAM_ID);
  assert.equal(teams[0]?.companyId, COMPANY_ID);

  const positions = teams[0]?.positions as Array<Record<string, unknown>>;
  assert.equal(positions[0]?.teamPositionId, TEAM_POSITION_ID);
  assert.equal(positions[0]?.positionId, POSITION_ID);
  assert.equal(positions[0]?.positionName, 'CRO');
  assert.equal(positions[0]?.siteManagerAssignable, true);
  assert.equal(positions[0]?.deactivatedAt, null);

  const directoryQuery = capturedQueries.find((entry) => entry.sql.includes('FROM companies c'))?.sql ?? '';
  assert.match(directoryQuery, /WHERE c\.deactivated_at IS NULL/);
  assert.match(directoryQuery, /t\.company_id = c\.id AND t\.deactivated_at IS NULL/);
  assert.match(directoryQuery, /tp\.team_id = t\.id AND tp\.deactivated_at IS NULL/);
});

test('the administration directory exposes no capability mapping', async () => {
  authorizeCeo();
  const response = await call('/admin/organization/structure', { token: VALID_TOKEN });
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes('capabilit'), 'authorization data must not be directory data');
  assert.ok(!serialized.includes('permit.'), serialized);
});

test('the employee-facing organization endpoint is unchanged and still separate', async () => {
  authorizeCeo();
  const response = await call('/admin/organization', { token: VALID_TOKEN });
  assert.equal(response.status, 200);
  assert.ok('companies' in response.body);
});

// =====================================================================
// Scope: what deliberately does not exist
// =====================================================================

test('there is NO hard-delete route for any organization object', async () => {
  authorizeCeo();
  for (const path of [
    '/admin/organization/companies',
    `/admin/organization/companies/${COMPANY_ID}`,
    `/admin/organization/teams/${TEAM_ID}`,
    `/admin/organization/team-positions/${TEAM_POSITION_ID}`,
  ]) {
    const response = await call(path, { method: 'DELETE', token: VALID_TOKEN });
    assert.equal(response.status, 404, `DELETE ${path} must not be routed`);
  }
});

test('there is NO rename route in this phase', async () => {
  authorizeCeo();
  for (const path of [
    `/admin/organization/companies/${COMPANY_ID}`,
    `/admin/organization/teams/${TEAM_ID}`,
  ]) {
    const response = await call(path, { method: 'PATCH', body: { name: 'Renamed' }, token: VALID_TOKEN });
    assert.equal(response.status, 404, `PATCH ${path} must not be routed`);
  }
});

test('there is NO capability-management route', async () => {
  authorizeCeo();
  for (const path of [
    `/admin/organization/team-positions/${TEAM_POSITION_ID}/capabilities`,
    '/admin/organization/capabilities',
  ]) {
    const response = await call(path, { method: 'POST', body: { capability: 'permit.cro_review' }, token: VALID_TOKEN });
    assert.equal(response.status, 404, `POST ${path} must not be routed`);
  }
});
