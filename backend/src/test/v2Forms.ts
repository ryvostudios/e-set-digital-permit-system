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
} from '../domain/permits/catalogue.js';

/**
 * Authoritative (V2) form payloads for tests, DERIVED FROM THE CATALOGUE.
 *
 * Nothing here lists question ids by hand: every answer is generated from
 * the same catalogue the schemas and the printed forms come from, so a
 * fixture can never drift from the contract it is meant to satisfy. If a
 * question is added to a form, these payloads answer it automatically.
 *
 * `answeredWtgPermitV2` / `answeredJsaV2` are COMPLETE - they satisfy
 * submission. `blankWtgPermitV2` / `blankJsaV2` leave every printed
 * question unanswered (`null`), which is what a fresh draft looks like
 * and what a submission must be refused for.
 */

const unanswered = (section: ChecklistSection): Record<string, unknown> =>
  Object.fromEntries(section.items.map((item) => [item.id, { response: null }]));

const answered = (section: ChecklistSection, response: string): Record<string, unknown> =>
  Object.fromEntries(section.items.map((item) => [item.id, { response }]));

const ticks = (section: SelectionSection): Record<string, boolean> =>
  Object.fromEntries(section.options.map((option) => [option.id, false]));

/** The identifying header of a WTG permit - the part that projects into columns. */
export interface WtgPermitIssueOverrides {
  windFarmName?: string;
  wtgNumber?: string;
  descriptionOfWork?: string;
}

function wtgBase(overrides: WtgPermitIssueOverrides = {}): Record<string, unknown> {
  return {
    permitIssue: {
      windFarmName: 'Zephyr',
      wtgNumber: 'WTG-1',
      descriptionOfWork: 'Work',
      permitStartAt: '2026-01-01T08:00:00.000Z',
      permitExpiryAt: '2026-01-01T16:00:00.000Z',
      ...overrides,
    },
    sections: Object.fromEntries(WTG_WORK_CHECKLIST_SECTIONS.map((s) => [s.id, unanswered(s)])),
    isolationPoints: unanswered(WTG_ISOLATION_POINTS),
    ppe: ticks(WTG_PPE_REQUIRED),
  };
}

/** A structurally complete WTG permit with every printed question still unanswered. */
export function blankWtgPermitV2(overrides: WtgPermitIssueOverrides = {}): Record<string, unknown> {
  return wtgBase(overrides);
}

/** A WTG permit whose every printed question carries a real answer. */
export function answeredWtgPermitV2(
  overrides: WtgPermitIssueOverrides = {},
  response = 'YES',
): Record<string, unknown> {
  return {
    ...wtgBase(overrides),
    sections: Object.fromEntries(WTG_WORK_CHECKLIST_SECTIONS.map((s) => [s.id, answered(s, response)])),
    // The isolation band prints Yes/No only - it has no N/A column.
    isolationPoints: answered(WTG_ISOLATION_POINTS, 'NO'),
  };
}

/** The shape tests read back from a JSA fixture. */
export interface JsaV2Fixture {
  page1: {
    siteOrWtg: string;
    jobOrWork: string;
    anyPermitsRequired: string | null;
    requiredPermits: Record<string, boolean>;
    hseChecklist: Record<string, Record<string, boolean>>;
  };
  page2: Record<string, unknown>;
}

function jsaBase(): JsaV2Fixture {
  return {
    page1: {
      siteOrWtg: 'WTG-1',
      jobOrWork: 'Work',
      anyPermitsRequired: null,
      requiredPermits: ticks(JSA_REQUIRED_PERMITS),
      hseChecklist: Object.fromEntries(JSA_HSE_CHECKLIST_CATEGORIES.map((c) => [c.id, ticks(c)])),
    },
    page2: {
      emergencyContacts: Object.fromEntries(JSA_EMERGENCY_CONTACTS.map((c) => [c.id, '0300-0000000'])),
      emergencyQuestions: Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((q) => [q.id, null])),
      taskAnalysis: [
        {
          sequenceOfTasks: 'Isolate',
          possibleHazardousEvents: 'Stored energy',
          energySources: ['E'],
          triggeringEventsToStopWork: 'Movement',
          protectiveActionsOrMeasures: 'LOTO',
        },
      ],
      ppe: ticks(JSA_PPE_REQUIRED),
      participants: [],
      approvals: Object.fromEntries(
        JSA_APPROVAL_SIGNATORIES.map((signatory) => [signatory.id, { closedOut: false }]),
      ),
    },
  };
}

/** A structurally complete JSA with its printed questions still unanswered. */
export function blankJsaV2(): JsaV2Fixture {
  return jsaBase();
}

/**
 * A JSA whose printed questions all carry an answer.
 *
 * The HSE checklist ticks stay as they are on purpose: an unticked HSE
 * box is a meaningful answer ("not applicable to this job"), not an
 * unanswered question, so completeness never demands them.
 */
