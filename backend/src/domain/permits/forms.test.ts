import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveJsaFormProjection,
  derivePermitFormProjection,
  MAX_FORM_PAYLOAD_BYTES,
  parseJsaForm,
  parsePermitForm,
  PERMIT_FORM_VERSIONS,
  PERMIT_TYPES,
} from './forms.js';
import {
  makeColdWorkForm,
  makeConfinedSpaceEntryForm,
  makeHotWorkForm,
  makeJsaForm,
  makeWtgWorkForm,
} from './formFixtures.test.js';

/** Every fixture is a complete, realistic payload for its own template. */
const VALID_FORMS = {
  WTG_WORK: makeWtgWorkForm(),
  COLD_WORK: makeColdWorkForm(),
  HOT_WORK: makeHotWorkForm(),
  CONFINED_SPACE_ENTRY: makeConfinedSpaceEntryForm(),
} as const;

test('every V1 permit template accepts its own complete form payload', () => {
  for (const permitType of PERMIT_TYPES) {
    const result = parsePermitForm(permitType, VALID_FORMS[permitType]);
    assert.equal(result.ok, true, `${permitType} should accept its own payload`);
  }
});

test('each permit type maps to exactly one form version', () => {
  assert.deepEqual(PERMIT_FORM_VERSIONS, {
    WTG_WORK: 'WTG_WORK_V1',
    COLD_WORK: 'COLD_WORK_V1',
    HOT_WORK: 'HOT_WORK_V1',
    CONFINED_SPACE_ENTRY: 'CONFINED_SPACE_ENTRY_V1',
  });
});

test('cross-template payloads are rejected in every direction', () => {
  for (const declaredType of PERMIT_TYPES) {
    for (const payloadType of PERMIT_TYPES) {
      if (declaredType === payloadType) continue;
      const result = parsePermitForm(declaredType, VALID_FORMS[payloadType]);
      assert.equal(
        result.ok,
        false,
        `a ${payloadType} payload must not validate as ${declaredType}`,
      );
    }
  }
});

test('a JSA payload is never accepted as a permit payload, and vice versa', () => {
  for (const permitType of PERMIT_TYPES) {
    assert.equal(parsePermitForm(permitType, makeJsaForm()).ok, false);
    assert.equal(parseJsaForm(VALID_FORMS[permitType]).ok, false);
  }
});

test('unknown top-level properties are rejected, never silently dropped', () => {
  for (const permitType of PERMIT_TYPES) {
    const result = parsePermitForm(permitType, { ...VALID_FORMS[permitType], smuggledField: 'x' });
    assert.equal(result.ok, false, `${permitType} must reject an unknown property`);
  }
  assert.equal(parseJsaForm({ ...makeJsaForm(), smuggledField: 'x' }).ok, false);
});

test('unknown NESTED properties are rejected too (strictness is not only top-level)', () => {
  const wtg = makeWtgWorkForm();
  const nestedUnknown = parsePermitForm('WTG_WORK', {
    ...wtg,
    generalWork: [{ label: 'Area barricaded', response: 'YES', signedBy: 'someone' }],
  });
  assert.equal(nestedUnknown.ok, false);

  const coldUnknownOption = parsePermitForm('COLD_WORK', {
    ...makeColdWorkForm(),
    natureOfWork: { ...makeColdWorkForm().natureOfWork, welding: true },
  });
  assert.equal(coldUnknownOption.ok, false);

  const jsa = makeJsaForm();
  const jsaNested = parseJsaForm({
    ...jsa,
    page1: { ...jsa.page1, requiredPermits: { ...jsa.page1.requiredPermits, excavation: true } },
  });
  assert.equal(jsaNested.ok, false);
});

test('a client can never supply a signer identity through a form payload', () => {
  // The JSA "completed by" identity is authenticated and server-derived;
  // there is no field for it, so supplying one is rejected outright.
  const jsa = makeJsaForm();
  const withCompletedBy = parseJsaForm({
    ...jsa,
    page1: { ...jsa.page1, completedBy: 'Someone Else' },
  });
  assert.equal(withCompletedBy.ok, false);

  for (const permitType of PERMIT_TYPES) {
    for (const field of ['applicantName', 'croName', 'hseName', 'signature', 'signedBy']) {
      const result = parsePermitForm(permitType, { ...VALID_FORMS[permitType], [field]: 'Impostor' });
      assert.equal(result.ok, false, `${permitType} must reject a client-supplied ${field}`);
    }
  }
});

