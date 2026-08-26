import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  computeVersionedSnapshotHash,
  hasValidSnapshotHash,
  type IssuedPermitSnapshot,
} from '../domain/permits/documents.js';

const migrationUrl = new URL('../../../database/migrations/0015_backend_integrity_hardening.sql', import.meta.url);

async function createBaseDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('10000000-0000-4000-8000-000000000001');
    CREATE TABLE permits (id uuid PRIMARY KEY, company text, company_other text);
    CREATE TABLE permit_lifecycle_events (id uuid PRIMARY KEY, permit_id uuid NOT NULL REFERENCES permits(id), event_type text NOT NULL);
    CREATE TABLE notifications (
      id uuid PRIMARY KEY, recipient_user_id uuid NOT NULL, permit_id uuid,
      source_event_id uuid NOT NULL REFERENCES permit_lifecycle_events(id), notification_type text NOT NULL,
      title text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
    );
    CREATE TABLE whatsapp_outbox_messages (
      id uuid PRIMARY KEY, permit_id uuid NOT NULL, source_event_id uuid NOT NULL REFERENCES permit_lifecycle_events(id),
      event_type text NOT NULL, payload text NOT NULL, status text NOT NULL DEFAULT 'PENDING', attempt_count int NOT NULL DEFAULT 0,
      claim_token uuid, claimed_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
      last_attempted_at timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE issued_document_snapshots (
      id uuid PRIMARY KEY, permit_id uuid NOT NULL, source_event_id uuid NOT NULL REFERENCES permit_lifecycle_events(id),
      snapshot jsonb NOT NULL, snapshot_hash text NOT NULL
    );
    CREATE TABLE permit_document_jobs (
      id uuid PRIMARY KEY, snapshot_id uuid NOT NULL REFERENCES issued_document_snapshots(id), status text NOT NULL,
      storage_path text, file_hash text, generated_at timestamptz, attempt_count int NOT NULL DEFAULT 0,
      claim_token uuid, claimed_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
      AS $$ BEGIN RAISE EXCEPTION 'immutable'; END; $$;
    CREATE FUNCTION notifications_restrict_update() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER notifications_restrict_update_trigger
      BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_restrict_update();
    CREATE FUNCTION permit_document_jobs_restrict_update() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER permit_document_jobs_restrict_update_trigger
      BEFORE UPDATE ON permit_document_jobs FOR EACH ROW EXECUTE FUNCTION permit_document_jobs_restrict_update();
  `);
  return db;
}

async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(await readFile(migrationUrl, 'utf8'));
}

async function setup(): Promise<PGlite> {
  const db = await createBaseDb();
  await applyMigration(db);
  return db;
}

test('0015 enforces access, company, read-receipt, outbox, and lifecycle-linkage integrity', async () => {
  const db = await setup();
  try {
    const user = '10000000-0000-4000-8000-000000000001';
    const permitA = '20000000-0000-4000-8000-000000000001';
    const permitB = '20000000-0000-4000-8000-000000000002';
    const eventA = '30000000-0000-4000-8000-000000000001';
    const eventB = '30000000-0000-4000-8000-000000000002';
    // Existing Auth identities are explicitly activated by the rollout migration.
    const access = await db.query<{ state: string }>(`SELECT state FROM app_user_access WHERE user_id='${user}'`);
    assert.equal(access.rows[0]?.state, 'ACTIVE');
    await db.exec(`UPDATE app_user_access SET state='DISABLED', updated_at='2000-01-01', disabled_at='2000-01-01' WHERE user_id='${user}'`);
    const disabled = await db.query<{ disabled_at: string; updated_at: string }>(`SELECT disabled_at,updated_at FROM app_user_access WHERE user_id='${user}'`);
    assert.notEqual(new Date(disabled.rows[0]!.disabled_at).getUTCFullYear(), 2000);
    assert.notEqual(new Date(disabled.rows[0]!.updated_at).getUTCFullYear(), 2000);

    await db.exec(`
      INSERT INTO permits VALUES ('${permitA}','ESET',NULL), ('${permitB}','OTHER','Vendor');
      INSERT INTO permit_lifecycle_events VALUES
        ('${eventA}','${permitA}','HSE_APPROVED'), ('${eventB}','${permitB}','HELD');
    `);
    await assert.rejects(db.exec(`INSERT INTO permits VALUES ('20000000-0000-4000-8000-000000000003','ESET','forbidden')`));
    await assert.rejects(db.exec(`INSERT INTO permits VALUES ('20000000-0000-4000-8000-000000000004','OTHER',NULL)`));

    const notification = '40000000-0000-4000-8000-000000000001';
    await db.exec(`INSERT INTO notifications VALUES ('${notification}','${user}','${permitA}','${eventA}','X','T','M',now(),NULL)`);
    await db.exec(`UPDATE notifications SET read_at=now() WHERE id='${notification}'`);
    await assert.rejects(db.exec(`UPDATE notifications SET read_at=NULL WHERE id='${notification}'`));
    await assert.rejects(db.exec(`UPDATE notifications SET read_at=now() + interval '1 second' WHERE id='${notification}'`));
    await assert.rejects(db.exec(`INSERT INTO notifications VALUES ('40000000-0000-4000-8000-000000000002','${user}','${permitA}','${eventB}','X','T','M',now(),NULL)`));

    const outbox = '50000000-0000-4000-8000-000000000001';
    await db.exec(`INSERT INTO whatsapp_outbox_messages(id,permit_id,source_event_id,event_type,payload) VALUES ('${outbox}','${permitB}','${eventB}','HELD','{}')`);
    await db.exec(`UPDATE whatsapp_outbox_messages SET status='PROCESSING',claim_token='60000000-0000-4000-8000-000000000001',claimed_at=now() WHERE id='${outbox}'`);
    await assert.rejects(db.exec(`UPDATE whatsapp_outbox_messages SET payload='tampered' WHERE id='${outbox}'`));
    await assert.rejects(db.exec(`INSERT INTO whatsapp_outbox_messages(id,permit_id,source_event_id,event_type,payload) VALUES ('50000000-0000-4000-8000-000000000002','${permitA}','${eventB}','HELD','{}')`));
    await assert.rejects(db.exec(`INSERT INTO whatsapp_outbox_messages(id,permit_id,source_event_id,event_type,payload) VALUES ('50000000-0000-4000-8000-000000000003','${permitB}','${eventB}','CLOSED','{}')`));
    await db.exec(`UPDATE whatsapp_outbox_messages SET status='SENT',claim_token=NULL,claimed_at=NULL,sent_at=now() WHERE id='${outbox}'`);
    await assert.rejects(db.exec(`UPDATE whatsapp_outbox_messages SET last_error='changed' WHERE id='${outbox}'`));
    await assert.rejects(db.exec(`DELETE FROM whatsapp_outbox_messages WHERE id='${outbox}'`));

    await db.exec(`INSERT INTO issued_document_snapshots VALUES ('70000000-0000-4000-8000-000000000001','${permitA}','${eventA}','{}','hash')`);
    await assert.rejects(db.exec(`INSERT INTO issued_document_snapshots VALUES ('70000000-0000-4000-8000-000000000002','${permitB}','${eventB}','{}','hash')`));
    await db.exec(`INSERT INTO permit_document_jobs(id,snapshot_id,status,renderer_version,expected_file_hash) VALUES ('80000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','PENDING','PDFKIT_V1','expected')`);
    await assert.rejects(db.exec(`UPDATE permit_document_jobs SET expected_file_hash='different' WHERE id='80000000-0000-4000-8000-000000000001'`));
  } finally {
    await db.close();
  }
});

const hashFixture: IssuedPermitSnapshot = {
  permitId: '20000000-0000-4000-8000-000000000001',
  permitNumber: '1045',
  jsaId: '90000000-0000-4000-8000-000000000001',
  jsaNumber: '2045',
  status: 'ISSUED',
  company: 'ESET',
  companyOther: null,
  createdBy: '10000000-0000-4000-8000-000000000001',
  submittedAt: '2026-01-01T00:00:00.000Z',
  issuedAt: '2026-01-01T01:00:00.000Z',
  expiresAt: '2026-01-01T19:00:00.000Z',
  siteTimezone: 'Asia/Karachi',
  previousPermitId: null,
  previousPermitNumber: null,
  jsaCreatedBy: '10000000-0000-4000-8000-000000000001',
  jsaCreatedAt: '2026-01-01T00:00:00.000Z',
  issuanceEventId: '30000000-0000-4000-8000-000000000001',
  issuanceEventType: 'HSE_APPROVED',
  issuanceActorUserId: '10000000-0000-4000-8000-000000000001',
  issuanceOccurredAt: '2026-01-01T01:00:00.000Z',
  snapshotTakenAt: '2026-01-01T01:00:00.000Z',
};

test('0015 executes real pgcrypto hash backfill for legacy/current snapshots and both persisted versions verify', async () => {
  const db = await createBaseDb();
  try {
    const currentSnapshot = { ...hashFixture, permitId: '20000000-0000-4000-8000-000000000002', permitNumber: '1046', issuanceEventId: '30000000-0000-4000-8000-000000000002' };
    const legacyHash = await db.query<{ hash: string }>(
      "SELECT encode(digest(convert_to($1::jsonb::text, 'UTF8'), 'sha256'), 'hex') AS hash",
      [JSON.stringify(hashFixture)],
    );
    const currentHash = computeVersionedSnapshotHash(currentSnapshot, 'SORTED_JSON_SHA256_V1');
    await db.query('INSERT INTO permits VALUES ($1, $2, NULL), ($3, $4, NULL)', [hashFixture.permitId, 'ESET', currentSnapshot.permitId, 'ESET']);
    await db.query('INSERT INTO permit_lifecycle_events VALUES ($1, $2, $3), ($4, $5, $6)', [
      hashFixture.issuanceEventId, hashFixture.permitId, 'HSE_APPROVED',
      currentSnapshot.issuanceEventId, currentSnapshot.permitId, 'HSE_APPROVED',
    ]);
    await db.query(
      'INSERT INTO issued_document_snapshots VALUES ($1,$2,$3,$4::jsonb,$5), ($6,$7,$8,$9::jsonb,$10)',
      [
        '70000000-0000-4000-8000-000000000001', hashFixture.permitId, hashFixture.issuanceEventId,
        JSON.stringify(hashFixture), legacyHash.rows[0]!.hash,
        '70000000-0000-4000-8000-000000000002', currentSnapshot.permitId, currentSnapshot.issuanceEventId,
        JSON.stringify(currentSnapshot), currentHash,
      ],
    );

    await applyMigration(db);
    const rows = await db.query<{ snapshot: IssuedPermitSnapshot; snapshot_hash: string; hash_version: string }>(
      `SELECT s.snapshot, s.snapshot_hash, i.hash_version FROM issued_document_snapshots s
       JOIN issued_document_snapshot_integrity i ON i.snapshot_id = s.id ORDER BY s.id`,
    );
    assert.deepEqual(rows.rows.map((row) => row.hash_version), ['PG_JSONB_SHA256_V1', 'SORTED_JSON_SHA256_V1']);
    for (const row of rows.rows) assert.equal(hasValidSnapshotHash(row.snapshot, row.snapshot_hash, row.hash_version), true);
  } finally {
    await db.close();
  }
});

test('0015 rejects an existing snapshot whose hash matches no recognized contract', async () => {
  const db = await createBaseDb();
  try {
    await db.query('INSERT INTO permits VALUES ($1, $2, NULL)', [hashFixture.permitId, 'ESET']);
    await db.query('INSERT INTO permit_lifecycle_events VALUES ($1, $2, $3)', [hashFixture.issuanceEventId, hashFixture.permitId, 'HSE_APPROVED']);
    await db.query('INSERT INTO issued_document_snapshots VALUES ($1,$2,$3,$4::jsonb,$5)', [
      '70000000-0000-4000-8000-000000000001', hashFixture.permitId, hashFixture.issuanceEventId,
      JSON.stringify(hashFixture), 'unrecognized-hash',
    ]);
    await assert.rejects(applyMigration(db), /recognized hash contract/);
  } finally {
    await db.close();
  }
});
