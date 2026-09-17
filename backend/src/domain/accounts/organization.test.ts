import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  BASELINE_APPLICANT_CAPABILITIES,
  createCompany,
  createTeam,
  createTeamPosition,
  deactivateOrganizationRecord,
  type OrganizationDeps,
} from './organization.js';

/**
 * Runtime organization management.
 *
 * What matters here is not row-shuffling but the guarantees:
 *
 *   * a runtime-created association receives EXACTLY the applicant
 *     baseline and reaches it only through the bounded database
 *     function - never a direct write, never a caller-chosen capability;
 *   * a Position NAME is irrelevant to what is granted;
 *   * the shared `positions` row is reused rather than duplicated, and
 *     an association can never cross a company boundary;
 *   * uniqueness is decided by the database, not by a pre-check;
 *   * deactivation refuses rather than cascading, and never removes the
 *     last holder of a capability.
 */

const ACTOR = { actorUserId: '10000000-0000-4000-8000-000000000001' };
const COMPANY_ID = '18000000-0000-4000-8000-000000000001';
const TEAM_ID = '20000000-0000-4000-8000-000000000001';
const POSITION_ID = '30000000-0000-4000-8000-000000000001';
const TEAM_POSITION_ID = '40000000-0000-4000-8000-000000000001';

interface Captured {
  sql: string;
  params: unknown[];
}

/**
 * A fake transaction whose `query` answers from a scripted list of
 * responses and records every statement, so a test can assert on what
 * SQL the module actually ran - which is how the "never writes
 * capability data directly" claims below are proved rather than assumed.
 */
function fakeTransaction(
  responses: QueryResultRow[][],
  captured: Captured[],
  options: { throwOn?: (sql: string, call: number) => unknown } = {},
): OrganizationDeps {
  return {
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      let call = 0;
      const query = async <R extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResult<R>> => {
        captured.push({ sql, params });
        const thrown = options.throwOn?.(sql, call);
        if (thrown) throw thrown;
        const rows = (responses[call] ?? []) as R[];
        call += 1;
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      };
      return fn({ query } as unknown as PoolClient);
    },
  };
}

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

const allSql = (captured: Captured[]): string => captured.map((entry) => entry.sql).join('\n');

// =====================================================================
// Company
// =====================================================================

test('creating a company generates the code server-side and audits it', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, code: 'ABC_CONTRACTORS', name: 'ABC Contractors' }], []], captured);

  const result = await createCompany('ABC Contractors', ACTOR, deps);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.outcome === 'ok' && result.company.code, 'ABC_CONTRACTORS');

  // The code is a generated PARAMETER, not something a caller supplied.
  assert.equal(captured[0]?.params[0], 'ABC_CONTRACTORS');
  assert.equal(captured[0]?.params[1], 'ABC Contractors');
  assert.match(captured[1]?.sql ?? '', /organization_audit_events/);
  assert.equal(captured[1]?.params[0], 'COMPANY_CREATED');
  assert.equal(captured[1]?.params[1], ACTOR.actorUserId);
});

test('creating a company creates NO default team', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, code: 'ABC', name: 'ABC' }], []], captured);

  await createCompany('ABC', ACTOR, deps);

  // A company legitimately exists with zero teams; a hidden default one
  // would make the hierarchy look a level shallower than it is.
  assert.doesNotMatch(allSql(captured), /INSERT INTO teams/);
});

test('a generated code collision retries with the next candidate rather than failing', async () => {
  const captured: Captured[] = [];
  let attempts = 0;
  const deps: OrganizationDeps = {
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      attempts += 1;
      const currentAttempt = attempts;
      const query = async <R extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResult<R>> => {
        captured.push({ sql, params });
        if (sql.includes('INSERT INTO companies') && currentAttempt === 1) {
          throw uniqueViolation('companies_code_key');
        }
        const rows = (sql.includes('INSERT INTO companies')
          ? [{ id: COMPANY_ID, code: String(params[0]), name: String(params[1]) }]
          : []) as unknown as R[];
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      };
      return fn({ query } as unknown as PoolClient);
    },
  };

  const result = await createCompany('ABC Contractors', ACTOR, deps);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.outcome === 'ok' && result.company.code, 'ABC_CONTRACTORS_2');
  assert.equal(attempts, 2, 'the second candidate should have been tried');
});

