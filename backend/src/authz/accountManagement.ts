import { query, type QueryFn } from '../db/pool.js';
import { resolveUserCapabilities } from './capabilities.js';
import { resolvePrivilegedAccess, type PrivilegedRole } from './privilegedAccess.js';

/**
 * Authorization for employee account management.
 *
 * TWO INDEPENDENT AUTHORITIES ARE REQUIRED, and both are resolved from
 * authoritative application tables - never from a role label, a token
 * claim, or client-editable `user_metadata`:
 *
 *   1. The explicit account-management capability
 *      (`employee.create` / `employee.reset_password`), resolved through
 *      the existing Team + Position -> Capabilities model.
 *   2. CEO or Site Manager privileged access, resolved from the
 *      append-only `privileged_access_events` log.
 *
 * Requiring both is deliberate. Account management is a MANAGEMENT
 * authority, and DECISIONS.md is explicit that "Team + Position never
 * automatically grants CEO or Site Manager authority" - so a capability
 * alone must not be able to mint accounts. Equally, holding a privileged
 * role alone does not silently confer every future management action;
 * the capability names what may actually be done. An attacker who
 * obtains one of the two still cannot provision or reset an account.
 *
 * Neither authority is self-grantable through this API: nothing in this
 * codebase writes `privileged_access_events` (outside the operator-run
 * CEO bootstrap CLI) or `team_position_capabilities` at all.
 */

export type AccountManagementCapability = 'employee.create' | 'employee.reset_password';

/** The privileged tiers whose holders may manage normal employee accounts. */
const ACCOUNT_MANAGEMENT_ROLES: readonly PrivilegedRole[] = ['CEO', 'SITE_MANAGER'];

export type AccountManagementDenial =
  | 'missing_capability'
  | 'missing_privileged_access';

export type AccountManagementAuthorization =
  | { authorized: true; roles: Set<PrivilegedRole> }
  | { authorized: false; reason: AccountManagementDenial };

export interface AccountManagementDeps {
  resolveCapabilities: (userId: string) => Promise<Set<string>>;
  resolvePrivileged: (userId: string) => Promise<Set<PrivilegedRole>>;
}

const defaultDeps: AccountManagementDeps = {
  resolveCapabilities: resolveUserCapabilities,
  resolvePrivileged: resolvePrivilegedAccess,
};

/**
 * Default-deny: a missing capability, a missing privileged grant, or a
 * resolution failure all deny. The caller decides the HTTP shape; this
 * only answers whether the authority exists.
 */
export async function authorizeAccountManagement(
  actorUserId: string,
  capability: AccountManagementCapability,
  deps: AccountManagementDeps = defaultDeps,
): Promise<AccountManagementAuthorization> {
  const capabilities = await deps.resolveCapabilities(actorUserId);
  if (!capabilities.has(capability)) return { authorized: false, reason: 'missing_capability' };

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
 * in as it. Protection is derived from `privileged_access_events` - the
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
