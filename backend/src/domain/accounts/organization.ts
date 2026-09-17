import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.js';
import {
  COMPANY_CODE_ATTEMPTS,
  companyCodeCandidate,
  isUniqueViolation,
  uniqueViolationTarget,
} from './organizationCodes.js';
import { recordOrganizationAuditEvent } from './organizationAudit.js';

/**
 * Runtime management of the organization structure:
 *
 *   Company -> Team -> Team + Position association -> capabilities
 *
 * WHAT THIS MAY AND MAY NOT GRANT. Creating an association attaches
 * exactly the standard applicant baseline - `permit.create` and
 * `permit.submit` - and nothing else, ever. It reaches that through
 * migration 0035's `grant_baseline_applicant_capabilities()`, a
 * SECURITY DEFINER function whose capability names are LITERALS in
 * database code; there is no parameter through which a caller could ask
 * for a different capability, and `app_runtime` holds no direct write on
 * `team_position_capabilities` to bypass it with. `permit.cro_review`,
 * `permit.hse_review`, the CRO-only operational actions and the
 * account-management capabilities are unreachable from this module.
 *
 * A NAME IS NEVER AUTHORITY. A Position named 'CRO', 'HSE Officer',
 * 'Site Manager' or 'CEO' created here receives the same two baseline
 * capabilities as one named 'Electrician'. Capability resolution joins
 * `team_position_capabilities` and never reads a name; privileged
 * CEO/SITE_MANAGER status comes only from `privileged_access_events`,
 * which nothing in this module touches.
 *
 * AUTHORIZATION IS THE CALLER'S JOB, AND IS NOT OPTIONAL. Every function
 * here assumes the route layer has already applied the same
 * `authorize()` gate the other admin mutations use (CEO or E-SET
 * SITE_MANAGER, resolved per request from the append-only grant log).
 * This module widens no authority and makes no authorization decision.
 *
 * COMPANY INTEGRITY IS STRUCTURAL. `teams.company_id` is NOT NULL, so an
 * association reaches a company only through its team and can never span
 * two. The company-scoped lookups below additionally refuse a team id
 * that belongs to a different company than the one named in the request,
 * so a caller cannot attach a position to another company's team by
 * guessing an id.
 *
 * POSITIONS ARE A SHARED VOCABULARY. `positions.name` is globally
 * unique, so "Supervisor" is ONE row that Electrical, Mechanical and
 * Civil each associate with. Creating a position reuses the existing row
 * when the name already exists rather than duplicating it, and the
 * position row itself has no lifecycle - retiring a designation for one
 * team deactivates that team's ASSOCIATION, never the shared row.
 */

export interface OrganizationActor {
  /** The authenticated privileged identity performing the change. Never client-supplied. */
  actorUserId: string;
}

export interface CreatedCompany {
  id: string;
  code: string;
  name: string;
}

export type CreateCompanyOutcome =
  | { outcome: 'ok'; company: CreatedCompany }
  | { outcome: 'conflict'; reason: 'duplicate_name' }
  | { outcome: 'failed'; reason: 'code_generation_exhausted' };

