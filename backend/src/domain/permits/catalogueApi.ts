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
  JSA_APPROVAL_NOTE,
  JSA_APPROVAL_SIGNATORIES,
  JSA_CLOSE_OUT_NOTE,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_ENERGY_SOURCE_LEGEND,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_HSE_CHECKLIST_INSTRUCTION,
  JSA_PAGE1_REMINDER,
  JSA_PARTICIPANT_SIGNATURE_NOTE,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  JSA_TASK_ANALYSIS_COLUMNS,
  PERMIT_008_AUTHORIZATION_BANDS,
  PERMIT_DISTRIBUTION_FOOTER,
  WTG_AUTHORIZATION_BANDS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';
import { JSA_FORM_VERSION_V2, PERMIT_FORM_VERSIONS_V2 } from './formsV2.js';

/**
 * The form DEFINITION served to the browser so it can render the
 * authoritative permit and JSA documents.
 *
 * This is a projection of `catalogue.ts` - it re-states no wording of its
 * own. That is deliberate: the editor, the read-only renderer and the PDF
 * must all draw from the one transcription, so a question cannot read one
 * way on screen and another on the issued document.
 *
 * WHAT THIS DELIBERATELY DOES NOT CONTAIN. Nothing about a person, a
 * permit, a company or an authorization decision. It is static printed
 * form text plus stable keys - the same for every caller, identical on
 * every request, and derivable from the paper forms anyone on site
 * already holds. It carries no secret, no database detail, and no
 * authorization internals, so serving it reveals nothing that reading the
 * printed pad would not. Authentication is still required, because an
 * unauthenticated caller has no business enumerating anything.
 */

export interface CatalogueItemDto {
  id: string;
  label: string;
}

export interface ChecklistSectionDto {
  id: string;
  title: string;
  printedNumber: string | null;
  /** 'YES_NO_NA' where the printed band has an N/A column; 'YES_NO' where it does not. */
  responses: 'YES_NO_NA' | 'YES_NO';
  items: CatalogueItemDto[];
}

export interface SelectionSectionDto {
  id: string;
  title: string;
  printedNumber: string | null;
  hasOther: boolean;
  options: CatalogueItemDto[];
}

const toChecklistDto = (section: ChecklistSection): ChecklistSectionDto => ({
  id: section.id,
  title: section.title,
  printedNumber: section.printedNumber ?? null,
  responses: section.responses,
  items: section.items.map((item) => ({ id: item.id, label: item.label })),
});

const toSelectionDto = (section: SelectionSection): SelectionSectionDto => ({
  id: section.id,
  title: section.title,
  printedNumber: section.printedNumber ?? null,
  hasOther: section.hasOther,
  options: section.options.map((option) => ({ id: option.id, label: option.label })),
});

const toItems = (items: readonly { id: string; label: string }[]): CatalogueItemDto[] =>
  items.map((item) => ({ id: item.id, label: item.label }));

