import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLD_WORK_CHECKLIST_SECTIONS,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_SLOGAN,
  COLD_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  CONFINED_SPACE_COMBUSTION_SUB_TICKS,
  CONFINED_SPACE_GAS_TEST_TABLE,
  CONFINED_SPACE_NATURE_OF_WORK,
  CONFINED_SPACE_SLOGAN,
  CONFINED_SPACE_TYPE_OF_HAZARD,
  FORM_REFERENCES,
  HOT_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_COMBUSTION_SUB_TICKS,
  HOT_WORK_NATURE_OF_WORK,
  HOT_WORK_SLOGAN,
  HOT_WORK_TYPE_OF_HAZARD,
  JSA_APPROVAL_SIGNATORIES,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_ENERGY_SOURCE_LEGEND,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  JSA_TASK_ANALYSIS_COLUMNS,
  PERMIT_008_AUTHORIZATION_BANDS,
  WTG_AUTHORIZATION_BANDS,
  WTG_WORK_CHECKLIST_SECTIONS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';

/**
 * THE SAFETY WORDING, PINNED.
 *
 * These assertions exist so that a future refactor which silently drops,
 * reorders, reworded or de-duplicates a printed safety question FAILS
 * rather than shipping. Every count and every label here was transcribed
 * from the operator's supplied forms in docs/reference-forms/.
 *
 * If one of these tests fails, the correct response is almost never to
 * update the test - it is to check the change against the printed form.
 */

const sectionById = (sections: readonly ChecklistSection[], id: string): ChecklistSection => {
  const found = sections.find((section) => section.id === id);
  assert.ok(found, `expected a section with id "${id}"`);
  return found;
};

const labels = (section: ChecklistSection | SelectionSection): string[] =>
  'items' in section ? section.items.map((i) => i.label) : section.options.map((o) => o.label);

// ---------------------------------------------------------------------
// Structural invariants that must hold for EVERY catalogue band
// ---------------------------------------------------------------------

const ALL_CHECKLISTS: readonly ChecklistSection[] = [
  ...WTG_WORK_CHECKLIST_SECTIONS,
  WTG_ISOLATION_POINTS,
  ...COLD_WORK_CHECKLIST_SECTIONS,
  ...HOT_WORK_CHECKLIST_SECTIONS,
  ...CONFINED_SPACE_CHECKLIST_SECTIONS,
];

const ALL_SELECTIONS: readonly SelectionSection[] = [
  WTG_PPE_REQUIRED,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_TYPE_OF_HAZARD,
  HOT_WORK_NATURE_OF_WORK,
  HOT_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_NATURE_OF_WORK,
  CONFINED_SPACE_TYPE_OF_HAZARD,
  JSA_REQUIRED_PERMITS,
  JSA_PPE_REQUIRED,
  ...JSA_HSE_CHECKLIST_CATEGORIES,
];

