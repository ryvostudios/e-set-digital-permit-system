import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Audit immutability, proved against the REAL migration chain.
 *
 * The rule is that the audit is append-only for EVERYONE - the CEO
 * included. A CEO may READ the administrative audit and may cause NEW
 * events to be appended, but may never rewrite actor, timestamp, or
 * history, and may never remove an event.
 *
 * These attempts run as the migration owner inside PGlite, which is a
 * STRONGER statement than "the CEO cannot": the CEO reaches the database
 * only as `app_runtime`, which holds strictly less authority than the
 * owner used here. If even the owner is refused, no application role can
 * succeed. Enforcement therefore does not depend on any route, any
 * middleware, or any role check remaining correct.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const CEO = '10000000-0000-4000-8000-0000000000c0';
const TARGET = '10000000-0000-4000-8000-0000000000c1';

/** Every append-only audit/event log the system keeps. */
const AUDIT_TABLES = ['privileged_access_events', 'account_audit_events', 'permit_lifecycle_events'] as const;

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${CEO}'), ('${TARGET}');
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

  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));

  // One real event in each log to attempt to tamper with.
  await db.exec(`
    INSERT INTO privileged_identities (user_id, display_name) VALUES ('${CEO}', 'The CEO');
    INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
      VALUES ('${CEO}', 'CEO', 'GRANTED', NULL, 'bootstrap');
    INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
      VALUES ('EMPLOYEE_ACCOUNT_CREATED', '${TARGET}', '${CEO}');
  `);
  return db;
}

async function refuses(db: PGlite, sql: string): Promise<boolean> {
  try {
    await db.exec(sql);
    return false;
  } catch {
    return true;
  }
}

/**
 * The two logs this harness can populate without standing up a whole
 * permit. `forbid_mutation()` is a BEFORE ... FOR EACH ROW trigger, so it
 * only fires where a row exists - which is why the populated logs prove
 * the function actually raises, and the trigger-installation test below
 * proves it is wired to the third one too.
 */
const POPULATED_AUDIT_TABLES = ['privileged_access_events', 'account_audit_events'] as const;

test('a populated audit log refuses UPDATE - not even the database owner may rewrite an actor', async () => {
  const db = await migratedDatabase();
  try {
    for (const table of POPULATED_AUDIT_TABLES) {
      assert.ok(
        await refuses(db, `UPDATE ${table} SET actor_user_id = '${TARGET}'`),
        `${table} must refuse UPDATE - rewriting an actor is exactly the tampering the audit exists to prevent`,
      );
    }
  } finally {
    await db.close();
  }
});

test('a populated audit log refuses DELETE', async () => {
  const db = await migratedDatabase();
  try {
    for (const table of POPULATED_AUDIT_TABLES) {
      assert.ok(await refuses(db, `DELETE FROM ${table}`), `${table} must refuse DELETE`);
    }
  } finally {
    await db.close();
  }
});

test('EVERY audit log refuses TRUNCATE, including one with no rows', async () => {
  // TRUNCATE is guarded by a STATEMENT-level trigger, so this holds
  // whether or not the log currently has rows - `permit_lifecycle_events`
  // is empty here and must still refuse.
  const db = await migratedDatabase();
  try {
    for (const table of AUDIT_TABLES) {
      assert.ok(await refuses(db, `TRUNCATE ${table}`), `${table} must refuse TRUNCATE`);
    }
  } finally {
    await db.close();
  }
});

test('EVERY audit log carries the append-only guard on both UPDATE and DELETE', async () => {
  // Asserted from the catalog rather than by attempting a mutation, so
  // the guarantee also covers `permit_lifecycle_events`, which this
  // harness has no rows for. A log that lost its trigger would pass a
  // "no rows were changed" check while being wide open in production.
  const db = await migratedDatabase();
  try {
    for (const table of AUDIT_TABLES) {
      const result = await db.query<{ tgname: string; on_update: boolean; on_delete: boolean }>(
        `SELECT t.tgname,
                (t.tgtype & 16) <> 0 AS on_update,
                (t.tgtype & 8)  <> 0 AS on_delete
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE c.relname = $1 AND NOT t.tgisinternal AND p.proname = 'forbid_mutation'`,
        [table],
      );
      const guards = result.rows;
      assert.ok(guards.length > 0, `${table} must carry a forbid_mutation() trigger`);
      assert.ok(guards.some((g) => g.on_update), `${table} must guard UPDATE`);
      assert.ok(guards.some((g) => g.on_delete), `${table} must guard DELETE`);
    }
  } finally {
    await db.close();
  }
});

test('the CEO grant that authorises reading the audit cannot itself be rewritten or erased', async () => {
  // Otherwise "only the CEO may read the audit" would be circular: the
  // holder could edit the very log that decides who the CEO is.
  const db = await migratedDatabase();
  try {
    assert.ok(await refuses(db, `UPDATE privileged_access_events SET action = 'REVOKED' WHERE user_id = '${CEO}'`));
    assert.ok(await refuses(db, `UPDATE privileged_access_events SET user_id = '${TARGET}'`));
    assert.ok(await refuses(db, `DELETE FROM privileged_access_events WHERE user_id = '${CEO}'`));

    const remaining = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM privileged_access_events WHERE user_id = $1 AND action = 'GRANTED'`,
      [CEO],
    );
    assert.equal(remaining.rows[0]!.n, 1, 'the original grant must survive every attempt untouched');
  } finally {
    await db.close();
  }
});

test('appending a NEW audit event still works - immutable is not read-only', async () => {
  // A CEO correction must be able to record itself. Immutability forbids
  // rewriting history, not adding to it.
  const db = await migratedDatabase();
  try {
    await db.exec(`
      INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
        VALUES ('EMPLOYEE_PASSWORD_RESET_BY_MANAGER', '${TARGET}', '${CEO}');
    `);
    const events = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM account_audit_events WHERE target_user_id = $1',
      [TARGET],
    );
    assert.equal(events.rows[0]!.n, 2);
  } finally {
    await db.close();
  }
});

test('the audit timestamp is the database s own, not whatever a caller supplies', async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id, created_at)
        VALUES ('EMPLOYEE_ACCOUNT_CREATED', '${TARGET}', '${CEO}', TIMESTAMPTZ '1999-01-01 00:00:00+00');
    `);
    const forged = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM account_audit_events WHERE created_at < TIMESTAMPTZ '2000-01-01 00:00:00+00'`,
    );
    assert.equal(forged.rows[0]!.n, 0, 'migration 0017 must overwrite a supplied timestamp with now()');
  } finally {
    await db.close();
  }
});
