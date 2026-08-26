import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { query, withTransaction, type QueryFn } from '../../db/pool.js';

/**
 * Employee account provisioning and password management.
 *
 * CROSS-SYSTEM BY NATURE: credentials live in Supabase Auth, account
 * state lives in PostgreSQL, and the two are NOT one distributed
 * transaction. Rather than pretending otherwise, every operation below
 * commits in an order chosen so that the only reachable intermediate
 * states are SAFE ones - an account that cannot be used, never an
 * account that can be used but should not be. Each function documents
 * its own failure ordering and how it recovers.
 *
 * No password, temporary password, or token is ever stored, returned,
 * or logged by anything in this file. `AccountAdmin` deliberately takes
 * the password as an argument and returns nothing that contains it.
 */

/** The Supabase Auth Admin operations this domain needs, narrowed to exactly what it uses so no route can reach the wider admin client through it. */
export interface AccountAdmin {
  /** Creates a brand-new Auth identity. MUST fail (never reconcile) when the email already exists - see `createEmployeeAccount`. */
  createUser(input: { email: string; password: string }): Promise<
    { ok: true; userId: string } | { ok: false; reason: 'email_unavailable' | 'failed' }
  >;
  /** Sets a new password on an existing Auth identity. */
  setPassword(userId: string, password: string): Promise<{ ok: boolean }>;
  /** Best-effort compensation for a half-provisioned identity. */
  deleteUser(userId: string): Promise<{ ok: boolean }>;
}

export interface AccountsServiceDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  admin: AccountAdmin;
  authAdminTimeoutMs: number;
}

export interface CredentialResetTransactionTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

/** Transaction-local guardrails; no unrelated workflow transaction changes. */
export function credentialResetTransactionTimeouts(authAdminTimeoutMs: number): CredentialResetTransactionTimeouts {
  return {
    lockTimeoutMs: Math.min(2_000, authAdminTimeoutMs),
    statementTimeoutMs: authAdminTimeoutMs + 5_000,
    idleInTransactionTimeoutMs: authAdminTimeoutMs + 2_000,
  };
}

async function boundCredentialResetTransaction(client: PoolClient, authAdminTimeoutMs: number): Promise<void> {
  const timeouts = credentialResetTransactionTimeouts(authAdminTimeoutMs);
  await client.query(
    `SELECT set_config('lock_timeout', $1, TRUE),
            set_config('statement_timeout', $2, TRUE),
            set_config('idle_in_transaction_session_timeout', $3, TRUE)`,
    [
      `${timeouts.lockTimeoutMs}ms`,
      `${timeouts.statementTimeoutMs}ms`,
      `${timeouts.idleInTransactionTimeoutMs}ms`,
    ],
  );
}

export type AccountAuditEventType =
  | 'EMPLOYEE_ACCOUNT_CREATED'
  | 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER'
  | 'EMPLOYEE_PASSWORD_CHANGED';

/**
 * Appends one account audit row. The table has no free-text column
 * (migration 0017), so there is nowhere for a secret to be written even
 * by mistake - the recorded facts are the event type, the actor, the
 * target, and the database's own timestamp.
 */
async function recordAccountAudit(
  queryFn: QueryFn,
  input: { eventType: AccountAuditEventType; actorUserId: string; targetUserId: string },
): Promise<void> {
  await queryFn(
    `INSERT INTO account_audit_events (event_type, actor_user_id, target_user_id)
     VALUES ($1, $2, $3)`,
    [input.eventType, input.actorUserId, input.targetUserId],
  );
}

export interface CreateEmployeeInput {
  email: string;
  temporaryPassword: string;
  displayName: string;
  teamPositionId: string;
}

export type CreateEmployeeOutcome =
  | { outcome: 'ok'; userId: string }
  | { outcome: 'conflict'; reason: 'email_unavailable' }
  | { outcome: 'failed'; reason: 'auth_create_failed' }
  | { outcome: 'failed'; reason: 'provisioning_rolled_back' }
  | { outcome: 'failed'; reason: 'provisioning_orphan_requires_operator'; orphanUserId: string };

/**
 * Provisions a normal employee account.
 *
 * ORDER AND FAILURE DESIGN:
 *   1. Create the Auth identity FIRST. At this instant the identity can
 *      authenticate against Supabase but has NO `app_user_access` row,
 *      and `requireAuth` fails closed on a missing row - so it cannot
 *      reach a single application endpoint.
 *   2. Insert every PostgreSQL row in ONE transaction (access row,
 *      Team + Position assignment, workforce profile, audit event). All
 *      four are real Postgres writes, so they are genuinely atomic with
 *      each other: there is no state where an account exists with an
 *      assignment but no profile, or with a profile whose primary
 *      assignment it does not hold (migration 0016's composite foreign
 *      key would refuse that anyway).
 *   3. If step 2 fails, COMPENSATE by deleting the Auth identity created
 *      in step 1. If that compensation itself fails, the identity is
 *      still harmless for exactly the reason in step 1 - it has no
 *      application access - and the caller gets a distinct outcome
 *      naming the orphan so an operator can clean it up.
 *
 * An existing email is NEVER adopted. Reconciling onto an existing Auth
 * identity here would let account management reach an identity it does
 * not own - including a governed one - so `createUser` must fail on a
 * duplicate and this function reports a conflict instead.
 */
