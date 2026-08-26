import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);
const USER = '10000000-0000-4000-8000-000000000001';
const TEAM = '70000000-0000-4000-8000-000000000001';
const POSITION = '80000000-0000-4000-8000-000000000001';
const TEAM_POSITION = '40000000-0000-4000-8000-000000000001';
const E_SET = '18000000-0000-4000-8000-000000000001';
const PRIVILEGED_USER = '10000000-0000-4000-8000-000000000002';

async function createSupabaseSubstrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${USER}');
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
  assert.deepEqual(names.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: lastId }, (_, index) => index + 1));
  return names;
}

async function applyRealMigrations(db: PGlite, lastId: number): Promise<void> {
  for (const name of await migrationFilesThrough(lastId)) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  }
}

async function seedAssignment(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO teams (id, name) VALUES ('${TEAM}', 'Operations');
    INSERT INTO positions (id, name) VALUES ('${POSITION}', 'Technician');
    INSERT INTO team_positions (id, team_id, position_id)
      VALUES ('${TEAM_POSITION}', '${TEAM}', '${POSITION}');
    INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${USER}', '${TEAM_POSITION}');
  `);
}

describe('0018 on the actual repository migration chain', { concurrency: false }, () => {
  let db: PGlite;
  before(async () => {
    db = await createSupabaseSubstrate();
    await applyRealMigrations(db, 18);
  });
  after(async () => { await db.close(); });

  test('the complete real 0001 through 0018 chain succeeds and seeds exactly the confirmed companies', async () => {
    const rows = await db.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM companies ORDER BY code',
    );
    assert.deepEqual(rows.rows, [
      { id: E_SET, code: 'E_SET', name: 'E-SET' },
      { id: '18000000-0000-4000-8000-000000000003', code: 'SGRE', name: 'SGRE' },
      { id: '18000000-0000-4000-8000-000000000002', code: 'ZPL', name: 'ZPL' },
    ]);
    const unique = await db.query<{ count: number; distinct_count: number }>(
      'SELECT count(*)::int AS count, count(DISTINCT code)::int AS distinct_count FROM companies',
    );
    assert.deepEqual(unique.rows[0], { count: 3, distinct_count: 3 });
  });

  test('one non-null company FK is enforced per workforce profile', async () => {
    await seedAssignment(db);
    await db.exec(`INSERT INTO workforce_profiles
      (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${USER}', 'Ayesha Khan', '${TEAM_POSITION}', '${E_SET}')`);
    const row = await db.query<{ company_id: string }>(
      `SELECT company_id FROM workforce_profiles WHERE user_id = '${USER}'`,
    );
    assert.equal(row.rows[0]?.company_id, E_SET);
    await assert.rejects(db.exec(`INSERT INTO workforce_profiles
      (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${USER}', 'Duplicate', '${TEAM_POSITION}',
              '18000000-0000-4000-8000-000000000002')`));
    await assert.rejects(db.exec(`UPDATE workforce_profiles SET company_id = NULL WHERE user_id = '${USER}'`));
    await assert.rejects(db.exec(`UPDATE workforce_profiles
      SET company_id = '99999999-0000-4000-8000-000000000999' WHERE user_id = '${USER}'`));
    await assert.rejects(db.exec(`DELETE FROM companies WHERE id = '${E_SET}'`));
  });

  test('companies is RLS-enabled, policy-free and has no browser grants', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'companies'`,
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    const policies = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'companies'`,
    );
    assert.equal(policies.rows[0]?.count, 0);
    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE table_name = 'companies' AND grantee IN ('anon','authenticated','PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  });

  test('a privileged system identity can never be given a company/team/position profile', async () => {
    // CEO and E-SET SITE_MANAGER are privileged SYSTEM accounts with no
    // organizational membership. The database - not just the application
    // - refuses to fabricate one for them, so no provisioning path or
    // operator script can satisfy the NOT NULL columns with an invented
    // E-SET company, Admin team, or "Site Manager" position.
    await db.exec(`INSERT INTO auth.users VALUES ('${PRIVILEGED_USER}')`);
    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${PRIVILEGED_USER}', '${TEAM_POSITION}')`);
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${PRIVILEGED_USER}', 'SITE_MANAGER', 'GRANTED')`);

    await assert.rejects(db.exec(`INSERT INTO workforce_profiles
      (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${PRIVILEGED_USER}', 'Privileged Person', '${TEAM_POSITION}', '${E_SET}')`),
      /privileged system access/);

    // A REVOKED grant leaves no active privilege, so the same person may
    // then hold an ordinary employee profile - status is derived from the
    // LATEST event per role, never from the presence of any event.
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${PRIVILEGED_USER}', 'SITE_MANAGER', 'REVOKED')`);
    await db.exec(`INSERT INTO workforce_profiles
      (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${PRIVILEGED_USER}', 'Now An Employee', '${TEAM_POSITION}', '${E_SET}')`);
    const kept = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM workforce_profiles WHERE user_id = '${PRIVILEGED_USER}'`,
    );
    assert.equal(kept.rows[0]?.count, 1);

    const guard = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT prosecdef, proconfig FROM pg_proc
        WHERE proname = 'workforce_profiles_reject_privileged_identity'`,
    );
    assert.equal(guard.rows[0]?.prosecdef, false, 'the guard is SECURITY INVOKER');
    assert.ok(guard.rows[0]?.proconfig?.includes('search_path=pg_catalog'));
  });

  test('the company foreign key is indexed on the referencing side', async () => {
    const index = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes
        WHERE tablename = 'workforce_profiles' AND indexname = 'workforce_profiles_company_idx'`,
    );
    assert.equal(index.rows[0]?.count, 1);
  });

  test('company created_at is DB-authoritative and its trigger is invoker-safe', async () => {
    await db.exec(`INSERT INTO companies (id, code, name, created_at)
      VALUES ('18000000-0000-4000-8000-000000000004', 'TEST_ONLY', 'Test Only', '1999-01-01')`);
    const row = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM companies WHERE code = 'TEST_ONLY'`,
    );
    assert.ok(row.rows[0]!.created_at.getUTCFullYear() > 2000);
    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'companies_authoritative_created_at'`,
    );
    assert.equal(fn.rows[0]?.prosecdef, false);
    assert.ok(fn.rows[0]?.proconfig?.includes('search_path=pg_catalog'));
  });
});

test('0018 fails before partial state when an existing profile has no authoritative company', async () => {
  const db = await createSupabaseSubstrate();
  try {
    await applyRealMigrations(db, 17);
    await seedAssignment(db);
    await db.exec(`INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
      VALUES ('${USER}', 'Existing Person', '${TEAM_POSITION}')`);
    const sql = await readFile(new URL('0018_employee_company_membership.sql', migrationsDirectory), 'utf8');
    await assert.rejects(async () => {
      await db.exec('BEGIN');
      try { await db.exec(sql); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    }, /authoritative company mapping/);
    const table = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'companies'`,
    );
    assert.equal(table.rows[0]?.count, 0);
    const column = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = 'workforce_profiles' AND column_name = 'company_id'`,
    );
    assert.equal(column.rows[0]?.count, 0);
  } finally { await db.close(); }
});
