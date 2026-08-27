import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import {
  credentialResetTransactionTimeouts,
  recordAccountAudit,
  type AccountsServiceDeps,
} from './service.js';

/**
 * Normal employee lifecycle: read, rename, transfer, email transition,
 * disable, re-enable, and CEO-only permanent deletion.
 *
 * WHO THESE ACT ON. NORMAL employees only. Every operation re-proves the
 * target is not a privileged system account from the authoritative
 * append-only grant log, and refuses otherwise - so the CEO tier can
 * never be reached, renamed, disabled, or deleted through the ordinary
 * employee API. Authorization of the CALLER is the route layer's job
 * (`authorizeAccountManagement` / the CEO-only gate); this module
 * enforces what may be done to the TARGET.
 *
 * NOTHING HERE DESTROYS HISTORY. A transfer ends the old assignment in
 * place and adds the new one; a rename leaves every frozen signature
 * untouched; a deletion tombstones the account rather than removing the
 * row that permits, signatures and audit events all reference. That is
 * not politeness - migrations 0016/0018/0019 use ON DELETE RESTRICT
 * precisely so history cannot be cascaded away, and 0023 makes DELETED
 * terminal at the trigger level.
 *
 * No password, temporary password, email address, or token is ever
 * written to an application table, returned, or logged by this module.
 * `account_audit_events` has no free-text column at all (0017/0023), so
 * the administrative history records WHICH company or capability
 * changed - by foreign key - and never a value that could be a secret.
 */

/** Locks the target's account row and derives everything the lifecycle operations need to decide safely. */
async function loadManageableTarget(
  client: PoolClient,
  targetUserId: string,
): Promise<
  | { ok: false; reason: 'not_found' | 'target_is_privileged' }
  | {
      ok: true;
      state: 'ACTIVE' | 'DISABLED' | 'DELETED';
      credentialVersion: string;
      credentialResetPending: boolean;
    }
