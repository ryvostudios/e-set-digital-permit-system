import type { QueryFn } from '../../db/pool.js';

/**
 * READ-ONLY administrative directory queries.
 *
 * These exist so a manager's screen can NAME the things the mutating
 * account endpoints already accept - which employees exist, which
 * Team + Position combinations an employee may legitimately be placed
 * into, and which privileged identities a CEO may grant or revoke. They
 * create, change and grant nothing: every statement in this module is a
 * `SELECT`, and none of them is an authorization decision. The caller
 * (routes/accounts.ts) applies exactly the same `authorize()` /
 * `authorizeCeo()` gate the corresponding mutations already use, so this
 * module widens no authority.
 *
 * WHAT IS DELIBERATELY NOT RETURNED. No email address (the login lives
 * in Supabase Auth and is not this application's to echo back), no
 * password or credential material, no `credential_version`, no
 * reset-pending marker, no raw audit ordinal, and no Team + Position
 * capability list. `mustChangePassword` is the single credential-adjacent
 * boolean, exactly as `/auth/me` and `loadEmployeeDetail` already expose.
 *
 * PRIVILEGED ACCOUNTS ARE NEVER NORMAL EMPLOYEES. `listEmployees` filters
 * out every account holding an active privileged grant, from the same
 * authoritative append-only log `loadEmployeeDetail` consults - so the
 * employee directory cannot be used to discover, count, or probe for the
 * CEO / Site Manager tier, matching that function's existing behaviour.
 */

export interface EmployeeListItem {
  userId: string;
  displayName: string;
  state: 'ACTIVE' | 'DISABLED' | 'DELETED';
  mustChangePassword: boolean;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
  teamPositionId: string;
  /** Whether the individually-grantable `permit.view_all` permission is currently active for this employee. */
  viewAllPermits: boolean;
}

export interface EmployeeListFilters {
  /** Case-insensitive substring match on the authoritative display name. */
  search?: string | undefined;
  state?: 'ACTIVE' | 'DISABLED' | 'DELETED' | undefined;
  /**
   * Filters on the authoritative `companies.code`. Typed as `string`
   * because the set of companies is managed at runtime (migration
   * 0035); the value is still BOUND as a parameter, never interpolated,
   * so an unknown code simply matches nothing.
   */
  companyCode?: string | undefined;
}

export interface DirectoryPageParams {
  page: number;
  pageSize: number;
}

const EMPLOYEE_DIRECTORY_FROM = `
       FROM app_user_access a
       JOIN workforce_profiles wp ON wp.user_id = a.user_id
       JOIN companies c ON c.id = wp.company_id
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
        AND utp.ended_at IS NULL
       JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id`;

/**
 * The one access predicate, shared by the page query and its COUNT so
 * the total can never describe a wider set than the rows. Every filter
 * value is bound as a parameter - the SQL text itself is fixed, so no
 * filter can alter the statement's shape.
 */
const EMPLOYEE_DIRECTORY_WHERE = `
      WHERE NOT EXISTS (
              SELECT 1 FROM (
                SELECT DISTINCT ON (role) role, action
                  FROM privileged_access_events
                 WHERE user_id = a.user_id
                 ORDER BY role, ordinal DESC
              ) latest WHERE latest.action = 'GRANTED'
            )
        AND ($1::text IS NULL OR wp.display_name ILIKE $1)
        AND ($2::text IS NULL OR a.state = $2)
        AND ($3::text IS NULL OR c.code = $3)`;

/** The employee directory, ordered by display name so paging is stable. */
export async function listEmployees(
  queryFn: QueryFn,
  filters: EmployeeListFilters,
  pageParams: DirectoryPageParams,
): Promise<{ items: EmployeeListItem[]; totalCount: number }> {
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;
  const params: unknown[] = [search, filters.state ?? null, filters.companyCode ?? null];

  const rows = await queryFn<{
    user_id: string;
    state: 'ACTIVE' | 'DISABLED' | 'DELETED';
    must_change_password: boolean;
    display_name: string;
    company_code: string;
    company_name: string;
    team_name: string;
    position_name: string;
    team_position_id: string;
    view_all_permits: boolean;
  }>(
    `SELECT a.user_id, a.state, a.must_change_password, wp.display_name,
            c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name,
            wp.primary_team_position_id AS team_position_id,
            EXISTS (
              SELECT 1 FROM (
                SELECT DISTINCT ON (capability_id) capability_id, action
                  FROM user_capability_grants
                 WHERE user_id = a.user_id
                 ORDER BY capability_id, ordinal DESC
              ) latest
              JOIN capabilities cap ON cap.id = latest.capability_id
             WHERE latest.action = 'GRANTED' AND cap.name = 'permit.view_all'
            ) AS view_all_permits
       ${EMPLOYEE_DIRECTORY_FROM}
       ${EMPLOYEE_DIRECTORY_WHERE}
      ORDER BY wp.display_name ASC, a.user_id ASC
      LIMIT $4 OFFSET $5`,
    [...params, pageParams.pageSize, (pageParams.page - 1) * pageParams.pageSize],
  );

  const total = await queryFn<{ count: string }>(
    `SELECT count(*)::text AS count ${EMPLOYEE_DIRECTORY_FROM} ${EMPLOYEE_DIRECTORY_WHERE}`,
    params,
  );

  return {
    items: rows.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      state: row.state,
      mustChangePassword: row.must_change_password,
      company: { code: row.company_code, name: row.company_name },
      teamName: row.team_name,
      positionName: row.position_name,
      teamPositionId: row.team_position_id,
      viewAllPermits: row.view_all_permits,
    })),
    totalCount: Number(total.rows[0]?.count ?? '0'),
  };
}

