import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Migration 0030 against the REAL 0001 -> 0030 chain.
 *
 * 0030 exists because `app_runtime` could not UPDATE `jsas` at all, so
 * the JSA half of "Save Draft" failed with 42501. The fix has two parts
 * and both are tested here for BEHAVIOUR, not for the text of a GRANT:
 *
 *   - the runtime login can now perform exactly the statement
 *     `updateLinkedJsa` issues, and nothing wider;
 *   - JSA content is frozen at the database level once the linked permit
 *     stops being editable, so historical safety records cannot be
 *     rewritten even by a defective caller holding the grant.
 *
 * The second is the one that matters most: a privilege says which
 * columns, never when.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const APPLICANT = '30000000-0000-4000-8000-0000000000a1';

async function substrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE app_runtime BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${APPLICANT}');
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

async function applyRealMigrations(db: PGlite, lastId: number): Promise<void> {
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
  for (const name of names) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  }
}

/**
 * A permit and its JSA. The JSA is created WITH a payload because a
 * permit may not leave DRAFT while its JSA is empty (0016), and the
 * non-DRAFT statuses carry the timestamps their CHECKs require.
 */
async function seed(db: PGlite, status: string): Promise<{ permitId: string; jsaId: string }> {
  // Only the statuses that actually carry review/issue timestamps get them.
  const issued = ['DRAFT', 'PENDING_CORRECTION', 'PENDING_CRO'].includes(status)
    ? 'NULL, NULL, NULL'
    : "now(), now(), now() + INTERVAL '5 minutes'";
  const result = await db.query<{ id: string; jsa_id: string }>(`
    WITH new_jsa AS (
      INSERT INTO jsas (created_by, form_version, form_payload)
      VALUES ('${APPLICANT}', 'JSA_V1', '{"page1":{}}'::jsonb) RETURNING id
    )
    INSERT INTO permits (jsa_id, created_by, site_timezone, status, permit_type, form_version, form_payload,
                         issued_at, hse_review_started_at, hse_review_deadline_at)
    SELECT id, '${APPLICANT}', 'Asia/Karachi', '${status}', 'COLD_WORK', 'COLD_WORK_V1', '{}'::jsonb, ${issued}
      FROM new_jsa
    RETURNING id, jsa_id;
  `);
  const row = result.rows[0]!;
  return { permitId: row.id, jsaId: row.jsa_id };
}

/** The exact statement `updateLinkedJsa` issues. */
const SAVE_SQL = `UPDATE jsas
     SET form_version = $1, form_payload = $2::jsonb, site_or_wtg = $3, job_description = $4
   WHERE id = $5`;

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

