import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import { query, type QueryFn } from '../../db/pool.js';
import { buildIssuedDocumentPages, type DocumentBlock, type DocumentPage } from './documentLayout.js';
import type { JsaForm, PermitForm, PermitFormVersion, PermitType } from './forms.js';
import { toDisplayNumber } from './numbering.js';
import type { JsaRow, PermitRow } from './service.js';
import type { SnapshotSignatureSet } from './signatures.js';
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
  /**
   * The snapshot content contract. `ISSUED_PERMIT_SNAPSHOT_V1` documents
   * are the pre-form snapshots migration 0013 backfilled; every snapshot
   * taken from migration 0016 onward is V2 and additionally carries the
   * permit template, both form payloads, and the frozen signature block.
   */
  snapshotVersion: 'ISSUED_PERMIT_SNAPSHOT_V2';
  permitId: string;
  permitNumber: string;
  jsaId: string;
  jsaNumber: string;
  status: 'ISSUED';
  company: string | null;
  companyOther: string | null;
  /** Added compatibly within V2; absent on historical V2 snapshots. */
  applicantIdentity?: {
    kind: 'NORMAL' | 'PRIVILEGED';
    displayName: string;
    companyCode: 'E_SET' | 'ZPL' | 'SGRE';
    companyName: string;
  } | undefined;
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
  /** The permit template and the exact schema version that validated the payload below. */
  permitType: PermitType;
  permitFormVersion: PermitFormVersion;
  /** The full, already-validated permit form content, frozen verbatim. */
  permitForm: PermitForm;
  jsaFormVersion: 'JSA_V1';
  /** The full, already-validated JSA_V1 content, frozen verbatim - the same JSA a renewal reuses, never copied or edited. */
  jsaForm: JsaForm;
  /**
   * The authoritative digital signatures, frozen as text at the instant
   * each authenticated action was performed. A later change to a
   * signer's display name, primary Team + Position, or account state can
   * never alter what this document says - nothing here is ever
   * re-resolved from a live profile.
   */
  signatures: SnapshotSignatureSet;
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
 * Builds the snapshot from the just-issued permit row, its JSA, and the
 * signatures already recorded against it - called from the SAME
 * transaction that just set `status = 'ISSUED'` (see
 * domain/permits/workflowSideEffects.ts), so `permit.issued_at` is
 * always already set when this runs. `previousPermit` is only passed for
 * a renewal (see `renewPermit` in service.ts); `null` for a normal
 * HSE/fallback issuance.
 *
 * Fails closed on missing form content or a missing applicant signature:
 * an issued permit without them would be a document that cannot honestly
 * be reproduced, so it is refused rather than snapshotted with holes.
 * The database independently guarantees the same
 * (permits_form_required_after_draft, permits_require_completed_jsa).
 */
export function buildIssuedPermitSnapshot(
  permit: PermitRow,
  jsa: JsaRow,
  previousPermit: PermitRow | null,
  issuanceEvent: IssuanceEventMetadata,
  signatures: SnapshotSignatureSet,
): IssuedPermitSnapshot {
  if (!permit.issued_at) {
    throw new Error('buildIssuedPermitSnapshot requires an already-issued permit (issued_at is null)');
  }
  if (!permit.permit_type || !permit.form_version || !permit.form_payload) {
    throw new Error('buildIssuedPermitSnapshot requires a permit with a completed, validated form');
  }
  if (!jsa.form_version || !jsa.form_payload) {
    throw new Error('buildIssuedPermitSnapshot requires a JSA with a completed, validated form');
  }
  if (!signatures.applicant) {
    throw new Error('buildIssuedPermitSnapshot requires a recorded applicant signature');
  }
  const issuedAt = new Date(permit.issued_at);
  return {
    snapshotVersion: 'ISSUED_PERMIT_SNAPSHOT_V2',
    permitId: permit.id,
    permitNumber: toDisplayNumber(BigInt(permit.permit_sequence)),
    jsaId: jsa.id,
    jsaNumber: toDisplayNumber(BigInt(jsa.jsa_sequence)),
    status: 'ISSUED',
    company: permit.company,
    companyOther: permit.company_other,
    ...(permit.applicant_identity_kind && permit.applicant_display_name &&
        permit.applicant_company_code && permit.applicant_company_name
      ? { applicantIdentity: {
          kind: permit.applicant_identity_kind,
          displayName: permit.applicant_display_name,
          companyCode: permit.applicant_company_code,
          companyName: permit.applicant_company_name,
        } }
      : {}),
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
    permitType: permit.permit_type,
    permitFormVersion: permit.form_version,
    permitForm: permit.form_payload,
    jsaFormVersion: jsa.form_version,
    jsaForm: jsa.form_payload,
    signatures,
  };
}

