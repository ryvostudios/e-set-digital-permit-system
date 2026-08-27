import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { QueryResultRow } from 'pg';
import { searchPermits } from './search.js';
import { listOwnDrafts } from './service.js';
import type { QueryFn } from '../../db/pool.js';

/**
 * `searchPermits` against a REAL PostgreSQL engine and the REAL migration
 * chain.
 *
 * WHY THIS FILE EXISTS. Every other search test stubs the query function,
 * so it sees the SQL string and the parameter array but never asks
 * PostgreSQL whether they agree. They cannot: a stub happily accepts a
 * statement whose text references no placeholders while two parameters
 * are bound to it.
 *
 * That is exactly the defect this file was written for. With broad
 * visibility the access predicate collapses to the literal `TRUE`, and
 * `viewerId`/`allowedStatuses` were bound anyway - leaving them
 * unreferenced. PostgreSQL rejects that outright:
 *
 *   rows  -> "could not determine data type of parameter $1"
 *   count -> "bind message supplies 2 parameters, but prepared
 *             statement \"\" requires 0"
 *
 * So every broad-visibility read - a CEO's or Site Manager's
 * `/permits/mine`, and the Records screen for anyone holding
 * `permit.view_all` - returned 500 in production while 434 permit tests
 * passed. Only a real engine catches it, which is why this file uses one.
 */

const migrationsDirectory = new URL('../../../../database/migrations/', import.meta.url);

const CEO = '10000000-0000-4000-8000-0000000000c0';
const SITE_MANAGER = '10000000-0000-4000-8000-0000000000c1';
const EMPLOYEE = '10000000-0000-4000-8000-0000000000e0';
const OTHER_EMPLOYEE = '10000000-0000-4000-8000-0000000000e1';

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
    INSERT INTO auth.users VALUES ('${CEO}'), ('${SITE_MANAGER}'), ('${EMPLOYEE}'), ('${OTHER_EMPLOYEE}');
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
  return db;
}

/** Adapts PGlite to the `QueryFn` the search module actually calls. */
function queryFnFor(db: PGlite): QueryFn {
  return (async <T extends QueryResultRow>(text: string, params: unknown[] = []) => {
    const result = await db.query<T>(text, params);
    return { rows: result.rows, rowCount: result.rows.length, command: '', oid: 0, fields: [] };
  }) as QueryFn;
}

/** One permit owned by `owner`, created through the real schema. */
/**
 * Defaults to ISSUED, not DRAFT, because Permit Records now excludes
 * drafts unconditionally - a visibility test seeded with drafts would
 * pass vacuously (everything is empty) and prove nothing about the
 * access predicate it exists to check. Tests about the draft rule itself
 * pass their status explicitly.
 */
async function seedPermit(db: PGlite, owner: string, status = 'ISSUED'): Promise<void> {
  // Only ISSUED carries the timestamps its CHECK constraints require;
  // DRAFT and the PENDING_* states must leave them null.
  const issued = status === 'ISSUED'
    ? "now(), now(), now() + INTERVAL '5 minutes'"
    : 'NULL, NULL, NULL';
  await db.exec(`
    WITH new_jsa AS (
      INSERT INTO jsas (created_by, form_version, form_payload)
      VALUES ('${owner}', 'JSA_V1', '{}'::jsonb) RETURNING id
    )
    INSERT INTO permits (jsa_id, created_by, site_timezone, status, permit_type, form_version, form_payload,
                         issued_at, hse_review_started_at, hse_review_deadline_at)
    SELECT id, '${owner}', 'Asia/Karachi', '${status}', 'COLD_WORK', 'COLD_WORK_V1', '{}'::jsonb, ${issued} FROM new_jsa;
  `);
}

const PAGE = { page: 1, pageSize: 5 };

test('a CEO with zero permits gets an empty page, not a database error', async () => {
  const db = await migratedDatabase();
  try {
    const page = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      {},
      PAGE,
      { query: queryFnFor(db) },
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.totalCount, 0);
    assert.equal(page.totalPages, 0);
    assert.equal(page.hasNextPage, false);
  } finally {
    await db.close();
  }
});

test('a Site Manager with zero permits gets an empty page too', async () => {
  const db = await migratedDatabase();
  try {
    const page = await searchPermits(
      { viewerId: SITE_MANAGER, allowedStatuses: [], viewAll: true },
      {},
      PAGE,
      { query: queryFnFor(db) },
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.totalCount, 0);
  } finally {
    await db.close();
  }
});

test('a privileged applicant sees the permit they applied for', async () => {
  const db = await migratedDatabase();
  try {
    await seedPermit(db, CEO);
    const page = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      {},
      PAGE,
      { query: queryFnFor(db) },
    );
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.created_by, CEO);
    assert.equal(page.totalCount, 1);
  } finally {
    await db.close();
  }
});

