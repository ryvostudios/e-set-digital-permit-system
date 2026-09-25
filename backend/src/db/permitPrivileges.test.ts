import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { historicalDatabase, installedDatabase } from '../test/permitSchemaFixtures.js';
import {
  createDraftPermit,
  forwardToHseReview,
  getPermitLifecycleEvents,
  holdPermit,
  hseApprove,
  resumePermit,
  closePermit,
  submitPermit,
  updateDraftPermit,
  updateLinkedJsa,
  type PermitsServiceDeps,
} from '../domain/permits/service.js';
import { answeredJsaV2, answeredWtgPermitV2 } from '../test/v2Forms.js';

/**
 * NO BYPASSRLS, AND NOTHING LOST FOR IT.
 *
 * The standalone runtime login bypassed row security. In the shared
 * database `permit_runtime` cannot, so it holds an explicit privilege set
 * plus one pass-through policy per table. These specs pin that set
 * EXACTLY (so it can only change deliberately), prove every privilege the
 * historical migrations granted survives, prove every privilege
 * DEPLOYMENT.md forbids is refused by the database, and drive the real
 * permit lifecycle through the real service code AS permit_runtime.
 */

// The complete permit_runtime surface (database/baseline/0038_permit_privileges.sql).
const RUNTIME_TABLES: Record<string, string[]> = {
  account_audit_events: ['INSERT', 'SELECT'],
  app_user_access: ['INSERT', 'SELECT', 'UPDATE'],
  capabilities: ['SELECT'],
  cms_audit_events: ['SELECT'],
  cms_logo_assets: ['INSERT', 'SELECT'],
  cms_settings: ['SELECT'],
  companies: ['INSERT', 'SELECT'],
  file_registry: ['INSERT', 'SELECT'],
  issued_document_snapshot_integrity: ['INSERT', 'SELECT'],
  issued_document_snapshots: ['INSERT', 'SELECT'],
  jsas: ['INSERT', 'SELECT'],
  notifications: ['INSERT', 'SELECT'],
  organization_audit_events: ['INSERT'],
  permit_document_jobs: ['INSERT', 'SELECT'],
  permit_lifecycle_events: ['INSERT', 'SELECT'],
  permit_number_counters: ['SELECT'],
  permit_signatures: ['INSERT', 'SELECT'],
  permits: ['INSERT', 'SELECT', 'UPDATE'],
  positions: ['INSERT', 'SELECT'],
  privileged_access_events: ['SELECT'],
  privileged_identities: ['INSERT', 'SELECT'],
  storage_audit_events: ['SELECT'],
  storage_connections: ['INSERT', 'SELECT', 'UPDATE'],
  storage_oauth_states: ['DELETE', 'INSERT', 'SELECT'],
  storage_selection: ['SELECT', 'UPDATE'],
  team_position_capabilities: ['SELECT'],
  team_positions: ['INSERT', 'SELECT'],
  teams: ['INSERT', 'SELECT'],
  user_capability_grants: ['INSERT', 'SELECT'],
  user_sessions: ['SELECT'],
  user_team_positions: ['INSERT', 'SELECT'],
  whatsapp_outbox_messages: ['INSERT', 'SELECT'],
  workforce_profiles: ['INSERT', 'SELECT'],
};
const RUNTIME_COLUMN_UPDATES: Record<string, string[]> = {
  companies: ['deactivated_at'],
  cms_logo_assets: ['active', 'applicable_document_types', 'display_order'],
  cms_settings: ['organization_name', 'pwa_icon_asset_id', 'revision', 'sign_in_notice', 'updated_at', 'updated_by', 'web_logo_asset_id'],
  file_registry: ['remote_id', 'state'],
  jsas: ['form_payload', 'form_version', 'job_description', 'site_or_wtg'],
  notifications: ['read_at'],
  permit_document_jobs: ['attempt_count', 'claim_token', 'claimed_at', 'expected_file_hash', 'file_hash',
    'generated_at', 'last_error', 'next_attempt_at', 'renderer_version', 'status', 'storage_path', 'updated_at'],
  permit_number_counters: ['next_value', 'updated_at'],
  team_positions: ['deactivated_at'],
  teams: ['deactivated_at'],
  user_sessions: ['revoked_at'],
  user_team_positions: ['ended_at'],
  users: ['email', 'password_hash', 'password_scheme', 'updated_at'],
  whatsapp_outbox_messages: ['attempt_count', 'claim_token', 'claimed_at', 'last_attempted_at', 'last_error',
    'next_attempt_at', 'sent_at', 'status'],
  workforce_profiles: ['company_id', 'display_name', 'primary_team_position_id'],
};
// Column-level SELECT/INSERT exist only on the 0039 authentication tables.
const RUNTIME_COLUMN_SELECTS: Record<string, string[]> = {
  users: ['email', 'id', 'password_hash', 'password_scheme'],
};
const RUNTIME_COLUMN_INSERTS: Record<string, string[]> = {
  user_sessions: ['expires_at', 'token_hash', 'user_id'],
  cms_audit_events: ['actor_user_id', 'asset_id', 'detail', 'event_type'],
  storage_audit_events: ['actor_user_id', 'connection_id', 'event_type'],
  users: ['email', 'password_hash', 'password_scheme'],
};
const RUNTIME_SEQUENCES = ['account_audit_events_ordinal_seq', 'jsa_number_seq', 'organization_audit_events_ordinal_seq',
  'permit_lifecycle_events_ordinal_seq', 'permit_number_seq', 'user_capability_grants_ordinal_seq'];
