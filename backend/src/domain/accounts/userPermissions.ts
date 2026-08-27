import { query, type QueryFn } from '../../db/pool.js';
import { recordAccountAudit, type AccountsServiceDeps } from './service.js';

/**
 * INDIVIDUAL, per-user permissions.
 *
 * These are granted to a PERSON, not to a Team + Position. Two Civil
 * Workers may legitimately differ on "can see every permit", so
 * modelling it organizationally would both be wrong and hand it to
 * everyone who ever holds that combination.
 *
 * ONLY A CLOSED SET IS INDIVIDUALLY GRANTABLE. Migration 0023 marks
 * exactly one capability `individually_grantable` - `permit.view_all` -
 * and a database trigger refuses any other, in BOTH directions: no
 * workflow capability (`permit.close`, `permit.cro_review`,
 * `permit.hse_review`, `employee.create`, ...) can be granted to an
 * individual, and no individually-grantable capability can be attached
 * to a Team + Position. So this API cannot become a back door into
 * workflow or account-management authority even if this file were wrong.
 *
 * APPEND-ONLY. `user_capability_grants` records GRANTED/REVOKED events
 * with the acting manager, current status is derived from the latest
 * event per (user, capability), and 0004's `forbid_mutation` triggers
 * make the log unmodifiable for every role including the backend's own.
 * The grant log IS the audit trail; `account_audit_events` additionally
 * records the administrative act by capability id.
 */

/** The one capability that may currently be granted to an individual. Kept as a constant so route validation and the database agree by construction. */
export const INDIVIDUALLY_GRANTABLE_CAPABILITIES = ['permit.view_all'] as const;
export type IndividualCapability = (typeof INDIVIDUALLY_GRANTABLE_CAPABILITIES)[number];

/**
 * The individually-granted capability names currently active for
 * `userId`, derived from the LATEST event per capability - never from
 * the mere presence of a grant row, so a revoke takes effect the instant
 * it commits and an old GRANTED row cannot resurrect it.
 *
 * Resolved from the database on every request that needs it, exactly
 * like Team + Position capabilities and privileged roles: a JWT never
 * carries authorization, so a revoked permission is gone on the target's
 * very next call.
 */
export async function resolveUserIndividualCapabilities(
  userId: string,
  queryFn: QueryFn = query,
): Promise<Set<string>> {
  const result = await queryFn<{ name: string }>(
    `SELECT c.name
       FROM (
         SELECT DISTINCT ON (capability_id) capability_id, action
           FROM user_capability_grants
          WHERE user_id = $1
          ORDER BY capability_id, ordinal DESC
       ) latest
       JOIN capabilities c ON c.id = latest.capability_id
      WHERE latest.action = 'GRANTED'`,
    [userId],
  );
  return new Set(result.rows.map((row) => row.name));
}

export type UserPermissionOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_privileged' | 'target_is_self' | 'account_deleted' | 'already_in_state' }
  | { outcome: 'invalid'; reason: 'capability_not_individually_grantable' }
  | { outcome: 'failed'; reason: 'update_failed' };

/**
 * Grants or revokes one individual capability for a normal employee.
 *
 * The target must be a normal employee: privileged system accounts get
 * their visibility from their role and must not accumulate
 * organizational permissions - migration 0023's guard refuses it, and
 * this checks first so the refusal is a clean 409 rather than a raw
 * database error. Any company is fine (E-SET, ZPL, SGRE): this
 * permission is deliberately company-agnostic.
 */
export async function setUserCapabilityGrant(
  actorUserId: string,
  targetUserId: string,
  capabilityName: IndividualCapability,
  action: 'GRANTED' | 'REVOKED',
  deps: AccountsServiceDeps,
): Promise<UserPermissionOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<UserPermissionOutcome> => {
      const capability = await client.query<{ id: string; individually_grantable: boolean }>(
        'SELECT id, individually_grantable FROM capabilities WHERE name = $1',
        [capabilityName],
      );
      const cap = capability.rows[0];
      if (!cap || !cap.individually_grantable) {
        return { outcome: 'invalid', reason: 'capability_not_individually_grantable' };
      }

      const access = await client.query<{ state: string }>(
        'SELECT state FROM app_user_access WHERE user_id = $1 FOR UPDATE',
        [targetUserId],
      );
      const state = access.rows[0]?.state;
      if (!state) return { outcome: 'not_found' };
      if (state === 'DELETED') return { outcome: 'refused', reason: 'account_deleted' };

      const privileged = await client.query<{ protected: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM (
             SELECT DISTINCT ON (role) role, action
               FROM privileged_access_events
              WHERE user_id = $1
              ORDER BY role, ordinal DESC
           ) latest WHERE latest.action = 'GRANTED'
         ) AS protected`,
        [targetUserId],
      );
      if (privileged.rows[0]?.protected) return { outcome: 'refused', reason: 'target_is_privileged' };

      // Derived from the latest event, so a redundant change is reported
      // as a conflict rather than appending a misleading duplicate.
      const current = await client.query<{ action: string }>(
        `SELECT action FROM user_capability_grants
          WHERE user_id = $1 AND capability_id = $2
          ORDER BY ordinal DESC LIMIT 1`,
        [targetUserId, cap.id],
      );
      const active = current.rows[0]?.action === 'GRANTED';
      if (active === (action === 'GRANTED')) return { outcome: 'refused', reason: 'already_in_state' };

      await client.query(
        `INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
         VALUES ($1, $2, $3, $4)`,
        [targetUserId, cap.id, action, actorUserId],
      );
      await recordAccountAudit(client.query.bind(client), {
        eventType: action === 'GRANTED' ? 'EMPLOYEE_PERMISSION_GRANTED' : 'EMPLOYEE_PERMISSION_REVOKED',
        actorUserId,
        targetUserId,
        detail: { capabilityId: cap.id },
      });
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'update_failed' };
  }
}