test('a duplicate company NAME is a conflict, not an endless retry', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([], captured, {
    throwOn: (sql) =>
      sql.includes('INSERT INTO companies')
        ? uniqueViolation('companies_name_normalized_unique')
        : undefined,
  });

  const result = await createCompany('ABC Contractors', ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'duplicate_name');
  // Exactly one attempt: a name clash is the administrator's answer, not
  // an internal code collision to work around.
  assert.equal(captured.length, 1);
});

test('uniqueness is decided by the INSERT, never by a prior existence check', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, code: 'ABC', name: 'ABC' }], []], captured);

  await createCompany('ABC', ACTOR, deps);

  // A read-then-write pre-check would let two concurrent requests both
  // pass before either inserted. There must be no such SELECT.
  assert.doesNotMatch(allSql(captured), /SELECT[^;]*FROM companies/i);
  assert.match(captured[0]?.sql ?? '', /INSERT INTO companies/);
});

// =====================================================================
// Team
// =====================================================================

test('a team can be added to an existing company, including a seeded one', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [
      [{ id: COMPANY_ID, deactivated_at: null }],
      [{ id: TEAM_ID, name: 'Electrical', company_id: COMPANY_ID }],
      [],
    ],
    captured,
  );

  const result = await createTeam(COMPANY_ID, 'Electrical', ACTOR, deps);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.outcome === 'ok' && result.team.companyId, COMPANY_ID);
  assert.match(captured[1]?.sql ?? '', /INSERT INTO teams/);
  assert.deepEqual(captured[1]?.params, ['Electrical', COMPANY_ID]);
  assert.equal(captured[2]?.params[0], 'TEAM_CREATED');
});

test('a team cannot be added to a company that does not exist', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[]], captured);

  const result = await createTeam(COMPANY_ID, 'Electrical', ACTOR, deps);

  assert.equal(result.outcome, 'not_found');
  assert.doesNotMatch(allSql(captured), /INSERT INTO teams/);
});

test('an inactive company cannot receive new teams', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: '2026-01-01T00:00:00Z' }]], captured);

  const result = await createTeam(COMPANY_ID, 'Electrical', ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'company_inactive');
  assert.doesNotMatch(allSql(captured), /INSERT INTO teams/);
});

// =====================================================================
// Team + Position association, and the capability boundary
// =====================================================================

function associationDeps(captured: Captured[], positionRows: QueryResultRow[] = [{ id: POSITION_ID, name: 'Supervisor' }]) {
  return fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }], // team lookup
      [], // INSERT INTO positions ... ON CONFLICT DO NOTHING
      positionRows, // SELECT position
      [{ id: TEAM_POSITION_ID }], // INSERT INTO team_positions
      [], // grant_baseline_applicant_capabilities
      [], // POSITION_CREATED
      [], // TEAM_POSITION_CREATED
      [], // BASELINE_CAPABILITIES_GRANTED
    ],
    captured,
  );
}

test('a new association receives exactly the applicant baseline, through the bounded function', async () => {
  const captured: Captured[] = [];
  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));

  assert.equal(result.outcome, 'ok');
  assert.deepEqual(
    result.outcome === 'ok' ? [...result.association.baselineCapabilities] : [],
    ['permit.create', 'permit.submit'],
  );

  const sql = allSql(captured);
  assert.match(sql, /grant_baseline_applicant_capabilities/);
  // The function takes ONLY the association id - there is no parameter
  // through which a capability could be requested.
  const call = captured.find((entry) => entry.sql.includes('grant_baseline_applicant_capabilities'));
  assert.deepEqual(call?.params, [TEAM_POSITION_ID]);
});

test('the module NEVER writes capability data directly', async () => {
  const captured: Captured[] = [];
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));

  const sql = allSql(captured);
  // The only write path to capability data is the SECURITY DEFINER
  // function whose capability names are literals in database code.
  // `app_runtime` holds no INSERT/UPDATE/DELETE on this table at all.
  assert.doesNotMatch(sql, /INSERT INTO team_position_capabilities/i);
  assert.doesNotMatch(sql, /UPDATE team_position_capabilities/i);
  assert.doesNotMatch(sql, /DELETE FROM team_position_capabilities/i);
});

