import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import { normalizeEmail } from '../accounts/credentials.js';
import { failureFloorMs, verifyPassword } from './passwords.js';
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
 * outcome. Each attempt does ONE password KDF (passwords.ts): the account's
 * own verifier - also for a disabled account, which still never gets a
 * session - or one dummy Argon2id verification when nothing is verifiable.
 * Every refusal then ends no earlier than the measured failure floor, an
 * asynchronous timer that holds no CPU, admission slot, connection or
 * transaction. A forced password change is NOT a refusal: the session
 * opens and `/auth/me` reports the outstanding change, exactly as before.
 *
 * LEGACY UPGRADE. A correct password for an imported Supabase bcrypt hash
 * is re-hashed with Argon2id (in the same admission slot as the bcrypt
 * check) and stored in the same transaction that opens the session. The row is re-read under lock first, so a password reset,
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
  options: { signal?: AbortSignal | undefined } = {},
): Promise<LoginOutcome> {
  const startedAt = performance.now();
  const refuse = async (): Promise<LoginOutcome> => {
    const wait = failureFloorMs() - (performance.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return { outcome: 'invalid_credentials' };
  };
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
    row ? { hash: row.password_hash, scheme: row.password_scheme } : null,
    input.password,
    { signal: options.signal, rehashLegacy: usable },
  );
  if (!usable || !verified.ok) return refuse();

  const upgradedHash = verified.upgradedHash ?? null;
  const outcome = await deps.withTransaction(async (client): Promise<LoginOutcome | null> => {
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
    if (!current || current.state !== 'ACTIVE' || current.password_hash !== row.password_hash) return null;
    if (upgradedHash) {
      await client.query(
        `UPDATE users SET password_hash = $2, password_scheme = 'argon2id', updated_at = now()
          WHERE id = $1 AND password_scheme = 'bcrypt_legacy'`,
        [row.id, upgradedHash],
      );
    }
    return { outcome: 'ok', token: await createSession(queryFn, row.id, input.remember) };
  });
  return outcome ?? refuse();
}
