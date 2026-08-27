import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * Wiring tests for the permit-template / form-content / record-view API
 * surface added alongside migration 0016. Deliberately a SEPARATE file
 * from `permits.test.ts`: the mutation rate limiter is a per-process
 * in-memory budget keyed by the authenticated actor, and that file
 * already spends most of it, so mutation-route wiring proved here would
 * otherwise be measuring the limiter rather than the routes.
 *
 * Only the two real external boundaries are stubbed - Supabase token
 * verification and the Postgres connection. `requireAuth`,
 * `requireCapability`, the Zod body/query schemas, and the route
 * definitions all run for real.
 */

const VALID_TOKEN = 'form-route-test-token';
const AUTHENTICATED_USER_ID = 'form-route-test-user';
const SOME_PERMIT_ID = '00000000-0000-0000-0000-000000000000';

let grantedCapabilities: string[] = [];
let mockOwnPermitRows: Record<string, unknown>[] = [];
let mockSearchPermitRows: Record<string, unknown>[] = [];
let mockPermitDetailRow: Record<string, unknown> | null = null;
let mockHistoryEventRows: Record<string, unknown>[] = [];
let mockSignatureRows: Record<string, unknown>[] = [];
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

function makePermitDetailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SOME_PERMIT_ID,
    permit_sequence: '1',
    jsa_id: '11111111-1111-1111-1111-111111111111',
    status: 'DRAFT',
    version: 1,
    created_by: AUTHENTICATED_USER_ID,
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: null,
    hse_review_started_at: null,
    hse_review_deadline_at: null,
    issued_at: null,
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    permit_type: 'WTG_WORK',
    form_version: 'WTG_WORK_V1',
    form_payload: { windFarm: 'Jhimpir' },
    wind_farm: 'Jhimpir',
    wtg_number: 'WTG-07',
    work_description: 'Replace yaw motor',
    loto_number: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;
const originalPoolConnect = Pool.prototype.connect;

before(() => {
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) return { data: null, error: new Error('invalid token') };
    return { data: { claims: { sub: AUTHENTICATED_USER_ID, email: null } }, error: null };
  }) as typeof supabase.auth.getClaims;

  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).trim();
    capturedQueries.push({ sql, params });
    if (sql.includes('FROM app_user_access')) return { rows: [{ state: 'ACTIVE', must_change_password: false }] };
    if (sql.startsWith('SELECT DISTINCT c.name')) return { rows: grantedCapabilities.map((name) => ({ name })) };
    // Mirrors the real query, which now excludes drafts: /permits/mine is
    // the formal record list and My Drafts is the only home for a draft.
    if (!sql.startsWith('SELECT COUNT') && sql.includes("FROM permits WHERE created_by = $1 AND status <>")) {
      return { rows: mockOwnPermitRows.filter((permit) => permit.status !== 'DRAFT') };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE created_by')) {
      return { rows: [{ count: String(mockOwnPermitRows.filter((permit) => permit.status !== 'DRAFT').length) }] };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE id = $1')) {
      return { rows: mockPermitDetailRow && mockPermitDetailRow.id === params[0] ? [mockPermitDetailRow] : [] };
    }
    if (sql.startsWith('SELECT * FROM jsas WHERE id = $1')) {
      return {
        rows: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            jsa_sequence: '1',
            created_by: AUTHENTICATED_USER_ID,
            form_version: 'JSA_V1',
            form_payload: { page1: {}, page2: {} },
            site_or_wtg: 'WTG-07',
            job_description: 'Yaw motor replacement',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
    }
    if (sql.startsWith('SELECT * FROM permit_lifecycle_events WHERE permit_id = $1')) {
      return { rows: mockHistoryEventRows };
    }
    if (sql.includes('FROM permit_signatures s')) return { rows: mockSignatureRows };
    // Permit Records excludes drafts unconditionally in the real query, so
    // the stub must not hand back rows the database would never return.
    if (!sql.startsWith('SELECT COUNT') && sql.includes('FROM permits p JOIN jsas j')) {
      return { rows: mockSearchPermitRows.filter((permit) => permit.status !== 'DRAFT') };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits p JOIN jsas j')) {
      return { rows: [{ count: String(mockSearchPermitRows.filter((permit) => permit.status !== 'DRAFT').length) }] };
    }
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;

  // Every query on the transactional client returns no rows, so a
  // mutation that reaches the service resolves through its own real
  // not-found path instead of touching a database.
  Pool.prototype.connect = (async () =>
    ({ query: async () => ({ rows: [] }), release: () => {} }) as unknown as PoolClient) as typeof Pool.prototype.connect;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
  Pool.prototype.connect = originalPoolConnect;
});