export interface OrganizationPosition {
  teamPositionId: string;
  positionName: string;
}

export interface OrganizationTeam {
  teamName: string;
  positions: OrganizationPosition[];
}

export interface OrganizationCompany {
  code: string;
  name: string;
  teams: OrganizationTeam[];
}

/**
 * The operator-owned organization structure a manager may provision
 * into: every Team + Position combination carrying the
 * `site_manager_assignable` flag, grouped by its owning company.
 *
 * This is the SAME flag `teamPositionIsSiteManagerAssignable` checks
 * before a create/transfer is allowed, read from the same table, so a
 * combination offered here is exactly a combination the mutation would
 * accept - and one that is not offered is one the mutation refuses.
 * Nothing here decides assignability: migration 0020 set it for the
 * launch structure, and `domain/accounts/organization.ts` sets it on
 * INSERT of a brand-new association it has just created - never by
 * UPDATE of an existing one, and never from a request field.
 *
 * ONLY ACTIVE STRUCTURE IS OFFERED. A combination whose association,
 * team or company has been deactivated is withheld here, because it is
 * exactly what the database now refuses to accept a new employee
 * assignment into.
 *
 * Capability mappings are deliberately NOT exposed: which permissions a
 * Team + Position carries is authorization data, and a management screen
 * has no need of it.
 */
export async function loadOrganization(queryFn: QueryFn): Promise<OrganizationCompany[]> {
  const result = await queryFn<{
    company_code: string;
    company_name: string;
    team_name: string;
    position_name: string;
    team_position_id: string;
  }>(
    `SELECT c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name, tp.id AS team_position_id
       FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id
       JOIN companies c ON c.id = t.company_id
       JOIN positions p ON p.id = tp.position_id
      WHERE tp.site_manager_assignable = TRUE
        AND tp.deactivated_at IS NULL
        AND t.deactivated_at IS NULL
        AND c.deactivated_at IS NULL
      ORDER BY c.name ASC, t.name ASC, p.name ASC`,
  );

  const companies: OrganizationCompany[] = [];
  for (const row of result.rows) {
    let company = companies.find((entry) => entry.code === row.company_code);
    if (!company) {
      company = { code: row.company_code, name: row.company_name, teams: [] };
      companies.push(company);
    }
    let team = company.teams.find((entry) => entry.teamName === row.team_name);
    if (!team) {
      team = { teamName: row.team_name, positions: [] };
      company.teams.push(team);
    }
    team.positions.push({ teamPositionId: row.team_position_id, positionName: row.position_name });
  }
  // Every ACTIVE company is surfaced, not a fixed set of three. The
  // organization is managed at runtime (migration 0035), so a closed
  // allowlist here would silently hide a company an administrator had
  // just created - while adding nothing, because the query already
  // restricts rows to explicitly assignable combinations whose whole
  // company/team/association chain is active, which is exactly what the
  // mutating endpoints independently re-check.
  return companies;
}

export interface SiteManagerListItem {
  userId: string;
  displayName: string;
  /** Whether the SITE_MANAGER grant is currently active, from the latest event for that role. */
  active: boolean;
  accountState: 'ACTIVE' | 'DISABLED' | 'DELETED' | null;
}

/**
 * The E-SET Site Manager tier, for the CEO-only administration screen -
 * every named privileged identity that currently holds, or has ever
 * held, SITE_MANAGER, together with whether the grant is active right
 * now.
 *
 * THE CEO TIER IS EXCLUDED. An identity holding an active CEO grant is
 * filtered out entirely: the grant/revoke endpoints refuse to touch it
 * anyway, and listing it would present the CEO as an administrable Site
 * Manager. An identity that has never had a SITE_MANAGER event at all is
 * not a Site Manager and is not listed either.
 */
export async function listSiteManagers(queryFn: QueryFn): Promise<SiteManagerListItem[]> {
  const result = await queryFn<{
    user_id: string;
    display_name: string;
    active: boolean;
    account_state: 'ACTIVE' | 'DISABLED' | 'DELETED' | null;
  }>(
    `SELECT pi.user_id, pi.display_name,
            (sm.action = 'GRANTED') AS active,
            a.state AS account_state
       FROM privileged_identities pi
       JOIN LATERAL (
         SELECT action
           FROM privileged_access_events
          WHERE user_id = pi.user_id AND role = 'SITE_MANAGER'
          ORDER BY ordinal DESC
          LIMIT 1
       ) sm ON TRUE
       LEFT JOIN app_user_access a ON a.user_id = pi.user_id
      WHERE NOT EXISTS (
              SELECT 1 FROM (
                SELECT action
                  FROM privileged_access_events
                 WHERE user_id = pi.user_id AND role = 'CEO'
                 ORDER BY ordinal DESC
                 LIMIT 1
              ) ceo WHERE ceo.action = 'GRANTED'
            )
      ORDER BY pi.display_name ASC, pi.user_id ASC`,
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    active: row.active,
    accountState: row.account_state,
  }));
}
