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

/** The seven append-only DELETE guards the reset must suspend and restore. */
const APPEND_ONLY_GUARDS: readonly (readonly [string, string])[] = [
  ['whatsapp_outbox_messages', 'whatsapp_outbox_no_delete'],
  ['notifications', 'notifications_no_delete'],
  ['permit_document_jobs', 'permit_document_jobs_no_delete'],
  ['issued_document_snapshot_integrity', 'issued_document_snapshot_integrity_append_only'],
  ['issued_document_snapshots', 'issued_document_snapshots_append_only'],
  ['permit_signatures', 'permit_signatures_append_only'],
  ['permit_lifecycle_events', 'permit_lifecycle_events_append_only'],
];

/** Tables the reset must never touch, with a row each so "unchanged" is observable. */
const PROTECTED_TABLES = [
  'app_users', 'app_user_access', 'workforce_profiles', 'companies', 'teams', 'positions',
  'team_positions', 'capabilities', 'team_position_capabilities', 'user_team_positions',
  'account_audit_events', 'privileged_access_events', 'schema_migrations',
];

/**
 * The estate the reset actually runs against: the permit workflow tables
 * with their REAL append-only triggers and REAL `ON DELETE RESTRICT`
 * foreign keys, plus the account/workforce tables it must leave alone.
 *
 * The triggers are the whole point. Without them these specs would prove
 * nothing about the one genuinely risky thing this script does.
 */
async function createResetEstate(applyMigration0033: boolean): Promise<PGlite> {
  const db = await createPre0033Db();
  await db.exec(`
    CREATE FUNCTION forbid_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $fm$
    BEGIN
      RAISE EXCEPTION '% on %.% is not permitted - this table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END; $fm$;

    CREATE TABLE permit_lifecycle_events (
      id SERIAL PRIMARY KEY,
      permit_id INTEGER NOT NULL REFERENCES permits (id) ON DELETE RESTRICT
    );
    CREATE TABLE notifications (
      id SERIAL PRIMARY KEY,
      permit_id INTEGER REFERENCES permits (id) ON DELETE RESTRICT,
      source_event_id INTEGER NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT
    );
    CREATE TABLE whatsapp_outbox_messages (
      id SERIAL PRIMARY KEY,
      permit_id INTEGER NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
      source_event_id INTEGER NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT
    );
    CREATE TABLE issued_document_snapshots (
      id SERIAL PRIMARY KEY,
      permit_id INTEGER NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
      source_event_id INTEGER NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT
    );
    CREATE TABLE issued_document_snapshot_integrity (
      snapshot_id INTEGER PRIMARY KEY REFERENCES issued_document_snapshots (id) ON DELETE RESTRICT
    );
    CREATE TABLE permit_document_jobs (
      id SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES issued_document_snapshots (id) ON DELETE RESTRICT,
      storage_path TEXT
    );
    CREATE TABLE permit_signatures (
      id SERIAL PRIMARY KEY,
      permit_id INTEGER NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
      source_event_id INTEGER NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT
    );

    CREATE TRIGGER whatsapp_outbox_no_delete BEFORE DELETE ON whatsapp_outbox_messages FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER whatsapp_outbox_no_truncate BEFORE TRUNCATE ON whatsapp_outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER permit_document_jobs_no_delete BEFORE DELETE ON permit_document_jobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER issued_document_snapshot_integrity_append_only BEFORE UPDATE OR DELETE ON issued_document_snapshot_integrity FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER issued_document_snapshots_append_only BEFORE UPDATE OR DELETE ON issued_document_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER permit_signatures_append_only BEFORE UPDATE OR DELETE ON permit_signatures FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    CREATE TRIGGER permit_lifecycle_events_append_only BEFORE UPDATE OR DELETE ON permit_lifecycle_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  `);
  for (const table of PROTECTED_TABLES) {
    await db.exec(`CREATE TABLE ${table} (id SERIAL PRIMARY KEY); INSERT INTO ${table} DEFAULT VALUES;`);
  }
  if (applyMigration0033) await applyMigration(db);
  return db;
}

/** A permit carrying the whole workflow tail an issued demo permit leaves behind. */
async function createIssuedEstatePermit(db: PGlite, permitType: string): Promise<void> {
  const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
  const permit = await db.query<{ id: number }>(
    "INSERT INTO permits (jsa_id, permit_type, status, issued_at) VALUES ($1, $2, 'ISSUED', now()) RETURNING id",
    [jsa.rows[0]!.id, permitType],
  );
  const permitId = permit.rows[0]!.id;
  const event = await db.query<{ id: number }>(
    'INSERT INTO permit_lifecycle_events (permit_id) VALUES ($1) RETURNING id',
    [permitId],
  );
  const eventId = event.rows[0]!.id;
  await db.query('INSERT INTO notifications (permit_id, source_event_id) VALUES ($1, $2)', [permitId, eventId]);
  await db.query('INSERT INTO whatsapp_outbox_messages (permit_id, source_event_id) VALUES ($1, $2)', [permitId, eventId]);
  await db.query('INSERT INTO permit_signatures (permit_id, source_event_id) VALUES ($1, $2)', [permitId, eventId]);
  const snapshot = await db.query<{ id: number }>(
    'INSERT INTO issued_document_snapshots (permit_id, source_event_id) VALUES ($1, $2) RETURNING id',
    [permitId, eventId],
  );
  const snapshotId = snapshot.rows[0]!.id;
  await db.query('INSERT INTO issued_document_snapshot_integrity (snapshot_id) VALUES ($1)', [snapshotId]);
  await db.query('INSERT INTO permit_document_jobs (snapshot_id, storage_path) VALUES ($1, $2)', [
    snapshotId,
    `permits/${permitId}/${snapshotId}.pdf`,
  ]);
}

