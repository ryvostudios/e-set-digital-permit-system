import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration0033Url = new URL('../../../database/migrations/0033_per_permit_type_numbering.sql', import.meta.url);
const migration0034Url = new URL('../../../database/migrations/0034_permit_number_on_submission.sql', import.meta.url);

const TYPES = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const;

/**
 * A PERMIT NUMBER IS ISSUED ON SUBMISSION, NOT ON CREATION.
 *
 * 0033 allocated in a BEFORE INSERT trigger, so pressing "Apply for
 * permit" consumed a number before a field was filled in - and a draft
 * abandoned half-finished kept it for ever, leaving the operational
 * register starting at HW-2 with HW-1 an unsubmitted draft.
 *
 * 0034 moves allocation to the DRAFT -> submitted transition. These
 * specs run the REAL migration SQL, in sequence, against the shape those
 * migrations actually see.
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

async function migratedDb(): Promise<PGlite> {
  const db = await createPre0033Db();
  await db.exec(await readFile(migration0033Url, 'utf8'));
  await db.exec(await readFile(migration0034Url, 'utf8'));
  return db;
}

/** Creates a DRAFT exactly the way the application does - naming no number. */
async function createDraft(db: PGlite, permitType: string | null): Promise<{ id: number; jsa: number }> {
  const jsa = await db.query<{ id: number; jsa_sequence: number }>(
    'INSERT INTO jsas DEFAULT VALUES RETURNING id, jsa_sequence',
  );
  const permit = await db.query<{ id: number }>(
    "INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, $2, 'DRAFT') RETURNING id",
    [jsa.rows[0]!.id, permitType],
  );
  return { id: permit.rows[0]!.id, jsa: Number(jsa.rows[0]!.jsa_sequence) };
}

/** The submission transition, as the service performs it. */
async function submit(db: PGlite, id: number): Promise<number | null> {
  const row = await db.query<{ permit_sequence: number | null }>(
    "UPDATE permits SET status = 'PENDING_CRO' WHERE id = $1 RETURNING permit_sequence",
    [id],
  );
  const value = row.rows[0]!.permit_sequence;
  return value === null ? null : Number(value);
}

const sequenceOf = async (db: PGlite, id: number): Promise<number | null> => {
  const row = await db.query<{ permit_sequence: number | null }>(
    'SELECT permit_sequence FROM permits WHERE id = $1',
    [id],
  );
  const value = row.rows[0]!.permit_sequence;
  return value === null ? null : Number(value);
};

// ---------------------------------------------------------------------
// A draft consumes nothing
// ---------------------------------------------------------------------

test('creating a DRAFT does not allocate a permit number', async () => {
  const db = await migratedDb();
  try {
    for (const type of TYPES) {
      const draft = await createDraft(db, type);
      assert.equal(await sequenceOf(db, draft.id), null, `${type}: a draft must be unnumbered`);
    }
    // Not one counter moved.
    const counters = await db.query<{ next_value: number }>('SELECT next_value FROM permit_number_counters');
    assert.ok(counters.rows.every((row) => Number(row.next_value) === 1));
  } finally {
    await db.close();
  }
});

test('saving the same draft many times still allocates nothing', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'HOT_WORK');
    for (let save = 0; save < 5; save += 1) {
      await db.query("UPDATE permits SET status = 'DRAFT' WHERE id = $1", [draft.id]);
      assert.equal(await sequenceOf(db, draft.id), null, 'a saved draft must stay unnumbered');
    }
    const counter = await db.query<{ next_value: number }>(
      "SELECT next_value FROM permit_number_counters WHERE permit_type = 'HOT_WORK'",
    );
    assert.equal(Number(counter.rows[0]!.next_value), 1, 'no number may have been consumed');
  } finally {
    await db.close();
  }
});