test('missing required fields are rejected per template', () => {
  const { windFarm, ...withoutWindFarm } = makeWtgWorkForm();
  assert.ok(windFarm);
  assert.equal(parsePermitForm('WTG_WORK', withoutWindFarm).ok, false);

  const { natureOfWork, ...withoutNature } = makeColdWorkForm();
  assert.ok(natureOfWork);
  assert.equal(parsePermitForm('COLD_WORK', withoutNature).ok, false);

  const { fireWatch, ...withoutFireWatch } = makeHotWorkForm();
  assert.ok(fireWatch);
  assert.equal(parsePermitForm('HOT_WORK', withoutFireWatch).ok, false);

  const { gasTest, ...withoutGasTest } = makeConfinedSpaceEntryForm();
  assert.ok(gasTest);
  assert.equal(parsePermitForm('CONFINED_SPACE_ENTRY', withoutGasTest).ok, false);
});

test('blank and whitespace-only text is rejected; accepted text is trimmed', () => {
  assert.equal(parsePermitForm('WTG_WORK', makeWtgWorkForm({ windFarm: '   ' })).ok, false);
  const trimmed = parsePermitForm('WTG_WORK', makeWtgWorkForm({ windFarm: '  Jhimpir  ' }));
  assert.equal(trimmed.ok, true);
  if (trimmed.ok) assert.equal((trimmed.data as { windFarm: string }).windFarm, 'Jhimpir');
});

test('malformed field types are rejected rather than coerced', () => {
  assert.equal(parsePermitForm('COLD_WORK', makeColdWorkForm({
    natureOfWork: { mechanical: 'yes', electricalAndInstrumentation: false, civil: false, chemical: false, inspection: false },
  } as never)).ok, false);
  assert.equal(parsePermitForm('WTG_WORK', makeWtgWorkForm({ generalWork: 'not-an-array' } as never)).ok, false);
  assert.equal(
    parsePermitForm('WTG_WORK', makeWtgWorkForm({ generalWork: [{ label: 'x', response: 'MAYBE' }] } as never)).ok,
    false,
  );
});

test('WTG_WORK rejects an expiry before its start and normalizes both to canonical UTC', () => {
  const invalid = parsePermitForm('WTG_WORK', makeWtgWorkForm({
    permitStartAt: '2026-01-01T18:00:00.000Z',
    permitExpiryAt: '2026-01-01T06:00:00.000Z',
  }));
  assert.equal(invalid.ok, false);

  const offsetForm = parsePermitForm('WTG_WORK', makeWtgWorkForm({
    permitStartAt: '2026-01-01T11:00:00+05:00',
    permitExpiryAt: '2026-01-01T23:00:00+05:00',
  }));
  assert.equal(offsetForm.ok, true);
  if (offsetForm.ok) {
    const form = offsetForm.data as { permitStartAt: string; permitExpiryAt: string };
    assert.equal(form.permitStartAt, '2026-01-01T06:00:00.000Z');
    assert.equal(form.permitExpiryAt, '2026-01-01T18:00:00.000Z');
  }
});

test('confined-space gas test rows: repeatable, validated, and numerically bounded', () => {
  const base = makeConfinedSpaceEntryForm();

  const many = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: {
      ...base.gasTest,
      // Distinct times: twelve genuinely separate readings, not the same
      // reading recorded twelve times (which the duplicate guard rejects).
      readings: Array.from({ length: 12 }, (_, index) => ({
        time: `2026-01-01T${String(index).padStart(2, '0')}:00:00.000Z`,
        oxygenPercent: 20.9,
        result: 'PASS' as const,
      })),
    },
  }));
  assert.equal(many.ok, true);
  if (many.ok) assert.equal((many.data as typeof base).gasTest.readings.length, 12);

  // The gas-test band is a printed section of the Confined Space Entry
  // form, so it may never be submitted empty (tightened from the
  // permissive original behaviour - see the dedicated section-content
  // tests below).
  const noReadings = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [] },
  }));
  assert.equal(noReadings.ok, false);

  const outOfRange = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [{ time: '2026-01-01T06:00:00.000Z', oxygenPercent: 120, result: 'PASS' }] },
  }));
  assert.equal(outOfRange.ok, false);

  const badResult = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [{ time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'MAYBE' }] },
  } as never));
  assert.equal(badResult.ok, false);

  const badTime = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [{ time: 'half past nine', oxygenPercent: 20.9, result: 'PASS' }] },
  }));
  assert.equal(badTime.ok, false);

  // Normalized to one decimal place so the stored text form is stable
  // across the JSONB round trip the snapshot hash is verified against.
  const precise = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [{ time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.94999, result: 'PASS' }] },
  }));
  assert.equal(precise.ok, true);
  if (precise.ok) assert.equal((precise.data as typeof base).gasTest.readings[0]?.oxygenPercent, 20.9);
});

