import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERMIT_NUMBER_PREFIXES,
  PERMIT_TYPE_LABELS,
  UNASSIGNED_PERMIT_NUMBER,
  hasPermitNumber,
  toDisplayNumber,
  toPermitLabel,
  toPermitNumber,
} from './numbering.js';

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
  assert.equal(toPermitLabel('WTG_WORK', 1n), 'WTG Work Permit WTG-1');
  assert.equal(toPermitLabel('COLD_WORK', 1n), 'Cold Work Permit CW-1');
  assert.equal(toPermitLabel('HOT_WORK', 1n), 'Hot Work Permit HW-1');
  assert.equal(toPermitLabel('CONFINED_SPACE_ENTRY', 1n), 'Confined Space Entry Permit CS-1');
  // The number inside it is the stored one, unchanged and unpadded.
  assert.equal(toPermitLabel('COLD_WORK', 1045n), 'Cold Work Permit CW-1045');
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
  // ...and a draft, which has no number at all.
  assert.equal(toPermitLabel('HOT_WORK', null), 'Hot Work Permit Not assigned');
});

// ---------------------------------------------------------------------
// The authoritative permit number, as people read it
// ---------------------------------------------------------------------

/**
 * A DRAFT HAS NO NUMBER, and a submitted permit has a prefixed one.
 *
 * The number is issued by the database on the first successful
 * submission (migration 0034), so everything before that has nothing to
 * show - and must say so rather than invent a `0`, a `-`, or the number
 * the draft would get if it were submitted this second.
 */

test('a submitted permit reads as PREFIX-N, derived from its type', () => {
  assert.equal(toPermitNumber('WTG_WORK', 1n), 'WTG-1');
  assert.equal(toPermitNumber('COLD_WORK', 1n), 'CW-1');
  assert.equal(toPermitNumber('HOT_WORK', 1n), 'HW-1');
  assert.equal(toPermitNumber('CONFINED_SPACE_ENTRY', 1n), 'CS-1');
  assert.equal(toPermitNumber('HOT_WORK', 12n), 'HW-12');
});

test('the prefix is derived from the permit type, never stored beside it', () => {
  assert.deepEqual(PERMIT_NUMBER_PREFIXES, {
    WTG_WORK: 'WTG',
    COLD_WORK: 'CW',
    HOT_WORK: 'HW',
    CONFINED_SPACE_ENTRY: 'CS',
  });
  // Every type has exactly one prefix, and no two share one.
  const prefixes = Object.values(PERMIT_NUMBER_PREFIXES);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test('a draft reads "Not assigned" - never a fabricated or predicted number', () => {
  assert.equal(toPermitNumber('HOT_WORK', null), 'Not assigned');
  assert.equal(toPermitNumber('HOT_WORK', undefined), 'Not assigned');
  assert.equal(UNASSIGNED_PERMIT_NUMBER, 'Not assigned');
  // Specifically not any of the things it must not be.
  for (const wrong of ['0', 'HW-0', '-', '', 'HW-1']) {
    assert.notEqual(toPermitNumber('HOT_WORK', null), wrong);
  }
});

test('the same number in different types reads differently', () => {
  const rendered = (['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const).map((type) =>
    toPermitNumber(type, 1n),
  );
  assert.deepEqual(rendered, ['WTG-1', 'CW-1', 'HW-1', 'CS-1']);
  assert.equal(new Set(rendered).size, 4, 'four different permits, four different names');
});

test('it accepts the shapes the database and API actually carry', () => {
  // A bigint column comes back as text through the driver.
  assert.equal(toPermitNumber('COLD_WORK', '4'), 'CW-4');
  assert.equal(toPermitNumber('COLD_WORK', 4), 'CW-4');
  assert.equal(toPermitNumber('COLD_WORK', 4n), 'CW-4');
});

test('a pre-form permit with no type keeps its bare number', () => {
  assert.equal(toPermitNumber(null, 7n), '7');
});

test('hasPermitNumber says whether a permit is in the register yet', () => {
  assert.equal(hasPermitNumber(null), false);
  assert.equal(hasPermitNumber(undefined), false);
  assert.equal(hasPermitNumber(0), true);
  assert.equal(hasPermitNumber('1'), true);
});

test('the JSA number is NOT prefixed - its series is unchanged', () => {
  // JSA numbering is one global series and reads as a bare number.
  assert.equal(toDisplayNumber(5n), '5');
  assert.ok(!toDisplayNumber(5n).includes('-'));
});
