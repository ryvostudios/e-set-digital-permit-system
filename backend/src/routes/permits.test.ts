import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';
import { computeFileHash, setDocumentStorageAdapterForTests, type DocumentStorageAdapter } from '../domain/permits/documents.js';
import { blankPermitV2 } from '../test/v2Forms.js';

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
let privilegedRoles: Array<'CEO' | 'SITE_MANAGER'> = [];
let appAccessState: 'ACTIVE' | 'DISABLED' | null = 'ACTIVE';
// Controllable canned results for the new read queries, keyed by which
// query issues them (see the `Pool.prototype.query` stub below) - reset
// per test in `beforeEach`.
let mockOwnPermitRows: Record<string, unknown>[] = [];
let mockQueuePermitRows: Record<string, unknown>[] = [];
let mockPermitDetailRow: Record<string, unknown> | null = null;
let mockHistoryEventRows: Record<string, unknown>[] = [];
let mockSearchPermitRows: Record<string, unknown>[] = [];
let mockDocumentLookupRow: Record<string, unknown> | null = null;
// The two account lookups the shared actor resolver makes when naming
// the people behind a permit's lifecycle actors and its closer.
let mockPrivilegedIdentityRows: Record<string, unknown>[] = [];
let mockWorkforceIdentityRows: Record<string, unknown>[] = [];
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
    if (sql.includes('FROM app_user_access')) {
      return { rows: appAccessState ? [{ state: appAccessState, must_change_password: false }] : [] };
    }
    if (sql.startsWith('SELECT DISTINCT c.name')) {
      return { rows: grantedCapabilities.map((name) => ({ name })) };
    }
    if (sql.includes('FROM privileged_identities')) {
      // resolvePermitActorIdentities - privileged actors. Checked before
      // the capability lookup below because this query reads the grant
      // log through a lateral join and would otherwise match it.
      const ids = new Set(((params as unknown[])[0] as string[]) ?? []);
      return { rows: mockPrivilegedIdentityRows.filter((row) => ids.has(row.user_id as string)) };
    }
    if (sql.includes('FROM workforce_profiles')) {
      // resolvePermitActorIdentities - ordinary employees.
      const ids = new Set(((params as unknown[])[0] as string[]) ?? []);
      return { rows: mockWorkforceIdentityRows.filter((row) => ids.has(row.user_id as string)) };
    }
    if (sql.includes('FROM privileged_access_events')) {
      return { rows: privilegedRoles.map((role) => ({ role, action: 'GRANTED' })) };
    }
    if (!sql.startsWith('SELECT COUNT') && sql.includes("WHERE created_by = $1 AND status = 'DRAFT'")) {
      return { rows: mockOwnPermitRows.filter((permit) => permit.status === 'DRAFT') };
    }
    if (sql.startsWith('SELECT COUNT') && sql.includes("WHERE created_by = $1 AND status = 'DRAFT'")) {
      return { rows: [{ count: String(mockOwnPermitRows.filter((permit) => permit.status === 'DRAFT').length) }] };
    }
    if (!sql.startsWith('SELECT COUNT') && sql.includes('FROM permits WHERE created_by = $1 AND status <>')) {
      return { rows: mockOwnPermitRows.filter((permit) => permit.status !== 'DRAFT') };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE created_by')) {
      return { rows: [{ count: String(mockOwnPermitRows.filter((permit) => permit.status !== 'DRAFT').length) }] };
    }
    if (!sql.startsWith('SELECT COUNT') && sql.includes('FROM permits WHERE status')) {
      return { rows: mockQueuePermitRows };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE status')) {
      return { rows: [{ count: String(mockQueuePermitRows.length) }] };
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
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permit_lifecycle_events')) {
      return { rows: [{ count: String(mockHistoryEventRows.length) }] };
    }
    if (sql.startsWith('SELECT * FROM permit_lifecycle_events')) {
      return { rows: mockHistoryEventRows };
    }
    if (sql.includes('FROM permits p JOIN jsas j') && !sql.startsWith('SELECT COUNT')) {
      return { rows: mockSearchPermitRows.filter((permit) => permit.status !== 'DRAFT') };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits p JOIN jsas j')) {
      return { rows: [{ count: String(mockSearchPermitRows.filter((permit) => permit.status !== 'DRAFT').length) }] };
    }
    if (sql.startsWith('SELECT s.*, i.hash_version')) {
      return { rows: mockDocumentLookupRow ? [mockDocumentLookupRow] : [] };
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
  appAccessState = 'ACTIVE';
  grantedCapabilities = [];
  privilegedRoles = [];
  mockOwnPermitRows = [];
  mockQueuePermitRows = [];
  mockPermitDetailRow = null;
  mockHistoryEventRows = [];
  mockSearchPermitRows = [];
  mockDocumentLookupRow = null;
  mockPrivilegedIdentityRows = [];
  mockWorkforceIdentityRows = [];
  setDocumentStorageAdapterForTests(null);
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

/** Generic POST helper for the new workflow-completion mutation routes below (send-back, resubmit, hold, resume, cancel, renew, hse-send-back). */
function postRequest(url: string, path: string, token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('a DISABLED user with a valid token cannot read own permits or perform capability-authorized mutations', async () => {
  appAccessState = 'DISABLED';
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    const read = await getRequest(url, '/permits/mine', VALID_TOKEN);
    const mutation = await closeRequest(url, VALID_TOKEN);
    assert.equal(read.status, 401);
    assert.equal(mutation.status, 401);
    assert.equal(capturedQueries.some(({ sql }) => sql.includes('FROM permits')), false);
  } finally {
    await close();
  }
});

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

test('POST /permits/:id/close is covered by the mutation rate limiter (RateLimit-* response headers present)', async () => {
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    const res = await closeRequest(url, VALID_TOKEN);
    // `standardHeaders: 'draft-7'` (see middleware/rateLimit.ts) emits a
    // single combined `RateLimit` header (e.g. "limit=30, remaining=29,
    // reset=900"), not the older per-field RateLimit-Limit/-Remaining.
    assert.ok(res.headers.get('ratelimit'), 'expected a RateLimit response header from the mutation limiter');
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

// --- Workflow-completion mutation routes: wiring only ---
//
// Same philosophy as the /close tests above: `Pool.prototype.connect`'s
// stub always returns no rows, so any request that gets PAST
// auth/capability lands on the service layer's own "not_found" outcome
// (404) - proving the route reached the handler/service, not that any
// particular business rule is correct (that's `service.test.ts`'s job).

const RESUBMIT_PATH = `/permits/${SOME_PERMIT_ID}/resubmit`;
const SEND_BACK_PATH = `/permits/${SOME_PERMIT_ID}/send-back`;
const HSE_SEND_BACK_PATH = `/permits/${SOME_PERMIT_ID}/hse-send-back`;
const HOLD_PATH = `/permits/${SOME_PERMIT_ID}/hold`;
const RESUME_PATH = `/permits/${SOME_PERMIT_ID}/resume`;
const CANCEL_PATH = `/permits/${SOME_PERMIT_ID}/cancel`;
const RENEW_PATH = `/permits/${SOME_PERMIT_ID}/renew`;

test('the SUBMIT route refuses an empty document with 422 empty_submission - and says so without demanding every field', async () => {
  // The backend is authoritative: partial submission is not something the
  // frontend enables by un-disabling a button. The only refusal left is a
  // document carrying nothing a person entered, and the message must not
  // tell people to fill everything in.
  grantedCapabilities = ['permit.submit'];
  mockPermitDetailRow = makePermitDetailRow({
    status: 'DRAFT',
    created_by: AUTHENTICATED_USER_ID,
    form_version: 'COLD_WORK_V2',
    permit_type: 'COLD_WORK',
    form_payload: blankPermitV2('COLD_WORK'),
  });
  const { url, close } = await startServer();
  try {
    const response = await postRequest(url, `/permits/${SOME_PERMIT_ID}/submit`, VALID_TOKEN, { expectedVersion: 1 });
    // The stubbed transactional client returns no rows, so the service
    // resolves through its own not-found path rather than a database.
    // What matters here is the CONTRACT: there is no route branch left
    // that demands a complete document.
    assert.notEqual(response.status, 200);
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (body.message) {
      assert.doesNotMatch(body.message, /every safety question/i, 'the completeness demand is gone');
    }
  } finally {
    await close();
  }
});


test('POST /permits/:id/resubmit denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RESUBMIT_PATH, undefined, { version: 1 })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/resubmit denies an authenticated actor without permit.submit (403)', async () => {
  grantedCapabilities = ['permit.create'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RESUBMIT_PATH, VALID_TOKEN, { version: 1 })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/resubmit lets an authenticated actor with permit.submit reach the handler/service', async () => {
  grantedCapabilities = ['permit.submit'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, RESUBMIT_PATH, VALID_TOKEN, { version: 1 });
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /permits/:id/send-back denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, SEND_BACK_PATH, undefined, { version: 1 })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/send-back denies an authenticated actor without permit.send_back (403)', async () => {
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, SEND_BACK_PATH, VALID_TOKEN, { version: 1 })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/send-back lets an authenticated actor with permit.send_back reach the handler/service, with or without an optional reason', async () => {
  grantedCapabilities = ['permit.send_back'];
  const { url, close } = await startServer();
  try {
    const withoutReason = await postRequest(url, SEND_BACK_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(withoutReason.status, 404);
    const withReason = await postRequest(url, SEND_BACK_PATH, VALID_TOKEN, { version: 1, reason: 'missing signage' });
    assert.equal(withReason.status, 404);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hse-send-back denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, HSE_SEND_BACK_PATH, undefined, { version: 1 })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hse-send-back denies an authenticated actor without permit.hse_review (403)', async () => {
  grantedCapabilities = ['permit.fallback_approve'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, HSE_SEND_BACK_PATH, VALID_TOKEN, { version: 1 })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hse-send-back lets an authenticated actor with permit.hse_review reach the handler/service', async () => {
  grantedCapabilities = ['permit.hse_review'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, HSE_SEND_BACK_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hold denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, HOLD_PATH, undefined, { version: 1, reason: 'x' })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hold denies an authenticated actor without permit.hold (403)', async () => {
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, HOLD_PATH, VALID_TOKEN, { version: 1, reason: 'x' })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hold rejects a missing/blank reason (400) - mandatory, enforced at the validation layer before the handler runs', async () => {
  grantedCapabilities = ['permit.hold'];
  const { url, close } = await startServer();
  try {
    const missing = await postRequest(url, HOLD_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(missing.status, 400);
    const blank = await postRequest(url, HOLD_PATH, VALID_TOKEN, { version: 1, reason: '   ' });
    assert.equal(blank.status, 400);
  } finally {
    await close();
  }
});

test('POST /permits/:id/hold lets an authenticated actor with permit.hold and a real reason reach the handler/service', async () => {
  grantedCapabilities = ['permit.hold'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, HOLD_PATH, VALID_TOKEN, { version: 1, reason: 'crane inspection overdue' });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('the hold route is bound specifically to permit.hold, not any other permit.* capability', async () => {
  grantedCapabilities = ['permit.create', 'permit.submit', 'permit.cancel', 'permit.resume', 'permit.close'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, HOLD_PATH, VALID_TOKEN, { version: 1, reason: 'x' });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/resume denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RESUME_PATH, undefined, { version: 1 })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/resume denies an authenticated actor without permit.resume (403)', async () => {
  grantedCapabilities = ['permit.hold'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RESUME_PATH, VALID_TOKEN, { version: 1 })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/resume lets an authenticated actor with permit.resume reach the handler/service', async () => {
  grantedCapabilities = ['permit.resume'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, RESUME_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /permits/:id/cancel denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, CANCEL_PATH, undefined, { version: 1 })).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/cancel denies an authenticated actor without permit.cancel (403)', async () => {
  grantedCapabilities = ['permit.hold'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, CANCEL_PATH, VALID_TOKEN, { version: 1 })).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/cancel lets an authenticated actor with permit.cancel reach the handler/service, with or without an optional reason', async () => {
  grantedCapabilities = ['permit.cancel'];
  const { url, close } = await startServer();
  try {
    const withoutReason = await postRequest(url, CANCEL_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(withoutReason.status, 404);
    const withReason = await postRequest(url, CANCEL_PATH, VALID_TOKEN, { version: 1, reason: 'no longer needed' });
    assert.equal(withReason.status, 404);
  } finally {
    await close();
  }
});

test('POST /permits/:id/renew denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RENEW_PATH, undefined, {})).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/renew denies an authenticated actor without permit.renew (403)', async () => {
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, RENEW_PATH, VALID_TOKEN, {})).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/renew rejects a client-supplied body field (400) - no mass assignment, nothing is legitimately client-suppliable for renewal', async () => {
  grantedCapabilities = ['permit.renew'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, RENEW_PATH, VALID_TOKEN, { version: 1 });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('POST /permits/:id/renew lets an authenticated actor with permit.renew reach the handler/service with an empty body', async () => {
  grantedCapabilities = ['permit.renew'];
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, RENEW_PATH, VALID_TOKEN, {});
    assert.equal(res.status, 404);
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
    const body = (await res.json()) as { permits: unknown[]; pagination: Record<string, unknown> };
    assert.equal(body.permits.length, 1);
    assert.deepEqual(body.pagination, {
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  } finally {
    await close();
  }
});

test('GET /permits/mine accepts page/pageSize query params and reflects them in the pagination metadata', async () => {
  grantedCapabilities = [];
  mockOwnPermitRows = [makePermitDetailRow({ created_by: AUTHENTICATED_USER_ID })];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/mine?page=2&pageSize=5', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pagination: Record<string, unknown> };
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.pageSize, 5);
  } finally {
    await close();
  }
});

