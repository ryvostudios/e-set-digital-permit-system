import type { PoolClient } from 'pg';
import { query, withTransaction, type QueryFn } from '../../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { insertUserWithPassword, setUserPassword } from './credentials.js';

/**
 * Employee account provisioning and password management.
 *
 * ONE DATABASE, ONE TRANSACTION. Credentials live in `permit.users`,
 * account state in `app_user_access`, and both are in the same PostgreSQL
 * database, so every operation below commits identity, credential, account
 * state, sessions and audit together - or nothing at all. There is no
 * half-provisioned identity, orphan, or out-of-order credential to recover
 * from. (The standalone design ordered its steps around Supabase Auth,
 * which could not share a transaction; that is gone.)
 *
 * Passwords are hashed with Argon2id BEFORE the transaction opens, so no
 * row lock is ever held across the hashing cost. No password, temporary
 * password, hash or session token is stored in an application table other
 * than `users`, returned, audited, or logged by anything in this file.
 */

export interface AccountsServiceDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

export type AccountAuditEventType =
  | 'EMPLOYEE_ACCOUNT_CREATED'
  | 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER'
  | 'EMPLOYEE_PASSWORD_CHANGED'
  | 'EMPLOYEE_DISPLAY_NAME_CHANGED'
  | 'EMPLOYEE_EMAIL_CHANGED'
  | 'EMPLOYEE_COMPANY_CHANGED'
  | 'EMPLOYEE_TEAM_POSITION_CHANGED'
  | 'EMPLOYEE_PERMISSION_GRANTED'
  | 'EMPLOYEE_PERMISSION_REVOKED'
  | 'EMPLOYEE_DISABLED'
  | 'EMPLOYEE_REENABLED'
  | 'EMPLOYEE_ACCOUNT_DELETED';

/**
 * The structured, non-free-text detail migration 0023 added. Every field
 * is a foreign key to reference data, so an administrative history can
 * say WHICH company or capability changed without any column that could
 * ever hold a password, a token, or an email address.
 */
export interface AccountAuditDetail {
  previousCompanyId?: string | null;
  newCompanyId?: string | null;
  previousTeamPositionId?: string | null;
  newTeamPositionId?: string | null;
  capabilityId?: string | null;
}

/**
 * Appends one account audit row. The table has no free-text column
 * (migration 0017), so there is nowhere for a secret to be written even
 * by mistake - the recorded facts are the event type, the actor, the
 * target, and the database's own timestamp.
 */
