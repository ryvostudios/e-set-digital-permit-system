import type { PrivilegedAccessAdmin } from '../../db/privilegedPool.js';
import { hashPassword } from '../auth/passwords.js';
import { normalizeEmail } from './credentials.js';
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
 * identity with its own privileged display name. A normal
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
  | { outcome: 'failed'; reason: 'provisioning_rolled_back' };

/** All writes, including privileged audit, belong to one database function call. */
export async function createSiteManagerAccount(
  sessionId: string,
  input: CreateSiteManagerInput,
  privileged: PrivilegedAccessAdmin,
): Promise<CreateSiteManagerOutcome> {
  const passwordHash = await hashPassword(input.temporaryPassword);
  const result = await privileged.provisionSiteManager(sessionId, normalizeEmail(input.email), passwordHash, input.displayName);
  if (result.ok) return { outcome: 'ok', userId: result.userId };
  if (result.reason === 'email_unavailable') return { outcome: 'conflict', reason: 'email_unavailable' };
  return { outcome: 'failed', reason: 'provisioning_rolled_back' };
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
    'SELECT user_id FROM app_user_access WHERE user_id = $1',
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
 * user id can never be handed privilege by identifier alone. Creating a
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
  sessionId: string,
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
      const recorded = await privileged.recordSiteManagerGrant(sessionId, targetUserId);
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
  sessionId: string,
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
      const recorded = await privileged.recordSiteManagerRevoke(sessionId, targetUserId);
      if (!recorded.ok) return { outcome: 'failed', reason: 'grant_write_failed' };
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'grant_write_failed' };
  }
}
