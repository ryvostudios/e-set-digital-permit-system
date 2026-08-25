import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closePermitBodySchema,
  MAX_PAGE_SIZE,
  MAX_PAGINATION_OFFSET,
  paginationQuerySchema,
  permitQueueQuerySchema,
} from './validation.js';

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

// --- paginationQuerySchema ---

test('paginationQuerySchema defaults page to 1 and pageSize to the safe default when omitted', () => {
  const result = paginationQuerySchema.safeParse({});
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page, 1);
  assert.equal(result.data.pageSize, 20);
});

test('paginationQuerySchema coerces string query-param values (page/pageSize arrive as strings over HTTP)', () => {
  const result = paginationQuerySchema.safeParse({ page: '3', pageSize: '10' });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page, 3);
  assert.equal(result.data.pageSize, 10);
});

test('paginationQuerySchema rejects page < 1', () => {
  assert.equal(paginationQuerySchema.safeParse({ page: 0 }).success, false);
  assert.equal(paginationQuerySchema.safeParse({ page: -1 }).success, false);
});

test('paginationQuerySchema rejects a non-integer page/pageSize', () => {
  assert.equal(paginationQuerySchema.safeParse({ page: 1.5 }).success, false);
  assert.equal(paginationQuerySchema.safeParse({ pageSize: 2.5 }).success, false);
});

test(`paginationQuerySchema enforces a hard maximum page size (${MAX_PAGE_SIZE}) - no unbounded result retrieval`, () => {
  assert.equal(paginationQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE }).success, true);
  assert.equal(paginationQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success, false);
  assert.equal(paginationQuerySchema.safeParse({ pageSize: 1_000_000 }).success, false);
});

test('paginationQuerySchema rejects pageSize < 1', () => {
  assert.equal(paginationQuerySchema.safeParse({ pageSize: 0 }).success, false);
});

test('permitQueueQuerySchema accepts pagination params alongside status (composition, not a separate/duplicated schema)', () => {
  const result = permitQueueQuerySchema.safeParse({ status: 'PENDING_CRO', page: '2', pageSize: '5' });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page, 2);
  assert.equal(result.data.pageSize, 5);
});

test('permitQueueQuerySchema still defaults pagination when only status is given (backwards-compatible with the pre-pagination query shape)', () => {
  const result = permitQueueQuerySchema.safeParse({ status: 'ISSUED' });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page, 1);
  assert.equal(result.data.pageSize, 20);
});

// --- MAX_PAGINATION_OFFSET: bounding the COMPUTED offset, not just page/pageSize individually ---

test('paginationQuerySchema: the first page (offset 0) is always accepted, regardless of pageSize', () => {
  assert.equal(paginationQuerySchema.safeParse({ page: 1, pageSize: 1 }).success, true);
  assert.equal(paginationQuerySchema.safeParse({ page: 1, pageSize: MAX_PAGE_SIZE }).success, true);
});

test(`paginationQuerySchema: accepts the exact maximum allowed offset (${MAX_PAGINATION_OFFSET})`, () => {
  // (1001 - 1) * 100 === 100_000, exactly MAX_PAGINATION_OFFSET.
  const atMaxWithMaxPageSize = paginationQuerySchema.safeParse({ page: 1001, pageSize: 100 });
  assert.equal(atMaxWithMaxPageSize.success, true);

  // (5001 - 1) * 20 === 100_000 too - the same offset ceiling reached via a different pageSize.
  const atMaxWithDefaultPageSize = paginationQuerySchema.safeParse({ page: 5001, pageSize: 20 });
  assert.equal(atMaxWithDefaultPageSize.success, true);
});

test('paginationQuerySchema: rejects exactly one page beyond the maximum allowed offset', () => {
  // (1002 - 1) * 100 === 100_100, one pageSize-unit past MAX_PAGINATION_OFFSET.
  const oneBeyond = paginationQuerySchema.safeParse({ page: 1002, pageSize: 100 });
  assert.equal(oneBeyond.success, false);
});

test('paginationQuerySchema: pageSize alone does not bound the offset - a huge page with a small pageSize is still rejected once the product exceeds the cap', () => {
  // page=100_001 with the smallest pageSize (1) still produces offset
  // 100_000 - accepted; one page further must be rejected, proving the
  // bound is on the OFFSET, not merely on `page` using some fixed
  // assumed pageSize.
  assert.equal(paginationQuerySchema.safeParse({ page: 100_001, pageSize: 1 }).success, true);
  assert.equal(paginationQuerySchema.safeParse({ page: 100_002, pageSize: 1 }).success, false);
});

test('paginationQuerySchema rejects page=Number.MAX_SAFE_INTEGER (syntactically a valid integer, but a pathological offset)', () => {
  const result = paginationQuerySchema.safeParse({ page: Number.MAX_SAFE_INTEGER, pageSize: 20 });
  assert.equal(result.success, false);
});

test('paginationQuerySchema rejects a page/pageSize combination whose product is not a safe integer (multiplication overflow)', () => {
  // Both dimensions large enough that (page - 1) * pageSize is nowhere
  // near a safe integer, independent of the MAX_PAGINATION_OFFSET
  // magnitude check alone - exercising the `Number.isSafeInteger` guard
  // specifically (see rejectExcessivePaginationOffset in validation.ts).
  const result = paginationQuerySchema.safeParse({ page: Number.MAX_SAFE_INTEGER, pageSize: MAX_PAGE_SIZE });
  assert.equal(result.success, false);
});

test('paginationQuerySchema: ordinary pagination (small page numbers) still works exactly as before', () => {
  assert.equal(paginationQuerySchema.safeParse({}).success, true);
  assert.equal(paginationQuerySchema.safeParse({ page: 2, pageSize: 20 }).success, true);
  assert.equal(paginationQuerySchema.safeParse({ page: 10, pageSize: 50 }).success, true);
});

test('permitQueueQuerySchema: the same offset bound applies when composed with `status` (no ownership/status-queue leakage regression - an excessive offset is rejected before any query is built, same as the bare pagination schema)', () => {
  const withinBound = permitQueueQuerySchema.safeParse({ status: 'PENDING_CRO', page: 1001, pageSize: 100 });
  assert.equal(withinBound.success, true);

  const overBound = permitQueueQuerySchema.safeParse({ status: 'PENDING_CRO', page: 1002, pageSize: 100 });
  assert.equal(overBound.success, false);

  const pathological = permitQueueQuerySchema.safeParse({ status: 'ISSUED', page: Number.MAX_SAFE_INTEGER, pageSize: 100 });
  assert.equal(pathological.success, false);
});
