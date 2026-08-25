import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canViewPermit, computeAvailableActions, computePermitValidity } from './access.js';
import type { PermitRow } from './service.js';

function basePermit(overrides: Partial<PermitRow> = {}): Pick<PermitRow, 'status' | 'created_by' | 'hse_review_deadline_at'> {
  return {
    status: 'DRAFT',
    created_by: 'owner',
    hse_review_deadline_at: null,
    ...overrides,
  };
}

test('canViewPermit always allows the creator, regardless of status or capabilities', () => {
  for (const status of ['DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'CLOSED'] as const) {
    const permit = basePermit({ status });
    assert.equal(canViewPermit(permit, 'owner', new Set()), true);
  }
});

test('canViewPermit never allows a non-creator to view a DRAFT (no queue capability exists for it)', () => {
  const permit = basePermit({ status: 'DRAFT' });
  const anyCapabilities = new Set([
    'permit.forward_hse',
    'permit.hse_review',
    'permit.fallback_approve',
    'permit.close',
  ]);
  assert.equal(canViewPermit(permit, 'someone-else', anyCapabilities), false);
});

test('canViewPermit allows a non-creator holding the status-appropriate capability', () => {
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CRO' }), 'cro-1', new Set(['permit.forward_hse'])),
    true,
  );
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_HSE' }), 'hse-1', new Set(['permit.hse_review'])),
    true,
  );
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_HSE' }), 'cro-1', new Set(['permit.fallback_approve'])),
    true,
  );
  assert.equal(canViewPermit(basePermit({ status: 'ISSUED' }), 'cro-1', new Set(['permit.close'])), true);
  assert.equal(canViewPermit(basePermit({ status: 'CLOSED' }), 'cro-1', new Set(['permit.close'])), true);
});

test('canViewPermit denies a non-creator holding an unrelated capability (no cross-status leakage - IDOR/BOLA guard)', () => {
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_HSE' }), 'cro-1', new Set(['permit.forward_hse'])),
    false,
    'forward_hse should not grant view access to a PENDING_HSE permit',
  );
  assert.equal(
    canViewPermit(basePermit({ status: 'ISSUED' }), 'hse-1', new Set(['permit.hse_review'])),
    false,
    'hse_review should not grant view access to an ISSUED permit',
  );
});

test('canViewPermit: permit.cro_review alone grants PENDING_CRO visibility (independent of permit.forward_hse)', () => {
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CRO' }), 'cro-1', new Set(['permit.cro_review'])),
    true,
  );
});

test('canViewPermit: permit.forward_hse alone still grants PENDING_CRO visibility (the transition actor)', () => {
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CRO' }), 'cro-1', new Set(['permit.forward_hse'])),
    true,
  );
});

test('canViewPermit: PENDING_CRO visibility is OR-based, not a requirement to hold both cro_review and forward_hse', () => {
  // Holding only one of the two is already proven sufficient above; this
  // confirms holding *neither* denies visibility, i.e. it's a genuine
  // OR over the two, not an accidental AND enforced elsewhere.
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CRO' }), 'cro-1', new Set(['permit.hse_review', 'permit.close'])),
    false,
  );
});

test('computeAvailableActions: creator sees update/submit on their own DRAFT when they hold both capabilities', () => {
  const permit = basePermit({ status: 'DRAFT', created_by: 'owner' });
  const actions = computeAvailableActions(permit, 'owner', new Set(['permit.create', 'permit.submit']), Date.now());
  assert.deepEqual(actions.sort(), ['submit', 'update']);
});

test('computeAvailableActions: a non-creator never sees DRAFT actions, even holding those capabilities', () => {
  const permit = basePermit({ status: 'DRAFT', created_by: 'owner' });
  const actions = computeAvailableActions(permit, 'someone-else', new Set(['permit.create', 'permit.submit']), Date.now());
  assert.deepEqual(actions, []);
});

test('computeAvailableActions: forward_hse only appears for PENDING_CRO with the matching capability', () => {
  const permit = basePermit({ status: 'PENDING_CRO' });
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.forward_hse']), Date.now()), [
    'forward_hse',
  ]);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(), Date.now()), []);
});

