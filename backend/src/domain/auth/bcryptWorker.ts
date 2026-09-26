import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/**
 * Legacy bcrypt comparison OFF the main event loop (A05-P1). bcryptjs is
 * pure JavaScript: its "async" compare runs each cost-10 comparison as one
 * ~90 ms setImmediate chunk on whichever thread calls it, which on the main
 * thread stalls every request. Here it runs in one dedicated worker thread;
 * the caller only awaits a message. Admission control (authWork.ts) bounds
 * how many comparisons can be waiting on it.
 *
 * The password crosses to the worker in one message and is not retained
 * there. A worker that errors, exits or exceeds the timeout is terminated,
 * its pending comparisons fail closed (false is never assumed true), and
 * the next call starts a fresh worker.
 */
const BCRYPT_PATH = createRequire(import.meta.url).resolve('bcryptjs');
const SOURCE = `
const { parentPort } = require('node:worker_threads');
const bcrypt = require(${JSON.stringify(BCRYPT_PATH)});
parentPort.on('message', ({ id, password, hash }) => {
  let ok = false;
  try { ok = bcrypt.compareSync(password, hash) === true; } catch { ok = false; }
  parentPort.postMessage({ id, ok });
});`;
const TIMEOUT_MS = 10_000;

interface Pending { resolve: (ok: boolean) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 0;

function fail(error: Error): void {
  const dead = worker;
  worker = null;
  for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(error); }
  void dead?.terminate();
}

function current(): Worker {
  if (worker) return worker;
  // Plain CommonJS source: no loader flags (execArgv) are inherited from the parent.
  const created = new Worker(SOURCE, { eval: true, execArgv: [] });
  created.on('message', ({ id, ok }: { id: number; ok: boolean }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(ok === true);
  });
  created.on('error', () => { if (worker === created) fail(new Error('bcrypt worker failed')); });
  created.on('exit', () => { if (worker === created) fail(new Error('bcrypt worker exited')); });
  // After the listeners: attaching a 'message' listener re-references the
  // port. An idle worker must never keep the process alive; a pending
  // comparison does, through its timeout timer.
  created.unref();
  worker = created;
  return created;
}

export function bcryptCompare(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const id = (nextId += 1);
    const timer = setTimeout(() => { if (pending.has(id)) fail(new Error('bcrypt comparison timed out')); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    current().postMessage({ id, password, hash });
  });
}

/** Shutdown: stop the worker; in-flight comparisons fail closed. */
export async function closeBcryptWorker(): Promise<void> {
  if (worker) fail(new Error('bcrypt worker closed'));
}
