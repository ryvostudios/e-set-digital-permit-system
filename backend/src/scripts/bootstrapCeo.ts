import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { closePool, query, withTransaction, type QueryFn } from '../db/pool.js';
import { getSupabaseAdminClient } from '../lib/supabaseAdmin.js';

const bootstrapEnvSchema = z.object({
  BOOTSTRAP_CEO_EMAIL: z.string().trim().email().max(254),
  BOOTSTRAP_CEO_PASSWORD: z.string().min(12).max(256),
  // REQUIRED: a CEO is a privileged system account whose only identity
  // field is their authoritative personal display name (migration 0019).
  // There is no workforce profile to fall back on, and a name is never
  // derived from the email address.
  BOOTSTRAP_CEO_NAME: z.string().trim().min(1).max(120),
});

export interface BootstrapAdmin {
  createUser(input: { email: string; password: string; email_confirm: true }): Promise<{ user: { id: string } | null; error: boolean }>;
  findUserByEmail(email: string): Promise<{ id: string } | null>;
}

/**
 * Whether an Auth identity already belongs to a normal organizational
 * employee. Reconciling the bootstrap onto such an identity would make
 * one person simultaneously a workforce employee and the CEO - exactly
 * the combination migrations 0018/0019 forbid in both directions - so
 * the bootstrap refuses instead. Nothing is deleted or converted to make
 * it succeed; promoting an employee is not an automatic workflow.
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
  admin: BootstrapAdmin;
  claimToken?: string;
}

export type BootstrapCeoResult =
  | { outcome: 'ok'; userId: string; authUserCreated: boolean }
  | {
      outcome: 'conflict';
      reason: 'ceo_exists' | 'bootstrap_in_progress' | 'different_email_reserved' | 'email_belongs_to_employee';
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

async function findOrCreateAuthUser(admin: BootstrapAdmin, email: string, password: string) {
  const created = await admin.createUser({ email, password, email_confirm: true });
  if (created.user && !created.error) return { userId: created.user.id, created: true };
  const existing = await admin.findUserByEmail(email);
  if (existing) return { userId: existing.id, created: false };
  throw new Error('Supabase Auth identity could not be created or reconciled');
}

export async function bootstrapInitialCeo(
  input: { email: string; password: string; name: string },
  deps: BootstrapCeoDeps,
): Promise<BootstrapCeoResult> {
  if (await findActiveCeo(deps.query)) return { outcome: 'conflict', reason: 'ceo_exists' };
  const token = deps.claimToken ?? randomUUID();
  const conflict = await reserveBootstrap(deps.query, input.email, token);
  if (conflict) return conflict;

  const auth = await findOrCreateAuthUser(deps.admin, input.email, input.password);

  // The reconciliation path above may have adopted a PRE-EXISTING Auth
  // identity. If that identity is a normal employee, refuse before any
  // privileged row is written - the database would refuse the grant
  // anyway (migration 0019), but failing here keeps the bootstrap
  // reservation recoverable and the error precise.
  if (await isWorkforceEmployee(deps.query, auth.userId)) {
    return { outcome: 'conflict', reason: 'email_belongs_to_employee' };
  }

  await deps.query(
    `UPDATE initial_ceo_bootstrap SET auth_user_id = $2, updated_at = now()
      WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1`,
    [token, auth.userId],
  );

  const finalized = await deps.withTransaction(async (client) => {
    const reservation = await client.query<{ auth_user_id: string | null }>(
      `SELECT auth_user_id FROM initial_ceo_bootstrap
        WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1 FOR UPDATE`,
      [token],
    );
    if (reservation.rows[0]?.auth_user_id !== auth.userId || (await findActiveCeo(client.query.bind(client)))) return false;
    // `must_change_password` is TRUE for exactly the same reason it is on
    // every employee (service.ts) and every Site Manager
    // (privilegedManagement.ts): the password that reaches this point was
    // chosen by an OPERATOR and typed into an environment variable, so it
    // is a temporary credential someone other than the CEO has seen. The
    // CEO was previously the single account exempt from that rule - the
    // one account where it matters most. `credentials_changed_at` is a
    // signal only; migration 0017's trigger overwrites it with the
    // database's own now().
    await client.query(
      `INSERT INTO app_user_access (user_id, state, must_change_password, credentials_changed_at)
       VALUES ($1, 'ACTIVE', TRUE, now())
       ON CONFLICT (user_id) DO NOTHING`,
      [auth.userId],
    );
    const access = await client.query<{ state: 'ACTIVE' | 'DISABLED' }>(
      'SELECT state FROM app_user_access WHERE user_id = $1',
      [auth.userId],
    );
    if (access.rows[0]?.state !== 'ACTIVE') return false;
    // Re-checked INSIDE the transaction: the employee check above ran on
    // a separate connection, so this is the one that actually races with
    // concurrent provisioning. Migration 0019's trigger is the final
    // backstop on the grant itself.
    if (await isWorkforceEmployee(client.query.bind(client), auth.userId)) return false;
    // The CEO's authoritative personal identity. No company, team or
    // position is created - a privileged system account has none.
    await client.query(
      'INSERT INTO privileged_identities (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [auth.userId, input.name],
    );
    await client.query(
      `INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
       VALUES ($1, 'CEO', 'GRANTED', NULL, $2)`,
      [auth.userId, 'Initial CEO bootstrap via bootstrap:ceo CLI'],
    );
    const completed = await client.query(
      `UPDATE initial_ceo_bootstrap
          SET status = 'COMPLETED', claim_token = NULL, claimed_at = NULL,
              completed_at = now(), updated_at = now()
        WHERE singleton = TRUE AND status = 'RESERVED' AND claim_token = $1 RETURNING singleton`,
      [token],
    );
    return completed.rows.length === 1;
  });
  return finalized
    ? { outcome: 'ok', userId: auth.userId, authUserCreated: auth.created }
    : { outcome: 'conflict', reason: 'ceo_exists' };
}

function createAdminAdapter(): BootstrapAdmin | null {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  return {
    async createUser(input) {
      const { data, error } = await admin.auth.admin.createUser(input);
      return { user: data.user ? { id: data.user.id } : null, error: Boolean(error) };
    },
    async findUserByEmail(email) {
      const perPage = 200;
      for (let page = 1; ; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
        if (error) throw new Error('Supabase Auth identity lookup failed');
        const match = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
        if (match) return { id: match.id };
        if (data.users.length < perPage) return null;
      }
    },
  };
}

async function main(): Promise<void> {
  const parsed = bootstrapEnvSchema.safeParse(process.env);
  const admin = createAdminAdapter();
  if (!parsed.success || !admin) throw new Error('bootstrap configuration is incomplete');
  const result = await bootstrapInitialCeo(
    { email: parsed.data.BOOTSTRAP_CEO_EMAIL, password: parsed.data.BOOTSTRAP_CEO_PASSWORD, name: parsed.data.BOOTSTRAP_CEO_NAME },
    { query, withTransaction, admin },
  );
  if (result.outcome !== 'ok') throw new Error(`bootstrap refused: ${result.reason}`);
  console.log(`bootstrap:ceo: success for ${parsed.data.BOOTSTRAP_CEO_EMAIL}`);
  console.log('bootstrap:ceo: first-login password change is ENFORCED for this account; enable production MFA, then remove bootstrap credentials.');
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
