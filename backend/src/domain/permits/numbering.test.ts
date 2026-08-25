import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toDisplayNumber } from './numbering.js';

test('toDisplayNumber renders the raw sequence value with no invented prefix or padding', () => {
  assert.equal(toDisplayNumber(1n), '1');
  assert.equal(toDisplayNumber(42n), '42');
  assert.equal(toDisplayNumber(1_234_567n), '1234567');
});

test('distinct sequence values always render to distinct display numbers', () => {
  const values = [1n, 2n, 3n, 999_999n, 1_000_000n];
  const formatted = values.map((value) => toDisplayNumber(value));
  assert.equal(new Set(formatted).size, formatted.length);
});

test('concurrent-style rendering of unique sequence values never collides', async () => {
  // Simulates the pattern used by domain/permits/service.ts: each
  // "concurrent" caller receives its own already-unique sequence value
  // (as Postgres's nextval() guarantees, via the permit_sequence/
  // jsa_sequence column DEFAULT) and renders it independently. This
  // exercises that rendering has no shared mutable state that could
  // reintroduce a collision on top of that guarantee.
  const callers = Array.from({ length: 50 }, (_, i) => BigInt(i + 1));
  const results = await Promise.all(
    callers.map(async (value) => {
      await Promise.resolve(); // force interleaving
      return toDisplayNumber(value);
    }),
  );
  assert.equal(new Set(results).size, results.length);
});
