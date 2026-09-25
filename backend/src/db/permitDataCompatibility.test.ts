import bcrypt from 'bcryptjs';
import { planLegacyUserImport, importLegacyUsers } from '../domain/auth/legacyImport.js';
import type { QueryFn } from './pool.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { historicalDatabase, installedDatabase } from '../test/permitSchemaFixtures.js';
import {
  closePermit,
  createDraftPermit,
  forwardToHseReview,
  hseApprove,
  renewPermit,
  submitPermit,
  updateDraftPermit,
  updateLinkedJsa,
  type PermitsServiceDeps,
} from '../domain/permits/service.js';
import { answeredJsaV2, answeredWtgPermitV2 } from '../test/v2Forms.js';

/**
 * EXISTING RECORDS MOVE INTO `permit` UNCHANGED.
 *
 * Real rows are produced in a replayed 0038 standalone database by the
 * real services (permits through issue and renewal, JSAs, lifecycle
 * events, signatures, issued snapshots, document jobs, notifications,
 * outbox, counters). They are then copied into a baseline installed
 * WITHOUT reference data - the data-migration target - and every row and
 * every sequence position must be identical: no regenerated UUID, no
 * renumbered permit or JSA, no rewritten timestamp, no lost audit row.
 *
 * The copy runs as permit_migrator with USER triggers disabled for the
 * duration of one transaction. That is required, not a shortcut: the
 * authoritative-timestamp and permit-numbering triggers exist to stamp
 * NEW rows, and would otherwise overwrite historical values. Foreign keys
 * stay enforced throughout, and the triggers are active again afterwards.
 */

const APPLICANT = '52000000-0000-4000-8000-000000000001';
const CRO = '52000000-0000-4000-8000-000000000002';
const HSE = '52000000-0000-4000-8000-000000000003';

let source: PGlite;
let target: PGlite;
let tables: string[];

function deps(db: PGlite): PermitsServiceDeps {
  return {
    query: ((text: string, params?: unknown[]) => db.query(text, params)) as PermitsServiceDeps['query'],
    withTransaction: (async <T>(work: (client: PoolClient) => Promise<T>) => db.transaction(
      async (tx) => work({ query: tx.query.bind(tx) } as unknown as PoolClient),
    )) as PermitsServiceDeps['withTransaction'],
  };
}

async function assign(db: PGlite, user: string, name: string, team: string, position: string): Promise<void> {
  await db.query('INSERT INTO auth.users (id) VALUES ($1)', [user]);
  await db.query(`
    INSERT INTO user_team_positions (user_id, team_position_id)
    SELECT $1, tp.id FROM team_positions tp JOIN teams t ON t.id = tp.team_id
      JOIN companies c ON c.id = t.company_id JOIN positions p ON p.id = tp.position_id
     WHERE c.code = 'E_SET' AND t.name = $2 AND p.name = $3`, [user, team, position]);
  await db.query(`
    INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
    SELECT $1, $2, utp.team_position_id, t.company_id FROM user_team_positions utp
      JOIN team_positions tp ON tp.id = utp.team_position_id JOIN teams t ON t.id = tp.team_id
     WHERE utp.user_id = $1`, [user, name]);
}

/** Drives real permits through the real services in the standalone schema. */
async function produceHistory(db: PGlite): Promise<void> {
  // The current issuance code captures the Permit CMS branding (Phase 4).
  // A standalone 0038 database has no CMS, so give it exactly the state a
  // fresh CMS has - an organization name and no logos - in the schema the
  // code reads. These tables are not part of the copied history.
  await db.exec(`
    CREATE SCHEMA permit;
    CREATE TABLE permit.cms_settings (singleton boolean PRIMARY KEY, organization_name text NOT NULL);
    INSERT INTO permit.cms_settings VALUES (true, 'E-Set Engineering Services');
    CREATE TABLE permit.file_registry (id uuid PRIMARY KEY, sha256 text NOT NULL, state text NOT NULL);
    CREATE TABLE permit.cms_logo_assets (file_id uuid, display_label text, purpose text, active boolean,
      display_order int, applicable_document_types text[]);
  `);
  await db.exec('SET search_path = public, pg_catalog');
  await assign(db, APPLICANT, 'Applicant One', 'WTG', 'Technician');
  await assign(db, CRO, 'Control Room', 'E-BOP', 'CRO');
  await assign(db, HSE, 'Safety Lead', 'HSE', 'Team Lead');
  const d = deps(db);
  for (let i = 0; i < 2; i += 1) {
    const { permit } = await createDraftPermit(APPLICANT, 'Asia/Karachi', 'WTG_WORK', d);
    const drafted = await updateDraftPermit(APPLICANT, permit.id, { expectedVersion: permit.version, form: answeredWtgPermitV2() }, d);
    assert.equal(drafted.outcome, 'ok');
    const jsa = await updateLinkedJsa(APPLICANT, permit.id,
      { expectedVersion: (drafted as { permit: { version: number } }).permit.version, form: answeredJsaV2() }, d);
    assert.equal(jsa.outcome, 'ok');
    const submitted = await submitPermit(APPLICANT, permit.id,
      { expectedVersion: (jsa as { permit: { version: number } }).permit.version }, d);
    assert.equal(submitted.outcome, 'ok');
    const forwarded = await forwardToHseReview(CRO, permit.id,
      { expectedVersion: (submitted as { permit: { version: number } }).permit.version }, d);
    assert.equal(forwarded.outcome, 'ok');
    const approved = await hseApprove(HSE, permit.id,
      { expectedVersion: (forwarded as { permit: { version: number } }).permit.version }, d);
    assert.equal(approved.outcome, 'ok');
    if (i === 1) {
      const closed = await closePermit(CRO, permit.id, {
        expectedVersion: (approved as { permit: { version: number } }).permit.version, closureRemarks: 'Done',
      }, d);
      assert.equal(closed.outcome, 'ok', JSON.stringify(closed));
      // Source fixture only: age the closed permit past its validity by
      // shifting every timestamp of the row together, so it can be renewed.
      await db.exec(`
        ALTER TABLE permits DISABLE TRIGGER USER;
        DO $age$ DECLARE cols text; BEGIN
          SELECT string_agg(format('%I = %I - interval ''2 days''', attname, attname), ', ') INTO cols
            FROM pg_attribute WHERE attrelid = 'public.permits'::regclass AND attnum > 0 AND NOT attisdropped
             AND atttypid = 'timestamptz'::regtype;
          EXECUTE format('UPDATE permits SET %s WHERE id = %L', cols, '${permit.id}');
        END $age$;
        ALTER TABLE permits ENABLE TRIGGER USER;`);
      const renewed = await renewPermit(CRO, permit.id, d);
      assert.equal(renewed.outcome, 'ok', JSON.stringify(renewed));
    }
  }
  await db.exec('SET search_path = pg_catalog');
}