test('JSA task-analysis rows are repeatable, complete, and required at least once', () => {
  const jsa = makeJsaForm();

  const empty = parseJsaForm({ ...jsa, page2: { ...jsa.page2, taskAnalysis: [] } });
  assert.equal(empty.ok, false);

  const incomplete = parseJsaForm({
    ...jsa,
    page2: {
      ...jsa.page2,
      taskAnalysis: [{ sequenceOfTasks: 'Isolate', possibleHazardousEvents: 'Movement' }],
    },
  });
  assert.equal(incomplete.ok, false);

  const many = parseJsaForm({
    ...jsa,
    page2: {
      ...jsa.page2,
      taskAnalysis: Array.from({ length: 25 }, (_, index) => ({
        sequenceOfTasks: `Step ${index}`,
        possibleHazardousEvents: 'Hazard',
        energyOrTriggeringSources: 'Source',
        protectiveActionsOrMeasures: 'Measure',
      })),
    },
  });
  assert.equal(many.ok, true);
  if (many.ok) assert.equal(many.data.page2.taskAnalysis.length, 25);
});

test('JSA page 1 keeps the four confirmed permit selections and repeatable HSE checklist groups', () => {
  const jsa = makeJsaForm();
  const parsed = parseJsaForm(jsa);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(Object.keys(parsed.data.page1.requiredPermits).sort(), [
    'coldWork',
    'confinedSpaceEntry',
    'hotWork',
    'wtgWork',
  ]);
  assert.equal(parsed.data.page1.hseChecklistGroups.length, 2);
  assert.equal(parsed.data.page1.hseChecklistGroups[0]?.title, 'Access');
});

test('an oversized payload is rejected before schema parsing, without a size-based crash', () => {
  const huge = makeWtgWorkForm({
    generalWork: Array.from({ length: 80 }, () => ({
      label: 'x'.repeat(300),
      response: 'YES' as const,
      remarks: 'y'.repeat(500),
    })),
    descriptionOfWork: 'z'.repeat(4000),
    specialPrecautions: 'w'.repeat(2000),
    specialInstructions: 'v'.repeat(2000),
  });
  const payload = { ...huge, isolationPoints: Array.from({ length: 60 }, () => ({ description: 'p'.repeat(300), remarks: 'q'.repeat(500) })) };
  const serializedSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  // The fixture must actually be under the cap for this test to prove
  // anything about the cap itself, so build an explicitly oversized one.
  assert.ok(serializedSize < MAX_FORM_PAYLOAD_BYTES * 4);

  const oversized = { ...makeWtgWorkForm(), descriptionOfWork: 'a'.repeat(MAX_FORM_PAYLOAD_BYTES + 1) };
  const result = parsePermitForm('WTG_WORK', oversized);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'too_large');
});

test('non-object payloads are rejected for both permit and JSA forms', () => {
  for (const value of [null, undefined, 'string', 42, true, ['array']]) {
    assert.equal(parsePermitForm('WTG_WORK', value).ok, false);
    assert.equal(parseJsaForm(value).ok, false);
  }
});

