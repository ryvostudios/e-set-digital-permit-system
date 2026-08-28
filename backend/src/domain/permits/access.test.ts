import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canViewPermit, computeAvailableActions, computePermitValidity, computeViewableStatuses, isPermitApplicantAuthorized, STATUS_VIEW_CAPABILITIES } from './access.js';
import type { PermitRow, PermitStatus } from './service.js';

function basePermit(
  overrides: Partial<PermitRow> = {},
): Pick<PermitRow, 'status' | 'created_by' | 'hse_review_deadline_at' | 'issued_at' | 'site_timezone'> {
  return {
    status: 'DRAFT',
    created_by: 'owner',
    hse_review_deadline_at: null,
    issued_at: null,
    site_timezone: 'UTC',
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
  // HSE's read runs FORWARD from their own queue, never backward into
  // the states before it: a permit being drafted, reviewed by CRO, or
  // returned for correction is none of HSE's business and stays unseen.
  for (const status of ['DRAFT', 'PENDING_CRO', 'PENDING_CORRECTION'] as const) {
    assert.equal(
      canViewPermit(basePermit({ status }), 'hse-1', new Set(['permit.hse_review'])),
      false,
      `hse_review must not grant view access to a ${status} permit`,
    );
  }
});

/**
 * THE BUG THIS ENCODES.
 *
 * `permit.hse_review` used to grant PENDING_HSE and nothing else, so the
 * moment an HSE reviewer approved a permit it vanished from under them:
 * the record they had just issued answered 404, and their screen said
 * "That record is not available" about their own approval.
 *
 * Reading is not acting. The states below are reachable only THROUGH
 * PENDING_HSE, so this lets HSE keep reading the same permits they could
 * already read - for longer, not more of them - and grants no action
 * anywhere (asserted separately).
 */
test('canViewPermit lets the HSE approver keep reading a permit after it is issued', () => {
  for (const status of ['ISSUED', 'HELD', 'CANCELLED', 'CLOSED'] as const) {
    assert.equal(
      canViewPermit(basePermit({ status }), 'hse-1', new Set(['permit.hse_review'])),
      true,
      `hse_review must grant view access to a ${status} permit`,
    );
  }
});

test('reading after issuance grants the HSE reviewer no action on it', () => {
  const capabilities = new Set(['permit.hse_review']);
  for (const status of ['ISSUED', 'HELD', 'CANCELLED', 'CLOSED'] as const) {
    assert.deepEqual(
      computeAvailableActions(
        { status, created_by: 'owner', hse_review_deadline_at: null, issued_at: '2026-01-01T09:00:00.000Z', site_timezone: 'UTC' },
        'hse-1',
        capabilities,
        Date.parse('2026-01-01T10:00:00.000Z'),
      ),
      [],
      `${status} must offer the HSE reviewer nothing to do`,
    );
  }
});

