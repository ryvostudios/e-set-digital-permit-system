import type {
  ChecklistSectionDef,
  FormCatalogue,
  PermitDefinition,
  PermitTypeKey,
  SelectionSectionDef,
} from '../../../api/catalogue';

/**
 * The V2 payload shapes, mirroring the server contract exactly: answers
 * are keyed by the catalogue's stable item ids, and no printed wording is
 * ever part of a value. A payload built here is the same shape the
 * backend's `formsV2.ts` schemas accept.
 */

export type ChecklistResponse = 'YES' | 'NO' | 'NA';

export type ChecklistAnswers = Record<string, { response: ChecklistResponse; remarks?: string }>;

/** A tick band: one boolean per printed option, plus the free-text Other line where the form prints one. */
export type SelectionValues = Record<string, boolean | string | undefined>;

export interface TaskAnalysisRow {
  sequenceOfTasks: string;
  possibleHazardousEvents: string;
  energySources: string[];
  triggeringEventsToStopWork: string;
  protectiveActionsOrMeasures: string;
}

export interface ParticipantRow {
  nameAndPosition: string;
  company?: string;
  acknowledged: boolean;
}

export type PermitValuesV2 = Record<string, unknown>;
export type JsaValuesV2 = { page1: Record<string, unknown>; page2: Record<string, unknown> };

/** A band's default answer. `NA` where the form prints that column, `NO` where it does not. */
function blankAnswers(section: ChecklistSectionDef): ChecklistAnswers {
  const response: ChecklistResponse = section.responses === 'YES_NO_NA' ? 'NA' : 'NO';
  return Object.fromEntries(section.items.map((item) => [item.id, { response }]));
}

function blankTicks(section: SelectionSectionDef): SelectionValues {
  return Object.fromEntries(section.options.map((option) => [option.id, false]));
}

export function emptyTaskAnalysisRow(): TaskAnalysisRow {
  return {
    sequenceOfTasks: '',
    possibleHazardousEvents: '',
    energySources: [],
    triggeringEventsToStopWork: '',
    protectiveActionsOrMeasures: '',
  };
}

/**
 * A blank but STRUCTURALLY COMPLETE permit payload: every printed
 * question already present and answerable, because the server requires
 * every catalogue key and would reject a part-shaped payload.
 */
export function emptyPermitValues(permitType: PermitTypeKey, definition: PermitDefinition): PermitValuesV2 {
  const sections = Object.fromEntries(
    definition.checklistSections.map((section) => [section.id, blankAnswers(section)]),
  );

  if (permitType === 'WTG_WORK') {
    return {
      permitIssue: {
        windFarmName: '',
        wtgNumber: '',
        descriptionOfWork: '',
        permitStartAt: '',
        permitExpiryAt: '',
      },
      sections,
      isolationPoints: definition.isolationPoints ? blankAnswers(definition.isolationPoints) : {},
      ppe: definition.ppe ? blankTicks(definition.ppe) : {},
    };
  }

  const base: PermitValuesV2 = {
    workWindow: { equipment: '', area: '', fromHours: '', toHours: '', extendedTo: '' },
    natureOfWork: definition.natureOfWork ? blankTicks(definition.natureOfWork) : {},
    typeOfHazard: definition.typeOfHazard ? blankTicks(definition.typeOfHazard) : {},
    sections,
    specialPrecautions: '',
    specialInstructions: '',
    lotoNumber: '',
    evacuation: { completedRemarks: '', acknowledgedAtHours: '', acknowledgedRemarks: '' },
  };

  if (definition.combustionSubTicks) {
    base.combustionSubTicks = Object.fromEntries(
      definition.combustionSubTicks.map((tick) => [tick.id, false]),
    );
  }
  if (permitType === 'COLD_WORK') base.confinedSpacePermitRef = '';
  if (permitType === 'HOT_WORK') {
    base.fireWatch = '';
    base.confinedSpacePermitRef = '';
  }
  if (permitType === 'CONFINED_SPACE_ENTRY') {
    base.attendant = '';
    base.relatedPermitRef = '';
    base.gasTestRecord = Object.fromEntries(
      (definition.gasTestRecord?.rows ?? []).map((row) => [row, { oxygenAndTime: '', testedBy: '' }]),
    );
  }
  return base;
}

/** The same, for the two-page JSA. */
export function emptyJsaValues(catalogue: FormCatalogue): JsaValuesV2 {
  const { page1, page2 } = catalogue.jsa;
  return {
    page1: {
      siteOrWtg: '',
      dateTime: '',
      serialNo: '',
      jobOrWork: '',
      anyPermitsRequired: 'NO',
      requiredPermits: blankTicks(page1.requiredPermits),
      hseChecklist: Object.fromEntries(
        page1.hseChecklistCategories.map((category) => [category.id, blankTicks(category)]),
      ),
    },
    page2: {
      emergencyContacts: Object.fromEntries(page2.emergencyContacts.map((c) => [c.id, ''])),
      emergencyQuestions: Object.fromEntries(page2.emergencyQuestions.map((q) => [q.id, 'NO'])),
      taskAnalysis: [emptyTaskAnalysisRow()],
      ppe: blankTicks(page2.ppe),
      toolsAndMaterials: '',
      participants: [],
      approvals: Object.fromEntries(
        page2.approvalSignatories.map((s) => [s.id, { nameAndPosition: '', contactNumber: '', closedOut: false }]),
      ),
      comments: '',
    },
  };
}