test('a client cannot choose its own permit number', async () => {
  const db = await migratedDb();
  try {
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const inserted = await db.query<{ permit_sequence: number | null }>(
      "INSERT INTO permits (jsa_id, permit_type, status, permit_sequence) VALUES ($1, 'HOT_WORK', 'DRAFT', 9999) RETURNING permit_sequence",
      [jsa.rows[0]!.id],
    );
    assert.equal(inserted.rows[0]!.permit_sequence, null, 'a supplied number must be discarded');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Submission issues the number
// ---------------------------------------------------------------------

test('the first successful submission allocates the next number for that type', async () => {
  const db = await migratedDb();
  try {
    for (const type of TYPES) {
      const first = await createDraft(db, type);
      const second = await createDraft(db, type);
      assert.equal(await sequenceOf(db, first.id), null);
      assert.equal(await sequenceOf(db, second.id), null);

      // The one submitted FIRST gets 1, whoever created their draft first.
      assert.equal(await submit(db, second.id), 1, `${type}: the first submission takes 1`);
      assert.equal(await submit(db, first.id), 2, `${type}: the second takes 2`);
    }
  } finally {
    await db.close();
  }
});

test('the reported example: A drafts, B drafts, B submits first', async () => {
  const db = await migratedDb();
  try {
    const a = await createDraft(db, 'HOT_WORK');
    const b = await createDraft(db, 'HOT_WORK');
    assert.equal(await sequenceOf(db, a.id), null, 'A holds no number');
    assert.equal(await sequenceOf(db, b.id), null, 'B holds no number');

    assert.equal(await submit(db, b.id), 1, 'B submits first and becomes HW-1');
    assert.equal(await submit(db, a.id), 2, 'A submits later and becomes HW-2');
    // A never reserved HW-1, so the register does not start at 2.
  } finally {
    await db.close();
  }
});

test('each permit type has its own independent counter', async () => {
  const db = await migratedDb();
  try {
    const drafts = await Promise.all(TYPES.map((type) => createDraft(db, type)));
    for (const [index] of TYPES.entries()) {
      assert.equal(await submit(db, drafts[index]!.id), 1, `${TYPES[index]} must start at 1`);
    }
    // A second of each, still independent.
    for (const type of TYPES) {
      const draft = await createDraft(db, type);
      assert.equal(await submit(db, draft.id), 2, `${type} must advance on its own`);
    }
  } finally {
    await db.close();
  }
});

test('an abandoned draft never consumes a number, however long it sits', async () => {
  const db = await migratedDb();
  try {
    const abandoned = await createDraft(db, 'COLD_WORK');
    const submittedDrafts = [];
    for (let index = 0; index < 3; index += 1) submittedDrafts.push(await createDraft(db, 'COLD_WORK'));
    for (const [index, draft] of submittedDrafts.entries()) {
      assert.equal(await submit(db, draft.id), index + 1);
    }
    // The abandoned draft is still unnumbered, and took nothing from the
    // series the others used.
    assert.equal(await sequenceOf(db, abandoned.id), null);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Rollback and concurrency
// ---------------------------------------------------------------------

test('a rolled-back submission leaves the draft unnumbered and consumes nothing', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'WTG_WORK');
    await db.exec('BEGIN');
    await db.query("UPDATE permits SET status = 'PENDING_CRO' WHERE id = $1", [draft.id]);
    await db.exec('ROLLBACK');

    assert.equal(await sequenceOf(db, draft.id), null, 'the permit must still be an unnumbered DRAFT');
    const status = await db.query<{ status: string }>('SELECT status FROM permits WHERE id = $1', [draft.id]);
    assert.equal(status.rows[0]!.status, 'DRAFT');

    // And the number it would have taken is still the next one out.
    const next = await createDraft(db, 'WTG_WORK');
    assert.equal(await submit(db, next.id), 1, 'the abandoned attempt burned nothing');
  } finally {
    await db.close();
  }
});

test('concurrent submissions of the same type receive distinct consecutive numbers', async () => {
  const db = await migratedDb();
  try {
    const drafts = [];
    for (let index = 0; index < 25; index += 1) drafts.push(await createDraft(db, 'HOT_WORK'));

    const results = await Promise.all(drafts.map((draft) => submit(db, draft.id)));
    const numbers = results.map((value) => Number(value)).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 25 }, (_, index) => index + 1));
    assert.equal(new Set(numbers).size, 25, 'no two submissions may share a number');
  } finally {
    await db.close();
  }
});