test('relational projections are derived from the validated payload only', () => {
  const wtg = makeWtgWorkForm();
  assert.deepEqual(derivePermitFormProjection('WTG_WORK', wtg), {
    windFarm: 'Jhimpir Wind Farm',
    wtgNumber: 'WTG-07',
    workDescription: 'Replace yaw motor and inspect the yaw ring.',
    lotoNumber: null,
  });

  assert.deepEqual(derivePermitFormProjection('COLD_WORK', makeColdWorkForm()), {
    windFarm: null,
    wtgNumber: null,
    workDescription: null,
    lotoNumber: 'LOTO-8891',
  });

  assert.deepEqual(derivePermitFormProjection('HOT_WORK', makeHotWorkForm({ lotoNumber: undefined })), {
    windFarm: null,
    wtgNumber: null,
    workDescription: null,
    lotoNumber: null,
  });

  assert.deepEqual(deriveJsaFormProjection(makeJsaForm()), {
    siteOrWtg: 'WTG-07',
    jobDescription: 'Yaw motor replacement',
  });
});

// ---------------------------------------------------------------------
// Required section content (the HIGH-1 fix)
// ---------------------------------------------------------------------
//
// A printed section of a permit/JSA form may never be submitted empty:
// an empty section is indistinguishable from one nobody filled in, and
// the issued immutable document would then reproduce a permit whose
// safety checklist says nothing at all. `NA` exists so an item that does
// not apply is recorded as answered rather than omitted.
//
// These tests bound WHETHER the printed items are answered. They cannot
// bound WHICH items they are: the authoritative per-template item
// catalogue is not supplied anywhere in this repository, and inventing
// safety questions is forbidden - see DECISIONS.md open decision #4.

/** Every checklist section that is printed on each template's form. */
const REQUIRED_CHECKLIST_SECTIONS = {
  WTG_WORK: [
    'generalWork',
    'electricalWork',
    'mechanicalWork',
    'hydraulicWork',
    'workAtHeights',
    'specificSafetyRequirements',
  ],
  COLD_WORK: ['generalRequirements', 'equipmentCondition'],
  HOT_WORK: ['generalRequirements', 'equipmentCondition'],
  CONFINED_SPACE_ENTRY: ['generalRequirements'],
} as const;

/** Every tick-box band that is printed on each template's form. */
const REQUIRED_SELECTION_SECTIONS = {
  WTG_WORK: ['ppe'],
  COLD_WORK: ['ppe'],
  HOT_WORK: ['natureOfWork', 'typeOfHazard', 'ppe'],
  CONFINED_SPACE_ENTRY: ['natureOfWork', 'typeOfHazard', 'ppe'],
} as const;

const FORM_BUILDERS = {
  WTG_WORK: makeWtgWorkForm,
  COLD_WORK: makeColdWorkForm,
  HOT_WORK: makeHotWorkForm,
  CONFINED_SPACE_ENTRY: makeConfinedSpaceEntryForm,
} as const;

function formWith(permitType: keyof typeof FORM_BUILDERS, section: string, value: unknown): unknown {
  return { ...(FORM_BUILDERS[permitType]() as Record<string, unknown>), [section]: value };
}

test('an EMPTY required checklist section is rejected for every permit template', () => {
  for (const [permitType, sections] of Object.entries(REQUIRED_CHECKLIST_SECTIONS)) {
    for (const section of sections) {
      const result = parsePermitForm(permitType as keyof typeof FORM_BUILDERS, formWith(permitType as keyof typeof FORM_BUILDERS, section, []));
      assert.equal(result.ok, false, `${permitType}.${section} must not accept an empty section`);
    }
  }
});

test('an EMPTY required tick-box band (PPE, Nature of Work, Type of Hazard) is rejected', () => {
  for (const [permitType, sections] of Object.entries(REQUIRED_SELECTION_SECTIONS)) {
    for (const section of sections) {
      const result = parsePermitForm(permitType as keyof typeof FORM_BUILDERS, formWith(permitType as keyof typeof FORM_BUILDERS, section, []));
      assert.equal(result.ok, false, `${permitType}.${section} must not accept an empty band`);
    }
  }
});

test('a permit with every required section populated is still accepted, unchanged', () => {
  for (const permitType of Object.keys(FORM_BUILDERS) as (keyof typeof FORM_BUILDERS)[]) {
    assert.equal(parsePermitForm(permitType, FORM_BUILDERS[permitType]()).ok, true, permitType);
  }
});

