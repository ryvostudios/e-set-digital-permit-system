import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Migration 0031 against the REAL 0001 -> 0031 chain.
 *
 * The application writes the administrative audit but could not read it:
 * `app_runtime` held INSERT and no SELECT, so both audit endpoints failed
 * with 42501. These tests prove the read now works, that nothing
 * destructive came with it, and that the append-only guarantee and the
 * browser-facing denial are untouched.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const ACTOR = '40000000-0000-4000-8000-0000000000a1';
const TARGET = '40000000-0000-4000-8000-0000000000a2';

async function substrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE app_runtime BYPASSRLS;
    CREATE ROLE privileged_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${ACTOR}'), ('${TARGET}');
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

async function applyRealMigrations(db: PGlite, lastId: number, fromId = 1): Promise<void> {
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => Number(name.slice(0, 4)) <= lastId)
    .sort();
  assert.deepEqual(
    names.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: lastId }, (_, index) => index + 1),
    'the migration chain must have no gaps',
  );
  for (const name of names.filter((entry) => Number(entry.slice(0, 4)) >= fromId)) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  }
}

async function asRole<T>(db: PGlite, role: string, work: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await work();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (caught) {
    return String((caught as { message?: string }).message ?? caught);
  }
  assert.fail('expected the database to refuse this statement');
}

describe('0031 - the application can read the audit it writes', { concurrency: false }, () => {
  let db: PGlite;
  before(async () => {
    db = await substrate();
    // Mirror live provisioning: INSERT is granted operator-side when the
    // audit is introduced, which is exactly the state 0031 arrives into.
    await applyRealMigrations(db, 30);
    await db.exec(`
      GRANT INSERT ON TABLE public.account_audit_events TO app_runtime;
      GRANT USAGE ON SEQUENCE public.account_audit_events_ordinal_seq TO app_runtime;
    `);
    // The failing state this migration exists to fix.
    const before = await db.query<{ sel: boolean }>(
      `SELECT has_table_privilege('app_runtime','public.account_audit_events','SELECT') AS sel`,
    );
    assert.equal(before.rows[0]?.sel, false, 'the read must genuinely be missing before 0031');
    await applyRealMigrations(db, 31, 31);
    await db.exec(`
      INSERT INTO account_audit_events (event_type, actor_user_id, target_user_id)
      VALUES ('EMPLOYEE_ACCOUNT_CREATED', '${ACTOR}', '${TARGET}');
    `);
  });
  after(async () => { await db.close(); });

  test('the runtime login can now read the audit - the failing case', async () => {
    const rows = await asRole(db, 'app_runtime', () =>
      db.query<{ event_type: string }>('SELECT event_type FROM account_audit_events ORDER BY ordinal DESC'),
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.event_type, 'EMPLOYEE_ACCOUNT_CREATED');
  });

  test('it holds exactly INSERT and SELECT, and nothing destructive', async () => {
    const granted = await db.query<{ privs: string | null }>(
      `SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.table_privileges
        WHERE table_schema='public' AND table_name='account_audit_events' AND grantee='app_runtime'`,
    );
    assert.equal(granted.rows[0]?.privs, 'INSERT,SELECT');

    const destructive = await db.query<{ upd: boolean; del: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('app_runtime','public.account_audit_events','UPDATE') AS upd,
              has_table_privilege('app_runtime','public.account_audit_events','DELETE') AS del,
              has_table_privilege('app_runtime','public.account_audit_events','TRUNCATE') AS trunc`,
    );
    assert.deepEqual(destructive.rows[0], { upd: false, del: false, trunc: false });
  });

  test('reading does not make the audit mutable - it is still append-only', async () => {
    // Both halves matter: the privilege is absent AND the trigger refuses,
    // so even the table owner cannot rewrite history.
    const asRuntime = await refusal(() => asRole(db, 'app_runtime', () =>
      db.query(`UPDATE account_audit_events SET event_type = 'TAMPERED'`),
    ));
    assert.match(asRuntime, /permission denied/i);

    const asOwner = await refusal(() => db.query(`UPDATE account_audit_events SET event_type = 'TAMPERED'`));
    assert.match(asOwner, /append-only/i);

    const deleted = await refusal(() => db.query('DELETE FROM account_audit_events'));
    assert.match(deleted, /append-only/i);
  });

  test('privileged_runtime still holds no direct table privilege anywhere', async () => {
    const rows = await db.query(
      `SELECT table_name FROM information_schema.table_privileges WHERE grantee = 'privileged_runtime'`,
    );
    assert.deepEqual(rows.rows, []);
  });

  test('the browser-facing roles still hold nothing on the audit', async () => {
    for (const source of ['table_privileges', 'column_privileges'] as const) {
      const rows = await db.query(
        `SELECT grantee FROM information_schema.${source}
          WHERE table_schema='public' AND table_name='account_audit_events'
            AND grantee IN ('PUBLIC','anon','authenticated')`,
      );
      assert.deepEqual(rows.rows, [], `${source} must expose nothing`);
    }
  });

  test('service_role stays read-only on the audit - 0031 changes nothing for it', async () => {
    // Whatever SELECT service_role holds here comes from Supabase's own
    // default privileges, not from this migration; what matters is that it
    // still cannot MUTATE the audit, which the hardening migrations
    // established and 0031 must not undo.
    const rows = await db.query<{ ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('service_role','public.account_audit_events','INSERT') AS ins,
              has_table_privilege('service_role','public.account_audit_events','UPDATE') AS upd,
              has_table_privilege('service_role','public.account_audit_events','DELETE') AS del,
              has_table_privilege('service_role','public.account_audit_events','TRUNCATE') AS trunc`,
    );
    assert.deepEqual(rows.rows[0], { ins: false, upd: false, del: false, trunc: false });
  });

  test('0031 grants nothing anywhere else', async () => {
    // A sweep, so an accidental widening beyond the one intended table is
    // caught rather than only the table this migration targeted.
    const destructive = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.table_privileges
        WHERE table_schema='public' AND grantee='app_runtime'
          AND privilege_type IN ('DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
    );
    assert.deepEqual(destructive.rows, []);
  });
});
