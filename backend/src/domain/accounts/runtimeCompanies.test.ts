import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { resolveProvisioningCompany, resolveProvisioningDestination } from './companies.js';
import {
  createEmployeeBodySchema,
  employeeListQuerySchema,
  updateEmployeeBodySchema,
} from './validation.js';

/**
 * RUNTIME-CREATED COMPANIES IN EMPLOYEE ADMINISTRATION.
 *
 * Organization Management creates companies at runtime, so a company
 * that did not exist when this build shipped must still be a valid
 * employee destination. These specs prove that end to end at the
 * account-management contract level: the request boundary accepts a
 * runtime code, and the destination check then proves the row is real,
 * active, assignable, and owned by the company that was named.
 *
 * The two halves are deliberately separate. Shape validation keeps
 * impossible values out of a query; it is NOT authorization. Everything
 * that decides whether a destination may be used is resolved against the
 * database.
 */

const ABB = '18000000-0000-4000-8000-0000000000ab';

interface Captured {
  sql: string;
  params: unknown[];
}

/** Answers the two statements `resolveProvisioningDestination` issues, in order. */
function stubQuery(responses: QueryResultRow[][], captured: Captured[] = []) {
  let call = 0;
  return async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> => {
    captured.push({ sql, params });
    const rows = (responses[call] ?? []) as T[];
    call += 1;
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  };
}

const companyRow = { id: ABB, code: 'ABB', name: 'ABB' };
const assignable = [{ exists: true }];

const VALID_CREATE = {
  email: 'new.hire@abb.example.com',
  temporaryPassword: 'a-temporary-password',
  displayName: 'New Hire',
  teamPositionId: '40000000-0000-4000-8000-000000000001',
};

// =====================================================================
// 1-2. The request boundary
// =====================================================================

test('a runtime company code passes request validation', () => {
  for (const companyCode of ['ABB', 'ABC_CONTRACTORS', 'XYZ_SERVICES_2', 'A', 'C_3M_SOLUTIONS']) {
    const parsed = createEmployeeBodySchema.safeParse({ ...VALID_CREATE, companyCode });
    assert.equal(parsed.success, true, `${companyCode} should be accepted`);
  }
});

test('the seeded companies still pass, unchanged', () => {
  for (const companyCode of ['E_SET', 'ZPL', 'SGRE']) {
    assert.equal(
      createEmployeeBodySchema.safeParse({ ...VALID_CREATE, companyCode }).success,
      true,
      companyCode,
    );
  }
});

test('a MALFORMED company code is refused at the boundary', () => {
  // The shape migration 0035 enforces: ^[A-Z][A-Z0-9_]*$, max 48.
  const malformed = [
    'abb', // lower case - codes are returned canonical, never repaired here
    ' ABB', // leading space
    'ABB ', // trailing space
    '2ABB', // must start with a letter
    'ABB-CONTRACTORS', // hyphen is not in the alphabet
    'ABB CONTRACTORS', // space
    'ABB;DROP', // punctuation
    '',
    'A'.repeat(49), // over the generated bound
  ];
  for (const companyCode of malformed) {
    assert.equal(
      createEmployeeBodySchema.safeParse({ ...VALID_CREATE, companyCode }).success,
      false,
      `${JSON.stringify(companyCode)} should be refused`,
    );
  }
});

test('a malformed code is not silently repaired into a valid one', () => {
  // Accepting ' abb ' by trimming and uppercasing would mean the value
  // stored differs from the value sent. It is a 400 instead.
  const parsed = createEmployeeBodySchema.safeParse({ ...VALID_CREATE, companyCode: ' abb ' });
  assert.equal(parsed.success, false);
});

test('the transfer and directory schemas accept the same runtime codes', () => {
  assert.equal(
    updateEmployeeBodySchema.safeParse({
      companyCode: 'ABB',
      teamPositionId: '40000000-0000-4000-8000-000000000001',
    }).success,
    true,
  );
  // 11. The directory filter must accept a runtime code, or an ABB
  // employee could exist and never be filtered by ABB.
  assert.equal(employeeListQuerySchema.safeParse({ companyCode: 'ABB' }).success, true);
  assert.equal(employeeListQuerySchema.safeParse({ companyCode: 'ABC_CONTRACTORS' }).success, true);
  assert.equal(employeeListQuerySchema.safeParse({ companyCode: 'abb' }).success, false);
  assert.equal(employeeListQuerySchema.safeParse({ state: 'DELETED' }).success, false);
});