> {
  const access = await client.query<{
    state: 'ACTIVE' | 'DISABLED' | 'DELETED';
    credential_version: string;
    credential_reset_pending: boolean;
  }>(
    `SELECT state, credential_version::text AS credential_version, credential_reset_pending
       FROM app_user_access
      WHERE user_id = $1
      FOR UPDATE`,
    [targetUserId],
  );
  const row = access.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  // Protected-identity guard, from the authoritative governance log -
  // never from a name, an email pattern, or `user_metadata`.
  const privileged = await client.query<{ protected: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM (
         SELECT DISTINCT ON (role) role, action
           FROM privileged_access_events
          WHERE user_id = $1
          ORDER BY role, ordinal DESC
       ) latest WHERE latest.action = 'GRANTED'
     ) AS protected`,
    [targetUserId],
  );
  if (privileged.rows[0]?.protected) return { ok: false, reason: 'target_is_privileged' };

  return {
    ok: true,
    state: row.state,
    credentialVersion: row.credential_version,
    credentialResetPending: row.credential_reset_pending,
  };
}

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

export interface EmployeeDetail {
  userId: string;
  state: 'ACTIVE' | 'DISABLED' | 'DELETED';
  mustChangePassword: boolean;
  displayName: string;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
  teamPositionId: string;
  /** Individually granted capability names, currently active. Never Team + Position capabilities. */
  individualPermissions: string[];
}

/**
 * One normal employee's authoritative management view.
 *
 * Deliberately exposes no credential internals: no credential version,
 * no reset-pending marker, no timestamps of credential changes, and no
 * email - the login address lives in Supabase Auth and is not this
 * application's to echo back. `mustChangePassword` is the single
 * credential-adjacent boolean, exactly as `/auth/me` already exposes.
 *
 * Returns null for an unknown target AND for a privileged one, so the
 * employee API cannot be used to probe for the existence of a CEO or
 * Site Manager account.
 */
export async function loadEmployeeDetail(
  queryFn: QueryFn,
  targetUserId: string,
): Promise<EmployeeDetail | null> {
  const result = await queryFn<{
    state: 'ACTIVE' | 'DISABLED' | 'DELETED';
    must_change_password: boolean;
    display_name: string;
    company_code: string;
    company_name: string;
    team_name: string;
    position_name: string;
    team_position_id: string;
    is_privileged: boolean;
  }>(
    `SELECT a.state, a.must_change_password, wp.display_name,
            c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name,
            wp.primary_team_position_id AS team_position_id,
            EXISTS (
              SELECT 1 FROM (
                SELECT DISTINCT ON (role) role, action
                  FROM privileged_access_events
                 WHERE user_id = a.user_id
                 ORDER BY role, ordinal DESC
              ) latest WHERE latest.action = 'GRANTED'
            ) AS is_privileged
       FROM app_user_access a
       JOIN workforce_profiles wp ON wp.user_id = a.user_id
       JOIN companies c ON c.id = wp.company_id
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
        AND utp.ended_at IS NULL
       JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
      WHERE a.user_id = $1`,
    [targetUserId],
  );
  const row = result.rows[0];
  if (!row || row.is_privileged) return null;

  const permissions = await queryFn<{ name: string }>(
    `SELECT c.name
       FROM (
         SELECT DISTINCT ON (capability_id) capability_id, action
           FROM user_capability_grants
          WHERE user_id = $1
          ORDER BY capability_id, ordinal DESC
       ) latest
       JOIN capabilities c ON c.id = latest.capability_id
      WHERE latest.action = 'GRANTED'
      ORDER BY c.name`,
    [targetUserId],
  );

  return {
    userId: targetUserId,
    state: row.state,
    mustChangePassword: row.must_change_password,
    displayName: row.display_name,
    company: { code: row.company_code, name: row.company_name },
    teamName: row.team_name,
    positionName: row.position_name,
    teamPositionId: row.team_position_id,
    individualPermissions: permissions.rows.map((r) => r.name),
  };
}

export interface AccountAuditEntry {
  eventType: string;
  actorUserId: string;
  occurredAt: string;
  previousCompanyCode: string | null;
  newCompanyCode: string | null;
  previousTeamPositionId: string | null;
  newTeamPositionId: string | null;
  capabilityName: string | null;
}

/**
 * One employee's administrative history, newest first, bounded by the
 * caller's validated page size. Ordered by `ordinal` (the append-only
 * insertion order) rather than a timestamp, so two events written inside
 * one transaction still read back in the true order they happened.
 */
export async function loadEmployeeAuditHistory(
  queryFn: QueryFn,
  targetUserId: string,
  limit: number,
  offset: number,
): Promise<{ items: AccountAuditEntry[]; totalCount: number }> {
  const rows = await queryFn<{
    event_type: string;
    actor_user_id: string;
    created_at: string;
    previous_company_code: string | null;
    new_company_code: string | null;
    previous_team_position_id: string | null;
    new_team_position_id: string | null;
    capability_name: string | null;
  }>(
    `SELECT e.event_type, e.actor_user_id, e.created_at,
            pc.code AS previous_company_code, nc.code AS new_company_code,
            e.previous_team_position_id, e.new_team_position_id,
            cap.name AS capability_name
       FROM account_audit_events e
       LEFT JOIN companies pc ON pc.id = e.previous_company_id
       LEFT JOIN companies nc ON nc.id = e.new_company_id
       LEFT JOIN capabilities cap ON cap.id = e.capability_id
      WHERE e.target_user_id = $1
      ORDER BY e.ordinal DESC
      LIMIT $2 OFFSET $3`,
    [targetUserId, limit, offset],
  );
  const total = await queryFn<{ count: string }>(
    'SELECT count(*)::text AS count FROM account_audit_events WHERE target_user_id = $1',
    [targetUserId],
  );
  return {
    items: rows.rows.map((row) => ({
      eventType: row.event_type,
      actorUserId: row.actor_user_id,
      occurredAt: new Date(row.created_at).toISOString(),
      previousCompanyCode: row.previous_company_code,
      newCompanyCode: row.new_company_code,
      previousTeamPositionId: row.previous_team_position_id,
      newTeamPositionId: row.new_team_position_id,
      capabilityName: row.capability_name,
    })),
    totalCount: Number(total.rows[0]?.count ?? '0'),
  };
}

/** One row of the organization-wide administrative audit. */
export interface GlobalAuditEntry extends AccountAuditEntry {
  targetUserId: string;
  targetDisplayName: string | null;
  actorDisplayName: string | null;
}

/**
 * The ORGANIZATION-WIDE administrative/security audit, newest first.
 *
 * The same append-only rows the per-employee history serves, without the
 * `target_user_id` filter - so it answers "what has been done to accounts
 * here", not "what has been done to this one". Ordered by `ordinal`, the
 * append-only insertion order, so two events written in the same
 * transaction keep their true sequence rather than tying on a timestamp.
 *
 * AUTHORIZATION IS NOT HERE. This is a read model; the route decides who
 * may call it, using exactly the same privileged check as the
 * per-employee history. There is deliberately no filter parameter that
 * could widen or redirect what it returns beyond paging.
 *
 * Display names are resolved for the people involved so the screen does
 * not have to show raw user ids. A name is LEFT JOINed from both
 * identity tables because an actor may be privileged (CEO / system Site
 * Manager, who have no workforce profile) or an ordinary employee, and
 * either may appear; a missing name stays null rather than inventing one.
 */
export async function loadGlobalAuditHistory(
  queryFn: QueryFn,
  limit: number,
  offset: number,
): Promise<{ items: GlobalAuditEntry[]; totalCount: number }> {
  const rows = await queryFn<{
    event_type: string;
    actor_user_id: string;
    target_user_id: string;
    created_at: string;
    previous_company_code: string | null;
    new_company_code: string | null;
    previous_team_position_id: string | null;
    new_team_position_id: string | null;
    capability_name: string | null;
    target_display_name: string | null;
    actor_display_name: string | null;
  }>(
    `SELECT e.event_type, e.actor_user_id, e.target_user_id, e.created_at,
            pc.code AS previous_company_code, nc.code AS new_company_code,
            e.previous_team_position_id, e.new_team_position_id,
            cap.name AS capability_name,
            COALESCE(tw.display_name, tp.display_name) AS target_display_name,
            COALESCE(aw.display_name, ap.display_name) AS actor_display_name
       FROM account_audit_events e
       LEFT JOIN companies pc ON pc.id = e.previous_company_id
       LEFT JOIN companies nc ON nc.id = e.new_company_id
       LEFT JOIN capabilities cap ON cap.id = e.capability_id
       LEFT JOIN workforce_profiles tw ON tw.user_id = e.target_user_id
       LEFT JOIN privileged_identities tp ON tp.user_id = e.target_user_id
       LEFT JOIN workforce_profiles aw ON aw.user_id = e.actor_user_id
       LEFT JOIN privileged_identities ap ON ap.user_id = e.actor_user_id
      ORDER BY e.ordinal DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const total = await queryFn<{ count: string }>(
    'SELECT count(*)::text AS count FROM account_audit_events',
  );
  return {
    items: rows.rows.map((row) => ({
      eventType: row.event_type,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      occurredAt: new Date(row.created_at).toISOString(),
      previousCompanyCode: row.previous_company_code,
      newCompanyCode: row.new_company_code,
      previousTeamPositionId: row.previous_team_position_id,
      newTeamPositionId: row.new_team_position_id,
      capabilityName: row.capability_name,
      targetDisplayName: row.target_display_name,
      actorDisplayName: row.actor_display_name,
    })),
    totalCount: Number(total.rows[0]?.count ?? '0'),
  };
}

