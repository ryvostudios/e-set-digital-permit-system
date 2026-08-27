import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIssuedDocumentPages, buildSignatureBlock, type DocumentPage } from './documentLayout.js';
import { buildIssuedPermitSnapshot, type IssuedPermitSnapshot } from './documents.js';
import {
  makeColdWorkForm,
  makeConfinedSpaceEntryForm,
  makeHotWorkForm,
  makeJsaForm,
  makeJsaFormColumns,
  makePermitFormColumns,
  makeSignature,
  makeSignatureSet,
  makeWtgWorkForm,
} from './formFixtures.test.js';
import type { JsaRow, PermitRow } from './service.js';
import type { PermitForm, PermitType } from './forms.js';
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

function makeJsa(): JsaRow {
  return {
    id: 'jsa-1',
    jsa_sequence: '234',
    created_by: 'applicant-1',
    ...makeJsaFormColumns(),
    created_at: '2026-01-01T07:00:00.000Z',
    updated_at: '2026-01-01T08:00:00.000Z',
  };
}

function makeSnapshot(
  permitType: PermitType = 'WTG_WORK',
  form: PermitForm = makeWtgWorkForm(),
  signatures: SnapshotSignatureSet = makeSignatureSet(),
): IssuedPermitSnapshot {
  const versions = {
    WTG_WORK: 'WTG_WORK_V1',
    COLD_WORK: 'COLD_WORK_V1',
    HOT_WORK: 'HOT_WORK_V1',
    CONFINED_SPACE_ENTRY: 'CONFINED_SPACE_ENTRY_V1',
  } as const;
  return buildIssuedPermitSnapshot(
    makePermit({ permit_type: permitType, form_version: versions[permitType], form_payload: form }),
    makeJsa(),
    null,
    {
      id: 'event-1',
      event_type: 'HSE_APPROVED',
      actor_user_id: 'hse-1',
      occurred_at: '2026-01-01T09:00:00.000Z',
      snapshot_taken_at: '2026-01-01T09:00:02.000Z',
    },
    signatures,
  );
}

function allText(page: DocumentPage): string {
  return JSON.stringify(page);
}

