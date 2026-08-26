import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);
const EXISTING_USER = '10000000-0000-4000-8000-000000000001';
const MANAGER = '10000000-0000-4000-8000-000000000002';
const EMPLOYEE = '10000000-0000-4000-8000-000000000003';

/** Bootstrap only Supabase-owned objects; application objects come from the real migration files. */
async function createSupabaseSubstrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${EXISTING_USER}'), ('${MANAGER}'), ('${EMPLOYEE}');
    CREATE TABLE public.schema_migrations (id integer PRIMARY KEY, name text NOT NULL);
    CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
    AS $$
    DECLARE command record;
    BEGIN
      IF TG_TAG <> 'CREATE TABLE' THEN RETURN; END IF;
      FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF command.object_type = 'table' AND command.schema_name = 'public' THEN
          EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
        END IF;
      END LOOP;
    END;
    $$;
    CREATE EVENT TRIGGER rls_auto_enable_trigger ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.rls_auto_enable();
  `);
  return db;
}

async function migrationFilesThrough(lastId: number): Promise<string[]> {
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => Number(name.slice(0, 4)) <= lastId)
    .sort();
  assert.deepEqual(
    names.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: lastId }, (_, index) => index + 1),
  );
  return names;
}

async function applyRealMigrations(db: PGlite, lastId: number): Promise<void> {
  for (const name of await migrationFilesThrough(lastId)) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  }
}

describe('0017 on the actual repository migration chain', { concurrency: false }, () => {
  let db: PGlite;

  before(async () => {
    db = await createSupabaseSubstrate();
    await applyRealMigrations(db, 17);
  });
  after(async () => { await db.close(); });

  test('the complete real 0001 through 0017 migration chain succeeds', async () => {
    const rows = await db.query(`SELECT 1 FROM account_audit_events LIMIT 1`);
    assert.equal(rows.rows.length, 0);
  });

  test('existing accounts retain safe credential defaults', async () => {
    const rows = await db.query<{
      must_change_password: boolean; credentials_changed_at: Date | null;
      credential_version: string; credential_reset_pending: boolean;
    }>(`SELECT must_change_password, credentials_changed_at,
              credential_version::text AS credential_version, credential_reset_pending
           FROM app_user_access WHERE user_id = '${EXISTING_USER}'`);
    assert.deepEqual(rows.rows[0], {
      must_change_password: false, credentials_changed_at: null,
      credential_version: '0', credential_reset_pending: false,
    });
  });

  test('0017 seeds only capability names and guesses no organization data', async () => {
    const seeded = await db.query<{ name: string }>(
      `SELECT name FROM capabilities WHERE name LIKE 'employee.%' ORDER BY name`,
    );
    assert.deepEqual(seeded.rows.map((row) => row.name), ['employee.create', 'employee.reset_password']);
    for (const table of ['teams', 'positions', 'team_positions', 'user_team_positions', 'workforce_profiles']) {
      const count = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
      assert.equal(count.rows[0]?.count, 0, `${table} must receive no guessed row`);
    }
    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM team_position_capabilities tpc
        JOIN capabilities c ON c.id = tpc.capability_id WHERE c.name LIKE 'employee.%'`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  });

  test('Team + Position assignability is NOT NULL, false by default and not seeded true', async () => {
    const column = await db.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'team_positions' AND column_name = 'site_manager_assignable'`,
    );
    assert.equal(column.rows[0]?.is_nullable, 'NO');
    assert.match(String(column.rows[0]?.column_default), /false/i);
    await db.exec(`
      INSERT INTO teams (id, name) VALUES ('70000000-0000-4000-8000-000000000001', 'Operations');
      INSERT INTO positions (id, name) VALUES ('80000000-0000-4000-8000-000000000001', 'Technician');
      INSERT INTO team_positions (id, team_id, position_id)
      VALUES ('40000000-0000-4000-8000-000000000001',
              '70000000-0000-4000-8000-000000000001',
              '80000000-0000-4000-8000-000000000001');
    `);
    const row = await db.query<{ site_manager_assignable: boolean }>(
      `SELECT site_manager_assignable FROM team_positions
        WHERE id = '40000000-0000-4000-8000-000000000001'`,
    );
    assert.equal(row.rows[0]?.site_manager_assignable, false);
  });

  test('account audit is RLS-enabled, policy-free and default-deny to browsers', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'account_audit_events'`,
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    const policies = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'account_audit_events'`,
    );
    assert.equal(policies.rows[0]?.count, 0);
    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE table_name = 'account_audit_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  });

  test('account audit created_at always uses the database clock', async () => {
    await db.exec(`INSERT INTO account_audit_events
      (id, event_type, actor_user_id, target_user_id, created_at)
      VALUES ('a0000000-0000-4000-8000-000000000001', 'EMPLOYEE_ACCOUNT_CREATED',
              '${MANAGER}', '${EMPLOYEE}', '1999-01-01')`);
    const row = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM account_audit_events WHERE id = 'a0000000-0000-4000-8000-000000000001'`,
    );
    assert.ok(row.rows[0]!.created_at.getUTCFullYear() > 2000);
  });

  test('account audit remains append-only', async () => {
    await assert.rejects(db.exec(`UPDATE account_audit_events SET created_at = now()
      WHERE id = 'a0000000-0000-4000-8000-000000000001'`));
    await assert.rejects(db.exec(`DELETE FROM account_audit_events
      WHERE id = 'a0000000-0000-4000-8000-000000000001'`));
    await assert.rejects(db.exec('TRUNCATE account_audit_events'));
  });

  test('0017 functions are SECURITY INVOKER with pinned search paths', async () => {
    const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE proname IN ('app_user_access_authoritative_timestamps',
                          'account_audit_events_authoritative_timestamp') ORDER BY proname`,
    );
    assert.equal(functions.rows.length, 2);
    for (const fn of functions.rows) {
      assert.equal(fn.prosecdef, false);
      assert.ok(fn.proconfig?.includes('search_path=pg_catalog'));
    }
  });

  test('credential state time is DB-authoritative and its generation is monotonic', async () => {
    await db.exec(`UPDATE app_user_access SET must_change_password = TRUE,
      credential_version = credential_version + 1, credentials_changed_at = '2099-01-01'
      WHERE user_id = '${EMPLOYEE}'`);
    const row = await db.query<{ credentials_changed_at: Date; credential_version: string }>(
      `SELECT credentials_changed_at, credential_version::text AS credential_version
         FROM app_user_access WHERE user_id = '${EMPLOYEE}'`,
    );
    assert.notEqual(row.rows[0]!.credentials_changed_at.getUTCFullYear(), 2099);
    assert.equal(row.rows[0]?.credential_version, '1');
    await assert.rejects(db.exec(`UPDATE app_user_access SET credential_version = 0
      WHERE user_id = '${EMPLOYEE}'`));
    await assert.rejects(db.exec(`UPDATE app_user_access
      SET must_change_password = FALSE, credential_reset_pending = TRUE
      WHERE user_id = '${EMPLOYEE}'`));
  });
});

test('a failed real 0017 transaction leaves no partial schema state', async () => {
  const db = await createSupabaseSubstrate();
  try {
    await applyRealMigrations(db, 16);
    await db.exec(`INSERT INTO capabilities (name, description) VALUES ('employee.create', 'collision')`);
    const migration = await readFile(new URL('0017_employee_account_password_management.sql', migrationsDirectory), 'utf8');
    await assert.rejects(async () => {
      await db.exec('BEGIN');
      try { await db.exec(migration); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    });
    const columns = await db.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM information_schema.columns WHERE
        (table_name = 'app_user_access' AND column_name IN
          ('must_change_password','credentials_changed_at','credential_version','credential_reset_pending'))
        OR (table_name = 'team_positions' AND column_name = 'site_manager_assignable')`);
    assert.equal(columns.rows[0]?.count, 0);
    const tables = await db.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM information_schema.tables WHERE table_name = 'account_audit_events'`);
    assert.equal(tables.rows[0]?.count, 0);
  } finally { await db.close(); }
});