// ---------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------

export type EmployeeUpdateOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_privileged' | 'target_is_self' | 'account_deleted' }
  | { outcome: 'invalid'; reason: 'team_position_not_assignable' | 'company_team_mismatch' | 'unchanged' }
  | { outcome: 'failed'; reason: 'update_failed' };

/**
 * Changes a normal employee's authoritative display name.
 *
 * HISTORY IS NOT TOUCHED. Every signature already recorded copied the
 * name AT SIGNING TIME into `permit_signatures` (migration 0016), and
 * issued snapshots copied it again - so renaming here cannot alter a
 * single existing permit, signature, or PDF. That is by design, not by
 * omission: a document says who signed it then, not who they are now.
 */
export async function updateEmployeeDisplayName(
  actorUserId: string,
  targetUserId: string,
  displayName: string,
  deps: AccountsServiceDeps,
): Promise<EmployeeUpdateOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<EmployeeUpdateOutcome> => {
      const target = await loadManageableTarget(client, targetUserId);
      if (!target.ok) {
        return target.reason === 'not_found'
          ? { outcome: 'not_found' }
          : { outcome: 'refused', reason: 'target_is_privileged' };
      }
      if (target.state === 'DELETED') return { outcome: 'refused', reason: 'account_deleted' };

      const updated = await client.query<{ user_id: string }>(
        `UPDATE workforce_profiles SET display_name = $2
          WHERE user_id = $1 AND display_name IS DISTINCT FROM $2
          RETURNING user_id`,
        [targetUserId, displayName],
      );
      if (updated.rows.length === 0) {
        // Either no profile (not a normal employee) or the name is
        // already exactly this. Distinguish, so a no-op is not reported
        // as a successful change in the audit trail.
        const exists = await client.query('SELECT 1 FROM workforce_profiles WHERE user_id = $1', [targetUserId]);
        return exists.rows.length === 0 ? { outcome: 'not_found' } : { outcome: 'invalid', reason: 'unchanged' };
      }

      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_DISPLAY_NAME_CHANGED',
        actorUserId,
        targetUserId,
      });
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'update_failed' };
  }
}