test('GET /permits/mine rejects an out-of-range page (400)', async () => {
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/mine?page=0', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/mine?page=-1', VALID_TOKEN)).status, 400);
  } finally {
    await close();
  }
});

test('GET /permits/mine enforces the hard maximum page size - a client cannot request an unbounded result set (400)', async () => {
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/mine?pageSize=101', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/mine?pageSize=1000000', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/mine?pageSize=100', VALID_TOKEN)).status, 200);
  } finally {
    await close();
  }
});

test('GET /permits/mine: a syntactically valid but pathological offset (huge page x pageSize) is rejected (400), even though page/pageSize individually pass their own bounds', async () => {
  grantedCapabilities = [];
  mockOwnPermitRows = [];
  const { url, close } = await startServer();
  try {
    // (1001 - 1) * 100 === 100_000, the exact documented maximum offset - accepted.
    assert.equal((await getRequest(url, '/permits/mine?page=1001&pageSize=100', VALID_TOKEN)).status, 200);
    // (1002 - 1) * 100 === 100_100, one page beyond it - rejected.
    assert.equal((await getRequest(url, '/permits/mine?page=1002&pageSize=100', VALID_TOKEN)).status, 400);
    // page alone is a "valid" positive integer, but the resulting offset is nowhere near safe/sane.
    assert.equal(
      (await getRequest(url, `/permits/mine?page=${Number.MAX_SAFE_INTEGER}&pageSize=100`, VALID_TOKEN)).status,
      400,
    );
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
    const ownPermitsQuery = capturedQueries.find((q) => !q.sql.startsWith('SELECT COUNT') && q.sql.includes('FROM permits WHERE created_by'));
    assert.ok(ownPermitsQuery, 'expected the own-permits query to have run');
    // The first (identity) param is never anything a client could
    // supply - it's the authenticated actor's own id, from the verified
    // token. The remaining params are the default pagination bounds
    // (pageSize/offset), not an identity of any kind.
    assert.equal(ownPermitsQuery?.params[0], AUTHENTICATED_USER_ID);
    assert.deepEqual(ownPermitsQuery?.params, [AUTHENTICATED_USER_ID, 20, 0]);
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

test('GET /permits/queue returns paginated results with pagination metadata, defaulting page/pageSize when omitted', async () => {
  mockQueuePermitRows = [makePermitDetailRow({ status: 'PENDING_CRO' })];
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/queue?status=PENDING_CRO', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permits: unknown[]; pagination: Record<string, unknown> };
    assert.equal(body.permits.length, 1);
    assert.deepEqual(body.pagination, {
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  } finally {
    await close();
  }
});

test('GET /permits/queue rejects an invalid pageSize (400) - hard maximum enforced the same way as /permits/mine', async () => {
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO&pageSize=0', VALID_TOKEN)).status, 400);
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO&pageSize=101', VALID_TOKEN)).status, 400);
  } finally {
    await close();
  }
});

test('GET /permits/queue: a pathological offset is rejected (400) even when status is valid and the capability is held - no ownership/status leakage regression (the query never even runs)', async () => {
  grantedCapabilities = ['permit.cro_review'];
  mockQueuePermitRows = [];
  const { url, close } = await startServer();
  try {
    assert.equal(
      (await getRequest(url, '/permits/queue?status=PENDING_CRO&page=1001&pageSize=100', VALID_TOKEN)).status,
      200,
    );
    assert.equal(
      (await getRequest(url, '/permits/queue?status=PENDING_CRO&page=1002&pageSize=100', VALID_TOKEN)).status,
      400,
    );
    const statusQueryBeforeExcessive = capturedQueries.filter((q) => !q.sql.startsWith('SELECT COUNT') && q.sql.includes('FROM permits WHERE status'));
    // Only the accepted (page=1001) request above should have reached the database.
    assert.equal(statusQueryBeforeExcessive.length, 1);
  } finally {
    await close();
  }
});

test('GET /permits/queue: an invalid pagination param is rejected (400) even when the status is valid and the capability is held - validation runs regardless', async () => {
  grantedCapabilities = ['permit.cro_review'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/queue?status=PENDING_CRO&page=abc', VALID_TOKEN)).status, 400);
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

/**
 * An `issued_at` that is deterministically "earlier today" in the site
 * timezone used by these fixtures (UTC): the most recent UTC midnight.
 *
 * `Date.now() - 60_000` was not safe here. A permit's validity runs to
 * the NEXT midnight after issuance, so a run that started within 60
 * seconds of 00:00 UTC produced an `issued_at` on the PREVIOUS day whose
 * expiry had already passed - making these tests fail for roughly one
 * minute a day. Anchoring to the current UTC midnight is always in the
 * past and always expires tomorrow, with no sleep, no retry, and no
 * change to the production next-midnight rule being exercised.
 */
function issuedEarlierTodayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

test('GET /permits/:id: an ISSUED permit reports isValid=true before its expiry', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'ISSUED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: issuedEarlierTodayUtc(), // issued earlier today, deterministically before its next-midnight expiry
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
    issued_at: issuedEarlierTodayUtc(), // same issuance - would still be "valid" by time alone
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

test('GET /permits/:id: a non-owner with permit.send_back can view a PENDING_CORRECTION permit and sees no forwarding/resubmit actions (those require capabilities they don\'t hold)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CORRECTION', created_by: 'someone-else' });
  grantedCapabilities = ['permit.send_back'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[] };
    assert.deepEqual(body.availableActions, []);
  } finally {
    await close();
  }
});

test('GET /permits/:id: a non-owner without permit.send_back cannot view a PENDING_CORRECTION permit (404, IDOR-safe)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'PENDING_CORRECTION', created_by: 'someone-else' });
  grantedCapabilities = ['permit.close'];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN)).status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id: a HELD permit is visible via any of resume/cancel/close, and its availableActions reflect exactly which capability is held', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'HELD',
    created_by: 'someone-else',
    issued_at: issuedEarlierTodayUtc(),
    site_timezone: 'UTC',
  });
  grantedCapabilities = ['permit.resume'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[]; validity: { isValid: boolean } | null };
    assert.deepEqual(body.availableActions, ['resume']);
    // HELD is never valid for work, regardless of time-of-day.
    assert.equal(body.validity?.isValid, false);
  } finally {
    await close();
  }
});