test('permit.view_all grants every status, including another applicant\'s draft, while ownership survives revoke', () => {
  for (const status of Object.keys(STATUS_VIEW_CAPABILITIES) as PermitStatus[]) {
    assert.equal(canViewPermit({ status, created_by: 'owner' }, 'viewer', new Set(['permit.view_all'])), true);
  }
  assert.equal(canViewPermit({ status: 'CLOSED', created_by: 'owner' }, 'viewer', new Set()), false);
  assert.equal(canViewPermit({ status: 'CLOSED', created_by: 'viewer' }, 'viewer', new Set()), true);
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

test('computeAvailableActions: hse_approve (and hse_send_back) have no time gate (whether HSE can act post-timeout is unresolved, not restricted)', () => {
  const permit = basePermit({
    status: 'PENDING_HSE',
    hse_review_deadline_at: new Date('2020-01-01T00:00:00.000Z').toISOString(),
  });
  const actions = computeAvailableActions(permit, 'hse-1', new Set(['permit.hse_review']), Date.now());
  assert.deepEqual(actions.sort(), ['hse_approve', 'hse_send_back']);
});

test('computeAvailableActions: close only appears for ISSUED with permit.close', () => {
  assert.deepEqual(
    computeAvailableActions(basePermit({ status: 'ISSUED' }), 'cro-1', new Set(['permit.close']), Date.now()),
    ['close'],
  );
  assert.deepEqual(computeAvailableActions(basePermit({ status: 'CLOSED' }), 'cro-1', new Set(['permit.close']), Date.now()), []);
});

// --- canViewPermit: new statuses (PENDING_CORRECTION, HELD, CANCELLED) ---

test('canViewPermit: PENDING_CORRECTION is visible to permit.send_back holders (the same capability that performs the send-back)', () => {
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CORRECTION' }), 'cro-1', new Set(['permit.send_back'])),
    true,
  );
  assert.equal(
    canViewPermit(basePermit({ status: 'PENDING_CORRECTION' }), 'cro-1', new Set(['permit.hold'])),
    false,
  );
});

test('canViewPermit: HELD is visible to any of resume/cancel/close holders (OR-based)', () => {
  assert.equal(canViewPermit(basePermit({ status: 'HELD' }), 'cro-1', new Set(['permit.resume'])), true);
  assert.equal(canViewPermit(basePermit({ status: 'HELD' }), 'cro-1', new Set(['permit.cancel'])), true);
  assert.equal(canViewPermit(basePermit({ status: 'HELD' }), 'cro-1', new Set(['permit.close'])), true);
  assert.equal(canViewPermit(basePermit({ status: 'HELD' }), 'cro-1', new Set(['permit.hold'])), false);
});

test('canViewPermit: CANCELLED is visible to permit.cancel holders', () => {
  assert.equal(canViewPermit(basePermit({ status: 'CANCELLED' }), 'cro-1', new Set(['permit.cancel'])), true);
  assert.equal(canViewPermit(basePermit({ status: 'CANCELLED' }), 'cro-1', new Set(['permit.close'])), false);
});

// --- computeAvailableActions: new actions ---

function timedPermit(
  overrides: Partial<Pick<PermitRow, 'status' | 'created_by' | 'hse_review_deadline_at' | 'issued_at' | 'site_timezone'>> = {},
) {
  return basePermit(overrides);
}

test('computeAvailableActions: PENDING_CORRECTION - owner sees update/resubmit with the matching capabilities, a non-owner sees neither', () => {
  const permit = timedPermit({ status: 'PENDING_CORRECTION', created_by: 'applicant-1' });
  const ownerActions = computeAvailableActions(
    permit,
    'applicant-1',
    new Set(['permit.create', 'permit.submit']),
    Date.now(),
  );
  assert.deepEqual(ownerActions.sort(), ['resubmit', 'update']);

  const nonOwnerActions = computeAvailableActions(
    permit,
    'someone-else',
    new Set(['permit.create', 'permit.submit']),
    Date.now(),
  );
  assert.deepEqual(nonOwnerActions, []);
});

test('computeAvailableActions: PENDING_CRO exposes both forward_hse and send_back independently, per capability held', () => {
  const permit = timedPermit({ status: 'PENDING_CRO' });
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.forward_hse']), Date.now()), [
    'forward_hse',
  ]);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.send_back']), Date.now()), [
    'send_back',
  ]);
  assert.deepEqual(
    computeAvailableActions(permit, 'cro-1', new Set(['permit.forward_hse', 'permit.send_back']), Date.now()).sort(),
    ['forward_hse', 'send_back'],
  );
});

test('computeAvailableActions: PENDING_HSE exposes hse_send_back alongside hse_approve, gated by the same permit.hse_review capability', () => {
  const permit = timedPermit({ status: 'PENDING_HSE' });
  assert.deepEqual(
    computeAvailableActions(permit, 'hse-1', new Set(['permit.hse_review']), Date.now()).sort(),
    ['hse_approve', 'hse_send_back'],
  );
  assert.deepEqual(computeAvailableActions(permit, 'hse-1', new Set(), Date.now()), []);
});

test('computeAvailableActions: ISSUED exposes hold/cancel/close independently, per capability held', () => {
  const permit = timedPermit({ status: 'ISSUED' });
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.hold']), Date.now()), ['hold']);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.cancel']), Date.now()), ['cancel']);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.close']), Date.now()), ['close']);
  assert.deepEqual(
    computeAvailableActions(permit, 'cro-1', new Set(['permit.hold', 'permit.cancel', 'permit.close']), Date.now()).sort(),
    ['cancel', 'close', 'hold'],
  );
});