// ---------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------

/**
 * Moves a normal employee to a new Company + Team + Position.
 *
 * ONE TRANSACTION, ROW-LOCKED. The account row is locked first, so two
 * concurrent transfers cannot both read the same "current" assignment
 * and both try to end it - the second waits and then sees the first
 * one's result.
 *
 * HISTORY IS ENDED, NEVER DELETED. The outgoing `user_team_positions`
 * row is stamped with `ended_at` (database-authoritative, migration
 * 0019) and stays forever; the incoming assignment is inserted as the
 * new current one. The partial unique index guarantees exactly one
 * current row per user, so a bug here fails loudly rather than silently
 * giving somebody two live roles - and returning to a previously held
 * combination reactivates that same history row, because 0016's
 * composite foreign key requires the UNIQUE (user_id, team_position_id)
 * that makes a duplicate impossible.
 *
 * CROSS-COMPANY IS REFUSED TWICE: once here with a precise error, and
 * again by migration 0019's trigger, which is what actually guarantees
 * an employee's company always owns the team behind their assignment.
 */
export async function transferEmployee(
  actorUserId: string,
  targetUserId: string,
  input: { companyId: string; teamPositionId: string },
  deps: AccountsServiceDeps,
): Promise<EmployeeUpdateOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<EmployeeUpdateOutcome> => {
      const target = await loadManageableTarget(client, targetUserId);
      if (!target.ok) {
        return target.reason === 'not_found'
          ? { outcome: 'not_found' }
          : { outcome: 'refused', reason: 'target_is_privileged' };
      }
      if (target.state === 'DELETED') return { outcome: 'refused', reason: 'account_deleted' };

      // The destination must be an operator-approved combination AND its
      // team must belong to the destination company.
      const destination = await client.query<{ company_id: string; assignable: boolean }>(
        `SELECT t.company_id, tp.site_manager_assignable AS assignable
           FROM team_positions tp
           JOIN teams t ON t.id = tp.team_id
          WHERE tp.id = $1`,
        [input.teamPositionId],
      );
      const target_tp = destination.rows[0];
      if (!target_tp || !target_tp.assignable) {
        return { outcome: 'invalid', reason: 'team_position_not_assignable' };
      }
      if (target_tp.company_id !== input.companyId) {
        return { outcome: 'invalid', reason: 'company_team_mismatch' };
      }

      const profile = await client.query<{ company_id: string; primary_team_position_id: string }>(
        'SELECT company_id, primary_team_position_id FROM workforce_profiles WHERE user_id = $1 FOR UPDATE',
        [targetUserId],
      );
      const current = profile.rows[0];
      if (!current) return { outcome: 'not_found' };
      if (
        current.company_id === input.companyId &&
        current.primary_team_position_id === input.teamPositionId
      ) {
        return { outcome: 'invalid', reason: 'unchanged' };
      }

      if (current.primary_team_position_id !== input.teamPositionId) {
        // End the outgoing assignment. `ended_at` is stamped by the
        // database, so no application clock can backdate the period.
        await client.query(
          `UPDATE user_team_positions SET ended_at = now()
            WHERE user_id = $1 AND ended_at IS NULL`,
          [targetUserId],
        );
        // Reactivate a previously-held combination if there is one,
        // otherwise create it. Either way exactly one row ends up
        // current, and no history row is ever removed.
        await client.query(
          `INSERT INTO user_team_positions (user_id, team_position_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, team_position_id) DO UPDATE SET ended_at = NULL`,
          [targetUserId, input.teamPositionId],
        );
      }

      await client.query(
        `UPDATE workforce_profiles
            SET company_id = $2, primary_team_position_id = $3
          WHERE user_id = $1`,
        [targetUserId, input.companyId, input.teamPositionId],
      );

      if (current.company_id !== input.companyId) {
        await recordAccountAudit(client.query.bind(client), {
          eventType: 'EMPLOYEE_COMPANY_CHANGED',
          actorUserId,
          targetUserId,
          detail: { previousCompanyId: current.company_id, newCompanyId: input.companyId },
        });
      }
      if (current.primary_team_position_id !== input.teamPositionId) {
        await recordAccountAudit(client.query.bind(client), {
          eventType: 'EMPLOYEE_TEAM_POSITION_CHANGED',
          actorUserId,
          targetUserId,
          detail: {
            previousTeamPositionId: current.primary_team_position_id,
            newTeamPositionId: input.teamPositionId,
          },
        });
      }
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'update_failed' };
  }
}

