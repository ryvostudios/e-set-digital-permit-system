import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { historicalDatabase, historicalMigrationsOnlyDir, installedDatabase } from '../test/permitSchemaFixtures.js';

/**
 * THE `permit` BASELINE IS THE 0038 SCHEMA, MOVED - NOT A REWRITE.
 *
 * The shared E-Set database installs Permit from database/baseline instead
 * of replaying 0001-0038 into `public`. This compares, object by object,
 * the catalog produced by replaying the real history against the catalog
 * the baseline installs, after mapping schema `public` to `permit`. The
 * only differences allowed are the ones the shared-database architecture
 * requires, and each is listed explicitly below; anything else fails.
 *
 * One of them is structural: the 20 user foreign keys to Supabase's
 * auth.users are deferred out of the baseline and re-created against
 * permit.users by migration 0039 - proven at the end of this file.
 */

type Snapshot = Record<string, unknown>;

// Text-stored references move from `public.` to `permit.` exactly as the
// generator rewrites them (tools/rewrite-namespace.sql).
const toPermit = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/\bpublic\./gi, 'permit.') : value;

async function rows(db: PGlite, sql: string, schema: string): Promise<Record<string, unknown>[]> {
  const result = await db.query<Record<string, unknown>>(sql, [schema]);
  return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toPermit(v)])));
}

/** Everything that defines a schema's structure, keyed by object name. */
async function snapshot(db: PGlite, schema: string): Promise<Snapshot> {
  await db.exec('SET search_path = pg_catalog');
  const ledger = `c.relname NOT IN ('schema_migrations', 'schema_migrations_id_seq', 'schema_migrations_pkey', 'schema_migrations_name_key')`;
  return {
    columns: await rows(db, `
      SELECT c.relname, a.attname,
             rank() OVER (PARTITION BY c.oid ORDER BY a.attnum) AS position,
             format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attidentity, a.attgenerated,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr, co.collname,
             col_description(c.oid, a.attnum) AS comment
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 100
       WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND ${ledger}
       ORDER BY 1, 3`, schema),
    relations: await rows(db, `
      SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
             c.relreplident, obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND ${ledger}
       ORDER BY 1`, schema),
    constraints: await rows(db, `
      SELECT c.relname, k.conname, k.contype, k.condeferrable, k.condeferred, k.convalidated,
             pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       WHERE k.connamespace = $1::regnamespace AND ${ledger}
       ORDER BY 1, 2`, schema),
    indexes: await rows(db, `
      SELECT c.relname, pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relnamespace = $1::regnamespace AND ${ledger}
       ORDER BY 1`, schema),
    sequences: await rows(db, `
      SELECT c.relname, format_type(s.seqtypid, NULL) AS type, s.seqstart, s.seqincrement, s.seqmax,
             s.seqmin, s.seqcache, s.seqcycle,
             (SELECT t.relname || '.' || a.attname FROM pg_depend dep
                JOIN pg_class t ON t.oid = dep.refobjid
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
               WHERE dep.objid = c.oid AND dep.deptype IN ('a', 'i')) AS owned_by
        FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
       WHERE c.relnamespace = $1::regnamespace AND ${ledger}
       ORDER BY 1`, schema),
    functions: await rows(db, `
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS result, l.lanname, p.prokind, p.provolatile,
             p.proisstrict, p.proleakproof, p.proparallel, p.prosecdef, p.prosrc,
             obj_description(p.oid, 'pg_proc') AS comment
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = $1::regnamespace
       ORDER BY 1, 2`, schema),
    triggers: await rows(db, `
      SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal
       ORDER BY 1, 2`, schema),
    types: await rows(db, `
      SELECT t.typname, t.typtype FROM pg_type t
       WHERE t.typnamespace = $1::regnamespace AND t.typtype IN ('e', 'd', 'c', 'r', 'm')
         AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
       ORDER BY 1`, schema),
    views: await rows(db, `
      SELECT c.relname, c.relkind FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('v', 'm') ORDER BY 1`, schema),
  };
}