export interface OrganizationDeps {
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

export const defaultOrganizationDeps: OrganizationDeps = { withTransaction };

/** The unique index that means "an administrator asked for a name already in use". */
const COMPANY_NAME_INDEX = 'companies_name_normalized_unique';
const TEAM_NAME_INDEX = 'teams_company_name_normalized_unique';

/**
 * Creates a company with a backend-generated code.
 *
 * NO DEFAULT TEAM IS CREATED. A company legitimately exists with zero
 * teams until an administrator adds them; inventing a hidden team would
 * put data in the database that no one asked for and would make the
 * hierarchy look one level shallower than it is.
 *
 * CONCURRENCY. The code is generated, not reserved. Each attempt INSERTs
 * and lets the database's UNIQUE constraint decide; a collision on the
 * CODE index retries with the next candidate, while a collision on the
 * NAME index is a real duplicate and is reported as one. Two concurrent
 * requests for the same name therefore produce one company and one
 * clean conflict - never two rows, and never a silent overwrite. Each
 * attempt runs in its own transaction because a unique violation aborts
 * the surrounding one.
 */
export async function createCompany(
  name: string,
  actor: OrganizationActor,
  deps: OrganizationDeps = defaultOrganizationDeps,
): Promise<CreateCompanyOutcome> {
  const displayName = name.trim();

  for (let attempt = 0; attempt < COMPANY_CODE_ATTEMPTS; attempt += 1) {
    const code = companyCodeCandidate(displayName, attempt);
    try {
      return await deps.withTransaction(async (client): Promise<CreateCompanyOutcome> => {
        const inserted = await client.query<{ id: string; code: string; name: string }>(
          `INSERT INTO companies (id, code, name)
           VALUES (gen_random_uuid(), $1, $2)
           RETURNING id, code, name`,
          [code, displayName],
        );
        const company = inserted.rows[0];
        if (!company) throw new Error('company insert returned no row');

        await recordOrganizationAuditEvent(client.query.bind(client), {
          eventType: 'COMPANY_CREATED',
          actorUserId: actor.actorUserId,
          companyId: company.id,
        });

        return { outcome: 'ok', company };
      });
    } catch (err) {
      const constraint = uniqueViolationTarget(err);
      if (constraint === COMPANY_NAME_INDEX) {
        return { outcome: 'conflict', reason: 'duplicate_name' };
      }
      // A code collision is an internal detail: try the next candidate.
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }

  return { outcome: 'failed', reason: 'code_generation_exhausted' };
}

export interface CreatedTeam {
  id: string;
  name: string;
  companyId: string;
}

export type CreateTeamOutcome =
  | { outcome: 'ok'; team: CreatedTeam }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'duplicate_name' | 'company_inactive' };

/**
 * Adds a team to a company - any company, including the seeded E-SET,
 * ZPL and SGRE, which are not closed structures.
 *
 * An inactive company is refused here AND by migration 0035's
 * `teams_require_active_company` trigger; the check exists so the
 * refusal is a clean typed outcome rather than a raw database error,
 * and the trigger exists so a bug here cannot widen the rule.
 */
export async function createTeam(
  companyId: string,
  name: string,
  actor: OrganizationActor,
  deps: OrganizationDeps = defaultOrganizationDeps,
): Promise<CreateTeamOutcome> {
  const teamName = name.trim();

  try {
    return await deps.withTransaction(async (client): Promise<CreateTeamOutcome> => {
      const company = await client.query<{ id: string; deactivated_at: string | null }>(
        `SELECT id, deactivated_at FROM companies WHERE id = $1 FOR SHARE`,
        [companyId],
      );
      const companyRow = company.rows[0];
      if (!companyRow) return { outcome: 'not_found' };
      if (companyRow.deactivated_at !== null) {
        return { outcome: 'conflict', reason: 'company_inactive' };
      }

      const inserted = await client.query<{ id: string; name: string; company_id: string }>(
        `INSERT INTO teams (name, company_id) VALUES ($1, $2) RETURNING id, name, company_id`,
        [teamName, companyId],
      );
      const team = inserted.rows[0];
      if (!team) throw new Error('team insert returned no row');

      await recordOrganizationAuditEvent(client.query.bind(client), {
        eventType: 'TEAM_CREATED',
        actorUserId: actor.actorUserId,
        companyId,
        teamId: team.id,
      });

      return { outcome: 'ok', team: { id: team.id, name: team.name, companyId: team.company_id } };
    });
  } catch (err) {
    if (uniqueViolationTarget(err) === TEAM_NAME_INDEX || isUniqueViolation(err)) {
      return { outcome: 'conflict', reason: 'duplicate_name' };
    }
    throw err;
  }
}

export interface CreatedTeamPosition {
  teamPositionId: string;
  positionId: string;
  positionName: string;
  teamId: string;
  /** The capability names the association was given - always exactly the baseline. */
  baselineCapabilities: readonly string[];
}

export type CreateTeamPositionOutcome =
  | { outcome: 'ok'; association: CreatedTeamPosition }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'duplicate_association' | 'team_inactive' };

/** Exactly what a runtime-created association receives. Documented policy, asserted by tests. */
export const BASELINE_APPLICANT_CAPABILITIES = ['permit.create', 'permit.submit'] as const;

