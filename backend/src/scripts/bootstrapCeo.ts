import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { closePool, query, withTransaction, type QueryFn } from '../db/pool.js';
import { insertUserWithPassword, normalizeEmail } from '../domain/accounts/credentials.js';
import { hashPassword } from '../domain/auth/passwords.js';

/**
 * One-time creation of the initial Permit CEO - a Permit account in
 * `permit.users`, never an ESDMS user and never a shared identity across
 * applications (the same person may also hold an ESDMS account; the two
 * are unrelated).
 *
 * Run by an OPERATOR with the Permit migration credential
 * (`DATABASE_URL` pointed at permit_migrator for this single invocation):
 * the ordinary runtime login deliberately cannot write the privileged
 * grant log or the bootstrap state.
 */

const bootstrapEnvSchema = z.object({
  BOOTSTRAP_CEO_EMAIL: z.string().trim().email().max(254),
  BOOTSTRAP_CEO_PASSWORD: z.string().min(12).max(256),
  // REQUIRED: a CEO is a privileged system account whose only identity
  // field is their authoritative personal display name (migration 0019).
  // There is no workforce profile to fall back on, and a name is never
  // derived from the email address.
  BOOTSTRAP_CEO_NAME: z.string().trim().min(1).max(120),
});

/**
 * Whether an identity already belongs to a normal organizational
 * employee. Making that identity the CEO would make one person
 * simultaneously a workforce employee and the CEO - exactly the
 * combination migrations 0018/0019 forbid in both directions - so the
 * bootstrap refuses instead. Nothing is deleted or converted to make it
 * succeed; promoting an employee is not an automatic workflow.
 */
async function isWorkforceEmployee(queryFn: QueryFn, userId: string): Promise<boolean> {
  const result = await queryFn<{ user_id: string }>(
    'SELECT user_id FROM workforce_profiles WHERE user_id = $1',
    [userId],
  );
  return result.rows.length > 0;
}

export interface BootstrapCeoDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  claimToken?: string;
}

export type BootstrapCeoResult =
  | { outcome: 'ok'; userId: string }
  | {
      outcome: 'conflict';
      reason:
        | 'ceo_exists'
        | 'bootstrap_in_progress'
        | 'different_email_reserved'
        | 'email_belongs_to_employee'
        | 'email_unavailable';
    };

async function findActiveCeo(queryFn: QueryFn): Promise<string | null> {
  const result = await queryFn<{ user_id: string }>(
    `SELECT user_id FROM (
       SELECT DISTINCT ON (user_id) user_id, action
         FROM privileged_access_events WHERE role = 'CEO'
        ORDER BY user_id, ordinal DESC
     ) latest WHERE action = 'GRANTED' LIMIT 1`,
  );
  return result.rows[0]?.user_id ?? null;
}

async function reserveBootstrap(queryFn: QueryFn, email: string, token: string): Promise<BootstrapCeoResult | null> {
  const inserted = await queryFn(
    `INSERT INTO initial_ceo_bootstrap (singleton, email, status, claim_token, claimed_at)
     VALUES (TRUE, $1, 'RESERVED', $2, now())
     ON CONFLICT (singleton) DO NOTHING RETURNING singleton`,
    [email.toLowerCase(), token],
  );
  if (inserted.rows.length > 0) return null;

  const reclaimed = await queryFn(
    `UPDATE initial_ceo_bootstrap SET claim_token = $2, claimed_at = now(), updated_at = now()
      WHERE singleton = TRUE AND status = 'RESERVED' AND lower(email) = lower($1)
        AND claimed_at < now() - INTERVAL '5 minutes'
      RETURNING singleton`,
    [email, token],
  );
  if (reclaimed.rows.length > 0) return null;

  const existing = await queryFn<{ email: string; status: 'RESERVED' | 'COMPLETED' }>(
    'SELECT email, status FROM initial_ceo_bootstrap WHERE singleton = TRUE',
  );
  const row = existing.rows[0];
  if (row?.status === 'COMPLETED') return { outcome: 'conflict', reason: 'ceo_exists' };
  if (row && row.email.toLowerCase() !== email.toLowerCase()) return { outcome: 'conflict', reason: 'different_email_reserved' };
  return { outcome: 'conflict', reason: 'bootstrap_in_progress' };
}

/**
 * The CEO account is always a NEW identity. An email already in use is
 * never adopted: an employee's is refused as `email_belongs_to_employee`
 * (as before), and any other existing account - a Site Manager, a deleted
 * account's successor - as `email_unavailable`, so no existing identity
 * can be silently handed CEO authority.
 */
