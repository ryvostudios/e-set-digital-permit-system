import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import { bcryptCompare, closeBcryptWorker } from './bcryptWorker.js';

/* A05-P1: legacy bcrypt runs in a worker thread, never on the event loop. */
test('compares correctly and fails closed on malformed input', async () => {
  const hash = await bcrypt.hash('FAKE-worker-password', 10);
  assert.equal(await bcryptCompare('FAKE-worker-password', hash), true);
  assert.equal(await bcryptCompare('FAKE-wrong', hash), false);
  assert.equal(await bcryptCompare('x', 'not-a-bcrypt-hash'), false);
});

test('the event loop stays free during comparisons', async () => {
  const hash = await bcrypt.hash('FAKE-worker-password', 10);
  let ticks = 0; let stop = false;
  const ticker = (async () => { while (!stop) { ticks += 1; await new Promise((r) => setTimeout(r, 5)); } })();
  await Promise.all(Array.from({ length: 4 }, () => bcryptCompare('FAKE-wrong', hash)));
  stop = true; await ticker;
  assert.ok(ticks >= 20, `timers kept firing during ~4 serial compares (${ticks} ticks)`);
});

test('a worker stopped mid-comparison fails that comparison closed; the next call gets a fresh worker', async () => {
  const hash = await bcrypt.hash('FAKE-worker-password', 10);
  const inFlight = bcryptCompare('FAKE-worker-password', hash);
  await closeBcryptWorker();
  await assert.rejects(inFlight);
  assert.equal(await bcryptCompare('FAKE-worker-password', hash), true);
});
