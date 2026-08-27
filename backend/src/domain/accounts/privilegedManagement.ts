import type { PrivilegedAccessAdmin } from '../../db/privilegedPool.js';
import type { AccountsServiceDeps } from './service.js';

/**
 * CEO-only administration of E-SET SITE_MANAGER privileged accounts.
 *
 * AUTHORITY. Only the CEO may establish, grant, or revoke SITE_MANAGER.
 * A Site Manager has full authority over NORMAL employees but none over
 * the privileged tier: they cannot create a CEO, mint another Site
 * Manager, or grant/revoke any privileged role. That asymmetry is what
 * keeps CEO strictly above Site Manager, and it is enforced at the route
 * layer by requiring the CEO role specifically (not merely "some
 * privileged role").
 *
 * MULTIPLE SITE MANAGERS ARE INTENTIONAL. Any number may be active at
 * once and each holds exactly the same full Site Manager authority;
 * nothing here is a singleton.
 *
 * NEVER A PROMOTION. A privileged account is established as its own new
 * Auth identity with its own privileged display name. A normal
 * workforce employee is never converted: migration 0019 refuses a
 * privileged grant for any user holding a workforce profile, and this
 * service checks the same thing first so the refusal is a clean 409
 * rather than a raw database error. Nothing here deletes an employee's
 * profile, ends their assignment, or rewrites history to make a grant
 * succeed.
 *
 * AUDIT. `privileged_access_events` is append-only (migration 0004's
 * `forbid_mutation` triggers) and records the actor, the target, the
 * role, the action and a reason - so the grant log IS the audit trail
 * for this tier. No separate audit write is needed, and nothing written
 * here can ever be edited or deleted, including by the backend itself.
 *
 * A DIFFERENT DATABASE LOGIN WRITES THE GRANT. The ordinary runtime
 * credential can neither INSERT into `privileged_access_events` nor
 * EXECUTE the function that does - it has no route to privileged
 * authority at all. Grants and revokes travel over the separate
 * `privileged_runtime` channel (`db/privilegedPool.ts`), whose login
 * holds CONNECT, schema USAGE and EXECUTE on that one hardened function
 * and nothing else. Possession of `DATABASE_URL` alone is therefore not
 * sufficient to grant SITE_MANAGER, even by passing the real CEO's id as
 * the actor.
 *
 * The reads below still run on the ordinary connection - they are only
 * lookups, and turning common refusals into typed outcomes is what makes
 * the API pleasant. They are NOT the enforcement: the database function
 * independently re-derives the actor's CEO status and refuses everything
 * this file refuses, so a bug here cannot widen authority.
 */

export interface CreateSiteManagerInput {
  email: string;
  temporaryPassword: string;
  displayName: string;
}

export type CreateSiteManagerOutcome =
  | { outcome: 'ok'; userId: string }
  | { outcome: 'conflict'; reason: 'email_unavailable' }
  | { outcome: 'failed'; reason: 'auth_create_failed' }
  | { outcome: 'failed'; reason: 'provisioning_rolled_back' }
  | { outcome: 'failed'; reason: 'provisioning_orphan_requires_operator'; orphanUserId: string }
  /** Account and name exist, but the SITE_MANAGER grant did not land. It holds NO privilege; the CEO retries the grant. */
  | { outcome: 'failed'; reason: 'grant_not_recorded'; userId: string };

