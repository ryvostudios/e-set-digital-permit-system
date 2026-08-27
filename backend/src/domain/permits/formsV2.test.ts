import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLD_WORK_CHECKLIST_SECTIONS,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  CONFINED_SPACE_COMBUSTION_SUB_TICKS,
  CONFINED_SPACE_GAS_TEST_TABLE,
  CONFINED_SPACE_NATURE_OF_WORK,
  CONFINED_SPACE_TYPE_OF_HAZARD,
  HOT_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_COMBUSTION_SUB_TICKS,
  HOT_WORK_NATURE_OF_WORK,
  HOT_WORK_TYPE_OF_HAZARD,
  JSA_APPROVAL_SIGNATORIES,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';
import { parsePermitForm, parseJsaForm } from './forms.js';
import {
  JSA_FORM_VERSION_V2,
  PERMIT_FORM_VERSIONS_V2,
  parseJsaFormV2,
  parsePermitFormV2,
} from './formsV2.js';

/**
 * The FIXED contract.
 *
 * V1 let the browser send `{ label, response }` rows, so a client decided
 * what safety question it was answering. These tests pin the property that
 * replaces that: answers are keyed by server-defined catalogue ids, the
 * wording never travels in the payload, every printed item is required,
 * and anything else is rejected.
 */

// ---------------------------------------------------------------------
// Builders - a VALID payload, derived from the catalogue itself
// ---------------------------------------------------------------------

function answers(section: ChecklistSection): Record<string, { response: string }> {
  const response = section.responses === 'YES_NO_NA' ? 'NA' : 'NO';
  return Object.fromEntries(section.items.map((item) => [item.id, { response }]));
}

function sectionAnswers(sections: readonly ChecklistSection[]): Record<string, unknown> {
  return Object.fromEntries(sections.map((section) => [section.id, answers(section)]));
}

function ticks(section: SelectionSection, value = false): Record<string, boolean> {
  return Object.fromEntries(section.options.map((option) => [option.id, value]));
}

const WORK_WINDOW = { equipment: 'Turbine 12', area: 'Nacelle', fromHours: '0800', toHours: '1600' };
const EVACUATION = { completedRemarks: 'clear', acknowledgedAtHours: '1610' };

function validWtg(): Record<string, unknown> {
  return {
    permitIssue: {
      windFarmName: 'Zephyr Wind Power Pakistan',
      wtgNumber: 'WTG-12',
      descriptionOfWork: 'Gearbox inspection',
      permitStartAt: '2026-01-01T08:00:00.000Z',
      permitExpiryAt: '2026-01-01T16:00:00.000Z',
    },
    sections: sectionAnswers(WTG_WORK_CHECKLIST_SECTIONS),
    isolationPoints: answers(WTG_ISOLATION_POINTS),
    ppe: ticks(WTG_PPE_REQUIRED),
  };
}

function validCold(): Record<string, unknown> {
  return {
    workWindow: WORK_WINDOW,
    natureOfWork: ticks(COLD_WORK_NATURE_OF_WORK),
    typeOfHazard: ticks(COLD_WORK_TYPE_OF_HAZARD),
    sections: sectionAnswers(COLD_WORK_CHECKLIST_SECTIONS),
    evacuation: EVACUATION,
  };
}

function validHot(): Record<string, unknown> {
  return {
    workWindow: WORK_WINDOW,
    natureOfWork: ticks(HOT_WORK_NATURE_OF_WORK),
    typeOfHazard: ticks(HOT_WORK_TYPE_OF_HAZARD),
    combustionSubTicks: Object.fromEntries(HOT_WORK_COMBUSTION_SUB_TICKS.map((t) => [t.id, false])),
    sections: sectionAnswers(HOT_WORK_CHECKLIST_SECTIONS),
    evacuation: EVACUATION,
  };
}

