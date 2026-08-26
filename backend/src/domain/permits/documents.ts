import { createHash, randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import { query, type QueryFn } from '../../db/pool.js';
import { getSupabaseAdminClient } from '../../lib/supabaseAdmin.js';
import { toDisplayNumber } from './numbering.js';
import type { JsaRow, PermitRow } from './service.js';
import { computeNextMidnightUtc } from './validity.js';

/**
 * The immutable, issuance-time business content of a Permit+JSA - "the
 * immutable snapshot must be enough to reproduce exactly the business
 * information issued". Every field here is an EXISTING permits/jsas
 * column (or a value trivially derived from one, e.g. `expiresAt` from
 * `computeNextMidnightUtc`) - no business field is invented. Deliberately
 * a plain, versionable JSON shape (not a class) - it is persisted
 * verbatim into `issued_document_snapshots.snapshot` (JSONB) and is what
 * `generateIssuedPermitPdf` below renders from, never the live,
 * potentially-later-changed `permits`/`jsas` rows themselves.
 */
export interface IssuedPermitSnapshot {
  permitId: string;
  permitNumber: string;
  jsaId: string;
  jsaNumber: string;
  status: 'ISSUED';
  company: string | null;
  companyOther: string | null;
  createdBy: string;
  submittedAt: string | null;
  issuedAt: string;
  expiresAt: string;
  siteTimezone: string;
  previousPermitId: string | null;
  previousPermitNumber: string | null;
  jsaCreatedBy: string;
  jsaCreatedAt: string;
  issuanceEventId: string;
  issuanceEventType: 'HSE_APPROVED' | 'CRO_FALLBACK_APPROVED' | 'RENEWED';
  issuanceActorUserId: string;
  issuanceOccurredAt: string;
  /** DB-authoritative time at which the immutable snapshot was captured. Distinct from the issuance decision time. */
  snapshotTakenAt: string;
}

export interface IssuanceEventMetadata {
  id: string;
  event_type: IssuedPermitSnapshot['issuanceEventType'];
  actor_user_id: string;
  occurred_at: string;
  snapshot_taken_at: string;
}

function toIsoTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

/**
 * Builds the snapshot from the just-issued permit row and its JSA -
 * called from the SAME transaction that just set `status = 'ISSUED'`
 * (see domain/permits/workflowSideEffects.ts), so `permit.issued_at` is
 * always already set when this runs. `previousPermit` is only passed for
 * a renewal (see `renewPermit` in service.ts); `null` for a normal
 * HSE/fallback issuance.
 */
export function buildIssuedPermitSnapshot(
  permit: PermitRow,
  jsa: JsaRow,
  previousPermit: PermitRow | null,
  issuanceEvent: IssuanceEventMetadata,
): IssuedPermitSnapshot {
  if (!permit.issued_at) {
    throw new Error('buildIssuedPermitSnapshot requires an already-issued permit (issued_at is null)');
  }
  const issuedAt = new Date(permit.issued_at);
  return {
    permitId: permit.id,
    permitNumber: toDisplayNumber(BigInt(permit.permit_sequence)),
    jsaId: jsa.id,
    jsaNumber: toDisplayNumber(BigInt(jsa.jsa_sequence)),
    status: 'ISSUED',
    company: permit.company,
    companyOther: permit.company_other,
    createdBy: permit.created_by,
    submittedAt: permit.submitted_at ? toIsoTimestamp(permit.submitted_at) : null,
    issuedAt: toIsoTimestamp(permit.issued_at),
    expiresAt: computeNextMidnightUtc(issuedAt, permit.site_timezone).toISOString(),
    siteTimezone: permit.site_timezone,
    previousPermitId: permit.previous_permit_id,
    previousPermitNumber: previousPermit ? toDisplayNumber(BigInt(previousPermit.permit_sequence)) : null,
    jsaCreatedBy: jsa.created_by,
    jsaCreatedAt: toIsoTimestamp(jsa.created_at),
    issuanceEventId: issuanceEvent.id,
    issuanceEventType: issuanceEvent.event_type,
    issuanceActorUserId: issuanceEvent.actor_user_id,
    issuanceOccurredAt: toIsoTimestamp(issuanceEvent.occurred_at),
    snapshotTakenAt: toIsoTimestamp(issuanceEvent.snapshot_taken_at),
  };
}

/** Deterministic (sorted-key) JSON, so `computeSnapshotHash` never depends on incidental property insertion order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash recorded on `issued_document_snapshots.snapshot_hash` - a content fingerprint of the immutable business snapshot itself (independent of the PDF file bytes, which get their own `permit_document_jobs.file_hash` once generated). */
export function computeSnapshotHash(snapshot: IssuedPermitSnapshot): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export function computeFileHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-shape integrity check used at the download boundary before any PDF bytes are served. */
export function hasExpectedFileHash(data: Buffer, expectedHash: string | null): boolean {
  return expectedHash !== null && computeFileHash(data) === expectedHash;
}

export interface CreateIssuedDocumentSnapshotInput {
  permitId: string;
  sourceEventId: string;
  snapshot: IssuedPermitSnapshot;
}

export interface CreateIssuedDocumentSnapshotResult {
  snapshotId: string;
  /** false when a snapshot for this permit already existed (idempotent retry) - the existing row is left completely untouched either way, since it's immutable. */
  created: boolean;
}

/**
 * Atomically records the immutable issued-document snapshot and creates
 * its (initially PENDING) PDF-generation job - called from inside the
 * SAME transaction as the issuance status change (HSE approval, CRO
 * fallback approval, or renewal's direct-ISSUED insert). Idempotent via
 * `issued_document_snapshots_permit_unique` (migration 0013): a
 * retried/racing issuance transaction can never create a second
 * snapshot for the same permit, and this function tolerates that by
 * looking the existing row back up rather than treating the conflict as
 * an error - the snapshot itself, once it exists, is never touched
 * again by this function or anything else (database-enforced - see the
 * migration's append-only triggers).
 */
export async function createIssuedDocumentSnapshot(
  queryFn: QueryFn,
  input: CreateIssuedDocumentSnapshotInput,
): Promise<CreateIssuedDocumentSnapshotResult> {
  const snapshotHash = computeSnapshotHash(input.snapshot);
  const insertResult = await queryFn<{ id: string }>(
    `INSERT INTO issued_document_snapshots (permit_id, source_event_id, snapshot, snapshot_hash)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (permit_id) DO NOTHING
     RETURNING id`,
    [input.permitId, input.sourceEventId, JSON.stringify(input.snapshot), snapshotHash],
  );

  let snapshotId = insertResult.rows[0]?.id;
  const created = Boolean(snapshotId);
  if (!snapshotId) {
    const existing = await queryFn<{ id: string }>('SELECT id FROM issued_document_snapshots WHERE permit_id = $1', [
      input.permitId,
    ]);
    snapshotId = existing.rows[0]?.id;
  }
  if (!snapshotId) {
    throw new Error('Expected an issued_document_snapshots row after insert/lookup but found none');
  }

  await queryFn(
    'INSERT INTO permit_document_jobs (snapshot_id) VALUES ($1) ON CONFLICT (snapshot_id) DO NOTHING',
    [snapshotId],
  );

  return { snapshotId, created };
}

export interface PermitDocumentJobRow {
  id: string;
  snapshot_id: string;
  status: 'PENDING' | 'PROCESSING' | 'GENERATED' | 'FAILED';
  storage_path: string | null;
  file_hash: string | null;
  generated_at: string | null;
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssuedDocumentSnapshotRow {
  id: string;
  permit_id: string;
  source_event_id: string;
  snapshot: IssuedPermitSnapshot;
  snapshot_hash: string;
  created_at: string;
}

/**
 * Renders the combined Permit+JSA PDF from an immutable snapshot only -
 * "CORE BUSINESS RULE: every ISSUED permit has ONE combined PDF
 * containing PERMIT then JSA (NOT two separate PDFs)". Uses `pdfkit`
 * (a well-supported, mature PDF library - never a hand-rolled PDF
 * writer). Every value rendered comes directly from `snapshot`; nothing
 * here re-reads the live `permits`/`jsas` tables, so a later Hold/
 * Resume/Cancel/Close/Renewal on the same permit can never change what
 * this function produces for an already-taken snapshot.
 */
export async function generateIssuedPermitPdf(snapshot: IssuedPermitSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const authoritativeDate = new Date(snapshot.issuanceOccurredAt);
    const doc = new PDFDocument({
      margin: 50,
      info: { Title: `Permit ${snapshot.permitNumber}`, CreationDate: authoritativeDate, ModDate: authoritativeDate },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Permit to Work', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Permit Number: ${snapshot.permitNumber}`);
    doc.text(`JSA Number: ${snapshot.jsaNumber}`);
    doc.text(`Status at Issuance: ${snapshot.status}`);
    doc.text(`Company: ${snapshot.company ?? '-'}${snapshot.companyOther ? ` (${snapshot.companyOther})` : ''}`);
    if (snapshot.submittedAt) doc.text(`Submitted At: ${snapshot.submittedAt}`);
    doc.text(`Issued At: ${snapshot.issuedAt}`);
    doc.text(`Issuance Decision: ${snapshot.issuanceEventType}`);
    doc.text(`Approved By: ${snapshot.issuanceActorUserId}`);
    doc.text(`Approval Recorded At: ${snapshot.issuanceOccurredAt}`);
    doc.text(`Valid Until (next midnight, site time): ${snapshot.expiresAt}`);
    doc.text(`Site Timezone: ${snapshot.siteTimezone}`);
    if (snapshot.previousPermitNumber) {
      doc.text(`Renewed From Permit Number: ${snapshot.previousPermitNumber}`);
    }

    doc.moveDown();
    doc.fontSize(14).text('Job Safety Analysis');
    doc.fontSize(12);
    doc.text(`JSA Number: ${snapshot.jsaNumber}`);
    doc.text(`JSA Created At: ${snapshot.jsaCreatedAt}`);

    doc.moveDown();
    doc
      .fontSize(9)
      .fillColor('gray')
      .text(`Snapshot captured at: ${snapshot.snapshotTakenAt}.`);

    doc.end();
  });
}

export type DocumentStorageErrorCode =
  | 'STORAGE_NOT_CONFIGURED'
  | 'STORAGE_UPLOAD_FAILED'
  | 'STORAGE_DOWNLOAD_FAILED'
  | 'STORAGE_OBJECT_EXISTS'
  | 'STORAGE_INTEGRITY_MISMATCH'
  | 'DOCUMENT_GENERATION_FAILED';
export type DocumentStorageResult = { ok: true } | { ok: false; code: DocumentStorageErrorCode; alreadyExists?: boolean };
export type DocumentDownloadResult = { ok: true; data: Buffer } | { ok: false; code: DocumentStorageErrorCode };

/**
 * The storage provider/adapter boundary - "no secrets in DB payload; no
 * client-controlled destination; provider interface/adapter boundary".
 * `path` is always server-derived (`permits/<permitId>/<snapshotId>.pdf`
 * - both UUIDs from the database, never client input), so there is no
 * path-traversal surface regardless of which adapter is active.
 */
export interface DocumentStorageAdapter {
  upload(path: string, data: Buffer, contentType: string): Promise<DocumentStorageResult>;
  download(path: string): Promise<DocumentDownloadResult>;
}

/**
 * The safe default when Supabase Storage isn't configured
 * (`SUPABASE_SERVICE_ROLE_KEY` unset) - "if actual storage upload cannot
 * complete without a missing credential/configuration, still implement
 * the pending/retry job - and report the missing production credential
 * as manual configuration". Never fakes success.
 */
export const unconfiguredDocumentStorageAdapter: DocumentStorageAdapter = {
  async upload(): Promise<DocumentStorageResult> {
    return { ok: false, code: 'STORAGE_NOT_CONFIGURED' };
  },
  async download(): Promise<DocumentDownloadResult> {
    return { ok: false, code: 'STORAGE_NOT_CONFIGURED' };
  },
};

/**
 * The real adapter, backed by a PRIVATE Supabase Storage bucket
 * (`env.SUPABASE_STORAGE_BUCKET`) via the service-role admin client -
 * "private bucket/object access; backend/server credentials only". This
 * backend never creates the bucket itself and never makes it public;
 * that is a one-time manual Supabase Dashboard step (see DEPLOYMENT.md).
 * `upsert: false` on upload is deliberate defense-in-depth on top of the
 * database-level immutability already enforced by
 * `permit_document_jobs_restrict_update()` (migration 0013): even if
 * something somehow tried to re-upload to the same path, Storage itself
 * refuses to silently overwrite an existing object.
 */
export function createSupabaseDocumentStorageAdapter(): DocumentStorageAdapter | null {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  return {
    async upload(path, data, contentType): Promise<DocumentStorageResult> {
      const { error } = await admin.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .upload(path, data, { contentType, upsert: false });
      if (error) {
        const status = 'statusCode' in error ? Number(error.statusCode) : 0;
        const alreadyExists = status === 409 || /already exists|duplicate/i.test(error.message);
        return { ok: false, code: alreadyExists ? 'STORAGE_OBJECT_EXISTS' : 'STORAGE_UPLOAD_FAILED', alreadyExists };
      }
      return { ok: true };
    },
    async download(path): Promise<DocumentDownloadResult> {
      const { data, error } = await admin.storage.from(env.SUPABASE_STORAGE_BUCKET).download(path);
      if (error || !data) return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
      return { ok: true, data: Buffer.from(await data.arrayBuffer()) };
    },
  };
}

let testStorageAdapter: DocumentStorageAdapter | null = null;

/** Test-only injection at the external Storage boundary; production callers cannot enable it. */
export function setDocumentStorageAdapterForTests(adapter: DocumentStorageAdapter | null): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Storage adapter overrides are test-only');
  testStorageAdapter = adapter;
}

/** Picks the real adapter when Storage is configured, the safe "not configured" stand-in otherwise - the single place callers (the PDF download route, the background generation worker) get a storage adapter from, so neither has to re-check configuration itself. */
export function resolveDocumentStorageAdapter(): DocumentStorageAdapter {
  if (testStorageAdapter) return testStorageAdapter;
  return createSupabaseDocumentStorageAdapter() ?? unconfiguredDocumentStorageAdapter;
}

export interface PermitDocumentLookup {
  snapshot: IssuedDocumentSnapshotRow;
  job: PermitDocumentJobRow;
}

/**
 * Looks up the issued-document snapshot and its (possibly still-pending)
 * PDF job for one permit - used by the `GET /permits/:id/pdf` route,
 * always AFTER that route has already fetched and authorized the permit
 * itself (`getPermitById` + `canViewPermit`), mirroring the existing
 * "authorize before any child-table read" pattern used for the JSA and
 * lifecycle history. Returns null for a permit that was never issued
 * (no snapshot exists) - the route turns that into a 404, never a 500.
 */
export async function getDocumentForPermit(
  permitId: string,
  deps: { query: QueryFn } = { query },
): Promise<PermitDocumentLookup | null> {
  const result = await deps.query<IssuedDocumentSnapshotRow & { job_id: string; job_status: PermitDocumentJobRow['status']; job_storage_path: string | null; job_file_hash: string | null; job_generated_at: string | null; job_attempt_count: number; job_claim_token: string | null; job_claimed_at: string | null; job_next_attempt_at: string; job_last_error: string | null; job_created_at: string; job_updated_at: string }>(
    `SELECT s.*, j.id AS job_id, j.status AS job_status, j.storage_path AS job_storage_path,
            j.file_hash AS job_file_hash, j.generated_at AS job_generated_at,
            j.attempt_count AS job_attempt_count, j.claim_token AS job_claim_token,
            j.claimed_at AS job_claimed_at, j.next_attempt_at AS job_next_attempt_at,
            j.last_error AS job_last_error,
            j.created_at AS job_created_at, j.updated_at AS job_updated_at
       FROM issued_document_snapshots s
       JOIN permit_document_jobs j ON j.snapshot_id = s.id
      WHERE s.permit_id = $1`,
    [permitId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const { job_id, job_status, job_storage_path, job_file_hash, job_generated_at, job_attempt_count, job_claim_token, job_claimed_at, job_next_attempt_at, job_last_error, job_created_at, job_updated_at, ...snapshot } = row;
  return {
    snapshot,
    job: {
      id: job_id,
      snapshot_id: snapshot.id,
      status: job_status,
      storage_path: job_storage_path,
      file_hash: job_file_hash,
      generated_at: job_generated_at,
      attempt_count: job_attempt_count,
      claim_token: job_claim_token,
      claimed_at: job_claimed_at,
      next_attempt_at: job_next_attempt_at,
      last_error: job_last_error,
      created_at: job_created_at,
      updated_at: job_updated_at,
    },
  };
}

function safeDocumentError(code: DocumentStorageErrorCode): string {
  return code;
}

export interface ProcessDocumentJobsDeps {
  query: QueryFn;
}

export interface ProcessDocumentJobsResult {
  processed: number;
  generated: number;
  failed: number;
}

const DOCUMENT_JOB_LEASE_SECONDS = 300;

/**
 * Generates and uploads the PDF for up to `batchSize` PENDING/FAILED
 * document jobs, oldest first. Like `processPendingWhatsappOutbox`, this
 * is not invoked automatically - run it via
 * `npm run documents:process` (see package.json) once Storage is
 * configured. A permit's issuance already succeeded (the snapshot row
 * was already committed) whether or not this has run yet or ever
 * succeeds - "successful issuance must not depend on an external file
 * service being available".
 */
export async function processPendingDocumentJobs(
  deps: ProcessDocumentJobsDeps = { query },
  storage: DocumentStorageAdapter = resolveDocumentStorageAdapter(),
  batchSize = 10,
): Promise<ProcessDocumentJobsResult> {
  const claimToken = randomUUID();
  const pending = await deps.query<{ id: string; snapshot_id: string; snapshot: IssuedPermitSnapshot; permit_id: string }>(
    `WITH claimable AS (
       SELECT j.id
         FROM permit_document_jobs j
        WHERE (
          (j.status IN ('PENDING', 'FAILED') AND j.next_attempt_at <= now())
          OR (j.status = 'PROCESSING' AND j.claimed_at < now() - ($3 * INTERVAL '1 second'))
        )
        ORDER BY j.next_attempt_at ASC, j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     ), claimed AS (
       UPDATE permit_document_jobs j
          SET status = 'PROCESSING', claim_token = $2, claimed_at = now(),
              attempt_count = attempt_count + 1, updated_at = now()
         FROM claimable
        WHERE j.id = claimable.id
        RETURNING j.id, j.snapshot_id
     )
     SELECT claimed.id, claimed.snapshot_id, s.snapshot, s.permit_id
       FROM claimed
       JOIN issued_document_snapshots s ON s.id = claimed.snapshot_id`,
    [batchSize, claimToken, DOCUMENT_JOB_LEASE_SECONDS],
  );

  let generated = 0;
  let failed = 0;

  for (const row of pending.rows) {
    try {
      const pdfBuffer = await generateIssuedPermitPdf(row.snapshot);
      const fileHash = computeFileHash(pdfBuffer);
      const storagePath = `permits/${row.permit_id}/${row.snapshot_id}.pdf`;

      const uploadResult = await storage.upload(storagePath, pdfBuffer, 'application/pdf');
      if (!uploadResult.ok) {
        const existing = await storage.download(storagePath);
        if (!existing.ok || computeFileHash(existing.data) !== fileHash) {
          const integrityError: DocumentStorageErrorCode = existing.ok
            ? 'STORAGE_INTEGRITY_MISMATCH'
            : uploadResult.code;
          const marked = await deps.query<{ id: string }>(
            `UPDATE permit_document_jobs
                SET status = 'FAILED', claim_token = NULL, claimed_at = NULL, last_error = $3,
                    next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) * INTERVAL '1 second'),
                    updated_at = now()
              WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2
              RETURNING id`,
            [row.id, claimToken, safeDocumentError(integrityError)],
          );
          if (marked.rows.length > 0) failed += 1;
          continue;
        }
      }

      const marked = await deps.query<{ id: string }>(
        `UPDATE permit_document_jobs
            SET status = 'GENERATED', storage_path = $2, file_hash = $3, generated_at = now(),
                claim_token = NULL, claimed_at = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $4
          RETURNING id`,
        [row.id, storagePath, fileHash, claimToken],
      );
      if (marked.rows.length > 0) generated += 1;
    } catch {
      const marked = await deps.query<{ id: string }>(
        `UPDATE permit_document_jobs
            SET status = 'FAILED', claim_token = NULL, claimed_at = NULL, last_error = $3,
                next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) * INTERVAL '1 second'),
                updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2
          RETURNING id`,
        [row.id, claimToken, safeDocumentError('DOCUMENT_GENERATION_FAILED')],
      );
      if (marked.rows.length > 0) failed += 1;
    }
  }

  return { processed: pending.rows.length, generated, failed };
}
