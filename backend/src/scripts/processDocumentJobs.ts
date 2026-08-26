import { closePool, query, toSafeDbErrorMessage } from '../db/pool.js';
import { processPendingDocumentJobs, resolveDocumentStorageAdapter } from '../domain/permits/documents.js';
import { pathToFileURL } from 'node:url';

/**
 * Operator-run PDF generation/upload worker - `npm run documents:process`.
 * Not invoked automatically (same reasoning as
 * scripts/processWhatsappOutbox.ts). Safe to run even without
 * `SUPABASE_SERVICE_ROLE_KEY`/Storage configured - every job simply
 * fails with a clear "Storage is not configured" reason and stays
 * retryable; issuance itself already succeeded regardless (see
 * domain/permits/documents.ts's doc comments).
 */
export async function runDocumentJobsCli(deps: {
  process?: typeof processPendingDocumentJobs;
  log?: (message: string) => void;
  error?: (message: string) => void;
} = {}): Promise<boolean> {
  try {
    const result = await (deps.process ?? processPendingDocumentJobs)({ query }, resolveDocumentStorageAdapter());
    (deps.log ?? console.log)(
    `documents:process: processed ${result.processed} job(s) - ${result.generated} generated, ${result.failed} failed/pending.`,
    );
    return true;
  } catch (error) {
    (deps.error ?? console.error)(JSON.stringify({ event: 'document_worker_failed', detail: toSafeDbErrorMessage(error) }));
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDocumentJobsCli()
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .finally(() => { void closePool(); });
}