// ---------------------------------------------------------------------
// Disable / re-enable
// ---------------------------------------------------------------------

export type AccountStateOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_privileged' | 'target_is_self' | 'account_deleted' | 'already_in_state' }
  | { outcome: 'failed'; reason: 'update_failed' };

/**
 * Disables or re-enables a normal employee.
 *
 * Takes effect on the target's VERY NEXT request: `requireAuth` reads
 * `app_user_access.state` on every authenticated call and refuses
 * anything that is not ACTIVE, so an already-issued JWT stops working
 * the moment this commits. No Supabase logout is involved and
 * `auth.sessions` is never queried.
 *
 * NOTHING IS REMOVED. The assignment, the workforce profile, and every
 * individual permission survive untouched, which is exactly what makes
 * re-enable restore the same Company, Team, Position and permissions
 * without any of them having to be re-applied.
 */
export async function setEmployeeAccountState(
  actorUserId: string,
  targetUserId: string,
  nextState: 'ACTIVE' | 'DISABLED',
  deps: AccountsServiceDeps,
): Promise<AccountStateOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };
  try {
    return await deps.withTransaction(async (client): Promise<AccountStateOutcome> => {
      const target = await loadManageableTarget(client, targetUserId);
      if (!target.ok) {
        return target.reason === 'not_found'
          ? { outcome: 'not_found' }
          : { outcome: 'refused', reason: 'target_is_privileged' };
      }
      // DELETED is terminal (migration 0023's trigger would refuse the
      // UPDATE anyway); refusing here makes the reason precise.
      if (target.state === 'DELETED') return { outcome: 'refused', reason: 'account_deleted' };
      if (target.state === nextState) return { outcome: 'refused', reason: 'already_in_state' };

      await client.query('UPDATE app_user_access SET state = $2 WHERE user_id = $1', [targetUserId, nextState]);
      await recordAccountAudit(client.query.bind(client), {
        eventType: nextState === 'DISABLED' ? 'EMPLOYEE_DISABLED' : 'EMPLOYEE_REENABLED',
        actorUserId,
        targetUserId,
      });
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'update_failed' };
  }
}