test('concurrent submissions across types keep the series independent', async () => {
  const db = await migratedDb();
  try {
    const plan = Array.from({ length: 40 }, (_, index) => TYPES[index % TYPES.length]!);
    const drafts = [];
    for (const type of plan) drafts.push(await createDraft(db, type));
    await Promise.all(drafts.map((draft) => submit(db, draft.id)));

    for (const type of TYPES) {
      const rows = await db.query<{ permit_sequence: number }>(
        'SELECT permit_sequence FROM permits WHERE permit_type = $1 ORDER BY permit_sequence',
        [type],
      );
      assert.deepEqual(
        rows.rows.map((row) => Number(row.permit_sequence)),
        Array.from({ length: 10 }, (_, index) => index + 1),
        `${type}: 1..10 with no duplicate and no gap`,
      );
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------

test('an assigned number survives the whole lifecycle unchanged', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'HOT_WORK');
    for (let index = 0; index < 16; index += 1) {
      const filler = await createDraft(db, 'HOT_WORK');
      await submit(db, filler.id);
    }
    const assigned = await submit(db, draft.id);
    assert.equal(assigned, 17, 'HW-17');

    // Send back, correct, resubmit, approve, issue, hold, resume, close.
    for (const status of [
      'PENDING_CORRECTION', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'HELD', 'ISSUED', 'CLOSED',
    ]) {
      await db.query('UPDATE permits SET status = $2 WHERE id = $1', [draft.id, status]);
      assert.equal(await sequenceOf(db, draft.id), 17, `it must still be HW-17 at ${status}`);
    }
    // Cancelled, and still HW-17 in history.
    await db.query("UPDATE permits SET status = 'CANCELLED' WHERE id = $1", [draft.id]);
    assert.equal(await sequenceOf(db, draft.id), 17);
  } finally {
    await db.close();
  }
});

test('an assigned number cannot be changed, even by a direct write', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'COLD_WORK');
    await submit(db, draft.id);
    await assert.rejects(
      db.query('UPDATE permits SET permit_sequence = 99 WHERE id = $1', [draft.id]),
      /permanent and is never reassigned/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await sequenceOf(db, draft.id), 1, 'the number is unchanged');
  } finally {
    await db.close();
  }
});

test('an assigned number cannot be cleared back to NULL', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'COLD_WORK');
    await submit(db, draft.id);
    await assert.rejects(
      db.query('UPDATE permits SET permit_sequence = NULL WHERE id = $1', [draft.id]),
      /permanent and is never reassigned/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await sequenceOf(db, draft.id), 1);
  } finally {
    await db.close();
  }
});

test('a number is never reused, even after the permit that held it is cancelled', async () => {
  const db = await migratedDb();
  try {
    const first = await createDraft(db, 'WTG_WORK');
    assert.equal(await submit(db, first.id), 1);
    await db.query("UPDATE permits SET status = 'CANCELLED' WHERE id = $1", [first.id]);

    const second = await createDraft(db, 'WTG_WORK');
    assert.equal(await submit(db, second.id), 2, 'the cancelled number is not recycled');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------

test('a typed permit cannot sit past DRAFT without a number', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'HOT_WORK');
    // The trigger allocates on this transition, so the constraint can
    // only be reached by disabling it - which is exactly what it guards.
    await db.exec('ALTER TABLE permits DISABLE TRIGGER permits_assign_permit_sequence_trigger');
    await assert.rejects(
      db.query("UPDATE permits SET status = 'ISSUED' WHERE id = $1", [draft.id]),
      /permits_sequence_required_after_draft/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    await db.exec('ALTER TABLE permits ENABLE TRIGGER permits_assign_permit_sequence_trigger');
  } finally {
    await db.close();
  }
});

test('many unnumbered drafts coexist - uniqueness is not reintroduced across NULLs', async () => {
  const db = await migratedDb();
  try {
    for (let index = 0; index < 6; index += 1) await createDraft(db, 'HOT_WORK');
    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM permits WHERE permit_sequence IS NULL",
    );
    assert.equal(Number(count.rows[0]!.count), 6);
  } finally {
    await db.close();
  }
});