test('a single answered item satisfies a required section - including an N/A answer', () => {
  for (const response of ['YES', 'NO', 'NA'] as const) {
    const result = parsePermitForm('WTG_WORK', formWith('WTG_WORK', 'generalWork', [{ label: 'Area barricaded', response }]));
    assert.equal(result.ok, true, `a single ${response} answer must satisfy the section`);
  }
  const band = parsePermitForm('HOT_WORK', formWith('HOT_WORK', 'ppe', [{ label: 'Welding shield', selected: false }]));
  assert.equal(band.ok, true, 'an unticked but present option still counts as content');
});

test('a blank or whitespace-only checklist label is rejected', () => {
  for (const label of ['', '   ', '\t\n']) {
    assert.equal(
      parsePermitForm('COLD_WORK', formWith('COLD_WORK', 'generalRequirements', [{ label, response: 'YES' }])).ok,
      false,
      `label ${JSON.stringify(label)} must be rejected`,
    );
    assert.equal(
      parsePermitForm('COLD_WORK', formWith('COLD_WORK', 'ppe', [{ label, selected: true }])).ok,
      false,
      `band label ${JSON.stringify(label)} must be rejected`,
    );
  }
});

test('a malformed checklist answer is rejected rather than coerced', () => {
  for (const response of ['MAYBE', 'yes', true, 1, null]) {
    assert.equal(
      parsePermitForm('WTG_WORK', formWith('WTG_WORK', 'generalWork', [{ label: 'Area barricaded', response }])).ok,
      false,
      `response ${JSON.stringify(response)} must be rejected`,
    );
  }
  assert.equal(
    parsePermitForm('WTG_WORK', formWith('WTG_WORK', 'ppe', [{ label: 'Helmet', selected: 'yes' }])).ok,
    false,
    'a non-boolean tick must be rejected',
  );
});

test('the same item answered twice in one section is rejected (case- and whitespace-insensitive)', () => {
  const duplicate = parsePermitForm('COLD_WORK', formWith('COLD_WORK', 'generalRequirements', [
    { label: 'Work area inspected', response: 'YES' },
    { label: '  work area INSPECTED ', response: 'NO' },
  ]));
  assert.equal(duplicate.ok, false, 'a duplicated question - here with conflicting answers - must be rejected');

  const distinct = parsePermitForm('COLD_WORK', formWith('COLD_WORK', 'generalRequirements', [
    { label: 'Work area inspected', response: 'YES' },
    { label: 'Access route inspected', response: 'YES' },
  ]));
  assert.equal(distinct.ok, true, 'genuinely different items in one section remain valid');

  const duplicateBand = parsePermitForm('HOT_WORK', formWith('HOT_WORK', 'ppe', [
    { label: 'Welding shield', selected: true },
    { label: 'welding shield', selected: false },
  ]));
  assert.equal(duplicateBand.ok, false, 'a duplicated tick-box option must be rejected');
});

test('optional free-text sections stay optional - the rule tightens sections, not prose', () => {
  const wtg = makeWtgWorkForm();
  delete (wtg as Record<string, unknown>).specialPrecautions;
  delete (wtg as Record<string, unknown>).specialInstructions;
  assert.equal(parsePermitForm('WTG_WORK', wtg).ok, true);

  const hot = makeHotWorkForm();
  for (const key of ['specialPrecautions', 'specialInstructions', 'evacuationDetails', 'remarks', 'relatedPermitRef', 'lotoNumber']) {
    delete (hot as Record<string, unknown>)[key];
  }
  assert.equal(parsePermitForm('HOT_WORK', hot).ok, true);

  // Isolation points are a conditional data table, not a printed
  // checklist band: a permit with nothing to isolate is a real form.
  assert.equal(parsePermitForm('WTG_WORK', makeWtgWorkForm({ isolationPoints: [] })).ok, true);
});

test('JSA: an empty HSE checklist band, an empty set of bands, and a duplicated band are all rejected', () => {
  const jsa = makeJsaForm();

  const noGroups = parseJsaForm({ ...jsa, page1: { ...jsa.page1, hseChecklistGroups: [] } });
  assert.equal(noGroups.ok, false, 'a JSA with no HSE checklist at all must be rejected');

  const emptyGroup = parseJsaForm({
    ...jsa,
    page1: { ...jsa.page1, hseChecklistGroups: [{ title: 'Access', items: [] }] },
  });
  assert.equal(emptyGroup.ok, false, 'an HSE band with no answered item must be rejected');

  const duplicateGroup = parseJsaForm({
    ...jsa,
    page1: {
      ...jsa.page1,
      hseChecklistGroups: [
        { title: 'Access', items: [{ label: 'Ladder inspected', response: 'YES' }] },
        { title: ' access ', items: [{ label: 'Ladder inspected', response: 'NO' }] },
      ],
    },
  });
  assert.equal(duplicateGroup.ok, false, 'the same HSE band must not appear twice');

  const emptyPpe = parseJsaForm({ ...jsa, page2: { ...jsa.page2, ppe: [] } });
  assert.equal(emptyPpe.ok, false, 'the JSA PPE band must not be empty');

  assert.equal(parseJsaForm(jsa).ok, true, 'a fully populated JSA is still accepted');
});

