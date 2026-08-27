import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Migration 0029 against the REAL 0001 -> 0029 chain.
 *
 * 0029 widens two CHECKs so the authoritative V2 form contract can be
 * stored beside the live V1 one. What matters is not the text of the
 * constraint but its behaviour, so these tests store real rows: a V1
 * permit written before the migration must still be valid after it, a V2
 * permit must become storable, and a cross-version combination must stay
 * impossible.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const APPLICANT = '10000000-0000-4000-8000-0000000000a0';

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

async function migrationNames(): Promise<string[]> {
  return (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function applyThrough(db: PGlite, lastId: number): Promise<void> {
  const names = (await migrationNames()).filter((name) => Number(name.slice(0, 4)) <= lastId);
  assert.deepEqual(
    names.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: lastId }, (_, index) => index + 1),
    'the migration chain must have no gaps',
  );
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
}

/** Inserts one DRAFT permit with the given type/version. Returns whether the database accepted it. */
async function tryStorePermit(db: PGlite, permitType: string, formVersion: string): Promise<boolean> {
  try {
    await db.exec(`
      WITH new_jsa AS (INSERT INTO jsas (created_by) VALUES ('${APPLICANT}') RETURNING id)
      INSERT INTO permits (jsa_id, created_by, site_timezone, status, permit_type, form_version, form_payload)
      SELECT id, '${APPLICANT}', 'Asia/Karachi', 'DRAFT', '${permitType}', '${formVersion}', '{}'::jsonb
        FROM new_jsa;
    `);
    return true;
  } catch {
    return false;
  }
}

async function tryStoreJsaVersion(db: PGlite, formVersion: string): Promise<boolean> {
  try {
    await db.exec(`
      INSERT INTO jsas (created_by, form_version, form_payload)
      VALUES ('${APPLICANT}', '${formVersion}', '{}'::jsonb);
    `);
    return true;
  } catch {
    return false;
  }
}

test('the whole chain 0001 -> 0029 applies cleanly', async () => {
  const db = await substrate();
  try {
    const names = await migrationNames();
    // 0029 must be the 29th link in a gapless chain. The TOTAL number of
    // migrations is deliberately not pinned here - later migrations are
    // expected, and each one asserts its own position.
    assert.ok(names.length >= 29, 'the chain must reach at least 0029');
    assert.match(names[28]!, /^0029_/);
    assert.deepEqual(
      names.slice(0, 29).map((name) => Number(name.slice(0, 4))),
      Array.from({ length: 29 }, (_, index) => index + 1),
      'the chain through 0029 must have no gaps',
    );
    await applyThrough(db, 29);
  } finally {
    await db.close();
  }
});

test('a V1 permit stored BEFORE 0029 is still valid AFTER it', async () => {
  // The real risk of widening a CHECK is that ADD CONSTRAINT re-validates
  // existing rows. Store V1 content first, then migrate onto it.
  const db = await substrate();
  try {
    await applyThrough(db, 28);
    assert.ok(await tryStorePermit(db, 'WTG_WORK', 'WTG_WORK_V1'), 'precondition: V1 storable before 0029');
    assert.ok(await tryStoreJsaVersion(db, 'JSA_V1'));

    const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM permits');
    await db.exec(await readFile(new URL('0029_permit_form_version_v2.sql', migrationsDirectory), 'utf8'));
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM permits');

    assert.equal(after.rows[0]!.n, before.rows[0]!.n, '0029 must not remove or rewrite a stored permit');
    const stored = await db.query<{ form_version: string }>('SELECT form_version FROM permits');
    assert.equal(stored.rows[0]!.form_version, 'WTG_WORK_V1', 'the stored version is untouched');
  } finally {
    await db.close();
  }
});

test('after 0029 every permit type accepts BOTH its V1 and its V2 version', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 29);
    for (const [type, v1, v2] of [
      ['WTG_WORK', 'WTG_WORK_V1', 'WTG_WORK_V2'],
      ['COLD_WORK', 'COLD_WORK_V1', 'COLD_WORK_V2'],
      ['HOT_WORK', 'HOT_WORK_V1', 'HOT_WORK_V2'],
      ['CONFINED_SPACE_ENTRY', 'CONFINED_SPACE_ENTRY_V1', 'CONFINED_SPACE_ENTRY_V2'],
    ] as const) {
      assert.ok(await tryStorePermit(db, type, v1), `${type} must still accept ${v1}`);
      assert.ok(await tryStorePermit(db, type, v2), `${type} must now accept ${v2}`);
    }
  } finally {
    await db.close();
  }
});

test('after 0029 a JSA accepts JSA_V1 and JSA_V2, and nothing else', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 29);
    assert.ok(await tryStoreJsaVersion(db, 'JSA_V1'));
    assert.ok(await tryStoreJsaVersion(db, 'JSA_V2'));
    assert.equal(await tryStoreJsaVersion(db, 'JSA_V3'), false, 'an unknown JSA version stays rejected');
  } finally {
    await db.close();
  }
});

test('widening is PER TYPE - a cross-version combination is still impossible', async () => {
  // The failure mode to avoid: widening into a flat "any known version"
  // list, which would let a WTG_WORK permit carry COLD_WORK_V2.
  const db = await substrate();
  try {
    await applyThrough(db, 29);
    for (const [type, wrongVersion] of [
      ['WTG_WORK', 'COLD_WORK_V2'],
      ['COLD_WORK', 'WTG_WORK_V2'],
      ['HOT_WORK', 'CONFINED_SPACE_ENTRY_V2'],
      ['CONFINED_SPACE_ENTRY', 'HOT_WORK_V1'],
    ] as const) {
      assert.equal(
        await tryStorePermit(db, type, wrongVersion),
        false,
        `${type} must never accept ${wrongVersion}`,
      );
    }
    assert.equal(await tryStorePermit(db, 'WTG_WORK', 'WTG_WORK_V3'), false, 'an unknown version stays rejected');
  } finally {
    await db.close();
  }
});

test('0029 creates no object and changes no privilege', async () => {
  const db = await substrate();
  const countObjects = async (): Promise<number> => {
    const result = await db.query<{ n: number }>(`
      SELECT ((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
            + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))::int AS n`);
    return result.rows[0]!.n;
  };
  const grantCount = async (): Promise<number> => {
    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_schema = 'public'`,
    );
    return result.rows[0]!.n;
  };
  try {
    await applyThrough(db, 28);
    const objectsBefore = await countObjects();
    const grantsBefore = await grantCount();

    await db.exec(await readFile(new URL('0029_permit_form_version_v2.sql', migrationsDirectory), 'utf8'));

    assert.equal(await countObjects(), objectsBefore, '0029 must create no table or function');
    assert.equal(await grantCount(), grantsBefore, '0029 must grant and revoke nothing');
  } finally {
    await db.close();
  }
});

test('RLS stays enabled on permits and jsas across 0029', async () => {
  const db = await substrate();
  try {
    await applyThrough(db, 29);
    const result = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('permits', 'jsas')`,
    );
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must keep RLS enabled`);
    }
  } finally {
    await db.close();
  }
});