/** Deterministic (sorted-key) JSON, so `computeSnapshotHash` never depends on incidental property insertion order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function pgJsonbStringifyV1(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pgJsonbStringifyV1).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pgJsonbStringifyV1(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

export type SnapshotHashVersion = 'PG_JSONB_SHA256_V1' | 'SORTED_JSON_SHA256_V1';
export const CURRENT_SNAPSHOT_HASH_VERSION: SnapshotHashVersion = 'SORTED_JSON_SHA256_V1';

/** The hash recorded on `issued_document_snapshots.snapshot_hash` - a content fingerprint of the immutable business snapshot itself (independent of the PDF file bytes, which get their own `permit_document_jobs.file_hash` once generated). */
export function computeSnapshotHash(snapshot: IssuedPermitSnapshot): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export function computeVersionedSnapshotHash(snapshot: IssuedPermitSnapshot, version: SnapshotHashVersion): string {
  const serialized = version === 'PG_JSONB_SHA256_V1' ? pgJsonbStringifyV1(snapshot) : stableStringify(snapshot);
  return createHash('sha256').update(serialized).digest('hex');
}

export function hasValidSnapshotHash(snapshot: IssuedPermitSnapshot, expected: string, version: string): boolean {
  if (version !== 'PG_JSONB_SHA256_V1' && version !== 'SORTED_JSON_SHA256_V1') return false;
  return computeVersionedSnapshotHash(snapshot, version) === expected;
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

export class SnapshotIntegrityConflictError extends Error {
  constructor() {
    super('Existing issued snapshot does not match the issuance transaction');
    this.name = 'SnapshotIntegrityConflictError';
  }
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
    const existing = await queryFn<{
      id: string; source_event_id: string; snapshot: IssuedPermitSnapshot; snapshot_hash: string; hash_version: string;
    }>(`SELECT s.id, s.source_event_id, s.snapshot, s.snapshot_hash, i.hash_version
          FROM issued_document_snapshots s
          JOIN issued_document_snapshot_integrity i ON i.snapshot_id = s.id
         WHERE s.permit_id = $1`, [input.permitId]);
    const row = existing.rows[0];
    if (
      !row || row.source_event_id !== input.sourceEventId || row.snapshot_hash !== snapshotHash ||
      row.hash_version !== CURRENT_SNAPSHOT_HASH_VERSION ||
      stableStringify(row.snapshot) !== stableStringify(input.snapshot)
    ) throw new SnapshotIntegrityConflictError();
    snapshotId = row.id;
  }
  if (!snapshotId) {
    throw new Error('Expected an issued_document_snapshots row after insert/lookup but found none');
  }

  if (created) {
    await queryFn(
      'INSERT INTO issued_document_snapshot_integrity (snapshot_id, hash_version) VALUES ($1, $2)',
      [snapshotId, CURRENT_SNAPSHOT_HASH_VERSION],
    );
  }

  await queryFn(
    'INSERT INTO permit_document_jobs (snapshot_id) VALUES ($1) ON CONFLICT (snapshot_id) DO NOTHING',
    [snapshotId],
  );

  return { snapshotId, created };
}

/**
 * The immutable issued snapshot for one permit, or null if it was never
 * issued. Used where an already-frozen document must be read rather than
 * rebuilt - notably renewal, which inherits the previous permit's frozen
 * signatures instead of re-resolving anyone's current identity.
 */
