import type { QueryFn } from '../../db/pool.js';

/**
 * The single writer for `organization_audit_events`.
 *
 * WHY A SEPARATE TABLE. `account_audit_events` requires a
 * `target_user_id` that is a real `permit.users` row, and constrains the
 * actor to differ from the target for every manager event. A
 * COMPANY_CREATED event has no target user at all, and relaxing that
 * column to NULL would weaken a constraint that currently makes "a
 * manager reset recorded as if the employee did it themselves"
 * impossible to store. Migration 0035 therefore adds a sibling table
 * using the same architecture - append-only through `forbid_mutation()`,
 * a database-authoritative timestamp, RLS on with no policy - rather
 * than a second logging system with different rules.
 *
 * ALWAYS IN THE CALLER'S TRANSACTION. Every function here takes the
 * `QueryFn` of the transaction performing the mutation, so an
 * organization change that commits without its audit row cannot exist,
 * and a rolled-back change leaves no audit row behind.
 *
 * THE ACTOR IS NEVER CLIENT-SUPPLIED. Callers pass the authenticated
 * privileged identity resolved by the route layer, exactly as the
 * account audit does.
 *
 * NO SECRET CAN REACH THIS TABLE. The only free-text columns are
 * `previous_name`/`new_name`, written solely by the rename paths and
 * bounded by the same validated schema that produced the name. Every
 * other column is a foreign key to reference data.
 */

export type OrganizationAuditEventType =
  | 'COMPANY_CREATED'
  | 'COMPANY_RENAMED'
  | 'COMPANY_DEACTIVATED'
  | 'COMPANY_REACTIVATED'
  | 'TEAM_CREATED'
  | 'TEAM_RENAMED'
  | 'TEAM_DEACTIVATED'
  | 'TEAM_REACTIVATED'
  | 'POSITION_CREATED'
  | 'TEAM_POSITION_CREATED'
  | 'TEAM_POSITION_DEACTIVATED'
  | 'TEAM_POSITION_REACTIVATED'
  | 'BASELINE_CAPABILITIES_GRANTED';

/** The organization entity an event happened to. At least one must be present. */
export interface OrganizationAuditSubject {
  companyId?: string | undefined;
  teamId?: string | undefined;
  positionId?: string | undefined;
  teamPositionId?: string | undefined;
}

export interface OrganizationAuditEntry extends OrganizationAuditSubject {
  eventType: OrganizationAuditEventType;
  actorUserId: string;
  /** Rename events only; the database CHECK refuses them on any other type. */
  previousName?: string | undefined;
  newName?: string | undefined;
}

export async function recordOrganizationAuditEvent(
  queryFn: QueryFn,
  entry: OrganizationAuditEntry,
): Promise<void> {
  await queryFn(
    `INSERT INTO organization_audit_events
       (event_type, actor_user_id, company_id, team_id, position_id, team_position_id,
        previous_name, new_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.eventType,
      entry.actorUserId,
      entry.companyId ?? null,
      entry.teamId ?? null,
      entry.positionId ?? null,
      entry.teamPositionId ?? null,
      entry.previousName ?? null,
      entry.newName ?? null,
    ],
  );
}
