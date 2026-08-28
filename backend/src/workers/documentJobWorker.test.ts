import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startDocumentJobWorker } from './documentJobWorker.js';
import type { ProcessDocumentJobsResult } from '../domain/permits/documents.js';

/**
 * THE WORKER THAT NEVER RAN.
 *
 * A hosted permit reached ISSUED, its snapshot was written and its
 * `permit_document_jobs` row was queued - and then nothing happened. The
 * row sat PENDING with `attempt_count = 0`, `claimed_at = NULL`,
 * `renderer_version = NULL`, and `GET /permits/:id/pdf` went on answering
 * 202 "still being prepared" indefinitely.
 *
 * Nothing was broken in claiming, rendering or uploading. The worker
 * simply was not running: it existed only as `npm run documents:process`,
 * a one-shot script nobody runs on a Web Service. `attempt_count = 0` is
 * the proof - a render or upload failure would have incremented it.
 *
 * These specs pin the two halves of the fix: the server STARTS the
 * worker, and the worker keeps ticking whatever happens to any one tick.
 */

const idle: ProcessDocumentJobsResult = { processed: 0, generated: 0, failed: 0 };

/** A controllable interval, so nothing here waits in real time. */
function fakeTimers() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  const setIntervalStub = ((handler: () => void) => {
    ticks.push(handler);
    return { unref: () => {} } as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;
  const clearIntervalStub = (() => {
    cleared += 1;
  }) as unknown as typeof globalThis.clearInterval;
  return {
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    fire: () => ticks.forEach((handler) => handler()),
    get cleared() {
      return cleared;
    },
  };
}

test('the server bootstrap starts the worker - the thing that was missing', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(source, /startDocumentJobWorker/, 'index.ts must start the document worker');
  assert.match(source, /DOCUMENT_WORKER_ENABLED/, 'starting it must be configurable');
  // Started after the port is open, and stopped on the way down. Scoped
  // to the function body: the import at the top of the file mentions the
  // worker before `app.listen` and would make a whole-file scan lie.
  const body = source.slice(source.indexOf('async function main'));
  assert.ok(
    body.indexOf('app.listen') < body.indexOf('startDocumentJobWorker('),
    'the worker must start after the port is open',
  );
  assert.match(source, /documentWorker\?\.stop\(\)/, 'shutdown must stop the worker');
  // Anchored on the CALL SITES, not on any textual occurrence: `closePool`
  // also appears in the import, in the startup database check, and in a
  // comment inside the shutdown block itself.
  const shutdownBlock = body.slice(body.indexOf('const shutdown ='));
  assert.ok(
    shutdownBlock.indexOf('documentWorker?.stop()') < shutdownBlock.indexOf('.then(() => closePool())'),
    'the worker must stop before the pool closes',
  );
});

