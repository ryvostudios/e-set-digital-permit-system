import type { CurrentUser } from '../api/types';

/**
 * Capability and identity helpers, derived ONLY from what `/auth/me`
 * returned.
 *
 * WHAT THIS IS FOR. Deciding what to render. Nothing more. The backend
 * re-resolves capabilities and privileged roles from the database on
 * every single request, so hiding a button here removes clutter, never
 * a security control - a person who reaches a route directly still gets
 * a 403/404 from the server, and this application shows that honestly.
 *
 * WHAT THIS NEVER DOES:
 *   - infer a role from an email address or its domain
 *   - infer a company from an email domain
 *   - read Supabase `user_metadata`
 *   - treat a POSITION NAME as authority
 *
 * THE COLLISION THAT MATTERS. ZPL's Position "Site Manager" is an
 * ordinary employee job title. The privileged system role
 * `SITE_MANAGER` is an entirely separate thing, carried only in
 * `privilegedRoles`. Everything below reads `privilegedRoles`; nothing
 * below ever looks at `positionName`. The same holds for ZPL's "HSE"
 * position, which carries no `permit.hse_review` capability and is
 * therefore never an HSE approver here.
 */

export const CAPABILITIES = {
  permitCreate: 'permit.create',
  permitSubmit: 'permit.submit',
  croReview: 'permit.cro_review',
  forwardHse: 'permit.forward_hse',
  sendBack: 'permit.send_back',
  hseReview: 'permit.hse_review',
  fallbackApprove: 'permit.fallback_approve',
  hold: 'permit.hold',
  resume: 'permit.resume',
  cancel: 'permit.cancel',
  close: 'permit.close',
  renew: 'permit.renew',
  viewAll: 'permit.view_all',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * The one derived view of the current user every screen reads. Built in
 * a single place so no component re-derives "am I a CRO" from a
 * different set of fields.
 */
export interface Capabilities {
  has: (capability: string) => boolean;
  /** Privileged system roles, from the authoritative append-only grant log. Never a position name. */
  isCeo: boolean;
  isSiteManager: boolean;
  isPrivileged: boolean;
  /** Employee account administration - CEO or E-SET SITE_MANAGER. */
  canManageEmployees: boolean;
  /** CEO-only: permanent deletion, and Site Manager administration. */
  canDeleteEmployees: boolean;
  canManageSiteManagers: boolean;
  /**
   * The ADMINISTRATIVE/SECURITY audit trail (who created an account, who
   * reset a password, who disabled it).
   *
   * Both privileged system roles may READ it - CEO and E-SET
   * SITE_MANAGER - because a Site Manager runs day-to-day employee
   * administration and needs to see what was already done to an account.
   * Nobody else: not a normal employee, not CRO, not HSE, not a ZPL
   * organizational "Site Manager" (which is not this role at all), and
   * `permit.view_all` never grants it.
   *
   * Read-only. Correcting a record is `canCorrectRecords` below, which is
   * CEO-only. This is also NOT permit workflow history, which stays
   * visible to the people working a permit.
   */
  canViewAdministrativeAudit: boolean;
  /**
   * CEO-only: initiate a controlled, versioned correction/amendment to a
   * historical record. A Site Manager may READ the audit but may never
   * amend a record.
   */
  canCorrectRecords: boolean;
  /** Permit application. Privileged accounts may apply; E-SET E-BOP CRO may not (it holds neither capability). */
  canApplyForPermits: boolean;
  /** Whether the CRO review queue is worth showing at all. */
  canReviewAsCro: boolean;
  /** Whether the HSE review queue is worth showing at all. */
  canReviewAsHse: boolean;
  /** Any CRO operational authority over an issued permit (hold/resume/cancel/close/renew). */
  hasIssuedPermitAuthority: boolean;
  canViewAllPermits: boolean;
  /** The name to show for this person - exactly one of the two identity sources is ever populated. */
  displayName: string;
  /** The organizational identity, or null for a privileged system account (which has none). */
  profile: CurrentUser['profile'];
}

export function deriveCapabilities(user: CurrentUser): Capabilities {
  const granted = new Set(user.capabilities);
  const has = (capability: string): boolean => granted.has(capability);

  const isCeo = user.privilegedRoles.includes('CEO');
  const isSiteManager = user.privilegedRoles.includes('SITE_MANAGER');
  const isPrivileged = isCeo || isSiteManager;

  return {
    has,
    isCeo,
    isSiteManager,
    isPrivileged,
    canManageEmployees: isPrivileged,
    canDeleteEmployees: isCeo,
    canManageSiteManagers: isCeo,
    canViewAdministrativeAudit: isPrivileged,
    canCorrectRecords: isCeo,
    // Matches `requirePermitApplicant`: the capability, OR a privileged
    // system role. E-SET E-BOP CRO holds neither `permit.create` nor
    // `permit.submit` (migration 0020 excludes it), so CRO cannot apply.
    canApplyForPermits: isPrivileged || has(CAPABILITIES.permitCreate) || has(CAPABILITIES.permitSubmit),
    // A privileged role is NOT automatically CRO or HSE. Review
    // authority is a Team + Position capability and nothing else, so a
    // Site Manager sees no review queue unless they genuinely hold it -
    // which, being a privileged account with no Team or Position, they
    // never do.
    canReviewAsCro: has(CAPABILITIES.croReview) || has(CAPABILITIES.forwardHse),
    canReviewAsHse: has(CAPABILITIES.hseReview),
    hasIssuedPermitAuthority:
      has(CAPABILITIES.hold) ||
      has(CAPABILITIES.resume) ||
      has(CAPABILITIES.cancel) ||
      has(CAPABILITIES.close) ||
      has(CAPABILITIES.renew),
    // A privileged account is granted broad read access by the backend
    // itself (`resolvePermitReadCapabilities`), which is why it is
    // reflected here rather than requiring the individual grant.
    canViewAllPermits: isPrivileged || has(CAPABILITIES.viewAll),
    displayName: user.profile?.displayName ?? user.privilegedDisplayName ?? 'Signed in',
    profile: user.profile,
  };
}

/**
 * How this person's identity is written on a permit's applicant line.
 *
 * A NORMAL employee reads "Mr. Ali Khan". A PRIVILEGED account reads the
 * personal name ALONE - no honorific-plus-company, no role, no "E-SET",
 * no Company, Team or Position, because it genuinely has none and none
 * may be fabricated.
 *
 * THE APPLICANT LINE IS A PERSON, NOT A PERSON AND THEIR EMPLOYER. It
 * used to read "Mr. Ali Khan of Company ZPL", which put the company into
 * the middle of every name on every list, register row and document -
 * and the company is its own field, shown in its own place, on the forms
 * that print one. Removing it from this line removes a duplicate
 * rendering, nothing else: the value is untouched in the database, the
 * API, the stored form payloads, the issued snapshots and the PDF.
 *
 * This is a PREVIEW of what the server will record. The applicant
 * identity actually stored on a permit is derived server-side at
 * submission (`domain/permits/applicantIdentity.ts`) and is never sent
 * from the browser.
 */
export function describeApplicantIdentity(user: CurrentUser): string {
  if (user.profile) {
    return `Mr. ${user.profile.displayName}`;
  }
  return user.privilegedDisplayName ?? '';
}

/**
 * The same line, rendered from a permit's own frozen applicant fields.
 *
 * `applicant_company_name` is deliberately not read here. It remains on
 * the permit and is displayed wherever a Company field belongs; it is
 * simply not part of the applicant's NAME.
 */
export function describePermitApplicant(permit: {
  applicant_identity_kind?: 'NORMAL' | 'PRIVILEGED' | null;
  applicant_display_name?: string | null;
  /** Still on the permit, still accepted here - and deliberately NOT read. */
  applicant_company_name?: string | null;
}): string | null {
  const name = permit.applicant_display_name;
  if (!name) return null;
  if (permit.applicant_identity_kind === 'PRIVILEGED') return name;
  return `Mr. ${name}`;
}
