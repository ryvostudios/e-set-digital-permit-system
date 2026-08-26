/**
 * Shared, deliberately COMPLETE and VALID form fixtures for the permit
 * and JSA schemas, reused by every test that needs a realistic payload
 * (schema tests, service tests, document/snapshot/PDF tests).
 *
 * Named `*.test.ts` so the build excludes it exactly like every other
 * test file; it declares no tests of its own.
 */
import type {
  ColdWorkForm,
  ConfinedSpaceEntryForm,
  HotWorkForm,
  JsaForm,
  WtgWorkForm,
} from './forms.js';
import type { SnapshotSignature, SnapshotSignatureSet } from './signatures.js';
import type { JsaRow, PermitRow } from './service.js';

export function makeWtgWorkForm(overrides: Partial<WtgWorkForm> = {}): WtgWorkForm {
  return {
    windFarm: 'Jhimpir Wind Farm',
    wtgNumber: 'WTG-07',
    descriptionOfWork: 'Replace yaw motor and inspect the yaw ring.',
    permitStartAt: '2026-01-01T06:00:00.000Z',
    permitExpiryAt: '2026-01-01T18:00:00.000Z',
    generalWork: [{ label: 'Area barricaded', response: 'YES' }],
    electricalWork: [{ label: 'Circuit isolated', response: 'YES', remarks: 'Isolated at the base switchgear' }],
    mechanicalWork: [{ label: 'Rotor locked', response: 'YES' }],
    hydraulicWork: [{ label: 'Accumulator depressurized', response: 'NA' }],
    workAtHeights: [{ label: 'Fall arrest inspected', response: 'YES' }],
    specificSafetyRequirements: [{ label: 'Rescue plan briefed', response: 'YES' }],
    isolationPoints: [{ description: 'Main breaker Q1', remarks: 'Locked and tagged' }],
    ppe: [
      { label: 'Helmet', selected: true },
      { label: 'Harness', selected: true },
    ],
    specialPrecautions: 'No work above other crews.',
    specialInstructions: 'Report to CRO before and after entry.',
    ...overrides,
  };
}

export function makeColdWorkForm(overrides: Partial<ColdWorkForm> = {}): ColdWorkForm {
  return {
    natureOfWork: {
      mechanical: true,
      electricalAndInstrumentation: false,
      civil: false,
      chemical: false,
      inspection: true,
    },
    hazards: { energized: false, fall: true, respiratory: false, chemical: false },
    generalRequirements: [{ label: 'Work area inspected', response: 'YES' }],
    equipmentCondition: [{ label: 'Tools inspected', response: 'YES' }],
    ppe: [{ label: 'Gloves', selected: true }],
    specialPrecautions: 'Keep walkway clear.',
    specialInstructions: 'Two-person rule applies.',
    confinedSpacePermitRef: 'CSE-2026-004',
    lotoNumber: 'LOTO-8891',
    ...overrides,
  };
}

export function makeHotWorkForm(overrides: Partial<HotWorkForm> = {}): HotWorkForm {
  return {
    natureOfWork: [{ label: 'Welding', selected: true }],
    typeOfHazard: [{ label: 'Flammable material nearby', selected: true, remarks: 'Cleared to 10 m' }],
    generalRequirements: [{ label: 'Fire extinguisher present', response: 'YES' }],
    equipmentCondition: [{ label: 'Welding leads inspected', response: 'YES' }],
    ppe: [{ label: 'Welding shield', selected: true }],
    fireWatch: { required: true, attendant: 'Site fire watch on duty', remarks: '30 minutes after completion' },
    relatedPermitRef: 'CW-2026-011',
    lotoNumber: 'LOTO-8892',
    specialPrecautions: 'Fire blanket in place.',
    specialInstructions: 'Stop work if wind exceeds limits.',
    evacuationDetails: 'Muster at the north gate.',
    remarks: 'Nacelle hatch kept open.',
    ...overrides,
  };
}

export function makeConfinedSpaceEntryForm(
  overrides: Partial<ConfinedSpaceEntryForm> = {},
): ConfinedSpaceEntryForm {
  return {
    natureOfWork: [{ label: 'Internal inspection', selected: true }],
    typeOfHazard: [{ label: 'Oxygen deficiency', selected: true }],
    gasTest: {
      instrument: 'MSA Altair 4XR',
      instrumentCalibration: 'Calibrated 2025-12-20',
      retestRequired: true,
      retestDetails: 'Retest every 2 hours',
      continuousMonitoring: true,
      readings: [
        { time: '2026-01-01T06:00:00.000Z', oxygenPercent: 20.9, result: 'PASS', testedBy: 'Gas tester on duty' },
        { time: '2026-01-01T08:00:00.000Z', oxygenPercent: 20.8, result: 'PASS' },
      ],
    },
    generalRequirements: [{ label: 'Entry log maintained', response: 'YES' }],
    ppe: [{ label: 'Full body harness', selected: true }],
    attendant: 'Standby attendant at the manhole',
    relatedColdWorkPermitRef: 'CW-2026-012',
    relatedHotWorkPermitRef: 'HW-2026-003',
    lotoNumber: 'LOTO-8893',
    specialPrecautions: 'No hot work while entry is open.',
    specialInstructions: 'Communications check every 15 minutes.',
    evacuationDetails: 'Tripod rescue rigged at the entry point.',
    remarks: 'Entry limited to two persons.',
    ...overrides,
  };
}