/** Builds the whole definition. Pure - no database, no request state, no identity. */
export function buildFormCatalogue() {
  return {
    permits: {
      WTG_WORK: {
        formVersion: PERMIT_FORM_VERSIONS_V2.WTG_WORK,
        title: 'PERMIT TO WORK ON WTG',
        formReference: null,
        checklistSections: WTG_WORK_CHECKLIST_SECTIONS.map(toChecklistDto),
        isolationPoints: toChecklistDto(WTG_ISOLATION_POINTS),
        ppe: toSelectionDto(WTG_PPE_REQUIRED),
        authorizationBands: toItems(WTG_AUTHORIZATION_BANDS),
        slogan: null,
        distributionFooter: PERMIT_DISTRIBUTION_FOOTER,
      },
      COLD_WORK: {
        formVersion: PERMIT_FORM_VERSIONS_V2.COLD_WORK,
        title: 'COLD WORK PERMIT',
        formReference: FORM_REFERENCES.COLD_WORK,
        natureOfWork: toSelectionDto(COLD_WORK_NATURE_OF_WORK),
        typeOfHazard: toSelectionDto(COLD_WORK_TYPE_OF_HAZARD),
        combustionSubTicks: null,
        checklistSections: COLD_WORK_CHECKLIST_SECTIONS.map(toChecklistDto),
        authorizationBands: PERMIT_008_AUTHORIZATION_BANDS.map((band) => ({
          id: band.id,
          statement: band.statement,
          signatories: toItems(band.signatories),
        })),
        slogan: COLD_WORK_SLOGAN,
        distributionFooter: PERMIT_DISTRIBUTION_FOOTER,
      },
      HOT_WORK: {
        formVersion: PERMIT_FORM_VERSIONS_V2.HOT_WORK,
        title: 'HOT WORK PERMIT',
        formReference: FORM_REFERENCES.HOT_WORK,
        natureOfWork: toSelectionDto(HOT_WORK_NATURE_OF_WORK),
        typeOfHazard: toSelectionDto(HOT_WORK_TYPE_OF_HAZARD),
        combustionSubTicks: toItems(HOT_WORK_COMBUSTION_SUB_TICKS),
        checklistSections: HOT_WORK_CHECKLIST_SECTIONS.map(toChecklistDto),
        authorizationBands: PERMIT_008_AUTHORIZATION_BANDS.map((band) => ({
          id: band.id,
          statement: band.statement,
          signatories: toItems(band.signatories),
        })),
        slogan: HOT_WORK_SLOGAN,
        distributionFooter: PERMIT_DISTRIBUTION_FOOTER,
      },
      CONFINED_SPACE_ENTRY: {
        formVersion: PERMIT_FORM_VERSIONS_V2.CONFINED_SPACE_ENTRY,
        title: 'CONFINED SPACE ENTRY PERMIT',
        formReference: FORM_REFERENCES.CONFINED_SPACE_ENTRY,
        natureOfWork: toSelectionDto(CONFINED_SPACE_NATURE_OF_WORK),
        typeOfHazard: toSelectionDto(CONFINED_SPACE_TYPE_OF_HAZARD),
        combustionSubTicks: toItems(CONFINED_SPACE_COMBUSTION_SUB_TICKS),
        checklistSections: CONFINED_SPACE_CHECKLIST_SECTIONS.map(toChecklistDto),
        gasTestRecord: {
          columns: toItems(CONFINED_SPACE_GAS_TEST_TABLE.columns),
          rows: [...CONFINED_SPACE_GAS_TEST_TABLE.rows],
        },
        authorizationBands: PERMIT_008_AUTHORIZATION_BANDS.map((band) => ({
          id: band.id,
          statement: band.statement,
          signatories: toItems(band.signatories),
        })),
        slogan: CONFINED_SPACE_SLOGAN,
        distributionFooter: PERMIT_DISTRIBUTION_FOOTER,
      },
    },
    jsa: {
      formVersion: JSA_FORM_VERSION_V2,
      formReference: FORM_REFERENCES.JSA,
      /** The two printed pages stay structurally separate, exactly as the form prints them. */
      page1: {
        pageLabel: 'PAGE 1 OF 2',
        requiredPermits: toSelectionDto(JSA_REQUIRED_PERMITS),
        hseChecklistInstruction: JSA_HSE_CHECKLIST_INSTRUCTION,
        hseChecklistCategories: JSA_HSE_CHECKLIST_CATEGORIES.map(toSelectionDto),
        reminder: JSA_PAGE1_REMINDER,
      },
      page2: {
        pageLabel: 'PAGE 2 OF 2',
        emergencyContacts: toItems(JSA_EMERGENCY_CONTACTS),
        emergencyQuestions: toItems(JSA_EMERGENCY_QUESTIONS),
        taskAnalysisColumns: toItems(JSA_TASK_ANALYSIS_COLUMNS),
        energySourceLegend: JSA_ENERGY_SOURCE_LEGEND.map((entry) => ({
          code: entry.code,
          label: entry.label,
        })),
        ppe: toSelectionDto(JSA_PPE_REQUIRED),
        participantSignatureNote: JSA_PARTICIPANT_SIGNATURE_NOTE,
        approvalSignatories: toItems(JSA_APPROVAL_SIGNATORIES),
        approvalNote: JSA_APPROVAL_NOTE,
        closeOutNote: JSA_CLOSE_OUT_NOTE,
      },
    },
  };
}

export type FormCatalogueDto = ReturnType<typeof buildFormCatalogue>;