test('two numbered permits of one type still cannot share a number', async () => {
  const db = await migratedDb();
  try {
    const first = await createDraft(db, 'COLD_WORK');
    await submit(db, first.id);
    const second = await createDraft(db, 'COLD_WORK');
    await submit(db, second.id);
    await db.exec('ALTER TABLE permits DISABLE TRIGGER permits_assign_permit_sequence_trigger');
    await assert.rejects(
      db.query('UPDATE permits SET permit_sequence = 1 WHERE id = $1', [second.id]),
      /permits_permit_type_sequence_unique/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    await db.exec('ALTER TABLE permits ENABLE TRIGGER permits_assign_permit_sequence_trigger');
  } finally {
    await db.close();
  }
});

test('the same number in two different types is still legitimate', async () => {
  const db = await migratedDb();
  try {
    for (const type of TYPES) {
      const draft = await createDraft(db, type);
      assert.equal(await submit(db, draft.id), 1, `${type} #1`);
    }
    const ones = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM permits WHERE permit_sequence = 1",
    );
    assert.equal(Number(ones.rows[0]!.count), 4, 'one #1 per type');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// Renewal, legacy rows, and the JSA
// ---------------------------------------------------------------------

test('a renewal is created past DRAFT and is numbered immediately', async () => {
  const db = await migratedDb();
  try {
    const original = await createDraft(db, 'WTG_WORK');
    await submit(db, original.id);

    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const renewed = await db.query<{ permit_sequence: number }>(
      `INSERT INTO permits (jsa_id, permit_type, status, issued_at, previous_permit_id)
       VALUES ($1, 'WTG_WORK', 'ISSUED', now(), $2) RETURNING permit_sequence`,
      [jsa.rows[0]!.id, original.id],
    );
    assert.equal(Number(renewed.rows[0]!.permit_sequence), 2, 'a renewal takes the next number in its type');
  } finally {
    await db.close();
  }
});

test('the legacy global series survives only for pre-form rows created past DRAFT', async () => {
  const db = await migratedDb();
  try {
    // An untyped DRAFT is unnumbered like any other draft - the legacy
    // sequence is not a back door around the rule.
    const draft = await createDraft(db, null);
    assert.equal(await sequenceOf(db, draft.id), null);

    // The sequence remains for what it was always for: a pre-form permit
    // that exists past DRAFT. No current application path creates one,
    // and it is kept rather than dropped so historical rows still have a
    // coherent origin.
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const legacy = await db.query<{ permit_sequence: number }>(
      "INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, NULL, 'ISSUED') RETURNING permit_sequence",
      [jsa.rows[0]!.id],
    );
    assert.equal(Number(legacy.rows[0]!.permit_sequence), 1, 'it still draws from the global sequence');
  } finally {
    await db.close();
  }
});

test('the JSA series is untouched: global, continuous, and allocated at creation', async () => {
  const db = await migratedDb();
  try {
    // A JSA number is issued when the draft is created, for every type,
    // and keeps counting across types - unchanged by any of this.
    const created = [];
    for (const type of [...TYPES, ...TYPES]) created.push(await createDraft(db, type));
    assert.deepEqual(created.map((draft) => draft.jsa), [1, 2, 3, 4, 5, 6, 7, 8]);

    // Even for drafts that are never submitted and never numbered.
    assert.ok((await Promise.all(created.map((d) => sequenceOf(db, d.id)))).every((value) => value === null));

    const constraint = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_catalog.pg_constraint WHERE conname = 'jsas_jsa_sequence_unique'",
    );
    assert.equal(Number(constraint.rows[0]!.count), 1, 'the global JSA uniqueness rule is intact');
  } finally {
    await db.close();
  }
});

test('the worked example: four types submitted in order, JSA counting globally', async () => {
  const db = await migratedDb();
  try {
    const order = ['COLD_WORK', 'HOT_WORK', 'WTG_WORK', 'CONFINED_SPACE_ENTRY', 'WTG_WORK'] as const;
    const observed: { permit: number | null; jsa: number }[] = [];
    for (const type of order) {
      const draft = await createDraft(db, type);
      observed.push({ permit: await submit(db, draft.id), jsa: draft.jsa });
    }
    // CW-1 / JSA 1, HW-1 / JSA 2, WTG-1 / JSA 3, CS-1 / JSA 4, WTG-2 / JSA 5.
    assert.deepEqual(observed, [
      { permit: 1, jsa: 1 },
      { permit: 1, jsa: 2 },
      { permit: 1, jsa: 3 },
      { permit: 1, jsa: 4 },
      { permit: 2, jsa: 5 },
    ]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------

test('0034 evolves 0033 rather than duplicating it', async () => {
  const sql = await readFile(migration0034Url, 'utf8');
  // The counter table, the allocator and the unique indexes are 0033's
  // and are reused, not recreated.
  assert.ok(!/CREATE TABLE permit_number_counters/.test(sql));
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.allocate_permit_sequence/.test(sql));
  assert.ok(!/CREATE UNIQUE INDEX permits_permit_type_sequence_unique/.test(sql));
  // Allocation still goes through 0033's allocator.
  assert.match(sql, /allocate_permit_sequence\(NEW\.permit_type\)/);
  // Nothing computes a next number itself.
  assert.ok(!/max\(permit_sequence\)\s*\+\s*1/i.test(sql));
});

test('0034 refuses to apply over a submitted permit that has no number', async () => {
  const db = await createPre0033Db();
  try {
    await db.exec(await readFile(migration0033Url, 'utf8'));
    // Reachable only by removing the numbering the schema enforces -
    // which is precisely the state the guard exists to catch.
    await db.exec('ALTER TABLE permits ALTER COLUMN permit_sequence DROP NOT NULL');
    await db.exec('ALTER TABLE permits DISABLE TRIGGER permits_assign_permit_sequence_trigger');
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    await db.query(
      "INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, 'HOT_WORK', 'ISSUED')",
      [jsa.rows[0]!.id],
    );
    await assert.rejects(db.exec(await readFile(migration0034Url, 'utf8')), /carry no permit number/);
  } finally {
    await db.close();
  }
});

test('0034 leaves already-numbered permits exactly as they are', async () => {
  const db = await createPre0033Db();
  try {
    await db.exec(await readFile(migration0033Url, 'utf8'));
    // Under 0033 a draft was numbered at creation; those rows must not be
    // renumbered or cleared by the new rule.
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    await db.query("INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, 'HOT_WORK', 'PENDING_CRO')", [
      jsa.rows[0]!.id,
    ]);
    const before = await db.query('SELECT id, permit_type, permit_sequence, status FROM permits ORDER BY id');

    await db.exec(await readFile(migration0034Url, 'utf8'));

    const after = await db.query('SELECT id, permit_type, permit_sequence, status FROM permits ORDER BY id');
    assert.deepEqual(after.rows, before.rows, 'no existing permit row may be rewritten');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------
// A DRAFT IS NEVER NUMBERED - typed or untyped, however it is written
// ---------------------------------------------------------------------

/**
 * The rule is absolute. 0033 numbered every insert; the first version of
 * 0034 exempted only TYPED drafts and still gave an untyped one a number
 * out of the legacy global sequence. That is the same defect in a smaller
 * place: a draft is not a permit, whatever is known about it yet.
 */

test('an untyped DRAFT is unnumbered too - the legacy sequence does not apply to drafts', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, null);
    assert.equal(await sequenceOf(db, draft.id), null, 'an untyped draft must be unnumbered');

    // The legacy global sequence has not been drawn from either.
    const seq = await db.query<{ is_called: boolean }>('SELECT is_called FROM permit_number_seq');
    assert.equal(seq.rows[0]!.is_called, false, 'the legacy sequence must not have moved');
  } finally {
    await db.close();
  }
});

test('an untyped DRAFT stays unnumbered across repeated saves', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, null);
    for (let save = 0; save < 4; save += 1) {
      await db.query("UPDATE permits SET status = 'DRAFT' WHERE id = $1", [draft.id]);
      assert.equal(await sequenceOf(db, draft.id), null);
    }
  } finally {
    await db.close();
  }
});

test('a client cannot force a number into a draft of either kind', async () => {
  const db = await migratedDb();
  try {
    for (const type of ['HOT_WORK', null]) {
      const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
      // On INSERT...
      const inserted = await db.query<{ id: number; permit_sequence: number | null }>(
        "INSERT INTO permits (jsa_id, permit_type, status, permit_sequence) VALUES ($1, $2, 'DRAFT', 4242) RETURNING id, permit_sequence",
        [jsa.rows[0]!.id, type],
      );
      assert.equal(inserted.rows[0]!.permit_sequence, null, 'a supplied number must be discarded');

      // ...and on a later update of the draft.
      await db.query('UPDATE permits SET permit_sequence = 4242 WHERE id = $1', [inserted.rows[0]!.id]);
      assert.equal(await sequenceOf(db, inserted.rows[0]!.id), null, 'still unnumbered');
    }
  } finally {
    await db.close();
  }
});

test('an untyped draft cannot be submitted at all - there is no series to draw from', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, null);
    await assert.rejects(
      db.query("UPDATE permits SET status = 'PENDING_CRO' WHERE id = $1", [draft.id]),
      /cannot be submitted without a permit type/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await sequenceOf(db, draft.id), null, 'and it is still an unnumbered draft');
    // Crucially it did NOT fall back to the legacy global sequence.
    const seq = await db.query<{ is_called: boolean }>('SELECT is_called FROM permit_number_seq');
    assert.equal(seq.rows[0]!.is_called, false);
  } finally {
    await db.close();
  }
});