/** Permit tables ordered so every foreign-key parent precedes its children. */
async function dependencyOrder(db: PGlite, historicalTables: string[]): Promise<string[]> {
  const result = await db.query<{ child: string; parent: string }>(`
    SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
     WHERE k.contype = 'f' AND c.relnamespace = 'permit'::regnamespace
       AND p.relnamespace = 'permit'::regnamespace AND c.oid <> p.oid`);
  const all = (await db.query<{ relname: string }>(`
    SELECT relname FROM pg_class WHERE relnamespace = 'permit'::regnamespace AND relkind = 'r'
       AND relname NOT IN ('schema_migrations', 'users', 'user_sessions') ORDER BY 1`)).rows
    .map((r) => r.relname)
    // Only the standalone 0038 tables carry history; Phase 4 tables start empty.
    .filter((name) => historicalTables.includes(name));
  const ordered: string[] = [];
  while (ordered.length < all.length) {
    const ready = all.filter((t) => !ordered.includes(t) &&
      result.rows.every((e) => e.child !== t || ordered.includes(e.parent) || !all.includes(e.parent)));
    assert.ok(ready.length > 0, 'foreign keys between permit tables must be acyclic');
    ordered.push(...ready);
  }
  return ordered;
}

async function tableRows(db: PGlite, schema: string, table: string): Promise<unknown[]> {
  const result = await db.query<{ rows: unknown[] | null }>(
    `SELECT json_agg(t ORDER BY t::text) AS rows FROM ${schema}.${table} t`);
  return result.rows[0]!.rows ?? [];
}

