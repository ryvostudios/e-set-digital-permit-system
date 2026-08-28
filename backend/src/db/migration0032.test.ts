import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL('../../../database/migrations/0032_pdf_renderer_v3.sql', import.meta.url);

const SNAPSHOT = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
const JOB = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;

/**
 * Migration 0032 widens the document renderer allowlist to admit
 * PDFKIT_V3.
 *
 * The pre-0032 shape below is exactly what 0016 left behind, reduced to
 * the columns and the one constraint this migration touches - the same
 * approach the 0015/0016 migration specs use, so these exercise the REAL
 * migration SQL rather than a paraphrase of it.
 */
async function createPre0032Db(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE issued_document_snapshots (id uuid PRIMARY KEY, permit_id uuid NOT NULL);
    CREATE TABLE permit_document_jobs (
      id uuid PRIMARY KEY,
      snapshot_id uuid NOT NULL REFERENCES issued_document_snapshots (id),
      status text NOT NULL,
      storage_path text,
      file_hash text,
      renderer_version text,
      expected_file_hash text,
      CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
        (renderer_version IS NULL AND expected_file_hash IS NULL)
        OR (
          renderer_version IN ('PDFKIT_V1', 'PDFKIT_V2')
          AND expected_file_hash IS NOT NULL
          AND btrim(expected_file_hash) <> ''
        )
      )
    );
    INSERT INTO issued_document_snapshots VALUES
      ('${SNAPSHOT(1)}', '20000000-0000-4000-8000-000000000001'),
      ('${SNAPSHOT(2)}', '20000000-0000-4000-8000-000000000001'),
      ('${SNAPSHOT(3)}', '20000000-0000-4000-8000-000000000001'),
      ('${SNAPSHOT(4)}', '20000000-0000-4000-8000-000000000001');
  `);
  return db;
}

async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(await readFile(migrationUrl, 'utf8'));
}

async function migratedDb(): Promise<PGlite> {
  const db = await createPre0032Db();
  await applyMigration(db);
  return db;
}

function insertJob(db: PGlite, job: string, snapshot: string, renderer: string | null): Promise<unknown> {
  const identity = renderer === null ? 'NULL, NULL' : `'${renderer}', 'expected-hash'`;
  return db.exec(
    `INSERT INTO permit_document_jobs (id, snapshot_id, status, renderer_version, expected_file_hash)
     VALUES ('${job}', '${snapshot}', 'PENDING', ${identity})`,
  );
}

test('PDFKIT_V3 becomes a valid renderer identity', async () => {
  const db = await migratedDb();
  try {
    await insertJob(db, JOB(3), SNAPSHOT(3), 'PDFKIT_V3');
    const rows = await db.query<{ renderer_version: string }>(
      `SELECT renderer_version FROM permit_document_jobs WHERE id = '${JOB(3)}'`,
    );
    assert.equal(rows.rows[0]?.renderer_version, 'PDFKIT_V3');
  } finally {
    await db.close();
  }
});

test('the allowlist is widened, never replaced - V1 and V2 stay valid', async () => {
  const db = await migratedDb();
  try {
    await insertJob(db, JOB(1), SNAPSHOT(1), 'PDFKIT_V1');
    await insertJob(db, JOB(2), SNAPSHOT(2), 'PDFKIT_V2');
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM permit_document_jobs WHERE renderer_version IN ('PDFKIT_V1','PDFKIT_V2')`,
    );
    assert.equal(rows.rows[0]?.count, '2');
  } finally {
    await db.close();
  }
});

test('an identity outside the allowlist is still refused, and so is one without a hash', async () => {
  const db = await migratedDb();
  try {
    await assert.rejects(insertJob(db, JOB(4), SNAPSHOT(4), 'HAND_ROLLED_V1'));
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_document_jobs (id, snapshot_id, status, renderer_version, expected_file_hash)
         VALUES ('${JOB(4)}', '${SNAPSHOT(4)}', 'PENDING', 'PDFKIT_V3', '   ')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test('a job that has pinned nothing yet is still allowed to pin nothing', async () => {
  const db = await migratedDb();
  try {
    await insertJob(db, JOB(4), SNAPSHOT(4), null);
    const rows = await db.query<{ renderer_version: string | null }>(
      `SELECT renderer_version FROM permit_document_jobs WHERE id = '${JOB(4)}'`,
    );
    assert.equal(rows.rows[0]?.renderer_version, null);
  } finally {
    await db.close();
  }
});

test('existing rows are not rewritten - a pinned V2 job keeps its identity and hash across the migration', async () => {
  const db = await createPre0032Db();
  try {
    await insertJob(db, JOB(1), SNAPSHOT(1), 'PDFKIT_V2');
    await db.exec(
      `UPDATE permit_document_jobs SET status = 'GENERATED', storage_path = 'permits/p/s.pdf', file_hash = 'stored-file-hash' WHERE id = '${JOB(1)}'`,
    );
    const before = await db.query(`SELECT * FROM permit_document_jobs WHERE id = '${JOB(1)}'`);

    await applyMigration(db);

    const after = await db.query(`SELECT * FROM permit_document_jobs WHERE id = '${JOB(1)}'`);
    // Byte-for-byte the same row: the migration touches no data at all.
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await db.close();
  }
});

test('re-running the migration is a no-op', async () => {
  const db = await migratedDb();
  try {
    await applyMigration(db);
    await insertJob(db, JOB(3), SNAPSHOT(3), 'PDFKIT_V3');
    await assert.rejects(insertJob(db, JOB(4), SNAPSHOT(4), 'SOMETHING_ELSE'));
  } finally {
    await db.close();
  }
});

test('it aborts rather than applying over a row carrying an unknown renderer identity', async () => {
  const db = await createPre0032Db();
  try {
    // Only reachable by dropping the constraint first - which is exactly
    // the state the guard exists to catch.
    await db.exec('ALTER TABLE permit_document_jobs DROP CONSTRAINT permit_document_jobs_render_identity_consistent');
    await insertJob(db, JOB(1), SNAPSHOT(1), 'HAND_ROLLED_V1');
    await assert.rejects(applyMigration(db), (error: unknown) => {
      assert.match(String(error), /unknown renderer_version/);
      return true;
    });
  } finally {
    await db.close();
  }
});