const RUNTIME_FUNCTIONS = ['allocate_permit_sequence', 'grant_baseline_applicant_capabilities',
  'organization_required_coverage_gap'];

let db: PGlite;

before(async () => {
  db = await installedDatabase();
});

after(async () => {
  await db.close();
});

async function grants(target: PGlite, schema: string, role: string) {
  const tables = await target.query<{ relname: string; privs: string[] }>(`
    SELECT c.relname, array_agg(a.privilege_type ORDER BY a.privilege_type) AS privs
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND a.grantee = $2::regrole
     GROUP BY 1 ORDER BY 1`, [schema, role]);
  const columnPrivilege = async (privilege: string) => Object.fromEntries((await target.query<{ relname: string; cols: string[] }>(`
    SELECT c.relname, array_agg(att.attname::text ORDER BY att.attname) AS cols
      FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid, aclexplode(att.attacl) a
     WHERE c.relnamespace = $1::regnamespace AND a.grantee = $2::regrole AND a.privilege_type = $3
     GROUP BY 1 ORDER BY 1`, [schema, role, privilege])).rows.map((r) => [r.relname, r.cols]));
  const sequences = await target.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'S' AND a.grantee = $2::regrole
       AND a.privilege_type = 'USAGE' ORDER BY 1`, [schema, role]);
  const functions = await target.query<{ proname: string }>(`
    SELECT p.proname FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.pronamespace = $1::regnamespace AND a.grantee = $2::regrole ORDER BY 1`, [schema, role]);
  return {
    tables: Object.fromEntries(tables.rows.map((r) => [r.relname, r.privs])),
    columns: await columnPrivilege('UPDATE'),
    columnSelects: await columnPrivilege('SELECT'),
    columnInserts: await columnPrivilege('INSERT'),
    sequences: sequences.rows.map((r) => r.relname),
    functions: functions.rows.map((r) => r.proname),
  };
}

/**
 * Runs `sql` as `role`; returns the SQLSTATE if refused, null if it
 * succeeded. The role switch is verified first, so a refusal is always the
 * statement's own and never a failed SET ROLE.
 */
async function attempt(role: string, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}; SET LOCAL search_path = pg_catalog, permit, pg_temp;`);
    const who = await db.query<{ user: string }>('SELECT current_user AS user');
    assert.equal(who.rows[0]!.user, role, 'the attempt must run as the role under test');
    try {
      await db.query(sql, params);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    }
  } finally {
    await db.exec('ROLLBACK');
  }
}

test('permit_runtime holds exactly the reviewed privilege set', async () => {
  const actual = await grants(db, 'permit', 'permit_runtime');
  assert.deepEqual(actual.tables, RUNTIME_TABLES);
  assert.deepEqual(actual.columns, RUNTIME_COLUMN_UPDATES);
  assert.deepEqual(actual.columnSelects, RUNTIME_COLUMN_SELECTS);
  assert.deepEqual(actual.columnInserts, RUNTIME_COLUMN_INSERTS);
  assert.deepEqual(actual.sequences, RUNTIME_SEQUENCES);
  assert.deepEqual(actual.functions, RUNTIME_FUNCTIONS);
});