function validConfinedSpace(): Record<string, unknown> {
  return {
    workWindow: WORK_WINDOW,
    natureOfWork: ticks(CONFINED_SPACE_NATURE_OF_WORK),
    typeOfHazard: ticks(CONFINED_SPACE_TYPE_OF_HAZARD),
    combustionSubTicks: Object.fromEntries(CONFINED_SPACE_COMBUSTION_SUB_TICKS.map((t) => [t.id, false])),
    sections: sectionAnswers(CONFINED_SPACE_CHECKLIST_SECTIONS),
    gasTestRecord: Object.fromEntries(
      CONFINED_SPACE_GAS_TEST_TABLE.rows.map((row) => [row, { oxygenAndTime: '20.9% 0800' }]),
    ),
    evacuation: EVACUATION,
  };
}

function validJsa(): Record<string, unknown> {
  return {
    page1: {
      siteOrWtg: 'WTG-12',
      jobOrWork: 'Gearbox inspection',
      anyPermitsRequired: 'YES',
      requiredPermits: ticks(JSA_REQUIRED_PERMITS),
      hseChecklist: Object.fromEntries(
        JSA_HSE_CHECKLIST_CATEGORIES.map((category) => [category.id, ticks(category)]),
      ),
    },
    page2: {
      emergencyContacts: Object.fromEntries(JSA_EMERGENCY_CONTACTS.map((c) => [c.id, '0300-0000000'])),
      emergencyQuestions: Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((q) => [q.id, 'YES'])),
      taskAnalysis: [
        {
          sequenceOfTasks: 'Isolate',
          possibleHazardousEvents: 'Stored energy release',
          energySources: ['E', 'P'],
          triggeringEventsToStopWork: 'Unexpected movement',
          protectiveActionsOrMeasures: 'LOTO applied',
        },
      ],
      ppe: ticks(JSA_PPE_REQUIRED),
      participants: [{ nameAndPosition: 'Ali Khan / Technician', acknowledged: true }],
      approvals: Object.fromEntries(
        JSA_APPROVAL_SIGNATORIES.map((s) => [s.id, { nameAndPosition: 'Lead', closedOut: false }]),
      ),
    },
  };
}

const ok = (result: { ok: boolean }) => result.ok;

// ---------------------------------------------------------------------
// The valid shape, per permit type
// ---------------------------------------------------------------------

test('every permit type accepts a payload built from its own catalogue', () => {
  assert.ok(ok(parsePermitFormV2('WTG_WORK', validWtg())), 'WTG');
  assert.ok(ok(parsePermitFormV2('COLD_WORK', validCold())), 'Cold Work');
  assert.ok(ok(parsePermitFormV2('HOT_WORK', validHot())), 'Hot Work');
  assert.ok(ok(parsePermitFormV2('CONFINED_SPACE_ENTRY', validConfinedSpace())), 'Confined Space');
  assert.ok(ok(parseJsaFormV2(validJsa())), 'JSA');
});

test('the version identifiers are V2 and distinct from the live V1 ones', () => {
  assert.deepEqual(PERMIT_FORM_VERSIONS_V2, {
    WTG_WORK: 'WTG_WORK_V2',
    COLD_WORK: 'COLD_WORK_V2',
    HOT_WORK: 'HOT_WORK_V2',
    CONFINED_SPACE_ENTRY: 'CONFINED_SPACE_ENTRY_V2',
  });
  assert.equal(JSA_FORM_VERSION_V2, 'JSA_V2');
});

// ---------------------------------------------------------------------
// The client cannot decide what the questions are
// ---------------------------------------------------------------------

test('a client CANNOT supply or override a safety question label', () => {
  // The V1 attack: send your own wording. There is nowhere to put it.
  const form = validWtg() as { sections: Record<string, Record<string, unknown>> };
  form.sections.general_work!.a = { response: 'YES', label: 'A question I made up' };
  const result = parsePermitFormV2('WTG_WORK', form);
  assert.equal(result.ok, false, 'a label must be rejected, not stored');
});

test('a client CANNOT invent an extra question in a printed section', () => {
  const form = validWtg() as { sections: Record<string, Record<string, unknown>> };
  form.sections.general_work!.zz_invented = { response: 'YES' };
  assert.equal(parsePermitFormV2('WTG_WORK', form).ok, false);
});

test('a client CANNOT omit a printed question', () => {
  const form = validWtg() as { sections: Record<string, Record<string, unknown>> };
  delete form.sections.general_work!.a;
  assert.equal(parsePermitFormV2('WTG_WORK', form).ok, false, 'a skipped safety question must not be storable');
});

