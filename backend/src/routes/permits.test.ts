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
// Controllable canned results for the new read queries, keyed by which
// query issues them (see the `Pool.prototype.query` stub below) - reset
// per test in `beforeEach`.
let mockOwnPermitRows: Record<string, unknown>[] = [];
let mockQueuePermitRows: Record<string, unknown>[] = [];
let mockPermitDetailRow: Record<string, unknown> | null = null;
let mockHistoryEventRows: Record<string, unknown>[] = [];
// Every query issued through the `Pool.prototype.query` stub, in order -
// lets a test assert *what was actually asked for* (e.g. which user id a
// query was scoped by), not just the canned response.
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

function makePermitDetailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SOME_PERMIT_ID,
    permit_sequence: '1',
    jsa_id: '11111111-1111-1111-1111-111111111111',
    status: 'PENDING_CRO',
    version: 1,
    created_by: 'someone-else',
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: '2026-01-01T00:00:00.000Z',
    hse_review_started_at: null,
    hse_review_deadline_at: null,
    issued_at: null,
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    jsa_row_id: '11111111-1111-1111-1111-111111111111',
    jsa_sequence: '1',
    jsa_created_by: 'someone-else',
    jsa_created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

  // Stub the bare `Pool.query()` calls the read endpoints/capability
  // resolution make. Dispatches on the query text (mirroring the exact
  // SQL each service function issues) to whichever canned result the
  // current test set up - never a real database.
  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).trim();
    capturedQueries.push({ sql, params });
    if (sql.startsWith('SELECT DISTINCT c.name')) {
      return { rows: grantedCapabilities.map((name) => ({ name })) };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE created_by')) {
      return { rows: mockOwnPermitRows };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE status')) {
      return { rows: mockQueuePermitRows };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE id = $1')) {
      // getPermitById - permit only, no JSA join. Authorization
      // (canViewPermit) runs against exactly this row, before anything
      // else is fetched.
      if (mockPermitDetailRow && mockPermitDetailRow.id === (params as unknown[])[0]) {
        const permitOnly = { ...mockPermitDetailRow };
        delete permitOnly.jsa_row_id;
        delete permitOnly.jsa_sequence;
        delete permitOnly.jsa_created_by;
        delete permitOnly.jsa_created_at;
        return { rows: [permitOnly] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM jsas WHERE id = $1')) {
      // getJsaById - must only ever be reached AFTER canViewPermit has
      // authorized the caller against the permit fetched above; several
      // tests below assert this query never appears in `capturedQueries`
      // for an unauthorized request.
      if (mockPermitDetailRow && mockPermitDetailRow.jsa_id === (params as unknown[])[0]) {
        return {
          rows: [
            {
              id: mockPermitDetailRow.jsa_row_id,
              jsa_sequence: mockPermitDetailRow.jsa_sequence,
              created_by: mockPermitDetailRow.jsa_created_by,
              created_at: mockPermitDetailRow.jsa_created_at,
            },
          ],
        };
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM permit_lifecycle_events')) {
      return { rows: mockHistoryEventRows };
    }
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;

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
  mockOwnPermitRows = [];
  mockQueuePermitRows = [];
  mockPermitDetailRow = null;
  mockHistoryEventRows = [];
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

function closeRequest(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1/permits/${SOME_PERMIT_ID}/close`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 1 }),
  });
}

function getRequest(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'GET', headers });
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

// --- GET /permits/mine ---

test('GET /permits/mine denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/mine')).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/mine is ownership-based, not permit.create-gated: an authenticated actor with NO capabilities can still list their own permits (200)', async () => {
  grantedCapabilities = []; // deliberately empty - no permit.create, no capabilities at all
  mockOwnPermitRows = [makePermitDetailRow({ created_by: AUTHENTICATED_USER_ID })];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/mine', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permits: unknown[] };
    assert.equal(body.permits.length, 1);
  } finally {
    await close();
  }
});

test('GET /permits/mine returns the caller\'s own permits for an authenticated actor with permit.create too (capability is not required, but holding it doesn\'t break access)', async () => {
  grantedCapabilities = ['permit.create'];
  mockOwnPermitRows = [makePermitDetailRow({ created_by: AUTHENTICATED_USER_ID })];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/mine', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permits: unknown[] };
    assert.equal(body.permits.length, 1);
  } finally {
    await close();
  }
});

test('GET /permits/mine never queries by anything other than the authenticated caller\'s own id (no cross-user access, no client-suppliable identity)', async () => {
  grantedCapabilities = [];
  mockOwnPermitRows = [];
  const { url, close } = await startServer();
  try {
    await getRequest(url, '/permits/mine', VALID_TOKEN);
    const ownPermitsQuery = capturedQueries.find((q) => q.sql.startsWith('SELECT * FROM permits WHERE created_by'));
    assert.ok(ownPermitsQuery, 'expected the own-permits query to have run');
    // The request has no path/query/body field for an identity at all -
    // this is the authenticated actor's own id (from the verified
    // token), never anything a client could supply.
    assert.deepEqual(ownPermitsQuery?.params, [AUTHENTICATED_USER_ID]);
  } finally {
    await close();
  }
});

// --- GET /permits/queue ---

test('GET /permits/queue denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO')).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/queue rejects an unsupported status value (400)', async () => {
  grantedCapabilities = ['permit.forward_hse'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=DRAFT', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/queue?status=CLOSED', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/queue', VALID_TOKEN)).status, 400);
  } finally {
    await close();
  }
});

test('GET /permits/queue denies an authenticated actor lacking the status-appropriate capability (403)', async () => {
  grantedCapabilities = ['permit.create']; // holds *some* capability, just not the right one
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO', VALID_TOKEN)).status, 403);
  } finally {
    await close();
  }
});

test('GET /permits/queue allows PENDING_HSE access via *either* hse_review or fallback_approve', async () => {
  mockQueuePermitRows = [makePermitDetailRow({ status: 'PENDING_HSE' })];

  grantedCapabilities = ['permit.hse_review'];
  const first = await startServer();
  try {
    assert.equal((await getRequest(first.url, '/permits/queue?status=PENDING_HSE', VALID_TOKEN)).status, 200);
  } finally {
    await first.close();
  }

  grantedCapabilities = ['permit.fallback_approve'];
  const second = await startServer();
  try {
    assert.equal((await getRequest(second.url, '/permits/queue?status=PENDING_HSE', VALID_TOKEN)).status, 200);
  } finally {
    await second.close();
  }
});

test('GET /permits/queue?status=PENDING_CRO: permit.cro_review alone grants access', async () => {
  mockQueuePermitRows = [makePermitDetailRow({ status: 'PENDING_CRO' })];
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO', VALID_TOKEN)).status, 200);
  } finally {
    await close();
  }
});

test('GET /permits/queue?status=PENDING_CRO: permit.forward_hse alone also grants access (the transition actor)', async () => {
  mockQueuePermitRows = [makePermitDetailRow({ status: 'PENDING_CRO' })];
  grantedCapabilities = ['permit.forward_hse'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO', VALID_TOKEN)).status, 200);
  } finally {
    await close();
  }
});

test('GET /permits/queue?status=PENDING_CRO: an unrelated permit capability does not grant access', async () => {
  grantedCapabilities = ['permit.close']; // holds a real capability, just not one for this status
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO', VALID_TOKEN)).status, 403);
  } finally {
    await close();
  }
});

// --- GET /permits/:id (detail + JSA + availableActions) ---

test('GET /permits/:id denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}`)).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/:id returns 404 for a nonexistent permit', async () => {
  grantedCapabilities = ['permit.create'];
  mockPermitDetailRow = null;
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN)).status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id returns 404 (not 403) for a permit that exists but the caller may not view (IDOR-safe)', async () => {
  // Exists, PENDING_HSE, owned by someone else - caller holds an
  // unrelated capability (forward_hse doesn't grant PENDING_HSE access).
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_HSE', created_by: 'someone-else' });
  grantedCapabilities = ['permit.forward_hse'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id returns detail+JSA+availableActions for the owner, even without any capability', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'DRAFT', created_by: AUTHENTICATED_USER_ID });
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permit: { id: string }; jsa: { id: string }; availableActions: string[] };
    assert.equal(body.permit.id, SOME_PERMIT_ID);
    assert.ok(body.jsa.id);
    assert.deepEqual(body.availableActions, []); // no capabilities granted
  } finally {
    await close();
  }
});

