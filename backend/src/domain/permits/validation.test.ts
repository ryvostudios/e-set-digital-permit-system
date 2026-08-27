import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closePermitBodySchema,
  createPermitBodySchema,
  MAX_PAGE_SIZE,
  MAX_PAGINATION_OFFSET,
  paginationQuerySchema,
  permitQueueQuerySchema,
  permitSearchQuerySchema,
  updateJsaBodySchema,
  updatePermitBodySchema,
} from './validation.js';

test('applicant company identity is never accepted from a permit-edit client', () => {
  for (const body of [
    { version: 1, company: 'ESET' }, { version: 1, company: 'OTHER', companyOther: 'Vendor' },
    { version: 1, companyCode: 'ZPL' }, { version: 1, companyId: '00000000-0000-4000-8000-000000000001' },
  ]) assert.equal(updatePermitBodySchema.safeParse(body).success, false);
});

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

/**
 * Request-contract tests for the schemas migration 0016 introduced or
 * extended. These run without HTTP on purpose - the route wiring is
 * proved in routes/permitFormRoutes.test.ts, and the mutation rate
 * limiter is a per-process budget that request-level coverage of every
 * rejection case would exhaust.
 */

test('createPermitBodySchema accepts exactly the four confirmed templates and nothing else', () => {
  for (const permitType of ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY']) {
    assert.equal(createPermitBodySchema.safeParse({ permitType }).success, true);
  }
  assert.equal(createPermitBodySchema.safeParse({}).success, false);
  assert.equal(createPermitBodySchema.safeParse({ permitType: 'ELECTRICAL_WORK' }).success, false);
  assert.equal(createPermitBodySchema.safeParse({ permitType: 'wtg_work' }).success, false);
});

test('a client can never choose a form version, a status, or an identity at creation', () => {
  for (const body of [
    { permitType: 'WTG_WORK', formVersion: 'WTG_WORK_V1' },
    { permitType: 'WTG_WORK', status: 'ISSUED' },
    { permitType: 'WTG_WORK', createdBy: 'someone-else' },
    { permitType: 'WTG_WORK', applicantName: 'Impostor' },
    { permitType: 'WTG_WORK', permitNumber: 'CW-1045' },
  ]) {
    assert.equal(createPermitBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test('updatePermitBodySchema carries only version and opaque form payload', () => {
  const withForm = updatePermitBodySchema.safeParse({ version: 3, form: { windFarm: 'Jhimpir' } });
  assert.equal(withForm.success, true);
  if (withForm.success) assert.deepEqual(withForm.data.form, { windFarm: 'Jhimpir' });

  // Omitting `form` entirely leaves the stored form untouched, so the
  // key must be genuinely absent rather than present-and-undefined.
  const withoutForm = updatePermitBodySchema.safeParse({ version: 3 });
  assert.equal(withoutForm.success, true);
  if (withoutForm.success) assert.equal('form' in withoutForm.data, false);

  assert.equal(updatePermitBodySchema.safeParse({ version: 1, company: 'OTHER' }).success, false);
  assert.equal(updatePermitBodySchema.safeParse({ version: 1, company: 'ESET', companyOther: 'x' }).success, false);
  assert.equal(updatePermitBodySchema.safeParse({ version: 0, form: {} }).success, false);
  assert.equal(updatePermitBodySchema.safeParse({ form: {} }).success, false);
});

test('no edit body may smuggle a signer identity, a permit type change, or a raw column write', () => {
  for (const body of [
    { version: 1, applicantSignature: 'Impostor' },
    { version: 1, croName: 'Impostor' },
    { version: 1, hseApprovedBy: 'Impostor' },
    { version: 1, permitType: 'HOT_WORK' },
    { version: 1, form_payload: {} },
    { version: 1, wind_farm: 'Jhimpir' },
    { version: 1, status: 'ISSUED' },
    { version: 1, issued_at: '2026-01-01T00:00:00.000Z' },
  ]) {
    assert.equal(updatePermitBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test('updateJsaBodySchema requires the permit version and a form, and rejects anything else', () => {
  assert.equal(updateJsaBodySchema.safeParse({ version: 2, form: { page1: {}, page2: {} } }).success, true);
  assert.equal(updateJsaBodySchema.safeParse({ version: 2 }).success, false);
  assert.equal(updateJsaBodySchema.safeParse({ form: {} }).success, false);
  assert.equal(updateJsaBodySchema.safeParse({ version: 2, form: {}, completedBy: 'Impostor' }).success, false);
  assert.equal(updateJsaBodySchema.safeParse({ version: 2, form: {}, jsaNumber: '234' }).success, false);
});

test('permit search accepts the new permit-type filter and still rejects unknown query keys', () => {
  const parsed = permitSearchQuerySchema.safeParse({ permitType: 'CONFINED_SPACE_ENTRY' });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.permitType, 'CONFINED_SPACE_ENTRY');

  assert.equal(permitSearchQuerySchema.safeParse({ permitType: 'ELECTRICAL_WORK' }).success, false);
  assert.equal(permitSearchQuerySchema.safeParse({ windFarm: 'Jhimpir' }).success, false);
  assert.equal(permitSearchQuerySchema.safeParse({ formPayload: '{}' }).success, false);
  // Existing bounds are untouched.
  assert.equal(permitSearchQuerySchema.safeParse({ pageSize: '1000' }).success, false);
});