test('a client CANNOT drop or invent a whole printed section', () => {
  const dropped = validWtg() as { sections: Record<string, unknown> };
  delete dropped.sections.electrical_work;
  assert.equal(parsePermitFormV2('WTG_WORK', dropped).ok, false);

  const invented = validWtg() as { sections: Record<string, unknown> };
  invented.sections.nuclear_work = {};
  assert.equal(parsePermitFormV2('WTG_WORK', invented).ok, false);
});

test('a client CANNOT invent a PPE or hazard option', () => {
  const form = validCold() as { ppeExtra?: unknown; typeOfHazard: Record<string, unknown> };
  form.typeOfHazard.radiation = true;
  assert.equal(parsePermitFormV2('COLD_WORK', form).ok, false);
});

// ---------------------------------------------------------------------
// Response semantics, per printed band
// ---------------------------------------------------------------------

test('a Yes/No/N/A band accepts all three answers', () => {
  for (const response of ['YES', 'NO', 'NA']) {
    const form = validWtg() as { sections: Record<string, Record<string, unknown>> };
    form.sections.general_work!.a = { response };
    assert.ok(ok(parsePermitFormV2('WTG_WORK', form)), `${response} must be accepted`);
  }
});

test('a Yes/No-only band REJECTS N/A - the printed form has no such column', () => {
  // WTG Isolation Points prints Yes and No only.
  const isolation = validWtg() as { isolationPoints: Record<string, unknown> };
  isolation.isolationPoints.a = { response: 'NA' };
  assert.equal(parsePermitFormV2('WTG_WORK', isolation).ok, false);

  // So do all three of the 008A/B/C checklist bands.
  const cold = validCold() as { sections: Record<string, Record<string, unknown>> };
  cold.sections.general_requirements!['1'] = { response: 'NA' };
  assert.equal(parsePermitFormV2('COLD_WORK', cold).ok, false);
});

test('an unknown response value is rejected everywhere', () => {
  const form = validWtg() as { sections: Record<string, Record<string, unknown>> };
  form.sections.general_work!.a = { response: 'MAYBE' };
  assert.equal(parsePermitFormV2('WTG_WORK', form).ok, false);
});

test('the JSA HSE checklist is TICKS, not a Yes/No/N/A band', () => {
  const form = validJsa() as { page1: { hseChecklist: Record<string, Record<string, unknown>> } };
  form.page1.hseChecklist.ergonomic!['1'] = { response: 'YES' };
  assert.equal(parseJsaFormV2(form).ok, false, 'a tick is a boolean, not a response object');
});

// ---------------------------------------------------------------------
// The two contract gaps this stage exists to close
// ---------------------------------------------------------------------

test('requiredPermits carries all EIGHT printed permits plus Other - V1 had four', () => {
  assert.equal(JSA_REQUIRED_PERMITS.options.length, 8);
  assert.equal(JSA_REQUIRED_PERMITS.hasOther, true);

  // All eight keys are required.
  for (const option of JSA_REQUIRED_PERMITS.options) {
    const form = validJsa() as { page1: { requiredPermits: Record<string, unknown> } };
    delete form.page1.requiredPermits[option.id];
    assert.equal(parseJsaFormV2(form).ok, false, `${option.id} must be required`);
  }

  // The printed Other line is accepted as free text.
  const withOther = validJsa() as { page1: { requiredPermits: Record<string, unknown> } };
  withOther.page1.requiredPermits.other = 'Excavation permit';
  assert.ok(ok(parseJsaFormV2(withOther)));

  // V1's four-boolean shape is NOT what V2 accepts.
  const v1Shape = validJsa() as { page1: { requiredPermits: unknown } };
  v1Shape.page1.requiredPermits = { wtgWork: true, coldWork: false, hotWork: false, confinedSpaceEntry: false };
  assert.equal(parseJsaFormV2(v1Shape).ok, false);
});

