import { env } from '../config/env.js';
import { query, toSafeDbErrorMessage } from '../db/pool.js';
import {
  processPendingDocumentJobs,
  resolveDocumentStorageAdapter,
  type DocumentStorageAdapter,
  type ProcessDocumentJobsDeps,
} from '../domain/permits/documents.js';
import { logEvent } from '../middleware/requestLog.js';

/**
 * THE ISSUED-DOCUMENT WORKER, RUNNING INSIDE THE API PROCESS.
 *
 * Issuing a permit writes an immutable snapshot and queues exactly one
 * `permit_document_jobs` row, in the same transaction as the status
 * change. Something then has to claim that row, render the PDF and
 * upload it. Until now the only thing that could was
 * `npm run documents:process`, a one-shot script an operator runs by
 * hand - so on a hosted deployment with a single Web Service, nothing
 * ever claimed anything. Jobs sat PENDING with `attempt_count = 0` and
 * `claimed_at = NULL`, and the download endpoint went on truthfully
 * answering 202 "still being prepared" forever.
 *
 * This is the missing piece: a timer that calls the SAME
 * `processPendingDocumentJobs` the script calls. Nothing about claiming,
 * locking, hashing, renderer pinning or immutability changes - this only
 * makes the existing worker actually run.
 *
 * FOUR PROPERTIES IT HAS TO HAVE.
 *
 * 1. IT MUST NEVER STOP. A tick that throws - the database blinking, a
 *    storage outage, a permission it does not have - is logged and the
 *    next tick still happens. A worker that dies on its first bad night
 *    is indistinguishable from the bug this exists to fix.
 * 2. TICKS MUST NOT OVERLAP. A slow render must not be joined by the
 *    next timer firing; a run in flight simply skips the tick. The
 *    database claim is safe under concurrency anyway (`FOR UPDATE SKIP
 *    LOCKED`, per-run claim token), but overlapping runs in ONE process
 *    would just multiply work against the same pool.
 * 3. IT MUST NOT HOLD THE PROCESS OPEN, BUT IT MUST FINISH WHAT IT
 *    STARTED. The timer is `unref`'d, so a deploy is never delayed by a
 *    worker waiting to tick. `stop()` prevents any FUTURE tick and then
 *    RESOLVES WHEN THE PASS ALREADY RUNNING HAS FINISHED - a render and
 *    upload in progress is never cut off, and the database pool is not
 *    closed underneath it. A pass is never cancelled or interrupted; it
 *    is waited for.
 * 4. IT MUST BE VISIBLE. Every failure is logged as an event, because a
 *    silent worker is exactly how this went unnoticed - a job that is
 *    never claimed leaves no trace on the job row at all.
 */

export interface DocumentJobWorker {
  /**
   * Stops all future ticks and resolves once any pass already in flight
   * has finished. Await it before closing the database pool. Idempotent:
   * every call returns the same promise.
   */
  stop: () => Promise<void>;
  /** Runs one tick now and resolves when it finishes - used by tests. */
  runOnce: () => Promise<void>;
}

export interface DocumentJobWorkerOptions {
  intervalMs?: number;
  /** Overridable for tests; production uses the real pool and adapter. */
  deps?: ProcessDocumentJobsDeps;
  storage?: DocumentStorageAdapter;
  process?: typeof processPendingDocumentJobs;
  log?: typeof logEvent;
  /** Injectable clock, so tests do not wait in real time. */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export function startDocumentJobWorker(options: DocumentJobWorkerOptions = {}): DocumentJobWorker {
  const intervalMs = options.intervalMs ?? env.DOCUMENT_WORKER_INTERVAL_MS;
  const run = options.process ?? processPendingDocumentJobs;
  const log = options.log ?? logEvent;
  const schedule = options.setInterval ?? globalThis.setInterval;
  const unschedule = options.clearInterval ?? globalThis.clearInterval;

  let stopped = false;
  /** The pass currently running, if any - what `stop()` waits for. */
  let inFlight: Promise<void> | null = null;
  /** Set on the first `stop()`, so repeat calls await the same shutdown. */
  let stopPromise: Promise<void> | null = null;

  /** One pass. Never rejects: a failure is logged and the loop continues. */
  async function runPass(): Promise<void> {
    try {
      const storage = options.storage ?? resolveDocumentStorageAdapter();
      const result = await run(options.deps ?? { query }, storage);
      // Only worth a line when something actually happened - an idle
      // poll every few seconds must not fill the log.
      if (result.processed > 0) {
        log('document_worker_run', {
          processed: result.processed,
          generated: result.generated,
          failed: result.failed,
        });
      }
    } catch (error) {
      // Requirement 1: log and carry on. The interval is untouched.
      log('document_worker_error', { detail: toSafeDbErrorMessage(error) });
    }
  }

  function tick(): Promise<void> {
    // Requirement 2: a run already in progress owns this cycle. Returning
    // it rather than a bare resolve means a caller awaiting a tick waits
    // for the real work, which is what makes `stop()` able to do the same.
    if (stopped) return inFlight ?? Promise.resolve();
    if (inFlight) return inFlight;
    const pass = runPass().finally(() => {
      inFlight = null;
    });
    inFlight = pass;
    return pass;
  }

  const timer = schedule(() => {
    void tick();
  }, intervalMs);
  // Requirement 3: never the reason a process stays alive.
  timer.unref?.();

  // A permit issued a moment ago should not wait a whole interval for its
  // document, and a restart should pick up anything left behind.
  void tick();

  log('document_worker_started', { intervalMs });

  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      // Future ticks stop immediately...
      stopped = true;
      unschedule(timer);
      // ...and the pass already running is waited for, not interrupted.
      // `runPass` never rejects, so this cannot reject either.
      const pending = inFlight;
      stopPromise = (pending ?? Promise.resolve()).then(() => {
        log('document_worker_stopped', { awaitedInFlightPass: pending !== null });
      });
      return stopPromise;
    },
    runOnce: tick,
  };
}