test('every runtime privilege the historical migrations granted survives on permit_runtime', async () => {
  const historical = await historicalDatabase();
  try {
    const before = await grants(historical, 'public', 'app_runtime');
    const now = await grants(db, 'permit', 'permit_runtime');
    for (const [table, privs] of Object.entries(before.tables)) {
      for (const priv of privs) assert.ok(now.tables[table]?.includes(priv), `lost ${priv} on ${table}`);
    }
    for (const [table, cols] of Object.entries(before.columns)) {
      for (const col of cols) assert.ok(now.columns[table]?.includes(col), `lost UPDATE (${col}) on ${table}`);
    }
    for (const seq of before.sequences) assert.ok(now.sequences.includes(seq), `lost USAGE on ${seq}`);
    for (const fn of before.functions) assert.ok(now.functions.includes(fn), `lost EXECUTE on ${fn}`);
  } finally {
    await historical.close();
  }
});

test('no Permit role has BYPASSRLS or any elevated attribute, and none inherits another role', async () => {
  const roles = await db.query<{ rolname: string; unsafe: boolean; members: number }>(`
    SELECT r.rolname,
           r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolinherit AS unsafe,
           (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS members
      FROM pg_roles r WHERE r.rolname LIKE 'permit\\_%' ORDER BY 1`);
  assert.deepEqual(roles.rows, [
    { rolname: 'permit_migrator', unsafe: false, members: 0 },
    { rolname: 'permit_privileged', unsafe: false, members: 0 },
    { rolname: 'permit_runtime', unsafe: false, members: 0 },
  ]);
});

test('the privileges DEPLOYMENT.md forbids are refused by the database, not just absent from a list', async () => {
  const refused = [
    ['INSERT privileged authority', `INSERT INTO permit.privileged_access_events (user_id, role, action) VALUES (gen_random_uuid(), 'CEO', 'GRANTED')`],
    ['draw the grant-log sequence', `SELECT nextval('permit.privileged_access_events_ordinal_seq')`],
    ['call the privileged grant function', `SELECT permit.record_site_manager_grant(gen_random_uuid(), gen_random_uuid(), 'GRANTED')`],
    ['read CEO bootstrap state', 'SELECT * FROM permit.initial_ceo_bootstrap'],
    ['read the migration ledger', 'SELECT * FROM permit.schema_migrations'],
    ['write capability data directly', `INSERT INTO permit.team_position_capabilities SELECT id, id FROM permit.team_positions LIMIT 0`],
    ['rename a company', `UPDATE permit.companies SET name = 'x'`],
    ['re-code a company', `UPDATE permit.companies SET code = 'x'`],
    ['rename a position', `UPDATE permit.positions SET name = 'x'`],
    ['rewrite a JSA identity', 'UPDATE permit.jsas SET created_by = created_by'],
    ['re-key a workforce profile', 'UPDATE permit.workforce_profiles SET user_id = user_id'],
    ['delete a permit', 'DELETE FROM permit.permits'],
    ['truncate the audit log', 'TRUNCATE permit.account_audit_events'],
    ['create a table', 'CREATE TABLE permit.intruder (id int)'],
    ['create in public', 'CREATE TABLE public.intruder (id int)'],
    ['re-key a user', 'UPDATE permit.users SET id = id'],
    ['delete a user', 'DELETE FROM permit.users'],
    ['forge a session owner', 'UPDATE permit.user_sessions SET user_id = user_id'],
    ['extend a session', 'UPDATE permit.user_sessions SET expires_at = expires_at'],
    ['delete a session', 'DELETE FROM permit.user_sessions'],
  ] as const;
  for (const [label, sql] of refused) {
    assert.equal(await attempt('permit_runtime', sql), '42501', `permit_runtime must not ${label}`);
  }
});