// ---------------------------------------------------------------------
// Email + temporary password transition
// ---------------------------------------------------------------------

export type ChangeEmployeeEmailOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_privileged' | 'target_is_self' | 'account_deleted' }
  | { outcome: 'conflict'; reason: 'email_unavailable' }
  | { outcome: 'failed'; reason: 'auth_update_failed' | 'state_update_failed' | 'credential_operation_superseded' };

/**
 * Changes a normal employee's LOGIN EMAIL and issues a new temporary
 * password in one governed transition.
 *
 * ORDER AND FAILURE DESIGN - deliberately identical in shape to
 * `resetEmployeePassword`, because it has the same hazard: a short first
 * transaction locks the account, advances the credential generation and
 * commits `must_change_password = TRUE` BEFORE Supabase Auth is touched.
 * Existing JWTs therefore lose normal access even if every later step
 * fails, and the account can only be recovered by completing the
 * transition - never by continuing to use the old email.
 *
 * The second, version-checked transaction performs the external Auth
 * update while holding the row lock, so two concurrent transitions
 * cannot publish their credentials out of generation order, and a
 * self-service password change cannot interleave (it refuses while
 * `credential_reset_pending` is set). Transaction-local lock, statement
 * and idle guards bound the database resources exactly as the reset path
 * does.
 *
 * NOT ATOMIC ACROSS SYSTEMS, AND SAFE ANYWAY: if Auth fails after the
 * gate committed, the employee simply cannot sign in until a manager
 * retries - strictly less access, never more. Email and password move
 * together in a single Auth call, so there is no window in which the new
 * address is live with the old password.
 *
 * The email address itself is never written to an application table -
 * `account_audit_events` has no column that could hold it - and the
 * temporary password is never stored, logged, or returned.
 */
export async function changeEmployeeEmail(
  actorUserId: string,
  targetUserId: string,
  input: { newEmail: string; temporaryPassword: string },
  deps: AccountsServiceDeps,
): Promise<ChangeEmployeeEmailOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };

  let credentialVersion: string;
  try {
    const gated = await deps.withTransaction(async (client) => {
      const target = await loadManageableTarget(client, targetUserId);
      if (!target.ok) {
        return target.reason === 'not_found'
          ? ({ outcome: 'not_found' } as const)
          : ({ outcome: 'refused', reason: 'target_is_privileged' } as const);
      }
      if (target.state === 'DELETED') return { outcome: 'refused', reason: 'account_deleted' } as const;

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
      if (marked.rows.length !== 1) throw new Error('account state row disappeared during email change');
      return { outcome: 'gated', credentialVersion: marked.rows[0]!.credential_version } as const;
    });
    if (gated.outcome !== 'gated') return gated;
    credentialVersion = gated.credentialVersion;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }

  try {
    return await deps.withTransaction(async (client): Promise<ChangeEmployeeEmailOutcome> => {
      const timeouts = credentialResetTransactionTimeouts(deps.authAdminTimeoutMs);
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

      const updated = await deps.admin.setEmailAndPassword(
        targetUserId,
        input.newEmail,
        input.temporaryPassword,
      );
      if (!updated.ok) {
        return updated.reason === 'email_unavailable'
          ? { outcome: 'conflict', reason: 'email_unavailable' }
          : { outcome: 'failed', reason: 'auth_update_failed' };
      }

      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_EMAIL_CHANGED',
        actorUserId,
        targetUserId,
      });
      const completed = await client.query(
        `UPDATE app_user_access
            SET credential_reset_pending = FALSE
          WHERE user_id = $1 AND credential_version = $2
          RETURNING user_id`,
        [targetUserId, credentialVersion],
      );
      if (completed.rows.length !== 1) throw new Error('credential operation changed during email completion');
      return { outcome: 'ok' };
    });
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }
}

