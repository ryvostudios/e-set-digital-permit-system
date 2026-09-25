import { pathToFileURL } from 'node:url';
import { closePool, query, type QueryFn } from '../db/pool.js';
import {
  computeFileHash,
  createSupabaseDocumentStorageAdapter,
  type DocumentStorageAdapter,
} from '../domain/permits/documents.js';
import { PermitDocumentStorage } from '../storage/documentStorage.js';

/**
 * OFFLINE copy of issued permit PDFs from the standalone Supabase Storage
 * bucket into Permit Dropbox. Operator-run; never runs by itself.
 *
 *   npm run storage:migrate-legacy              # dry run (the default): reads and verifies only
 *   npm run storage:migrate-legacy -- --execute # copies
 *
 * For every GENERATED document job whose file still lives at its legacy
 * key (`permits/<permit>/<snapshot>.pdf`) and has no ready Dropbox copy:
 *   1. read the legacy object;
 *   2. refuse it unless its SHA-256 equals the job's pinned `file_hash`;
 *   3. (execute) upload it through the ordinary Permit document storage,
 *      which reserves the registry row first, verifies Dropbox's content
 *      hash, and marks the row ready - registered under the SAME logical
 *      key, so the download route transparently prefers the Dropbox copy;
 *   4. (execute) read it back from Dropbox and compare the hash again.
 *
 * NON-DESTRUCTIVE: the legacy object is never deleted or modified, and the
 * job row is not rewritten. RESUMABLE AND IDEMPOTENT: a copied job is
 * skipped on the next run; an interrupted one resumes on its existing
 * registry reservation. Output is counts and job ids only - never file
 * bytes, paths of other systems, or credentials.
 */

export type LegacyOutcome = 'would_copy' | 'copied' | 'checksum_mismatch' | 'source_unavailable' | 'copy_failed';

export interface LegacyMigrationReport {
  dryRun: boolean;
  examined: number;
  outcomes: Record<LegacyOutcome, number>;
  /** Job ids needing operator attention (never paths or bytes). */
  attention: { jobId: string; outcome: LegacyOutcome }[];
}

interface LegacyJob {
  id: string;
  storage_path: string;
  file_hash: string;
  permit_id: string;
  jsa_id: string;
  permit_number: string;
  issued_at: string;
  actor_user_id: string;
}

export async function migrateLegacyDocuments(
  options: { dryRun: boolean; batchSize?: number },
  deps: { query: QueryFn; legacy: DocumentStorageAdapter; target: DocumentStorageAdapter },
): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = {
    dryRun: options.dryRun,
    examined: 0,
    outcomes: { would_copy: 0, copied: 0, checksum_mismatch: 0, source_unavailable: 0, copy_failed: 0 },
    attention: [],
  };
  const batchSize = options.batchSize ?? 50;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const batch = await deps.query<LegacyJob>(
      `SELECT j.id, j.storage_path, j.file_hash, s.permit_id,
              s.snapshot->>'jsaId' AS jsa_id, s.snapshot->>'permitNumber' AS permit_number,
              s.snapshot->>'issuedAt' AS issued_at, s.snapshot->>'issuanceActorUserId' AS actor_user_id
         FROM permit.permit_document_jobs j
         JOIN permit.issued_document_snapshots s ON s.id = j.snapshot_id
        WHERE j.status = 'GENERATED' AND j.id > $1
          AND j.storage_path LIKE 'permits/%'
          AND NOT EXISTS (SELECT 1 FROM permit.file_registry f WHERE f.document_job_id = j.id AND f.state = 'ready')
        ORDER BY j.id
        LIMIT $2`, [after, batchSize]);
    if (batch.rows.length === 0) break;
    for (const job of batch.rows) {
      after = job.id;
      report.examined += 1;
      const outcome = await migrateOne(job, options.dryRun, deps);
      report.outcomes[outcome] += 1;
      if (outcome !== 'would_copy' && outcome !== 'copied') report.attention.push({ jobId: job.id, outcome });
    }
  }
  return report;
}

async function migrateOne(
  job: LegacyJob,
  dryRun: boolean,
  deps: { legacy: DocumentStorageAdapter; target: DocumentStorageAdapter },
): Promise<LegacyOutcome> {
  const source = await deps.legacy.download(job.storage_path);
  if (!source.ok) return 'source_unavailable';
  if (computeFileHash(source.data) !== job.file_hash) return 'checksum_mismatch';
  if (dryRun) return 'would_copy';
  const uploaded = await deps.target.upload(job.storage_path, source.data, 'application/pdf', {
    documentJobId: job.id, permitId: job.permit_id, jsaId: job.jsa_id,
    permitNumber: job.permit_number, issuedAt: job.issued_at, actorUserId: job.actor_user_id,
  });
  if (!uploaded.ok || !uploaded.reference) return 'copy_failed';
  const readBack = await deps.target.download(uploaded.reference);
  if (!readBack.ok || computeFileHash(readBack.data) !== job.file_hash) return 'copy_failed';
  return 'copied';
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const legacy = createSupabaseDocumentStorageAdapter();
  if (!legacy) throw new Error('legacy storage configuration is incomplete');
  const report = await migrateLegacyDocuments({ dryRun: !execute }, {
    query, legacy, target: new PermitDocumentStorage(null),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.attention.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch(() => {
      console.error('storage:migrate-legacy failed safely');
      process.exitCode = 1;
    })
    .finally(() => void closePool());
}
