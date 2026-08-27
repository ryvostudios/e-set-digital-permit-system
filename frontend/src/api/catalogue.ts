import { apiRequest } from './client';

/**
 * The authoritative form DEFINITION, fetched from the backend.
 *
 * THE WORDING LIVES ON THE SERVER, NOT HERE. Every printed question,
 * option, hazard and PPE choice comes from `GET /permits/catalogue`,
 * which projects the one transcription of the operational forms. No
 * safety wording is written into these types or into any component that
 * consumes them - a renderer only knows there is "a section with a title
 * and items", never what the items say. That is what keeps the editor,
 * the read-only document and (later) the PDF from drifting apart.
 */

export type ResponseDomain = 'YES_NO_NA' | 'YES_NO';

export interface CatalogueItem {
  id: string;
  label: string;
}

export interface ChecklistSectionDef {
  id: string;
  title: string;
  printedNumber: string | null;
  responses: ResponseDomain;
  items: CatalogueItem[];
}

export interface SelectionSectionDef {
  id: string;
  title: string;
  printedNumber: string | null;
  hasOther: boolean;
  options: CatalogueItem[];
}

export interface AuthorizationBandDef {
  id: string;
  statement: string;
  signatories: CatalogueItem[];
}

export interface PermitDefinition {
  formVersion: string;
  title: string;
  formReference: string | null;
  checklistSections: ChecklistSectionDef[];
  /** WTG only. */
  isolationPoints?: ChecklistSectionDef;
  /** WTG only - the icon band. */
  ppe?: SelectionSectionDef;
  /** 008A/B/C only. */
  natureOfWork?: SelectionSectionDef;
  typeOfHazard?: SelectionSectionDef;
  combustionSubTicks?: CatalogueItem[] | null;
  /** Confined Space only. */
  gasTestRecord?: { columns: CatalogueItem[]; rows: string[] };
  authorizationBands: CatalogueItem[] | AuthorizationBandDef[];
  slogan: string | null;
  distributionFooter: string;
}

export interface JsaDefinition {
  formVersion: string;
  formReference: string;
  page1: {
    pageLabel: string;
    requiredPermits: SelectionSectionDef;
    hseChecklistInstruction: string;
    hseChecklistCategories: SelectionSectionDef[];
    reminder: string;
  };
  page2: {
    pageLabel: string;
    emergencyContacts: CatalogueItem[];
    emergencyQuestions: CatalogueItem[];
    taskAnalysisColumns: CatalogueItem[];
    energySourceLegend: { code: string; label: string }[];
    ppe: SelectionSectionDef;
    participantSignatureNote: string;
    approvalSignatories: CatalogueItem[];
    approvalNote: string;
    closeOutNote: string;
  };
}

export type PermitTypeKey = 'WTG_WORK' | 'COLD_WORK' | 'HOT_WORK' | 'CONFINED_SPACE_ENTRY';

export interface FormCatalogue {
  permits: Record<PermitTypeKey, PermitDefinition>;
  jsa: JsaDefinition;
}

/** Narrows an authorization band list to the 008A/B/C statement shape. */
export function isStatementBands(
  bands: CatalogueItem[] | AuthorizationBandDef[],
): bands is AuthorizationBandDef[] {
  return bands.length > 0 && 'statement' in bands[0]!;
}

/** GET /api/v1/permits/catalogue */
export function getFormCatalogue(signal?: AbortSignal): Promise<FormCatalogue> {
  return apiRequest('/permits/catalogue', { ...(signal ? { signal } : {}) });
}
