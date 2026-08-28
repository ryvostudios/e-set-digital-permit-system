import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERMIT_TYPE_LABELS, toDisplayNumber, toPermitLabel } from './numbering.js';

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

/**
 * PER-TYPE NUMBERING AND HOW A PERMIT IS NAMED (migration 0033).
 *
 * The AUTHORITATIVE permit number stays the bare per-type sequence
 * everywhere it is an identifier - `permitDisplayNumber`, the PDF's
 * Permit No., the issued snapshot, the record screen. `toPermitLabel` is
 * only for prose a person reads, where "Permit 1" alone would now name
 * four different permits.
 */

test('the authoritative display number never gains a type prefix', () => {
  // The examples that were explicitly rejected as the authoritative form.
  for (const rejected of ['CW-1', 'HW-1', 'WTG-1', 'CSE-1']) {
    assert.notEqual(toDisplayNumber(1n), rejected);
  }
  assert.equal(toDisplayNumber(1n), '1');
});

test('toPermitLabel names the type beside the bare number, for prose only', () => {
  assert.equal(toPermitLabel('WTG_WORK', 1n), 'WTG Work Permit 1');
  assert.equal(toPermitLabel('COLD_WORK', 1n), 'Cold Work Permit 1');
  assert.equal(toPermitLabel('HOT_WORK', 1n), 'Hot Work Permit 1');
  assert.equal(toPermitLabel('CONFINED_SPACE_ENTRY', 1n), 'Confined Space Entry Permit 1');
  // The number inside it is the stored one, unchanged and unpadded.
  assert.equal(toPermitLabel('COLD_WORK', 1045n), 'Cold Work Permit 1045');
});

test('the same number in different types produces four distinguishable labels', () => {
  const labels = (Object.keys(PERMIT_TYPE_LABELS) as (keyof typeof PERMIT_TYPE_LABELS)[])
    .map((type) => toPermitLabel(type, 1n));
  assert.equal(new Set(labels).size, 4, 'each type must read differently at the same number');
  // ...while the underlying authoritative number is identical for all four.
  assert.equal(new Set([1n, 1n, 1n, 1n].map(toDisplayNumber)).size, 1);
});

test('a pre-form permit with no type still reads sensibly', () => {
  assert.equal(toPermitLabel(null, 7n), 'Permit 7');
});
