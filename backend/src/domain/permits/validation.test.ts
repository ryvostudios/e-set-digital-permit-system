import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closePermitBodySchema } from './validation.js';

test('closePermitBodySchema accepts version alone (closureRemarks stays optional - not required, per the unresolved-mandatory-remarks decision)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1 });
  assert.equal(result.success, true);
});

test('closePermitBodySchema accepts version with closureRemarks', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closureRemarks: 'Area inspected, all clear.' });
  assert.equal(result.success, true);
});

test('closePermitBodySchema rejects an empty-string closureRemarks when the field is present', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closureRemarks: '' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects an oversized closureRemarks', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closureRemarks: 'x'.repeat(2001) });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects a client-supplied closedBy (cannot spoof the actor - .strict() rejects unknown keys)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closedBy: 'some-other-user-id' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects a client-supplied closedAt (cannot spoof the timestamp - .strict() rejects unknown keys)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects a client-supplied closed_by (cannot spoof the actor via the DB column name either)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closed_by: 'some-other-user-id' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects a client-supplied closed_at (cannot spoof the timestamp via the DB column name either)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, closed_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema rejects a client-supplied status (cannot spoof/force the resulting status)', () => {
  const result = closePermitBodySchema.safeParse({ version: 1, status: 'CLOSED' });
  assert.equal(result.success, false);
});

test('closePermitBodySchema still accepts only the legitimate shape (version, optional closureRemarks) alongside all of the above', () => {
  const versionOnly = closePermitBodySchema.safeParse({ version: 1 });
  const withRemarks = closePermitBodySchema.safeParse({ version: 1, closureRemarks: 'Area inspected, all clear.' });
  assert.equal(versionOnly.success, true);
  assert.equal(withRemarks.success, true);
});

test('closePermitBodySchema requires version', () => {
  const result = closePermitBodySchema.safeParse({ closureRemarks: 'Area inspected.' });
  assert.equal(result.success, false);
});
