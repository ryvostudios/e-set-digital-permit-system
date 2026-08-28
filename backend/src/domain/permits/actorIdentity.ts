import type { QueryFn } from '../../db/pool.js';
import {
  PRIVILEGED_APPLICANT_ROLE_LABELS,
  type PrivilegedApplicantRole,
} from './applicantIdentity.js';

/**
 * WHO DID A THING TO A PERMIT.
 *
 * Every append-only lifecycle event stores `actor_user_id`: the
 * authenticated actor the workflow recorded, never a value from a
 * request. That is the authoritative answer to "who did this" - but it
 * is a raw user id, so nothing could ever be shown to a person.
 *
 * This resolves those ids to names, in one place, for every actor on a
 * permit - the closer, and anyone appearing in its history. It exists so
 * the closure is not a bespoke lookup of its own and the history is not
 * a bespoke lookup of its own; they are the same question asked twice.
 *
 * TWO KINDS OF ACTOR, because the system has two kinds of account:
 *
 *   NORMAL     - an employee with a workforce profile: a real company,
 *                team and position.
 *   PRIVILEGED - a CEO / System Site Manager account, which holds no
 *                team or position at all. Its role label stands in for a
 *                job title, and is derived from the append-only
 *                privileged grant log rather than invented here. This
 *                mirrors `resolvePermitApplicantAuthority` exactly, and
 *                reuses its labels, so the same person is described the
 *                same way whether they applied for a permit or closed
 *                one.
 *
 * UNRESOLVABLE STAYS UNRESOLVABLE. An id with neither a privileged
 * identity nor a usable workforce profile is simply absent from the
 * returned map. Callers render that as unknown. Nothing is guessed, and
 * in particular no identity is ever read off a signature: a signature
 * says who AUTHORIZED the work, which is a different fact from who
 * performed a later action on it.
 *
 * READ-TIME, AND DELIBERATELY SO. Unlike `permit_signatures` - frozen at
 * the moment authorization is given, because it is authorization
 * evidence - this is a lookup against the CURRENT account records. The
 * limitation is worth stating plainly: if an actor is later renamed, or
 * moves team, or their privileged grant is revoked, this shows the new
 * value, and a name shown beside a two-year-old event is that person's
 * name today. The authoritative fact - the user id on the immutable
 * event - never changes, and neither do the frozen signatures on the
 * issued document. Freezing actor names onto every lifecycle event would
 * need new columns and a backfill of history that is deliberately
 * immutable; the authoritative record already answers the question
 * without it.
 */

export interface PermitActorIdentity {
  userId: string;
  kind: 'NORMAL' | 'PRIVILEGED';
  displayName: string;
  /** Privileged accounts belong to the operating company; E-SET, as everywhere else. */
  companyName: string | null;
  /** Null for a privileged account, which holds no team assignment. */
  teamName: string | null;
  /** Null for a privileged account, which holds no position. */
  positionName: string | null;
  /** The role that stands in for a job title, for a privileged actor only. */
  privilegedRole: PrivilegedApplicantRole | null;
}

/**
 * The identities of the given actors, keyed by user id.
 *
 * Ids that cannot be resolved are absent from the map - never present
 * with a placeholder name.
 */
export async function resolvePermitActorIdentities(
  queryFn: QueryFn,
  userIds: readonly string[],
): Promise<Map<string, PermitActorIdentity>> {
  const identities = new Map<string, PermitActorIdentity>();
  const wanted = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return identities;

  const privileged = await queryFn<{
    user_id: string;
    display_name: string;
    role: 'CEO' | 'SITE_MANAGER' | null;
  }>(
    // The privileged identity carries the name; the grant log carries
    // the role, and only a grant that is still in force counts - a
    // revoked account keeps its name but loses the role label rather
    // than being described by an authority it no longer holds.
    //
    // ORDER BY role LIMIT 1 picks CEO over SITE_MANAGER for an account
    // holding both ('CEO' sorts first), matching the precedence in
    // resolvePermitApplicantAuthority.
    `SELECT pi.user_id, pi.display_name, latest.role
       FROM privileged_identities pi
       LEFT JOIN LATERAL (
         SELECT current_grants.role
           FROM (
             SELECT DISTINCT ON (role) role, action
               FROM privileged_access_events pae
              WHERE pae.user_id = pi.user_id
              ORDER BY role, ordinal DESC
           ) current_grants
          WHERE current_grants.action = 'GRANTED'
            AND current_grants.role IN ('CEO', 'SITE_MANAGER')
          ORDER BY current_grants.role
          LIMIT 1
       ) latest ON TRUE
      WHERE pi.user_id = ANY($1)`,
    [wanted],
  );

  for (const row of privileged.rows) {
    const displayName = row.display_name?.trim();
    if (!row.user_id || !displayName) continue;
    identities.set(row.user_id, {
      userId: row.user_id,
      kind: 'PRIVILEGED',
      displayName,
      companyName: 'E-SET',
      // A privileged account genuinely has no team or position. Leaving
      // these null is the point: it must never be given a fabricated one.
      teamName: null,
      positionName: null,
      privilegedRole:
        row.role === 'CEO'
          ? PRIVILEGED_APPLICANT_ROLE_LABELS.CEO
          : row.role === 'SITE_MANAGER'
            ? PRIVILEGED_APPLICANT_ROLE_LABELS.SITE_MANAGER
            : null,
    });
  }

  const remaining = wanted.filter((id) => !identities.has(id));
  if (remaining.length === 0) return identities;

  const workforce = await queryFn<{
    user_id: string;
    display_name: string;
    company_name: string | null;
    team_name: string | null;
    position_name: string | null;
  }>(
    // LEFT JOINs throughout: an actor whose team assignment has since
    // ended still has a name, and a name is more useful than nothing.
    `SELECT wp.user_id,
            wp.display_name,
            c.name AS company_name,
            t.name AS team_name,
            p.name AS position_name
       FROM workforce_profiles wp
       LEFT JOIN companies c ON c.id = wp.company_id
       LEFT JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       LEFT JOIN teams t ON t.id = tp.team_id
       LEFT JOIN positions p ON p.id = tp.position_id
      WHERE wp.user_id = ANY($1)`,
    [remaining],
  );

  for (const row of workforce.rows) {
    const displayName = row.display_name?.trim();
    if (!row.user_id || !displayName) continue;
    identities.set(row.user_id, {
      userId: row.user_id,
      kind: 'NORMAL',
      displayName,
      companyName: row.company_name,
      teamName: row.team_name,
      positionName: row.position_name,
      // An employee's job title is their real workforce assignment,
      // never a privileged role.
      privilegedRole: null,
    });
  }

  return identities;
}