test('starting the worker runs a pass immediately, without waiting for the first interval', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const worker = startDocumentJobWorker({
    process: async () => {
      runs += 1;
      return idle;
    },
    deps: { query: (async () => ({ rows: [] })) as never },
    storage: { upload: async () => ({ ok: true }), download: async () => ({ ok: true, data: Buffer.alloc(0) }) },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await worker.runOnce();
  assert.ok(runs >= 1, 'a permit issued a moment ago must not wait a whole interval');
  await worker.stop();
});

test('a due job is claimed and generated once the worker is running', async () => {
  // The hosted-equivalent shape: one PENDING job, already due.
  const jobs = [{ id: 'job-1', status: 'PENDING', attempt_count: 0, claimed_at: null as string | null }];
  const timers = fakeTimers();
  const worker = startDocumentJobWorker({
    process: async () => {
      const pending = jobs.filter((job) => job.status === 'PENDING');
      for (const job of pending) {
        job.status = 'GENERATED';
        job.attempt_count += 1;
        job.claimed_at = '2026-01-01T00:00:00.000Z';
      }
      return { processed: pending.length, generated: pending.length, failed: 0 };
    },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  await worker.runOnce();
  assert.deepEqual(jobs[0], {
    id: 'job-1',
    status: 'GENERATED',
    attempt_count: 1,
    claimed_at: '2026-01-01T00:00:00.000Z',
  });
  await worker.stop();
});

test('a failing tick does not stop the worker - the next one still runs', async () => {
  const timers = fakeTimers();
  const events: string[] = [];
  let runs = 0;
  const worker = startDocumentJobWorker({
    process: async () => {
      runs += 1;
      if (runs <= 2) throw new Error('storage unavailable');
      return { processed: 1, generated: 1, failed: 0 };
    },
    log: (event) => events.push(event),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) await worker.runOnce();

  assert.ok(runs >= 3, `the worker must keep running after a failure (ran ${runs} times)`);
  assert.ok(events.filter((event) => event === 'document_worker_error').length >= 2, 'failures are logged');
  assert.ok(events.includes('document_worker_run'), 'and it recovers rather than dying');
  await worker.stop();
});

test('a database error in one tick is reported without leaking connection detail', async () => {
  const timers = fakeTimers();
  const logged: { event: string; fields: Record<string, unknown> }[] = [];
  const worker = startDocumentJobWorker({
    process: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2');
    },
    log: (event, fields) => logged.push({ event, fields: fields as Record<string, unknown> }),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await worker.runOnce();

  const failure = logged.find((entry) => entry.event === 'document_worker_error');
  assert.ok(failure, 'the failure must be visible');
  assert.ok(!JSON.stringify(failure.fields).includes('hunter2'), 'and must not carry a credential');
  await worker.stop();
});

test('ticks never overlap - a slow pass owns its cycle', async () => {
  const timers = fakeTimers();
  let active = 0;
  let maxActive = 0;
  // A holder, not a bare `let`: TypeScript narrows a variable only
  // assigned inside a callback to `never` at the call site.
  const gate: { release?: () => void } = {};
  const worker = startDocumentJobWorker({
    process: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      active -= 1;
      return idle;
    },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  // The immediate pass is still in flight; three more timer firings land
  // on top of it and must all be skipped.
  timers.fire();
  timers.fire();
  timers.fire();
  assert.equal(maxActive, 1, 'a run in flight must not be joined by another');
  gate.release?.();
  await worker.stop();
});

test('the worker never holds the process open', async () => {
  let unrefCalled = false;
  const worker = startDocumentJobWorker({
    process: async () => idle,
    log: () => {},
    setInterval: (() => ({ unref: () => { unrefCalled = true; } }) as unknown as NodeJS.Timeout) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
  });
  assert.equal(unrefCalled, true, 'the poll timer must be unref-d so a deploy is never delayed');
  await worker.stop();
});

test('an idle poll logs nothing, so the log stays readable', async () => {
  const timers = fakeTimers();
  const events: string[] = [];
  const worker = startDocumentJobWorker({
    process: async () => idle,
    log: (event) => events.push(event),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await worker.runOnce();
  await worker.runOnce();

  assert.ok(!events.includes('document_worker_run'), 'an idle poll must not be logged');
  assert.ok(events.includes('document_worker_started'), 'but starting is');
  await worker.stop();
});

test('the operator script and the in-process worker call the same entry point', async () => {
  const script = await readFile(new URL('../scripts/processDocumentJobs.ts', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('./documentJobWorker.ts', import.meta.url), 'utf8');
  // One implementation of claiming/rendering/uploading, two ways to run
  // it - a separate worker service stays a valid deployment.
  assert.match(script, /processPendingDocumentJobs/);
  assert.match(workerSource, /processPendingDocumentJobs/);
  // And the worker changes none of the protections.
  assert.ok(!/DISABLE TRIGGER|renderer_version\s*=/.test(workerSource));
});

// ---------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------

/**
 * `stop()` used to only clear the interval, so shutdown could close the
 * database pool while a pass was mid-claim or mid-upload. It now also
 * WAITS for that pass - never cancels it - and `index.ts` closes the pool
 * only after the promise it returns has resolved.
 */

test('stop waits for an in-flight pass, and resolves only after it finishes', async () => {
  const timers = fakeTimers();
  const gate: { release?: () => void } = {};
  let finished = false;
  const worker = startDocumentJobWorker({
    process: async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      finished = true;
      return idle;
    },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  // The immediate pass is in flight and deliberately not finished.
  let stopResolved = false;
  const stopping = worker.stop().then(() => {
    stopResolved = true;
  });

  // stop() must not resolve while the pass is still running.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false, 'the pass is still running');
  assert.equal(stopResolved, false, 'stop must not resolve before the pass finishes');

  gate.release?.();
  await stopping;
  assert.equal(finished, true, 'the pass ran to completion - it was waited for, not cancelled');
  assert.equal(stopResolved, true);
});

test('the pool is closed only after the in-flight pass has finished', async () => {
  const order: string[] = [];
  const timers = fakeTimers();
  const gate: { release?: () => void } = {};
  const worker = startDocumentJobWorker({
    process: async () => {
      order.push('pass_started');
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      order.push('pass_finished');
      return idle;
    },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  // The shutdown sequence index.ts performs, in the same order.
  const closePool = async (): Promise<void> => {
    order.push('pool_closed');
  };
  const shutdown = worker.stop().then(() => closePool());

  await Promise.resolve();
  assert.deepEqual(order, ['pass_started'], 'the pool must not close while the pass runs');

  gate.release?.();
  await shutdown;
  assert.deepEqual(order, ['pass_started', 'pass_finished', 'pool_closed']);
});

test('stop with nothing in flight resolves immediately', async () => {
  const timers = fakeTimers();
  const worker = startDocumentJobWorker({
    process: async () => idle,
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await worker.runOnce();
  // No pass running: shutdown is not delayed at all.
  await worker.stop();
});

test('stop is idempotent - two calls share one shutdown and one clearInterval', async () => {
  const timers = fakeTimers();
  const gate: { release?: () => void } = {};
  let passes = 0;
  const events: string[] = [];
  const worker = startDocumentJobWorker({
    process: async () => {
      passes += 1;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return idle;
    },
    log: (event) => events.push(event),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  const first = worker.stop();
  const second = worker.stop();
  assert.equal(first, second, 'repeat calls must return the same promise, not start a second shutdown');

  gate.release?.();
  await Promise.all([first, second]);

  assert.equal(timers.cleared, 1, 'the interval is cleared exactly once');
  assert.equal(events.filter((event) => event === 'document_worker_stopped').length, 1, 'stopped is logged once');
  assert.equal(passes, 1, 'no extra pass was started by stopping twice');
});

test('no pass can start after stop, including from a timer that was already queued', async () => {
  const timers = fakeTimers();
  let passes = 0;
  const worker = startDocumentJobWorker({
    process: async () => {
      passes += 1;
      return idle;
    },
    log: () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await worker.runOnce();
  const before = passes;

  await worker.stop();

  // A timer firing after stop, and an explicit tick, must both do nothing.
  timers.fire();
  await worker.runOnce();
  assert.equal(passes, before, 'no pass may start once shutdown has begun');
});

test('index.ts closes the pool only after awaiting the worker', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function main'));
  // The stop promise is captured, and the pool close is chained onto it.
  assert.match(body, /const workerStopped = documentWorker\?\.stop\(\) \?\? Promise\.resolve\(\);/);
  // The pool close is CHAINED onto the worker promise - the only ordering
  // that actually guarantees it, and the only occurrence worth matching.
  assert.match(body, /workerStopped[\s\S]*?\.then\(\(\) => closePool\(\)\)/);
  assert.ok(
    body.indexOf('const workerStopped') < body.indexOf('.then(() => closePool())'),
    'the worker must be awaited before the pool closes',
  );
  // The force-exit timer still bounds the whole shutdown.
  assert.match(body, /FORCE_SHUTDOWN_TIMEOUT_MS/);
});