export async function recordAccountAudit(
  queryFn: QueryFn,
  input: {
    eventType: AccountAuditEventType;
    actorUserId: string;
    targetUserId: string;
    detail?: AccountAuditDetail;
  },
): Promise<void> {
  const detail = input.detail ?? {};
  await queryFn(
    `INSERT INTO account_audit_events (
       event_type, actor_user_id, target_user_id,
       previous_company_id, new_company_id,
       previous_team_position_id, new_team_position_id, capability_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.eventType,
      input.actorUserId,
      input.targetUserId,
      detail.previousCompanyId ?? null,
      detail.newCompanyId ?? null,
      detail.previousTeamPositionId ?? null,
      detail.newTeamPositionId ?? null,
      detail.capabilityId ?? null,
    ],
  );
}

export interface CreateEmployeeInput {
  email: string;
  temporaryPassword: string;
  displayName: string;
  companyId: string;
  teamPositionId: string;
}

export type CreateEmployeeOutcome =
  | { outcome: 'ok'; userId: string }
  | { outcome: 'conflict'; reason: 'email_unavailable' }
  | { outcome: 'failed'; reason: 'provisioning_rolled_back' };

/**
 * Provisions a normal employee account: identity + credential, account
 * state (ACTIVE, owing a password change), Team + Position assignment,
 * workforce profile and the audit event, in ONE transaction.
 *
 * An existing email is NEVER adopted: `insertUserWithPassword` returns
 * nothing for a taken address and this reports a conflict, so account
 * management can never reach an identity it does not own.
 */
export async function createEmployeeAccount(
  actorUserId: string,
  input: CreateEmployeeInput,
  deps: AccountsServiceDeps,
): Promise<CreateEmployeeOutcome> {
  const passwordHash = await hashPassword(input.temporaryPassword);
  try {
    const userId = await deps.withTransaction(async (client) => {
      const queryFn = client.query.bind(client) as QueryFn;
      const id = await insertUserWithPassword(queryFn, input.email, passwordHash);
      if (!id) return null;
      // `credentials_changed_at` is written as a SIGNAL only - migration
      // 0017's trigger replaces whatever is supplied with the database's
      // own now(), so no application clock value can be persisted.
      await client.query(
        `INSERT INTO app_user_access (user_id, state, must_change_password, credentials_changed_at)
         VALUES ($1, 'ACTIVE', TRUE, now())`,
        [id],
      );
      await client.query(
        'INSERT INTO user_team_positions (user_id, team_position_id) VALUES ($1, $2)',
        [id, input.teamPositionId],
      );
      // The profile's primary assignment is the one just inserted, so
      // migration 0016's composite foreign key is satisfied by
      // construction and the signing designation can never point at an
      // assignment this user does not hold.
      await client.query(
        `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
         VALUES ($1, $2, $3, $4)`,
        [id, input.displayName, input.teamPositionId, input.companyId],
      );
      await recordAccountAudit(queryFn, {
        eventType: 'EMPLOYEE_ACCOUNT_CREATED',
        actorUserId,
        targetUserId: id,
      });
      return id;
    });
    return userId ? { outcome: 'ok', userId } : { outcome: 'conflict', reason: 'email_unavailable' };
  } catch {
    return { outcome: 'failed', reason: 'provisioning_rolled_back' };
  }
}

export type ResetEmployeePasswordOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'not_manageable' }
  | { outcome: 'failed'; reason: 'state_update_failed' };

/**
 * Sets a new temporary password on an existing employee account. In one
 * transaction: the credential is replaced, the account is gated behind a
 * forced password change, its credential generation advances, EVERY
 * existing session of the account is revoked, and the reset is audited.
 * The employee must sign in again with the temporary password.
 *
 * Target existence is checked against `app_user_access`, so this can
 * never be used to probe for identities that were never provisioned into
 * this application. A privileged account (CEO / SITE_MANAGER) and the
 * caller themself are never manageable here.
 */
export async function resetEmployeePassword(
  actorUserId: string,
  targetUserId: string,
  temporaryPassword: string,
  deps: AccountsServiceDeps,
): Promise<ResetEmployeePasswordOutcome> {
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    return await deps.withTransaction(async (client): Promise<ResetEmployeePasswordOutcome> => {
      const queryFn = client.query.bind(client) as QueryFn;
      const locked = await client.query<{ user_id: string }>(
        `SELECT user_id
           FROM app_user_access
          WHERE user_id = $1
          FOR UPDATE`,
        [targetUserId],
      );
      if (locked.rows.length === 0) return { outcome: 'not_found' };
      if (actorUserId === targetUserId) return { outcome: 'not_manageable' };

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
      if (privileged.rows[0]?.protected) return { outcome: 'not_manageable' };

      await setUserPassword(queryFn, targetUserId, passwordHash);
      await client.query(
        `UPDATE app_user_access
            SET must_change_password = TRUE,
                credential_reset_pending = FALSE,
                credential_version = credential_version + 1,
                credentials_changed_at = now()
          WHERE user_id = $1`,
        [targetUserId],
      );
      await revokeUserSessions(queryFn, targetUserId);
      await recordAccountAudit(queryFn, {
        eventType: 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER',
        actorUserId,
        targetUserId,
      });
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }
}

export type ChangeOwnPasswordOutcome =
  | { outcome: 'ok' }
  | { outcome: 'refused'; reason: 'no_password_change_required' }
  | { outcome: 'invalid'; reason: 'password_unchanged' }
  | { outcome: 'failed'; reason: 'state_update_failed' };

/**
 * The authenticated user replaces their own password. The target is
 * always the caller's own verified identity - this function takes no
 * target parameter at all, so there is nothing for a request body to
 * influence.
 *
 * ONLY REACHABLE WHILE A CHANGE IS OWED (`must_change_password`): a first
 * sign-in on a temporary password, a manager reset, or an email
 * transition. There is deliberately no "change my password whenever I
 * like" feature, so this is refused before anything is touched. The caller
 * has just signed in with the temporary password this session was created
 * from; the new one must differ from it.
 *
 * In one transaction: the new Argon2id credential replaces the old one,
 * the forced-change gate clears, every OTHER session of the account is
 * revoked (this one continues), and the change is audited.
 */
export async function changeOwnPassword(
  userId: string,
  newPassword: string,
  deps: AccountsServiceDeps,
  currentSessionId?: string,
): Promise<ChangeOwnPasswordOutcome> {
  let credential: { password_hash: string | null; password_scheme: string | null };
  try {
    const captured = await deps.query<{
      must_change_password: boolean;
      password_hash: string | null;
      password_scheme: string | null;
    }>(
      `SELECT a.must_change_password, u.password_hash, u.password_scheme
         FROM app_user_access a
         JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1`,
      [userId],
    );
    const row = captured.rows[0];
    if (!row) return { outcome: 'failed', reason: 'state_update_failed' };
    if (!row.must_change_password) return { outcome: 'refused', reason: 'no_password_change_required' };
    credential = row;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }

  const same = await verifyPassword({ hash: credential.password_hash, scheme: credential.password_scheme }, newPassword);
  if (same.ok) return { outcome: 'invalid', reason: 'password_unchanged' };
  const passwordHash = await hashPassword(newPassword);

  try {
    return await deps.withTransaction(async (client): Promise<ChangeOwnPasswordOutcome> => {
      const queryFn = client.query.bind(client) as QueryFn;
      const locked = await client.query<{ must_change_password: boolean; password_hash: string | null }>(
        `SELECT a.must_change_password, u.password_hash
           FROM app_user_access a
           JOIN users u ON u.id = a.user_id
          WHERE a.user_id = $1
          FOR UPDATE OF a, u`,
        [userId],
      );
      const activeSession = currentSessionId ? await client.query(
        `SELECT s.id FROM user_sessions s JOIN app_user_access a ON a.user_id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
            AND s.expires_at > clock_timestamp() AND a.state = 'ACTIVE' FOR UPDATE OF s`,
        [currentSessionId, userId],
      ) : null;
      if (!activeSession?.rows.length) return { outcome: 'failed', reason: 'state_update_failed' };
      const current = locked.rows[0];
      // A manager reset (or another change) landed in between: this
      // request no longer describes the account, so it changes nothing.
      if (!current?.must_change_password || current.password_hash !== credential.password_hash) {
        return { outcome: 'failed', reason: 'state_update_failed' };
      }
      await setUserPassword(queryFn, userId, passwordHash);
      await client.query(
        `UPDATE app_user_access
            SET must_change_password = FALSE,
                credential_version = credential_version + 1,
                credentials_changed_at = now()
          WHERE user_id = $1`,
        [userId],
      );
      await revokeUserSessions(queryFn, userId, currentSessionId);
      await recordAccountAudit(queryFn, {
        eventType: 'EMPLOYEE_PASSWORD_CHANGED',
        actorUserId: userId,
        targetUserId: userId,
      });
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }
}

export const defaultAccountsServiceDeps = (): AccountsServiceDeps => ({ query, withTransaction });
