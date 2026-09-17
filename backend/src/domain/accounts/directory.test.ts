import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  listEmployees,
  listSiteManagers,
  loadOrganization,
  loadOrganizationAdministration,
} from './directory.js';

/**
 * The read-only administrative directory. What matters here is not
 * formatting but the guarantees: privileged accounts never appear as
 * employees, only operator-approved Team + Position combinations are
 * offered, filters are always BOUND rather than interpolated, and the
 * page and its COUNT are produced by the same predicate.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function stubQuery(responses: QueryResultRow[][], captured: Captured[]) {
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

const EMPLOYEE_ROW = {
  user_id: '10000000-0000-4000-8000-000000000003',
  state: 'ACTIVE' as const,
  must_change_password: false,
  display_name: 'Ali Khan',
  company_code: 'ZPL',
  company_name: 'ZPL',
  team_name: 'ZPL',
  position_name: 'Site Manager',
  team_position_id: '40000000-0000-4000-8000-000000000001',
  view_all_permits: true,
};

test('listEmployees maps rows and the total count', async () => {
  const captured: Captured[] = [];
  const result = await listEmployees(
    stubQuery([[EMPLOYEE_ROW], [{ count: '7' }]], captured),
    {},
    { page: 2, pageSize: 25 },
  );

  assert.deepEqual(result.items, [
    {
      userId: EMPLOYEE_ROW.user_id,
      displayName: 'Ali Khan',
      state: 'ACTIVE',
      mustChangePassword: false,
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'ZPL',
      positionName: 'Site Manager',
      teamPositionId: EMPLOYEE_ROW.team_position_id,
      viewAllPermits: true,
    },
  ]);
  assert.equal(result.totalCount, 7);
  // Page 2 of 25 starts at offset 25 - bound, never interpolated.
  assert.deepEqual(captured[0]?.params.slice(3), [25, 25]);
});

test('listEmployees excludes accounts holding an active privileged grant', async () => {
  const captured: Captured[] = [];
  await listEmployees(stubQuery([[], [{ count: '0' }]], captured), {}, { page: 1, pageSize: 25 });

  for (const { sql } of captured) {
    assert.ok(sql.includes('NOT EXISTS'), 'privileged accounts must be filtered out');
    assert.ok(sql.includes('FROM privileged_access_events'), 'the authoritative grant log must be consulted');
  }
});

test('listEmployees never returns an email or any credential internals', async () => {
  const captured: Captured[] = [];
  const result = await listEmployees(
    stubQuery([[EMPLOYEE_ROW], [{ count: '1' }]], captured),
    {},
    { page: 1, pageSize: 25 },
  );

  const serialized = JSON.stringify(result);
  for (const forbidden of ['email', 'credential_version', 'credentialVersion', 'password', 'reset_pending']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must never be exposed`);
  }
  for (const { sql } of captured) {
    assert.ok(!sql.includes('credential_version'), 'credential internals must not even be selected');
  }
});

test('listEmployees binds every filter rather than interpolating it', async () => {
  const captured: Captured[] = [];
  await listEmployees(
    stubQuery([[], [{ count: '0' }]], captured),
    { search: "'; DROP TABLE permits; --", state: 'DISABLED', companyCode: 'E_SET' },
    { page: 1, pageSize: 10 },
  );

  const [rowsCall, countCall] = captured;
  assert.deepEqual(rowsCall?.params.slice(0, 3), ["%'; DROP TABLE permits; --%", 'DISABLED', 'E_SET']);
  assert.ok(!rowsCall?.sql.includes('DROP TABLE'), 'filter values must never reach the SQL text');
  // The COUNT runs the same predicate with the same values, so the total
  // can never describe a wider set than the page.
  assert.deepEqual(countCall?.params, rowsCall?.params.slice(0, 3));
});

test('listEmployees passes null for absent filters', async () => {
  const captured: Captured[] = [];
  await listEmployees(stubQuery([[], [{ count: '0' }]], captured), { search: '   ' }, { page: 1, pageSize: 10 });
  assert.deepEqual(captured[0]?.params.slice(0, 3), [null, null, null]);
});

test('loadOrganization groups assignable combinations by company and team', async () => {
  const captured: Captured[] = [];
  const companies = await loadOrganization(
    stubQuery(
      [
        [
          { company_code: 'E_SET', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'CRO', team_position_id: 'tp-1' },
          { company_code: 'E_SET', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'Team Lead', team_position_id: 'tp-2' },
          { company_code: 'E_SET', company_name: 'E-SET', team_name: 'HSE', position_name: 'Paramedic', team_position_id: 'tp-3' },
          { company_code: 'ZPL', company_name: 'ZPL', team_name: 'ZPL', position_name: 'Site Manager', team_position_id: 'tp-4' },
        ],
      ],
      captured,
    ),
  );

  assert.deepEqual(companies.map((company) => company.code), ['E_SET', 'ZPL']);
  assert.deepEqual(companies[0]?.teams.map((team) => team.teamName), ['E-BOP', 'HSE']);
  assert.deepEqual(companies[0]?.teams[0]?.positions, [
    { teamPositionId: 'tp-1', positionName: 'CRO' },
    { teamPositionId: 'tp-2', positionName: 'Team Lead' },
  ]);
  assert.ok(captured[0]?.sql.includes('site_manager_assignable = TRUE'), 'only approved combinations may be offered');
});

test('loadOrganization exposes no capability mapping', async () => {
  const captured: Captured[] = [];
  await loadOrganization(stubQuery([[]], captured));
  assert.ok(!captured[0]?.sql.includes('team_position_capabilities'), 'authorization data is not directory data');
});

test('loadOrganization surfaces EVERY company the query returns, not a fixed set of three', async () => {
  // Companies are managed at runtime (migration 0035). A closed allowlist
  // here would silently hide a company an administrator had just
  // created, which is exactly the bug this replaced.
  const companies = await loadOrganization(
    stubQuery(
      [
        [
          { company_code: 'ZPL', company_name: 'ZPL', team_name: 'ZPL', position_name: 'Engineer', team_position_id: 'tp-1' },
          { company_code: 'ABC_CONTRACTORS', company_name: 'ABC Contractors', team_name: 'Electrical', position_name: 'Electrician', team_position_id: 'tp-2' },
        ],
      ],
      [],
    ),
  );
  assert.deepEqual(companies.map((company) => company.code), ['ZPL', 'ABC_CONTRACTORS']);
  assert.deepEqual(companies[1]?.teams[0]?.positions, [
    { teamPositionId: 'tp-2', positionName: 'Electrician' },
  ]);
});

test('loadOrganization offers only structure whose whole chain is active', async () => {
  const captured: Captured[] = [];
  await loadOrganization(stubQuery([[]], captured));
  const sql = captured[0]?.sql ?? '';
  // An association under a retired team or company is exactly what the
  // database refuses to accept a new employee assignment into, so it
  // must not be offered as a choice.
  assert.match(sql, /tp\.deactivated_at IS NULL/);
  assert.match(sql, /t\.deactivated_at IS NULL/);
  assert.match(sql, /c\.deactivated_at IS NULL/);
  assert.match(sql, /tp\.site_manager_assignable = TRUE/);
});

const ADMIN_ROW = {
  company_id: 'c-1', company_code: 'E_SET', company_name: 'E-SET', company_deactivated_at: null,
  team_id: 't-1', team_name: 'E-BOP', team_deactivated_at: null,
  team_position_id: 'tp-1', team_position_deactivated_at: null, site_manager_assignable: true,
  position_id: 'p-1', position_name: 'CRO',
};

test('loadOrganizationAdministration returns the full hierarchy by STABLE ID', async () => {
  const companies = await loadOrganizationAdministration(stubQuery([[ADMIN_ROW]], []));
  const company = companies[0];
  assert.equal(company?.id, 'c-1');
  assert.equal(company?.code, 'E_SET');
  assert.equal(company?.deactivatedAt, null);
  const team = company?.teams[0];
  assert.equal(team?.id, 't-1');
  assert.equal(team?.companyId, 'c-1');
  const position = team?.positions[0];
  assert.equal(position?.teamPositionId, 'tp-1');
  assert.equal(position?.positionId, 'p-1');
  assert.equal(position?.positionName, 'CRO');
  assert.equal(position?.siteManagerAssignable, true);
});

test('loadOrganizationAdministration INCLUDES deactivated rows - an admin must see them to manage them', async () => {
  const companies = await loadOrganizationAdministration(
    stubQuery(
      [[
        { ...ADMIN_ROW, company_deactivated_at: '2026-01-01T00:00:00.000Z',
          team_deactivated_at: '2026-01-02T00:00:00.000Z',
          team_position_deactivated_at: '2026-01-03T00:00:00.000Z' },
      ]],
      [],
    ),
  );
  assert.equal(companies[0]?.deactivatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(companies[0]?.teams[0]?.deactivatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(companies[0]?.teams[0]?.positions[0]?.deactivatedAt, '2026-01-03T00:00:00.000Z');
});

test('a company with no teams, and a team with no positions, are returned as empty - not omitted', async () => {
  const companies = await loadOrganizationAdministration(
    stubQuery(
      [[
        { ...ADMIN_ROW, company_id: 'c-2', company_code: 'ABC_CONTRACTORS', company_name: 'ABC',
          team_id: null, team_name: null, team_deactivated_at: null,
          team_position_id: null, position_id: null, position_name: null,
          team_position_deactivated_at: null, site_manager_assignable: null },
        { ...ADMIN_ROW, company_id: 'c-3', company_code: 'XYZ', company_name: 'XYZ',
          team_id: 't-9', team_name: 'Empty Team',
          team_position_id: null, position_id: null, position_name: null,
          team_position_deactivated_at: null, site_manager_assignable: null },
      ]],
      [],
    ),
  );
  assert.deepEqual(companies[0]?.teams, []);
  assert.equal(companies[1]?.teams[0]?.name, 'Empty Team');
  assert.deepEqual(companies[1]?.teams[0]?.positions, []);
});

test('loadOrganizationAdministration exposes no capability mapping and is a pure SELECT', async () => {
  const captured: Captured[] = [];
  await loadOrganizationAdministration(stubQuery([[]], captured));
  const sql = captured[0]?.sql ?? '';
  assert.ok(!sql.includes('team_position_capabilities'), 'authorization data is not directory data');
  assert.ok(sql.trimStart().startsWith('SELECT'));
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(sql));
});

test('loadOrganizationAdministration is NOT filtered by assignability or by a closed company set', async () => {
  const captured: Captured[] = [];
  await loadOrganizationAdministration(stubQuery([[]], captured));
  const sql = captured[0]?.sql ?? '';
  // The employee-facing reader filters on both; the admin view must not,
  // or management state becomes impossible to understand.
  assert.ok(!sql.includes('site_manager_assignable = TRUE'));
  assert.ok(!sql.includes("code IN ("));
});

test('listSiteManagers reports the current grant state and excludes the CEO tier', async () => {
  const captured: Captured[] = [];
  const siteManagers = await listSiteManagers(
    stubQuery(
      [
        [
          { user_id: 'u-1', display_name: 'Sara Ahmed', active: true, account_state: 'ACTIVE' },
          { user_id: 'u-2', display_name: 'Bilal Raza', active: false, account_state: 'DISABLED' },
        ],
      ],
      captured,
    ),
  );

  assert.deepEqual(siteManagers, [
    { userId: 'u-1', displayName: 'Sara Ahmed', active: true, accountState: 'ACTIVE' },
    { userId: 'u-2', displayName: 'Bilal Raza', active: false, accountState: 'DISABLED' },
  ]);
  const sql = captured[0]?.sql ?? '';
  assert.ok(sql.includes("role = 'CEO'"), 'the CEO tier must be filtered out');
  assert.ok(sql.includes("role = 'SITE_MANAGER'"), 'grant state comes from the SITE_MANAGER role only');
  assert.ok(sql.includes('ORDER BY ordinal DESC'), 'state must come from the LATEST event, never a stale one');
});
