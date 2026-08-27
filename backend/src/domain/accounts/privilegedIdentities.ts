import { query, type QueryFn } from '../../db/pool.js';

/**
 * The authoritative personal identity of a PRIVILEGED SYSTEM ACCOUNT
 * (CEO, E-SET SITE_MANAGER).
 *
 * These accounts are not organizational employees: they have no Company,
 * no Team and no Position, so `workforce_profiles` structurally cannot
 * hold their name (its composite foreign key requires a Team + Position
 * the user actually holds). `privileged_identities` (migration 0019) is
 * the one place their display name lives.
 *
 * IDENTITY ONLY - NEVER AUTHORITY. A row here confers nothing. Whether a
 * user is currently CEO or SITE_MANAGER is derived exclusively from the
 * latest `privileged_access_events` row per role
 * (authz/privilegedAccess.ts). A named identity with no active grant has
 * no more authority than an unnamed one, so this table can never be used
 * to escalate.
 *
 * The name is server-authoritative: it is never derived from an email
 * address, an email domain, Supabase `user_metadata`, or any client
 * input beyond the explicit, validated value a CEO supplies when
 * establishing the account.
 */
export async function resolvePrivilegedDisplayName(
  userId: string,
  queryFn: QueryFn = query,
): Promise<string | null> {
  const result = await queryFn<{ display_name: string }>(
    'SELECT display_name FROM privileged_identities WHERE user_id = $1',
    [userId],
  );
  const name = result.rows[0]?.display_name;
  // A blank name is refused by the database, but resolving one would be
  // an unnamed signature on a document - fail closed rather than return
  // whitespace.
  return name && name.trim() !== '' ? name : null;
}

/**
 * Whether `userId` is a normal organizational employee. Used to fail
 * closed BEFORE attempting a privileged grant, so the caller gets a
 * precise refusal instead of a raw database exception from migration
 * 0019's guard. The guard remains the real enforcement; this is the
 * courteous check in front of it.
 */
export async function isWorkforceEmployee(
  userId: string,
  queryFn: QueryFn = query,
): Promise<boolean> {
  const result = await queryFn<{ user_id: string }>(
    'SELECT user_id FROM workforce_profiles WHERE user_id = $1',
    [userId],
  );
  return result.rows.length > 0;
}
