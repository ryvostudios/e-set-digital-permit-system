import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLD_WORK_CHECKLIST_SECTIONS, COLD_WORK_NATURE_OF_WORK, COLD_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_CHECKLIST_SECTIONS, CONFINED_SPACE_COMBUSTION_SUB_TICKS, CONFINED_SPACE_GAS_TEST_TABLE,
  CONFINED_SPACE_NATURE_OF_WORK, CONFINED_SPACE_TYPE_OF_HAZARD, HOT_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_COMBUSTION_SUB_TICKS, HOT_WORK_NATURE_OF_WORK, HOT_WORK_TYPE_OF_HAZARD,
  JSA_APPROVAL_SIGNATORIES, JSA_EMERGENCY_CONTACTS, JSA_EMERGENCY_QUESTIONS,
  JSA_ENERGY_SOURCE_LEGEND, JSA_HSE_CHECKLIST_CATEGORIES, JSA_PPE_REQUIRED, JSA_REQUIRED_PERMITS,
  JSA_TASK_ANALYSIS_COLUMNS, WTG_ISOLATION_POINTS, WTG_PPE_REQUIRED, WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection, type SelectionSection,
} from './catalogue.js';
import { buildIssuedDocumentPages } from './documentLayout.js';
import { generateIssuedPermitPdf, type IssuedPermitSnapshot } from './documents.js';
import { JSA_FORM_VERSION_V2, PERMIT_FORM_VERSIONS_V2, parseJsaFormV2, parsePermitFormV2, type PermitFormV2 } from './formsV2.js';
import type { PermitType } from './forms.js';
import { makeSignatureSet } from './formFixtures.test.js';

const answers = (section: ChecklistSection) => Object.fromEntries(section.items.map((item) => [item.id, { response: section.responses === 'YES_NO_NA' ? 'NA' : 'NO' }]));
const sections = (items: readonly ChecklistSection[]) => Object.fromEntries(items.map((section) => [section.id, answers(section)]));
const ticks = (section: SelectionSection) => Object.fromEntries(section.options.map((option) => [option.id, option.id === section.options[0]?.id]));
const workWindow = { equipment: 'WTG-12', area: 'Nacelle', fromHours: '0800', toHours: '1600' };
const evacuation = { completedRemarks: 'Area clear', acknowledgedAtHours: '1610' };

function permitForm(type: PermitType): PermitFormV2 {
  const raw = type === 'WTG_WORK' ? {
    permitIssue: { windFarmName: 'Zephyr Wind Farm', wtgNumber: 'WTG-12', descriptionOfWork: 'Authoritative maintenance task', permitStartAt: '2026-01-01T08:00:00.000Z', permitExpiryAt: '2026-01-01T16:00:00.000Z' },
    sections: sections(WTG_WORK_CHECKLIST_SECTIONS), isolationPoints: answers(WTG_ISOLATION_POINTS), ppe: ticks(WTG_PPE_REQUIRED),
  } : type === 'COLD_WORK' ? {
    workWindow, natureOfWork: ticks(COLD_WORK_NATURE_OF_WORK), typeOfHazard: ticks(COLD_WORK_TYPE_OF_HAZARD), sections: sections(COLD_WORK_CHECKLIST_SECTIONS), evacuation,
  } : type === 'HOT_WORK' ? {
    workWindow, natureOfWork: ticks(HOT_WORK_NATURE_OF_WORK), typeOfHazard: ticks(HOT_WORK_TYPE_OF_HAZARD), combustionSubTicks: Object.fromEntries(HOT_WORK_COMBUSTION_SUB_TICKS.map((item) => [item.id, false])), sections: sections(HOT_WORK_CHECKLIST_SECTIONS), fireWatch: 'Fatima / Fire Watch', evacuation,
  } : {
    workWindow, natureOfWork: ticks(CONFINED_SPACE_NATURE_OF_WORK), typeOfHazard: ticks(CONFINED_SPACE_TYPE_OF_HAZARD), combustionSubTicks: Object.fromEntries(CONFINED_SPACE_COMBUSTION_SUB_TICKS.map((item) => [item.id, false])), sections: sections(CONFINED_SPACE_CHECKLIST_SECTIONS), gasTestRecord: Object.fromEntries(CONFINED_SPACE_GAS_TEST_TABLE.rows.map((row) => [row, { oxygenAndTime: '20.9% / 0800', testedBy: 'Gas tester' }])), attendant: 'Attendant One', evacuation,
  };
  const parsed = parsePermitFormV2(type, raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture rejected');
  return parsed.data;
}

function jsaForm() {
  const raw = {
    page1: { siteOrWtg: 'WTG-12', dateTime: '2026-01-01T08:00:00.000Z', serialNo: '01', jobOrWork: 'Authoritative maintenance task', anyPermitsRequired: 'YES', requiredPermits: { ...ticks(JSA_REQUIRED_PERMITS), other: 'Special permit' }, hseChecklist: Object.fromEntries(JSA_HSE_CHECKLIST_CATEGORIES.map((category) => [category.id, ticks(category)])) },
    page2: {
      emergencyContacts: Object.fromEntries(JSA_EMERGENCY_CONTACTS.map((item) => [item.id, '0300-0000000'])), emergencyQuestions: Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((item) => [item.id, 'YES'])),
      taskAnalysis: [{ sequenceOfTasks: 'Isolate equipment', possibleHazardousEvents: 'Stored energy', energySources: ['M', 'E', 'C', 'P', 'G', 'H', 'R', 'B'], triggeringEventsToStopWork: 'Unexpected movement', protectiveActionsOrMeasures: 'Apply LOTO and verify' }],
      ppe: ticks(JSA_PPE_REQUIRED), toolsAndMaterials: 'Approved insulated tools', participants: [{ nameAndPosition: 'Worker / Technician', company: 'E-SET', acknowledged: true }], approvals: Object.fromEntries(JSA_APPROVAL_SIGNATORIES.map((item) => [item.id, { nameAndPosition: 'Frozen approver', contactNumber: '0300-1111111', closedOut: false }])), comments: 'Controlled local PDF fixture',
    },
  };
  const parsed = parseJsaFormV2(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture rejected');
  return parsed.data;
}

export function makeV2PdfTestSnapshot(type: PermitType): IssuedPermitSnapshot {
  return {
    snapshotVersion: 'ISSUED_PERMIT_SNAPSHOT_V2', permitId: `permit-${type}`, permitNumber: '1045', jsaId: 'jsa-234', jsaNumber: '234', status: 'ISSUED', company: 'UNTRUSTED CLIENT COMPANY', companyOther: null,
    applicantIdentity: { kind: 'NORMAL', displayName: 'Frozen Applicant', companyCode: 'E_SET', companyName: 'Frozen E-SET Company' }, createdBy: 'applicant-uuid', submittedAt: '2026-01-01T08:00:00.000Z', issuedAt: '2026-01-01T09:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z', siteTimezone: 'UTC', previousPermitId: null, previousPermitNumber: null, jsaCreatedBy: 'applicant-uuid', jsaCreatedAt: '2026-01-01T07:00:00.000Z', issuanceEventId: 'event-1', issuanceEventType: 'HSE_APPROVED', issuanceActorUserId: 'hse-uuid', issuanceOccurredAt: '2026-01-01T09:00:00.000Z', snapshotTakenAt: '2026-01-01T09:00:01.000Z',
    permitType: type, permitFormVersion: PERMIT_FORM_VERSIONS_V2[type], permitForm: permitForm(type), jsaFormVersion: JSA_FORM_VERSION_V2, jsaForm: jsaForm(), signatures: makeSignatureSet({ applicant: { ...makeSignatureSet().applicant!, displayName: 'Frozen Applicant' } }),
  };
}

const text = (value: unknown) => JSON.stringify(value);

test('all four stored V2 permit versions dispatch to authoritative catalogue layouts while V1 remains separately renderable', async () => {
  for (const type of ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const) {
    const model = buildIssuedDocumentPages(makeV2PdfTestSnapshot(type));
    assert.equal(model.length, 3);
    assert.match(model[0]!.title, /^AUTHORITATIVE /);
    assert.match(model[1]!.title, /PAGE 1 OF 2/);
    assert.match(model[2]!.title, /PAGE 2 OF 2/);
    assert.equal((await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type))).subarray(0, 5).toString(), '%PDF-');
  }
});

