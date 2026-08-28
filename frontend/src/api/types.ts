/**
 * Response shapes, transcribed from the backend source that produces
 * them. Each block names the module it mirrors so a future contract
 * change has one obvious place to be reflected.
 *
 * These are DESCRIPTIONS of what the server sends, never a second copy
 * of its rules. Nothing here decides authorization, validity, or which
 * actions are possible - the backend answers all three, and the fields
 * below simply carry those answers.
 */

// ---------------------------------------------------------------------
// Identity - backend/src/routes/auth.ts (GET /auth/me)
// ---------------------------------------------------------------------

export type PrivilegedRole = 'CEO' | 'SITE_MANAGER';

/**
 * A NORMAL employee's organizational identity: exactly one Company, one
 * Team and one Position. Null for a privileged system account, which has
 * none of the three - see `privilegedDisplayName`.
 */
export interface WorkforceProfile {
  displayName: string;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
}

export interface CurrentUser {
  auth: { id: string; email: string | null };
  accessState: 'ACTIVE';
  mustChangePassword: boolean;
  profile: WorkforceProfile | null;
  privilegedRoles: PrivilegedRole[];
  privilegedDisplayName: string | null;
  capabilities: string[];
}

// ---------------------------------------------------------------------
// Permits - backend/src/domain/permits/service.ts + routes/permits.ts
// ---------------------------------------------------------------------

export const PERMIT_TYPES = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];

export const PERMIT_STATUSES = [
  'DRAFT',
  'PENDING_CRO',
  'PENDING_HSE',
  'PENDING_CORRECTION',
  'ISSUED',
  'HELD',
  'CANCELLED',
  'CLOSED',
] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];

/** The display-only action hints `computeAvailableActions` returns. Never an authorization decision. */
export type AvailableAction =
  | 'update'
  | 'submit'
  | 'resubmit'
  | 'send_back'
  | 'forward_hse'
  | 'hse_approve'
  | 'hse_send_back'
  | 'fallback_approve'
  | 'hold'
  | 'resume'
  | 'cancel'
  | 'close'
  | 'renew';

/** The list/summary projection - identical to the detail row minus `form_payload`. */
export interface PermitSummary {
  id: string;
  /**
   * The authoritative permit number within its type's series - NULL while
   * the permit is a DRAFT. The database issues it on the first successful
   * submission and it is permanent thereafter.
   */
  permit_sequence: string | null;
  /**
   * That number as people read it: `HW-12`, or `Not assigned` while the
   * permit is still a draft.
   *
   * FORMATTED BY THE SERVER, in one place, so a permit cannot be called
   * one thing on a list and another on its own document. Never build this
   * in the browser.
   */
  permitDisplayNumber: string;
  jsa_id: string;
  status: PermitStatus;
  version: number;
  created_by: string;
  previous_permit_id: string | null;
  site_timezone: string;
  company: string | null;
  company_other: string | null;
  /**
   * The SERVER-DERIVED applicant identity, frozen at submission
   * (migration 0024). The browser never supplies, edits, or reconstructs
   * any of these four fields.
   */
  applicant_identity_kind?: 'NORMAL' | 'PRIVILEGED' | null;
  applicant_display_name?: string | null;
  applicant_company_code?: 'E_SET' | 'ZPL' | 'SGRE' | null;
  applicant_company_name?: string | null;
  submitted_at: string | null;
  hse_review_started_at: string | null;
  hse_review_deadline_at: string | null;
  issued_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closure_remarks: string | null;
  held_by: string | null;
  held_at: string | null;
  hold_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  permit_type: PermitType | null;
  form_version: string | null;
  wind_farm: string | null;
  wtg_number: string | null;
  work_description: string | null;
  loto_number: string | null;
  created_at: string;
  updated_at: string;
}

export interface Permit extends PermitSummary {
  form_payload: PermitFormPayload | null;
}