test('computeAvailableActions: HELD exposes cancel/close unconditionally, but resume only strictly before the midnight expiry', () => {
  const issuedAt = '2026-03-05T09:00:00.000Z';
  const permit = timedPermit({ status: 'HELD', issued_at: issuedAt, site_timezone: 'UTC' });
  const capabilities = new Set(['permit.resume', 'permit.cancel', 'permit.close']);

  const beforeExpiry = new Date('2026-03-05T23:59:59.000Z').getTime();
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', capabilities, beforeExpiry).sort(), [
    'cancel',
    'close',
    'resume',
  ]);

  const atExpiry = new Date('2026-03-06T00:00:00.000Z').getTime();
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', capabilities, atExpiry).sort(), ['cancel', 'close']);
});

test('computeAvailableActions: HELD never exposes resume without permit.resume, even before expiry', () => {
  const permit = timedPermit({ status: 'HELD', issued_at: '2026-03-05T09:00:00.000Z', site_timezone: 'UTC' });
  const beforeExpiry = new Date('2026-03-05T10:00:00.000Z').getTime();
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.cancel']), beforeExpiry), ['cancel']);
});

test('computeAvailableActions: CLOSED exposes renew only once expired and only with permit.renew', () => {
  const issuedAt = '2026-03-05T09:00:00.000Z';
  const permit = timedPermit({ status: 'CLOSED', issued_at: issuedAt, site_timezone: 'UTC' });

  const beforeExpiry = new Date('2026-03-05T23:59:59.000Z').getTime();
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.renew']), beforeExpiry), []);

  const afterExpiry = new Date('2026-03-06T00:00:01.000Z').getTime();
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(['permit.renew']), afterExpiry), ['renew']);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', new Set(), afterExpiry), []);
});

test('computeAvailableActions: CANCELLED exposes no actions at all, regardless of capabilities held', () => {
  const permit = timedPermit({ status: 'CANCELLED' });
  const allCapabilities = new Set([
    'permit.create',
    'permit.submit',
    'permit.send_back',
    'permit.forward_hse',
    'permit.hse_review',
    'permit.fallback_approve',
    'permit.hold',
    'permit.resume',
    'permit.cancel',
    'permit.close',
    'permit.renew',
  ]);
  assert.deepEqual(computeAvailableActions(permit, 'cro-1', allCapabilities, Date.now()), []);
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
  for (const status of [
    'DRAFT',
    'PENDING_CRO',
    'PENDING_HSE',
    'PENDING_CORRECTION',
    'HELD',
    'CANCELLED',
    'CLOSED',
  ] as const) {
    const permit = issuedPermit({ status });
    const result = computePermitValidity(permit, new Date('2026-03-05T10:00:00.000Z'));
    assert.equal(result?.isValid, false, `expected ${status} to never be valid`);
  }
});

test('computePermitValidity: a HELD permit is NEVER valid, even strictly before what would otherwise be its expiry (the same regression class as CLOSED)', () => {
  const permit = issuedPermit({ status: 'HELD' });
  const wellBeforeWhatWouldHaveBeenExpiry = new Date('2026-03-05T10:00:00.000Z');
  const result = computePermitValidity(permit, wellBeforeWhatWouldHaveBeenExpiry);
  assert.equal(result?.isValid, false);
});

test('computePermitValidity: a CANCELLED permit is NEVER valid, even strictly before what would otherwise be its expiry', () => {
  const permit = issuedPermit({ status: 'CANCELLED' });
  const wellBeforeWhatWouldHaveBeenExpiry = new Date('2026-03-05T10:00:00.000Z');
  const result = computePermitValidity(permit, wellBeforeWhatWouldHaveBeenExpiry);
  assert.equal(result?.isValid, false);
});

// --- computeViewableStatuses (used by domain/permits/search.ts) ---

test('computeViewableStatuses: no capabilities grants no non-owner status visibility, including DRAFT (never queue-able)', () => {
  assert.deepEqual(computeViewableStatuses(new Set()), []);
});

test('computeViewableStatuses: a single relevant capability grants exactly the statuses it appears under in STATUS_VIEW_CAPABILITIES', () => {
  const statuses = computeViewableStatuses(new Set(['permit.resume']));
  assert.deepEqual(statuses.sort(), ['HELD']);
});

test('computeViewableStatuses: holding every CRO/HSE capability grants every non-DRAFT status', () => {
  const statuses = computeViewableStatuses(
    new Set([
      'permit.cro_review',
      'permit.forward_hse',
      'permit.hse_review',
      'permit.fallback_approve',
      'permit.send_back',
      'permit.close',
      'permit.resume',
      'permit.cancel',
    ]),
  );
  assert.deepEqual(
    statuses.sort(),
    ['CANCELLED', 'CLOSED', 'HELD', 'ISSUED', 'PENDING_CORRECTION', 'PENDING_CRO', 'PENDING_HSE'].sort(),
  );
});