export async function getIssuedSnapshotForPermit(
  queryFn: QueryFn,
  permitId: string,
): Promise<{ id: string; snapshot: IssuedPermitSnapshot; snapshotHash: string } | null> {
  const result = await queryFn<{ id: string; snapshot: IssuedPermitSnapshot; snapshot_hash: string }>(
    'SELECT id, snapshot, snapshot_hash FROM issued_document_snapshots WHERE permit_id = $1',
    [permitId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, snapshot: row.snapshot, snapshotHash: row.snapshot_hash } : null;
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
  renderer_version: string | null;
  expected_file_hash: string | null;
}

export interface IssuedDocumentSnapshotRow {
  id: string;
  permit_id: string;
  source_event_id: string;
  snapshot: IssuedPermitSnapshot;
  snapshot_hash: string;
  hash_version: SnapshotHashVersion;
  created_at: string;
}

/** The renderer identity persisted on `permit_document_jobs.renderer_version` (allowlisted by migration 0016). Bumped from PDFKIT_V1 because this renderer produces a different, richer document: Permit page(s), then JSA page 1, then JSA page 2. */
export const CURRENT_RENDERER_VERSION = 'PDFKIT_V2';

const PAGE_MARGIN = 50;

function renderBlock(doc: PDFKit.PDFDocument, block: DocumentBlock, contentWidth: number): void {
  switch (block.kind) {
    case 'fields':
      doc.fontSize(10).fillColor('black');
      for (const row of block.rows) {
        doc.font('Helvetica-Bold').text(`${row.label}: `, { continued: true });
        doc.font('Helvetica').text(row.value);
      }
      break;
    case 'checklist':
      doc.font('Helvetica').fontSize(10).fillColor('black');
      if (block.items.length === 0) {
        doc.fillColor('gray').text('No entries recorded.').fillColor('black');
        break;
      }
      for (const item of block.items) {
        doc.text(`[${item.response}] ${item.label}${item.remarks ? ` - ${item.remarks}` : ''}`);
      }
      break;
    case 'selections':
      doc.font('Helvetica').fontSize(10).fillColor('black');
      if (block.items.length === 0) {
        doc.fillColor('gray').text('No entries recorded.').fillColor('black');
        break;
      }
      for (const item of block.items) {
        doc.text(`[${item.selected ? 'X' : ' '}] ${item.label}${item.remarks ? ` - ${item.remarks}` : ''}`);
      }
      break;
    case 'table': {
      doc.fontSize(9).fillColor('black');
      if (block.rows.length === 0) {
        doc.font('Helvetica').fillColor('gray').text('No entries recorded.').fillColor('black');
        break;
      }
      const columnWidth = contentWidth / block.columns.length;
      const writeRow = (cells: string[], bold: boolean): void => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        const top = doc.y;
        let bottom = top;
        cells.forEach((cell, index) => {
          doc.text(cell, PAGE_MARGIN + index * columnWidth, top, { width: columnWidth - 6 });
          bottom = Math.max(bottom, doc.y);
        });
        doc.x = PAGE_MARGIN;
        doc.y = bottom + 2;
      };
      writeRow(block.columns, true);
      for (const row of block.rows) writeRow(row, false);
      break;
    }
    case 'paragraph':
      doc.font('Helvetica').fontSize(10).fillColor('black').text(block.text, { width: contentWidth });
      break;
    case 'signatures':
      doc.fontSize(10).fillColor('black');
      if (block.entries.length === 0) {
        doc.font('Helvetica').fillColor('gray').text('No signatures recorded.').fillColor('black');
      }
      for (const entry of block.entries) {
        doc.font('Helvetica-Bold').text(entry.caption);
        doc.font('Helvetica').text(`Signed by: ${entry.name}`);
        doc.text(`Designation: ${entry.designation}`);
        doc.text(`Signed at: ${entry.signedAt}`);
        doc.moveDown(0.5);
      }
      if (block.note) {
        doc.font('Helvetica-Oblique').fontSize(9).text(block.note, { width: contentWidth });
        doc.font('Helvetica').fontSize(10);
      }
      break;
  }
}

function renderPage(doc: PDFKit.PDFDocument, page: DocumentPage, contentWidth: number): void {
  doc.font('Helvetica-Bold').fontSize(16).fillColor('black').text(page.title, { align: 'center' });
  doc.moveDown();
  for (const section of page.sections) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text(section.title);
    doc.moveDown(0.3);
    for (const block of section.blocks) {
      renderBlock(doc, block, contentWidth);
    }
    doc.moveDown(0.7);
  }
}

/**
 * Renders the combined Permit + JSA PDF from an immutable snapshot only -
 * "CORE BUSINESS RULE: every ISSUED permit has ONE combined PDF
 * containing PERMIT then JSA (NOT two separate PDFs)" - in the confirmed
 * immutable document order: Permit page(s) -> JSA page 1 -> JSA page 2.
 * Uses `pdfkit` (a mature, well-supported PDF library - never a
 * hand-rolled PDF writer).
 *
 * Every value rendered comes from `snapshot` alone. Nothing here reads
 * the live `permits`/`jsas`/`workforce_profiles` rows or the clock, so a
 * later Hold/Resume/Cancel/Close/Renewal, or a later change to a
 * signer's name or position, can never change what this produces for an
 * already-taken snapshot - and rendering the same snapshot twice always
 * produces byte-identical output (the document's own creation/
 * modification dates come from the snapshot's authoritative issuance
 * timestamp, not from `Date.now()`).
 */
