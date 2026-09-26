import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthWorkBusy, AuthWorkLimiter } from './authWork.js';

/* A05-P1: the admission limiter in front of every password KDF. */
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const settled = async (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.constructor.name);

test('capacity exactly full, one above capacity queues, queue exactly full, overflow refused at once', async () => {
  const limiter = new AuthWorkLimiter(2, 2, 5_000);
  const g = gate();
  const running = [limiter.run(() => g.p), limiter.run(() => g.p)];
  assert.deepEqual(limiter.stats(), { active: 2, queued: 0 });
  const queued = [limiter.run(async () => 'q1'), limiter.run(async () => 'q2')];
  assert.deepEqual(limiter.stats(), { active: 2, queued: 2 });
  const started = performance.now();
  await assert.rejects(limiter.run(async () => 'overflow'), AuthWorkBusy);
  assert.ok(performance.now() - started < 50, 'overflow is refused immediately, never queued');
  g.open();
  await Promise.all(running);
  assert.deepEqual(await Promise.all(queued), ['q1', 'q2']);
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('a queued request whose client disconnects leaves the queue and never runs', async () => {
  const limiter = new AuthWorkLimiter(1, 4, 5_000);
  const g = gate();
  const running = limiter.run(() => g.p);
  const abandoned = new AbortController();
  let ran = false;
  const waiting = limiter.run(async () => { ran = true; }, abandoned.signal);
  assert.equal(limiter.stats().queued, 1);
  abandoned.abort();
  assert.equal(await settled(waiting), 'AuthWorkBusy');
  assert.equal(limiter.stats().queued, 0);
  g.open(); await running;
  assert.equal(ran, false);
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
  // an already-aborted signal never takes a slot
  await assert.rejects(limiter.run(async () => 1, AbortSignal.abort()), AuthWorkBusy);
});

test('KDF rejection releases its slot; the next waiter runs', async () => {
  const limiter = new AuthWorkLimiter(1, 1, 5_000);
  const failing = limiter.run(async () => { throw new Error('kdf failed'); });
  const next = limiter.run(async () => 'next');
  await assert.rejects(failing, /kdf failed/);
  assert.equal(await next, 'next');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('waiting is bounded: a queued request times out as busy and is removed', async () => {
  const limiter = new AuthWorkLimiter(1, 2, 150);
  const g = gate();
  const running = limiter.run(() => g.p);
  const started = performance.now();
  await assert.rejects(limiter.run(async () => 1), /Timed out/);
  const waited = performance.now() - started;
  assert.ok(waited >= 140 && waited < 1_000, `waited ${waited}`);
  assert.equal(limiter.stats().queued, 0);
  g.open(); await running;
});

test('shutdown refuses queued and new work; running work completes', async () => {
  const limiter = new AuthWorkLimiter(1, 4, 5_000);
  const g = gate();
  const running = limiter.run(async () => { await g.p; return 'finished'; });
  const queued = limiter.run(async () => 'never');
  limiter.close();
  assert.equal(await settled(queued), 'AuthWorkBusy');
  await assert.rejects(limiter.run(async () => 'late'), AuthWorkBusy);
  g.open();
  assert.equal(await running, 'finished');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('never more than `concurrency` running under a burst of 200 (no unbounded promise queue)', async () => {
  const limiter = new AuthWorkLimiter(3, 10, 5_000);
  let running = 0; let peak = 0;
  const outcomes = await Promise.all(Array.from({ length: 200 }, () => settled(limiter.run(async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  }))));
  assert.equal(peak, 3);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 13, '3 running + 10 queued');
  assert.equal(outcomes.filter((o) => o === 'AuthWorkBusy').length, 187);
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});
