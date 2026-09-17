import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration0037Url = new URL(
  '../../../database/migrations/0037_organization_management_runtime_privileges.sql',
  import.meta.url,
);

/**
 * THE PHASE 2 RUNTIME PRIVILEGE DELTA.
 *
 * 0035 created the organization objects and granted `app_runtime`
 * nothing on them; Phase 2 mounts the routes, so the minimum privileges
 * are granted here. What these specs prove is not that the grants exist
 * - the migration's own self-verification does that - but that the
 * resulting surface is EXACTLY the intended one:
 *
 *   * every privilege the domain code actually needs is present;
 *   * every privilege that would be an escalation is absent, including
 *     rename, re-code, hard delete, and any direct write to capability
 *     data.
 *
 * The bounded SECURITY DEFINER function stays the only path to
 * capability data, which is what stops a runtime-created position named
 * "CRO" from ever being given CRO authority.
 */

/** The organization objects as 0035 leaves them, plus the operator-created runtime role. */
async function withRuntimeRole(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE app_runtime;
    CREATE ROLE anon; CREATE ROLE authenticated;

    CREATE TABLE public.companies (
      id UUID PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
      company_id UUID NOT NULL REFERENCES public.companies (id),
      deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE);
    CREATE TABLE public.team_positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID NOT NULL REFERENCES public.teams (id),
      position_id UUID NOT NULL REFERENCES public.positions (id),
      site_manager_assignable BOOLEAN NOT NULL DEFAULT FALSE,
      deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.capabilities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE);
    CREATE TABLE public.team_position_capabilities (
      team_position_id UUID NOT NULL REFERENCES public.team_positions (id),
      capability_id UUID NOT NULL REFERENCES public.capabilities (id),
      PRIMARY KEY (team_position_id, capability_id));
    CREATE TABLE public.organization_audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ordinal BIGSERIAL NOT NULL,
      event_type TEXT NOT NULL,
      actor_user_id UUID NOT NULL,
      company_id UUID, team_id UUID, position_id UUID, team_position_id UUID,
      previous_name TEXT, new_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE public.privileged_access_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, role TEXT, action TEXT);
    CREATE TABLE public.privileged_identities (
      user_id UUID PRIMARY KEY, display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

    -- The grant-writing function 0019 reserves for privileged_runtime.
    -- Its real signature is (UUID, UUID, TEXT); 0037 reads the signature
    -- from the catalogue rather than assuming it.
    CREATE FUNCTION public.record_site_manager_grant(
      p_actor_user_id UUID, p_target_user_id UUID, p_action TEXT)
    RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    BEGIN RETURN; END; $fn$;
    REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT)
      FROM PUBLIC, anon, authenticated;

    CREATE FUNCTION public.grant_baseline_applicant_capabilities(p_team_position_id UUID)
    RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    BEGIN RETURN; END; $fn$;
    REVOKE ALL ON FUNCTION public.grant_baseline_applicant_capabilities(UUID)
      FROM PUBLIC, anon, authenticated;

    -- The runtime role's REAL pre-Phase-2 surface, as observed in
    -- production during the 0037 preflight.
    GRANT SELECT ON public.companies, public.teams, public.positions,
                    public.team_positions, public.team_position_capabilities,
                    public.capabilities, public.privileged_access_events TO app_runtime;

    -- privileged_identities carries SELECT *and* INSERT. That is not
    -- drift: DEPLOYMENT.md records it as the applied 0019 delta, and
    -- the CEO-only Site Manager creation endpoint writes this row on
    -- the ordinary connection. Modelling it SELECT-only is what made
    -- an earlier version of this fixture disagree with production.
    GRANT SELECT, INSERT ON public.privileged_identities TO app_runtime;
  `);
  return db;
}

async function applied(): Promise<PGlite> {
  const db = await withRuntimeRole();
  await db.exec(await readFile(migration0037Url, 'utf8'));
  return db;
}

async function tablePriv(db: PGlite, table: string, priv: string): Promise<boolean> {
  const row = await db.query<{ ok: boolean }>(
    `SELECT has_table_privilege('app_runtime', 'public.${table}', '${priv}') AS ok`,
  );
  return row.rows[0]!.ok;
}

async function columnPriv(db: PGlite, table: string, column: string, priv: string): Promise<boolean> {
  const row = await db.query<{ ok: boolean }>(
    `SELECT has_column_privilege('app_runtime', 'public.${table}', '${column}', '${priv}') AS ok`,
  );
  return row.rows[0]!.ok;
}

// =====================================================================
// The required surface
// =====================================================================

test('the migration applies and its self-verification passes', async () => {
  const db = await applied();
  assert.equal(await tablePriv(db, 'companies', 'INSERT'), true);
});

test('every privilege the Phase 2 domain code needs is granted', async () => {
  const db = await applied();
  assert.equal(await tablePriv(db, 'companies', 'INSERT'), true, 'createCompany');
  assert.equal(await tablePriv(db, 'teams', 'INSERT'), true, 'createTeam');
  assert.equal(await tablePriv(db, 'positions', 'INSERT'), true, 'createTeamPosition mints a global position');
  assert.equal(await tablePriv(db, 'team_positions', 'INSERT'), true, 'createTeamPosition');
  assert.equal(await tablePriv(db, 'organization_audit_events', 'INSERT'), true, 'recordOrganizationAuditEvent');

  assert.equal(await columnPriv(db, 'companies', 'deactivated_at', 'UPDATE'), true);
  assert.equal(await columnPriv(db, 'teams', 'deactivated_at', 'UPDATE'), true);
  assert.equal(await columnPriv(db, 'team_positions', 'deactivated_at', 'UPDATE'), true);

  const fn = await db.query<{ ok: boolean }>(
    `SELECT has_function_privilege('app_runtime',
       'public.grant_baseline_applicant_capabilities(uuid)', 'EXECUTE') AS ok`,
  );
  assert.equal(fn.rows[0]?.ok, true, 'the bounded baseline grant must be callable');

  const seq = await db.query<{ ok: boolean }>(
    `SELECT has_sequence_privilege('app_runtime',
       'public.organization_audit_events_ordinal_seq', 'USAGE') AS ok`,
  );
  assert.equal(seq.rows[0]?.ok, true, 'the audit ordinal sequence must be usable');
});

// =====================================================================
// The forbidden surface
// =====================================================================

test('NO rename privilege is granted - there is no rename endpoint in this phase', async () => {
  const db = await applied();
  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), false);
  assert.equal(await columnPriv(db, 'teams', 'name', 'UPDATE'), false);
});

test('a company code or id can never be rewritten by the runtime role', async () => {
  const db = await applied();
  assert.equal(await columnPriv(db, 'companies', 'code', 'UPDATE'), false);
  assert.equal(await columnPriv(db, 'companies', 'id', 'UPDATE'), false);
});

test('capability data cannot be written directly - the bounded function is the only path', async () => {
  const db = await applied();
  // This is the privilege that would let a runtime-created position
  // named "CRO" be given real CRO authority. It must not exist.
  assert.equal(await tablePriv(db, 'team_position_capabilities', 'INSERT'), false);
  assert.equal(await tablePriv(db, 'team_position_capabilities', 'UPDATE'), false);
  assert.equal(await tablePriv(db, 'team_position_capabilities', 'DELETE'), false);
});

test('no hard delete or truncate is granted on any organization table', async () => {
  const db = await applied();
  for (const table of ['companies', 'teams', 'positions', 'team_positions',
    'team_position_capabilities', 'organization_audit_events']) {
    assert.equal(await tablePriv(db, table, 'DELETE'), false, `${table} DELETE`);
    assert.equal(await tablePriv(db, table, 'TRUNCATE'), false, `${table} TRUNCATE`);
  }
});

test('the organization audit stays append-only for the runtime role', async () => {
  const db = await applied();
  assert.equal(await tablePriv(db, 'organization_audit_events', 'INSERT'), true);
  assert.equal(await tablePriv(db, 'organization_audit_events', 'UPDATE'), false);
  assert.equal(await tablePriv(db, 'organization_audit_events', 'DELETE'), false);
});

test('positions gets INSERT only - it has no lifecycle column to update', async () => {
  const db = await applied();
  assert.equal(await tablePriv(db, 'positions', 'INSERT'), true);
  assert.equal(await tablePriv(db, 'positions', 'UPDATE'), false);
});

test('privileged authority remains completely out of reach', async () => {
  const db = await applied();
  assert.equal(await tablePriv(db, 'privileged_access_events', 'INSERT'), false);
  assert.equal(await tablePriv(db, 'privileged_access_events', 'UPDATE'), false);
});

// =====================================================================
// Correcting an over-broad environment
// =====================================================================

test('an over-broad grant applied by hand is CORRECTED by this migration', async () => {
  const db = await withRuntimeRole();
  // Simulate an environment where someone granted too much.
  await db.exec(`
    GRANT UPDATE ON public.companies TO app_runtime;
    GRANT UPDATE ON public.teams TO app_runtime;
    GRANT INSERT, UPDATE, DELETE ON public.team_position_capabilities TO app_runtime;
    GRANT DELETE ON public.team_positions TO app_runtime;
  `);
  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), true, 'setup');

  await db.exec(await readFile(migration0037Url, 'utf8'));

  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), false);
  assert.equal(await columnPriv(db, 'teams', 'name', 'UPDATE'), false);
  assert.equal(await tablePriv(db, 'team_position_capabilities', 'INSERT'), false);
  assert.equal(await tablePriv(db, 'team_positions', 'DELETE'), false);
  // ...while the legitimate privileges are still in place.
  assert.equal(await columnPriv(db, 'companies', 'deactivated_at', 'UPDATE'), true);
});

test('the migration is idempotent', async () => {
  const db = await applied();
  await db.exec(await readFile(migration0037Url, 'utf8'));
  assert.equal(await tablePriv(db, 'companies', 'INSERT'), true);
  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), false);
});

// =====================================================================
// Portability and scope
// =====================================================================

test('a database with no app_runtime role is skipped, not failed', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.companies (id UUID PRIMARY KEY, name TEXT, deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.teams (id UUID PRIMARY KEY, name TEXT, deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.positions (id UUID PRIMARY KEY, name TEXT);
    CREATE TABLE public.team_positions (id UUID PRIMARY KEY, deactivated_at TIMESTAMPTZ);
    CREATE TABLE public.team_position_capabilities (team_position_id UUID, capability_id UUID);
    CREATE TABLE public.organization_audit_events (id UUID PRIMARY KEY, ordinal BIGSERIAL);
    CREATE TABLE public.privileged_access_events (id UUID PRIMARY KEY);
    CREATE FUNCTION public.grant_baseline_applicant_capabilities(p UUID)
      RETURNS VOID LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END; $fn$;
  `);
  // Must not throw: local and CI databases have no operator-created role.
  await db.exec(await readFile(migration0037Url, 'utf8'));
});

