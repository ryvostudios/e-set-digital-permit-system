import { query } from '../db/pool.js';

export type PrivilegedRole = 'CEO' | 'SITE_MANAGER';

/**
 * Resolves `userId`'s currently active privileged role grants by reading
 * the latest `privileged_access_events` row per role for that user - the
 * status is derived from the append-only event log, never stored as a
 * separate current-state flag (DATABASE.md). A user with no events, or
 * whose latest event per role is a REVOKED, holds no privileged access
 * for that role - callers must treat that as "not privileged"
 * (default-deny), never as an error to be ignored.
 *
 * This resolves status only. Granting/revoking privileged access is not
 * implemented here (see migration 0004's notes) - the exact grant/revoke
 * rules (only one active CEO, only CEO grants/revokes Site Manager, a
 * Site Manager cannot grant another Site Manager) have no service to
 * enforce yet.
 */
export async function resolvePrivilegedAccess(userId: string): Promise<Set<PrivilegedRole>> {
  const result = await query<{ role: PrivilegedRole; action: 'GRANTED' | 'REVOKED' }>(
    `SELECT DISTINCT ON (role) role, action
       FROM privileged_access_events
      WHERE user_id = $1
      ORDER BY role, ordinal DESC`,
    [userId],
  );
  const active = result.rows.filter((row) => row.action === 'GRANTED').map((row) => row.role);
  return new Set(active);
}
