import type {
  ChecklistItem,
  ColdWorkForm,
  ConfinedSpaceEntryForm,
  HotWorkForm,
  JsaFormPayload,
  PermitFormPayload,
  PermitType,
  SelectionOption,
  WtgWorkForm,
} from '../../../api/types';

/**
 * The EMPTY starting shape for each form.
 *
 * These are blanks, not content. No checklist question, hazard, or PPE
 * option is pre-filled with invented wording - each required band starts
 * with one blank row for the person to transcribe the printed item into,
 * which is exactly how the backend models these sections. The only
 * pre-named entries anywhere are Cold Work's Nature of Work and Hazards,
 * whose option lists the real form supplied verbatim and which the
 * backend therefore models as fixed named booleans.
 */

const blankChecklistItem = (): ChecklistItem => ({ label: '', response: 'NA' });
const blankSelectionOption = (): SelectionOption => ({ label: '', selected: false });

function blankChecklist(): ChecklistItem[] {
  return [blankChecklistItem()];
}

function blankSelection(): SelectionOption[] {
  return [blankSelectionOption()];
}

function emptyWtgWorkForm(): WtgWorkForm {
  return {
    windFarm: '',
    wtgNumber: '',
    descriptionOfWork: '',
    permitStartAt: '',
    permitExpiryAt: '',
    generalWork: blankChecklist(),
    electricalWork: blankChecklist(),
    mechanicalWork: blankChecklist(),
    hydraulicWork: blankChecklist(),
    workAtHeights: blankChecklist(),
    specificSafetyRequirements: blankChecklist(),
    isolationPoints: [],
    ppe: blankSelection(),
  };
}

function emptyColdWorkForm(): ColdWorkForm {
  return {
    natureOfWork: {
      mechanical: false,
      electricalAndInstrumentation: false,
      civil: false,
      chemical: false,
      inspection: false,
    },
    hazards: { energized: false, fall: false, respiratory: false, chemical: false },
    generalRequirements: blankChecklist(),
    equipmentCondition: blankChecklist(),
    ppe: blankSelection(),
  };
}

function emptyHotWorkForm(): HotWorkForm {
  return {
    natureOfWork: blankSelection(),
    typeOfHazard: blankSelection(),
    generalRequirements: blankChecklist(),
    equipmentCondition: blankChecklist(),
    ppe: blankSelection(),
    fireWatch: { required: false },
  };
}

function emptyConfinedSpaceForm(): ConfinedSpaceEntryForm {
  return {
    natureOfWork: blankSelection(),
    typeOfHazard: blankSelection(),
    gasTest: {
      retestRequired: false,
      continuousMonitoring: false,
      readings: [{ time: '', oxygenPercent: 20.9, result: 'PASS' }],
    },
    generalRequirements: blankChecklist(),
    ppe: blankSelection(),
  };
}

export function emptyPermitForm(permitType: PermitType): PermitFormPayload {
  switch (permitType) {
    case 'WTG_WORK':
      return emptyWtgWorkForm();
    case 'COLD_WORK':
      return emptyColdWorkForm();
    case 'HOT_WORK':
      return emptyHotWorkForm();
    case 'CONFINED_SPACE_ENTRY':
      return emptyConfinedSpaceForm();
  }
}

export function emptyJsaForm(): JsaFormPayload {
  return {
    page1: {
      siteOrWtg: '',
      jobOrWork: '',
      requiredPermits: { wtgWork: false, coldWork: false, hotWork: false, confinedSpaceEntry: false },
      hseChecklistGroups: [{ title: '', items: blankChecklist() }],
    },
    page2: {
      taskAnalysis: [
        {
          sequenceOfTasks: '',
          possibleHazardousEvents: '',
          energyOrTriggeringSources: '',
          protectiveActionsOrMeasures: '',
        },
      ],
      ppe: blankSelection(),
      toolsAndMaterials: [],
      participants: [],
      participantAcknowledgements: [],
    },
  };
}

/**
 * Strips values the backend's strict schemas would reject - an optional
 * string is either genuinely present or absent, never an empty string
 * (`optionalText` requires at least one character once supplied).
 *
 * This is a shape fix, not validation: the backend remains the authority
 * on whether the content is acceptable, and its rejection is what the
 * person is shown.
 */
export function pruneEmptyStrings<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneEmptyStrings(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed !== '') result[key] = trimmed;
        continue;
      }
      result[key] = pruneEmptyStrings(entry);
    }
    return result as T;
  }
  return value;
}