describe('0030 - least-privilege JSA draft writes', { concurrency: false }, () => {
  let db: PGlite;
  before(async () => {
    db = await substrate();
    await applyRealMigrations(db, 30);
    // The privileges `app_runtime` already held before 0030. Only the
    // column-level UPDATE is new, and it comes from the migration itself.
    await db.exec(`
      GRANT SELECT, INSERT ON TABLE public.jsas TO app_runtime;
      GRANT SELECT, INSERT, UPDATE ON TABLE public.permits TO app_runtime;
    `);
  });
  after(async () => { await db.close(); });

  test('the runtime login can perform the exact legitimate DRAFT JSA save', async () => {
    const { jsaId } = await seed(db, 'DRAFT');
    await asRole(db, 'app_runtime', async () => {
      await db.query(SAVE_SQL, ['JSA_V2', '{"page1":{"a":1},"page2":{}}', 'WTG A07', 'Blade inspection', jsaId]);
    });
    const stored = await db.query<{ form_version: string; site_or_wtg: string; job_description: string }>(
      'SELECT form_version, site_or_wtg, job_description FROM jsas WHERE id = $1',
      [jsaId],
    );
    assert.equal(stored.rows[0]?.form_version, 'JSA_V2');
    assert.equal(stored.rows[0]?.site_or_wtg, 'WTG A07');
    assert.equal(stored.rows[0]?.job_description, 'Blade inspection');
  });

  test('a permit returned for correction keeps an editable JSA', async () => {
    // The database rule must match the application constant
    // EDITABLE_STATUSES, or the CRO correction path would be refused by
    // the very guard meant to protect history.
    const { jsaId } = await seed(db, 'PENDING_CORRECTION');
    await asRole(db, 'app_runtime', async () => {
      await db.query(SAVE_SQL, ['JSA_V2', '{"corrected":true}', 'WTG B11', 'Corrected scope', jsaId]);
    });
    const stored = await db.query<{ job_description: string }>(
      'SELECT job_description FROM jsas WHERE id = $1', [jsaId],
    );
    assert.equal(stored.rows[0]?.job_description, 'Corrected scope');
  });

  test('the grant is exactly four columns and never a table privilege', async () => {
    const columns = await db.query<{ granted: string | null }>(
      `SELECT string_agg(column_name, ', ' ORDER BY column_name) AS granted
         FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'jsas'
          AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'`,
    );
    assert.equal(columns.rows[0]?.granted, 'form_payload, form_version, job_description, site_or_wtg');

    const table = await db.query<{ upd: boolean; del: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'public.jsas', 'UPDATE') AS upd,
              has_table_privilege('app_runtime', 'public.jsas', 'DELETE') AS del,
              has_table_privilege('app_runtime', 'public.jsas', 'TRUNCATE') AS trunc`,
    );
    assert.deepEqual(table.rows[0], { upd: false, del: false, trunc: false });
  });

  test('the runtime login cannot update unrelated JSA columns', async () => {
    const { jsaId } = await seed(db, 'DRAFT');
    for (const column of ['created_by', 'jsa_sequence', 'created_at', 'updated_at', 'id']) {
      const privilege = await db.query<{ allowed: boolean }>(
        `SELECT has_column_privilege('app_runtime', 'public.jsas', $1, 'UPDATE') AS allowed`,
        [column],
      );
      assert.equal(privilege.rows[0]?.allowed, false, `${column} must not be updatable`);
    }
    // Not merely a catalog claim - the engine refuses the statement.
    const message = await refusal(() => asRole(db, 'app_runtime', () =>
      db.query(`UPDATE jsas SET created_by = $1 WHERE id = $2`, [APPLICANT, jsaId]),
    ));
    assert.match(message, /permission denied/i);
  });

  test('the runtime login cannot delete a JSA', async () => {
    const { jsaId } = await seed(db, 'DRAFT');
    const message = await refusal(() => asRole(db, 'app_runtime', () =>
      db.query('DELETE FROM jsas WHERE id = $1', [jsaId]),
    ));
    assert.match(message, /permission denied/i);
    const survivors = await db.query('SELECT 1 FROM jsas WHERE id = $1', [jsaId]);
    assert.equal(survivors.rows.length, 1);
  });

  test('an issued permit freezes its JSA content', async () => {
    const { jsaId } = await seed(db, 'ISSUED');
    const message = await refusal(() => asRole(db, 'app_runtime', () =>
      db.query(SAVE_SQL, ['JSA_V2', '{"rewritten":true}', 'X', 'Rewritten history', jsaId]),
    ));
    assert.match(message, /cannot be changed while a linked permit is ISSUED/);
    const stored = await db.query<{ job_description: string | null }>(
      'SELECT job_description FROM jsas WHERE id = $1', [jsaId],
    );
    assert.notEqual(stored.rows[0]?.job_description, 'Rewritten history');
  });

  test('a submitted permit freezes its JSA even for the table owner', async () => {
    // The point of putting this in the database: a defective caller, a
    // future route, or a privileged session cannot rewrite a historical
    // JSA. Only a superuser disabling triggers could, which is why the
    // guard is a trigger rather than application code.
    const { jsaId } = await seed(db, 'PENDING_CRO');
    const message = await refusal(() =>
      db.query(SAVE_SQL, ['JSA_V2', '{"x":1}', 'X', 'Owner rewrite', jsaId]),
    );
    assert.match(message, /cannot be changed while a linked permit is PENDING_CRO/);
  });

  test('one issued permit in a renewal lineage freezes the shared JSA', async () => {
    // A renewal reuses the SAME jsa row, so a JSA can be reachable from a
    // DRAFT permit while an ISSUED permit already relies on it. The rule
    // is universal over linked permits, not existential.
    const { jsaId } = await seed(db, 'ISSUED');
    await db.exec(`
      INSERT INTO permits (jsa_id, created_by, site_timezone, status, permit_type, form_version, form_payload)
      VALUES ('${jsaId}', '${APPLICANT}', 'Asia/Karachi', 'DRAFT', 'COLD_WORK', 'COLD_WORK_V1', '{}'::jsonb);
    `);
    const message = await refusal(() => asRole(db, 'app_runtime', () =>
      db.query(SAVE_SQL, ['JSA_V2', '{"y":1}', 'Y', 'Via the draft renewal', jsaId]),
    ));
    assert.match(message, /cannot be changed while a linked permit is ISSUED/);
  });

  test('an update that changes no content is not challenged', async () => {
    // The guard must fire on real content mutation only, or the
    // timestamp trigger from 0016 would make ordinary writes fail.
    const { jsaId } = await seed(db, 'ISSUED');
    await db.query('UPDATE jsas SET form_version = form_version WHERE id = $1', [jsaId]);
  });

  test('service_role still cannot mutate a JSA', async () => {
    const { jsaId } = await seed(db, 'DRAFT');
    const privileges = await db.query<{ upd: boolean; del: boolean; ins: boolean }>(
      `SELECT has_table_privilege('service_role', 'public.jsas', 'UPDATE') AS upd,
              has_table_privilege('service_role', 'public.jsas', 'DELETE') AS del,
              has_table_privilege('service_role', 'public.jsas', 'INSERT') AS ins`,
    );
    assert.deepEqual(privileges.rows[0], { upd: false, del: false, ins: false });
    const message = await refusal(() => asRole(db, 'service_role', () =>
      db.query(SAVE_SQL, ['JSA_V2', '{}', 'X', 'service_role rewrite', jsaId]),
    ));
    assert.match(message, /permission denied/i);
  });

  test('anon, authenticated and PUBLIC hold nothing on jsas', async () => {
    const table = await db.query(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'jsas'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
    );
    assert.deepEqual(table.rows, []);
    const columns = await db.query(
      `SELECT grantee, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'jsas'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
    );
    assert.deepEqual(columns.rows, []);
  });

  test('row-level security and the guard trigger are both in place', async () => {
    const rls = await db.query<{ enabled: boolean }>(
      `SELECT c.relrowsecurity AS enabled FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'jsas'`,
    );
    assert.equal(rls.rows[0]?.enabled, true);
    const trigger = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'jsas_content_editable_only_trigger' AND NOT tgisinternal`,
    );
    assert.equal(trigger.rows.length, 1);
  });

  test('0030 grants the runtime login nothing beyond the JSA content columns', async () => {
    // A privilege sweep, so an accidental widening anywhere in this
    // migration is caught rather than only the one table it targeted.
    const wide = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND grantee = 'app_runtime'
          AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`,
    );
    assert.deepEqual(wide.rows, []);
  });
});