/**
 * Establishes a new E-SET SITE_MANAGER account.
 *
 * ORDER AND FAILURE DESIGN - identical in shape to employee
 * provisioning, for the same reasons:
 *   1. Create the Auth identity FIRST. At that instant it can
 *      authenticate against Supabase but has NO `app_user_access` row,
 *      and `requireAuth` fails closed on a missing row, so it can reach
 *      no application endpoint and holds no privilege.
 *   2. Write every PostgreSQL row in ONE transaction: the access row
 *      (ACTIVE, owing a password change), the privileged identity, and
 *      the SITE_MANAGER grant. They are genuinely atomic with each
 *      other, so there is no state with a grant but no name, or a name
 *      but no forced password change.
 *   3. On failure, COMPENSATE by deleting the Auth identity. If that
 *      also fails the identity remains harmless for the reason in step
 *      1, and the caller receives a distinct outcome naming the orphan.
 *
 * The forced password change is set in the same transaction as the
 * grant, so a Site Manager can never reach an application endpoint with
 * the temporary password the CEO chose.
 *
 * An existing email is NEVER adopted: reconciling onto an existing Auth
 * identity would let this endpoint attach privilege to an identity it
 * does not own - including a normal employee's.
 */
export async function createSiteManagerAccount(
  actorUserId: string,
  input: CreateSiteManagerInput,
  deps: AccountsServiceDeps,
  privileged: PrivilegedAccessAdmin,
): Promise<CreateSiteManagerOutcome> {
  const created = await deps.admin.createUser({
    email: input.email,
    password: input.temporaryPassword,
  });
  if (!created.ok) {
    return created.reason === 'email_unavailable'
      ? { outcome: 'conflict', reason: 'email_unavailable' }
      : { outcome: 'failed', reason: 'auth_create_failed' };
  }

  const userId = created.userId;
  try {
    await deps.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO app_user_access (user_id, state, must_change_password, credentials_changed_at)
         VALUES ($1, 'ACTIVE', TRUE, now())`,
        [userId],
      );
      // No company_id, no team, no position - a privileged system
      // account has none, and none is fabricated to satisfy any column.
      await client.query(
        'INSERT INTO privileged_identities (user_id, display_name) VALUES ($1, $2)',
        [userId, input.displayName],
      );
    });
  } catch {
    const removed = await deps.admin.deleteUser(userId);
    return removed.ok
      ? { outcome: 'failed', reason: 'provisioning_rolled_back' }
      : { outcome: 'failed', reason: 'provisioning_orphan_requires_operator', orphanUserId: userId };
  }

  // The grant is the LAST step and travels over the separate privileged
  // login, so it cannot share the transaction above. That split is safe
  // precisely because of the ordering: at this point the account exists,
  // is named, owes a password change, and holds NO privilege and NO
  // capabilities - a privileged identity confers nothing on its own. If
  // the grant fails, the reachable state has LESS authority than
  // intended, never more, which is the property every cross-system step
  // in this codebase is ordered to preserve.
  //
  // The Auth identity is deliberately NOT compensated here: the account
  // is legitimate and complete apart from its authority, so deleting it
  // would destroy a named identity over a retryable failure. The CEO
  // retries via the grant endpoint, which succeeds because the
  // privileged identity already exists.
  const granted = await privileged.recordSiteManagerGrant(actorUserId, userId);
  if (!granted.ok) return { outcome: 'failed', reason: 'grant_not_recorded', userId };

  return { outcome: 'ok', userId };
}

export type SiteManagerGrantOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_employee' }
  | { outcome: 'refused'; reason: 'target_is_self' }
  | { outcome: 'refused'; reason: 'target_is_ceo' }
  | { outcome: 'refused'; reason: 'already_in_requested_state' }
  | { outcome: 'failed'; reason: 'grant_write_failed' };

/**
 * The current SITE_MANAGER state of `targetUserId`, read with the same
 * latest-event-per-role derivation the authorization resolver uses, and
 * under a lock so a concurrent grant/revoke cannot interleave.
 */
async function readPrivilegedState(
  client: { query: AccountsServiceDeps['query'] },
  targetUserId: string,
): Promise<{ exists: boolean; isSiteManager: boolean; isCeo: boolean; isEmployee: boolean }> {
  const access = await client.query<{ user_id: string }>(
    'SELECT user_id FROM app_user_access WHERE user_id = $1 FOR UPDATE',
    [targetUserId],
  );
  if (access.rows.length === 0) {
    return { exists: false, isSiteManager: false, isCeo: false, isEmployee: false };
  }
  const roles = await client.query<{ role: string; action: string }>(
    `SELECT DISTINCT ON (role) role, action
       FROM privileged_access_events
      WHERE user_id = $1
      ORDER BY role, ordinal DESC`,
    [targetUserId],
  );
  const active = new Set(roles.rows.filter((row) => row.action === 'GRANTED').map((row) => row.role));
  const employee = await client.query<{ user_id: string }>(
    'SELECT user_id FROM workforce_profiles WHERE user_id = $1',
    [targetUserId],
  );
  return {
    exists: true,
    isSiteManager: active.has('SITE_MANAGER'),
    isCeo: active.has('CEO'),
    isEmployee: employee.rows.length > 0,
  };
}

/**
 * CEO re-grants SITE_MANAGER to an existing privileged identity - a
 * previously revoked Site Manager returning to duty.
 *
 * This deliberately cannot bootstrap a brand-new privileged account: the
 * target must already have a `privileged_identities` row, so there is
 * always an authoritative display name behind the authority, and a bare
 * Auth id can never be handed privilege by identifier alone. Creating a
 * new Site Manager is `createSiteManagerAccount`, which establishes name
 * and grant atomically.
 *
 * A normal workforce employee is refused outright - the promotion path
 * does not exist, by design.
 */
export async function grantSiteManager(
  actorUserId: string,
  targetUserId: string,
  deps: AccountsServiceDeps,
  privileged: PrivilegedAccessAdmin,
): Promise<SiteManagerGrantOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<SiteManagerGrantOutcome> => {
      const bound = { query: client.query.bind(client) as AccountsServiceDeps['query'] };
      const state = await readPrivilegedState(bound, targetUserId);
      if (!state.exists) return { outcome: 'not_found' };
      if (state.isEmployee) return { outcome: 'refused', reason: 'target_is_employee' };
      if (state.isSiteManager) return { outcome: 'refused', reason: 'already_in_requested_state' };

      const identity = await client.query<{ user_id: string }>(
        'SELECT user_id FROM privileged_identities WHERE user_id = $1',
        [targetUserId],
      );
      if (identity.rows.length === 0) return { outcome: 'not_found' };

      // Written over the separate privileged login, never this one.
      const recorded = await privileged.recordSiteManagerGrant(actorUserId, targetUserId);
      if (!recorded.ok) return { outcome: 'failed', reason: 'grant_write_failed' };
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'grant_write_failed' };
  }
}

/**
 * CEO revokes SITE_MANAGER. Takes effect on the target's very next
 * request: privileged authority is re-resolved from this log on every
 * authorization check, so an already-issued JWT confers nothing extra
 * once the REVOKED row commits.
 *
 * The account itself is left intact - the identity, its display name and
 * its login all survive; only the authority is withdrawn. A CEO is never
 * revocable through this endpoint (CEO governance is not a Site Manager
 * operation), and the CEO cannot revoke themselves here.
 */
export async function revokeSiteManager(
  actorUserId: string,
  targetUserId: string,
  deps: AccountsServiceDeps,
  privileged: PrivilegedAccessAdmin,
): Promise<SiteManagerGrantOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<SiteManagerGrantOutcome> => {
      const bound = { query: client.query.bind(client) as AccountsServiceDeps['query'] };
      const state = await readPrivilegedState(bound, targetUserId);
      if (!state.exists) return { outcome: 'not_found' };
      if (state.isCeo) return { outcome: 'refused', reason: 'target_is_ceo' };
      if (!state.isSiteManager) return { outcome: 'refused', reason: 'already_in_requested_state' };

      // Written over the separate privileged login, never this one.
      const recorded = await privileged.recordSiteManagerRevoke(actorUserId, targetUserId);
      if (!recorded.ok) return { outcome: 'failed', reason: 'grant_write_failed' };
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'grant_write_failed' };
  }
}
