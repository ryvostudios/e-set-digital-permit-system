import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import {
  buildIssuedPermitSnapshot,
  computeFileHash,
  computeSnapshotHash,
  computeVersionedSnapshotHash,
  createIssuedDocumentSnapshot,
  generateIssuedPermitPdf,
  getDocumentForPermit,
  hasExpectedFileHash,
  hasValidSnapshotHash,
  isValidPrivateDocumentBucket,
  processPendingDocumentJobs,
  unconfiguredDocumentStorageAdapter,
  type DocumentStorageAdapter,
  type IssuedPermitSnapshot,
} from './documents.js';
import type { JsaRow, PermitRow } from './service.js';

function makeIssuanceEvent(occurredAt = '2026-01-01T09:00:00.000Z') {
  return {
    id: 'event-1', event_type: 'HSE_APPROVED' as const, actor_user_id: 'hse-1', occurred_at: occurredAt,
    snapshot_taken_at: '2026-01-01T09:00:02.000Z',
  };
}

function makePermit(overrides: Partial<PermitRow> = {}): PermitRow {
  return {
    id: 'permit-1',
    permit_sequence: '1045',
    jsa_id: 'jsa-1',
    status: 'ISSUED',
    version: 2,
    created_by: 'applicant-1',
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: '2026-01-01T00:00:00.000Z',
    hse_review_started_at: null,
    hse_review_deadline_at: null,
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeJsa(overrides: Partial<JsaRow> = {}): JsaRow {
  return {
    id: 'jsa-1',
    jsa_sequence: '234',
    created_by: 'applicant-1',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

class FakeDocumentsDb {
  snapshots: Array<{ id: string; permit_id: string; source_event_id: string; snapshot: IssuedPermitSnapshot; snapshot_hash: string; created_at: string }> = [];
  integrity = new Map<string, string>();
  jobs: Array<{ id: string; snapshot_id: string; status: 'PENDING' | 'PROCESSING' | 'GENERATED' | 'FAILED'; storage_path: string | null; file_hash: string | null; generated_at: string | null; attempt_count: number; claim_token: string | null; claimed_at: string | null; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string; renderer_version: string | null; expected_file_hash: string | null }> = [];
  private snapshotCounter = 0;
  private jobCounter = 0;

  query: QueryFn = (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('INSERT INTO issued_document_snapshots')) {
      const [permitId, sourceEventId, snapshotJson, snapshotHash] = params as [string, string, string, string];
      if (this.snapshots.some((s) => s.permit_id === permitId)) return { rows: [] };
      this.snapshotCounter += 1;
      const row = {
        id: `snapshot-${this.snapshotCounter}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        snapshot: JSON.parse(snapshotJson) as IssuedPermitSnapshot,
        snapshot_hash: snapshotHash,
        created_at: '2026-01-01T09:00:00.000Z',
      };
      this.snapshots.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith('INSERT INTO issued_document_snapshot_integrity')) {
      this.integrity.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT s.id, s.source_event_id')) {
      const [permitId] = params as [string];
      const row = this.snapshots.find((s) => s.permit_id === permitId);
      return { rows: row ? [{ ...row, hash_version: this.integrity.get(row.id) }] : [] };
    }
    if (sql.startsWith('INSERT INTO permit_document_jobs')) {
      const [snapshotId] = params as [string];
      if (this.jobs.some((j) => j.snapshot_id === snapshotId)) return { rows: [] };
      this.jobCounter += 1;
      this.jobs.push({
        id: `job-${this.jobCounter}`,
        snapshot_id: snapshotId,
        status: 'PENDING',
        storage_path: null,
        file_hash: null,
        generated_at: null,
        attempt_count: 0,
        claim_token: null,
        claimed_at: null,
        next_attempt_at: '2026-01-01T09:00:00.000Z',
        last_error: null,
        created_at: '2026-01-01T09:00:00.000Z',
        updated_at: '2026-01-01T09:00:00.000Z',
        renderer_version: null,
        expected_file_hash: null,
      });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT s.*, i.hash_version')) {
      const [permitId] = params as [string];
      const snapshot = this.snapshots.find((s) => s.permit_id === permitId);
      if (!snapshot) return { rows: [] };
      const job = this.jobs.find((j) => j.snapshot_id === snapshot.id);
      if (!job) return { rows: [] };
      return {
        rows: [
          {
            ...snapshot,
            hash_version: this.integrity.get(snapshot.id),
            job_id: job.id,
            job_status: job.status,
            job_storage_path: job.storage_path,
            job_file_hash: job.file_hash,
            job_generated_at: job.generated_at,
            job_attempt_count: job.attempt_count,
            job_claim_token: job.claim_token,
            job_claimed_at: job.claimed_at,
            job_next_attempt_at: job.next_attempt_at,
            job_last_error: job.last_error,
            job_created_at: job.created_at,
            job_updated_at: job.updated_at,
            job_renderer_version: job.renderer_version,
            job_expected_file_hash: job.expected_file_hash,
          },
        ],
      };
    }
    if (sql.startsWith('WITH claimable AS')) {
      const [limit, claimToken] = params as [number, string];
      const rows = this.jobs
        .filter((j) => j.status === 'PENDING' || j.status === 'FAILED' || (j.status === 'PROCESSING' && j.claimed_at === 'stale'))
        .slice(0, limit)
        .map((j) => {
          j.status = 'PROCESSING';
          j.claim_token = claimToken;
          j.claimed_at = '2026-01-01T09:00:00.000Z';
          j.attempt_count += 1;
          const snapshot = this.snapshots.find((s) => s.id === j.snapshot_id)!;
          return { id: j.id, snapshot_id: j.snapshot_id, snapshot: snapshot.snapshot, snapshot_hash: snapshot.snapshot_hash, hash_version: this.integrity.get(snapshot.id), permit_id: snapshot.permit_id, renderer_version: j.renderer_version, expected_file_hash: j.expected_file_hash };
        });
      return { rows };
    }
    if (sql.startsWith('UPDATE permit_document_jobs') && sql.includes('renderer_version = COALESCE')) {
      const [id, claimToken, fileHash] = params as [string, string, string];
      const job = this.jobs.find((j) => j.id === id);
      if (!job || job.status !== 'PROCESSING' || job.claim_token !== claimToken) return { rows: [] };
      if ((job.renderer_version && job.renderer_version !== 'PDFKIT_V1') || (job.expected_file_hash && job.expected_file_hash !== fileHash)) return { rows: [] };
      job.renderer_version = 'PDFKIT_V1'; job.expected_file_hash = fileHash;
      return { rows: [{ id }] };
    }
    if (sql.startsWith('UPDATE permit_document_jobs') && sql.includes("status = 'GENERATED'")) {
      const [id, storagePath, fileHash, claimToken] = params as [string, string, string, string];
      const index = this.jobs.findIndex((j) => j.id === id);
      if (index !== -1 && this.jobs[index]!.status === 'PROCESSING' && this.jobs[index]!.claim_token === claimToken) {
        this.jobs[index] = {
          ...this.jobs[index]!,
          status: 'GENERATED',
          storage_path: storagePath,
          file_hash: fileHash,
          generated_at: '2026-01-01T09:05:00.000Z',
          claim_token: null,
          claimed_at: null,
        };
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE permit_document_jobs') && sql.includes("status = 'FAILED'")) {
      const [id, claimToken, lastError] = params as [string, string, string];
      const index = this.jobs.findIndex((j) => j.id === id);
      if (index !== -1 && this.jobs[index]!.status === 'PROCESSING' && this.jobs[index]!.claim_token === claimToken) {
        this.jobs[index] = { ...this.jobs[index]!, status: 'FAILED', claim_token: null, claimed_at: null, last_error: lastError };
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }

    throw new Error(`FakeDocumentsDb: unhandled query: ${sql}`);
  }) as QueryFn;
}

test('buildIssuedPermitSnapshot captures the Permit Number, JSA Number, and issuance metadata from existing columns only', () => {
  const permit = makePermit();
  const jsa = makeJsa();
  const snapshot = buildIssuedPermitSnapshot(permit, jsa, null, makeIssuanceEvent('2026-01-01T09:00:01.000Z'));
  assert.equal(snapshot.permitNumber, '1045');
  assert.equal(snapshot.jsaNumber, '234');
  assert.equal(snapshot.status, 'ISSUED');
  assert.equal(snapshot.company, 'ESET');
  assert.equal(snapshot.previousPermitNumber, null);
  assert.equal(snapshot.issuedAt, permit.issued_at);
  assert.equal(snapshot.issuanceEventId, 'event-1');
  assert.equal(snapshot.issuanceEventType, 'HSE_APPROVED');
  assert.equal(snapshot.issuanceActorUserId, 'hse-1');
  assert.equal(snapshot.issuanceOccurredAt, '2026-01-01T09:00:01.000Z');
  assert.equal(snapshot.snapshotTakenAt, '2026-01-01T09:00:02.000Z');
  assert.notEqual(snapshot.snapshotTakenAt, snapshot.issuanceOccurredAt);
});

test('snapshot issuance and capture timestamps ignore a deliberately skewed application clock', () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2099-12-31T23:59:59.999Z').getTime();
  try {
    const event = makeIssuanceEvent('2026-01-01T09:00:01.000Z');
    const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, event);
    assert.equal(snapshot.issuanceOccurredAt, '2026-01-01T09:00:01.000Z');
    assert.equal(snapshot.snapshotTakenAt, '2026-01-01T09:00:02.000Z');
    assert.doesNotMatch(`${snapshot.issuanceOccurredAt} ${snapshot.snapshotTakenAt}`, /2099/);
  } finally {
    Date.now = originalDateNow;
  }
});

test('buildIssuedPermitSnapshot throws if the permit has never been issued', () => {
  const permit = makePermit({ issued_at: null });
  assert.throws(() => buildIssuedPermitSnapshot(permit, makeJsa(), null, makeIssuanceEvent()));
});

test('buildIssuedPermitSnapshot records the previous Permit Number for a renewal', () => {
  const oldPermit = makePermit({ id: 'permit-old', permit_sequence: '1045' });
  const newPermit = makePermit({ id: 'permit-new', permit_sequence: '1046', previous_permit_id: 'permit-old' });
  const snapshot = buildIssuedPermitSnapshot(newPermit, makeJsa(), oldPermit, makeIssuanceEvent());
  assert.equal(snapshot.permitNumber, '1046');
  assert.equal(snapshot.previousPermitNumber, '1045');
});

test('computeSnapshotHash is deterministic regardless of property insertion order', () => {
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as IssuedPermitSnapshot;
  assert.equal(computeSnapshotHash(snapshot), computeSnapshotHash(reordered));
});

test('computeSnapshotHash differs when the snapshot content differs', () => {
  const a = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const b = buildIssuedPermitSnapshot(makePermit({ permit_sequence: '1046' }), makeJsa(), null, makeIssuanceEvent());
  assert.notEqual(computeSnapshotHash(a), computeSnapshotHash(b));
});

test('snapshot hash versions verify current and legacy contracts, reject mutation/unknown versions, and canonicalize key order', () => {
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as IssuedPermitSnapshot;
  const current = computeVersionedSnapshotHash(snapshot, 'SORTED_JSON_SHA256_V1');
  const legacy = computeVersionedSnapshotHash(snapshot, 'PG_JSONB_SHA256_V1');
  assert.equal(hasValidSnapshotHash(reordered, current, 'SORTED_JSON_SHA256_V1'), true);
  assert.equal(hasValidSnapshotHash(reordered, legacy, 'PG_JSONB_SHA256_V1'), true);
  assert.equal(hasValidSnapshotHash({ ...snapshot, company: 'ZPL' }, current, 'SORTED_JSON_SHA256_V1'), false);
  assert.equal(hasValidSnapshotHash(snapshot, current, 'UNKNOWN'), false);
});

test('private document bucket validation fails closed for missing/public/wrong/unsafe configuration', () => {
  const valid = { id: 'issued-permit-documents', public: false, file_size_limit: 1_000_000, allowed_mime_types: ['application/pdf'] };
  assert.equal(isValidPrivateDocumentBucket(valid, valid.id), true);
  assert.equal(isValidPrivateDocumentBucket(undefined, valid.id), false);
  assert.equal(isValidPrivateDocumentBucket({ ...valid, public: true }, valid.id), false);
  assert.equal(isValidPrivateDocumentBucket({ ...valid, id: 'wrong' }, valid.id), false);
  assert.equal(isValidPrivateDocumentBucket({ ...valid, file_size_limit: null }, valid.id), false);
  assert.equal(isValidPrivateDocumentBucket({ ...valid, allowed_mime_types: ['image/png'] }, valid.id), false);
});

test('download integrity accepts exactly the immutable PDF hash and rejects missing/mismatched hashes', () => {
  const bytes = Buffer.from('immutable pdf bytes');
  const hash = computeFileHash(bytes);
  assert.equal(hasExpectedFileHash(bytes, hash), true);
  assert.equal(hasExpectedFileHash(Buffer.from('tampered'), hash), false);
  assert.equal(hasExpectedFileHash(bytes, null), false);
});

test('document worker persists only a fixed safe category when an external boundary throws secret-bearing text', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  const hostile = 'DATABASE_URL=postgres://user:password@host/db sb_secret_FAKE_SECRET';
  await processPendingDocumentJobs({ query: db.query }, {
    async upload() { throw new Error(hostile); },
    async download() { throw new Error(hostile); },
  });
  assert.equal(db.jobs[0]?.last_error, 'DOCUMENT_GENERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(db.jobs), /postgres:\/\/|password|sb_secret_FAKE_SECRET/);
});

test('createIssuedDocumentSnapshot creates both the snapshot and its PDF job atomically', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const result = await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  assert.equal(result.created, true);
  assert.equal(db.snapshots.length, 1);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.jobs[0]?.status, 'PENDING');
});

test('createIssuedDocumentSnapshot is idempotent - a retried/racing issuance never creates a second snapshot for the same permit', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const first = await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  const second = await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(db.snapshots.length, 1);
  assert.equal(db.jobs.length, 1);
});

test('snapshot idempotency accepts only exact event/hash/content equivalence', async () => {
  for (const tamper of ['event', 'hash', 'content'] as const) {
    const db = new FakeDocumentsDb();
    const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
    await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
    if (tamper === 'event') db.snapshots[0]!.source_event_id = 'wrong-event';
    if (tamper === 'hash') db.snapshots[0]!.snapshot_hash = 'wrong-hash';
    if (tamper === 'content') db.snapshots[0]!.snapshot = { ...snapshot, company: 'ZPL' };
    await assert.rejects(
      createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot }),
      { name: 'SnapshotIntegrityConflictError' },
    );
    assert.equal(db.snapshots.length, 1);
    assert.equal(db.jobs.length, 1);
  }
});

test('generateIssuedPermitPdf produces a real PDF buffer containing the Permit Number and JSA Number', async () => {
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const pdf = await generateIssuedPermitPdf(snapshot);
  assert.ok(pdf.length > 0);
  assert.equal(pdf.subarray(0, 5).toString('utf8'), '%PDF-');
});

test('two independent PDF renders of one immutable snapshot have identical bytes and SHA-256 identity', async () => {
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const first = await generateIssuedPermitPdf(snapshot);
  const second = await generateIssuedPermitPdf(snapshot);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);
  assert.equal(computeFileHash(first), computeFileHash(second));
});

test('getDocumentForPermit returns null when no snapshot exists for the permit', async () => {
  const db = new FakeDocumentsDb();
  const result = await getDocumentForPermit('permit-1', { query: db.query });
  assert.equal(result, null);
});

test('getDocumentForPermit returns the snapshot and its (still-pending) job together', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });

  const result = await getDocumentForPermit('permit-1', { query: db.query });
  assert.ok(result);
  assert.equal(result?.snapshot.permit_id, 'permit-1');
  assert.equal(result?.job.status, 'PENDING');
});

test('unconfiguredDocumentStorageAdapter never fakes success', async () => {
  const uploadResult = await unconfiguredDocumentStorageAdapter.upload('permits/x/y.pdf', Buffer.from('x'), 'application/pdf');
  assert.equal(uploadResult.ok, false);
  const downloadResult = await unconfiguredDocumentStorageAdapter.download('permits/x/y.pdf');
  assert.equal(downloadResult.ok, false);
});

test('processPendingDocumentJobs: a working storage adapter marks the job GENERATED with a storage path and file hash', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });

  const workingAdapter: DocumentStorageAdapter = {
    async upload() {
      return { ok: true };
    },
    async download() {
      return { ok: true, data: Buffer.from('x') };
    },
  };
  const result = await processPendingDocumentJobs({ query: db.query }, workingAdapter);
  assert.equal(result.generated, 1);
  assert.equal(db.jobs[0]?.status, 'GENERATED');
  assert.ok(db.jobs[0]?.storage_path);
  assert.ok(db.jobs[0]?.file_hash);
});

test('processPendingDocumentJobs: issuance already succeeded (the snapshot exists) even when storage is not configured - the job just stays retryable', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  const created = await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  assert.equal(created.created, true);

  const result = await processPendingDocumentJobs({ query: db.query }, unconfiguredDocumentStorageAdapter);
  assert.equal(result.failed, 1);
  assert.equal(db.jobs[0]?.status, 'FAILED');
  assert.equal(db.jobs[0]?.last_error, 'STORAGE_NOT_CONFIGURED');
  // The snapshot itself is completely unaffected by the storage failure.
  assert.equal(db.snapshots.length, 1);
});

test('processPendingDocumentJobs: retries a previously FAILED job once storage becomes available', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  await processPendingDocumentJobs({ query: db.query }, unconfiguredDocumentStorageAdapter);
  assert.equal(db.jobs[0]?.status, 'FAILED');

  const workingAdapter: DocumentStorageAdapter = {
    async upload() {
      return { ok: true };
    },
    async download() {
      return { ok: true, data: Buffer.from('x') };
    },
  };
  await processPendingDocumentJobs({ query: db.query }, workingAdapter);
  assert.equal(db.jobs[0]?.status, 'GENERATED');
  assert.equal(db.jobs[0]?.attempt_count, 2);
});

test('document job claiming gives concurrent workers only one active owner', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const storage: DocumentStorageAdapter = {
    async upload() { sends += 1; await gate; return { ok: true }; },
    async download() { return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' }; },
  };
  const first = processPendingDocumentJobs({ query: db.query }, storage);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await processPendingDocumentJobs({ query: db.query }, storage);
  release();
  await first;
  assert.equal(sends, 1);
  assert.equal(second.processed, 0);
});

test('a stale document-job lease is reclaimable, but a foreign claim cannot finalize it', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  db.jobs[0]!.status = 'PROCESSING';
  db.jobs[0]!.claim_token = 'dead-worker';
  db.jobs[0]!.claimed_at = 'stale';
  const storage: DocumentStorageAdapter = { async upload() { return { ok: true }; }, async download() { return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' }; } };
  const result = await processPendingDocumentJobs({ query: db.query }, storage);
  assert.equal(result.generated, 1);
  assert.equal(db.jobs[0]?.status, 'GENERATED');
  const foreignFinalize = await db.query("UPDATE permit_document_jobs SET status = 'GENERATED' WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $4 RETURNING id", ['job-1', 'x', 'y', 'dead-worker']);
  assert.equal(foreignFinalize.rows.length, 0);
});

test('upload-crash reconciliation finalizes an existing identical object and rejects a different object', async () => {
  for (const matching of [true, false]) {
    const db = new FakeDocumentsDb();
    const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
    await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
    const expected = await generateIssuedPermitPdf(snapshot);
    const storage: DocumentStorageAdapter = {
      async upload() { return { ok: false, code: 'STORAGE_OBJECT_EXISTS', alreadyExists: true }; },
      async download() { return { ok: true, data: matching ? expected : Buffer.from('tampered') }; },
    };
    const result = await processPendingDocumentJobs({ query: db.query }, storage);
    assert.equal(db.jobs[0]?.status, matching ? 'GENERATED' : 'FAILED');
    assert.equal(result.generated, matching ? 1 : 0);
    if (!matching) assert.equal(db.jobs[0]?.last_error, 'STORAGE_INTEGRITY_MISMATCH');
  }
});

test('a GENERATED immutable document job is never claimed or regenerated', async () => {
  const db = new FakeDocumentsDb();
  const snapshot = buildIssuedPermitSnapshot(makePermit(), makeJsa(), null, makeIssuanceEvent());
  await createIssuedDocumentSnapshot(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', snapshot });
  db.jobs[0]!.status = 'GENERATED';
  let uploads = 0;
  const storage: DocumentStorageAdapter = { async upload() { uploads += 1; return { ok: true }; }, async download() { return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' }; } };
  const result = await processPendingDocumentJobs({ query: db.query }, storage);
  assert.equal(result.processed, 0);
  assert.equal(uploads, 0);
});