export async function generateIssuedPermitPdf(snapshot: IssuedPermitSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const authoritativeDate = new Date(snapshot.issuanceOccurredAt);
    const doc = new PDFDocument({
      margin: PAGE_MARGIN,
      info: { Title: `Permit ${snapshot.permitNumber}`, CreationDate: authoritativeDate, ModDate: authoritativeDate },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;
    const pages = buildIssuedDocumentPages(snapshot);
    pages.forEach((page, index) => {
      if (index > 0) doc.addPage();
      renderPage(doc, page, contentWidth);
    });

    doc
      .moveDown()
      .font('Helvetica')
      .fontSize(8)
      .fillColor('gray')
      .text(`Snapshot captured at: ${snapshot.snapshotTakenAt}. Renderer: ${CURRENT_RENDERER_VERSION}.`);

    doc.end();
  });
}

export type DocumentStorageErrorCode =
  | 'STORAGE_NOT_CONFIGURED'
  | 'STORAGE_UPLOAD_FAILED'
  | 'STORAGE_DOWNLOAD_FAILED'
  | 'STORAGE_OBJECT_EXISTS'
  | 'STORAGE_INTEGRITY_MISMATCH'
  | 'STORAGE_PREFLIGHT_FAILED'
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
  preflight?(): Promise<DocumentStorageResult>;
  upload(path: string, data: Buffer, contentType: string): Promise<DocumentStorageResult>;
  download(path: string): Promise<DocumentDownloadResult>;
}

export interface StorageBucketMetadata {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

export function isValidPrivateDocumentBucket(row: StorageBucketMetadata | undefined, expectedBucket: string): boolean {
  return Boolean(
    row && row.id === expectedBucket && !row.public && row.file_size_limit && row.file_size_limit >= 100_000 &&
    row.allowed_mime_types?.includes('application/pdf'),
  );
}

/**
 * The safe default when Supabase Storage S3 credentials aren't configured -
 * "if actual storage upload cannot
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
 * The real adapter, backed by a PRIVATE Supabase Storage bucket using
 * Storage-scoped S3 credentials - never the Auth Admin service-role key.
 * This
 * backend never creates the bucket itself and never makes it public;
 * that is a one-time manual Supabase Dashboard step (see DEPLOYMENT.md).
 * S3 `If-None-Match: *` on upload is deliberate defense-in-depth on top of the
 * database-level immutability already enforced by
 * `permit_document_jobs_restrict_update()` (migration 0013): even if
 * something somehow tried to re-upload to the same path, Storage itself
 * refuses to silently overwrite an existing object.
 */
export function createSupabaseDocumentStorageAdapter(queryFn: QueryFn = query): DocumentStorageAdapter | null {
  if (
    !env.SUPABASE_STORAGE_ENDPOINT || !env.SUPABASE_STORAGE_REGION ||
    !env.SUPABASE_STORAGE_ACCESS_KEY_ID || !env.SUPABASE_STORAGE_SECRET_ACCESS_KEY
  ) return null;
  const client = new S3Client({
    endpoint: env.SUPABASE_STORAGE_ENDPOINT,
    region: env.SUPABASE_STORAGE_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.SUPABASE_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.SUPABASE_STORAGE_SECRET_ACCESS_KEY,
    },
  });
  const bucket = env.SUPABASE_DOCUMENT_BUCKET;