test('V2 permit catalogue details reach the PDF model without an independent wording copy', () => {
  const wtg = text(buildIssuedDocumentPages(makeV2PdfTestSnapshot('WTG_WORK'))[0]);
  assert.match(wtg, new RegExp(WTG_WORK_CHECKLIST_SECTIONS[0]!.items.find((item) => item.id === 'g')!.label.replace(/[?]/g, '\\?')));
  assert.match(text(buildIssuedDocumentPages(makeV2PdfTestSnapshot('COLD_WORK'))[0]), /INSPECTION/);
  const hot = text(buildIssuedDocumentPages(makeV2PdfTestSnapshot('HOT_WORK'))[0]);
  assert.equal(HOT_WORK_NATURE_OF_WORK.options.length, 4);
  assert.match(hot, /METAL THICKNESS FOR WELDING/);
  const confined = text(buildIssuedDocumentPages(makeV2PdfTestSnapshot('CONFINED_SPACE_ENTRY'))[0]);
  assert.match(confined, /02 \(19\.5-23\.5%\) & TIME/);
  assert.match(confined, /CONTINOUS MONITORING/);
});

test('JSA preserves the two logical pages, complete fixed checklist, five columns, and energy legend', () => {
  const pages = buildIssuedDocumentPages(makeV2PdfTestSnapshot('WTG_WORK'));
  const page1 = text(pages[1]);
  const page2 = text(pages[2]);
  assert.equal(JSA_REQUIRED_PERMITS.options.length, 8);
  assert.match(page1, /Special permit/);
  assert.equal(JSA_HSE_CHECKLIST_CATEGORIES.length, 16);
  assert.equal(JSA_HSE_CHECKLIST_CATEGORIES.reduce((sum, category) => sum + category.options.length, 0), 115);
  assert.equal(JSA_TASK_ANALYSIS_COLUMNS.length, 5);
  for (const column of JSA_TASK_ANALYSIS_COLUMNS) assert.match(page2, new RegExp(column.label.replace(/[/?]/g, '\\$&')));
  assert.equal(page2.includes(JSA_ENERGY_SOURCE_LEGEND.map((item) => `${item.code} = ${item.label}`).join('  |  ')), true);
});

test('identity and digital authorization render only frozen snapshot values', () => {
  const rendered = text(buildIssuedDocumentPages(makeV2PdfTestSnapshot('WTG_WORK')));
  assert.match(rendered, /Frozen Applicant/);
  assert.match(rendered, /Frozen E-SET Company/);
  assert.match(rendered, /digitally recorded/);
  assert.doesNotMatch(rendered, /UNTRUSTED CLIENT COMPANY/);
});

test('mixed V1/V2 stored versions fail closed instead of guessing a renderer', () => {
  assert.throws(() => buildIssuedDocumentPages({ ...makeV2PdfTestSnapshot('WTG_WORK'), jsaFormVersion: 'JSA_V1' }), /incompatible V2/);
});