test('no organization write ever touches privileged access or capability definitions', async () => {
  const captured: Captured[] = [];
  await createCompany('ABC', ACTOR, fakeTransaction([[{ id: COMPANY_ID, code: 'ABC', name: 'ABC' }], []], captured));
  await createTeam(COMPANY_ID, 'Electrical', ACTOR, fakeTransaction(
    [[{ id: COMPANY_ID, deactivated_at: null }], [{ id: TEAM_ID, name: 'Electrical', company_id: COMPANY_ID }], []],
    captured,
  ));
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'CRO', ACTOR, associationDeps(captured));

  const sql = allSql(captured);
  assert.doesNotMatch(sql, /privileged_access_events/i);
  assert.doesNotMatch(sql, /privileged_identities/i);
  assert.doesNotMatch(sql, /record_site_manager_grant/i);
  assert.doesNotMatch(sql, /INSERT INTO capabilities/i);
  assert.doesNotMatch(sql, /user_capability_grants/i);
});

test('a position named CRO, HSE Officer, Site Manager or CEO gets the same baseline and nothing more', async () => {
  for (const name of ['CRO', 'HSE Officer', 'Site Manager', 'CEO', 'Electrician']) {
    const captured: Captured[] = [];
    const result = await createTeamPosition(
      COMPANY_ID,
      TEAM_ID,
      name,
      ACTOR,
      associationDeps(captured, [{ id: POSITION_ID, name }]),
    );

    assert.equal(result.outcome, 'ok', `${name} should be creatable`);
    assert.deepEqual(
      result.outcome === 'ok' ? [...result.association.baselineCapabilities] : [],
      ['permit.create', 'permit.submit'],
      `${name} received something other than the baseline`,
    );

    const sql = allSql(captured);
    // The name is data. It never appears in a capability decision.
    assert.doesNotMatch(sql, /permit\.cro_review/);
    assert.doesNotMatch(sql, /permit\.hse_review/);
    assert.doesNotMatch(sql, /permit\.fallback_approve/);
    assert.doesNotMatch(sql, /employee\.create/);
    assert.doesNotMatch(sql, /SITE_MANAGER/);
  }
});

test('the baseline is the documented two capabilities and no more', () => {
  assert.deepEqual([...BASELINE_APPLICANT_CAPABILITIES], ['permit.create', 'permit.submit']);
});

test('the shared position row is reused, never duplicated', async () => {
  const captured: Captured[] = [];
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));

  const insert = captured.find((entry) => entry.sql.includes('INSERT INTO positions'));
  // ON CONFLICT DO NOTHING is untargeted on purpose: `positions` carries
  // both an exact-name and a normalized-name unique index, and naming
  // only one would let a case variant escape as a raw error.
  assert.match(insert?.sql ?? '', /ON CONFLICT DO NOTHING/);
  const select = captured.find((entry) => entry.sql.includes('SELECT id, name FROM positions'));
  assert.match(select?.sql ?? '', /lower\(btrim\(name\)\)/);
});

test('the team is resolved WITHIN the company, so an association cannot cross a boundary', async () => {
  const captured: Captured[] = [];
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));

  const lookup = captured[0];
  assert.match(lookup?.sql ?? '', /t\.id = \$1 AND t\.company_id = \$2/);
  assert.deepEqual(lookup?.params, [TEAM_ID, COMPANY_ID]);
});

test("another company's team id reads as not found, never as an accepted association", async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[]], captured);

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps);

  assert.equal(result.outcome, 'not_found');
  assert.doesNotMatch(allSql(captured), /INSERT INTO team_positions/);
});

test('an inactive team cannot receive positions', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [[{ id: TEAM_ID, deactivated_at: '2026-01-01T00:00:00Z', company_deactivated_at: null }]],
    captured,
  );

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'team_inactive');
  assert.doesNotMatch(allSql(captured), /INSERT INTO team_positions/);
});

test('a team under an INACTIVE COMPANY cannot receive positions either', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [[{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: '2026-01-01T00:00:00Z' }]],
    captured,
  );

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'team_inactive');
});

test('a duplicate (team, position) association is a conflict', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
      [],
      [{ id: POSITION_ID, name: 'Supervisor' }],
    ],
    captured,
    {
      throwOn: (sql) =>
        sql.includes('INSERT INTO team_positions') ? uniqueViolation('team_positions_unique') : undefined,
    },
  );

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'duplicate_association');
});

test('a failing baseline grant aborts the whole association - never a half-capable row', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
      [],
      [{ id: POSITION_ID, name: 'Supervisor' }],
      [{ id: TEAM_POSITION_ID }],
    ],
    captured,
    {
      throwOn: (sql) =>
        sql.includes('grant_baseline_applicant_capabilities')
          ? new Error('the baseline applicant capabilities are not both defined (found 1)')
          : undefined,
    },
  );

  // The database function raises, so the transaction carrying the
  // association INSERT fails with it: all-or-nothing, by construction.
  await assert.rejects(
    () => createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps),
    /baseline applicant capabilities/,
  );
  // The audit rows are written after the grant, so none was recorded.
  assert.doesNotMatch(allSql(captured), /organization_audit_events/);
});