test('the immutable document order is always Permit page(s), then JSA page 1, then JSA page 2', () => {
  for (const [permitType, form] of [
    ['WTG_WORK', makeWtgWorkForm()],
    ['COLD_WORK', makeColdWorkForm()],
    ['HOT_WORK', makeHotWorkForm()],
    ['CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm()],
  ] as const) {
    const pages = buildIssuedDocumentPages(makeSnapshot(permitType, form));
    assert.equal(pages.length, 3);
    assert.match(pages[0]!.title, /Permit$/);
    assert.equal(pages[1]!.title, 'Job Safety Analysis - Page 1');
    assert.equal(pages[2]!.title, 'Job Safety Analysis - Page 2');
  }
});

test('each permit template renders its own sections, and never another template\'s', () => {
  const wtg = allText(buildIssuedDocumentPages(makeSnapshot('WTG_WORK', makeWtgWorkForm()))[0]!);
  assert.match(wtg, /Wind Farm/);
  assert.match(wtg, /Work at Heights/);
  assert.match(wtg, /Isolation Points/);
  assert.doesNotMatch(wtg, /Fire Watch/);
  assert.doesNotMatch(wtg, /Gas Test/);

  const cold = allText(buildIssuedDocumentPages(makeSnapshot('COLD_WORK', makeColdWorkForm()))[0]!);
  assert.match(cold, /Nature of Work/);
  assert.match(cold, /Equipment Condition/);
  assert.match(cold, /Confined Space Permit/);
  assert.doesNotMatch(cold, /Fire Watch/);
  assert.doesNotMatch(cold, /Work at Heights/);

  const hot = allText(buildIssuedDocumentPages(makeSnapshot('HOT_WORK', makeHotWorkForm()))[0]!);
  assert.match(hot, /Fire Watch/);
  assert.match(hot, /Type of Hazard/);
  assert.match(hot, /Evacuation/);
  assert.doesNotMatch(hot, /Gas Test/);

  const confined = allText(buildIssuedDocumentPages(makeSnapshot('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm()))[0]!);
  assert.match(confined, /Gas Test/);
  assert.match(confined, /Continuous Monitoring/);
  assert.match(confined, /Attendant/);
  assert.doesNotMatch(confined, /Fire Watch/);
});

test('the confined-space gas test renders every repeatable reading row', () => {
  const form = makeConfinedSpaceEntryForm();
  const page = buildIssuedDocumentPages(makeSnapshot('CONFINED_SPACE_ENTRY', form))[0]!;
  const gasSection = page.sections.find((section) => section.title === 'Gas Test');
  assert.ok(gasSection);
  const table = gasSection.blocks.find((block) => block.kind === 'table');
  assert.ok(table && table.kind === 'table');
  assert.deepEqual(table.columns, ['Time', 'O2 %', 'Result', 'Tested By', 'Remarks']);
  assert.equal(table.rows.length, form.gasTest.readings.length);
  assert.equal(table.rows[0]?.[1], '20.9');
  assert.equal(table.rows[1]?.[3], '-', 'a reading with no tester renders a dash, never an invented name');
});

test('JSA page 2 renders every task-analysis row under the real form column headings', () => {
  const page = buildIssuedDocumentPages(makeSnapshot())[2]!;
  const taskSection = page.sections.find((section) => section.title === 'Task Analysis');
  assert.ok(taskSection);
  const table = taskSection.blocks.find((block) => block.kind === 'table');
  assert.ok(table && table.kind === 'table');
  assert.deepEqual(table.columns, [
    'Sequence of Tasks',
    'Possible Hazardous Events',
    'Energy / Triggering Sources',
    'Protective Actions / Measures',
  ]);
  assert.equal(table.rows.length, makeJsaForm().page2.taskAnalysis.length);
});

test("JSA page 1's completed-by identity comes from the frozen applicant signature, not the form", () => {
  const page = buildIssuedDocumentPages(makeSnapshot())[1]!;
  const details = page.sections.find((section) => section.title === 'JSA Details');
  assert.ok(details);
  const fields = details.blocks.find((block) => block.kind === 'fields');
  assert.ok(fields && fields.kind === 'fields');
  const completedBy = fields.rows.find((row) => row.label === 'Completed By');
  const designation = fields.rows.find((row) => row.label === 'Designation');
  assert.equal(completedBy?.value, 'Ayesha Khan');
  assert.equal(designation?.value, 'Technician, Maintenance Team A');
});

test('the digital signature block renders only signatures that were actually made', () => {
  const block = buildSignatureBlock(makeSignatureSet());
  assert.ok(block.kind === 'signatures');
  assert.deepEqual(block.entries.map((entry) => entry.caption), [
    'APPLICANT',
    'CRO AUTHORIZATION',
    'HSE APPROVAL',
  ]);
  assert.equal(block.note, null);
  assert.equal(block.entries[0]?.name, 'Ayesha Khan');
  assert.equal(block.entries[2]?.designation, 'HSE Officer, HSE');
});

test('a fallback-approved permit shows the real CRO as CRO FALLBACK APPROVAL and NO HSE signature', () => {
  const signatures = makeSignatureSet({
    hse: null,
    croFallback: makeSignature({
      role: 'CRO_FALLBACK',
      userId: 'cro-1',
      displayName: 'Bilal Ahmed',
      designation: 'Control Room Operator, Operations',
      teamName: 'Operations',
      positionName: 'Control Room Operator',
      signedAt: '2026-01-01T09:00:00.000Z',
      sourceEventId: 'event-fallback',
    }),
  });
  const block = buildSignatureBlock(signatures);
  assert.ok(block.kind === 'signatures');

  const captions = block.entries.map((entry) => entry.caption);
  assert.deepEqual(captions, ['APPLICANT', 'CRO AUTHORIZATION', 'CRO FALLBACK APPROVAL']);
  assert.ok(!captions.includes('HSE APPROVAL'), 'no HSE signature may be fabricated for a fallback approval');
  assert.equal(block.entries[2]?.name, 'Bilal Ahmed');
  assert.match(String(block.note), /No HSE approval was performed/);

  const rendered = allText(buildIssuedDocumentPages(makeSnapshot('WTG_WORK', makeWtgWorkForm(), signatures))[0]!);
  assert.match(rendered, /CRO FALLBACK APPROVAL/);
  assert.doesNotMatch(rendered, /HSE APPROVAL/);
  assert.doesNotMatch(rendered, /Cara Noor/);
});

test('a renewed permit shows the inherited signatures plus the renewing CRO', () => {
  const signatures = makeSignatureSet({
    renewal: makeSignature({
      role: 'RENEWAL',
      userId: 'cro-2',
      displayName: 'Dania Iqbal',
      designation: 'Control Room Operator, Operations',
      sourceEventId: 'event-renewed',
    }),
  });
  const block = buildSignatureBlock(signatures);
  assert.ok(block.kind === 'signatures');
  assert.deepEqual(block.entries.map((entry) => entry.caption), [
    'APPLICANT',
    'CRO AUTHORIZATION',
    'HSE APPROVAL',
    'RENEWAL AUTHORIZED BY (CRO)',
  ]);
  assert.equal(block.entries[3]?.name, 'Dania Iqbal');
});

test('participant acknowledgements are rendered as form content, separately from the digital signature block', () => {
  const pages = buildIssuedDocumentPages(makeSnapshot());
  const jsaPage2 = pages[2]!;
  const acknowledgements = jsaPage2.sections.find((section) => section.title.startsWith('Participant Acknowledgements'));
  assert.ok(acknowledgements, 'acknowledgements belong on the JSA page, as form content');
  assert.ok(
    !jsaPage2.sections.some((section) => section.blocks.some((block) => block.kind === 'signatures')),
    'the JSA pages carry no digital signature block',
  );
  const permitPage = pages[0]!;
  assert.ok(permitPage.sections.some((section) => section.title === 'Digital Signatures'));
});

test('the document model is a pure function of the snapshot - two builds are deeply identical', () => {
  const snapshot = makeSnapshot();
  assert.deepEqual(buildIssuedDocumentPages(snapshot), buildIssuedDocumentPages(snapshot));
});

test('applicant paper wording uses frozen normal identity and privileged identity is name-only', () => {
  const normal = { ...makeSnapshot(), applicantIdentity: { kind: 'NORMAL' as const, displayName: 'Ali Khan', companyCode: 'ZPL' as const, companyName: 'ZPL' } };
  const privileged = { ...makeSnapshot(), applicantIdentity: { kind: 'PRIVILEGED' as const, displayName: 'Sana Iqbal', companyCode: 'E_SET' as const, companyName: 'E-SET' } };
  assert.match(JSON.stringify(buildIssuedDocumentPages(normal)), /Mr\. Ali Khan of Company ZPL/);
  const rendered = JSON.stringify(buildIssuedDocumentPages(privileged));
  assert.match(rendered, /Sana Iqbal/);
  assert.doesNotMatch(rendered, /Mr\.|of Company|CEO|Site Manager/);
});
