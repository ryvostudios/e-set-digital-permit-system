import type { QueryFn } from '../../db/pool.js';
import type { PrivilegedRole } from '../../authz/privilegedAccess.js';

export interface PermitApplicantIdentity {
  kind: 'NORMAL' | 'PRIVILEGED';
  displayName: string;
  companyCode: 'E_SET' | 'ZPL' | 'SGRE';
  companyName: 'E-SET' | 'ZPL' | 'SGRE';
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
    return {
      allowed: true,
      identity: { kind: 'PRIVILEGED', displayName: privilegedName, companyCode: 'E_SET', companyName: 'E-SET' },
    };
  }

  const normal = await queryFn<{
    display_name: string; company_code: 'E_SET' | 'ZPL' | 'SGRE'; company_name: 'E-SET' | 'ZPL' | 'SGRE';
    team_name: string; position_name: string;
  }>(
    `SELECT wp.display_name, c.code AS company_code, c.name AS company_name,
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
      kind: 'NORMAL', displayName, companyCode: row.company_code, companyName: row.company_name,
    },
  };
}