test('no request schema accepts an id, a name, a capability or an authority field', () => {
  const smuggled: Record<string, unknown>[] = [
    { companyId: ABB },
    { companyName: 'ABB' },
    { capabilities: ['permit.cro_review'] },
    { capability: 'permit.hse_review' },
    { siteManagerAssignable: true },
    { privilegedRoles: ['SITE_MANAGER'] },
    { role: 'CEO' },
  ];
  for (const extra of smuggled) {
    assert.equal(
      createEmployeeBodySchema.safeParse({ ...VALID_CREATE, companyCode: 'ABB', ...extra }).success,
      false,
      JSON.stringify(extra),
    );
    assert.equal(
      updateEmployeeBodySchema.safeParse({
        companyCode: 'ABB',
        teamPositionId: VALID_CREATE.teamPositionId,
        ...extra,
      }).success,
      false,
      JSON.stringify(extra),
    );
  }
});

// =====================================================================
// 3-4. Company resolution
// =====================================================================

test('an unknown but well-formed company fails resolution', async () => {
  const company = await resolveProvisioningCompany('NO_SUCH_COMPANY', stubQuery([[]]));
  assert.equal(company, null);
});

test('a DEACTIVATED company is not a provisioning destination', async () => {
  const captured: Captured[] = [];
  // The query itself excludes retired rows, so a deactivated company
  // returns nothing - fail closed without the caller having to remember.
  const company = await resolveProvisioningCompany('ABB', stubQuery([[]], captured));
  assert.equal(company, null);
  assert.match(captured[0]?.sql ?? '', /deactivated_at IS NULL/);
});

test('the code is BOUND as a parameter, never interpolated', async () => {
  const captured: Captured[] = [];
  await resolveProvisioningCompany("'; DROP TABLE companies; --", stubQuery([[]], captured));
  assert.deepEqual(captured[0]?.params, ["'; DROP TABLE companies; --"]);
  assert.doesNotMatch(captured[0]?.sql ?? '', /DROP TABLE/);
});

// =====================================================================
// 5-9. The destination chain
// =====================================================================

test('an active runtime company with an active assignable team-position SUCCEEDS', async () => {
  const captured: Captured[] = [];
  const result = await resolveProvisioningDestination(
    'ABB',
    VALID_CREATE.teamPositionId,
    stubQuery([[companyRow], assignable], captured),
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.company.code, 'ABB');
  assert.equal(result.ok && result.company.id, ABB);

  // The destination is proved against the RESOLVED company id, not
  // against the client's string.
  assert.deepEqual(captured[1]?.params, [VALID_CREATE.teamPositionId, ABB]);
});

test('the destination statement proves the WHOLE chain in one query', async () => {
  const captured: Captured[] = [];
  await resolveProvisioningDestination('ABB', VALID_CREATE.teamPositionId, stubQuery([[companyRow], assignable], captured));

  const sql = captured[1]?.sql ?? '';
  // Ownership, assignability, and all three active levels.
  assert.match(sql, /JOIN teams t ON t\.id = tp\.team_id/);
  assert.match(sql, /JOIN companies c ON c\.id = t\.company_id/);
  assert.match(sql, /c\.id = \$2/);
  assert.match(sql, /tp\.site_manager_assignable = TRUE/);
  assert.match(sql, /tp\.deactivated_at IS NULL/);
  assert.match(sql, /t\.deactivated_at IS NULL/);
  assert.match(sql, /c\.deactivated_at IS NULL/);
});

test('a team-position belonging to ANOTHER company fails closed', async () => {
  // The company resolves; the join returns nothing because the
  // team-position is not owned by it. This is the case two independent
  // checks would both have passed.
  const result = await resolveProvisioningDestination(
    'ABB',
    VALID_CREATE.teamPositionId,
    stubQuery([[companyRow], []]),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'team_position_not_assignable');
});

test('an INACTIVE team-position, an INACTIVE team and a NON-ASSIGNABLE combination all fail closed', async () => {
  // Each is excluded by the same statement, so each returns no row. The
  // refusal is identical on purpose: a caller learns nothing about
  // structure it did not name.
  for (const _case of ['inactive team-position', 'inactive team', 'not assignable']) {
    const result = await resolveProvisioningDestination(
      'ABB',
      VALID_CREATE.teamPositionId,
      stubQuery([[companyRow], []]),
    );
    assert.equal(result.ok, false, _case);
    assert.equal(result.ok === false && result.reason, 'team_position_not_assignable', _case);
  }
});

test('a missing company short-circuits: the destination is never even queried', async () => {
  const captured: Captured[] = [];
  const result = await resolveProvisioningDestination('GONE', VALID_CREATE.teamPositionId, stubQuery([[]], captured));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'company_not_found');
  assert.equal(captured.length, 1, 'no second query should run');
});

// =====================================================================
// 10. The seeded companies behave exactly as before
// =====================================================================

test('E_SET, ZPL and SGRE resolve and validate exactly as they always did', async () => {
  for (const code of ['E_SET', 'ZPL', 'SGRE']) {
    const row = { id: `id-${code}`, code, name: code };
    const result = await resolveProvisioningDestination(
      code,
      VALID_CREATE.teamPositionId,
      stubQuery([[row], assignable]),
    );
    assert.equal(result.ok, true, code);
    assert.equal(result.ok && result.company.code, code);
  }
});