const readReset = (): Promise<string> => readFile(resetUrl, 'utf8');
const arm = (sql: string): string => sql.replace("confirmed TEXT := 'NO';", "confirmed TEXT := 'YES';");

async function triggerStates(db: PGlite): Promise<Map<string, string>> {
  const rows = await db.query<{ tgname: string; tgenabled: string }>(
    'SELECT tgname, tgenabled FROM pg_catalog.pg_trigger WHERE NOT tgisinternal',
  );
  return new Map(rows.rows.map((row) => [row.tgname, row.tgenabled]));
}

async function countOf(db: PGlite, table: string): Promise<number> {
  const rows = await db.query<{ count: string | number }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(rows.rows[0]!.count);
}

test('the reset is committed DISARMED and aborts having changed nothing', async () => {
  const sql = await readReset();
  assert.match(sql, /confirmed TEXT := 'NO';/);
  assert.ok(!/confirmed TEXT := 'YES';/.test(sql), 'the reset must never be committed armed');
  // It is not a migration, and it does not live in the migrations directory.
  assert.ok(!resetUrl.pathname.includes('/migrations/'));

  const db = await createResetEstate(true);
  try {
    await createIssuedEstatePermit(db, 'COLD_WORK');
    await assert.rejects(db.exec(sql), /not armed/);
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await countOf(db, 'permits'), 1, 'a disarmed reset must delete nothing');
  } finally {
    await db.close();
  }
});

test('the issued-permit rejection is gone - an ISSUED demo permit is cleared', async () => {
  const sql = await readReset();
  assert.ok(!/have been ISSUED/.test(sql), 'the issued_at guard must no longer refuse the reset');

  const db = await createResetEstate(true);
  try {
    await createIssuedEstatePermit(db, 'COLD_WORK');
    await db.exec(arm(sql));
    assert.equal(await countOf(db, 'permits'), 0);
  } finally {
    await db.close();
  }
});

test('the cleanup clears every FK-related workflow table, leaving no orphan', async () => {
  const db = await createResetEstate(true);
  try {
    for (const type of TYPES) await createIssuedEstatePermit(db, type);
    for (const [table] of APPEND_ONLY_GUARDS) {
      assert.ok(await countOf(db, table) > 0, `${table} must be populated first`);
    }

    await db.exec(arm(await readReset()));

    for (const table of [...APPEND_ONLY_GUARDS.map(([t]) => t), 'permits', 'jsas']) {
      assert.equal(await countOf(db, table), 0, `${table} must be empty`);
    }
  } finally {
    await db.close();
  }
});

test('every append-only guard is disabled only inside the reset and restored before commit', async () => {
  const db = await createResetEstate(true);
  try {
    for (const type of TYPES) await createIssuedEstatePermit(db, type);
    const before = await triggerStates(db);
    for (const [, trigger] of APPEND_ONLY_GUARDS) {
      assert.equal(before.get(trigger), 'O', `${trigger} must start enabled`);
    }

    await db.exec(arm(await readReset()));

    const after = await triggerStates(db);
    for (const [, trigger] of APPEND_ONLY_GUARDS) {
      assert.equal(after.get(trigger), 'O', `${trigger} must be re-enabled`);
    }
    // Every trigger in the database is in exactly the state it started
    // in - nothing else was disturbed on the way past.
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());

    // And they genuinely work again: the tables are append-only once more.
    await createIssuedEstatePermit(db, 'HOT_WORK');
    await assert.rejects(db.exec('DELETE FROM permit_lifecycle_events'), /append-only/);
    await db.exec('ROLLBACK').catch(() => {});
    await assert.rejects(db.exec('DELETE FROM notifications'), /append-only/);
    await db.exec('ROLLBACK').catch(() => {});
  } finally {
    await db.close();
  }
});