test('computeAvailableActions: fallback_approve only appears once the DB-recorded deadline has passed', () => {
  const deadline = new Date('2026-01-01T00:05:00.000Z').toISOString();
  const permit = basePermit({ status: 'PENDING_HSE', hse_review_deadline_at: deadline });
  const capabilities = new Set(['permit.fallback_approve']);

  const before = computeAvailableActions(permit, 'cro-1', capabilities, new Date('2026-01-01T00:04:59.000Z').getTime());
  const atDeadline = computeAvailableActions(permit, 'cro-1', capabilities, new Date(deadline).getTime());
  const after = computeAvailableActions(permit, 'cro-1', capabilities, new Date('2026-01-01T00:10:00.000Z').getTime());

  assert.deepEqual(before, []);
  assert.deepEqual(atDeadline, ['fallback_approve']);
  assert.deepEqual(after, ['fallback_approve']);
});

test('computeAvailableActions: hse_approve has no time gate (whether HSE can act post-timeout is unresolved, not restricted)', () => {
  const permit = basePermit({
    status: 'PENDING_HSE',
    hse_review_deadline_at: new Date('2020-01-01T00:00:00.000Z').toISOString(),
  });
  const actions = computeAvailableActions(permit, 'hse-1', new Set(['permit.hse_review']), Date.now());
  assert.deepEqual(actions, ['hse_approve']);
});

test('computeAvailableActions: close only appears for ISSUED with permit.close', () => {
  assert.deepEqual(
    computeAvailableActions(basePermit({ status: 'ISSUED' }), 'cro-1', new Set(['permit.close']), Date.now()),
    ['close'],
  );
  assert.deepEqual(computeAvailableActions(basePermit({ status: 'CLOSED' }), 'cro-1', new Set(['permit.close']), Date.now()), []);
});

// --- computePermitValidity ---

function issuedPermit(overrides: Partial<Pick<PermitRow, 'status' | 'issued_at' | 'site_timezone'>> = {}) {
  return {
    status: 'ISSUED' as const,
    issued_at: '2026-03-05T09:00:00.000Z',
    site_timezone: 'UTC',
    ...overrides,
  };
}

test('computePermitValidity: returns null before issuance (issued_at not set - nothing to compute)', () => {
  const permit = { status: 'PENDING_HSE' as const, issued_at: null, site_timezone: 'UTC' };
  assert.equal(computePermitValidity(permit, new Date()), null);
});

test('computePermitValidity: an ISSUED permit is valid before its next-midnight expiry', () => {
  const permit = issuedPermit();
  const beforeExpiry = new Date('2026-03-05T23:59:59.000Z');

  const result = computePermitValidity(permit, beforeExpiry);

  assert.equal(result?.isValid, true);
  assert.equal(result?.expiresAt, '2026-03-06T00:00:00.000Z');
});

test('computePermitValidity: an ISSUED permit is no longer valid at/after its next-midnight expiry', () => {
  const permit = issuedPermit();
  const atExpiry = new Date('2026-03-06T00:00:00.000Z');

  const result = computePermitValidity(permit, atExpiry);

  assert.equal(result?.isValid, false);
});

test('computePermitValidity: a CLOSED permit is NEVER valid, even strictly before what would otherwise be its expiry (the exact regression this guards against)', () => {
  const permit = issuedPermit({ status: 'CLOSED' });
  const wellBeforeWhatWouldHaveBeenExpiry = new Date('2026-03-05T10:00:00.000Z'); // same day as issuance, hours before midnight

  const result = computePermitValidity(permit, wellBeforeWhatWouldHaveBeenExpiry);

  assert.equal(result?.isValid, false);
});

test('computePermitValidity: expiresAt is unchanged by status - CLOSED reports the same expiry an ISSUED permit with identical issued_at/timezone would', () => {
  const issued = issuedPermit({ status: 'ISSUED' });
  const closed = issuedPermit({ status: 'CLOSED' });
  const now = new Date('2026-03-05T10:00:00.000Z');

  const issuedResult = computePermitValidity(issued, now);
  const closedResult = computePermitValidity(closed, now);

  assert.equal(issuedResult?.expiresAt, closedResult?.expiresAt);
  assert.equal(issuedResult?.isValid, true);
  assert.equal(closedResult?.isValid, false);
});

test('computePermitValidity: no status other than ISSUED can ever be reported valid', () => {
  for (const status of ['DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'CLOSED'] as const) {
    const permit = issuedPermit({ status });
    const result = computePermitValidity(permit, new Date('2026-03-05T10:00:00.000Z'));
    assert.equal(result?.isValid, false, `expected ${status} to never be valid`);
  }
});