test('broad visibility still works once a FILTER is applied - the parameters stay correctly numbered', async () => {
  // The original defect survived filters too: $1/$2 remained unreferenced
  // however many filters were appended, so this is not merely the
  // zero-filter case restated.
  const db = await migratedDatabase();
  try {
    await seedPermit(db, CEO);
    await seedPermit(db, EMPLOYEE);
    const q = queryFnFor(db);

    const issued = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      { status: 'ISSUED' },
      PAGE,
      { query: q },
    );
    assert.equal(issued.totalCount, 2, 'broad visibility spans records belonging to other people');

    // A status these records genuinely are not - DRAFT is no longer a
    // reachable Permit Records status at all, so a real one is used here.
    const closed = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      { status: 'CLOSED' },
      PAGE,
      { query: q },
    );
    assert.equal(closed.totalCount, 0);

    const byOwner = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      { createdBy: EMPLOYEE, status: 'ISSUED' },
      PAGE,
      { query: q },
    );
    assert.equal(byOwner.totalCount, 1, 'two filters together must also stay correctly numbered');
    assert.equal(byOwner.items[0]!.created_by, EMPLOYEE);
  } finally {
    await db.close();
  }
});

test('a NORMAL employee is unchanged: own permits only, never anyone else\'s', async () => {
  const db = await migratedDatabase();
  try {
    await seedPermit(db, EMPLOYEE);
    await seedPermit(db, OTHER_EMPLOYEE);
    const q = queryFnFor(db);

    const mine = await searchPermits(
      { viewerId: EMPLOYEE, allowedStatuses: [] },
      {},
      PAGE,
      { query: q },
    );
    assert.equal(mine.totalCount, 1, 'an ordinary caller sees exactly their own permit');
    assert.equal(mine.items[0]!.created_by, EMPLOYEE);
  } finally {
    await db.close();
  }
});

test('the fix did not widen access: a filter cannot reach another person\'s permit without broad visibility', async () => {
  const db = await migratedDatabase();
  try {
    await seedPermit(db, OTHER_EMPLOYEE);
    const q = queryFnFor(db);

    // Naming someone else's permit explicitly must still return nothing -
    // the access predicate is ANDed in first and only ever narrows.
    const idor = await searchPermits(
      { viewerId: EMPLOYEE, allowedStatuses: [] },
      { createdBy: OTHER_EMPLOYEE },
      PAGE,
      { query: q },
    );
    assert.equal(idor.totalCount, 0);
    assert.deepEqual(idor.items, []);

    const bySequence = await searchPermits(
      { viewerId: EMPLOYEE, allowedStatuses: [] },
      { permitNumber: 1 },
      PAGE,
      { query: q },
    );
    assert.equal(bySequence.totalCount, 0, 'permit-number lookup must not enumerate past the access predicate');
  } finally {
    await db.close();
  }
});

test('Permit Records EXCLUDES drafts, even for a broad-visibility caller', async () => {
  // The property that matters: broad record visibility must not surface
  // someone else's unfinished safety document.
  const db = await migratedDatabase();
  try {
    await seedPermit(db, EMPLOYEE, 'DRAFT');
    await seedPermit(db, OTHER_EMPLOYEE, 'DRAFT');
    await seedPermit(db, OTHER_EMPLOYEE, 'ISSUED');
    const q = queryFnFor(db);

    const records = await searchPermits(
      { viewerId: CEO, allowedStatuses: [], viewAll: true },
      {},
      PAGE,
      { query: q },
    );
    assert.equal(records.totalCount, 1, 'only the formal record');
    assert.equal(records.items[0]!.status, 'ISSUED');

  } finally {
    await db.close();
  }
});

test("My Drafts returns ONLY the caller's own drafts, whatever authority they hold", async () => {
  const db = await migratedDatabase();
  try {
    await seedPermit(db, EMPLOYEE, 'DRAFT');
    await seedPermit(db, OTHER_EMPLOYEE, 'DRAFT');
    await seedPermit(db, OTHER_EMPLOYEE, 'DRAFT');
    await seedPermit(db, EMPLOYEE, 'ISSUED');
    const q = queryFnFor(db);

    const mine = await listOwnDrafts(EMPLOYEE, PAGE, { query: q } as never);
    assert.equal(mine.totalCount, 1, 'own drafts only - and not own ISSUED permit');
    assert.equal(mine.items[0]!.created_by, EMPLOYEE);

    // A CEO has broad record visibility and still sees none of theirs.
    const ceo = await listOwnDrafts(CEO, PAGE, { query: q } as never);
    assert.equal(ceo.totalCount, 0, "broad visibility must not widen someone else's drafts into view");
  } finally {
    await db.close();
  }
});

test('an allowed-status reviewer still sees that status without broad visibility', async () => {
  const db = await migratedDatabase();
  try {
    await seedPermit(db, OTHER_EMPLOYEE, 'PENDING_CRO');
    const page = await searchPermits(
      { viewerId: EMPLOYEE, allowedStatuses: ['PENDING_CRO'] },
      {},
      PAGE,
      { query: queryFnFor(db) },
    );
    assert.equal(page.totalCount, 1, 'the ANY($2) branch must still bind and match');
  } finally {
    await db.close();
  }
});