beforeEach(() => {
  grantedCapabilities = [];
  mockOwnPermitRows = [];
  mockSearchPermitRows = [];
  mockPermitDetailRow = null;
  mockHistoryEventRows = [];
  mockSignatureRows = [];
  capturedQueries = [];
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

function getRequest(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'GET', headers });
}

function sendJson(url: string, method: 'POST' | 'PATCH', path: string, token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method, headers, body: JSON.stringify(body) });
}

test('POST /permits requires one of the four confirmed permit templates', async () => {
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    // No template at all: a permit can never be created without knowing
    // which form it is.
    assert.equal((await sendJson(url, 'POST', '/permits', VALID_TOKEN, {})).status, 400);
    // An invented template.
    assert.equal((await sendJson(url, 'POST', '/permits', VALID_TOKEN, { permitType: 'ELECTRICAL_WORK' })).status, 400);
    // A client-chosen form version, or a smuggled signer identity.
    assert.equal(
      (await sendJson(url, 'POST', '/permits', VALID_TOKEN, { permitType: 'WTG_WORK', formVersion: 'WTG_WORK_V9' })).status,
      400,
    );
    assert.equal(
      (await sendJson(url, 'POST', '/permits', VALID_TOKEN, { permitType: 'WTG_WORK', applicantName: 'Impostor' })).status,
      400,
    );
  } finally {
    await close();
  }
});

test('POST /permits still requires the permit.create capability, template or not', async () => {
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    assert.equal((await sendJson(url, 'POST', '/permits', VALID_TOKEN, { permitType: 'WTG_WORK' })).status, 403);
    assert.equal((await sendJson(url, 'POST', '/permits', undefined, { permitType: 'WTG_WORK' })).status, 401);
  } finally {
    await close();
  }
});

test('PATCH /permits/:id carries form content and rejects a smuggled signer identity', async () => {
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    const withForm = await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN, {
      version: 1,
      form: { windFarm: 'Jhimpir' },
    });
    assert.notEqual(withForm.status, 400, 'a form payload is an accepted part of the edit body');

    for (const body of [
      { version: 1, applicantSignature: 'Impostor' },
      { version: 1, permitType: 'HOT_WORK' },
      { version: 1, wind_farm: 'Jhimpir' },
    ]) {
      assert.equal(
        (await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN, body)).status,
        400,
        `expected ${JSON.stringify(body)} to be rejected`,
      );
    }
  } finally {
    await close();
  }
});

test('PATCH /permits/:id/jsa is authenticated, capability-gated, and body-validated', async () => {
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    assert.equal(
      (await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}/jsa`, undefined, { version: 1, form: {} })).status,
      401,
    );
    assert.equal(
      (await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}/jsa`, VALID_TOKEN, { version: 1, form: {} })).status,
      403,
    );

    grantedCapabilities = ['permit.create'];
    assert.equal((await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}/jsa`, VALID_TOKEN, { version: 1 })).status, 400);
    assert.equal(
      (await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}/jsa`, VALID_TOKEN, { version: 1, form: {}, completedBy: 'Impostor' }))
        .status,
      400,
    );
    // A well-formed request reaches the service, which - against the
    // empty transactional stub - reports not-found, proving the body was
    // accepted and that object access is still scoped, not assumed.
    assert.equal(
      (await sendJson(url, 'PATCH', `/permits/${SOME_PERMIT_ID}/jsa`, VALID_TOKEN, { version: 1, form: {} })).status,
      404,
    );
  } finally {
    await close();
  }
});