  return {
    async preflight(): Promise<DocumentStorageResult> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        const metadata = await queryFn<StorageBucketMetadata>(
          `SELECT id, public, file_size_limit, allowed_mime_types
             FROM storage.buckets WHERE id = $1`,
          [bucket],
        );
        const row = metadata.rows[0];
        if (!isValidPrivateDocumentBucket(row, bucket)) return { ok: false, code: 'STORAGE_PREFLIGHT_FAILED' };
        return { ok: true };
      } catch {
        return { ok: false, code: 'STORAGE_PREFLIGHT_FAILED' };
      }
    },
    async upload(path, data, contentType): Promise<DocumentStorageResult> {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: data, ContentType: contentType, IfNoneMatch: '*' }));
        return { ok: true };
      } catch (error) {
        const status = error && typeof error === 'object' && '$metadata' in error
          ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
          : 0;
        const alreadyExists = status === 409 || status === 412;
        return { ok: false, code: alreadyExists ? 'STORAGE_OBJECT_EXISTS' : 'STORAGE_UPLOAD_FAILED', alreadyExists };
      }
    },
    async download(path): Promise<DocumentDownloadResult> {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
        if (!result.Body) return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
        return { ok: true, data: Buffer.from(await result.Body.transformToByteArray()) };
      } catch {
        return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
      }
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
  const result = await deps.query<IssuedDocumentSnapshotRow & { job_id: string; job_status: PermitDocumentJobRow['status']; job_storage_path: string | null; job_file_hash: string | null; job_generated_at: string | null; job_attempt_count: number; job_claim_token: string | null; job_claimed_at: string | null; job_next_attempt_at: string; job_last_error: string | null; job_created_at: string; job_updated_at: string; job_renderer_version: string | null; job_expected_file_hash: string | null }>(
    `SELECT s.*, i.hash_version, j.id AS job_id, j.status AS job_status, j.storage_path AS job_storage_path,
            j.file_hash AS job_file_hash, j.generated_at AS job_generated_at,
            j.attempt_count AS job_attempt_count, j.claim_token AS job_claim_token,
            j.claimed_at AS job_claimed_at, j.next_attempt_at AS job_next_attempt_at,
            j.last_error AS job_last_error,
            j.created_at AS job_created_at, j.updated_at AS job_updated_at,
            j.renderer_version AS job_renderer_version, j.expected_file_hash AS job_expected_file_hash
       FROM issued_document_snapshots s
       JOIN issued_document_snapshot_integrity i ON i.snapshot_id = s.id
       JOIN permit_document_jobs j ON j.snapshot_id = s.id
      WHERE s.permit_id = $1`,
    [permitId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const { job_id, job_status, job_storage_path, job_file_hash, job_generated_at, job_attempt_count, job_claim_token, job_claimed_at, job_next_attempt_at, job_last_error, job_created_at, job_updated_at, job_renderer_version, job_expected_file_hash, ...snapshot } = row;
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
      renderer_version: job_renderer_version,
      expected_file_hash: job_expected_file_hash,
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
  const preflight = storage.preflight ? await storage.preflight() : { ok: true as const };
  if (!preflight.ok) return { processed: 0, generated: 0, failed: 0 };
  const claimToken = randomUUID();
  const pending = await deps.query<{ id: string; snapshot_id: string; snapshot: IssuedPermitSnapshot; snapshot_hash: string; hash_version: string; permit_id: string; renderer_version: string | null; expected_file_hash: string | null }>(
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
       SELECT claimed.id, claimed.snapshot_id, s.snapshot, s.snapshot_hash, i.hash_version, s.permit_id,
              j.renderer_version, j.expected_file_hash
       FROM claimed
       JOIN issued_document_snapshots s ON s.id = claimed.snapshot_id
       JOIN issued_document_snapshot_integrity i ON i.snapshot_id = s.id
       JOIN permit_document_jobs j ON j.id = claimed.id`,
    [batchSize, claimToken, DOCUMENT_JOB_LEASE_SECONDS],
  );

  let generated = 0;
  let failed = 0;

  for (const row of pending.rows) {
    try {
      if (!hasValidSnapshotHash(row.snapshot, row.snapshot_hash, row.hash_version)) {
        throw new Error('snapshot integrity verification failed');
      }
      const pdfBuffer = await generateIssuedPermitPdf(row.snapshot);
      const fileHash = computeFileHash(pdfBuffer);
      const storagePath = `permits/${row.permit_id}/${row.snapshot_id}.pdf`;

      // Establishes (once) the intended renderer identity and file hash
      // for this job, then refuses to proceed if a DIFFERENT identity was
      // already established - a job whose intended bytes were pinned by
      // an earlier renderer version is never silently re-rendered by a
      // newer one.
      const intended = await deps.query<{ id: string }>(
        `UPDATE permit_document_jobs
            SET renderer_version = COALESCE(renderer_version, $4),
                expected_file_hash = COALESCE(expected_file_hash, $3), updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2
            AND (renderer_version IS NULL OR renderer_version = $4)
            AND (expected_file_hash IS NULL OR expected_file_hash = $3)
          RETURNING id`,
        [row.id, claimToken, fileHash, CURRENT_RENDERER_VERSION],
      );
      if (intended.rows.length === 0) throw new Error('document intended identity conflict');

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