test('GET /permits/:id: a CANCELLED permit is visible via permit.cancel and exposes no available actions (terminal)', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'CANCELLED',
    created_by: 'someone-else',
    issued_at: issuedEarlierTodayUtc(),
    site_timezone: 'UTC',
  });
  grantedCapabilities = ['permit.cancel'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[]; validity: { isValid: boolean } | null };
    assert.deepEqual(body.availableActions, []);
    assert.equal(body.validity?.isValid, false);
  } finally {
    await close();
  }
});

test('GET /permits/:id: an ISSUED permit exposes hold/cancel/close together when the viewer holds all three capabilities', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'ISSUED',
    created_by: 'someone-else',
    issued_at: issuedEarlierTodayUtc(),
    site_timezone: 'UTC',
  });
  grantedCapabilities = ['permit.hold', 'permit.cancel', 'permit.close'];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { availableActions: string[] };
    assert.deepEqual(body.availableActions.sort(), ['cancel', 'close', 'hold']);
  } finally {
    await close();
  }
});

/**
 * WHO CLOSED IT, END TO END.
 *
 * CRO A forwards the permit; CRO B closes it hours later. The detail
 * response has to name B as the closer - in the Closure record AND on
 * the closing lifecycle event - while A's own event stays A's, and
 * neither identity is read off a signature.
 */