test('opening a record returns Permit, JSA, and History together, plus the frozen signatures', async () => {
  mockPermitDetailRow = makePermitDetailRow();
  mockHistoryEventRows = [
    {
      id: 'event-1',
      ordinal: '1',
      permit_id: SOME_PERMIT_ID,
      event_type: 'CREATED',
      actor_user_id: AUTHENTICATED_USER_ID,
      from_status: null,
      to_status: 'DRAFT',
      reason: null,
      occurred_at: '2026-01-01T00:00:00.000Z',
    },
  ];
  mockSignatureRows = [
    {
      id: 'signature-1',
      permit_id: SOME_PERMIT_ID,
      source_event_id: 'event-1',
      signature_role: 'APPLICANT',
      signer_user_id: AUTHENTICATED_USER_ID,
      signer_display_name: 'Ayesha Khan',
      signer_team_position_id: 'tp-1',
      signer_team_name: 'Maintenance Team A',
      signer_position_name: 'Technician',
      signed_at: '2026-01-01T08:00:00.000Z',
      created_at: '2026-01-01T08:00:00.000Z',
    },
  ];

  const { url, close } = await startServer();
  try {
    const response = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      permit: { permit_type: string; form_payload: unknown };
      jsa: { form_version: string };
      history: unknown[];
      signatures: Array<{ signature_role: string; signer_display_name: string }>;
      document: unknown;
      validity: unknown;
      availableActions: unknown[];
    };
    assert.equal(body.permit.permit_type, 'WTG_WORK');
    assert.deepEqual(body.permit.form_payload, { windFarm: 'Jhimpir' });
    assert.equal(body.jsa.form_version, 'JSA_V1');
    assert.equal(body.history.length, 1);
    assert.equal(body.signatures[0]?.signer_display_name, 'Ayesha Khan');
    assert.ok(Array.isArray(body.availableActions));
    // A permit that was never issued has no document at all.
    assert.equal(body.document, null);
  } finally {
    await close();
  }
});

test('permit detail reads child data only AFTER the permit itself is authorized', async () => {
  grantedCapabilities = [];
  mockPermitDetailRow = makePermitDetailRow({ created_by: 'someone-else', status: 'PENDING_CRO' });
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN)).status, 404);
    for (const forbidden of ['FROM permit_signatures', 'FROM permit_lifecycle_events', 'FROM jsas']) {
      assert.ok(
        !capturedQueries.some((q) => q.sql.includes(forbidden)),
        `an unauthorized caller must not cause ${forbidden} to be read`,
      );
    }
  } finally {
    await close();
  }
});

test('list responses stay concise: no form payload is ever returned by /permits/mine', async () => {
  mockOwnPermitRows = [
    {
      id: SOME_PERMIT_ID,
      permit_sequence: '1',
      status: 'PENDING_CRO',
      created_by: AUTHENTICATED_USER_ID,
      permit_type: 'WTG_WORK',
      form_version: 'WTG_WORK_V1',
      wtg_number: 'WTG-07',
    },
  ];
  const { url, close } = await startServer();
  try {
    const response = await getRequest(url, '/permits/mine', VALID_TOKEN);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { permits: Array<Record<string, unknown>> };
    assert.equal(body.permits[0]?.permit_type, 'WTG_WORK');
    assert.equal(body.permits[0]?.wtg_number, 'WTG-07');
    assert.ok(!('form_payload' in (body.permits[0] ?? {})), 'a list row must never carry a form payload');

    const listQuery = capturedQueries.find(
      (q) => !q.sql.startsWith('SELECT COUNT') && q.sql.includes('FROM permits WHERE created_by'),
    );
    assert.ok(listQuery && !listQuery.sql.includes('form_payload'));
  } finally {
    await close();
  }
});

test('GET /permits/search filters by permit type against the real relational column', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/search?permitType=HOT_WORK', VALID_TOKEN)).status, 200);
    const searchQuery = capturedQueries.find(
      (q) => !q.sql.startsWith('SELECT COUNT') && q.sql.includes('FROM permits p JOIN jsas j'),
    );
    assert.ok(searchQuery?.sql.includes('p.permit_type ='));
    assert.ok(!searchQuery?.sql.includes('form_payload'), 'search results are summaries only');
    // The access predicate still comes first and is still the caller's own id.
    assert.equal(searchQuery?.params[0], AUTHENTICATED_USER_ID);
  } finally {
    await close();
  }
});

test('GET /permits/search rejects an invented permit type rather than ignoring it', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/search?permitType=ELECTRICAL_WORK', VALID_TOKEN)).status, 400);
    assert.ok(
      !capturedQueries.some((q) => q.sql.includes('FROM permits p JOIN jsas j')),
      'a rejected filter must never reach the database',
    );
  } finally {
    await close();
  }
});