export function answeredJsaV2(): JsaV2Fixture {
  const base = jsaBase();
  return {
    page1: { ...base.page1, anyPermitsRequired: 'YES' },
    page2: {
      ...base.page2,
      emergencyQuestions: Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((q) => [q.id, 'YES'])),
    },
  };
}


// ---------------------------------------------------------------------
// Blank and partial documents, for every permit type
// ---------------------------------------------------------------------

/**
 * What a genuinely untouched draft looks like: every printed question
 * unanswered, every tick false, every optional text omitted. Built from
 * the catalogue, so a form gaining a question stays covered.
 */
const blankSections = (sections: readonly ChecklistSection[]): Record<string, unknown> =>
  Object.fromEntries(sections.map((s) => [s.id, unanswered(s)]));

const blankTicks = (options: readonly { id: string }[]): Record<string, boolean> =>
  Object.fromEntries(options.map((o) => [o.id, false]));

export function blankPermitV2(permitType: 'WTG_WORK' | 'COLD_WORK' | 'HOT_WORK' | 'CONFINED_SPACE_ENTRY'): Record<string, unknown> {
  if (permitType === 'WTG_WORK') {
    return {
      // Genuinely untouched: the header is optional, so it is omitted
      // entirely rather than carrying placeholder values.
      permitIssue: {},
      sections: blankSections(WTG_WORK_CHECKLIST_SECTIONS),
      isolationPoints: unanswered(WTG_ISOLATION_POINTS),
      ppe: ticks(WTG_PPE_REQUIRED),
    };
  }
  const common = { workWindow: {}, evacuation: {} };
  if (permitType === 'COLD_WORK') {
    return {
      ...common,
      natureOfWork: blankTicks(COLD_WORK_NATURE_OF_WORK.options),
      typeOfHazard: blankTicks(COLD_WORK_TYPE_OF_HAZARD.options),
      sections: blankSections(COLD_WORK_CHECKLIST_SECTIONS),
    };
  }
  if (permitType === 'HOT_WORK') {
    return {
      ...common,
      natureOfWork: blankTicks(HOT_WORK_NATURE_OF_WORK.options),
      typeOfHazard: blankTicks(HOT_WORK_TYPE_OF_HAZARD.options),
      combustionSubTicks: blankTicks(HOT_WORK_COMBUSTION_SUB_TICKS),
      sections: blankSections(HOT_WORK_CHECKLIST_SECTIONS),
    };
  }
  return {
    ...common,
    natureOfWork: blankTicks(CONFINED_SPACE_NATURE_OF_WORK.options),
    typeOfHazard: blankTicks(CONFINED_SPACE_TYPE_OF_HAZARD.options),
    combustionSubTicks: blankTicks(CONFINED_SPACE_COMBUSTION_SUB_TICKS),
    sections: blankSections(CONFINED_SPACE_CHECKLIST_SECTIONS),
    gasTestRecord: Object.fromEntries(CONFINED_SPACE_GAS_TEST_TABLE.rows.map((row) => [row, {}])),
  };
}

/**
 * A realistically PARTIAL permit: the applicant described the job and
 * answered one question, and left everything else blank because it does
 * not apply. This is the shape the business requires to be submittable.
 */
export function partialPermitV2(permitType: 'WTG_WORK' | 'COLD_WORK' | 'HOT_WORK' | 'CONFINED_SPACE_ENTRY'): Record<string, unknown> {
  const blank = blankPermitV2(permitType);
  if (permitType === 'WTG_WORK') {
    const sections = blank.sections as Record<string, Record<string, { response: string | null }>>;
    const first = WTG_WORK_CHECKLIST_SECTIONS[0]!;
    sections[first.id]![first.items[0]!.id] = { response: 'NA' };
    return {
      ...blank,
      permitIssue: { ...(blank.permitIssue as Record<string, unknown>), descriptionOfWork: 'Gearbox inspection' },
    };
  }
  return { ...blank, workWindow: { area: 'Substation bay 3' } };
}

/** A JSA with nothing entered at all - every question null, every tick false. */
export function blankJsaFormV2(): JsaV2Fixture {
  const base = jsaBase();
  return {
    page1: { ...base.page1, siteOrWtg: '', jobOrWork: '' },
    page2: {
      ...base.page2,
      emergencyContacts: Object.fromEntries(JSA_EMERGENCY_CONTACTS.map((c) => [c.id, ''])),
      // One EMPTY row, exactly as the editor starts a blank JSA - the
      // printed table always has a first line.
      taskAnalysis: [{
        sequenceOfTasks: '', possibleHazardousEvents: '', energySources: [],
        triggeringEventsToStopWork: '', protectiveActionsOrMeasures: '',
      }],
    },
  };
}