export interface Jsa {
  id: string;
  jsa_sequence: string;
  jsaDisplayNumber: string;
  created_by: string;
  form_version: string | null;
  form_payload: JsaFormPayload | null;
  site_or_wtg: string | null;
  job_description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermitValidity {
  isValid: boolean;
  expiresAt: string;
}

export interface LifecycleEvent {
  id: string;
  ordinal: string;
  permit_id: string;
  event_type: string;
  actor_user_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  occurred_at: string;
}

export type SignatureRole = 'APPLICANT' | 'CRO' | 'HSE' | 'CRO_FALLBACK' | 'RENEWAL';

/** A frozen signature identity, copied at signing time - never re-resolved from a live profile. */
export interface PermitSignature {
  id: string;
  permit_id: string;
  source_event_id: string;
  signature_role: SignatureRole;
  signer_user_id: string;
  signer_display_name: string;
  signer_identity_kind?: 'NORMAL' | 'PRIVILEGED';
  signer_team_position_id: string | null;
  signer_team_name: string | null;
  signer_position_name: string | null;
  signed_at: string;
  created_at: string;
}

/** Document STATUS only. The bytes come solely from `GET /permits/:id/pdf`. */
export interface PermitDocumentStatus {
  snapshotId: string;
  snapshotHash: string;
  hashVersion: string;
  status: string;
  generatedAt: string | null;
  rendererVersion: string | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PermitListResponse {
  permits: PermitSummary[];
  pagination: Pagination;
}

export interface PermitDetailResponse {
  permit: Permit;
  jsa: Jsa;
  validity: PermitValidity | null;
  availableActions: AvailableAction[];
  history: LifecycleEvent[];
  signatures: PermitSignature[];
  document: PermitDocumentStatus | null;
}

// ---------------------------------------------------------------------
// Permit form payloads - backend/src/domain/permits/forms.ts
// ---------------------------------------------------------------------

export type ChecklistResponse = 'YES' | 'NO' | 'NA';

export interface ChecklistItem {
  label: string;
  response: ChecklistResponse;
  remarks?: string;
}

export interface SelectionOption {
  label: string;
  selected: boolean;
  remarks?: string;
}

export interface DescriptionRow {
  description: string;
  remarks?: string;
}

export interface WtgWorkForm {
  windFarm: string;
  wtgNumber: string;
  descriptionOfWork: string;
  permitStartAt: string;
  permitExpiryAt: string;
  generalWork: ChecklistItem[];
  electricalWork: ChecklistItem[];
  mechanicalWork: ChecklistItem[];
  hydraulicWork: ChecklistItem[];
  workAtHeights: ChecklistItem[];
  specificSafetyRequirements: ChecklistItem[];
  isolationPoints: DescriptionRow[];
  ppe: SelectionOption[];
  specialPrecautions?: string;
  specialInstructions?: string;
}

export interface ColdWorkForm {
  natureOfWork: {
    mechanical: boolean;
    electricalAndInstrumentation: boolean;
    civil: boolean;
    chemical: boolean;
    inspection: boolean;
  };
  hazards: { energized: boolean; fall: boolean; respiratory: boolean; chemical: boolean };
  generalRequirements: ChecklistItem[];
  equipmentCondition: ChecklistItem[];
  ppe: SelectionOption[];
  specialPrecautions?: string;
  specialInstructions?: string;
  confinedSpacePermitRef?: string;
  lotoNumber?: string;
}

export interface HotWorkForm {
  natureOfWork: SelectionOption[];
  typeOfHazard: SelectionOption[];
  generalRequirements: ChecklistItem[];
  equipmentCondition: ChecklistItem[];
  ppe: SelectionOption[];
  fireWatch: { required: boolean; attendant?: string; remarks?: string };
  relatedPermitRef?: string;
  lotoNumber?: string;
  specialPrecautions?: string;
  specialInstructions?: string;
  evacuationDetails?: string;
  remarks?: string;
}

export interface GasTestReading {
  time: string;
  oxygenPercent: number;
  result: 'PASS' | 'FAIL';
  testedBy?: string;
  remarks?: string;
}

export interface ConfinedSpaceEntryForm {
  natureOfWork: SelectionOption[];
  typeOfHazard: SelectionOption[];
  gasTest: {
    instrument?: string;
    instrumentCalibration?: string;
    retestRequired: boolean;
    retestDetails?: string;
    continuousMonitoring: boolean;
    readings: GasTestReading[];
  };
  generalRequirements: ChecklistItem[];
  ppe: SelectionOption[];
  attendant?: string;
  relatedColdWorkPermitRef?: string;
  relatedHotWorkPermitRef?: string;
  lotoNumber?: string;
  specialPrecautions?: string;
  specialInstructions?: string;
  evacuationDetails?: string;
  remarks?: string;
}

export type PermitFormPayload = WtgWorkForm | ColdWorkForm | HotWorkForm | ConfinedSpaceEntryForm;

export interface JsaTaskAnalysisRow {
  sequenceOfTasks: string;
  possibleHazardousEvents: string;
  energyOrTriggeringSources: string;
  protectiveActionsOrMeasures: string;
}

export interface JsaFormPayload {
  page1: {
    siteOrWtg: string;
    jobOrWork: string;
    requiredPermits: {
      wtgWork: boolean;
      coldWork: boolean;
      hotWork: boolean;
      confinedSpaceEntry: boolean;
    };
    hseChecklistGroups: { title: string; items: ChecklistItem[] }[];
  };
  page2: {
    emergencyResponse?: string;
    taskAnalysis: JsaTaskAnalysisRow[];
    ppe: SelectionOption[];
    toolsAndMaterials: DescriptionRow[];
    participants: { name: string; company?: string }[];
    participantAcknowledgements: { name: string; acknowledged: boolean; remarks?: string }[];
    comments?: string;
    closeOut?: { completedAt?: string; remarks?: string };
  };
}

// ---------------------------------------------------------------------
// Notifications - backend/src/domain/notifications/service.ts
// ---------------------------------------------------------------------

export interface AppNotification {
  id: string;
  recipient_user_id: string;
  permit_id: string | null;
  source_event_id: string;
  notification_type: string;
  title: string;
  message: string;
  created_at: string;
  read_at: string | null;
}

export interface NotificationListResponse {
  notifications: AppNotification[];
  pagination: Pagination;
}

// ---------------------------------------------------------------------
// Accounts - backend/src/routes/accounts.ts + domain/accounts/*
// ---------------------------------------------------------------------

export const COMPANY_CODES = ['E_SET', 'ZPL', 'SGRE'] as const;
export type CompanyCode = (typeof COMPANY_CODES)[number];

export type AccountState = 'ACTIVE' | 'DISABLED' | 'DELETED';

export interface EmployeeListItem {
  userId: string;
  displayName: string;
  state: AccountState;
  mustChangePassword: boolean;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
  teamPositionId: string;
  viewAllPermits: boolean;
}

export interface EmployeeListResponse {
  employees: EmployeeListItem[];
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number };
}

export interface EmployeeDetail {
  userId: string;
  state: AccountState;
  mustChangePassword: boolean;
  displayName: string;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
  teamPositionId: string;
  individualPermissions: string[];
}

export interface AccountAuditEntry {
  eventType: string;
  actorUserId: string;
  occurredAt: string;
  previousCompanyCode: string | null;
  newCompanyCode: string | null;
  previousTeamPositionId: string | null;
  newTeamPositionId: string | null;
  capabilityName: string | null;
}

/** One row of the organization-wide administrative audit. */
export interface GlobalAuditEntry extends AccountAuditEntry {
  targetUserId: string;
  targetDisplayName: string | null;
  actorDisplayName: string | null;
}

export interface AuditLogsResponse {
  items: GlobalAuditEntry[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface EmployeeHistoryResponse {
  items: AccountAuditEntry[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface OrganizationCompany {
  code: string;
  name: string;
  teams: { teamName: string; positions: { teamPositionId: string; positionName: string }[] }[];
}

export interface SiteManagerListItem {
  userId: string;
  displayName: string;
  active: boolean;
  accountState: AccountState | null;
}