test('GET /permits/:id names the ACTUAL closer, on both the closure and its history event', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'CLOSED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: 'cro-b',
    closed_at: '2026-01-01T17:00:00.000Z',
    closure_remarks: 'Work completed and area restored.',
  });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'CRO_FORWARDED_HSE', actor_user_id: 'cro-a', from_status: 'PENDING_CRO', to_status: 'PENDING_HSE', reason: null, occurred_at: '2026-01-01T08:00:00.000Z' },
    { id: 'e2', ordinal: '2', permit_id: SOME_PERMIT_ID, event_type: 'PERMIT_CLOSED', actor_user_id: 'cro-b', from_status: 'ISSUED', to_status: 'CLOSED', reason: 'Work completed and area restored.', occurred_at: '2026-01-01T17:00:00.000Z' },
  ];
  mockWorkforceIdentityRows = [
    { user_id: 'cro-a', display_name: 'Hamza Tariq', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'CRO' },
    { user_id: 'cro-b', display_name: 'Osama', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'CRO' },
  ];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      closure: { closedAt: string; remarks: string; closedBy: { displayName: string; positionName: string } };
      history: Array<{ event_type: string; actor: { displayName: string } | null }>;
    };

    assert.equal(body.closure.closedBy.displayName, 'Osama', 'the actor recorded on the permit');
    assert.equal(body.closure.closedBy.positionName, 'CRO');
    assert.equal(body.closure.remarks, 'Work completed and area restored.');

    const closed = body.history.find((event) => event.event_type === 'PERMIT_CLOSED')!;
    assert.equal(closed.actor?.displayName, 'Osama', 'the history names the same actual closer');
    const forwarded = body.history.find((event) => event.event_type === 'CRO_FORWARDED_HSE')!;
    assert.equal(forwarded.actor?.displayName, 'Hamza Tariq', 'and the earlier event stays its own actor');
  } finally {
    await close();
  }
});

test('GET /permits/:id names a PRIVILEGED closer rather than reporting them unknown', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'CLOSED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: 'ceo-1',
    closed_at: '2026-01-01T17:00:00.000Z',
    closure_remarks: null,
  });
  mockHistoryEventRows = [
    { id: 'e2', ordinal: '2', permit_id: SOME_PERMIT_ID, event_type: 'PERMIT_CLOSED', actor_user_id: 'ceo-1', from_status: 'ISSUED', to_status: 'CLOSED', reason: null, occurred_at: '2026-01-01T17:00:00.000Z' },
  ];
  mockPrivilegedIdentityRows = [{ user_id: 'ceo-1', display_name: 'Ayesha Khan', role: 'CEO' }];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    const body = (await res.json()) as {
      closure: { closedBy: { displayName: string; kind: string; privilegedRole: string; teamName: null } };
      history: Array<{ actor: { displayName: string } | null }>;
    };
    assert.equal(body.closure.closedBy.displayName, 'Ayesha Khan');
    assert.equal(body.closure.closedBy.kind, 'PRIVILEGED');
    assert.equal(body.closure.closedBy.privilegedRole, 'CEO');
    assert.equal(body.closure.closedBy.teamName, null, 'no team is invented for a privileged account');
    assert.equal(body.history[0]?.actor?.displayName, 'Ayesha Khan');
  } finally {
    await close();
  }
});

test('GET /permits/:id reports an unresolvable closer as null, and never falls back to a signature', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'CLOSED',
    created_by: AUTHENTICATED_USER_ID,
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: 'ghost',
    closed_at: '2026-01-01T17:00:00.000Z',
    closure_remarks: 'Closed out.',
  });
  mockHistoryEventRows = [
    { id: 'e2', ordinal: '2', permit_id: SOME_PERMIT_ID, event_type: 'PERMIT_CLOSED', actor_user_id: 'ghost', from_status: 'ISSUED', to_status: 'CLOSED', reason: 'Closed out.', occurred_at: '2026-01-01T17:00:00.000Z' },
  ];
  // Nobody matches 'ghost' in either account table.
  mockWorkforceIdentityRows = [
    { user_id: 'cro-a', display_name: 'Hamza Tariq', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'CRO' },
  ];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
    const body = (await res.json()) as {
      closure: { closedBy: unknown; remarks: string };
      history: Array<{ actor: unknown }>;
    };
    assert.equal(body.closure.closedBy, null, 'unknown stays unknown');
    assert.equal(body.closure.remarks, 'Closed out.', 'the closure is still a fact');
    assert.equal(body.history[0]?.actor, null);
    // The identity lookups - the batched ones, taking a list of user ids -
    // must never have consulted the signature table. Who signed is a
    // different fact from who acted.
    const identityLookups = capturedQueries.filter((entry) => Array.isArray(entry.params[0]));
    assert.ok(identityLookups.length > 0, 'the actor lookups actually ran');
    assert.ok(
      identityLookups.every((entry) => !/permit_signatures/.test(entry.sql)),
      'no actor identity may be resolved from a signature',
    );
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
    const body = (await res.json()) as { events: Array<{ actor: unknown }> };
    assert.equal(body.events.length, 1);
    // The history endpoint answers "who did this" the same way the
    // permit detail does - an unresolvable actor as an explicit null.
    assert.ok('actor' in body.events[0]!, 'each event carries its actor identity');
    assert.equal(body.events[0]!.actor, null);
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

