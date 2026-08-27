import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Migration 0028, executed against the REAL 0001 -> 0027 chain in a
 * genuine PostgreSQL engine. Nothing here hand-builds a schema subset.
 *
 * 0028 exists because `bootstrapCeo.ts` originally left the CEO's
 * `must_change_password` at FALSE while every other provisioning path set
 * it TRUE, so the one account operating on an operator-chosen password
 * was the one account never asked to replace it. These tests pin the
 * scope of the correction - what it changes, and just as importantly what
 * it must leave alone.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const CEO = '10000000-0000-4000-8000-0000000000c0';
const CEO_ALREADY_CHANGED = '10000000-0000-4000-8000-0000000000c1';
const REVOKED_CEO = '10000000-0000-4000-8000-0000000000c2';
const PLAIN_USER = '10000000-0000-4000-8000-0000000000c3';
const DISABLED_CEO = '10000000-0000-4000-8000-0000000000c4';

async function substrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES
      ('${CEO}'), ('${CEO_ALREADY_CHANGED}'), ('${REVOKED_CEO}'),
      ('${PLAIN_USER}'), ('${DISABLED_CEO}');
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

async function migrationFile(id: number): Promise<string> {
  const prefix = String(id).padStart(4, '0') + '_';
  const names = (await readdir(migrationsDirectory)).filter((name) => name.startsWith(prefix));
  assert.equal(names.length, 1, `exactly one migration must carry id ${id}`);
  return readFile(new URL(names[0]!, migrationsDirectory), 'utf8');
}

async function applyThrough(db: PGlite, lastId: number): Promise<void> {
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
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
}

/** The world as it stood before 0028: a bootstrapped CEO owing no password change. */
async function seedPre0028(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO privileged_identities (user_id, display_name) VALUES
      ('${CEO}', 'Bootstrapped CEO'),
      ('${CEO_ALREADY_CHANGED}', 'Diligent CEO'),
      ('${REVOKED_CEO}', 'Former CEO'),
      ('${DISABLED_CEO}', 'Disabled CEO');

    INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason) VALUES
      ('${CEO}', 'CEO', 'GRANTED', NULL, 'bootstrap'),
      ('${CEO_ALREADY_CHANGED}', 'CEO', 'GRANTED', NULL, 'bootstrap'),
      ('${DISABLED_CEO}', 'CEO', 'GRANTED', NULL, 'bootstrap'),
      ('${REVOKED_CEO}', 'CEO', 'GRANTED', NULL, 'bootstrap');
    INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
      VALUES ('${REVOKED_CEO}', 'CEO', 'REVOKED', NULL, 'stepped down');

    -- Migration 0015 already backfilled an ACTIVE row for every
    -- auth.users id, so these are UPDATEs. That is the real shape of the
    -- production table this migration runs against.
    UPDATE app_user_access SET must_change_password = FALSE
     WHERE user_id IN ('${CEO}', '${CEO_ALREADY_CHANGED}', '${REVOKED_CEO}', '${PLAIN_USER}');
    UPDATE app_user_access SET state = 'DISABLED', must_change_password = FALSE
     WHERE user_id = '${DISABLED_CEO}';

    INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
      VALUES ('EMPLOYEE_PASSWORD_CHANGED', '${CEO_ALREADY_CHANGED}', '${CEO_ALREADY_CHANGED}');
  `);
}

async function owesChange(db: PGlite, userId: string): Promise<boolean> {
  const result = await db.query<{ must_change_password: boolean }>(
    'SELECT must_change_password FROM app_user_access WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]!.must_change_password;
}

test('0028 makes the already-bootstrapped CEO owe a first-login password change', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 27);
    await seedPre0028(db);
    assert.equal(await owesChange(db, CEO), false, 'precondition: the state the bug produced');

    await db.exec(await migrationFile(28));

    assert.equal(await owesChange(db, CEO), true);
  } finally {
    await db.close();
  }
});

test('0028 leaves every account it must not touch exactly as it found it', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 27);
    await seedPre0028(db);
    await db.exec(await migrationFile(28));

    // Already replaced the bootstrap password personally - not dragged
    // back through the forced-change screen.
    assert.equal(await owesChange(db, CEO_ALREADY_CHANGED), false);
    // No longer holds the grant; the latest event for them is REVOKED.
    assert.equal(await owesChange(db, REVOKED_CEO), false);
    // Never was privileged at all.
    assert.equal(await owesChange(db, PLAIN_USER), false);
    // A disabled account is not made to owe anything.
    assert.equal(await owesChange(db, DISABLED_CEO), false);
  } finally {
    await db.close();
  }
});

test('0028 is idempotent, and writes no audit row', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 27);
    await seedPre0028(db);
    const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM account_audit_events');

    await db.exec(await migrationFile(28));
    await db.exec(await migrationFile(28));

    assert.equal(await owesChange(db, CEO), true, 're-running must be a no-op, not an error');
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM account_audit_events');
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, '0028 must not write, alter or remove audit rows');
  } finally {
    await db.close();
  }
});

test('a CEO bootstrapped by the FIXED code is already correct, so 0028 changes nothing', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 27);
    await db.exec(`
      INSERT INTO privileged_identities (user_id, display_name) VALUES ('${CEO}', 'New CEO');
      INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
        VALUES ('${CEO}', 'CEO', 'GRANTED', NULL, 'bootstrap');
      UPDATE app_user_access SET must_change_password = TRUE WHERE user_id = '${CEO}';
    `);
    await db.exec(await migrationFile(28));
    assert.equal(await owesChange(db, CEO), true);
  } finally {
    await db.close();
  }
});

test('0028 creates no new object, so it adds no service_role or PUBLIC ACL surface', async () => {
  const db = await substrate();
  const countObjects = async (): Promise<number> => {
    const result = await db.query<{ n: number }>(`
      SELECT ((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
            + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))::int AS n`);
    return result.rows[0]!.n;
  };
  try {
    await applyThrough(db, 27);
    const before = await countObjects();
    await db.exec(await migrationFile(28));
    assert.equal(await countObjects(), before);
  } finally {
    await db.close();
  }
});
