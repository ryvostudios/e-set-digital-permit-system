import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL('../../../../database/migrations/0013_notifications_outbox_documents.sql', import.meta.url);

async function backfillSql(): Promise<string> {
  const migration = await readFile(migrationUrl, 'utf8');
  const start = migration.indexOf('DO $$', migration.indexOf('Migrations 0001-0012'));
  const end = migration.indexOf('-- Initial CEO bootstrap singleton/reservation');
  assert.ok(start >= 0 && end > start);
  // PGlite executes real PostgreSQL semantics but its minimal build omits pgcrypto.
  // Only the hash expression is substituted; validation, joins, timestamps,
  // conflicts and transaction behavior are the exact migration SQL.
  return migration.slice(start, end).replace(
    /encode\(digest\(convert_to\(snapshot_document::text, 'UTF8'\), 'sha256'\), 'hex'\)/,
    "repeat('a', 64)",
  );
}

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE jsas (id uuid PRIMARY KEY, jsa_sequence bigint NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE permits (
      id uuid PRIMARY KEY, permit_sequence bigint NOT NULL, jsa_id uuid NOT NULL REFERENCES jsas(id), status text NOT NULL,
      company text, company_other text, created_by uuid NOT NULL, submitted_at timestamptz, issued_at timestamptz,
      site_timezone text NOT NULL, previous_permit_id uuid REFERENCES permits(id)
    );
    CREATE TABLE permit_lifecycle_events (
      id uuid PRIMARY KEY, permit_id uuid NOT NULL REFERENCES permits(id), event_type text NOT NULL,
      actor_user_id uuid NOT NULL, occurred_at timestamptz NOT NULL
    );
    CREATE TABLE issued_document_snapshots (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, permit_id uuid NOT NULL UNIQUE,
      source_event_id uuid NOT NULL UNIQUE, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE permit_document_jobs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      snapshot_id bigint NOT NULL UNIQUE REFERENCES issued_document_snapshots(id)
    );
  `);
  return db;
}

const ids = { jsa: '00000000-0000-0000-0000-000000000001', actor: '00000000-0000-0000-0000-000000000002', owner: '00000000-0000-0000-0000-000000000003' };

async function seed(db: PGlite, rows: Array<{ n: number; status: string; event?: string | undefined; previous?: number; secondEvent?: boolean }>): Promise<void> {
  await db.query('INSERT INTO jsas VALUES ($1, 234, $2, $3)', [ids.jsa, ids.owner, '2025-12-01T00:00:00Z']);
  for (const row of rows) {
    const permitId = `00000000-0000-0000-0001-${String(row.n).padStart(12, '0')}`;
    const previousId = row.previous ? `00000000-0000-0000-0001-${String(row.previous).padStart(12, '0')}` : null;
    await db.query('INSERT INTO permits VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10)', [permitId, row.n, ids.jsa, row.status, 'ESET', ids.owner, '2025-12-20T08:00:00Z', '2025-12-20T09:00:00Z', 'Asia/Karachi', previousId]);
    if (row.event) {
      await db.query('INSERT INTO permit_lifecycle_events VALUES ($1,$2,$3,$4,$5)', [`00000000-0000-0000-0002-${String(row.n).padStart(12, '0')}`, permitId, row.event, ids.actor, '2025-12-20T09:00:01Z']);
      if (row.secondEvent) await db.query('INSERT INTO permit_lifecycle_events VALUES ($1,$2,$3,$4,$5)', [`00000000-0000-0000-0003-${String(row.n).padStart(12, '0')}`, permitId, 'CRO_FALLBACK_APPROVED', ids.actor, '2025-12-20T09:00:02Z']);
    }
  }
}

test('0013 executable historical backfill covers all issued states and renewal, with exactly one snapshot/job and idempotent rerun', async () => {
  const db = await createDb();
  try {
    await seed(db, [
      { n: 1, status: 'ISSUED', event: 'HSE_APPROVED' }, { n: 2, status: 'HELD', event: 'CRO_FALLBACK_APPROVED' },
      { n: 3, status: 'CLOSED', event: 'HSE_APPROVED' }, { n: 4, status: 'CANCELLED', event: 'HSE_APPROVED' },
      { n: 5, status: 'CLOSED', event: 'HSE_APPROVED' }, { n: 6, status: 'ISSUED', event: 'RENEWED', previous: 5 },
    ]);
    const sql = await backfillSql();
    await db.exec(sql);
    await db.exec(sql);
    const counts = await db.query<{ snapshots: number; jobs: number }>('SELECT (SELECT count(*) FROM issued_document_snapshots)::int snapshots, (SELECT count(*) FROM permit_document_jobs)::int jobs');
    assert.deepEqual(counts.rows[0], { snapshots: 6, jobs: 6 });
    const renewed = await db.query<{ snapshot: Record<string, string>; created_at: Date }>("SELECT snapshot, created_at FROM issued_document_snapshots WHERE snapshot->>'issuanceEventType' = 'RENEWED'");
    const snapshot = renewed.rows[0]!.snapshot;
    assert.equal(snapshot.issuanceOccurredAt, '2025-12-20T09:00:01.000Z');
    assert.equal(snapshot.issuanceActorUserId, ids.actor);
    assert.equal(snapshot.previousPermitId, '00000000-0000-0000-0001-000000000005');
    assert.equal(snapshot.previousPermitNumber, '5');
    assert.equal(snapshot.siteTimezone, 'Asia/Karachi');
    assert.notEqual(snapshot.snapshotTakenAt, snapshot.issuanceOccurredAt);
    assert.equal(new Date(snapshot.snapshotTakenAt!).getTime(), new Date(renewed.rows[0]!.created_at).getTime());
  } finally { await db.close(); }
});

for (const corrupt of ['missing', 'multiple'] as const) {
  test(`0013 executable backfill fails closed and rolls back for ${corrupt} authoritative issuance history`, async () => {
    const db = await createDb();
    try {
      await seed(db, [{ n: 1, status: 'ISSUED', event: corrupt === 'missing' ? undefined : 'HSE_APPROVED', secondEvent: corrupt === 'multiple' }]);
      const sql = await backfillSql();
      await assert.rejects(() => db.exec(`BEGIN; ${sql} COMMIT;`), /lack exactly one authoritative issuance event/);
      await db.exec('ROLLBACK');
      const counts = await db.query<{ count: number }>('SELECT count(*)::int count FROM issued_document_snapshots');
      assert.equal(counts.rows[0]!.count, 0);
    } finally { await db.close(); }
  });
}