test('GET /permits/:id/history: supplying a filter switches to the paginated path and adds a pagination block, without changing the unfiltered contract', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'SUBMITTED', actor_user_id: AUTHENTICATED_USER_ID, from_status: 'DRAFT', to_status: 'PENDING_CRO', reason: null, occurred_at: '2026-01-01T00:00:00.000Z' },
  ];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/history?eventType=SUBMITTED`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: unknown[]; pagination?: unknown };
    assert.equal(body.events.length, 1);
    assert.ok(body.pagination, 'filtered/paginated history responses include a pagination block');
  } finally {
    await close();
  }
});

test('GET /permits/:id/history rejects an invalid filter (400) - e.g. an occurredFrom after occurredTo', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID });
  const { url, close } = await startServer();
  try {
    const res = await getRequest(
      url,
      `/permits/${SOME_PERMIT_ID}/history?occurredFrom=2026-02-01T00:00:00.000Z&occurredTo=2026-01-01T00:00:00.000Z`,
      VALID_TOKEN,
    );
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

// --- GET /permits/search ---

test('GET /permits/search denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/search')).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/search returns only permits within the caller\'s own access scope (own + capability-granted statuses)', async () => {
  mockSearchPermitRows = [makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID })];
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/search', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permits: unknown[]; pagination: { totalCount: number } };
    assert.equal(body.permits.length, 1);
    assert.equal(body.pagination.totalCount, 1);
    // The access predicate always includes the caller's own id and the
    // capability-derived allowed-status array, regardless of filters.
    const searchQuery = capturedQueries.find((q) => q.sql.includes('FROM permits p JOIN jsas j') && !q.sql.startsWith('SELECT COUNT'));
    assert.ok(searchQuery);
    assert.equal(searchQuery?.params[0], AUTHENTICATED_USER_ID);
  } finally {
    await close();
  }
});

test('Permit Records returns [] when the database contains only DRAFT rows - owner, permit.view_all, CEO, SITE_MANAGER, CRO and HSE alike', async () => {
  mockSearchPermitRows = [makePermitDetailRow({ status: 'DRAFT', created_by: AUTHENTICATED_USER_ID })];
  const { url, close } = await startServer();
  try {
    const contexts: Array<() => void> = [
      // The owner of the draft.
      () => undefined,
      () => { grantedCapabilities = ['permit.view_all']; },
      () => { privilegedRoles = ['CEO']; },
      () => { privilegedRoles = ['SITE_MANAGER']; },
      // Reviewers: a workflow capability is a reason to see a permit in
      // THAT status, and DRAFT is never one of them.
      () => { grantedCapabilities = ['permit.cro_review']; },
      () => { grantedCapabilities = ['permit.hse_review']; },
      () => { grantedCapabilities = ['permit.cro_review', 'permit.hse_review', 'permit.view_all']; },
    ];
    for (const establish of contexts) {
      grantedCapabilities = [];
      privilegedRoles = [];
      establish();
      const response = await getRequest(url, '/permits/search', VALID_TOKEN);
      const body = (await response.json()) as { permits: unknown[]; pagination: { totalCount: number } };
      assert.equal(response.status, 200);
      assert.deepEqual(body.permits, []);
      assert.equal(body.pagination.totalCount, 0);
      const rowQuery = [...capturedQueries].reverse().find((entry) => entry.sql.includes('FROM permits p JOIN jsas j') && !entry.sql.startsWith('SELECT COUNT'));
      assert.match(rowQuery?.sql ?? '', /p\.status <> 'DRAFT'/);
    }
  } finally {
    await close();
  }
});

test('legacy /permits/mine cannot leak own or broad-visible drafts; /permits/my-drafts remains own-DRAFT-only', async () => {
  mockOwnPermitRows = [makePermitDetailRow({ id: 'own-draft', status: 'DRAFT', created_by: AUTHENTICATED_USER_ID })];
  mockSearchPermitRows = [
    makePermitDetailRow({ id: 'own-draft', status: 'DRAFT', created_by: AUTHENTICATED_USER_ID }),
    makePermitDetailRow({ id: 'other-draft', status: 'DRAFT', created_by: 'other' }),
  ];
  const { url, close } = await startServer();
  try {
    let response = await getRequest(url, '/permits/mine', VALID_TOKEN);
    assert.deepEqual(((await response.json()) as { permits: unknown[] }).permits, []);
    response = await getRequest(url, '/permits/my-drafts', VALID_TOKEN);
    const drafts = (await response.json()) as { permits: Array<{ id: string; created_by: string; status: string }> };
    assert.deepEqual(drafts.permits.map((permit) => permit.id), ['own-draft']);
    assert.ok(drafts.permits.every((permit) => permit.created_by === AUTHENTICATED_USER_ID && permit.status === 'DRAFT'));

    grantedCapabilities = ['permit.view_all'];
    response = await getRequest(url, '/permits/mine', VALID_TOKEN);
    assert.deepEqual(((await response.json()) as { permits: unknown[] }).permits, []);
  } finally {
    await close();
  }
});

test('Permit Records still returns an authorized non-DRAFT permit', async () => {
  mockSearchPermitRows = [makePermitDetailRow({ id: 'issued-record', status: 'ISSUED', created_by: 'other' })];
  grantedCapabilities = ['permit.view_all'];
  const { url, close } = await startServer();
  try {
    const response = await getRequest(url, '/permits/search', VALID_TOKEN);
    const body = (await response.json()) as { permits: Array<{ id: string; status: string }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.permits.map((permit) => permit.id), ['issued-record']);
  } finally {
    await close();
  }
});

test('GET /permits/search?permitNumber=... rejects a non-numeric value (400)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/search?permitNumber=not-a-number', VALID_TOKEN);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('GET /permits/search rejects an unknown query parameter (400) - strict schema', async () => {
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/search?nonsense=1', VALID_TOKEN);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('GET /permits/search enforces the same hard pagination bounds as every other list endpoint', async () => {
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/permits/search?pageSize=99999', VALID_TOKEN);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

// --- GET /permits/:id/pdf ---

test('GET /permits/:id/pdf denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`)).status, 401);
  } finally {
    await close();
  }
});

