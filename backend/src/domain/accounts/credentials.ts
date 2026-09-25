import type { QueryFn } from '../../db/pool.js';

/**
 * Credential writes on `permit.users`, shared by every account flow.
 * Each is called INSIDE the caller's transaction, so identity, account
 * state, assignments and audit commit or roll back together - there is no
 * second system to fall out of step with.
 *
 * Callers pass an already-computed Argon2id hash (domain/auth/passwords.ts);
 * nothing here ever receives a plaintext password.
 */

/** The one normalization applied to every login email (matches the users_email_normalized CHECK). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Creates a new identity. Returns null - never adopts - when the email is already taken. */
export async function insertUserWithPassword(queryFn: QueryFn, email: string, passwordHash: string): Promise<string | null> {
  const created = await queryFn<{ id: string }>(
    `INSERT INTO users (email, password_hash, password_scheme)
     VALUES ($1, $2, 'argon2id')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [normalizeEmail(email), passwordHash],
  );
  return created.rows[0]?.id ?? null;
}

export async function setUserPassword(queryFn: QueryFn, userId: string, passwordHash: string): Promise<void> {
  const updated = await queryFn(
    `UPDATE users SET password_hash = $2, password_scheme = 'argon2id', updated_at = now()
      WHERE id = $1 AND email IS NOT NULL RETURNING id`,
    [userId, passwordHash],
  );
  if (updated.rows.length !== 1) throw new Error('account identity has no usable login');
}

export async function setUserEmailAndPassword(
  queryFn: QueryFn,
  userId: string,
  email: string,
  passwordHash: string,
): Promise<void> {
  const updated = await queryFn(
    `UPDATE users SET email = $2, password_hash = $3, password_scheme = 'argon2id', updated_at = now()
      WHERE id = $1 RETURNING id`,
    [userId, normalizeEmail(email), passwordHash],
  );
  if (updated.rows.length !== 1) throw new Error('account identity disappeared');
}

/** Destroys the login of a deleted account; the identity row stays for its history. */
export async function destroyUserLogin(queryFn: QueryFn, userId: string): Promise<void> {
  await queryFn(
    `UPDATE users SET email = NULL, password_hash = NULL, password_scheme = NULL, updated_at = now()
      WHERE id = $1`,
    [userId],
  );
}

/** Whether an error is the users email uniqueness constraint (a concurrent claim of the same address). */
export function isEmailTaken(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === '23505'
    && (err as { constraint?: unknown }).constraint === 'users_email_key');
}