async function functionSearchPaths(db: PGlite, schema: string): Promise<Record<string, string>> {
  const result = await db.query<{ proname: string; config: string | null }>(
    `SELECT proname, array_to_string(proconfig, ',') AS config FROM pg_proc
      WHERE pronamespace = $1::regnamespace ORDER BY 1`, [schema]);
  return Object.fromEntries(result.rows.map((r) => [r.proname, r.config ?? '<none>']));
}

/** Reference rows compared by natural key; identifiers and timestamps are arbitrary per install. */
async function referenceData(db: PGlite, schema: string): Promise<Record<string, unknown[]>> {
  const q = async (sql: string) => (await db.query(sql.replaceAll('S.', `${schema}.`))).rows;
  return {
    capabilities: await q('SELECT name, individually_grantable FROM S.capabilities ORDER BY 1'),
    companies: await q('SELECT code, name, deactivated_at FROM S.companies ORDER BY 1'),
    teams: await q(`SELECT co.code, t.name, t.deactivated_at FROM S.teams t
                      JOIN S.companies co ON co.id = t.company_id ORDER BY 1, 2`),
    positions: await q('SELECT name FROM S.positions ORDER BY 1'),
    teamPositions: await q(`SELECT t.name AS team, p.name AS position, tp.site_manager_assignable, tp.deactivated_at
                              FROM S.team_positions tp JOIN S.teams t ON t.id = tp.team_id
                              JOIN S.positions p ON p.id = tp.position_id ORDER BY 1, 2`),
    teamPositionCapabilities: await q(`SELECT t.name AS team, p.name AS position, c.name AS capability
                                         FROM S.team_position_capabilities x
                                         JOIN S.team_positions tp ON tp.id = x.team_position_id
                                         JOIN S.teams t ON t.id = tp.team_id
                                         JOIN S.positions p ON p.id = tp.position_id
                                         JOIN S.capabilities c ON c.id = x.capability_id ORDER BY 1, 2, 3`),
    counters: await q('SELECT permit_type, next_value FROM S.permit_number_counters ORDER BY 1'),
    emptyTables: await q(`SELECT relname FROM pg_class
                           WHERE relnamespace = '${schema}'::regnamespace AND relkind = 'r'
                             AND relname NOT IN ('capabilities', 'companies', 'teams', 'positions', 'team_positions',
                                                 'team_position_capabilities', 'permit_number_counters', 'schema_migrations')
                           ORDER BY 1`),
  };
}

let historical: PGlite;
let baseline: PGlite;
let migrated: PGlite;

const isAuthUsersFk = (c: { definition: unknown }) => String(c.definition).includes('REFERENCES auth.users(id)');

before(async () => {
  historical = await historicalDatabase();
  // The baseline alone (0001-0038 recorded, nothing after it).
  baseline = await installedDatabase({ migrationsDir: await historicalMigrationsOnlyDir() });
  // Baseline plus every later shared-database migration.
  migrated = await installedDatabase();
});

after(async () => {
  await historical?.close();
  await baseline?.close();
  await migrated?.close();
});

test('every structural object of the replayed 0038 schema is present and identical in permit', async () => {
  const source = await snapshot(historical, 'public');
  // The emulated Supabase helper is not a Permit object.
  source.functions = (source.functions as { proname: string }[]).filter((f) => f.proname !== 'rls_auto_enable');
  const target = await snapshot(baseline, 'permit');
  // The deferred Supabase references - exactly 20 foreign keys, nothing else.
  const deferred = (source.constraints as { definition: unknown; contype: string }[]).filter(isAuthUsersFk);
  assert.equal(deferred.length, 20);
  assert.ok(deferred.every((c) => (c as { contype: string }).contype === 'f'));
  source.constraints = (source.constraints as { definition: unknown }[]).filter((c) => !isAuthUsersFk(c));
  for (const key of Object.keys(source)) {
    assert.deepEqual(target[key], source[key], `baseline differs from the 0038 replay in: ${key}`);
  }
  // Guard against a vacuous comparison.
  assert.equal((target.relations as unknown[]).filter((r) => (r as { relkind: string }).relkind === 'r').length, 25);
  assert.equal((target.functions as unknown[]).length, 37);
  assert.equal((target.triggers as unknown[]).length, 57);
  assert.equal((target.types as unknown[]).length, 0);
  assert.equal((target.views as unknown[]).length, 0);
});