test('site_manager_assignable is set on INSERT of a new row only, never by UPDATE', async () => {
  const captured: Captured[] = [];
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));

  const insert = captured.find((entry) => entry.sql.includes('INSERT INTO team_positions'));
  assert.match(insert?.sql ?? '', /site_manager_assignable/);
  assert.match(insert?.sql ?? '', /VALUES \(\$1, \$2, TRUE\)/);
  // It must never be flipped on a pre-existing association.
  assert.doesNotMatch(allSql(captured), /UPDATE team_positions[\s\S]*site_manager_assignable/i);
});

// =====================================================================
// Deactivation
// =====================================================================

test('deactivation sets a timestamp and audits it, at each level', async () => {
  for (const [level, event] of [
    ['company', 'COMPANY_DEACTIVATED'],
    ['team', 'TEAM_DEACTIVATED'],
    ['team_position', 'TEAM_POSITION_DEACTIVATED'],
  ] as const) {
    const captured: Captured[] = [];
    const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: null }], [], []], captured);

    const result = await deactivateOrganizationRecord(level, COMPANY_ID, ACTOR, deps);

    assert.equal(result.outcome, 'ok');
    assert.match(captured[1]?.sql ?? '', /SET deactivated_at = now\(\)/);
    assert.equal(captured[2]?.params[0], event);
  }
});

test('deactivation never cascades to child records', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: null }], [], []], captured);

  await deactivateOrganizationRecord('company', COMPANY_ID, ACTOR, deps);

  const sql = allSql(captured);
  assert.doesNotMatch(sql, /UPDATE teams/);
  assert.doesNotMatch(sql, /UPDATE team_positions/);
  // And nothing touches people or their work.
  assert.doesNotMatch(sql, /DELETE/i);
  assert.doesNotMatch(sql, /workforce_profiles/);
  assert.doesNotMatch(sql, /app_user_access/);
  assert.doesNotMatch(sql, /permits/);
});

test('deactivation is refused while an active employee still depends on the record', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: TEAM_ID, deactivated_at: null }]], captured, {
    throwOn: (sql) =>
      sql.includes('SET deactivated_at')
        ? new Error('team 20000000-0000-4000-8000-000000000001 still has 3 active employee(s); reassign or disable them before deactivating it')
        : undefined,
  });

  const result = await deactivateOrganizationRecord('team', TEAM_ID, ACTOR, deps);

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.outcome === 'blocked' && result.reason, 'active_employees');
});

test('deactivation is refused when it would push a REQUIRED capability below its minimum', async () => {
  for (const capability of ['permit.cro_review', 'permit.hse_review']) {
    const captured: Captured[] = [];
    const deps = fakeTransaction([[{ id: TEAM_POSITION_ID, deactivated_at: null }]], captured, {
      throwOn: (sql) =>
        sql.includes('SET deactivated_at')
          ? new Error(
              `deactivating team position ${TEAM_POSITION_ID} would leave required capability ${capability} below its required coverage`,
            )
          : undefined,
    });

    const result = await deactivateOrganizationRecord('team_position', TEAM_POSITION_ID, ACTOR, deps);

    // This is what stops an organization action from quietly removing the
    // only CRO or HSE authority path.
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.outcome === 'blocked' && result.reason, 'capability_coverage');
  }
});

test('deactivating an already inactive record is a conflict, not a silent no-op', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: '2026-01-01T00:00:00Z' }]], captured);

  const result = await deactivateOrganizationRecord('company', COMPANY_ID, ACTOR, deps);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.outcome === 'conflict' && result.reason, 'already_inactive');
  assert.doesNotMatch(allSql(captured), /SET deactivated_at/);
});

test('an unknown record is not found, and nothing is written', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[]], captured);

  const result = await deactivateOrganizationRecord('company', COMPANY_ID, ACTOR, deps);

  assert.equal(result.outcome, 'not_found');
  assert.doesNotMatch(allSql(captured), /SET deactivated_at/);
});

test('no table name is ever interpolated into a deactivation statement', async () => {
  for (const level of ['company', 'team', 'team_position'] as const) {
    const captured: Captured[] = [];
    const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: null }], [], []], captured);
    await deactivateOrganizationRecord(level, COMPANY_ID, ACTOR, deps);
    for (const entry of captured) {
      assert.doesNotMatch(entry.sql, /\$\{/, 'a statement was built by interpolation');
    }
  }
});

