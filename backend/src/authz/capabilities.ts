import { query, type QueryFn } from '../db/pool.js';
import { resolveUserIndividualCapabilities } from '../domain/accounts/userPermissions.js';

/**
 * Resolves the set of capability names granted to `userId` via their
 * CURRENT Team + Position assignment:
 *   user_team_positions -> team_positions -> team_position_capabilities -> capabilities
 * Capabilities are derived from the explicit Team + Position combination,
 * never from a Position alone. A user with no assignment, or whose
 * assignment grants nothing, resolves to an empty set - callers must
 * treat that as "no capabilities" (default-deny), never as an error to
 * be ignored.
 *
 * ONLY THE CURRENT ASSIGNMENT COUNTS. Migration 0019 keeps every
 * assignment a user has ever held and marks the retired ones with
 * `ended_at`, so authorization must filter to `ended_at IS NULL` - a
 * partial unique index guarantees there is at most one such row per
 * user. Without this filter a transferred employee would silently retain
 * the capabilities of every position they had ever held, which is
 * exactly the escalation the one-current-assignment rule exists to
 * prevent. History is for audit; only the current row grants anything.
 *
 * INDIVIDUAL GRANTS ARE UNIONED IN. A capability may also be held
 * personally rather than through a role (migration 0023's
 * `user_capability_grants`). Only capabilities explicitly marked
 * `individually_grantable` can be held that way - currently just
 * `permit.view_all` - and a database trigger refuses to attach any of
 * them to a Team + Position, so the two sources can never overlap and
 * this union cannot smuggle workflow authority in through the personal
 * side. Both are re-resolved from the database on every request, so a
 * revoke takes effect on the target's very next call.
 *
 * Privileged system authority (CEO / E-SET SITE_MANAGER) is deliberately
 * NOT resolved here and can never be obtained through this path - it
 * comes solely from `privileged_access_events` (authz/privilegedAccess.ts).
 */
export async function resolveUserCapabilities(userId: string): Promise<Set<string>> {
  const [organizational, individual] = await Promise.all([
    query<{ name: string }>(
      `SELECT DISTINCT c.name
         FROM user_team_positions utp
         JOIN team_position_capabilities tpc ON tpc.team_position_id = utp.team_position_id
         JOIN capabilities c ON c.id = tpc.capability_id
        WHERE utp.user_id = $1
          AND utp.ended_at IS NULL`,
      [userId],
    ),
    resolveUserIndividualCapabilities(userId),
  ]);
  return new Set([...organizational.rows.map((row) => row.name), ...individual]);
}

/**
 * The reverse lookup of `resolveUserCapabilities`: every distinct user
 * who holds AT LEAST ONE of `capabilityNames` through their CURRENT
 * assignment, via the same Team + Position -> Capabilities join. Used to
 * resolve workflow-notification recipients server-side
 * (domain/notifications/recipients.ts) - a client can never choose or
 * influence who receives a notification, only the authoritative
 * capability model can. `DISTINCT` is what prevents a user reachable
 * through more than one matching capability from being returned twice.
 *
 * The `ended_at IS NULL` filter matters just as much here: a transferred
 * employee must drop out of the CRO/HSE notification queue immediately,
 * not keep receiving permits addressed to a role they no longer hold.
 *
 * Individual grants are deliberately NOT unioned in here. This resolves
 * WHO SHOULD BE NOTIFIED about a workflow step, which is an
 * organizational duty; a personal "see every permit" permission is a
 * visibility grant and must not subscribe anyone to a review queue.
 *
 * Takes an injectable `queryFn` (rather than always using the module's
 * own pooled `query`) so a caller that needs this resolved INSIDE an
 * already-open transaction (see domain/permits/workflowSideEffects.ts)
 * can pass that transaction's own `client.query` - keeping recipient
 * resolution and the notification/outbox INSERTs it feeds into
 * consistent with the same in-flight transaction, not a separate
 * connection.
 */
export async function resolveUserIdsWithCapabilities(
  capabilityNames: readonly string[],
  queryFn: QueryFn = query,
): Promise<string[]> {
  if (capabilityNames.length === 0) return [];
  const result = await queryFn<{ user_id: string }>(
    `SELECT DISTINCT utp.user_id
       FROM user_team_positions utp
       JOIN team_position_capabilities tpc ON tpc.team_position_id = utp.team_position_id
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name = ANY($1)
        AND utp.ended_at IS NULL`,
    [capabilityNames],
  );
  return result.rows.map((row) => row.user_id);
}