test('GET /permits/:id: an ISSUED permit reports isValid=true before its expiry', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'ISSUED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: new Date(Date.now() - 60_000).toISOString(), // issued a minute ago, well before midnight
    site_timezone: 'UTC',
  });
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { validity: { isValid: boolean } | null };
    assert.equal(body.validity?.isValid, true);
  } finally {
    await close();
  }
});

test('GET /permits/:id: a CLOSED permit always reports isValid=false, even strictly before what would otherwise be its expiry (regression guard)', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'CLOSED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: new Date(Date.now() - 60_000).toISOString(), // same recent issuance - would still be "valid" by time alone
    site_timezone: 'UTC',
    closed_by: AUTHENTICATED_USER_ID,
    closed_at: new Date().toISOString(),
  });
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { validity: { isValid: boolean } | null };
    assert.equal(body.validity?.isValid, false);
  } finally {
    await close();
  }
});

test('GET /permits/:id returns detail for a non-owner CRO holding the status-appropriate capability', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CRO', created_by: 'someone-else' });
  grantedCapabilities = ['permit.forward_hse'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[] };
    assert.deepEqual(body.availableActions, ['forward_hse']);
  } finally {
    await close();
  }
});

test('GET /permits/:id: permit.cro_review alone lets a non-owner view a PENDING_CRO permit, but grants no forwarding action', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CRO', created_by: 'someone-else' });
  grantedCapabilities = ['permit.cro_review']; // no permit.forward_hse
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[] };
    // Viewing must never itself grant forwarding authority - mutation
    // authorization (permit.forward_hse) is independent of read access.
    assert.deepEqual(body.availableActions, []);
  } finally {
    await close();
  }
});

