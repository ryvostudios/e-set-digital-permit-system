import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL('../../../database/migrations/0033_per_permit_type_numbering.sql', import.meta.url);
const resetUrl = new URL('../../../database/maintenance/uat_reset_permit_numbering.sql', import.meta.url);

const TYPES = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const;

/**
 * Migration 0033 - each permit type gets its own number series, the JSA
 * series stays global, and no existing record is renumbered.
 *
 * The pre-0033 shape below is what 0006 + 0016 leave behind, reduced to
 * the columns and constraints this migration touches - the same approach
 * the 0015/0016/0032 specs use, so these exercise the REAL migration SQL
 * rather than a paraphrase of it.
 */
async function createPre0033Db(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SEQUENCE permit_number_seq AS BIGINT START WITH 1;
    CREATE SEQUENCE jsa_number_seq AS BIGINT START WITH 1;

    CREATE TABLE jsas (
      id SERIAL PRIMARY KEY,
      jsa_sequence BIGINT NOT NULL DEFAULT nextval('jsa_number_seq'),
      CONSTRAINT jsas_jsa_sequence_unique UNIQUE (jsa_sequence)
    );
    ALTER SEQUENCE jsa_number_seq OWNED BY jsas.jsa_sequence;

    CREATE TABLE permits (
      id SERIAL PRIMARY KEY,
      permit_sequence BIGINT NOT NULL DEFAULT nextval('permit_number_seq'),
      jsa_id INTEGER NOT NULL REFERENCES jsas (id),
      permit_type TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      previous_permit_id INTEGER REFERENCES permits (id),
      issued_at TIMESTAMPTZ,
      CONSTRAINT permits_permit_sequence_unique UNIQUE (permit_sequence),
      CONSTRAINT permits_permit_type_valid CHECK (
        permit_type IS NULL OR permit_type IN ('WTG_WORK','COLD_WORK','HOT_WORK','CONFINED_SPACE_ENTRY')
      )
    );
    ALTER SEQUENCE permit_number_seq OWNED BY permits.permit_sequence;
  `);
  return db;
}

const applyMigration = async (db: PGlite): Promise<void> => {
  await db.exec(await readFile(migrationUrl, 'utf8'));
};

async function migratedDb(): Promise<PGlite> {
  const db = await createPre0033Db();
  await applyMigration(db);
  return db;
}

/** Creates a permit exactly the way the application does: JSA first, then the permit, naming no number. */
async function createPermit(db: PGlite, permitType: string | null): Promise<{ permit: number; jsa: number }> {
  const jsa = await db.query<{ id: number; jsa_sequence: string }>(
    'INSERT INTO jsas DEFAULT VALUES RETURNING id, jsa_sequence',
  );
  const permit = await db.query<{ permit_sequence: string }>(
    'INSERT INTO permits (jsa_id, permit_type) VALUES ($1, $2) RETURNING permit_sequence',
    [jsa.rows[0]!.id, permitType],
  );
  return { permit: Number(permit.rows[0]!.permit_sequence), jsa: Number(jsa.rows[0]!.jsa_sequence) };
}

// ---------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------

test('each permit type is numbered from 1, independently', async () => {
  const db = await migratedDb();
  try {
    for (const type of TYPES) {
      assert.equal((await createPermit(db, type)).permit, 1, `${type} must start at 1`);
    }
    // Cold #1 and Hot #1 coexist - that is the whole point.
    const rows = await db.query<{ permit_type: string; permit_sequence: string | number }>(
      'SELECT permit_type, permit_sequence FROM permits ORDER BY permit_type',
    );
    assert.equal(rows.rows.length, 4);
    assert.ok(rows.rows.every((row) => Number(row.permit_sequence) === 1));

    // ...and each advances on its own.
    assert.equal((await createPermit(db, 'COLD_WORK')).permit, 2);
    assert.equal((await createPermit(db, 'COLD_WORK')).permit, 3);
    assert.equal((await createPermit(db, 'WTG_WORK')).permit, 2);
    assert.equal((await createPermit(db, 'CONFINED_SPACE_ENTRY')).permit, 2);
    // Hot Work was not touched by any of that.
    assert.equal((await createPermit(db, 'HOT_WORK')).permit, 2);
  } finally {
    await db.close();
  }
});

test('the JSA series stays global and continuous across every permit type', async () => {
  const db = await migratedDb();
  try {
    const created = [];
    for (const type of [...TYPES, ...TYPES]) created.push(await createPermit(db, type));
    // Eight permits, JSA 1..8 regardless of type.
    assert.deepEqual(created.map((c) => c.jsa), [1, 2, 3, 4, 5, 6, 7, 8]);
    // While the permit numbers restart per type.
    assert.deepEqual(created.map((c) => c.permit), [1, 1, 1, 1, 2, 2, 2, 2]);
  } finally {
    await db.close();
  }
});

test('uniqueness is per type, and a duplicate within a type is still refused', async () => {
  const db = await migratedDb();
  try {
    await createPermit(db, 'COLD_WORK');
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    // The trigger would overwrite a supplied number, so the constraint is
    // exercised directly with the trigger disabled for this statement.
    await db.exec('ALTER TABLE permits DISABLE TRIGGER permits_assign_permit_sequence_trigger');
    await assert.rejects(
      db.query('INSERT INTO permits (jsa_id, permit_type, permit_sequence) VALUES ($1, $2, 1)', [
        jsa.rows[0]!.id,
        'COLD_WORK',
      ]),
      /permits_permit_type_sequence_unique/,
    );
    await db.exec('ALTER TABLE permits ENABLE TRIGGER permits_assign_permit_sequence_trigger');
  } finally {
    await db.close();
  }
});

test('the client cannot choose a permit number - a supplied one is discarded', async () => {
  const db = await migratedDb();
  try {
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const inserted = await db.query<{ permit_sequence: string | number }>(
      'INSERT INTO permits (jsa_id, permit_type, permit_sequence) VALUES ($1, $2, 9999) RETURNING permit_sequence',
      [jsa.rows[0]!.id, 'HOT_WORK'],
    );
    assert.equal(Number(inserted.rows[0]!.permit_sequence), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------

test('concurrent creation of the same type cannot produce a duplicate number', async () => {
  const db = await migratedDb();
  try {
    // Twenty-five creations of the same type, issued together. The
    // allocator serialises them on one counter row.
    const jsas = await Promise.all(
      Array.from({ length: 25 }, () => db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id')),
    );
    const results = await Promise.all(
      jsas.map((jsa) =>
        db.query<{ permit_sequence: string }>(
          'INSERT INTO permits (jsa_id, permit_type) VALUES ($1, $2) RETURNING permit_sequence',
          [jsa.rows[0]!.id, 'COLD_WORK'],
        ),
      ),
    );
    const numbers = results.map((r) => Number(r.rows[0]!.permit_sequence)).sort((a, b) => a - b);
    // Contiguous 1..25, no duplicate and no gap.
    assert.deepEqual(numbers, Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(new Set(numbers).size, 25);
  } finally {
    await db.close();
  }
});

test('concurrent creation across all four types keeps the series independent', async () => {
  const db = await migratedDb();
  try {
    const plan = Array.from({ length: 40 }, (_, i) => TYPES[i % TYPES.length]!);
    const jsas = await Promise.all(
      plan.map(() => db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id')),
    );
    await Promise.all(
      plan.map((type, index) =>
        db.query('INSERT INTO permits (jsa_id, permit_type) VALUES ($1, $2)', [jsas[index]!.rows[0]!.id, type]),
      ),
    );

    for (const type of TYPES) {
      const rows = await db.query<{ permit_sequence: string }>(
        'SELECT permit_sequence FROM permits WHERE permit_type = $1 ORDER BY permit_sequence',
        [type],
      );
      assert.deepEqual(
        rows.rows.map((row) => Number(row.permit_sequence)),
        Array.from({ length: 10 }, (_, i) => i + 1),
        `${type} must be 1..10 with no duplicate or gap`,
      );
    }
    // No duplicate pair anywhere.
    const dupes = await db.query<{ count: string | number }>(
      'SELECT count(*)::text AS count FROM (SELECT permit_type, permit_sequence FROM permits GROUP BY 1,2 HAVING count(*) > 1) d',
    );
    assert.equal(Number(dupes.rows[0]!.count), 0);
  } finally {
    await db.close();
  }
});

test('a rolled-back creation returns its number to the series rather than burning it', async () => {
  const db = await migratedDb();
  try {
    assert.equal((await createPermit(db, 'WTG_WORK')).permit, 1);
    await db.exec('BEGIN');
    await db.exec("INSERT INTO jsas DEFAULT VALUES");
    await db.exec("INSERT INTO permits (jsa_id, permit_type) VALUES ((SELECT max(id) FROM jsas), 'WTG_WORK')");
    await db.exec('ROLLBACK');
    // The abandoned attempt left no gap in the register.
    assert.equal((await createPermit(db, 'WTG_WORK')).permit, 2);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Existing records
// ---------------------------------------------------------------------

test('existing permits are not renumbered, and their type continues from where it was', async () => {
  const db = await createPre0033Db();
  try {
    // A live-shaped estate: one global series interleaved across types.
    await createPermit(db, 'COLD_WORK'); // 1
    await createPermit(db, 'HOT_WORK'); // 2
    await createPermit(db, 'COLD_WORK'); // 3
    await createPermit(db, 'WTG_WORK'); // 4
    const before = await db.query('SELECT id, permit_type, permit_sequence FROM permits ORDER BY id');

    await applyMigration(db);

    const after = await db.query('SELECT id, permit_type, permit_sequence FROM permits ORDER BY id');
    assert.deepEqual(after.rows, before.rows, 'no existing permit row may be rewritten');

    // Each type continues past its own highest number - never reissuing one.
    assert.equal((await createPermit(db, 'COLD_WORK')).permit, 4);
    assert.equal((await createPermit(db, 'HOT_WORK')).permit, 3);
    assert.equal((await createPermit(db, 'WTG_WORK')).permit, 5);
    // A type with no history starts at 1.
    assert.equal((await createPermit(db, 'CONFINED_SPACE_ENTRY')).permit, 1);
  } finally {
    await db.close();
  }
});

test('legacy pre-form permits stay readable and keep the global series', async () => {
  const db = await createPre0033Db();
  try {
    await createPermit(db, null); // 1, untyped
    await createPermit(db, null); // 2, untyped
    await applyMigration(db);

    const legacy = await db.query<{ permit_sequence: string | number }>(
      'SELECT permit_sequence FROM permits WHERE permit_type IS NULL ORDER BY permit_sequence',
    );
    assert.deepEqual(legacy.rows.map((r) => Number(r.permit_sequence)), [1, 2]);

    // A further untyped permit continues the ORIGINAL sequence...
    assert.equal((await createPermit(db, null)).permit, 3);
    // ...and a typed one is unaffected by it.
    assert.equal((await createPermit(db, 'HOT_WORK')).permit, 1);
  } finally {
    await db.close();
  }
});

test('the JSA numbering objects are not touched by the migration', async () => {
  const db = await createPre0033Db();
  try {
    await createPermit(db, 'COLD_WORK');
    const before = await db.query('SELECT last_value, is_called FROM jsa_number_seq');
    await applyMigration(db);
    const after = await db.query('SELECT last_value, is_called FROM jsa_number_seq');
    assert.deepEqual(after.rows, before.rows);

    const constraint = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_catalog.pg_constraint WHERE conname = 'jsas_jsa_sequence_unique'",
    );
    assert.equal(constraint.rows[0]!.count, '1');
  } finally {
    await db.close();
  }
});

test('the migration refuses to apply over data that already breaks the new rule', async () => {
  const db = await createPre0033Db();
  try {
    await db.exec('ALTER TABLE permits DROP CONSTRAINT permits_permit_sequence_unique');
    const jsaA = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const jsaB = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    await db.query('INSERT INTO permits (jsa_id, permit_type, permit_sequence) VALUES ($1, $2, 5)', [jsaA.rows[0]!.id, 'HOT_WORK']);
    await db.query('INSERT INTO permits (jsa_id, permit_type, permit_sequence) VALUES ($1, $2, 5)', [jsaB.rows[0]!.id, 'HOT_WORK']);
    await assert.rejects(applyMigration(db));
  } finally {
    await db.close();
  }
});

test('browser-facing roles hold nothing on the counter table', async () => {
  const db = await migratedDb();
  try {
    const granted = await db.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'permit_number_counters'
          AND grantee IN ('anon','authenticated','PUBLIC')`,
    );
    assert.equal(granted.rows.length, 0);
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_catalog.pg_class WHERE relname = 'permit_number_counters'",
    );
    assert.equal(rls.rows[0]!.relrowsecurity, true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// The UAT reset procedure
// ---------------------------------------------------------------------

test('the UAT reset is disarmed in source control and aborts having changed nothing', async () => {
  const sql = await readFile(resetUrl, 'utf8');
  // The guard is a manual edit, and it must be committed in the OFF position.
  assert.match(sql, /confirmed TEXT := 'NO';/);
  assert.ok(!/confirmed TEXT := 'YES';/.test(sql), 'the reset must never be committed armed');
  // It is not a migration.
  assert.ok(!resetUrl.pathname.includes('/migrations/'));

  const db = await migratedDb();
  try {
    await createPermit(db, 'COLD_WORK');
    await assert.rejects(db.exec(sql), /not armed/);
    // The raised guard leaves the transaction aborted; end it before reading.
    await db.exec('ROLLBACK').catch(() => {});
    const permits = await db.query<{ count: string | number }>('SELECT count(*)::text AS count FROM permits');
    assert.equal(Number(permits.rows[0]!.count), 1, 'a disarmed reset must delete nothing');
  } finally {
    await db.close();
  }
});

test('when armed on a test estate, the reset restarts every type at 1 and the JSA at 1', async () => {
  const db = await migratedDb();
  try {
    // The reset's own tables, reduced to what it deletes from.
    await db.exec(`
      CREATE TABLE whatsapp_outbox_messages (id SERIAL PRIMARY KEY);
      CREATE TABLE notifications (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_document_jobs (id SERIAL PRIMARY KEY);
      CREATE TABLE issued_document_snapshot_integrity (id SERIAL PRIMARY KEY);
      CREATE TABLE issued_document_snapshots (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_signatures (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_lifecycle_events (id SERIAL PRIMARY KEY);
    `);
    for (const type of [...TYPES, 'COLD_WORK', 'COLD_WORK']) await createPermit(db, type);

    const armed = (await readFile(resetUrl, 'utf8')).replace("confirmed TEXT := 'NO';", "confirmed TEXT := 'YES';");
    await db.exec(armed);

    const counters = await db.query<{ permit_type: string; next_value: string | number }>(
      'SELECT permit_type, next_value FROM permit_number_counters ORDER BY permit_type',
    );
    assert.equal(counters.rows.length, 4);
    assert.ok(counters.rows.every((row) => Number(row.next_value) === 1));

    // Everything starts again: each type at 1, the JSA at 1 globally.
    assert.deepEqual(await createPermit(db, 'COLD_WORK'), { permit: 1, jsa: 1 });
    assert.deepEqual(await createPermit(db, 'HOT_WORK'), { permit: 1, jsa: 2 });
    assert.deepEqual(await createPermit(db, 'COLD_WORK'), { permit: 2, jsa: 3 });
  } finally {
    await db.close();
  }
});

test('the reset refuses to run against a database holding issued permits', async () => {
  const db = await migratedDb();
  try {
    await db.exec(`
      CREATE TABLE whatsapp_outbox_messages (id SERIAL PRIMARY KEY);
      CREATE TABLE notifications (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_document_jobs (id SERIAL PRIMARY KEY);
      CREATE TABLE issued_document_snapshot_integrity (id SERIAL PRIMARY KEY);
      CREATE TABLE issued_document_snapshots (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_signatures (id SERIAL PRIMARY KEY);
      CREATE TABLE permit_lifecycle_events (id SERIAL PRIMARY KEY);
    `);
    await createPermit(db, 'COLD_WORK');
    await db.exec("UPDATE permits SET issued_at = now(), status = 'ISSUED'");

    const armed = (await readFile(resetUrl, 'utf8')).replace("confirmed TEXT := 'NO';", "confirmed TEXT := 'YES';");
    await assert.rejects(db.exec(armed), /have been ISSUED/);
    await db.exec('ROLLBACK').catch(() => {});
    const permits = await db.query<{ count: string | number }>('SELECT count(*)::text AS count FROM permits');
    assert.equal(Number(permits.rows[0]!.count), 1);
  } finally {
    await db.close();
  }
});