test('permit_privileged can only call the two approved privileged operations', async () => {
  const actual = await grants(db, 'permit', 'permit_privileged');
  assert.deepEqual(actual, {
    tables: {}, columns: {}, columnSelects: {}, columnInserts: {}, sequences: [], functions: ['provision_site_manager', 'record_site_manager_grant'],
  });
  for (const sql of ['SELECT * FROM permit.permits', 'SELECT * FROM permit.privileged_access_events',
    `INSERT INTO permit.privileged_access_events (user_id, role, action) VALUES (gen_random_uuid(), 'CEO', 'GRANTED')`,
    'SELECT permit.grant_baseline_applicant_capabilities(gen_random_uuid())', 'CREATE TABLE permit.intruder (id int)',
    'SELECT password_hash FROM permit.users', 'SELECT token_hash FROM permit.user_sessions']) {
    assert.equal(await attempt('permit_privileged', sql), '42501', sql);
  }
  // The function itself is reachable: it runs and applies its own CEO check.
  const code = await attempt('permit_privileged',
    `SELECT permit.record_site_manager_grant(gen_random_uuid(), gen_random_uuid(), 'GRANTED')`);
  assert.equal(code, '42501', 'the callable function must reject an invalid session');
});

test('PUBLIC and the Supabase browser roles cannot reach schema permit at all', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await attempt(role, 'SELECT count(*) FROM permit.permits'), '42501', role);
    assert.equal(await attempt(role, 'SELECT password_hash FROM permit.users'), '42501', role);
    assert.equal(await attempt(role, 'SELECT permit.allocate_permit_sequence($1)', ['WTG_WORK']), '42501', role);
  }
});

test('Permit and ESDMS runtime roles cannot cross their schema boundary', async () => {
  // A disposable representative ESDMS object proves both directions with
  // real PostgreSQL privilege checks after the final 0039 schema is installed.
  await db.exec(`
    CREATE ROLE esdms_runtime NOLOGIN NOBYPASSRLS NOINHERIT;
    CREATE TABLE public.esdms_isolation_probe (id integer PRIMARY KEY);
    REVOKE ALL ON public.esdms_isolation_probe FROM PUBLIC;
    GRANT SELECT ON public.esdms_isolation_probe TO esdms_runtime;
  `);
  for (const role of ['permit_runtime', 'permit_privileged']) {
    assert.equal(await attempt(role, 'SELECT * FROM public.esdms_isolation_probe'), '42501', role);
  }
  assert.equal(await attempt('esdms_runtime', 'SELECT * FROM permit.users'), '42501');
  assert.equal(await attempt('esdms_runtime',
    `SELECT permit.provision_site_manager(gen_random_uuid(), 'x@example.test', 'x', 'x')`), '42501');

  const misplaced = await db.query<{ name: string }>(`
    SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'permit_migrator'
    UNION ALL
    SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = 'permit_migrator'`);
  assert.deepEqual(misplaced.rows, [], 'the Permit migrator owns no public objects');
});

// ---------------------------------------------------------------------
// The real lifecycle, as permit_runtime, under row security
// ---------------------------------------------------------------------

const APPLICANT = '51000000-0000-4000-8000-000000000001';
const CRO = '51000000-0000-4000-8000-000000000002';
const HSE = '51000000-0000-4000-8000-000000000003';

async function assign(user: string, name: string, team: string, position: string): Promise<void> {
  await db.query(`INSERT INTO permit.users (id, email) VALUES ($1, $2)`, [user, `${user}@example.test`]);
  await db.query(`
    INSERT INTO permit.user_team_positions (user_id, team_position_id)
    SELECT $1, tp.id FROM permit.team_positions tp
      JOIN permit.teams t ON t.id = tp.team_id JOIN permit.companies c ON c.id = t.company_id
      JOIN permit.positions p ON p.id = tp.position_id
     WHERE c.code = 'E_SET' AND t.name = $2 AND p.name = $3`, [user, team, position]);
  await db.query(`
    INSERT INTO permit.workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
    SELECT $1, $2, utp.team_position_id, t.company_id FROM permit.user_team_positions utp
      JOIN permit.team_positions tp ON tp.id = utp.team_position_id JOIN permit.teams t ON t.id = tp.team_id
     WHERE utp.user_id = $1`, [user, name]);
}

function runtimeDeps(): PermitsServiceDeps {
  return {
    query: ((text: string, params?: unknown[]) => db.query(text, params)) as PermitsServiceDeps['query'],
    withTransaction: (async <T>(work: (client: PoolClient) => Promise<T>) => db.transaction(
      async (tx) => work({ query: tx.query.bind(tx) } as unknown as PoolClient),
    )) as PermitsServiceDeps['withTransaction'],
  };
}