test('the first successful submission allocates exactly once', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'HOT_WORK');
    assert.equal(await submit(db, draft.id), 1);

    const counterAfterSubmit = await db.query<{ next_value: number }>(
      "SELECT next_value FROM permit_number_counters WHERE permit_type = 'HOT_WORK'",
    );
    assert.equal(Number(counterAfterSubmit.rows[0]!.next_value), 2, 'the counter moved by exactly one');

    // Everything after submission takes nothing more.
    for (const status of ['PENDING_HSE', 'ISSUED', 'CLOSED']) {
      await db.query('UPDATE permits SET status = $2 WHERE id = $1', [draft.id, status]);
    }
    const counterAfterLifecycle = await db.query<{ next_value: number }>(
      "SELECT next_value FROM permit_number_counters WHERE permit_type = 'HOT_WORK'",
    );
    assert.equal(Number(counterAfterLifecycle.rows[0]!.next_value), 2, 'only the submission allocates');
    assert.equal(await sequenceOf(db, draft.id), 1);
  } finally {
    await db.close();
  }
});

test('a submitted permit cannot be pushed back to DRAFT to strip its number', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'COLD_WORK');
    await submit(db, draft.id);
    await assert.rejects(
      db.query("UPDATE permits SET status = 'DRAFT' WHERE id = $1", [draft.id]),
      /cannot return to DRAFT/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(await sequenceOf(db, draft.id), 1);
  } finally {
    await db.close();
  }
});

