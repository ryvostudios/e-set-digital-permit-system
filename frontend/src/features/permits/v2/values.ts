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

/**
 * `null` means UNANSWERED, and it is not the same as `'NA'`.
 *
 * 'NA' is a judgement someone makes - "I considered this and it does not
 * apply". A blank draft that arrived pre-set to 'NA' would put a safety
 * judgement nobody made onto an issued permit, so a new form starts with
 * every response null and the server refuses the submission until a
 * person has answered each one.
 */
export type ChecklistAnswers = Record<string, { response: ChecklistResponse | null; remarks?: string }>;

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

/**
 * A band's starting state: every printed question present but UNANSWERED.
 * Never pre-set to 'NA', and never to 'NO' - both are answers, and the
 * applicant has not given one yet.
 */
function blankAnswers(section: ChecklistSectionDef): ChecklistAnswers {
  return Object.fromEntries(section.items.map((item) => [item.id, { response: null }]));
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
      anyPermitsRequired: null,
      requiredPermits: blankTicks(page1.requiredPermits),
      hseChecklist: Object.fromEntries(
        page1.hseChecklistCategories.map((category) => [category.id, blankTicks(category)]),
      ),
    },
    page2: {
      emergencyContacts: Object.fromEntries(page2.emergencyContacts.map((c) => [c.id, ''])),
      emergencyQuestions: Object.fromEntries(page2.emergencyQuestions.map((q) => [q.id, null])),
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

// =====================================================================
// HYDRATION - the single boundary between a STORED payload and a
// RENDERABLE one
// =====================================================================

/**
 * WHY THIS EXISTS.
 *
 * `emptyPermitValues`/`emptyJsaValues` above are structurally complete:
 * every collection the renderers walk is present. A STORED payload is
 * not. The V2 contract makes most printed fields optional (a blank draft
 * has to be saveable), so the server stores exactly what the applicant
 * had - and a key nobody touched is simply absent. Now that a partly
 * completed permit is a legitimate, saveable, submittable thing, those
 * gaps reach the browser routinely.
 *
 * Using `stored ?? empty...` therefore picks the WHOLE stored payload the
 * moment it is non-null, gaps and all, and the first renderer to reach
 * for a collection that is not there crashes the screen to blank.
 *
 * So the payload is hydrated ONCE, here, on the way in. Every renderer
 * downstream can then assume the structure the catalogue describes, and
 * no component needs its own `?? []` - a scattered fallback is a second
 * copy of the empty-form shape, and copies drift.
 *
 * WHAT HYDRATION MUST NEVER DO IS INVENT AN ANSWER. It supplies
 * STRUCTURE - the containers a form has - and never CONTENT. An
 * unanswered question stays null, a stored 'NO' stays 'NO', a stored
 * 'NA' stays 'NA', an empty string stays empty, and a collection the
 * applicant deliberately emptied stays empty. The completeness rule is
 * still entirely the server's.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A defensive deep copy, so nothing rendered aliases the stored payload. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const copy: PlainObject = {};
    for (const key of Object.keys(value)) copy[key] = cloneValue(value[key]);
    return copy;
  }
  return value;
}

/**
 * Merges one stored value onto its default.
 *
 * - `undefined` (the key was never stored) takes the default.
 * - Plain objects merge RECURSIVELY, key by key, so a partly stored
 *   section keeps what it has and gains only the containers it lacks.
 * - A stored array REPLACES the default array outright - including an
 *   explicitly empty one, which stays empty. Its entries are shaped
 *   against the default's first entry where there is one, so a
 *   half-written task-analysis row gains its missing `energySources`
 *   list rather than crashing the table that reads it.
 * - Anything else is a LEAF and is taken from storage exactly as it is:
 *   `null` (unanswered), `''`, `false`, 'YES'/'NO'/'NA', a number.
 * - Where storage holds a structure and the default holds a leaf-shaped
 *   value of a different kind, the DEFAULT's structure wins - that is
 *   the only case a stored value is dropped, and it is the case where
 *   keeping it would crash the renderer.
 */
function hydrateValue(defaults: unknown, stored: unknown): unknown {
  if (stored === undefined) return cloneValue(defaults);

  if (Array.isArray(defaults)) {
    if (!Array.isArray(stored)) return cloneValue(defaults);
    // The default's first entry is the row template; a default of `[]`
    // (participants) has none, so stored rows are taken as they are.
    const template = defaults.length > 0 ? defaults[0] : undefined;
    return stored.map((entry) => (template === undefined ? cloneValue(entry) : hydrateValue(template, entry)));
  }

  if (isPlainObject(defaults)) {
    if (!isPlainObject(stored)) return cloneValue(defaults);
    const merged: PlainObject = {};
    for (const key of Object.keys(defaults)) merged[key] = hydrateValue(defaults[key], stored[key]);
    // Keys the stored payload carries and the blank form does not - a
    // remark beside an answer, an `other` line, a question this build's
    // catalogue no longer lists. Kept: dropping them would silently
    // discard something a person wrote.
    for (const key of Object.keys(stored)) {
      if (!(key in defaults)) merged[key] = cloneValue(stored[key]);
    }
    return merged;
  }

  return cloneValue(stored);
}

/**
 * A stored permit payload, made renderable. `null` (never saved) and a
 * partial payload both come back structurally complete.
 */
export function hydratePermitValuesV2(
  permitType: PermitTypeKey,
  definition: PermitDefinition,
  stored: unknown,
): PermitValuesV2 {
  return hydrateValue(emptyPermitValues(permitType, definition), stored ?? undefined) as PermitValuesV2;
}

/** The same, for the two-page JSA. */
export function hydrateJsaValuesV2(catalogue: FormCatalogue, stored: unknown): JsaValuesV2 {
  return hydrateValue(emptyJsaValues(catalogue), stored ?? undefined) as JsaValuesV2;
}