async function sequenceStates(db: PGlite, schema: string): Promise<Record<string, unknown>> {
  const names = (await db.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'S'
        AND relname <> 'schema_migrations_id_seq' ORDER BY 1`, [schema])).rows.map((r) => r.relname);
  const states: Record<string, unknown> = {};
  for (const name of names) {
    states[name] = (await db.query(`SELECT last_value::text, is_called FROM ${schema}.${name}`)).rows[0];
  }
  return states;
}

before(async () => {
  source = await historicalDatabase();
  await produceHistory(source);
  target = await installedDatabase({ baselineReferenceData: false });
  const historicalTables = (await source.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).rows.map((r) => r.relname);
  tables = await dependencyOrder(target, historicalTables);

  // Synthetic credentials only: UUIDs and normalized login identity precede
  // all referencing data in the destination. Nothing reads a real Auth host.
  const users = (await source.query<{ id: string }>('SELECT id FROM auth.users ORDER BY id')).rows;
  const legacyHash = await bcrypt.hash('FAKE-data-migration-password', 10);
  const plan = planLegacyUserImport(users.map((user) => ({id:user.id,email:`${user.id}@example.test`,
    encryptedPassword:legacyHash,createdAt:'2020-01-01T00:00:00Z'})));
  assert.equal(plan.ok,true);
  if (!plan.ok) throw new Error('synthetic import plan refused');
  await target.exec('SET ROLE permit_migrator; SET search_path=pg_catalog,permit,pg_temp');
  await target.transaction(async(tx)=>{
    assert.equal(await importLegacyUsers(tx.query.bind(tx) as QueryFn,plan),users.length);
  });

  // The import step, as the data migration will run it.
  await target.exec('SET ROLE permit_migrator; BEGIN;');
  try {
    for (const table of tables) await target.exec(`ALTER TABLE permit.${table} DISABLE TRIGGER USER`);
    for (const table of tables) {
      // Parents first; a renewal's predecessor precedes it (created earlier).
      const rows = (await source.query<{ rows: unknown[] | null }>(
        `SELECT json_agg(t ORDER BY ${table === 'permits' ? 't.created_at, t.id' : 't::text'}) AS rows FROM public.${table} t`,
      )).rows[0]!.rows ?? [];
      if (rows.length === 0) continue;
      await target.query(
        `INSERT INTO permit.${table} SELECT * FROM json_populate_recordset(NULL::permit.${table}, $1::json)`,
        [JSON.stringify(rows)]);
    }
    const sequences = await sequenceStates(source, 'public');
    for (const [name, state] of Object.entries(sequences)) {
      const { last_value, is_called } = state as { last_value: string; is_called: boolean };
      await target.query(`SELECT setval($1::regclass, $2::bigint, $3)`, [`permit.${name}`, last_value, is_called]);
    }
    for (const table of tables) await target.exec(`ALTER TABLE permit.${table} ENABLE TRIGGER USER`);
    await target.exec('COMMIT; RESET ROLE;');
  } catch (err) {
    await target.exec('ROLLBACK; RESET ROLE;');
    throw err;
  }
});

after(async () => {
  await source?.close();
  await target?.close();
});

test('the standalone history is non-trivial', async () => {
  const counts = await source.query<Record<string, number>>(`
    SELECT (SELECT count(*)::int FROM public.permits) AS permits,
           (SELECT count(*)::int FROM public.permits WHERE previous_permit_id IS NOT NULL) AS renewals,
           (SELECT count(*)::int FROM public.permit_lifecycle_events) AS events,
           (SELECT count(*)::int FROM public.permit_signatures) AS signatures,
           (SELECT count(*)::int FROM public.issued_document_snapshots) AS snapshots,
           (SELECT count(*)::int FROM public.permit_document_jobs) AS jobs`);
  const c = counts.rows[0]!;
  assert.ok(c.permits! >= 3 && c.renewals! >= 1 && c.events! >= 10 && c.signatures! >= 2 && c.snapshots! >= 2 && c.jobs! >= 2,
    JSON.stringify(c));
});

test('every row of every Permit table arrives byte-for-byte: ids, numbers, timestamps, audit, signatures, snapshots', async () => {
  for (const table of tables) {
    let rows = await tableRows(target, 'permit', table);
    if (table === 'capabilities') {
      // Migration 0041 adds the Permit CMS capability; the standalone
      // history never had it. Everything else must match exactly.
      const added = rows.filter((row) => (row as { name: string }).name === 'permit.cms.manage');
      assert.equal(added.length, 1, 'exactly one capability added after 0038');
      rows = rows.filter((row) => (row as { name: string }).name !== 'permit.cms.manage');
    }
    assert.deepEqual(rows, await tableRows(source, 'public', table), table);
  }
});

test('every sequence continues from its historical position', async () => {
  assert.deepEqual(await sequenceStates(target, 'permit'), await sequenceStates(source, 'public'));
});

test('after the import, protections are active again and numbering continues without reuse', async () => {
  const triggers = await target.query(`
    SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'permit'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O'`);
  assert.deepEqual(triggers.rows, [], 'every user trigger is enabled again');

  await target.exec('SET ROLE permit_migrator');
  try {
    await assert.rejects(target.exec('UPDATE permit.permit_lifecycle_events SET reason = reason'),
      'the lifecycle log is immutable again, even for its owner');
  } finally {
    await target.exec('RESET ROLE');
  }

  const highest = await target.query<{ max: number }>(
    `SELECT max(permit_sequence)::int AS max FROM permit.permits WHERE permit_type = 'WTG_WORK'`);
  await target.exec('SET ROLE permit_runtime; SET search_path = pg_catalog, permit, pg_temp;');
  try {
    const d = deps(target);
    const { permit } = await createDraftPermit(APPLICANT, 'Asia/Karachi', 'WTG_WORK', d);
    const drafted = await updateDraftPermit(APPLICANT, permit.id, { expectedVersion: permit.version, form: answeredWtgPermitV2() }, d);
    const jsa = await updateLinkedJsa(APPLICANT, permit.id,
      { expectedVersion: (drafted as { permit: { version: number } }).permit.version, form: answeredJsaV2() }, d);
    const submitted = await submitPermit(APPLICANT, permit.id,
      { expectedVersion: (jsa as { permit: { version: number } }).permit.version }, d);
    assert.equal(submitted.outcome, 'ok', JSON.stringify(submitted));
    assert.equal(Number((submitted as { permit: { permit_sequence: string | null } }).permit.permit_sequence), highest.rows[0]!.max + 1);
  } finally {
    await target.exec('RESET ROLE; SET search_path = pg_catalog;');
  }
});