test('0037 changes no schema and no data - it adjusts privileges only', async () => {
  const sql = await readFile(migration0037Url, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  for (const forbidden of [/CREATE\s+TABLE/i, /ALTER\s+TABLE/i, /CREATE\s+TRIGGER/i,
    /CREATE\s+POLICY/i, /INSERT\s+INTO/i, /\bDELETE\s+FROM\b/i, /\bDROP\b/i]) {
    assert.ok(!forbidden.test(statements), `0037 contains a forbidden statement: ${forbidden}`);
  }
  // The only CREATE FUNCTION in the file would be a new capability path.
  assert.ok(!/CREATE\s+(OR REPLACE\s+)?FUNCTION/i.test(statements));
});

test('0037 grants nothing beyond the ten intended privileges', async () => {
  const sql = await readFile(migration0037Url, 'utf8');
  const grants = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .filter((line) => /EXECUTE 'GRANT/i.test(line))
    .map((line) => line.trim());

  assert.equal(grants.length, 10, `expected exactly 10 grants, found ${grants.length}`);
  for (const grant of grants) {
    assert.ok(grant.includes('TO app_runtime'), `a grant targets an unexpected role: ${grant}`);
  }
  // And none of them is a rename, a delete, or a capability write.
  const joined = grants.join('\n');
  assert.ok(!/UPDATE \(name/i.test(joined));
  assert.ok(!/\bDELETE\b/i.test(joined));
  assert.ok(!/team_position_capabilities/i.test(joined));
});

test('migrations 0035 and 0036 are untouched by this phase', async () => {
  // 0035 and 0036 are live applied history. A future edit that made the
  // repository disagree with the database would fail here.
  const m35 = await readFile(
    new URL('../../../database/migrations/0035_dynamic_organization_management.sql', import.meta.url),
    'utf8',
  );
  const m36 = await readFile(
    new URL('../../../database/migrations/0036_permit_applicant_company_contract.sql', import.meta.url),
    'utf8',
  );
  assert.ok(m35.includes('THIS IS THE **EXPAND** MIGRATION'));
  assert.ok(m36.includes('ROLLBACK IS CLOSED AFTER THIS MIGRATION'));
  // Neither may contain the Phase 2 grants: that is this file's job.
  assert.ok(!/^\s*GRANT/m.test(m35), '0035 must not grant anything');
  assert.ok(!/^\s*GRANT/m.test(m36), '0036 must not grant anything');
});

// =====================================================================
// The EFFECTIVE surface, column by column
//
// `has_table_privilege(..., 'UPDATE')` is FALSE when only a column-level
// grant exists, so a table-level check alone would miss
// `GRANT UPDATE (name) ON companies`. These specs enumerate the real
// columns and assert per column, which is what the migration now does
// too.
// =====================================================================

async function columnsOf(db: PGlite, table: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY column_name`,
  );
  return rows.rows.map((row) => row.column_name);
}

/** Every column of `table` that app_runtime may effectively UPDATE. */
async function updatableColumns(db: PGlite, table: string): Promise<string[]> {
  const columns = await columnsOf(db, table);
  const updatable: string[] = [];
  for (const column of columns) {
    if (await columnPriv(db, table, column, 'UPDATE')) updatable.push(column);
  }
  return updatable;
}

test('the UPDATE surface on companies is EXACTLY deactivated_at', async () => {
  const db = await applied();
  const columns = await columnsOf(db, 'companies');
  // Guard the guard: if the fixture lost a column the assertion below
  // would pass vacuously.
  assert.ok(columns.includes('id') && columns.includes('code') && columns.includes('name'));
  assert.deepEqual(await updatableColumns(db, 'companies'), ['deactivated_at']);
});

test('the UPDATE surface on teams is EXACTLY deactivated_at', async () => {
  const db = await applied();
  const columns = await columnsOf(db, 'teams');
  assert.ok(columns.includes('id') && columns.includes('company_id') && columns.includes('name'));
  assert.deepEqual(await updatableColumns(db, 'teams'), ['deactivated_at']);
});

test('the UPDATE surface on team_positions is EXACTLY deactivated_at', async () => {
  const db = await applied();
  const columns = await columnsOf(db, 'team_positions');
  assert.ok(
    columns.includes('id') && columns.includes('team_id') &&
    columns.includes('position_id') && columns.includes('site_manager_assignable'),
  );
  // site_manager_assignable in particular: a runtime-writable flag here
  // would let an existing association be flipped, which the design
  // forbids - it is set on INSERT of a new row only.
  assert.deepEqual(await updatableColumns(db, 'team_positions'), ['deactivated_at']);
});

test('positions has NO updatable column at all', async () => {
  const db = await applied();
  assert.ok((await columnsOf(db, 'positions')).includes('name'));
  assert.deepEqual(await updatableColumns(db, 'positions'), []);
});

test('the organization audit has no updatable column - it is append-only', async () => {
  const db = await applied();
  assert.deepEqual(await updatableColumns(db, 'organization_audit_events'), []);
});

test('team_position_capabilities has no updatable column either', async () => {
  const db = await applied();
  assert.deepEqual(await updatableColumns(db, 'team_position_capabilities'), []);
});

test('a COLUMN-LEVEL rename grant is caught, where a table-level check would miss it', async () => {
  const db = await withRuntimeRole();
  await db.exec(`GRANT UPDATE (name) ON public.companies TO app_runtime;`);

  // This is the gap: the table-level question says "no UPDATE" while the
  // role can in fact rewrite the company name.
  assert.equal(await tablePriv(db, 'companies', 'UPDATE'), false, 'table-level check is blind here');
  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), true, 'but the column IS writable');

  await db.exec(await readFile(migration0037Url, 'utf8'));

  assert.deepEqual(await updatableColumns(db, 'companies'), ['deactivated_at']);
});

test('a column-level grant on site_manager_assignable is revoked', async () => {
  const db = await withRuntimeRole();
  await db.exec(`GRANT UPDATE (site_manager_assignable) ON public.team_positions TO app_runtime;`);
  await db.exec(await readFile(migration0037Url, 'utf8'));
  assert.deepEqual(await updatableColumns(db, 'team_positions'), ['deactivated_at']);
});

// =====================================================================
// The privileged authority channel
// =====================================================================

test('app_runtime has NO mutation path to the privileged AUTHORITY LOG', async () => {
  const db = await applied();
  // privileged_access_events is authority itself: no write of any
  // kind. Grants travel over the separate privileged_runtime login.
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal(await tablePriv(db, 'privileged_access_events', priv), false, priv);
  }
  assert.deepEqual(await updatableColumns(db, 'privileged_access_events'), []);
});

test('privileged_identities keeps SELECT and INSERT, and loses UPDATE/DELETE/TRUNCATE', async () => {
  const db = await applied();
  // INSERT is the DOCUMENTED 0019 contract - the CEO-only
  // `POST /admin/site-managers` endpoint creates this row on the
  // ordinary connection. Revoking it would break Site Manager
  // creation with 42501.
  assert.equal(await tablePriv(db, 'privileged_identities', 'SELECT'), true);
  assert.equal(await tablePriv(db, 'privileged_identities', 'INSERT'), true,
    'Site Manager creation depends on this INSERT');

  // Rewriting or removing an EXISTING privileged identity is what must
  // never be possible from the ordinary login.
  for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal(await tablePriv(db, 'privileged_identities', priv), false, priv);
  }
  assert.deepEqual(await updatableColumns(db, 'privileged_identities'), []);
});

test('a stale UPDATE/DELETE grant on privileged_identities is REPAIRED, INSERT is not', async () => {
  const db = await withRuntimeRole();
  await db.exec(`GRANT UPDATE, DELETE ON public.privileged_identities TO app_runtime;`);
  assert.equal(await tablePriv(db, 'privileged_identities', 'UPDATE'), true, 'setup');

  await db.exec(await readFile(migration0037Url, 'utf8'));

  assert.equal(await tablePriv(db, 'privileged_identities', 'UPDATE'), false);
  assert.equal(await tablePriv(db, 'privileged_identities', 'DELETE'), false);
  assert.equal(await tablePriv(db, 'privileged_identities', 'INSERT'), true,
    'the documented INSERT must survive the repair');
  assert.equal(await tablePriv(db, 'privileged_identities', 'SELECT'), true);
});

test('a stale mutation grant on the AUTHORITY LOG is repaired', async () => {
  const db = await withRuntimeRole();
  await db.exec(`GRANT INSERT, UPDATE ON public.privileged_access_events TO app_runtime;`);
  await db.exec(await readFile(migration0037Url, 'utf8'));
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal(await tablePriv(db, 'privileged_access_events', priv), false, priv);
  }
  assert.equal(await tablePriv(db, 'privileged_access_events', 'SELECT'), true,
    'authorization resolution must keep reading the log');
});

test('the SELECT that resolvePrivilegedAccess() depends on is NOT revoked', async () => {
  const db = await applied();
  // Authority is resolved by reading privileged_access_events on every
  // authorized request. Breaking this read would break every admin
  // endpoint in the application, so it must survive the hardening.
  assert.equal(await tablePriv(db, 'privileged_access_events', 'SELECT'), true);
  assert.equal(await tablePriv(db, 'privileged_identities', 'SELECT'), true);
});

test('app_runtime cannot EXECUTE record_site_manager_grant', async () => {
  const db = await applied();
  const row = await db.query<{ ok: boolean }>(
    `SELECT has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS ok
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_site_manager_grant'`,
  );
  assert.equal(row.rows[0]?.ok, false, 'privileged grants belong to privileged_runtime alone');
});

test('the reads the organization directory depends on are NOT revoked', async () => {
  const db = await applied();
  for (const table of ['companies', 'teams', 'positions', 'team_positions',
    'team_position_capabilities', 'capabilities']) {
    assert.equal(await tablePriv(db, table, 'SELECT'), true, `${table} SELECT`);
  }
});

// =====================================================================
// Inherited privilege: fails closed rather than silently repairing
// =====================================================================

test('an INHERITED forbidden privilege makes the migration FAIL, not silently pass', async () => {
  const db = await withRuntimeRole();
  // A privilege reaching app_runtime through role membership cannot be
  // removed by REVOKE ... FROM app_runtime, and this migration
  // deliberately does not touch role memberships. It must therefore
  // refuse rather than record a surface it did not achieve.
  await db.exec(`
    CREATE ROLE legacy_writer;
    GRANT UPDATE ON public.companies TO legacy_writer;
    GRANT legacy_writer TO app_runtime;
  `);
  assert.equal(await columnPriv(db, 'companies', 'name', 'UPDATE'), true, 'setup: inherited');

  const sql = await readFile(migration0037Url, 'utf8');
  await assert.rejects(
    () => db.exec(sql),
    /effective UPDATE privilege on companies/,
    'an inherited privilege must fail the migration',
  );
});
