import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeNextMidnightUtc, isPermitValid } from './validity.js';

test('computeNextMidnightUtc: issued 09:00 UTC expires at the next 00:00 UTC', () => {
  const issued = new Date('2026-03-05T09:00:00.000Z');
  const expiry = computeNextMidnightUtc(issued, 'UTC');
  assert.equal(expiry.toISOString(), '2026-03-06T00:00:00.000Z');
});

test('computeNextMidnightUtc: issued 23:50 UTC expires at the same next-day 00:00 UTC boundary', () => {
  const issued = new Date('2026-03-05T23:50:00.000Z');
  const expiry = computeNextMidnightUtc(issued, 'UTC');
  assert.equal(expiry.toISOString(), '2026-03-06T00:00:00.000Z');
});

test('computeNextMidnightUtc: a fixed positive-offset zone (Asia/Karachi, UTC+5, no DST)', () => {
  // 2026-03-05T04:00:00Z is 2026-03-05 09:00 local (PKT).
  const issued = new Date('2026-03-05T04:00:00.000Z');
  const expiry = computeNextMidnightUtc(issued, 'Asia/Karachi');
  // Next local midnight is 2026-03-06T00:00:00+05:00 == 2026-03-05T19:00:00Z.
  assert.equal(expiry.toISOString(), '2026-03-05T19:00:00.000Z');
});

test('computeNextMidnightUtc: a DST-observing zone (America/New_York, EDT/UTC-4 in June)', () => {
  // 2026-06-15T14:00:00Z is 2026-06-15 10:00 local (EDT, UTC-4).
  const issued = new Date('2026-06-15T14:00:00.000Z');
  const expiry = computeNextMidnightUtc(issued, 'America/New_York');
  // Next local midnight is 2026-06-16T00:00:00-04:00 == 2026-06-16T04:00:00Z.
  assert.equal(expiry.toISOString(), '2026-06-16T04:00:00.000Z');
});

test('isPermitValid: true strictly before the next-midnight boundary, false at/after it', () => {
  const issued = new Date('2026-03-05T09:00:00.000Z');
  const justBefore = new Date('2026-03-05T23:59:59.999Z');
  const atBoundary = new Date('2026-03-06T00:00:00.000Z');
  const after = new Date('2026-03-06T00:00:00.001Z');

  assert.equal(isPermitValid(issued, 'UTC', justBefore), true);
  assert.equal(isPermitValid(issued, 'UTC', atBoundary), false);
  assert.equal(isPermitValid(issued, 'UTC', after), false);
});

test('isPermitValid never depends on client-supplied time - only the instants passed in', () => {
  const issued = new Date('2026-03-05T09:00:00.000Z');
  const now = new Date('2026-03-05T10:00:00.000Z');
  assert.equal(isPermitValid(issued, 'Asia/Karachi', now), true);
});