test('the database refuses a numbered draft outright', async () => {
  const db = await migratedDb();
  try {
    const draft = await createDraft(db, 'HOT_WORK');
    // Only reachable with the trigger off - which is what the constraint
    // underneath it is for.
    await db.exec('ALTER TABLE permits DISABLE TRIGGER permits_assign_permit_sequence_trigger');
    await assert.rejects(
      db.query('UPDATE permits SET permit_sequence = 7 WHERE id = $1', [draft.id]),
      /permits_draft_is_unnumbered/,
    );
    await db.exec('ROLLBACK').catch(() => {});
    await db.exec('ALTER TABLE permits ENABLE TRIGGER permits_assign_permit_sequence_trigger');
  } finally {
    await db.close();
  }
});

test('0034 releases numbers that 0033 had already given to drafts', async () => {
  const db = await createPre0033Db();
  try {
    await db.exec(await readFile(migration0033Url, 'utf8'));
    // Under 0033 a draft was numbered the moment it was created.
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const stale = await db.query<{ id: number; permit_sequence: number }>(
      "INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, 'HOT_WORK', 'DRAFT') RETURNING id, permit_sequence",
      [jsa.rows[0]!.id],
    );
    assert.equal(Number(stale.rows[0]!.permit_sequence), 1, '0033 numbered it at creation');

    await db.exec(await readFile(migration0034Url, 'utf8'));

    // The draft is released - it was never part of the register.
    assert.equal(await sequenceOf(db, stale.rows[0]!.id), null);
    // The counter is NOT rewound, so a released number is never reused.
    assert.equal(await submit(db, stale.rows[0]!.id), 2, 'submission takes the next number, not the released one');
  } finally {
    await db.close();
  }
});

test('0034 does not release a number from anything already submitted', async () => {
  const db = await createPre0033Db();
  try {
    await db.exec(await readFile(migration0033Url, 'utf8'));
    const jsa = await db.query<{ id: number }>('INSERT INTO jsas DEFAULT VALUES RETURNING id');
    const submitted = await db.query<{ id: number; permit_sequence: number }>(
      "INSERT INTO permits (jsa_id, permit_type, status) VALUES ($1, 'HOT_WORK', 'PENDING_CRO') RETURNING id, permit_sequence",
      [jsa.rows[0]!.id],
    );
    const before = Number(submitted.rows[0]!.permit_sequence);

    await db.exec(await readFile(migration0034Url, 'utf8'));

    assert.equal(await sequenceOf(db, submitted.rows[0]!.id), before, 'a submitted permit keeps its number');
  } finally {
    await db.close();
  }
});