test('the reset refuses to commit if a guard is left disabled', async () => {
  const db = await createResetEstate(true);
  try {
    await createIssuedEstatePermit(db, 'COLD_WORK');
    // A botched edit that forgets one re-enable must not reach COMMIT.
    const sabotaged = arm(await readReset()).replace(
      'ALTER TABLE permit_signatures                 ENABLE TRIGGER permit_signatures_append_only;',
      '-- deliberately not re-enabled',
    );
    await assert.rejects(db.exec(sabotaged), /still disabled/);
    await db.exec('ROLLBACK').catch(() => {});
    // The rollback restored the data AND the protection together.
    assert.equal(await countOf(db, 'permits'), 1);
    assert.equal((await triggerStates(db)).get('permit_signatures_append_only'), 'O');
  } finally {
    await db.close();
  }
});

test('protected account, workforce and migration-history tables are untouched', async () => {
  const db = await createResetEstate(true);
  try {
    for (const type of TYPES) await createIssuedEstatePermit(db, type);
    await db.exec(arm(await readReset()));
    for (const table of PROTECTED_TABLES) {
      assert.equal(await countOf(db, table), 1, `${table} must be untouched`);
    }
  } finally {
    await db.close();
  }
});

test('the reset refuses to commit if a protected table was disturbed', async () => {
  const db = await createResetEstate(true);
  try {
    await createIssuedEstatePermit(db, 'COLD_WORK');
    const sabotaged = arm(await readReset()).replace(
      'DELETE FROM whatsapp_outbox_messages;',
      'DELETE FROM whatsapp_outbox_messages;\nDELETE FROM workforce_profiles;',
    );
    await assert.rejects(db.exec(sabotaged), /protected table/);
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await countOf(db, 'workforce_profiles'), 1);
  } finally {
    await db.close();
  }
});

test('counters and both sequences restart, and the register begins again at 1', async () => {
  const db = await createResetEstate(true);
  try {
    // The live shape: four types sitting at scattered high-water marks.
    for (const type of [...TYPES, 'COLD_WORK', 'WTG_WORK', 'WTG_WORK']) {
      await createIssuedEstatePermit(db, type);
    }
    await db.exec(arm(await readReset()));

    const counters = await db.query<{ permit_type: string; next_value: string | number }>(
      'SELECT permit_type, next_value FROM permit_number_counters ORDER BY permit_type',
    );
    assert.equal(counters.rows.length, 4);
    assert.ok(counters.rows.every((row) => Number(row.next_value) === 1));

    // Each type restarts at 1; the JSA series restarts at 1 GLOBALLY.
    assert.deepEqual(await createPermit(db, 'COLD_WORK'), { permit: 1, jsa: 1 });
    assert.deepEqual(await createPermit(db, 'HOT_WORK'), { permit: 1, jsa: 2 });
    assert.deepEqual(await createPermit(db, 'WTG_WORK'), { permit: 1, jsa: 3 });
    assert.deepEqual(await createPermit(db, 'CONFINED_SPACE_ENTRY'), { permit: 1, jsa: 4 });
    // ...and they advance independently from there.
    assert.deepEqual(await createPermit(db, 'WTG_WORK'), { permit: 2, jsa: 5 });
    assert.deepEqual(await createPermit(db, 'COLD_WORK'), { permit: 2, jsa: 6 });
  } finally {
    await db.close();
  }
});

test('the reset works BEFORE migration 0033, and 0033 then seeds all four types at 1', async () => {
  // The recommended rollout order: an empty register makes 0033's own
  // seed produce the desired state, with no counter reset needed at all.
  const db = await createResetEstate(false);
  try {
    for (const type of TYPES) await createIssuedEstatePermit(db, type);
    await db.exec(arm(await readReset()));

    // The counter table does not exist yet - the reset must not assume it.
    const exists = await db.query<{ present: boolean }>(
      "SELECT to_regclass('public.permit_number_counters') IS NOT NULL AS present",
    );
    assert.equal(exists.rows[0]!.present, false);

    await applyMigration(db);

    const counters = await db.query<{ next_value: string | number }>('SELECT next_value FROM permit_number_counters');
    assert.equal(counters.rows.length, 4);
    assert.ok(counters.rows.every((row) => Number(row.next_value) === 1));
    assert.deepEqual(await createPermit(db, 'COLD_WORK'), { permit: 1, jsa: 1 });
  } finally {
    await db.close();
  }
});

test('the reset reports the storage objects it cannot delete, and never claims to have removed them', async () => {
  const sql = await readReset();
  assert.match(sql, /SQL CANNOT DELETE THESE/);
  assert.match(sql, /issued-permit-documents/);
  assert.match(sql, /SELECT storage_path FROM permit_document_jobs/);
  // The paths are printed BEFORE the jobs table is emptied - the only
  // moment they are still knowable.
  assert.ok(
    sql.indexOf('SELECT storage_path FROM permit_document_jobs') < sql.indexOf('DELETE FROM permit_document_jobs;'),
  );
});

test('migration 0033 has no BEGIN/COMMIT of its own - the runner owns the transaction', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.ok(!/^BEGIN;/m.test(sql), '0033 must not open its own transaction');
  assert.ok(!/^COMMIT;/m.test(sql), '0033 must not commit - that would unbind it from its schema_migrations row');
});
