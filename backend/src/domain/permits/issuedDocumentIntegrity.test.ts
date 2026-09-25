import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIssuedPermitSnapshot,
  computeFileHash,
  computeSnapshotHash,
  CURRENT_RENDERER_VERSION,
  generateIssuedPermitPdf,
  hasValidSnapshotHash,
  stableStringify,
  type IssuanceEventMetadata,
  type IssuedPermitSnapshot,
} from './documents.js';
import {
  makeConfinedSpaceEntryForm,
  makeJsaFormColumns,
  makePermitFormColumns,
  makeSignature,
  makeSignatureSet,
} from './formFixtures.test.js';
import type { JsaRow, PermitRow } from './service.js';
import type { SnapshotSignatureSet } from './signatures.js';

function makePermit(overrides: Partial<PermitRow> = {}): PermitRow {
  return {
    id: 'permit-1',
    permit_sequence: '1045',
    jsa_id: 'jsa-1',
    status: 'ISSUED',
    version: 2,
    created_by: 'applicant-1',
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: '2026-01-01T08:00:00.000Z',
    hse_review_started_at: '2026-01-01T08:30:00.000Z',
    hse_review_deadline_at: '2026-01-01T08:35:00.000Z',
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    ...makePermitFormColumns(),
    created_at: '2026-01-01T07:00:00.000Z',
    updated_at: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeJsa(overrides: Partial<JsaRow> = {}): JsaRow {
  return {
    id: 'jsa-1',
    jsa_sequence: '234',
    created_by: 'applicant-1',
    ...makeJsaFormColumns(),
    created_at: '2026-01-01T07:00:00.000Z',
    updated_at: '2026-01-01T08:00:00.000Z',
    ...overrides,
  };
}

const ISSUANCE_EVENT: IssuanceEventMetadata = {
  id: 'event-1',
  event_type: 'HSE_APPROVED',
  actor_user_id: 'hse-1',
  occurred_at: '2026-01-01T09:00:00.000Z',
  snapshot_taken_at: '2026-01-01T09:00:02.000Z',
};

function build(
  permit = makePermit(),
  jsa = makeJsa(),
  signatures: SnapshotSignatureSet = makeSignatureSet(),
): IssuedPermitSnapshot {
  return buildIssuedPermitSnapshot(permit, jsa, null, ISSUANCE_EVENT, signatures);
}

test('the issued snapshot freezes the permit template, both form payloads, and every signature', () => {
  const snapshot = build();
  assert.equal(snapshot.snapshotVersion, 'ISSUED_PERMIT_SNAPSHOT_V2');
  assert.equal(snapshot.permitType, 'WTG_WORK');
  assert.equal(snapshot.permitFormVersion, 'WTG_WORK_V1');
  assert.equal(snapshot.jsaFormVersion, 'JSA_V1');
  assert.deepEqual(snapshot.permitForm, makePermitFormColumns().form_payload);
  assert.deepEqual(snapshot.jsaForm, makeJsaFormColumns().form_payload);
  assert.equal(snapshot.signatures.applicant?.displayName, 'Ayesha Khan');
  assert.equal(snapshot.signatures.cro?.displayName, 'Bilal Ahmed');
  assert.equal(snapshot.signatures.hse?.displayName, 'Cara Noor');
  assert.equal(snapshot.signatures.croFallback, null);
});

test('a permit or JSA with no completed form can never be snapshotted', () => {
  assert.throws(() => build(makePermit({ form_payload: null })), /completed, validated form/);
  assert.throws(() => build(makePermit({ permit_type: null, form_version: null, form_payload: null })), /completed, validated form/);
  assert.throws(() => build(makePermit(), makeJsa({ form_payload: null })), /JSA with a completed/);
});

test('a snapshot without a recorded applicant signature is refused, never filled in with a placeholder', () => {
  assert.throws(
    () => build(makePermit(), makeJsa(), makeSignatureSet({ applicant: null })),
    /applicant signature/,
  );
});

test('a fallback-approved snapshot carries the real CRO and no HSE signature at all', () => {
  const snapshot = buildIssuedPermitSnapshot(
    makePermit(),
    makeJsa(),
    null,
    { ...ISSUANCE_EVENT, event_type: 'CRO_FALLBACK_APPROVED', actor_user_id: 'cro-1' },
    makeSignatureSet({
      hse: null,
      croFallback: makeSignature({ role: 'CRO_FALLBACK', userId: 'cro-1', displayName: 'Bilal Ahmed', sourceEventId: 'event-1' }),
    }),
  );
  assert.equal(snapshot.issuanceEventType, 'CRO_FALLBACK_APPROVED');
  assert.equal(snapshot.signatures.hse, null);
  assert.equal(snapshot.signatures.croFallback?.displayName, 'Bilal Ahmed');
  assert.doesNotMatch(stableStringify(snapshot.signatures), /"role":"HSE"/);
});

test('a later profile/position change cannot alter an already-taken snapshot or its hash', () => {
  const snapshot = build();
  const originalHash = computeSnapshotHash(snapshot);

  // Simulate the employee being renamed and re-designated afterwards:
  // the snapshot is a frozen copy, so re-hashing it yields the same
  // fingerprint and the stored identity is untouched.
  const laterProfile = { displayName: 'A. Khan', positionName: 'Senior Technician', teamName: 'Maintenance Team B' };
  assert.notEqual(snapshot.signatures.applicant?.displayName, laterProfile.displayName);
  assert.equal(computeSnapshotHash(snapshot), originalHash);

  // And a snapshot rebuilt with the changed identity is a DIFFERENT
  // document with a different hash - proving the frozen copy is what
  // makes history stable, not luck.
  const rebuilt = build(
    makePermit(),
    makeJsa(),
    makeSignatureSet({
      applicant: makeSignature({ displayName: laterProfile.displayName, positionName: laterProfile.positionName, teamName: laterProfile.teamName, designation: `${laterProfile.positionName}, ${laterProfile.teamName}` }),
    }),
  );
  assert.notEqual(computeSnapshotHash(rebuilt), originalHash);
});

test('the snapshot hash covers the form payloads and the signature block', () => {
  const baseline = computeSnapshotHash(build());

  const differentForm = build(
    makePermit({
      permit_type: 'CONFINED_SPACE_ENTRY',
      form_version: 'CONFINED_SPACE_ENTRY_V1',
      form_payload: makeConfinedSpaceEntryForm(),
    }),
  );
  assert.notEqual(computeSnapshotHash(differentForm), baseline);

  const differentSigner = build(
    makePermit(),
    makeJsa(),
    makeSignatureSet({ hse: makeSignature({ role: 'HSE', displayName: 'Someone Else' }) }),
  );
  assert.notEqual(computeSnapshotHash(differentSigner), baseline);
});

test('the migration-0015 hash contract still verifies a V2 snapshot after a JSONB round trip', () => {
  const snapshot = build();
  const hash = computeSnapshotHash(snapshot);
  // JSON.parse(JSON.stringify(...)) is exactly what a JSONB round trip
  // does to this document (canonical timestamps, one-decimal numbers).
  const roundTripped = JSON.parse(JSON.stringify(snapshot)) as IssuedPermitSnapshot;
  assert.equal(hasValidSnapshotHash(roundTripped, hash, 'SORTED_JSON_SHA256_V1'), true);
  assert.equal(hasValidSnapshotHash(roundTripped, hash, 'PG_JSONB_SHA256_V1'), false);
  assert.equal(hasValidSnapshotHash(roundTripped, hash, 'SOMETHING_ELSE'), false);
});

test('a confined-space snapshot with decimal gas readings survives the round trip byte-stably', () => {
  const snapshot = build(
    makePermit({
      permit_type: 'CONFINED_SPACE_ENTRY',
      form_version: 'CONFINED_SPACE_ENTRY_V1',
      form_payload: makeConfinedSpaceEntryForm(),
    }),
  );
  const hash = computeSnapshotHash(snapshot);
  const roundTripped = JSON.parse(JSON.stringify(snapshot)) as IssuedPermitSnapshot;
  assert.equal(hasValidSnapshotHash(roundTripped, hash, 'SORTED_JSON_SHA256_V1'), true);
});

test('the same snapshot renders a byte-identical PDF, every time', async () => {
  const snapshot = build();
  const first = await generateIssuedPermitPdf(snapshot);
  const second = await generateIssuedPermitPdf(snapshot);
  assert.deepEqual(first, second);
  assert.equal(computeFileHash(first), computeFileHash(second));
});

test('the rendered PDF is a real multi-page document carrying Permit, JSA, and signature content', async () => {
  const pdf = await generateIssuedPermitPdf(build());
  assert.equal(pdf.subarray(0, 5).toString('utf8'), '%PDF-');
  // Permit page, JSA page 1, JSA page 2.
  const pageCount = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
  assert.ok(pageCount >= 3, `expected at least 3 pages, got ${pageCount}`);
  // A NEW job pins to the current renderer. Existing jobs keep the
  // identity they already established - see documentRendererV3.test.ts.
  assert.equal(CURRENT_RENDERER_VERSION, 'PDFKIT_V4');
});

test('an application-clock skew cannot change the rendered bytes (the document dates come from the snapshot)', async () => {
  const snapshot = build();
  const expected = await generateIssuedPermitPdf(snapshot);
  const originalNow = Date.now;
  Date.now = () => new Date('2099-12-31T23:59:59.999Z').getTime();
  try {
    const skewed = await generateIssuedPermitPdf(snapshot);
    assert.deepEqual(skewed, expected);
  } finally {
    Date.now = originalNow;
  }
});

test('two snapshots differing only in signer identity render different PDFs (signatures really are rendered)', async () => {
  const original = await generateIssuedPermitPdf(build());
  const renamed = await generateIssuedPermitPdf(
    build(makePermit(), makeJsa(), makeSignatureSet({ applicant: makeSignature({ displayName: 'Someone Else' }) })),
  );
  assert.notDeepEqual(original, renamed);
});