test('taskAnalysis carries all FIVE printed columns - V1 collapsed two into one', () => {
  const row = {
    sequenceOfTasks: 'a',
    possibleHazardousEvents: 'b',
    energySources: ['M'],
    triggeringEventsToStopWork: 'd',
    protectiveActionsOrMeasures: 'e',
  };
  const form = validJsa() as { page2: { taskAnalysis: unknown[] } };
  form.page2.taskAnalysis = [row];
  assert.ok(ok(parseJsaFormV2(form)));

  // All five are ACCEPTED and distinct. They are no longer each
  // MANDATORY: a permit may be submitted partially completed, so a task
  // row may be started and left for the CRO to review. `energySources`
  // remains structurally required because it is a list, not free text -
  // an empty list is how "none" is expressed.
  for (const column of ['sequenceOfTasks', 'possibleHazardousEvents', 'triggeringEventsToStopWork', 'protectiveActionsOrMeasures']) {
    const withoutColumn = validJsa() as { page2: { taskAnalysis: Record<string, unknown>[] } };
    const partial: Record<string, unknown> = { ...row };
    delete partial[column];
    withoutColumn.page2.taskAnalysis = [partial];
    assert.equal(parseJsaFormV2(withoutColumn).ok, true, `${column} may be left blank`);

    // Present-but-empty is stored as given, never defaulted.
    const blanked = validJsa() as { page2: { taskAnalysis: Record<string, unknown>[] } };
    blanked.page2.taskAnalysis = [{ ...row, [column]: '' }];
    const parsedBlank = parseJsaFormV2(blanked);
    assert.equal(parsedBlank.ok, true, `${column} may be empty`);
  }

  // The one column that is not free text stays structurally required.
  const withoutEnergy = validJsa() as { page2: { taskAnalysis: Record<string, unknown>[] } };
  const noEnergy: Record<string, unknown> = { ...row };
  delete noEnergy.energySources;
  withoutEnergy.page2.taskAnalysis = [noEnergy];
  assert.equal(parseJsaFormV2(withoutEnergy).ok, false, 'energySources must still be present');

  // V1's merged column is not accepted.
  const v1Shape = validJsa() as { page2: { taskAnalysis: unknown[] } };
  v1Shape.page2.taskAnalysis = [
    { sequenceOfTasks: 'a', possibleHazardousEvents: 'b', energyOrTriggeringSources: 'c', protectiveActionsOrMeasures: 'e' },
  ];
  assert.equal(parseJsaFormV2(v1Shape).ok, false);
});

test('energy sources are constrained to the printed legend', () => {
  const bad = validJsa() as { page2: { taskAnalysis: Record<string, unknown>[] } };
  bad.page2.taskAnalysis[0]!.energySources = ['Z'];
  assert.equal(parseJsaFormV2(bad).ok, false, 'only M/E/C/P/G/H/R/B are printed');

  const duplicated = validJsa() as { page2: { taskAnalysis: Record<string, unknown>[] } };
  duplicated.page2.taskAnalysis[0]!.energySources = ['M', 'M'];
  assert.equal(parseJsaFormV2(duplicated).ok, false);
});

// ---------------------------------------------------------------------
// Permit types stay distinct
// ---------------------------------------------------------------------

test('Hot Work does NOT accept a Cold Work payload, and vice versa', () => {
  assert.equal(parsePermitFormV2('HOT_WORK', validCold()).ok, false, 'Hot Work has its own catalogue');
  assert.equal(parsePermitFormV2('COLD_WORK', validHot()).ok, false);
});

test('Hot Work rejects Cold Work\'s INSPECTION nature, which it does not print', () => {
  const form = validHot() as { natureOfWork: Record<string, unknown> };
  form.natureOfWork.inspection = true;
  assert.equal(parsePermitFormV2('HOT_WORK', form).ok, false);
});

test('Confined Space requires all three printed gas-test record rows', () => {
  const form = validConfinedSpace() as { gasTestRecord: Record<string, unknown> };
  delete form.gasTestRecord['3'];
  assert.equal(parsePermitFormV2('CONFINED_SPACE_ENTRY', form).ok, false);
});

// ---------------------------------------------------------------------
// Identity rule
// ---------------------------------------------------------------------