test('no catalogue band is empty, blank-labelled, or carries a duplicate id', () => {
  for (const section of [...ALL_CHECKLISTS, ...ALL_SELECTIONS]) {
    const entries = 'items' in section ? section.items : section.options;
    assert.ok(entries.length > 0, `${section.id} must not be empty`);
    const ids = entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${section.id} has a duplicate item id`);
    for (const entry of entries) {
      assert.ok(entry.label.trim().length > 0, `${section.id}/${entry.id} has a blank label`);
      assert.equal(entry.label, entry.label.trim(), `${section.id}/${entry.id} has padded whitespace`);
    }
  }
});

test('no catalogue band repeats the same printed text twice', () => {
  for (const section of [...ALL_CHECKLISTS, ...ALL_SELECTIONS]) {
    const seen = labels(section).map((l) => l.toLocaleLowerCase());
    assert.equal(new Set(seen).size, seen.length, `${section.id} repeats a printed label`);
  }
});

// ---------------------------------------------------------------------
// WTG Work Permit
// ---------------------------------------------------------------------

test('WTG: six numbered checklist sections, in printed order, all Yes/No/N/A', () => {
  assert.deepEqual(
    WTG_WORK_CHECKLIST_SECTIONS.map((s) => s.id),
    ['general_work', 'electrical_work', 'mechanical_work', 'hydraulic_work', 'work_at_heights', 'specific_safety_requirements'],
  );
  assert.deepEqual(
    WTG_WORK_CHECKLIST_SECTIONS.map((s) => s.printedNumber ?? null),
    ['2', '3', '4', '5', '6', null],
  );
  for (const section of WTG_WORK_CHECKLIST_SECTIONS) {
    assert.equal(section.responses, 'YES_NO_NA', `${section.id} prints a Yes/No/N/A band`);
  }
});

test('WTG: exact question counts per section', () => {
  assert.deepEqual(WTG_WORK_CHECKLIST_SECTIONS.map((s) => s.items.length), [9, 3, 2, 2, 3, 3]);
});

test('WTG 2(g) is the JSA question, confirmed by the operator - never "15A"', () => {
  const general = sectionById(WTG_WORK_CHECKLIST_SECTIONS, 'general_work');
  const g = general.items.find((i) => i.id === 'g');
  assert.equal(g?.label, 'Has JSA been carried out for this activity?');
  assert.ok(!labels(general).some((l) => l.includes('15A')), 'the misread "15A" must never reappear');
});

test('WTG General Work reads exactly as printed, a) through i)', () => {
  assert.deepEqual(labels(sectionById(WTG_WORK_CHECKLIST_SECTIONS, 'general_work')), [
    'Risk Assessment & safe system of work document & workers aware of/trained in findings?',
    'Those undertaking the work have appropriate competence & experience?',
    'Loss of service has been approved by site management?',
    'Are safety warning signs clearly displayed at the work location?',
    'Is suitable rescue equipment in place & certified for use?',
    'Are radios required or communication strategy known?',
    'Has JSA been carried out for this activity?',
    "Are tools and work equipment's suitable for the work activity?",
    'Aware with "work in and around the WTG"?',
  ]);
});

test('WTG Isolation Points: ten items a-j, and NO N/A column', () => {
  assert.equal(WTG_ISOLATION_POINTS.items.length, 10);
  assert.equal(WTG_ISOLATION_POINTS.responses, 'YES_NO', 'the printed band has only Yes and No');
  assert.deepEqual(WTG_ISOLATION_POINTS.items.map((i) => i.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.equal(WTG_ISOLATION_POINTS.items[0]!.label, 'Bottom box isolation');
  assert.equal(WTG_ISOLATION_POINTS.items[9]!.label, 'transformer isolation');
});

test('WTG PPE: eleven printed choices in order, plus the Other(s) line', () => {
  assert.equal(WTG_PPE_REQUIRED.options.length, 11);
  assert.equal(WTG_PPE_REQUIRED.hasOther, true);
  assert.deepEqual(labels(WTG_PPE_REQUIRED), [
    'Fall Protection', 'Full Suit', 'Electrical', 'Dust respirator', 'Vapor respirator',
    'Hardhat', 'Safety glasses', 'Face Shield', 'Boots', 'Ear protection', 'Gloves',
  ]);
});

test('WTG signature bands appear in printed order', () => {
  assert.deepEqual(labels({ id: 'x', title: 'x', hasOther: false, options: WTG_AUTHORIZATION_BANDS }), [
    'PERMIT ISSUER', 'PERMIT RECEIPT', 'EXTENSION OF PERMIT', 'PERMIT CLOSED',
  ]);
});

// ---------------------------------------------------------------------
// Cold Work Permit
// ---------------------------------------------------------------------

test('Cold Work: five Nature of Work options, INCLUDING Inspection', () => {
  assert.deepEqual(labels(COLD_WORK_NATURE_OF_WORK), [
    'MECHANICAL WORK', 'E&I WORK', 'CIVIL WORK', 'CHEMICAL WORK', 'INSPECTION',
  ]);
});

test('Cold Work: four hazard types, and NO combustion band', () => {
  assert.deepEqual(labels(COLD_WORK_TYPE_OF_HAZARD), [
    'ENERGIZED WORK', 'FALL HAZARD', 'RESPIRATORY HAZARD', 'CHEMICAL HAZARD',
  ]);
  assert.ok(
    !labels(COLD_WORK_TYPE_OF_HAZARD).some((l) => l.includes('COMBUSTION')),
    'Cold Work does not print the combustion & spark band',
  );
});

test('Cold Work: General Requirements 6, Equipment Condition 10, PPE 11 - all Yes/No only', () => {
  assert.deepEqual(COLD_WORK_CHECKLIST_SECTIONS.map((s) => s.items.length), [6, 10, 11]);
  for (const section of COLD_WORK_CHECKLIST_SECTIONS) assert.equal(section.responses, 'YES_NO');
});

test('Cold Work General Requirements preserves the printed spelling "LABEING"', () => {
  assert.deepEqual(labels(sectionById(COLD_WORK_CHECKLIST_SECTIONS, 'general_requirements')), [
    'AREA/EQUIPMENT/LINE READY',
    'SITE SPECIFIC HAZARD EXPLAINED',
    'EMERGENCY EGRESS PLANNED',
    'CONTAINERS LABEING O.K.',
    'MSDS INFORMATION AVAILABLE',
    'ANY SOURCE OF HEAT/SPARK INVOLVED',
  ]);
});

test('Cold Work slogan is printed verbatim', () => {
  assert.equal(COLD_WORK_SLOGAN, 'PERMIT SAVE LIVE - GIVE THEM THE PROPER ATTENTION');
});

// ---------------------------------------------------------------------
// Hot Work Permit - its OWN catalogue, not Cold Work's
// ---------------------------------------------------------------------

test('Hot Work: exactly FOUR Nature of Work options, with NO Inspection - operator confirmed', () => {
  assert.equal(HOT_WORK_NATURE_OF_WORK.options.length, 4);
  assert.deepEqual(labels(HOT_WORK_NATURE_OF_WORK), [
    'MECHANICAL WORK', 'E&I WORK', 'CIVIL WORK', 'CHEMICAL WORK',
  ]);
  assert.ok(!labels(HOT_WORK_NATURE_OF_WORK).includes('INSPECTION'));
});

test('Hot Work General Requirements item 2 is METAL THICKNESS FOR WELDING - operator confirmed', () => {
  const general = sectionById(HOT_WORK_CHECKLIST_SECTIONS, 'general_requirements');
  assert.equal(general.items[1]!.label, 'METAL THICKNESS FOR WELDING');
  assert.deepEqual(labels(general), [
    'AREA/EQUIPMENT/LINE READY',
    'METAL THICKNESS FOR WELDING',
    'SEWERS COVERED',
    'SITE SPECIFIC HAZARD EXPLAINED',
    'EMERGENCY EGRESS PLANNED',
    'FIRE WATCH READY',
    'FIRE EXTINGUISHER NEARBY',
    'MSDS INFORMATION AVAILABLE',
  ]);
});

test('Hot Work General Requirements is NOT Cold Work\'s - the two must never be aliased', () => {
  const hot = labels(sectionById(HOT_WORK_CHECKLIST_SECTIONS, 'general_requirements'));
  const cold = labels(sectionById(COLD_WORK_CHECKLIST_SECTIONS, 'general_requirements'));
  assert.notDeepEqual(hot, cold);
  assert.equal(hot.length, 8);
  assert.equal(cold.length, 6);
  for (const hotOnly of ['METAL THICKNESS FOR WELDING', 'SEWERS COVERED', 'FIRE WATCH READY', 'FIRE EXTINGUISHER NEARBY']) {
    assert.ok(hot.includes(hotOnly), `Hot Work must print "${hotOnly}"`);
    assert.ok(!cold.includes(hotOnly), `Cold Work must NOT print "${hotOnly}"`);
  }
  assert.ok(cold.includes('CONTAINERS LABEING O.K.'));
  assert.ok(!hot.includes('CONTAINERS LABEING O.K.'), 'Hot Work does not print the containers item');
});

test('Hot Work: five hazard types including combustion, with five sub-ticks', () => {
  assert.deepEqual(labels(HOT_WORK_TYPE_OF_HAZARD), [
    'COMBUSTION & SPARK PRODUCING HAZARD', 'ENERGISED EQPT HAZARD', 'FALL HAZARD',
    'RESPIRATORY HAZARD', 'CHEMICAL HAZARD',
  ]);
  assert.deepEqual(HOT_WORK_COMBUSTION_SUB_TICKS.map((s) => s.label), [
    'WELDING', 'CUTTING', 'BRAZING', 'GRINDING', 'DRILLING',
  ]);
});

test('Hot Work banner is printed verbatim', () => {
  assert.equal(HOT_WORK_SLOGAN, 'PERMIT VOID IF CONDITIONS CHANGED');
});

// ---------------------------------------------------------------------
// Confined Space Entry Permit
// ---------------------------------------------------------------------

test('Confined Space: SEVEN Nature of Work options, leading with Hot Work and Cold Work', () => {
  assert.equal(CONFINED_SPACE_NATURE_OF_WORK.options.length, 7);
  assert.deepEqual(labels(CONFINED_SPACE_NATURE_OF_WORK), [
    'HOT WORK', 'COLD WORK', 'MECHANICAL WORK', 'E&I WORK', 'CIVIL WORK', 'CHEMICAL WORK', 'INSPECTION',
  ]);
});

test('Confined Space: Gas Test 5, General Requirements 11, PPE 11 - all Yes/No only', () => {
  assert.deepEqual(CONFINED_SPACE_CHECKLIST_SECTIONS.map((s) => s.id), [
    'gas_test', 'general_requirements', 'protective_equipment',
  ]);
  assert.deepEqual(CONFINED_SPACE_CHECKLIST_SECTIONS.map((s) => s.items.length), [5, 11, 11]);
  for (const section of CONFINED_SPACE_CHECKLIST_SECTIONS) assert.equal(section.responses, 'YES_NO');
});

test('Confined Space Gas Test preserves the printed spelling "CONTINOUS"', () => {
  assert.deepEqual(labels(sectionById(CONFINED_SPACE_CHECKLIST_SECTIONS, 'gas_test')), [
    'GAS TEST CONDUCTED', 'INSTRUMENT USED', 'INSTRUMENT CALIBRATED',
    'GAS RETEST REQUIRED', 'CONTINOUS MONITORING',
  ]);
});

test('Confined Space gas-test record: three rows and the printed O2 range', () => {
  assert.deepEqual(CONFINED_SPACE_GAS_TEST_TABLE.rows, ['1', '2', '3']);
  assert.deepEqual(CONFINED_SPACE_GAS_TEST_TABLE.columns.map((c) => c.label), [
    'TEST NO.', '02 (19.5-23.5%) & TIME', 'SIGNATURE',
  ]);
});

test('Confined Space carries the same hazard band and sub-ticks as Hot Work', () => {
  assert.deepEqual(labels(CONFINED_SPACE_TYPE_OF_HAZARD), labels(HOT_WORK_TYPE_OF_HAZARD));
  assert.deepEqual(CONFINED_SPACE_COMBUSTION_SUB_TICKS, HOT_WORK_COMBUSTION_SUB_TICKS);
});

test('Confined Space banner is printed verbatim', () => {
  assert.equal(CONFINED_SPACE_SLOGAN, 'EVACUATE IMMEDIATELY IF CONDITIONS CHANGED');
});

test('008A/B/C share three authorization bands in printed order', () => {
  assert.deepEqual(PERMIT_008_AUTHORIZATION_BANDS.map((b) => b.id), [
    'inspected_safe_to_work', 'instructed_the_crew', 'evacuation',
  ]);
  assert.equal(
    PERMIT_008_AUTHORIZATION_BANDS[0]!.statement,
    'INSPECTED/DISCUSSED WORK AREA, JOB PREPARATIONS ARE COMPLETE AND IT IS SAFE TO WORK',
  );
  assert.deepEqual(PERMIT_008_AUTHORIZATION_BANDS[0]!.signatories.map((s) => s.label), [
    'ISSUING AUTH PERSON', 'EXTEND AUTH PERSON',
  ]);
});

// ---------------------------------------------------------------------
// JSA PAGE 1 OF 2
// ---------------------------------------------------------------------

test('JSA page 1: eight named permits plus the Other line', () => {
  assert.equal(JSA_REQUIRED_PERMITS.options.length, 8);
  assert.equal(JSA_REQUIRED_PERMITS.hasOther, true);
  assert.deepEqual(labels(JSA_REQUIRED_PERMITS), [
    'Energized Electrical Work (EEW)', 'Switching Authorization', 'Confined Space Entry',
    'Ground Disturbance', 'Simultaneous Operations (SIMOPS)', 'Major Equipment Movement',
    'Lifting Operations', 'Hot Work',
  ]);
});

test('JSA page 1 HSE CHECKLIST: sixteen categories in printed column order', () => {
  assert.deepEqual(JSA_HSE_CHECKLIST_CATEGORIES.map((c) => c.title), [
    // printed column 1, top to bottom
    'Ergonomic', 'Driving/Motorized Equipment', 'Electrical', 'Hot Work/Welding',
    'Environmental, Biological and Human',
    // printed column 2
    'Workplace Area and Design', 'Organizational Arrangements', 'Energy Isolation',
    'Heavy Lifting Equipment', 'Chemical and Toxicity',
    // printed column 3
    'Weather and Environmental Conditions', 'Working at Heights', 'Mechanical',
    'Ground Disturbance', 'Technical/Processes', 'Emergency and Communication',
  ]);
});

test('JSA page 1 HSE CHECKLIST: exact item count per category, and 115 in total', () => {
  assert.deepEqual(JSA_HSE_CHECKLIST_CATEGORIES.map((c) => c.options.length), [
    9, 5, 8, 9, 9, 10, 8, 7, 7, 5, 6, 6, 9, 7, 3, 7,
  ]);
  const total = JSA_HSE_CHECKLIST_CATEGORIES.reduce((sum, c) => sum + c.options.length, 0);
  assert.equal(total, 115, 'the printed HSE checklist carries 115 items');
});

test('JSA page 1: a representative category reads exactly as printed', () => {
  const energy = JSA_HSE_CHECKLIST_CATEGORIES.find((c) => c.id === 'energy_isolation');
  assert.deepEqual(labels(energy!), [
    'Is personnel trained to use LOTO?',
    'Walkthrough, discussion, LOTO verification',
    'Depressurized/drained (verification)',
    'Breaker open and locked?',
    'Mechanical energy released',
    'Purge/ventilation needed?',
    'LOTO checklist used and attached to JSA?',
  ]);
});

test('JSA page 1 HSE items are ticks - no category offers Yes/No/N/A', () => {
  for (const category of JSA_HSE_CHECKLIST_CATEGORIES) {
    assert.ok(!('responses' in category), `${category.id} must be a tick band, not a response band`);
  }
});

// ---------------------------------------------------------------------
// JSA PAGE 2 OF 2
// ---------------------------------------------------------------------

test('JSA page 2: emergency response table and its two questions', () => {
  assert.deepEqual(JSA_EMERGENCY_CONTACTS.map((c) => c.label), [
    'Radio Channel / Cell phone', 'E-Set Emergency response unit',
  ]);
  assert.deepEqual(JSA_EMERGENCY_QUESTIONS.map((q) => q.label), [
    'Was the Emergency Response Plan understood and agreed prior start working?',
    'Is language a working team concern/behaviour?',
  ]);
});

test('JSA page 2: the Task Analysis table has five printed columns in order', () => {
  assert.deepEqual(JSA_TASK_ANALYSIS_COLUMNS.map((c) => c.label), [
    'Sequence of Tasks', 'Possible Hazardous Events', 'Energy Sources',
    'Triggering Events to Stop the Work', 'Protective Actions/ Measures to Reduce Risk',
  ]);
});

test('JSA page 2: the eight energy-source codes', () => {
  assert.deepEqual(JSA_ENERGY_SOURCE_LEGEND.map((e) => e.code), ['M', 'E', 'C', 'P', 'G', 'H', 'R', 'B']);
  assert.deepEqual(JSA_ENERGY_SOURCE_LEGEND.map((e) => e.label), [
    'mechanical', 'electrical', 'chemical', 'pressure', 'gravity', 'heat/cold', 'radiation', 'biological',
  ]);
});

test('JSA page 2 PPE is the SAME printed band as the WTG permit, same order', () => {
  assert.deepEqual(labels(JSA_PPE_REQUIRED), labels(WTG_PPE_REQUIRED));
  assert.equal(JSA_PPE_REQUIRED.hasOther, true);
});

test('JSA page 2: two approval signatories in printed order', () => {
  assert.deepEqual(JSA_APPROVAL_SIGNATORIES.map((s) => s.label), ['Job Lead', 'Work Authorizer']);
});

// ---------------------------------------------------------------------
// The two JSA pages are distinct and must stay that way
// ---------------------------------------------------------------------

test('the JSA is TWO pages: page 1 content never leaks onto page 2', () => {
  const page1 = [
    ...JSA_REQUIRED_PERMITS.options.map((o) => o.label),
    ...JSA_HSE_CHECKLIST_CATEGORIES.flatMap((c) => c.options.map((o) => o.label)),
  ];
  const page2 = [
    ...JSA_EMERGENCY_CONTACTS.map((c) => c.label),
    ...JSA_EMERGENCY_QUESTIONS.map((q) => q.label),
    ...JSA_TASK_ANALYSIS_COLUMNS.map((c) => c.label),
    ...JSA_APPROVAL_SIGNATORIES.map((s) => s.label),
  ];
  const overlap = page1.filter((label) => page2.includes(label));
  assert.deepEqual(overlap, [], 'no printed item belongs to both JSA pages');
});

test('form reference numbers match the printed footers', () => {
  assert.deepEqual(FORM_REFERENCES, {
    COLD_WORK: 'E-SET-ZPL-F-008A',
    CONFINED_SPACE_ENTRY: 'E-SET-ZPL-F-008B',
    HOT_WORK: 'E-SET-ZPL-F-008C',
    JSA: 'E-SET-ZPL-F-009',
  });
});

test('no catalogue label contains collapsed whitespace it could never render with', () => {
  // HTML collapses runs of whitespace, so a label carrying a double space
  // can never display as transcribed - it is always a transcription
  // artifact rather than printed wording. Caught by real-browser QA on
  // Cold Work's "ALL VALVES BLOCKED / BLINDED".
  for (const section of [...ALL_CHECKLISTS, ...ALL_SELECTIONS]) {
    for (const entry of 'items' in section ? section.items : section.options) {
      assert.ok(
        !/\s{2,}/.test(entry.label),
        `${section.id}/${entry.id} carries collapsed whitespace: ${JSON.stringify(entry.label)}`,
      );
    }
  }
});