export async function createEmployeeAccount(
  actorUserId: string,
  input: CreateEmployeeInput,
  deps: AccountsServiceDeps,
): Promise<CreateEmployeeOutcome> {
  const created = await deps.admin.createUser({
    email: input.email,
    password: input.temporaryPassword,
  });
  if (!created.ok) {
    return created.reason === 'email_unavailable'
      ? { outcome: 'conflict', reason: 'email_unavailable' }
      : { outcome: 'failed', reason: 'auth_create_failed' };
  }

  const userId = created.userId;
  try {
    await deps.withTransaction(async (client) => {
      // `credentials_changed_at` is written as a SIGNAL only - migration
      // 0017's trigger replaces whatever is supplied with the database's
      // own now(), so no application clock value can be persisted.
      await client.query(
        `INSERT INTO app_user_access (user_id, state, must_change_password, credentials_changed_at)
         VALUES ($1, 'ACTIVE', TRUE, now())`,
        [userId],
      );
      await client.query(
        'INSERT INTO user_team_positions (user_id, team_position_id) VALUES ($1, $2)',
        [userId, input.teamPositionId],
      );
      // The profile's primary assignment is the one just inserted, so
      // migration 0016's composite foreign key is satisfied by
      // construction and the signing designation can never point at an
      // assignment this user does not hold.
      await client.query(
        `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
         VALUES ($1, $2, $3)`,
        [userId, input.displayName, input.teamPositionId],
      );
      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_ACCOUNT_CREATED',
        actorUserId,
        targetUserId: userId,
      });
    });
  } catch {
    const removed = await deps.admin.deleteUser(userId);
    return removed.ok
      ? { outcome: 'failed', reason: 'provisioning_rolled_back' }
      : { outcome: 'failed', reason: 'provisioning_orphan_requires_operator', orphanUserId: userId };
  }

  return { outcome: 'ok', userId };
}

export type ResetEmployeePasswordOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'not_manageable' }
  | { outcome: 'failed'; reason: 'auth_update_failed' }
  | { outcome: 'failed'; reason: 'state_update_failed' }
  | { outcome: 'failed'; reason: 'credential_operation_superseded' };

/**
 * Sets a new temporary password on an existing employee account.
 *
 * ORDER AND FAILURE DESIGN: a short first transaction locks the account,
 * advances its credential generation and commits the forced gate BEFORE
 * Supabase Auth is touched. Existing JWTs therefore lose normal access
 * even if every later step fails. A second version-checked transaction
 * serializes the external Auth update for this account; it deliberately
 * holds the row lock across that call so two resets cannot publish their
 * passwords out of generation order. The Auth transport genuinely aborts
 * at `SUPABASE_AUTH_ADMIN_TIMEOUT_MS`; transaction-local lock, statement,
 * and idle-in-transaction guards bound the database resources as defense
 * in depth. With defaults, lock acquisition waits at most 2 seconds, Auth
 * occupies the acquired lock for at most 8 seconds, and PostgreSQL kills an
 * unexpectedly idle transaction after 10 seconds. This is not a distributed
 * transaction: Auth success followed by audit failure leaves the already-
 * committed gate closed and the operation safely retryable.
 *
 * Target existence is checked against `app_user_access` rather than
 * Supabase, so this can never be used to probe Auth for identities that
 * were never provisioned into this application.
 */
