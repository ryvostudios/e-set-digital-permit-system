import type { AvailableAction, PermitType } from '../../api/types';

/**
 * Human-readable labels for the backend's exact enum values.
 *
 * The four permit types are fixed by the backend (`PERMIT_TYPES`) and no
 * fifth is ever offered. The friendly label is for reading; the enum
 * value is what is sent, unchanged.
 */
export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  WTG_WORK: 'WTG Work Permit',
  COLD_WORK: 'Cold Work Permit',
  HOT_WORK: 'Hot Work Permit',
  CONFINED_SPACE_ENTRY: 'Confined Space Entry Permit',
};

export const PERMIT_TYPE_DESCRIPTIONS: Record<PermitType, string> = {
  WTG_WORK: 'Work on or inside a wind turbine generator.',
  COLD_WORK: 'Maintenance or inspection with no ignition source.',
  HOT_WORK: 'Welding, cutting, grinding, or any other ignition source.',
  CONFINED_SPACE_ENTRY: 'Entry into a confined space, with gas testing.',
};

export function permitTypeLabel(type: PermitType | null | undefined): string {
  return type ? PERMIT_TYPE_LABELS[type] : 'Not selected';
}

/**
 * The lifecycle event types the backend records (migration 0012's CHECK
 * constraint). Rendered as plain sentences; the raw event name, the
 * append-only ordinal, and every internal identifier stay out of the UI.
 */
const EVENT_LABELS: Record<string, string> = {
  CREATED: 'Draft created',
  SUBMITTED: 'Submitted for CRO review',
  APPLICANT_RESUBMITTED: 'Resubmitted for CRO review',
  CRO_SENT_BACK_TO_APPLICANT: 'Returned to the applicant for correction',
  CRO_FORWARDED_HSE: 'Forwarded for HSE review',
  HSE_APPROVED: 'Approved by HSE — permit issued',
  HSE_SENT_BACK_TO_CRO: 'Returned to CRO by HSE',
  CRO_FALLBACK_APPROVED: 'Approved by CRO fallback — permit issued',
  HELD: 'Placed on hold',
  RESUMED: 'Resumed',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
  RENEWED: 'Issued as a renewal of an earlier permit',
};

export function lifecycleEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replaceAll('_', ' ').toLowerCase();
}

/** The label and tone for each backend-offered action. */
export const ACTION_LABELS: Record<AvailableAction, string> = {
  update: 'Edit',
  submit: 'Submit for CRO review',
  resubmit: 'Resubmit for CRO review',
  send_back: 'Return for correction',
  forward_hse: 'Forward to HSE',
  hse_approve: 'Approve and issue',
  hse_send_back: 'Return to CRO',
  fallback_approve: 'Approve as CRO fallback',
  hold: 'Place on hold',
  resume: 'Resume',
  cancel: 'Cancel permit',
  close: 'Close permit',
  renew: 'Renew permit',
};

/** The signature block heading for each frozen signature role. */
export const SIGNATURE_ROLE_LABELS: Record<string, string> = {
  APPLICANT: 'Applicant',
  CRO: 'Control Room Operator',
  HSE: 'HSE',
  CRO_FALLBACK: 'CRO (fallback approval)',
  RENEWAL: 'Renewal',
};

/** The company values the permit search filter accepts (backend `companySchema`). */
export const SEARCH_COMPANY_OPTIONS = [
  { value: 'ESET', label: 'E-SET' },
  { value: 'SGRE', label: 'SGRE' },
  { value: 'ZPL', label: 'ZPL' },
  { value: 'OTHER', label: 'Other' },
] as const;
