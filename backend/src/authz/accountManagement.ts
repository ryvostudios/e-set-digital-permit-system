import { query, type QueryFn } from '../db/pool.js';
import { resolvePrivilegedAccess, type PrivilegedRole } from './privilegedAccess.js';

/**
 * Authorization for employee account management.
 *
 * THE AUTHORITY IS THE PRIVILEGED SYSTEM ROLE ITSELF - CEO or E-SET
 * SITE_MANAGER - resolved from the authoritative, append-only
 * `privileged_access_events` log, never from a role label, a token
 * claim, a Position NAME, or client-editable `user_metadata`.
 *
 * WHY NOT ALSO A TEAM + POSITION CAPABILITY. CEO and E-SET SITE_MANAGER
 * are privileged SYSTEM accounts, not organizational employees: by
 * confirmed business rule they have no Company, no Team and no Position.
 * Capabilities are derived exclusively from Team + Position
 * (`authz/capabilities.ts`), so requiring `employee.create` /
 * `employee.reset_password` in addition to the privileged role could only
 * ever be satisfied by inventing a fake Team + Position for a privileged
 * identity - precisely the fabricated membership the model forbids -
 * which would in turn have made account management unreachable for the
 * only accounts entitled to perform it.
 *
 * This does NOT loosen the governance model, and in particular does not
 * let Team + Position confer management authority - the opposite
 * direction is what DECISIONS.md forbids ("Team + Position never
 * automatically grants CEO or Site Manager authority"), and a capability
 * on its own is now not merely insufficient but irrelevant here.
 * Capability authorization is untouched everywhere else (permits, JSA,
 * review queues), where it governs normal employees.
 *
 * The authority is not self-grantable through this API: nothing in this
 * codebase writes `privileged_access_events` outside the operator-run
 * CEO bootstrap CLI.
 */

/** The privileged tiers whose holders may manage normal employee accounts. */
const ACCOUNT_MANAGEMENT_ROLES: readonly PrivilegedRole[] = ['CEO', 'SITE_MANAGER'];

export type AccountManagementDenial = 'missing_privileged_access';

export type AccountManagementAuthorization =
  | { authorized: true; roles: Set<PrivilegedRole> }
  | { authorized: false; reason: AccountManagementDenial };

export interface AccountManagementDeps {
  resolvePrivileged: (userId: string) => Promise<Set<PrivilegedRole>>;
}

const defaultDeps: AccountManagementDeps = {
  resolvePrivileged: resolvePrivilegedAccess,
};

/**
 * Default-deny: no active CEO/SITE_MANAGER grant - or a resolution
 * failure at the caller - denies. The caller decides the HTTP shape;
 * this only answers whether the authority exists.
 */
export async function authorizeAccountManagement(
  actorUserId: string,
  deps: AccountManagementDeps = defaultDeps,
): Promise<AccountManagementAuthorization> {
  const roles = await deps.resolvePrivileged(actorUserId);
  if (!ACCOUNT_MANAGEMENT_ROLES.some((role) => roles.has(role))) {
    return { authorized: false, reason: 'missing_privileged_access' };
  }
  return { authorized: true, roles };
}

export type ProtectedTargetReason =
  | 'target_is_privileged'
  | 'target_is_self';

export type TargetEligibility =
  | { eligible: true }
  | { eligible: false; reason: ProtectedTargetReason };

/**
 * Whether `targetUserId` is an account these endpoints may act on.
 *
 * A target holding ANY privileged grant (CEO or Site Manager) is
 * protected: the normal-employee flow may never provision, reset, or
 * otherwise reach a governed identity, so existing CEO authority cannot
 * be bypassed by resetting a privileged account's password and signing
 * in as it. This is also what keeps CEO strictly above Site Manager -
 * one Site Manager cannot reach another, and neither can reach the CEO.
 * Protection is derived from `privileged_access_events` - the
 * authoritative, append-only governance log - never from
 * `user_metadata`, an email pattern, or any client-supplied hint.
 *
 * Acting on your own account through the management endpoints is also
 * refused: self-service password change is its own authenticated
 * endpoint, and allowing a manager to "reset" themselves here would let
 * the audit trail record a manager action against its own actor (which
 * `account_audit_events_actor_consistent` refuses to store anyway).
 */
export async function isManageableTarget(
  actorUserId: string,
  targetUserId: string,
  deps: AccountManagementDeps = defaultDeps,
): Promise<TargetEligibility> {
  if (actorUserId === targetUserId) return { eligible: false, reason: 'target_is_self' };
  const roles = await deps.resolvePrivileged(targetUserId);
  if (roles.size > 0) return { eligible: false, reason: 'target_is_privileged' };
  return { eligible: true };
}

/**
 * Whether a Team + Position is explicitly approved for ordinary employee
 * provisioning by a Site Manager. Existence alone is intentionally
 * insufficient: an existing assignment may carry security-sensitive
 * capabilities. Migration 0017 defaults every combination to FALSE and
 * this API exposes no way to change the flag. Capabilities remain governed
 * separately; assignability itself grants nothing.
 *
 * Note that this is an ORGANIZATIONAL assignment in every case - a ZPL
 * "Site Manager" position is an ordinary ZPL job title and confers no
 * privileged SITE_MANAGER authority whatsoever, because privileged
 * status is read only from `privileged_access_events`, never from a
 * Position name.
 */
export async function teamPositionIsSiteManagerAssignable(
  teamPositionId: string,
  queryFn: QueryFn = query,
): Promise<boolean> {
  const result = await queryFn<{ exists: boolean }>(
    `SELECT TRUE AS exists
       FROM team_positions
      WHERE id = $1
        AND site_manager_assignable = TRUE`,
    [teamPositionId],
  );
  return result.rows.length > 0;
}