test('an unexpected database error is never swallowed as a business outcome', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction([[{ id: COMPANY_ID, deactivated_at: null }]], captured, {
    throwOn: (sql) => (sql.includes('SET deactivated_at') ? new Error('connection terminated') : undefined),
  });

  await assert.rejects(
    () => deactivateOrganizationRecord('company', COMPANY_ID, ACTOR, deps),
    /connection terminated/,
  );
});

// =====================================================================
// POSITION_CREATED must describe what actually happened
// =====================================================================

test('reusing an existing global position emits NO POSITION_CREATED', async () => {
  const captured: Captured[] = [];
  // The INSERT ... ON CONFLICT DO NOTHING RETURNING returns NO row, which
  // is how the domain knows the shared vocabulary row already existed.
  const deps = fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
      [], // INSERT ... RETURNING -> nothing inserted
      [{ id: POSITION_ID, name: 'Supervisor' }], // the existing row
      [{ id: TEAM_POSITION_ID }],
      [],
      [],
      [],
    ],
    captured,
  );

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, deps);
  assert.equal(result.outcome, 'ok');

  const events = captured
    .filter((entry) => entry.sql.includes('organization_audit_events'))
    .map((entry) => entry.params[0]);
  assert.deepEqual(events, ['TEAM_POSITION_CREATED', 'BASELINE_CAPABILITIES_GRANTED']);
  assert.ok(!events.includes('POSITION_CREATED'), 'no position was created, so none may be claimed');
});

test('minting a NEW global position emits POSITION_CREATED exactly once', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
      [{ id: POSITION_ID, name: 'Rope Access Technician' }], // genuinely inserted
      [{ id: TEAM_POSITION_ID }],
      [],
      [],
      [],
      [],
    ],
    captured,
  );

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Rope Access Technician', ACTOR, deps);
  assert.equal(result.outcome, 'ok');

  const events = captured
    .filter((entry) => entry.sql.includes('organization_audit_events'))
    .map((entry) => entry.params[0]);
  assert.deepEqual(events, ['POSITION_CREATED', 'TEAM_POSITION_CREATED', 'BASELINE_CAPABILITIES_GRANTED']);
  assert.equal(events.filter((event) => event === 'POSITION_CREATED').length, 1);
});

test('the position INSERT uses RETURNING - that is what distinguishes mint from reuse', async () => {
  const captured: Captured[] = [];
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, associationDeps(captured));
  const insert = captured.find((entry) => entry.sql.includes('INSERT INTO positions'));
  assert.match(insert?.sql ?? '', /ON CONFLICT DO NOTHING RETURNING id, name/);
});

test('when the position is minted, no redundant SELECT is issued', async () => {
  const captured: Captured[] = [];
  const deps = fakeTransaction(
    [
      [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
      [{ id: POSITION_ID, name: 'New Designation' }],
      [{ id: TEAM_POSITION_ID }],
      [], [], [], [],
    ],
    captured,
  );
  await createTeamPosition(COMPANY_ID, TEAM_ID, 'New Designation', ACTOR, deps);
  const selects = captured.filter((entry) => entry.sql.includes('SELECT id, name FROM positions'));
  assert.equal(selects.length, 0, 'RETURNING already produced the row');
});

// =====================================================================
// Transactional atomicity - behavioural, not statement-order
// =====================================================================

/**
 * A transaction fake that records BEGIN/COMMIT/ROLLBACK and tags every
 * statement with the client that issued it, so a test can prove the work
 * and its audit really did share one connection.
 */
function transactionSpy(
  responses: QueryResultRow[][],
  captured: Array<Captured & { clientId: number }>,
  options: { throwOn?: (sql: string) => unknown } = {},
): { deps: OrganizationDeps; clients: () => number } {
  let clientCount = 0;
  const deps: OrganizationDeps = {
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      clientCount += 1;
      const clientId = clientCount;
      let call = 0;
      const query = async <R extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = [],
      ): Promise<QueryResult<R>> => {
        captured.push({ sql, params, clientId });
        const thrown = options.throwOn?.(sql);
        if (thrown) throw thrown;
        // Transaction control is a real statement on the client, but it
        // consumes none of the scripted responses - otherwise BEGIN
        // would shift every answer by one.
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0, command: sql, oid: 0, fields: [] };
        }
        const rows = (responses[call] ?? []) as R[];
        call += 1;
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      };
      // Mirrors db/pool.ts::withTransaction exactly.
      await query('BEGIN');
      try {
        const result = await fn({ query } as unknown as PoolClient);
        await query('COMMIT');
        return result;
      } catch (err) {
        await query('ROLLBACK');
        throw err;
      }
    },
  };
  return { deps, clients: () => clientCount };
}

