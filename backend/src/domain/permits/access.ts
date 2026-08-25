import type { PermitRow, PermitStatus } from './service.js';
import { computeNextMidnightUtc, isPermitValid } from './validity.js';

export interface PermitValidity {
  isValid: boolean;
  expiresAt: string;
}

/**
 * Computed permit validity - the single, centralized place this is
 * derived, so no route/caller needs to (or can accidentally get wrong
 * by) re-deriving status semantics itself.
 *
 * Only a currently-ISSUED permit can ever be valid. `issued_at` and
 * `site_timezone` remain on the row after closure (so a CLOSED permit's
 * `expiresAt` is still reconstructable for historical reference - the
 * `expiresAt` formula itself is unchanged, still `computeNextMidnightUtc`
 * on `issued_at`/`site_timezone`), but `isValid` is false for every
 * status other than ISSUED - in particular CLOSED, even before what
 * would otherwise have been its midnight expiry. This reads existing
 * columns only; it never writes/mutates anything, and no persisted
 * EXPIRED state is introduced - validity remains purely computed.
 *
 * Returns null before issuance (`issued_at` not set - there is nothing
 * to compute yet).
 */
export function computePermitValidity(
  permit: Pick<PermitRow, 'status' | 'issued_at' | 'site_timezone'>,
  nowUtc: Date,
): PermitValidity | null {
  if (!permit.issued_at) return null;
  const issuedAt = new Date(permit.issued_at);
  return {
    isValid: permit.status === 'ISSUED' && isPermitValid(issuedAt, permit.site_timezone, nowUtc),
    expiresAt: computeNextMidnightUtc(issuedAt, permit.site_timezone).toISOString(),
  };
}

/**
 * Which capabilities grant read access to a permit that ISN'T the
 * viewer's own (`created_by`), keyed by the permit's CURRENT status -
 * the same capability(ies) that already gate the primary mutation
 * available from that status (WORKFLOW.md's "common queue": CRO/HSE act
 * on permits they did not create). A creator can always view their own
 * permit regardless of status; that is a separate, unconditional check
 * (see `canViewPermit`), not part of this table.
 *
 * DRAFT maps to an empty list deliberately: a draft is a private
 * work-in-progress document, never visible to anyone but its creator -
 * there is no "DRAFT queue" capability, and none should be invented.
 *
 * This governs READ access only (list/detail/history). It does not
 * change, weaken, or duplicate the authorization already enforced by
 * each mutation endpoint (requireCapability + the service layer's own
 * row-locked status/version checks), which remains the sole source of
 * truth for whether an action is actually allowed.
 */
export const STATUS_VIEW_CAPABILITIES: Readonly<Record<PermitStatus, readonly string[]>> = {
  DRAFT: [],
  // `permit.cro_review` ("review a pending permit as CRO", capability
  // catalog) is the general CRO-review read/act capability for this
  // status; `permit.forward_hse` (the capability that actually gates the
  // forward-to-HSE mutation) also grants visibility for an actor about
  // to perform that transition. Either is sufficient (OR, not AND) -
  // holding neither denies visibility; holding one never implies the
  // other, and viewing never implies forwarding authority (that's
  // decided solely by `computeAvailableActions`/`requireCapability`
  // below, independently of this list).
  PENDING_CRO: ['permit.cro_review', 'permit.forward_hse'],
  PENDING_HSE: ['permit.hse_review', 'permit.fallback_approve'],
  ISSUED: ['permit.close'],
  CLOSED: ['permit.close'],
};

/**
 * Whether `viewerId` (holding `viewerCapabilities`) may read `permit` -
 * either because they created it, or because they hold a capability
 * applicable to its current status. Used for permit detail, JSA detail,
 * and lifecycle history alike (the same object, the same rule).
 */
export function canViewPermit(
  permit: Pick<PermitRow, 'status' | 'created_by'>,
  viewerId: string,
  viewerCapabilities: ReadonlySet<string>,
): boolean {
  if (permit.created_by === viewerId) return true;
  return STATUS_VIEW_CAPABILITIES[permit.status].some((capability) => viewerCapabilities.has(capability));
}

export type AvailableAction = 'update' | 'submit' | 'forward_hse' | 'hse_approve' | 'fallback_approve' | 'close';

/**
 * A display-only hint of which actions `viewerId` could currently
 * attempt on `permit`, derived purely from already-fetched data (status,
 * ownership, resolved capabilities, and - only for the fallback-approve
 * hint - the backend server's own clock, never the browser's). This
 * NEVER authorizes anything by itself: every mutation endpoint
 * independently re-checks capability, the row-locked current status, and
 * (for fallback approval) DB-authoritative time. Frontend visibility is
 * not a security control (ARCHITECTURE.md) - this exists only so the
 * frontend doesn't have to duplicate the same status/capability rules to
 * decide what to render.
 */
export function computeAvailableActions(
  permit: Pick<PermitRow, 'status' | 'created_by' | 'hse_review_deadline_at'>,
  viewerId: string,
  viewerCapabilities: ReadonlySet<string>,
  nowMs: number,
): AvailableAction[] {
  const actions: AvailableAction[] = [];
  const isOwner = permit.created_by === viewerId;

  if (permit.status === 'DRAFT' && isOwner) {
    if (viewerCapabilities.has('permit.create')) actions.push('update');
    if (viewerCapabilities.has('permit.submit')) actions.push('submit');
  }
  if (permit.status === 'PENDING_CRO' && viewerCapabilities.has('permit.forward_hse')) {
    actions.push('forward_hse');
  }
  if (permit.status === 'PENDING_HSE') {
    if (viewerCapabilities.has('permit.hse_review')) actions.push('hse_approve');
    if (
      viewerCapabilities.has('permit.fallback_approve') &&
      permit.hse_review_deadline_at !== null &&
      nowMs >= new Date(permit.hse_review_deadline_at).getTime()
    ) {
      actions.push('fallback_approve');
    }
  }
  if (permit.status === 'ISSUED' && viewerCapabilities.has('permit.close')) {
    actions.push('close');
  }

  return actions;
}