test('the permit lifecycle runs end to end as permit_runtime with no BYPASSRLS', async () => {
  await assign(APPLICANT, 'Applicant One', 'WTG', 'Technician');
  await assign(CRO, 'Control Room', 'E-BOP', 'CRO');
  await assign(HSE, 'Safety Lead', 'HSE', 'Team Lead');

  await db.exec('SET ROLE permit_runtime; SET search_path = pg_catalog, permit, pg_temp;');
  try {
    assert.equal((await db.query<{ user: string }>('SELECT current_user AS user')).rows[0]!.user, 'permit_runtime');
    const deps = runtimeDeps();
    const { permit } = await createDraftPermit(APPLICANT, 'Asia/Karachi', 'WTG_WORK', deps);
    assert.equal(permit.status, 'DRAFT');

    const drafted = await updateDraftPermit(APPLICANT, permit.id, {
      expectedVersion: permit.version, form: answeredWtgPermitV2(),
    }, deps);
    assert.equal(drafted.outcome, 'ok', JSON.stringify(drafted));
    const withJsa = await updateLinkedJsa(APPLICANT, permit.id, {
      expectedVersion: (drafted as { permit: { version: number } }).permit.version, form: answeredJsaV2(),
    }, deps);
    assert.equal(withJsa.outcome, 'ok', JSON.stringify(withJsa));

    const submitted = await submitPermit(APPLICANT, permit.id, {
      expectedVersion: (withJsa as { permit: { version: number } }).permit.version,
    }, deps);
    assert.equal(submitted.outcome, 'ok', JSON.stringify(submitted));
    const numbered = (submitted as { permit: { status: string; permit_sequence: number | string; version: number } }).permit;
    assert.equal(numbered.status, 'PENDING_CRO');
    assert.equal(Number(numbered.permit_sequence), 1, 'numbered from its type series by the invoker trigger');

    const forwarded = await forwardToHseReview(CRO, permit.id, { expectedVersion: numbered.version }, deps);
    assert.equal(forwarded.outcome, 'ok', JSON.stringify(forwarded));
    const approved = await hseApprove(HSE, permit.id, {
      expectedVersion: (forwarded as { permit: { version: number } }).permit.version,
    }, deps);
    assert.equal(approved.outcome, 'ok', JSON.stringify(approved));
    const issued = (approved as { permit: { status: string; version: number } }).permit;
    assert.equal(issued.status, 'ISSUED');

    const held = await holdPermit(CRO, permit.id, { expectedVersion: issued.version, reason: 'Wind above limit' }, deps);
    assert.equal(held.outcome, 'ok', JSON.stringify(held));
    const resumed = await resumePermit(CRO, permit.id, {
      expectedVersion: (held as { permit: { version: number } }).permit.version,
    }, deps);
    assert.equal(resumed.outcome, 'ok', JSON.stringify(resumed));
    const closed = await closePermit(CRO, permit.id, {
      expectedVersion: (resumed as { permit: { version: number } }).permit.version, closureRemarks: 'Work complete',
    }, deps);
    assert.equal(closed.outcome, 'ok', JSON.stringify(closed));

    const events = await getPermitLifecycleEvents(permit.id, deps);
    assert.ok(events.length >= 6, `lifecycle recorded (${events.length} events)`);
    const side = await db.query<{ notifications: number; signatures: number; snapshots: number; jobs: number }>(`
      SELECT (SELECT count(*)::int FROM notifications) AS notifications,
             (SELECT count(*)::int FROM permit_signatures) AS signatures,
             (SELECT count(*)::int FROM issued_document_snapshots) AS snapshots,
             (SELECT count(*)::int FROM permit_document_jobs) AS jobs`);
    const counts = side.rows[0]!;
    assert.ok(counts.notifications > 0, 'notifications written and readable under RLS');
    assert.ok(counts.signatures > 0, 'signatures written and readable under RLS');
    assert.ok(counts.snapshots > 0, 'issued snapshot written and readable under RLS');
    assert.ok(counts.jobs > 0, 'document job queued and readable under RLS');
  } finally {
    await db.exec('RESET ROLE; SET search_path = pg_catalog;');
  }
});
