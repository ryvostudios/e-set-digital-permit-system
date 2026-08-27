import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_FORM_GENERATION,
  derivePermitProjectionForVersion,
  deriveJsaProjectionForVersion,
  generationOfJsaFormVersion,
  generationOfPermitFormVersion,
  jsaFormVersionFor,
  parseJsaFormForVersion,
  parsePermitFormForVersion,
  permitFormVersionFor,
} from './formGeneration.js';

/**
 * WHICH CONTRACT READS A GIVEN ROW.
 *
 * The security-relevant property is that the STORED `form_version`
 * decides, never the request. If a client could choose, it would simply
 * ask for V1 to escape V2's fixed-key checking and go back to sending its
 * own safety-question labels.
 */

const V1_WTG = {
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

const V1_JSA = {
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

test('the cutover switch is still V1 - flipping it is the whole cutover', () => {
  // Guards against the flip landing before the frontend can render V2.
  assert.equal(ACTIVE_FORM_GENERATION, 'V1');
});

test('each generation names its own version per permit type', () => {
  assert.equal(permitFormVersionFor('WTG_WORK', 'V1'), 'WTG_WORK_V1');
  assert.equal(permitFormVersionFor('WTG_WORK', 'V2'), 'WTG_WORK_V2');
  assert.equal(permitFormVersionFor('CONFINED_SPACE_ENTRY', 'V2'), 'CONFINED_SPACE_ENTRY_V2');
  assert.equal(jsaFormVersionFor('V1'), 'JSA_V1');
  assert.equal(jsaFormVersionFor('V2'), 'JSA_V2');
});

test('a stored version maps back to its generation', () => {
  assert.equal(generationOfPermitFormVersion('HOT_WORK_V1'), 'V1');
  assert.equal(generationOfPermitFormVersion('HOT_WORK_V2'), 'V2');
  assert.equal(generationOfJsaFormVersion('JSA_V1'), 'V1');
  assert.equal(generationOfJsaFormVersion('JSA_V2'), 'V2');
});

test('an unrecognised or absent version is REFUSED, never quietly treated as V1', () => {
  // Falling back to V1 would mean a row with a corrupt version silently
  // accepted client-supplied safety labels again.
  assert.equal(generationOfPermitFormVersion('WTG_WORK_V9'), null);
  assert.equal(generationOfPermitFormVersion(''), null);
  assert.equal(generationOfPermitFormVersion(null), null);
  assert.equal(generationOfJsaFormVersion('JSA_V9'), null);

  const result = parsePermitFormForVersion('WTG_WORK', 'WTG_WORK_V9', V1_WTG);
  assert.equal(result.ok, false, 'an unknown version must not parse as anything');
});

test('the STORED version decides the contract - a V1 payload is rejected under a V2 row', () => {
  assert.ok(parsePermitFormForVersion('WTG_WORK', 'WTG_WORK_V1', V1_WTG).ok, 'V1 row reads V1 payload');
  assert.equal(
    parsePermitFormForVersion('WTG_WORK', 'WTG_WORK_V2', V1_WTG).ok,
    false,
    'a V2 row must not accept the old client-labelled shape',
  );
});

test('a V2 payload is rejected under a V1 row', () => {
  const v2 = {
    permitIssue: {
      windFarmName: 'Zephyr',
      wtgNumber: 'WTG-1',
      descriptionOfWork: 'Work',
      permitStartAt: '2026-01-01T08:00:00.000Z',
      permitExpiryAt: '2026-01-01T16:00:00.000Z',
    },
    sections: {},
    isolationPoints: {},
    ppe: {},
  };
  assert.equal(parsePermitFormForVersion('WTG_WORK', 'WTG_WORK_V1', v2).ok, false);
});

test('the JSA follows the generation it is given', () => {
  assert.ok(parseJsaFormForVersion('V1', V1_JSA).ok);
  assert.equal(parseJsaFormForVersion('V2', V1_JSA).ok, false, 'V2 must not accept the V1 JSA shape');
});

test('the relational projection is derived correctly in BOTH generations', () => {
  const v1 = derivePermitProjectionForVersion('WTG_WORK', 'V1', V1_WTG as never);
  assert.deepEqual(v1, {
    windFarm: 'Zephyr',
    wtgNumber: 'WTG-1',
    workDescription: 'Work',
    lotoNumber: null,
  });

  const v2Form = {
    permitIssue: {
      windFarmName: 'Zephyr V2',
      wtgNumber: 'WTG-9',
      descriptionOfWork: 'Gearbox',
      permitStartAt: '2026-01-01T08:00:00.000Z',
      permitExpiryAt: '2026-01-01T16:00:00.000Z',
    },
  };
  const v2 = derivePermitProjectionForVersion('WTG_WORK', 'V2', v2Form as never);
  assert.deepEqual(v2, {
    windFarm: 'Zephyr V2',
    wtgNumber: 'WTG-9',
    workDescription: 'Gearbox',
    lotoNumber: null,
  });

  // A non-WTG template projects its LOTO number and nothing else.
  const cold = derivePermitProjectionForVersion('COLD_WORK', 'V2', { lotoNumber: 'LOTO-3' } as never);
  assert.deepEqual(cold, { windFarm: null, wtgNumber: null, workDescription: null, lotoNumber: 'LOTO-3' });
});

test('the JSA projection reads page 1 in both generations', () => {
  assert.deepEqual(deriveJsaProjectionForVersion('V1', V1_JSA), {
    siteOrWtg: 'WTG-1',
    jobDescription: 'Work',
  });
  assert.deepEqual(
    deriveJsaProjectionForVersion('V2', { page1: { siteOrWtg: 'WTG-2', jobOrWork: 'Inspect' } }),
    { siteOrWtg: 'WTG-2', jobDescription: 'Inspect' },
  );
});