test('JSA task analysis keeps its existing at-least-one-row requirement and complete rows', () => {
  const jsa = makeJsaForm();
  assert.equal(parseJsaForm({ ...jsa, page2: { ...jsa.page2, taskAnalysis: [] } }).ok, false);
  assert.equal(
    parseJsaForm({
      ...jsa,
      page2: { ...jsa.page2, taskAnalysis: [{ sequenceOfTasks: 'Isolate', possibleHazardousEvents: 'Movement' }] },
    }).ok,
    false,
    'a task row missing its structured fields must be rejected',
  );
  for (const blank of ['', '   ']) {
    assert.equal(
      parseJsaForm({
        ...jsa,
        page2: {
          ...jsa.page2,
          taskAnalysis: [{
            sequenceOfTasks: blank,
            possibleHazardousEvents: 'Hazard',
            energyOrTriggeringSources: 'Source',
            protectiveActionsOrMeasures: 'Measure',
          }],
        },
      }).ok,
      false,
      'a blank structured task field must be rejected',
    );
  }
});

test('confined space: a gas-test band with no reading is rejected; one valid reading is accepted', () => {
  const base = makeConfinedSpaceEntryForm();

  const noReadings = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, readings: [] },
  }));
  assert.equal(noReadings.ok, false, 'an entry permit recording no gas reading is an incomplete form');

  const oneReading = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: {
      ...base.gasTest,
      readings: [{ time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'PASS' }],
    },
  }));
  assert.equal(oneReading.ok, true);

  // The band stays repeatable so a retest / continuous-monitoring spot
  // record is simply an additional row.
  const retest = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: {
      ...base.gasTest,
      retestRequired: true,
      retestDetails: 'Retest every 2 hours',
      readings: [
        { time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'PASS' },
        { time: '2026-01-01T08:00:00.000Z', oxygenPercent: 20.8, result: 'PASS' },
      ],
    },
  }));
  assert.equal(retest.ok, true, 'a retest reading is an additional row, not a schema change');

  const duplicateReading = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: {
      ...base.gasTest,
      readings: [
        { time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'PASS', testedBy: 'Gas tester on duty' },
        { time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'PASS', testedBy: 'Gas tester on duty' },
      ],
    },
  }));
  assert.equal(duplicateReading.ok, false, 'the identical reading recorded twice is a data-entry fault');

  // Instrument, calibration and monitoring stay strictly validated.
  assert.equal(parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, continuousMonitoring: 'yes' as never },
  })).ok, false);
  assert.equal(parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, retestRequired: 'true' as never },
  })).ok, false);
  assert.equal(parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, instrument: '   ' },
  })).ok, false);
  assert.equal(parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    gasTest: { ...base.gasTest, instrumentCalibration: '' },
  })).ok, false);
});

test('an incomplete permit form cannot reach the issued document: the whole payload is rejected before storage', () => {
  // The same rejection applies wherever a payload is validated, so an
  // empty section can never be persisted and therefore can never be
  // frozen into an immutable snapshot or rendered onto a PDF.
  const stripped = parsePermitForm('CONFINED_SPACE_ENTRY', makeConfinedSpaceEntryForm({
    generalRequirements: [],
    ppe: [],
  }));
  assert.equal(stripped.ok, false);
  if (!stripped.ok && stripped.reason === 'invalid') {
    const paths = stripped.issues.map((issue) => issue.path.join('.'));
    assert.ok(paths.includes('generalRequirements'), 'the empty section is named in the rejection');
    assert.ok(paths.includes('ppe'), 'every empty section is reported, not just the first');
  }
});