export async function bootstrapInitialCeo(
  input: { email: string; password: string; name: string },
  deps: BootstrapCeoDeps,
): Promise<BootstrapCeoResult> {
  if (await findActiveCeo(deps.query)) return { outcome: 'conflict', reason: 'ceo_exists' };
  const token = deps.claimToken ?? randomUUID();
  const conflict = await reserveBootstrap(deps.query, input.email, token);
  if (conflict) return conflict;

  const passwordHash = await hashPassword(input.password);
  return deps.withTransaction(async (client): Promise<BootstrapCeoResult> => {
    const queryFn = client.query.bind(client) as QueryFn;
    const reservation = await client.query<{ singleton: boolean }>(
      `SELECT singleton FROM initial_ceo_bootstrap
        WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1 FOR UPDATE`,
      [token],
    );
    if (reservation.rows.length !== 1 || (await findActiveCeo(queryFn))) {
      return { outcome: 'conflict', reason: 'ceo_exists' };
    }

    const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      normalizeEmail(input.email),
    ]);
    if (existing.rows[0]) {
      return (await isWorkforceEmployee(queryFn, existing.rows[0].id))
        ? { outcome: 'conflict', reason: 'email_belongs_to_employee' }
        : { outcome: 'conflict', reason: 'email_unavailable' };
    }
    const userId = await insertUserWithPassword(queryFn, input.email, passwordHash);
    if (!userId) return { outcome: 'conflict', reason: 'email_unavailable' };

    await client.query(
      `UPDATE initial_ceo_bootstrap SET auth_user_id = $2, updated_at = now()
        WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1`,
      [token, userId],
    );
    // `must_change_password` is TRUE for exactly the same reason it is on
    // every employee (service.ts) and every Site Manager
    // (privilegedManagement.ts): the password that reaches this point was
    // chosen by an OPERATOR and typed into an environment variable, so it
    // is a temporary credential someone other than the CEO has seen.
    // `credentials_changed_at` is a signal only; migration 0017's trigger
    // overwrites it with the database's own now().
    await client.query(
      `INSERT INTO app_user_access (user_id, state, must_change_password, credentials_changed_at)
       VALUES ($1, 'ACTIVE', TRUE, now())`,
      [userId],
    );
    // The CEO's authoritative personal identity. No company, team or
    // position is created - a privileged system account has none.
    await client.query('INSERT INTO privileged_identities (user_id, display_name) VALUES ($1, $2)', [
      userId,
      input.name,
    ]);
    await client.query(
      `INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
       VALUES ($1, 'CEO', 'GRANTED', NULL, $2)`,
      [userId, 'Initial CEO bootstrap via bootstrap:ceo CLI'],
    );
    const completed = await client.query(
      `UPDATE initial_ceo_bootstrap
          SET status = 'COMPLETED', claim_token = NULL, claimed_at = NULL,
              completed_at = now(), updated_at = now()
        WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1 RETURNING singleton`,
      [token],
    );
    if (completed.rows.length !== 1) throw new Error('bootstrap reservation changed during completion');
    return { outcome: 'ok', userId };
  });
}

async function main(): Promise<void> {
  const parsed = bootstrapEnvSchema.safeParse(process.env);
  if (!parsed.success) throw new Error('bootstrap configuration is incomplete');
  const result = await bootstrapInitialCeo(
    { email: parsed.data.BOOTSTRAP_CEO_EMAIL, password: parsed.data.BOOTSTRAP_CEO_PASSWORD, name: parsed.data.BOOTSTRAP_CEO_NAME },
    { query, withTransaction },
  );
  if (result.outcome !== 'ok') throw new Error(`bootstrap refused: ${result.reason}`);
  console.log(`bootstrap:ceo: success for ${parsed.data.BOOTSTRAP_CEO_EMAIL}`);
  console.log('bootstrap:ceo: first-login password change is ENFORCED for this account; now remove the bootstrap credentials from the environment.');
}

export async function runBootstrapCeoCli(deps: {
  execute?: () => Promise<void>;
  error?: (message: string) => void;
} = {}): Promise<boolean> {
  try {
    await (deps.execute ?? main)();
    return true;
  } catch {
    (deps.error ?? console.error)('bootstrap:ceo: failed safely');
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runBootstrapCeoCli()
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .finally(() => void closePool());
}
