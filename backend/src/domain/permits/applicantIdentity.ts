import type { QueryFn } from '../../db/pool.js';
import type { PrivilegedRole } from '../../authz/privilegedAccess.js';

/** The privileged roles that may apply for a permit, as they are described to a person. */
export const PRIVILEGED_APPLICANT_ROLE_LABELS = {
  CEO: 'CEO',
  SITE_MANAGER: 'System Site Manager',
} as const;

export type PrivilegedApplicantRole = (typeof PRIVILEGED_APPLICANT_ROLE_LABELS)[keyof typeof PRIVILEGED_APPLICANT_ROLE_LABELS];

export interface PermitApplicantIdentity {
  kind: 'NORMAL' | 'PRIVILEGED';
  displayName: string;
  /**
   * The AUTHORITATIVE applicant company: the `companies` row itself.
   *
   * Migration 0035 made this a real foreign key on the permit
   * (`applicant_company_id`) so a company created at runtime is a
   * first-class applicant company rather than a string the schema has to
   * recognise. It is what the completeness CHECK now requires.
   */
  companyId: string;
  /**
   * The company's code and display name AT THE TIME, frozen alongside
   * the identity. Migration 0024 froze the name so a later rename cannot
   * alter an issued document, and that remains exactly their role: they
   * are the display snapshot, no longer a closed vocabulary. Typed as
   * `string` because the set of companies is now dynamic.
   */
  companyCode: string;
  companyName: string;
  /**
   * PRIVILEGED applicants only: the role that stands in for a job title,
   * because a privileged account holds no team or position and must
   * never be given a fabricated one. Null for a normal employee, whose
   * team and position are their real workforce assignment.
   *
   * Derived here from the append-only privileged grant log - never from
   * the request - so it cannot be supplied, chosen or spoofed by a
   * client.
   */
  privilegedRole: PrivilegedApplicantRole | null;
}

export interface PermitApplicantAuthority {
  allowed: boolean;
  identity?: PermitApplicantIdentity;
}

export async function resolvePermitApplicantAuthority(
  queryFn: QueryFn,
  userId: string,
): Promise<PermitApplicantAuthority> {
  const privileged = await queryFn<{ role: PrivilegedRole; display_name: string }>(
    `SELECT latest.role, pi.display_name
       FROM (
         SELECT DISTINCT ON (role) role, action
           FROM privileged_access_events
          WHERE user_id = $1
          ORDER BY role, ordinal DESC
       ) latest
       JOIN privileged_identities pi ON pi.user_id = $1
      WHERE latest.action = 'GRANTED' AND latest.role IN ('CEO', 'SITE_MANAGER')`,
    [userId],
  );
  const privilegedName = privileged.rows[0]?.display_name?.trim();
  if (privileged.rows.length > 0) {
    if (!privilegedName) return { allowed: false };
    // CEO outranks, so an account holding both grants is described by the
    // higher one rather than by whichever row came back first.
    const role = privileged.rows.some((row) => row.role === 'CEO')
      ? PRIVILEGED_APPLICANT_ROLE_LABELS.CEO
      : PRIVILEGED_APPLICANT_ROLE_LABELS.SITE_MANAGER;
    // A privileged system account holds no company membership, so E-SET
    // is derived server-side exactly as migration 0024 specified. The
    // row is READ rather than the code hardcoded into the permit,
    // because the permit now stores the authoritative company id and a
    // fabricated one would not reference a real company.
    const eset = await queryFn<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM companies WHERE code = 'E_SET'`,
    );
    const esetRow = eset.rows[0];
    // Fail closed: without the authoritative company row there is no
    // complete applicant identity to freeze.
    if (!esetRow) return { allowed: false };
    return {
      allowed: true,
      identity: {
        kind: 'PRIVILEGED',
        displayName: privilegedName,
        companyId: esetRow.id,
        companyCode: esetRow.code,
        companyName: esetRow.name,
        privilegedRole: role,
      },
    };
  }

  const normal = await queryFn<{
    display_name: string; company_id: string; company_code: string; company_name: string;
    team_name: string; position_name: string;
  }>(
    `SELECT wp.display_name, c.id AS company_id, c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name
       FROM workforce_profiles wp
       JOIN companies c ON c.id = wp.company_id
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
        AND utp.ended_at IS NULL
       JOIN team_positions tp ON tp.id = utp.team_position_id
       JOIN teams t ON t.id = tp.team_id AND t.company_id = wp.company_id
       JOIN positions p ON p.id = tp.position_id
      WHERE wp.user_id = $1`,
    [userId],
  );
  const row = normal.rows[0];
  if (!row) return { allowed: false };
  const displayName = row.display_name.trim();
  if (!displayName) return { allowed: false };
  return {
    allowed: true,
    identity: {
      kind: 'NORMAL', displayName,
      companyId: row.company_id, companyCode: row.company_code, companyName: row.company_name,
      // A normal employee's job title is their real workforce assignment,
      // never a privileged role.
      privilegedRole: null,
    },
  };
}