export async function resetEmployeePassword(
  actorUserId: string,
  targetUserId: string,
  temporaryPassword: string,
  deps: AccountsServiceDeps,
): Promise<ResetEmployeePasswordOutcome> {
  let credentialVersion: string;
  try {
    const gated = await deps.withTransaction(async (client) => {
      const locked = await client.query<{ user_id: string }>(
        `SELECT user_id
           FROM app_user_access
          WHERE user_id = $1
          FOR UPDATE`,
        [targetUserId],
      );
      if (locked.rows.length === 0) return { outcome: 'not_found' as const };
      if (actorUserId === targetUserId) return { outcome: 'not_manageable' as const };

      const privileged = await client.query<{ protected: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM (
               SELECT DISTINCT ON (role) role, action
                 FROM privileged_access_events
                WHERE user_id = $1
                ORDER BY role, ordinal DESC
             ) latest
            WHERE latest.action = 'GRANTED'
         ) AS protected`,
        [targetUserId],
      );
      if (privileged.rows[0]?.protected) return { outcome: 'not_manageable' as const };

      const marked = await client.query<{ credential_version: string }>(
        `UPDATE app_user_access
            SET must_change_password = TRUE,
                credential_reset_pending = TRUE,
                credential_version = credential_version + 1,
                credentials_changed_at = now()
          WHERE user_id = $1
          RETURNING credential_version::text AS credential_version`,
        [targetUserId],
      );
      if (marked.rows.length !== 1) throw new Error('account state row disappeared during reset');
      return { outcome: 'gated' as const, credentialVersion: marked.rows[0]!.credential_version };
    });
    if (gated.outcome !== 'gated') return gated;
    credentialVersion = gated.credentialVersion;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }

  try {
    return await deps.withTransaction(async (client): Promise<ResetEmployeePasswordOutcome> => {
      await boundCredentialResetTransaction(client, deps.authAdminTimeoutMs);
      const current = await client.query<{ credential_version: string; credential_reset_pending: boolean }>(
        `SELECT credential_version::text AS credential_version, credential_reset_pending
           FROM app_user_access
          WHERE user_id = $1
          FOR UPDATE`,
        [targetUserId],
      );
      const row = current.rows[0];
      if (!row || row.credential_version !== credentialVersion || !row.credential_reset_pending) {
        return { outcome: 'failed', reason: 'credential_operation_superseded' };
      }

      const updated = await deps.admin.setPassword(targetUserId, temporaryPassword);
      if (!updated.ok) return { outcome: 'failed', reason: 'auth_update_failed' };

      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER',
        actorUserId,
        targetUserId,
      });
      const completed = await client.query(
        `UPDATE app_user_access
            SET credential_reset_pending = FALSE
          WHERE user_id = $1
            AND credential_version = $2
          RETURNING user_id`,
        [targetUserId, credentialVersion],
      );
      if (completed.rows.length !== 1) throw new Error('credential operation changed during reset completion');
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }
}

export type ChangeOwnPasswordOutcome =
  | { outcome: 'ok' }
  | { outcome: 'failed'; reason: 'auth_update_failed' }
  | { outcome: 'failed'; reason: 'state_update_failed' }
  | { outcome: 'failed'; reason: 'manager_reset_in_progress' }
  | { outcome: 'failed'; reason: 'credential_operation_superseded' };

/**
 * The authenticated user replaces their own password. The target is
 * always the caller's own verified identity - this function takes no
 * target parameter at all, so there is nothing for a request body to
 * influence.
 *
 * ORDER AND FAILURE DESIGN: Auth first, then application state. If the
 * state update fails after Auth succeeded, the user simply still owes a
 * password change and can sign in with the password they just chose and
 * repeat the operation - idempotent, recoverable, and fail-closed
 * (access stays withheld). The reverse order could clear the forced-
 * change flag for a password that was never actually set, handing an
 * account normal access while its temporary password still worked.
 */
export async function changeOwnPassword(
  userId: string,
  newPassword: string,
  deps: AccountsServiceDeps,
): Promise<ChangeOwnPasswordOutcome> {
  let credentialVersion: string;
  try {
    const captured = await deps.query<{ credential_version: string; credential_reset_pending: boolean }>(
      `SELECT credential_version::text AS credential_version, credential_reset_pending
         FROM app_user_access
        WHERE user_id = $1`,
      [userId],
    );
    const row = captured.rows[0];
    if (!row) return { outcome: 'failed', reason: 'state_update_failed' };
    if (row.credential_reset_pending) return { outcome: 'failed', reason: 'manager_reset_in_progress' };
    credentialVersion = row.credential_version;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }

  const updated = await deps.admin.setPassword(userId, newPassword);
  if (!updated.ok) return { outcome: 'failed', reason: 'auth_update_failed' };

  try {
    const result = await deps.withTransaction(async (client): Promise<ChangeOwnPasswordOutcome> => {
      const locked = await client.query<{ credential_version: string; credential_reset_pending: boolean }>(
        `SELECT credential_version::text AS credential_version, credential_reset_pending
           FROM app_user_access
          WHERE user_id = $1
          FOR UPDATE`,
        [userId],
      );
      const current = locked.rows[0];
      if (!current || current.credential_version !== credentialVersion || current.credential_reset_pending) {
        return { outcome: 'failed', reason: 'credential_operation_superseded' as const };
      }

      const cleared = await client.query(
        `UPDATE app_user_access
            SET must_change_password = FALSE, credentials_changed_at = now()
          WHERE user_id = $1
            AND credential_version = $2
            AND credential_reset_pending = FALSE
          RETURNING user_id`,
        [userId, credentialVersion],
      );
      if (cleared.rows.length !== 1) throw new Error('account state row disappeared during password change');
      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_PASSWORD_CHANGED',
        actorUserId: userId,
        targetUserId: userId,
      });
      return { outcome: 'ok' as const };
    });
    return result;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }
}

export const defaultAccountsServiceDeps = (admin: AccountAdmin): AccountsServiceDeps => ({
  query,
  withTransaction,
  admin,
  authAdminTimeoutMs: env.SUPABASE_AUTH_ADMIN_TIMEOUT_MS,
});
