import { query } from '../db/pool.js';

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