/**
 * Associates a position with a team, creating the shared position row
 * only if that name does not exist yet, and equipping the new
 * association with the applicant baseline.
 *
 * THE TEAM IS RESOLVED WITHIN THE COMPANY. The lookup is scoped by
 * `company_id`, so a team id belonging to another company reads as
 * "not found" rather than being silently accepted - an association can
 * never be attached across a company boundary.
 *
 * THE SHARED POSITION ROW IS REUSED, NOT DUPLICATED. `positions.name` is
 * globally unique, so adding "Supervisor" to a second team must find the
 * existing row. Inserting blindly would raise a unique violation that
 * would be wrong to report as "duplicate position" - the duplicate that
 * matters is the (team, position) pair, not the name.
 *
 * `site_manager_assignable` is set TRUE on INSERT of a brand-new row
 * only. It is never written by an UPDATE, and never taken from a request
 * field, so it cannot be flipped on a pre-existing association. The flag
 * means only "a manager may place an employee here" and grants nothing
 * by itself; capabilities are the separate mapping below.
 */
export async function createTeamPosition(
  companyId: string,
  teamId: string,
  positionName: string,
  actor: OrganizationActor,
  deps: OrganizationDeps = defaultOrganizationDeps,
): Promise<CreateTeamPositionOutcome> {
  const name = positionName.trim();

  try {
    return await deps.withTransaction(async (client): Promise<CreateTeamPositionOutcome> => {
      const team = await client.query<{ id: string; deactivated_at: string | null; company_deactivated_at: string | null }>(
        `SELECT t.id, t.deactivated_at, c.deactivated_at AS company_deactivated_at
           FROM teams t
           JOIN companies c ON c.id = t.company_id
          WHERE t.id = $1 AND t.company_id = $2
            FOR SHARE OF t`,
        [teamId, companyId],
      );
      const teamRow = team.rows[0];
      if (!teamRow) return { outcome: 'not_found' };
      if (teamRow.deactivated_at !== null || teamRow.company_deactivated_at !== null) {
        return { outcome: 'conflict', reason: 'team_inactive' };
      }

      // Reuse the shared vocabulary row, or mint it. The conflict clause
      // is deliberately UNTARGETED: `positions` carries two unique
      // indexes - the exact name (0002) and the normalized name (0035) -
      // and naming only the first would let "supervisor" escape as a raw
      // unique violation when "Supervisor" already exists. The SELECT
      // that follows is what makes the reuse path work when DO NOTHING
      // returns no row.
      await client.query(
        `INSERT INTO positions (name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [name],
      );
      const position = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM positions WHERE lower(btrim(name)) = lower(btrim($1))`,
        [name],
      );
      const positionRow = position.rows[0];
      if (!positionRow) throw new Error('position row could not be resolved after insert');

      const association = await client.query<{ id: string }>(
        `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
         VALUES ($1, $2, TRUE)
         RETURNING id`,
        [teamId, positionRow.id],
      );
      const associationRow = association.rows[0];
      if (!associationRow) throw new Error('team position insert returned no row');

      // The ONE write path to capability data, bounded by literals inside
      // the database function. It raises - failing this whole transaction
      // - if either baseline capability is missing, so an association
      // with one capability or none is never committed.
      await client.query(`SELECT grant_baseline_applicant_capabilities($1)`, [associationRow.id]);

      await recordOrganizationAuditEvent(client.query.bind(client), {
        eventType: 'POSITION_CREATED',
        actorUserId: actor.actorUserId,
        companyId,
        teamId,
        positionId: positionRow.id,
      });
      await recordOrganizationAuditEvent(client.query.bind(client), {
        eventType: 'TEAM_POSITION_CREATED',
        actorUserId: actor.actorUserId,
        companyId,
        teamId,
        positionId: positionRow.id,
        teamPositionId: associationRow.id,
      });
      await recordOrganizationAuditEvent(client.query.bind(client), {
        eventType: 'BASELINE_CAPABILITIES_GRANTED',
        actorUserId: actor.actorUserId,
        companyId,
        teamId,
        teamPositionId: associationRow.id,
      });

      return {
        outcome: 'ok',
        association: {
          teamPositionId: associationRow.id,
          positionId: positionRow.id,
          positionName: positionRow.name,
          teamId,
          baselineCapabilities: BASELINE_APPLICANT_CAPABILITIES,
        },
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: 'conflict', reason: 'duplicate_association' };
    }
    throw err;
  }
}

export type OrganizationLevel = 'company' | 'team' | 'team_position';

export type DeactivationOutcome =
  | { outcome: 'ok' }
  | { outcome: 'not_found' }
  | { outcome: 'blocked'; reason: 'active_employees' | 'capability_coverage' }
  | { outcome: 'conflict'; reason: 'already_inactive' };

/**
 * One fixed SELECT and one fixed UPDATE per level, written out in full.
 *
 * The table name is NEVER interpolated into the statement, even from a
 * closed union - every statement in this module is a literal whose only
 * variable part is a bound parameter, matching the rest of the account
 * domain. That is what makes the SQL auditable by reading it.
 */
const DEACTIVATION_TARGETS: Record<
  OrganizationLevel,
  {
    select: string;
    update: string;
    event: 'COMPANY_DEACTIVATED' | 'TEAM_DEACTIVATED' | 'TEAM_POSITION_DEACTIVATED';
  }
> = {
  company: {
    select: 'SELECT id, deactivated_at FROM companies WHERE id = $1 FOR UPDATE',
    update: 'UPDATE companies SET deactivated_at = now() WHERE id = $1',
    event: 'COMPANY_DEACTIVATED',
  },
  team: {
    select: 'SELECT id, deactivated_at FROM teams WHERE id = $1 FOR UPDATE',
    update: 'UPDATE teams SET deactivated_at = now() WHERE id = $1',
    event: 'TEAM_DEACTIVATED',
  },
  team_position: {
    select: 'SELECT id, deactivated_at FROM team_positions WHERE id = $1 FOR UPDATE',
    update: 'UPDATE team_positions SET deactivated_at = now() WHERE id = $1',
    event: 'TEAM_POSITION_DEACTIVATED',
  },
};

/**
 * Retires an organization record. There is no hard delete anywhere in
 * this design.
 *
 * DEACTIVATION NEVER CASCADES. Retiring a company does not write
 * `deactivated_at` on its teams, and retiring a team does not write it
 * on its associations. What an inactive ancestor does instead is make
 * its descendants unusable for NEW work, which the database enforces by
 * reading the whole chain.
 *
 * TWO REFUSALS, BOTH ENFORCED IN THE DATABASE. Migration 0035 refuses to
 * retire a record while an ACTIVE employee still depends on it - the
 * administrator must reassign or disable the person first, and nothing
 * here does that for them - and refuses any deactivation that would push
 * a REQUIRED capability below its coverage minimum.
 *
 * "Required" is a short explicit list, not every capability. Only
 * `permit.cro_review` and `permit.hse_review` are protected, because
 * those are the only two the workflow fails closed on
 * (`workflowSideEffects.ts` throws `ResponsibilityRecipientUnavailableError`
 * when either recipient set is empty). An OPTIONAL capability may
 * legitimately fall to zero active holders, and a lifecycle operation is
 * never blocked because of one - which is exactly what would happen
 * under a global "every capability needs a holder" rule.
 *
 * NOR DOES A DEGRADED REQUIREMENT FREEZE THE ORGANIZATION. The bar is
 * `LEAST(minimum, current)`, so an action is refused only when it NEWLY
 * breaks a minimum or REDUCES a count that is already short. While
 * coverage sits below its minimum, unrelated retirements still go
 * through - including the reassignments an administrator needs in order
 * to restore it.
 *
 * The messages below are matched rather than re-derived, so this module
 * cannot disagree with the database about whether a change was allowed.
 */
export async function deactivateOrganizationRecord(
  level: OrganizationLevel,
  id: string,
  actor: OrganizationActor,
  deps: OrganizationDeps = defaultOrganizationDeps,
): Promise<DeactivationOutcome> {
  const target = DEACTIVATION_TARGETS[level];

  try {
    return await deps.withTransaction(async (client): Promise<DeactivationOutcome> => {
      const existing = await client.query<{ id: string; deactivated_at: string | null }>(
        target.select,
        [id],
      );
      const row = existing.rows[0];
      if (!row) return { outcome: 'not_found' };
      if (row.deactivated_at !== null) return { outcome: 'conflict', reason: 'already_inactive' };

      await client.query(target.update, [id]);

      await recordOrganizationAuditEvent(client.query.bind(client), {
        eventType: target.event,
        actorUserId: actor.actorUserId,
        ...(level === 'company' ? { companyId: id } : {}),
        ...(level === 'team' ? { teamId: id } : {}),
        ...(level === 'team_position' ? { teamPositionId: id } : {}),
      });

      return { outcome: 'ok' };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('active employee(s)')) {
      return { outcome: 'blocked', reason: 'active_employees' };
    }
    if (message.includes('below its required coverage')) {
      return { outcome: 'blocked', reason: 'capability_coverage' };
    }
    throw err;
  }
}