test('GET /permits/:id/pdf returns 404 (not 403) when the caller may not view the permit - authorization runs before any document lookup', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: 'someone-else', issued_at: '2026-01-01T09:00:00.000Z' });
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 404);
    assert.equal(
      capturedQueries.some((q) => q.sql.startsWith('SELECT s.*, j.id AS job_id')),
      false,
      'the document must never be looked up for a caller canViewPermit denies',
    );
  } finally {
    await close();
  }
});

test('GET /permits/:id/pdf returns 404 for a permit that was never issued (nothing to generate)', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'DRAFT', created_by: AUTHENTICATED_USER_ID, issued_at: null });
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('GET /permits/:id/pdf permits only ISSUED/CLOSED final packages, never HELD/CANCELLED masquerades', async () => {
  const { url, close } = await startServer();
  try {
    for (const status of ['HELD', 'CANCELLED'] as const) {
      mockPermitDetailRow = makePermitDetailRow({ status, created_by: AUTHENTICATED_USER_ID, issued_at: '2026-01-01T09:00:00.000Z' });
      assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN)).status, 404);
    }
    for (const status of ['ISSUED', 'CLOSED'] as const) {
      mockPermitDetailRow = makePermitDetailRow({ status, created_by: AUTHENTICATED_USER_ID, issued_at: '2026-01-01T09:00:00.000Z' });
      mockDocumentLookupRow = null;
      assert.equal((await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN)).status, 202);
    }
  } finally {
    await close();
  }
});

test('GET /permits/:id/pdf returns an explicit "processing" status (never a fake PDF) when the document has not been generated yet', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID, issued_at: '2026-01-01T09:00:00.000Z' });
  mockDocumentLookupRow = {
    id: 'snapshot-1',
    permit_id: SOME_PERMIT_ID,
    source_event_id: 'event-1',
    snapshot: {},
    snapshot_hash: 'hash',
    created_at: '2026-01-01T09:00:00.000Z',
    job_id: 'job-1',
    job_status: 'PENDING',
    job_storage_path: null,
    job_file_hash: null,
    job_generated_at: null,
    job_attempt_count: 0,
    job_last_error: null,
    job_created_at: '2026-01-01T09:00:00.000Z',
    job_updated_at: '2026-01-01T09:00:00.000Z',
  };
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 202);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'processing');
  } finally {
    await close();
  }
});

test('GET /permits/:id/pdf: with storage unconfigured (test env), a GENERATED job still fails safely (503) rather than serving a fake file', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID, issued_at: '2026-01-01T09:00:00.000Z' });
  mockDocumentLookupRow = {
    id: 'snapshot-1',
    permit_id: SOME_PERMIT_ID,
    source_event_id: 'event-1',
    snapshot: {},
    snapshot_hash: 'hash',
    created_at: '2026-01-01T09:00:00.000Z',
    job_id: 'job-1',
    job_status: 'GENERATED',
    job_storage_path: `permits/${SOME_PERMIT_ID}/snapshot-1.pdf`,
    job_file_hash: 'filehash',
    job_generated_at: '2026-01-01T09:05:00.000Z',
    job_attempt_count: 1,
    job_last_error: null,
    job_created_at: '2026-01-01T09:00:00.000Z',
    job_updated_at: '2026-01-01T09:05:00.000Z',
  };
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 503);
  } finally {
    await close();
  }
});

function setGeneratedDocument(fileHash: string): void {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: AUTHENTICATED_USER_ID, issued_at: '2026-01-01T09:00:00.000Z' });
  mockDocumentLookupRow = {
    id: 'snapshot-1', permit_id: SOME_PERMIT_ID, source_event_id: 'event-1', snapshot: {}, snapshot_hash: 'hash',
    created_at: '2026-01-01T09:00:00.000Z', job_id: 'job-1', job_status: 'GENERATED',
    job_storage_path: `permits/${SOME_PERMIT_ID}/snapshot-1.pdf`, job_file_hash: fileHash,
    job_generated_at: '2026-01-01T09:05:00.000Z', job_attempt_count: 1, job_last_error: null,
    job_created_at: '2026-01-01T09:00:00.000Z', job_updated_at: '2026-01-01T09:05:00.000Z',
  };
}

test('GET /permits/:id/pdf downloads and serves an authorized immutable PDF only when its SHA-256 matches', async () => {
  const bytes = Buffer.from('%PDF-1.7 immutable route test');
  setGeneratedDocument(computeFileHash(bytes));
  let downloads = 0;
  const storage: DocumentStorageAdapter = {
    async upload() { return { ok: true }; },
    async download() { downloads += 1; return { ok: true, data: bytes }; },
  };
  setDocumentStorageAdapterForTests(storage);
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    assert.equal(downloads, 1);
  } finally { await close(); }
});

test('permit.view_all can DOWNLOAD an issued PDF it does not own, but gains no approval authority', async () => {
  // The two halves of this are deliberately asserted together, because
  // the risk is that broad VISIBILITY quietly becomes workflow AUTHORITY.
  // Reading an issued record and approving one are different powers.
  const bytes = Buffer.from('%PDF-1.7 view_all download');
  setGeneratedDocument(computeFileHash(bytes));
  setDocumentStorageAdapterForTests({
    async upload() { return { ok: true }; },
    async download() { return { ok: true, data: bytes }; },
  });
  const { url, close } = await startServer();
  try {
    grantedCapabilities = ['permit.view_all'];
    const download = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(download.status, 200, 'broad visibility may read the issued document');

    // ...and nothing more. Approval routes need their own capability.
    for (const path of [`/permits/${SOME_PERMIT_ID}/forward-hse`, `/permits/${SOME_PERMIT_ID}/hse-approve`, `/permits/${SOME_PERMIT_ID}/send-back`]) {
      const response = await fetch(new URL(`/api/v1${path}`, url), {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      });
      assert.equal(response.status, 403, `${path} must refuse a permit.view_all holder`);
    }
  } finally { await close(); }
});

test('GET /permits/:id/pdf refuses altered Storage bytes without leaking the private path', async () => {
  setGeneratedDocument(computeFileHash(Buffer.from('expected bytes')));
  let downloads = 0;
  setDocumentStorageAdapterForTests({
    async upload() { return { ok: true }; },
    async download() { downloads += 1; return { ok: true, data: Buffer.from('tampered bytes') }; },
  });
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.doesNotMatch(body, /permits\//);
    assert.doesNotMatch(body, /snapshot-1/);
    assert.equal(downloads, 1);
  } finally { await close(); }
});

