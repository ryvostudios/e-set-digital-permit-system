import type { QueryFn } from '../../db/pool.js';
import { normalizeEmail } from '../accounts/credentials.js';
import { isSupportedLegacyHash } from './passwords.js';

/**
 * THE IDENTITY IMPORT CONTRACT for moving standalone Permit users out of
 * Supabase Auth into `permit.users` (used by the data-migration
 * rehearsal; nothing here reads Supabase itself).
 *
 * Source fields, and ONLY these, are taken from each `auth.users` row:
 *   id                  -> permit.users.id (preserved exactly)
 *   email               -> permit.users.email (normalized)
 *   encrypted_password  -> permit.users.password_hash (scheme bcrypt_legacy)
 *   created_at          -> permit.users.created_at
 * No other Supabase Auth internals (metadata, factors, sessions, tokens,
 * confirmation state) are migrated.
 *
 * FAIL CLOSED. The whole import is refused - nothing is written - if any
 * row has an invalid id, a missing email, an email that collides with
 * another after normalization, a duplicate id, or a password hash whose
 * format is not the supported bcrypt shape. A row with no password at all
 * is also refused unless the operator has explicitly approved the
 * controlled-reset path (`allowAccountsWithoutPassword`), in which case
 * that account is imported with NO credential and can only sign in after
 * a manager issues a temporary password.
 *
 * Problems name the user id and the kind of problem, never a hash. Hash
 * formats are reported only as aggregate prefix counts (for example
 * `$2a$`: 42).
 */

export interface LegacyAuthUser {
  id: string;
  email: string | null;
  encryptedPassword: string | null;
  createdAt: string;
}

export type LegacyImportProblemKind =
  | 'invalid_id'
  | 'duplicate_id'
  | 'missing_email'
  | 'duplicate_email'
  | 'unsupported_hash'
  | 'missing_password'
  /** A Permit row references a user id that has no source identity (data import). */
  | 'missing_identity';

export interface LegacyImportProblem {
  kind: LegacyImportProblemKind;
  userId: string;
}

export interface PlannedLegacyUser {
  id: string;
  email: string;
  passwordHash: string | null;
  createdAt: string;
}

export type LegacyImportPlan =
  | { ok: true; users: PlannedLegacyUser[]; hashPrefixCounts: Record<string, number>; withoutPassword: number }
  | { ok: false; problems: LegacyImportProblem[]; hashPrefixCounts: Record<string, number> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The algorithm/cost prefix of a hash (e.g. `$2a$10$`), or a fixed label - never any digest material. */
function hashPrefix(hash: string | null): string {
  if (!hash) return '(none)';
  const match = /^\$[A-Za-z0-9]{1,10}\$(\d{2}\$)?/.exec(hash);
  return match ? match[0] : '(unrecognized)';
}

export function planLegacyUserImport(
  rows: LegacyAuthUser[],
  options: { allowAccountsWithoutPassword?: boolean } = {},
): LegacyImportPlan {
  const problems: LegacyImportProblem[] = [];
  const hashPrefixCounts: Record<string, number> = {};
  const ids = new Set<string>();
  const emails = new Map<string, string>();
  const users: PlannedLegacyUser[] = [];
  let withoutPassword = 0;

  for (const row of rows) {
    const prefix = hashPrefix(row.encryptedPassword);
    hashPrefixCounts[prefix] = (hashPrefixCounts[prefix] ?? 0) + 1;

    const id = row.id.toLowerCase();
    if (!UUID.test(id)) {
      problems.push({ kind: 'invalid_id', userId: row.id });
      continue;
    }
    if (ids.has(id)) problems.push({ kind: 'duplicate_id', userId: id });
    ids.add(id);

    const email = row.email ? normalizeEmail(row.email) : '';
    if (!email || !email.includes('@') || email.length > 254) {
      problems.push({ kind: 'missing_email', userId: id });
    } else if (emails.has(email)) {
      problems.push({ kind: 'duplicate_email', userId: id });
    } else {
      emails.set(email, id);
    }

    const hash = row.encryptedPassword?.trim() ? row.encryptedPassword : null;
    if (hash === null) {
      if (options.allowAccountsWithoutPassword) withoutPassword += 1;
      else problems.push({ kind: 'missing_password', userId: id });
    } else if (!isSupportedLegacyHash(hash)) {
      problems.push({ kind: 'unsupported_hash', userId: id });
    }
    users.push({ id, email, passwordHash: hash, createdAt: row.createdAt });
  }

  return problems.length > 0
    ? { ok: false, problems, hashPrefixCounts }
    : { ok: true, users, hashPrefixCounts, withoutPassword };
}

/**
 * Writes a validated plan into `permit.users` inside the CALLER'S
 * transaction (run as permit_migrator), then reconciles the row count. Any
 * failure throws, so the caller's transaction rolls the whole import back.
 */
export async function importLegacyUsers(
  queryFn: QueryFn,
  plan: Extract<LegacyImportPlan, { ok: true }>,
): Promise<number> {
  for (const user of plan.users) {
    await queryFn(
      `INSERT INTO users (id, email, password_hash, password_scheme, created_at, updated_at)
       VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE 'bcrypt_legacy' END, $4, $4)`,
      [user.id, user.email, user.passwordHash, user.createdAt],
    );
  }
  const reconciled = await queryFn<{ count: number }>(
    'SELECT count(*)::int AS count FROM users WHERE id = ANY($1::uuid[])',
    [plan.users.map((user) => user.id)],
  );
  if (reconciled.rows[0]?.count !== plan.users.length) {
    throw new Error('imported identity count does not match the plan');
  }
  return plan.users.length;
}