test('GET /permits/:id: an unrelated capability does not let a non-owner view a PENDING_CRO permit (404, IDOR-safe)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CRO', created_by: 'someone-else' });
  grantedCapabilities = ['permit.close']; // a real capability, just not one that applies to PENDING_CRO
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN)).status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id: an unauthorized request (exists, but caller may not view it) never queries the JSA - authorization runs before any child-table read', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_HSE', created_by: 'someone-else' });
  grantedCapabilities = ['permit.forward_hse']; // real capability, wrong status - denied
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 404);
    assert.equal(
      capturedQueries.some((q) => q.sql.startsWith('SELECT * FROM jsas')),
      false,
      'the JSA must never be queried for a caller canViewPermit denies',
    );
    // The permit itself, by contrast, must have been fetched - that's
    // what authorization was actually checked against.
    assert.ok(capturedQueries.some((q) => q.sql.startsWith('SELECT * FROM permits WHERE id = $1')));
  } finally {
    await close();
  }
});

test('GET /permits/:id: an authorized request DOES query the JSA (only after authorization succeeds)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'DRAFT', created_by: AUTHENTICATED_USER_ID });
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const permitQueryIndex = capturedQueries.findIndex((q) => q.sql.startsWith('SELECT * FROM permits WHERE id = $1'));
    const jsaQueryIndex = capturedQueries.findIndex((q) => q.sql.startsWith('SELECT * FROM jsas'));
    assert.notEqual(permitQueryIndex, -1);
    assert.notEqual(jsaQueryIndex, -1);
    assert.ok(jsaQueryIndex > permitQueryIndex, 'the JSA must be fetched strictly after the permit');
  } finally {
    await close();
  }
});

// --- GET /permits/:id/history ---

test('GET /permits/:id/history denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`)).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/:id/history returns 404 (not 403) when the caller may not view the permit (IDOR-safe)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: 'someone-else' });
  grantedCapabilities = []; // no permit.close, no ownership
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`, VALID_TOKEN)).status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id/history returns events for an authorized caller', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'CREATED', actor_user_id: AUTHENTICATED_USER_ID, from_status: null, to_status: 'DRAFT', reason: null, occurred_at: '2026-01-01T00:00:00.000Z' },
  ];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: unknown[] };
    assert.equal(body.events.length, 1);
  } finally {
    await close();
  }
});

test('GET /permits/:id/history: permit.cro_review alone lets a non-owner view a PENDING_CRO permit\'s history', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CRO', created_by: 'someone-else' });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'SUBMITTED', actor_user_id: 'someone-else', from_status: 'DRAFT', to_status: 'PENDING_CRO', reason: null, occurred_at: '2026-01-01T00:00:00.000Z' },
  ];
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: unknown[] };
    assert.equal(body.events.length, 1);
  } finally {
    await close();
  }
});

test('GET /permits/:id/history: an unauthorized request (exists, but caller may not view it) never queries the JSA - authorization runs before any child-table read', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: 'someone-else' });
  grantedCapabilities = []; // no permit.close, no ownership - denied
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`, VALID_TOKEN);
    assert.equal(res.status, 404);
    assert.equal(
      capturedQueries.some((q) => q.sql.startsWith('SELECT * FROM jsas')),
      false,
      'the JSA must never be queried for a caller canViewPermit denies',
    );
    assert.ok(capturedQueries.some((q) => q.sql.startsWith('SELECT * FROM permits WHERE id = $1')));
  } finally {
    await close();
  }
});

test('GET /permits/:id/history: never queries the JSA at all, even for an authorized caller (the endpoint has no use for it)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'CREATED', actor_user_id: AUTHENTICATED_USER_ID, from_status: null, to_status: 'DRAFT', reason: null, occurred_at: '2026-01-01T00:00:00.000Z' },
  ];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/history`, VALID_TOKEN);
    assert.equal(res.status, 200);
    assert.equal(
      capturedQueries.some((q) => q.sql.startsWith('SELECT * FROM jsas')),
      false,
      'history never needs the JSA, authorized or not',
    );
  } finally {
    await close();
  }
});