// ---------------------------------------------------------------------
// CEO-only permanent deletion
// ---------------------------------------------------------------------

export type DeleteEmployeeOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'refused'; reason: 'target_is_privileged' | 'target_is_self' | 'already_deleted' }
  | { outcome: 'failed'; reason: 'auth_delete_failed' | 'state_update_failed' };

/**
 * CEO-only permanent deletion of a normal employee account.
 *
 * WHAT "PERMANENT" MEANS HERE. The login is destroyed and the local
 * account is tombstoned; the person's HISTORY is kept in full. Permits,
 * JSAs, signatures, issued snapshots, lifecycle events, the account
 * audit trail, and every assignment they ever held all reference
 * `auth.users` with ON DELETE RESTRICT, so cascading them away is not
 * merely undesirable, it is impossible - and the tombstone is what lets
 * those references stay valid.
 *
 * ORDER AND FAILURE DESIGN. The local terminal state commits FIRST,
 * then the Supabase Auth identity is removed:
 *
 *   1. `state = 'DELETED'` commits. From this instant `requireAuth`
 *      refuses every request, so access has already ended even though
 *      the Auth identity still exists. Migration 0023's trigger makes
 *      the state terminal, so nothing can walk it back.
 *   2. Auth deletion follows. If it fails, the reachable state is an
 *      account that cannot reach a single endpoint but whose Supabase
 *      credential technically still exists - strictly LESS access than
 *      intended, never more - and the caller receives a distinct outcome
 *      so an operator can finish the removal.
 *
 * The reverse order would be the unsafe one: deleting the Auth identity
 * first and then failing to tombstone would leave an ACTIVE local
 * account whose audit trail never records the deletion.
 */
export async function deleteEmployeeAccount(
  actorUserId: string,
  targetUserId: string,
  deps: AccountsServiceDeps,
): Promise<DeleteEmployeeOutcome> {
  if (actorUserId === targetUserId) return { outcome: 'refused', reason: 'target_is_self' };

  try {
    const tombstoned = await deps.withTransaction(async (client) => {
      const target = await loadManageableTarget(client, targetUserId);
      if (!target.ok) {
        return target.reason === 'not_found'
          ? ({ outcome: 'not_found' } as const)
          : ({ outcome: 'refused', reason: 'target_is_privileged' } as const);
      }
      if (target.state === 'DELETED') return { outcome: 'refused', reason: 'already_deleted' } as const;

      // Advance the credential generation too: any in-flight credential
      // operation for this account is invalidated by the same commit.
      await client.query(
        `UPDATE app_user_access
            SET state = 'DELETED',
                credential_reset_pending = FALSE,
                credential_version = credential_version + 1
          WHERE user_id = $1`,
        [targetUserId],
      );
      await recordAccountAudit(client.query.bind(client), {
        eventType: 'EMPLOYEE_ACCOUNT_DELETED',
        actorUserId,
        targetUserId,
      });
      return { outcome: 'tombstoned' } as const;
    });
    if (tombstoned.outcome !== 'tombstoned') return tombstoned;
  } catch {
    return { outcome: 'failed', reason: 'state_update_failed' };
  }

  const removed = await deps.admin.deleteUser(targetUserId);
  if (!removed.ok) return { outcome: 'failed', reason: 'auth_delete_failed' };
  return { outcome: 'ok' };
}