test('function search_path differences are exactly the intended hardening', async () => {
  const source = await functionSearchPaths(historical, 'public');
  delete source.rls_auto_enable;
  const target = await functionSearchPaths(baseline, 'permit');
  const intended: Record<string, [string, string]> = {
    // SECURITY DEFINER: pg_temp pinned last so it can never shadow a relation.
    grant_baseline_applicant_capabilities: ['search_path=pg_catalog', 'search_path=pg_catalog, pg_temp'],
    record_site_manager_grant: ['search_path=pg_catalog', 'search_path=pg_catalog, pg_temp'],
    // Invokers that resolved unqualified Permit names through public.
    allocate_permit_sequence: ['search_path=pg_catalog, public', 'search_path=pg_catalog, permit'],
    jsas_content_editable_only: ['search_path=pg_catalog, public', 'search_path=pg_catalog, permit'],
    permits_assign_permit_sequence: ['search_path=pg_catalog, public', 'search_path=pg_catalog, permit'],
  };
  assert.deepEqual(Object.keys(target), Object.keys(source));
  for (const name of Object.keys(source)) {
    const [from, to] = intended[name] ?? [source[name], source[name]];
    assert.equal(source[name], from, `${name}: unexpected historical search_path`);
    assert.equal(target[name], to, `${name}: unexpected baseline search_path`);
  }
});

test('the seeded reference data at 0038 is reproduced exactly', async () => {
  assert.deepEqual(await referenceData(baseline, 'permit'), await referenceData(historical, 'public'));
});

test('the only row-security change is one permit_runtime policy per runtime-visible table', async () => {
  const source = await historical.query('SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1', ['public']);
  assert.equal((source.rows[0] as { n: number }).n, 0, 'the standalone design relied on BYPASSRLS, not policies');
  const policies = await baseline.query<{ tablename: string; roles: string[]; cmd: string; qual: string; with_check: string }>(
    `SELECT tablename, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'permit' ORDER BY 1`);
  assert.equal(policies.rows.length, 24);
  for (const policy of policies.rows) {
    assert.deepEqual(policy.roles, ['permit_runtime']);
    assert.equal(policy.cmd, 'ALL');
  }
  assert.ok(!policies.rows.some((p) => p.tablename === 'initial_ceo_bootstrap'), 'bootstrap state stays unreachable');
  assert.ok(!policies.rows.some((p) => p.tablename === 'schema_migrations'), 'the ledger stays unreachable');
});

test('nothing in the baseline references schema public', async () => {
  const leftovers = await baseline.query(`
    SELECT proname FROM pg_proc WHERE pronamespace = 'permit'::regnamespace
       AND (prosrc ~* '\\mpublic\\s*\\.' OR array_to_string(proconfig, ',') ~* 'public')`);
  assert.deepEqual(leftovers.rows, []);
  const outside = await baseline.query(`
    SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace`);
  assert.deepEqual(outside.rows, [], 'no Permit relation may land in public');
});

test('0039 re-creates every deferred user reference against permit.users, unchanged', async () => {
  const source = await snapshot(historical, 'public');
  const expected = (source.constraints as { relname: string; conname: string; definition: string }[])
    .filter(isAuthUsersFk)
    .map((c) => ({ ...c, definition: c.definition.replace('REFERENCES auth.users(id)', 'REFERENCES permit.users(id)') }));
  const after0039 = await snapshot(migrated, 'permit');
  const actual = (after0039.constraints as { relname: string; conname: string; definition: string }[])
    .filter((c) => c.definition.includes('REFERENCES permit.users(id)') && c.relname !== 'user_sessions'
      && !['cms_audit_events', 'cms_logo_assets', 'cms_settings', 'file_registry', 'storage_audit_events',
        'storage_connections', 'storage_oauth_states', 'storage_selection'].includes(c.relname));
  assert.deepEqual(actual, expected);
  const stillAuth = await migrated.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text = 'auth.users'`)
    .catch(() => ({ rows: [] }));
  assert.deepEqual(stillAuth.rows, [], 'no Permit foreign key references auth.users');
});
