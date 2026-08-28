import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, getPool, toSafeDbErrorMessage } from './db/pool.js';
import { logEvent } from './middleware/requestLog.js';
import { ACTIVE_FORM_GENERATION } from './domain/permits/formGeneration.js';
import { startDocumentJobWorker, type DocumentJobWorker } from './workers/documentJobWorker.js';

// A safety net, not the primary shutdown mechanism: `server.close()`
// normally completes as soon as in-flight requests finish and idle
// keep-alive sockets are closed (below), but if something unexpected
// keeps a connection open indefinitely, the process must still exit
// rather than hang forever during a deploy/restart.
const FORCE_SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  try {
    await getPool().query('SELECT 1');
  } catch (err) {
    logEvent('startup_failed', { reason: 'database_unreachable', detail: toSafeDbErrorMessage(err) });
    await closePool();
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    // The active form generation is logged at startup because a STALE
    // PROCESS is otherwise invisible: the source and the build can both
    // say V2 while a long-running server still serves the V1 it was
    // started with, and the only symptom is new permits quietly storing
    // the wrong version. One line here makes "which generation is this
    // process actually creating?" answerable without a database query.
    logEvent('startup', {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      activeFormGeneration: ACTIVE_FORM_GENERATION,
      documentWorker: env.DOCUMENT_WORKER_ENABLED,
    });
  });

  /*
    THE ISSUED-DOCUMENT WORKER RUNS HERE, IN THE API PROCESS.

    Issuance queues a `permit_document_jobs` row; without something
    claiming it the PDF is never rendered and `GET /permits/:id/pdf`
    answers 202 forever. It used to exist only as an operator-run script,
    which a single hosted Web Service never runs - so no job was ever
    claimed. Started after `listen` so a worker tick can never delay the
    port opening, and stopped before the pool closes on shutdown.

    Turn it off only where a separate worker service runs
    `npm run documents:process` instead.
  */
  let documentWorker: DocumentJobWorker | null = null;
  if (env.DOCUMENT_WORKER_ENABLED) {
    try {
      documentWorker = startDocumentJobWorker();
    } catch (err) {
      // A worker that cannot start must not take the API down with it:
      // permits are still issued, and their documents catch up once the
      // cause is fixed. It is logged rather than swallowed.
      logEvent('document_worker_start_failed', { detail: toSafeDbErrorMessage(err) });
    }
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_started', { signal });
    /*
      Stop scheduling immediately, and remember the promise: it resolves
      only once a document pass ALREADY RUNNING has finished. Closing the
      pool underneath a render would abort it mid-claim and leave the job
      to be retried for no reason, so `closePool()` waits for this below.
      The force-exit timer above still bounds the whole shutdown, so a
      genuinely stuck pass cannot hold a deploy open.
    */
    const workerStopped = documentWorker?.stop() ?? Promise.resolve();

    const forceExitTimer = setTimeout(() => {
      logEvent('shutdown_forced', { reason: 'timeout' });
      process.exit(1);
    }, FORCE_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    server.close((closeErr) => {
      let exitCode = 0;
      if (closeErr) {
        logEvent('shutdown_error', { stage: 'http_server', detail: closeErr.message });
        exitCode = 1;
      }
      // The in-flight document pass finishes first, THEN the pool closes.
      workerStopped
        .catch((workerErr: unknown) => {
          logEvent('shutdown_error', { stage: 'document_worker', detail: toSafeDbErrorMessage(workerErr) });
          exitCode = 1;
        })
        .then(() => closePool())
        .catch((poolErr: unknown) => {
          logEvent('shutdown_error', { stage: 'database_pool', detail: toSafeDbErrorMessage(poolErr) });
          exitCode = 1;
        })
        .finally(() => {
          clearTimeout(forceExitTimer);
          logEvent('shutdown_complete', { exitCode });
          process.exit(exitCode);
        });
    });

    // Idle keep-alive connections have no in-flight request, so
    // `server.close()` alone waits for them to time out on their own
    // (which can take a while) before its callback ever fires - closing
    // them immediately lets an orderly shutdown proceed right away.
    // Deliberately `closeIdleConnections`, NOT `closeAllConnections`:
    // the latter would also cut off in-flight requests mid-response,
    // which is exactly what a graceful shutdown must not do.
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logEvent('startup_failed', { reason: 'fatal', detail: toSafeDbErrorMessage(err) });
  process.exit(1);
});