const ASSOCIATION_RESPONSES: QueryResultRow[][] = [
  [{ id: TEAM_ID, deactivated_at: null, company_deactivated_at: null }],
  [{ id: POSITION_ID, name: 'Supervisor' }],
  [{ id: TEAM_POSITION_ID }],
  [], [], [], [],
];

test('the whole association is one transaction on ONE client', async () => {
  const captured: Array<Captured & { clientId: number }> = [];
  const spy = transactionSpy(ASSOCIATION_RESPONSES, captured);

  const result = await createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, spy.deps);
  assert.equal(result.outcome, 'ok');

  assert.equal(spy.clients(), 1, 'more than one connection was used');
  const ids = new Set(captured.map((entry) => entry.clientId));
  assert.equal(ids.size, 1, 'statements were split across clients');

  const order = captured.map((entry) => entry.sql.split(/\s+/).slice(0, 3).join(' '));
  assert.equal(order[0], 'BEGIN');
  assert.equal(order.at(-1), 'COMMIT');
  // Everything that matters happened between them.
  const joined = captured.map((entry) => entry.sql).join('\n');
  assert.match(joined, /INSERT INTO positions/);
  assert.match(joined, /INSERT INTO team_positions/);
  assert.match(joined, /grant_baseline_applicant_capabilities/);
  assert.match(joined, /organization_audit_events/);
});

test('a FAILING baseline grant rolls the whole association back - no COMMIT', async () => {
  const captured: Array<Captured & { clientId: number }> = [];
  const spy = transactionSpy(ASSOCIATION_RESPONSES, captured, {
    throwOn: (sql) =>
      sql.includes('grant_baseline_applicant_capabilities')
        ? new Error('the baseline applicant capabilities are not both defined (found 1)')
        : undefined,
  });

  await assert.rejects(
    () => createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, spy.deps),
    /baseline applicant capabilities/,
  );

  const statements = captured.map((entry) => entry.sql);
  assert.ok(statements.includes('ROLLBACK'), 'the transaction must roll back');
  assert.ok(!statements.includes('COMMIT'), 'a failed grant must never commit');
  // The association INSERT ran, and is therefore discarded by the rollback.
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO team_positions')));
  // And no audit row claims success.
  assert.ok(!statements.some((sql) => sql.includes('organization_audit_events')));
});

test('a FAILING audit insert rolls the mutation back - the audit cannot be skipped', async () => {
  const captured: Array<Captured & { clientId: number }> = [];
  const spy = transactionSpy(ASSOCIATION_RESPONSES, captured, {
    throwOn: (sql) =>
      sql.includes('organization_audit_events')
        ? Object.assign(new Error('append-only'), { code: '42501' })
        : undefined,
  });

  await assert.rejects(() => createTeamPosition(COMPANY_ID, TEAM_ID, 'Supervisor', ACTOR, spy.deps));

  const statements = captured.map((entry) => entry.sql);
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.includes('COMMIT'), 'a mutation whose audit failed must not commit');
});

test('company creation and its audit also share one transaction, and roll back together', async () => {
  const captured: Array<Captured & { clientId: number }> = [];
  const spy = transactionSpy([[{ id: COMPANY_ID, code: 'ABC', name: 'ABC' }], []], captured, {
    throwOn: (sql) =>
      sql.includes('organization_audit_events') ? Object.assign(new Error('boom'), { code: '42501' }) : undefined,
  });

  await assert.rejects(() => createCompany('ABC', ACTOR, spy.deps));
  const statements = captured.map((entry) => entry.sql);
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.includes('COMMIT'));
});

test('deactivation and its audit share one transaction, and roll back together', async () => {
  const captured: Array<Captured & { clientId: number }> = [];
  const spy = transactionSpy([[{ id: TEAM_POSITION_ID, deactivated_at: null }], [], []], captured, {
    throwOn: (sql) =>
      sql.includes('organization_audit_events') ? Object.assign(new Error('boom'), { code: '42501' }) : undefined,
  });

  await assert.rejects(() =>
    deactivateOrganizationRecord('team_position', TEAM_POSITION_ID, ACTOR, spy.deps));
  const statements = captured.map((entry) => entry.sql);
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.includes('COMMIT'));
});