test('no V2 payload accepts a signer identity, permit number or JSA number', () => {
  const spoofs: Record<string, unknown>[] = [
    { ...validWtg(), applicantName: 'Someone Else' },
    { ...validWtg(), permitNumber: '729' },
    { ...validCold(), issuingAuthPerson: 'Someone Else' },
    { ...validCold(), jsaNumber: '3' },
    { ...validHot(), maintenanceAuthPerson: 'Someone Else' },
  ];
  assert.equal(parsePermitFormV2('WTG_WORK', spoofs[0]!).ok, false);
  assert.equal(parsePermitFormV2('WTG_WORK', spoofs[1]!).ok, false);
  assert.equal(parsePermitFormV2('COLD_WORK', spoofs[2]!).ok, false);
  assert.equal(parsePermitFormV2('COLD_WORK', spoofs[3]!).ok, false);
  assert.equal(parsePermitFormV2('HOT_WORK', spoofs[4]!).ok, false);

  const jsa = validJsa() as { page1: Record<string, unknown> };
  jsa.page1.completedBy = 'Someone Else';
  assert.equal(parseJsaFormV2(jsa).ok, false, 'JSA "completed by" is server-derived');
});

// ---------------------------------------------------------------------
// V1 COMPATIBILITY - stage A must not disturb the running application
// ---------------------------------------------------------------------

test('V1 still parses its own payloads exactly as before', () => {
  const v1Wtg = {
    windFarm: 'Zephyr',
    wtgNumber: 'WTG-1',
    descriptionOfWork: 'Work',
    permitStartAt: '2026-01-01T08:00:00.000Z',
    permitExpiryAt: '2026-01-01T16:00:00.000Z',
    generalWork: [{ label: 'Area barricaded', response: 'YES' }],
    electricalWork: [{ label: 'Circuit isolated', response: 'YES' }],
    mechanicalWork: [{ label: 'Rotor locked', response: 'YES' }],
    hydraulicWork: [{ label: 'Accumulator depressurized', response: 'NA' }],
    workAtHeights: [{ label: 'Fall arrest inspected', response: 'YES' }],
    specificSafetyRequirements: [{ label: 'Rescue plan briefed', response: 'YES' }],
    isolationPoints: [],
    ppe: [{ label: 'Helmet', selected: true }],
  };
  assert.ok(ok(parsePermitForm('WTG_WORK', v1Wtg)), 'the live V1 contract must be untouched');
});

test('the two contracts are genuinely separate - neither accepts the other', () => {
  assert.equal(parsePermitForm('WTG_WORK', validWtg()).ok, false, 'V1 must not accept a V2 payload');
  assert.equal(parsePermitFormV2('WTG_WORK', {
    windFarm: 'Zephyr',
    wtgNumber: 'WTG-1',
    descriptionOfWork: 'Work',
    permitStartAt: '2026-01-01T08:00:00.000Z',
    permitExpiryAt: '2026-01-01T16:00:00.000Z',
    generalWork: [{ label: 'x', response: 'YES' }],
    electricalWork: [{ label: 'x', response: 'YES' }],
    mechanicalWork: [{ label: 'x', response: 'YES' }],
    hydraulicWork: [{ label: 'x', response: 'YES' }],
    workAtHeights: [{ label: 'x', response: 'YES' }],
    specificSafetyRequirements: [{ label: 'x', response: 'YES' }],
    isolationPoints: [],
    ppe: [{ label: 'x', selected: true }],
  }).ok, false, 'V2 must not accept a V1 payload');

  const v1Jsa = {
    page1: {
      siteOrWtg: 'WTG-1',
      jobOrWork: 'Work',
      requiredPermits: { wtgWork: true, coldWork: false, hotWork: false, confinedSpaceEntry: false },
      hseChecklistGroups: [{ title: 'Access', items: [{ label: 'Ladder inspected', response: 'YES' }] }],
    },
    page2: {
      taskAnalysis: [
        { sequenceOfTasks: 'a', possibleHazardousEvents: 'b', energyOrTriggeringSources: 'c', protectiveActionsOrMeasures: 'd' },
      ],
      ppe: [{ label: 'Helmet', selected: true }],
      toolsAndMaterials: [],
      participants: [],
      participantAcknowledgements: [],
    },
  };
  assert.ok(ok(parseJsaForm(v1Jsa)), 'the live V1 JSA contract must be untouched');
  assert.equal(parseJsaFormV2(v1Jsa).ok, false);
});