test('computeViewableStatuses: an unrelated capability grants no visibility', () => {
  assert.deepEqual(computeViewableStatuses(new Set(['permit.create'])), []);
});

// ---------------------------------------------------------------------
// Privileged applicants (CEO / E-SET SITE_MANAGER)
// ---------------------------------------------------------------------
//
// A privileged system account holds NO capabilities: capabilities come
// from a Team + Position, and a privileged account has neither by design.
// `requirePermitApplicant` has always let them apply anyway, so the PATCH
// succeeded - but `computeAvailableActions` tested the capability alone,
// so the UI never offered the editor and a CEO's own DRAFT opened
// read-only. Both now share `isPermitApplicantAuthorized`.

test('computeAvailableActions: a CEO with NO capabilities may edit and submit their OWN draft', () => {
  const permit = basePermit({ status: 'DRAFT', created_by: 'ceo-1' });
  const actions = computeAvailableActions(permit, 'ceo-1', new Set(), Date.now(), new Set(['CEO']));
  assert.deepEqual(actions.sort(), ['submit', 'update']);
});

test('computeAvailableActions: an E-SET SITE_MANAGER with NO capabilities may edit and submit their OWN draft', () => {
  const permit = basePermit({ status: 'DRAFT', created_by: 'sm-1' });
  const actions = computeAvailableActions(permit, 'sm-1', new Set(), Date.now(), new Set(['SITE_MANAGER']));
  assert.deepEqual(actions.sort(), ['submit', 'update']);
});

test('computeAvailableActions: a privileged applicant may correct their own returned permit', () => {
  const permit = basePermit({ status: 'PENDING_CORRECTION', created_by: 'ceo-1' });
  const actions = computeAvailableActions(permit, 'ceo-1', new Set(), Date.now(), new Set(['CEO']));
  assert.deepEqual(actions.sort(), ['resubmit', 'update']);
});

test('computeAvailableActions: privilege does NOT let a privileged account edit someone else\'s draft', () => {
  // Ownership is the rule for applicant actions; being CEO is not a
  // licence to rewrite another applicant's draft.
  const permit = basePermit({ status: 'DRAFT', created_by: 'someone-else' });
  assert.deepEqual(computeAvailableActions(permit, 'ceo-1', new Set(), Date.now(), new Set(['CEO'])), []);
  assert.deepEqual(computeAvailableActions(permit, 'sm-1', new Set(), Date.now(), new Set(['SITE_MANAGER'])), []);
});

test('computeAvailableActions: an ordinary owner WITHOUT the capability still gets nothing', () => {
  // The fix must not have widened anything for non-privileged callers.
  const permit = basePermit({ status: 'DRAFT', created_by: 'owner' });
  assert.deepEqual(computeAvailableActions(permit, 'owner', new Set(), Date.now()), []);
  assert.deepEqual(computeAvailableActions(permit, 'owner', new Set(), Date.now(), new Set()), []);
});

test('computeAvailableActions: privilege grants NO reviewer or issued-permit authority', () => {
  // Being CEO must not imply CRO/HSE review or hold/cancel/close.
  const roles = new Set(['CEO', 'SITE_MANAGER']);
  for (const status of ['PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'HELD'] as const) {
    const permit = basePermit({ status, created_by: 'ceo-1' });
    assert.deepEqual(
      computeAvailableActions(permit, 'ceo-1', new Set(), Date.now(), roles),
      [],
      `${status} must offer a privileged account no workflow authority`,
    );
  }
});

test('isPermitApplicantAuthorized is the single rule the write path and the hint share', () => {
  const none = new Set<string>();
  assert.equal(isPermitApplicantAuthorized(new Set(['permit.create']), none, 'permit.create'), true);
  assert.equal(isPermitApplicantAuthorized(none, new Set(['CEO']), 'permit.create'), true);
  assert.equal(isPermitApplicantAuthorized(none, new Set(['SITE_MANAGER']), 'permit.submit'), true);
  assert.equal(isPermitApplicantAuthorized(none, none, 'permit.create'), false);
  // A capability for a DIFFERENT action does not authorize this one.
  assert.equal(isPermitApplicantAuthorized(new Set(['permit.submit']), none, 'permit.create'), false);
});
