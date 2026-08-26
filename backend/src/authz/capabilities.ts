import { query, type QueryFn } from '../db/pool.js';

/**
 * Resolves the set of capability names granted to `userId` via their
 * Team + Position assignment(s):
 *   user_team_positions -> team_positions -> team_position_capabilities -> capabilities
 * Capabilities are derived from the explicit Team + Position combination,
 * never from a Position alone. A user with no assignments, or whose
 * assignments grant nothing, resolves to an empty set - callers must
 * treat that as "no capabilities" (default-deny), never as an error to
 * be ignored.
 */
export async function resolveUserCapabilities(userId: string): Promise<Set<string>> {
  const result = await query<{ name: string }>(
    `SELECT DISTINCT c.name
       FROM user_team_positions utp
       JOIN team_position_capabilities tpc ON tpc.team_position_id = utp.team_position_id
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE utp.user_id = $1`,
    [userId],
  );
  return new Set(result.rows.map((row) => row.name));
}

/**
 * The reverse lookup of `resolveUserCapabilities`: every distinct user
 * who holds AT LEAST ONE of `capabilityNames`, via the same Team +
 * Position -> Capabilities join. Used to resolve workflow-notification
 * recipients server-side (domain/notifications/recipients.ts) - a
 * client can never choose or influence who receives a notification,
 * only the authoritative capability model can. `DISTINCT` is what
 * prevents a user who holds more than one matching capability (or
 * reaches it via more than one Team + Position assignment) from being
 * returned twice - "avoid duplicate recipients where a user has
 * multiple assignments".
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
      WHERE c.name = ANY($1)`,
    [capabilityNames],
  );
  return result.rows.map((row) => row.user_id);
}