export function makeJsaForm(overrides: Partial<JsaForm> = {}): JsaForm {
  return {
    page1: {
      siteOrWtg: 'WTG-07',
      jobOrWork: 'Yaw motor replacement',
      requiredPermits: { wtgWork: true, coldWork: false, hotWork: false, confinedSpaceEntry: false },
      hseChecklistGroups: [
        { title: 'Access', items: [{ label: 'Ladder inspected', response: 'YES' }] },
        { title: 'Environment', items: [{ label: 'Wind speed within limits', response: 'YES' }] },
      ],
    },
    page2: {
      emergencyResponse: 'Call the site emergency number and initiate tower rescue.',
      taskAnalysis: [
        {
          sequenceOfTasks: 'Isolate and lock out the yaw drive',
          possibleHazardousEvents: 'Unexpected yaw movement',
          energyOrTriggeringSources: 'Stored electrical energy',
          protectiveActionsOrMeasures: 'LOTO applied and verified',
        },
        {
          sequenceOfTasks: 'Remove the yaw motor',
          possibleHazardousEvents: 'Dropped object',
          energyOrTriggeringSources: 'Gravity',
          protectiveActionsOrMeasures: 'Tool tethering and exclusion zone',
        },
      ],
      ppe: [{ label: 'Helmet', selected: true }],
      toolsAndMaterials: [{ description: 'Torque wrench', remarks: 'Calibrated' }],
      participants: [{ name: 'Technician A', company: 'ESET' }],
      participantAcknowledgements: [{ name: 'Technician A', acknowledged: true }],
      comments: 'Weather window confirmed with CRO.',
      closeOut: { completedAt: '2026-01-01T17:00:00.000Z', remarks: 'Area cleared and handed back.' },
    },
    ...overrides,
  };
}

export function makeSignature(overrides: Partial<SnapshotSignature> = {}): SnapshotSignature {
  return {
    role: 'APPLICANT',
    userId: 'applicant-1',
    displayName: 'Ayesha Khan',
    designation: 'Technician, Maintenance Team A',
    teamName: 'Maintenance Team A',
    positionName: 'Technician',
    teamPositionId: 'tp-1',
    signedAt: '2026-01-01T08:00:00.000Z',
    sourceEventId: 'event-submitted',
    ...overrides,
  };
}

export function makeSignatureSet(overrides: Partial<SnapshotSignatureSet> = {}): SnapshotSignatureSet {
  return {
    applicant: makeSignature(),
    cro: makeSignature({
      role: 'CRO',
      userId: 'cro-1',
      displayName: 'Bilal Ahmed',
      designation: 'Control Room Operator, Operations',
      teamName: 'Operations',
      positionName: 'Control Room Operator',
      teamPositionId: 'tp-2',
      signedAt: '2026-01-01T08:30:00.000Z',
      sourceEventId: 'event-forwarded',
    }),
    hse: makeSignature({
      role: 'HSE',
      userId: 'hse-1',
      displayName: 'Cara Noor',
      designation: 'HSE Officer, HSE',
      teamName: 'HSE',
      positionName: 'HSE Officer',
      teamPositionId: 'tp-3',
      signedAt: '2026-01-01T09:00:00.000Z',
      sourceEventId: 'event-1',
    }),
    croFallback: null,
    renewal: null,
    ...overrides,
  };
}

/** Permit-row form columns for an already-completed WTG_WORK permit. */
export function makePermitFormColumns(): Pick<
  PermitRow,
  'permit_type' | 'form_version' | 'form_payload' | 'wind_farm' | 'wtg_number' | 'work_description' | 'loto_number'
> {
  const form = makeWtgWorkForm();
  return {
    permit_type: 'WTG_WORK',
    form_version: 'WTG_WORK_V1',
    form_payload: form,
    wind_farm: form.windFarm,
    wtg_number: form.wtgNumber,
    work_description: form.descriptionOfWork,
    loto_number: null,
  };
}

/** JSA-row form columns for an already-completed JSA. */
export function makeJsaFormColumns(): Pick<
  JsaRow,
  'form_version' | 'form_payload' | 'site_or_wtg' | 'job_description'
> {
  const form = makeJsaForm();
  return {
    form_version: 'JSA_V1',
    form_payload: form,
    site_or_wtg: form.page1.siteOrWtg,
    job_description: form.page1.jobOrWork,
  };
}
