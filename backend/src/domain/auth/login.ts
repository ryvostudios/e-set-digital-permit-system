import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import { normalizeEmail } from '../accounts/credentials.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { createSession } from './sessions.js';

/**
 * Permit sign-in. Authentication only: it proves WHO the caller is and
 * opens a session. What they may do is decided afterwards, on every
 * request, by the existing model (account state, Team + Position
 * capabilities, the privileged grant log) - a `permit.users` row confers
 * nothing on its own.
 *
 * NO ENUMERATION. An unknown email, a DISABLED or DELETED account, an
 * account with no credential, and a wrong password all return the same
 * outcome after the same Argon2id verification cost. A forced password
 * change is NOT a refusal: the session opens and `/auth/me` reports the
 * outstanding change, exactly as before.
 *
 * LEGACY UPGRADE. A correct password for an imported Supabase bcrypt hash
 * is re-hashed with Argon2id and stored in the same transaction that opens
 * the session. The row is re-read under lock first, so a password reset,
 * disable or concurrent upgrade that landed after verification wins and
 * this sign-in is refused instead.
 */

export interface LoginDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

export type LoginOutcome = { outcome: 'ok'; token: string } | { outcome: 'invalid_credentials' };

export async function login(
  input: { email: string; password: string; remember: boolean },
  deps: LoginDeps,
): Promise<LoginOutcome> {
  const invalid: LoginOutcome = { outcome: 'invalid_credentials' };
  const found = await deps.query<{
    id: string;
    password_hash: string | null;
    password_scheme: string | null;
    state: string | null;
  }>(
    `SELECT u.id, u.password_hash, u.password_scheme, a.state
       FROM users u
       LEFT JOIN app_user_access a ON a.user_id = u.id
      WHERE u.email = $1`,
    [normalizeEmail(input.email)],
  );
  const row = found.rows[0];
  const usable = row !== undefined && row.state === 'ACTIVE';
  const verified = await verifyPassword(
    usable ? { hash: row.password_hash, scheme: row.password_scheme } : null,
    input.password,
  );
  if (!usable || !verified.ok) return invalid;

  const upgradedHash = verified.needsUpgrade ? await hashPassword(input.password) : null;
  return deps.withTransaction(async (client): Promise<LoginOutcome> => {
    const queryFn = client.query.bind(client) as QueryFn;
    const locked = await client.query<{ password_hash: string | null; state: string | null }>(
      `SELECT u.password_hash, a.state
         FROM users u
         JOIN app_user_access a ON a.user_id = u.id
        WHERE u.id = $1
          FOR UPDATE OF a, u`,
      [row.id],
    );
    const current = locked.rows[0];
    if (!current || current.state !== 'ACTIVE' || current.password_hash !== row.password_hash) return invalid;
    if (upgradedHash) {
      await client.query(
        `UPDATE users SET password_hash = $2, password_scheme = 'argon2id', updated_at = now()
          WHERE id = $1 AND password_scheme = 'bcrypt_legacy'`,
        [row.id, upgradedHash],
      );
    }
    return { outcome: 'ok', token: await createSession(queryFn, row.id, input.remember) };
  });
}