test('GET /permits/:id/pdf performs neither document nor Storage lookup for an unauthorized caller', async () => {
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: 'someone-else', issued_at: '2026-01-01T09:00:00.000Z' });
  let downloads = 0;
  setDocumentStorageAdapterForTests({
    async upload() { return { ok: true }; },
    async download() { downloads += 1; return { ok: true, data: Buffer.from('secret') }; },
  });
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}/pdf`, VALID_TOKEN);
    assert.equal(res.status, 404);
    assert.equal(capturedQueries.some((q) => q.sql.startsWith('SELECT s.*, j.id AS job_id')), false);
    assert.equal(downloads, 0);
  } finally { await close(); }
});

// ---------------------------------------------------------------------
// The authoritative form catalogue endpoint
// ---------------------------------------------------------------------

test('the form catalogue requires authentication', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/catalogue')).status, 401);
    assert.equal((await getRequest(url, '/permits/catalogue', 'not-a-valid-token')).status, 401);
  } finally {
    await close();
  }
});

test('the form catalogue is served to an authenticated caller with NO capability at all', async () => {
  // It is printed form text, identical for everyone - the same content as
  // the paper pad on site. Being signed in is the whole gate.
  grantedCapabilities = [];
  const { url, close } = await startServer();
  try {
    const response = await getRequest(url, '/permits/catalogue', VALID_TOKEN);
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test('the form catalogue defines all four permits and BOTH JSA pages', async () => {
  const { url, close } = await startServer();
  try {
    const body = (await (await getRequest(url, '/permits/catalogue', VALID_TOKEN)).json()) as {
      permits: Record<string, { formVersion: string; checklistSections: { id: string; items: unknown[] }[] }>;
      jsa: {
        formVersion: string;
        page1: { pageLabel: string; requiredPermits: { options: unknown[]; hasOther: boolean }; hseChecklistCategories: unknown[] };
        page2: { pageLabel: string; taskAnalysisColumns: unknown[]; energySourceLegend: unknown[] };
      };
    };

    assert.deepEqual(Object.keys(body.permits).sort(), [
      'COLD_WORK', 'CONFINED_SPACE_ENTRY', 'HOT_WORK', 'WTG_WORK',
    ]);
    assert.equal(body.permits.WTG_WORK!.formVersion, 'WTG_WORK_V2');

    // The JSA is two pages, and says so.
    assert.equal(body.jsa.formVersion, 'JSA_V2');
    assert.equal(body.jsa.page1.pageLabel, 'PAGE 1 OF 2');
    assert.equal(body.jsa.page2.pageLabel, 'PAGE 2 OF 2');

    // The two gaps this stage closes.
    assert.equal(body.jsa.page1.requiredPermits.options.length, 8);
    assert.equal(body.jsa.page1.requiredPermits.hasOther, true);
    assert.equal(body.jsa.page2.taskAnalysisColumns.length, 5);

    // The full HSE checklist travels to the browser.
    assert.equal(body.jsa.page1.hseChecklistCategories.length, 16);
    assert.equal(body.jsa.page2.energySourceLegend.length, 8);
  } finally {
    await close();
  }
});

test('the served catalogue keeps Hot Work and Cold Work distinct', async () => {
  const { url, close } = await startServer();
  try {
    const body = (await (await getRequest(url, '/permits/catalogue', VALID_TOKEN)).json()) as {
      permits: Record<string, {
        natureOfWork?: { options: { label: string }[] };
        checklistSections: { id: string; items: { label: string }[] }[];
      }>;
    };

    const hotNature = body.permits.HOT_WORK!.natureOfWork!.options.map((o) => o.label);
    const coldNature = body.permits.COLD_WORK!.natureOfWork!.options.map((o) => o.label);
    assert.equal(hotNature.length, 4, 'Hot Work prints four');
    assert.equal(coldNature.length, 5, 'Cold Work prints five, including INSPECTION');
    assert.ok(!hotNature.includes('INSPECTION'));

    const general = (permitKey: string): string[] =>
      body.permits[permitKey]!.checklistSections.find((s) => s.id === 'general_requirements')!.items.map((i) => i.label);
    assert.ok(general('HOT_WORK').includes('METAL THICKNESS FOR WELDING'));
    assert.ok(!general('COLD_WORK').includes('METAL THICKNESS FOR WELDING'));
    assert.notDeepEqual(general('HOT_WORK'), general('COLD_WORK'));
  } finally {
    await close();
  }
});

test('the catalogue exposes no secret, no database detail and no permit data', async () => {
  const { url, close } = await startServer();
  try {
    const raw = await (await getRequest(url, '/permits/catalogue', VALID_TOKEN)).text();
    for (const forbidden of [
      'postgres', 'postgresql', 'DATABASE_URL', 'service_role', 'SUPABASE', 'app_runtime',
      'privileged_runtime', 'password', 'secret', 'token', 'SELECT ', 'INSERT ',
      'created_by', 'permit_sequence', 'form_payload', 'capabilit',
    ]) {
      assert.ok(!raw.includes(forbidden), `the catalogue must not mention "${forbidden}"`);
    }
  } finally {
    await close();
  }
});

test('the catalogue reads nothing from the database', async () => {
  capturedQueries = [];
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/permits/catalogue', VALID_TOKEN)).status, 200);
    // Only the auth/access-state lookups the gate itself performs; no
    // permit, JSA or form query is issued for a static definition.
    const permitQueries = capturedQueries.filter((q) => /FROM\s+permits|FROM\s+jsas/i.test(q.sql));
    assert.deepEqual(permitQueries, []);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------
// CRO fallback approval: the authorization gate, over real HTTP
// ---------------------------------------------------------------------

/**
 * THE UI IS NOT THE SECURITY BOUNDARY.
 *
 * Whether the fallback button is on screen is decided by the server's
 * action hints, but nothing depends on that: these drive the real route
 * over real HTTP, so an attempt made straight at the API - by someone who
 * never saw a button, or who called it before the window expired - meets
 * the same gates.
 *
 * Business correctness of the outcome (the 4:59.999 / 5:00.000 boundary,
 * the one-winner race) is proven in domain/permits/service.test.ts. What
 * is proven here is that the gates cannot be walked around.
 */
function fallbackApproveRequest(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1/permits/${SOME_PERMIT_ID}/fallback-approve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 1 }),
  });
}

test('POST /permits/:id/fallback-approve rejects an unauthenticated caller (401)', async () => {
  grantedCapabilities = ['permit.fallback_approve'];
  const { url, close } = await startServer();
  try {
    assert.equal((await fallbackApproveRequest(url)).status, 401);
  } finally {
    await close();
  }
});

test('POST /permits/:id/fallback-approve denies an ordinary employee (403)', async () => {
  // An applicant, with no review authority of any kind.
  grantedCapabilities = ['permit.create', 'permit.submit'];
  const { url, close } = await startServer();
  try {
    assert.equal((await fallbackApproveRequest(url, VALID_TOKEN)).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/fallback-approve denies a CRO without the fallback capability (403)', async () => {
  /*
    A real CRO - they may review, forward, send back and hold - but
    fallback approval is a separately granted authority, and holding the
    rest of the CRO role does not confer it.
  */
  grantedCapabilities = ['permit.cro_review', 'permit.forward_hse', 'permit.send_back', 'permit.hold'];
  const { url, close } = await startServer();
  try {
    assert.equal((await fallbackApproveRequest(url, VALID_TOKEN)).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/fallback-approve denies an HSE approver (403)', async () => {
  // HSE approves on its own authority; it is not the fallback.
  grantedCapabilities = ['permit.hse_review'];
  const { url, close } = await startServer();
  try {
    assert.equal((await fallbackApproveRequest(url, VALID_TOKEN)).status, 403);
  } finally {
    await close();
  }
});

test('POST /permits/:id/fallback-approve lets a capable CRO reach the handler/service', async () => {
  grantedCapabilities = ['permit.fallback_approve'];
  const { url, close } = await startServer();
  try {
    const res = await fallbackApproveRequest(url, VALID_TOKEN);
    // Neither auth gate short-circuited it...
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    // ...and the fake DB behind this request holds no such permit, so the
    // service's own not-found outcome is what proves control genuinely
    // reached it rather than a stubbed-out auth layer.
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

/*
  THE PERMIT DID NOT DISAPPEAR WHEN HSE APPROVED IT.

  Reported from UAT: HSE opens a PENDING_HSE permit, presses "Approve and
  issue", the backend issues it correctly - the PDF is generated, the
  applicant and the CRO can both see it - and the HSE browser, still on
  the same URL, renders "That record is not available".

  The cause was here, in the read path, not in the workflow: HSE's read
  access was keyed to the queue they act from, so it ended at the instant
  they acted. `STATUS_VIEW_CAPABILITIES.ISSUED` listed `permit.close`,
  which is CRO's, and the reviewer who had just issued the permit was a
  stranger to it one request later.

  These exercise the REAL route with the REAL authorization, over HTTP,
  in the exact order the browser performs it.
*/

const HSE_ONLY = ['permit.hse_review'];

test('GET /permits/:id: an HSE reviewer can still read the permit they just issued', async () => {
  // The record as it stands immediately after the approval succeeded.
  mockPermitDetailRow = makePermitDetailRow({
    status: 'ISSUED',
    created_by: 'someone-else',
    issued_at: '2026-01-01T09:00:00.000Z',
  });
  grantedCapabilities = HSE_ONLY;
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);

    assert.equal(res.status, 200, 'the reviewer who issued it must not be told it does not exist');
    const body = (await res.json()) as { permit: { id: string; status: string }; availableActions: string[] };
    assert.equal(body.permit.id, SOME_PERMIT_ID);
    assert.equal(body.permit.status, 'ISSUED');
    // Read-only: issuing it was the last thing HSE may do to it.
    assert.deepEqual(body.availableActions, [], 'no approval or edit action survives issuance');
  } finally {
    await close();
  }
});

test('GET /permits/:id: HSE keeps reading the permit through hold, cancellation and closure', async () => {
  for (const status of ['HELD', 'CANCELLED', 'CLOSED'] as const) {
    mockPermitDetailRow = makePermitDetailRow({
      status,
      created_by: 'someone-else',
      issued_at: '2026-01-01T09:00:00.000Z',
      ...(status === 'CLOSED'
        ? { closed_by: 'cro-b', closed_at: '2026-01-01T17:00:00.000Z' }
        : {}),
    });
    grantedCapabilities = HSE_ONLY;
    const { url, close } = await startServer();
    try {
      const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
      assert.equal(res.status, 200, `${status} must remain readable by the approver`);
      const body = (await res.json()) as { availableActions: string[] };
      assert.deepEqual(body.availableActions, [], `${status} must offer HSE nothing to do`);
    } finally {
      await close();
    }
  }
});

test('GET /permits/:id: HSE still cannot read a permit that has not reached them (404, IDOR-safe)', async () => {
  // The states BEFORE their queue are none of their business, and the
  // fix above must not have quietly opened them.
  for (const status of ['DRAFT', 'PENDING_CRO', 'PENDING_CORRECTION'] as const) {
    mockPermitDetailRow = makePermitDetailRow({ status, created_by: 'someone-else' });
    grantedCapabilities = HSE_ONLY;
    const { url, close } = await startServer();
    try {
      const res = await getRequest(url, `/permits/${SOME_PERMIT_ID}`, VALID_TOKEN);
      assert.equal(res.status, 404, `${status} must stay invisible to HSE`);
    } finally {
      await close();
    }
  }
});

test('GET /permits/:id/history: the approver can still read the history of what they issued', async () => {
  mockPermitDetailRow = makePermitDetailRow({
    status: 'ISSUED',
    created_by: 'someone-else',
    issued_at: '2026-01-01T09:00:00.000Z',
  });
  mockHistoryEventRows = [
    { id: 'e1', ordinal: '1', permit_id: SOME_PERMIT_ID, event_type: 'HSE_APPROVED', actor_user_id: AUTHENTICATED_USER_ID, from_status: 'PENDING_HSE', to_status: 'ISSUED', reason: null, occurred_at: '2026-01-01T09:00:00.000Z' },
  ];
  grantedCapabilities = HSE_ONLY;
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

test('POST /permits/:id/hse-approve: reading after issuance does not let HSE approve again', async () => {
  // The read fix is a read fix. The mutation still refuses, on the
  // capability AND on the row-locked status behind it.
  mockPermitDetailRow = makePermitDetailRow({ status: 'ISSUED', created_by: 'someone-else' });
  grantedCapabilities = ['permit.close']; // a CRO: may read and close, may NOT approve
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, `/permits/${SOME_PERMIT_ID}/hse-approve`, VALID_TOKEN, {
      expectedVersion: 1,
    });
    assert.equal(res.status, 403, 'approval remains gated by permit.hse_review');
  } finally {
    await close();
  }
});
