import { query, type QueryFn } from '../../db/pool.js';

/**
 * Authoritative company membership for NORMAL employees.
 *
 * Every normal employee belongs to exactly one company, and that company
 * is server-side authoritative data. Provisioning accepts a company CODE
 * and resolves it against the backend-only `companies` table (migration
 * 0018). It is NEVER inferred from an email address or its domain, from
 * Supabase `user_metadata`, from a permit payload, from client state, or
 * from a Team or Position name - and the client can supply neither a
 * company name, nor a company object, nor a database identifier, nor a
 * list of companies (see `validation.ts`, whose schemas are `.strict()`).
 *
 * THE SET OF COMPANIES IS OPEN, AND HAS BEEN SINCE MIGRATION 0035.
 * Organization Management creates companies at runtime, so this module
 * deliberately has no closed list: a company created this morning must
 * work this afternoon with no deployment. What makes a code acceptable
 * is not membership of a hardcoded union but the row it resolves to -
 * present, and not retired.
 *
 * A COMPANY CODE IS AN IDENTIFIER, NEVER AUTHORITY. It is generated
 * server-side (`organizationCodes.ts`), frozen by migration 0035, and
 * read here only to find a row. Nothing anywhere grants a capability,
 * a privileged role, or any permission because of what a company,
 * team or position is called.
 *
 * CEO and E-SET SITE_MANAGER are privileged SYSTEM accounts and have no
 * company membership at all; they are not provisioned through the
 * employee endpoints, so they never reach this module.
 */

export interface AuthoritativeCompany {
  id: string;
  code: string;
  name: string;
}

/**
 * Resolves a validated code against authoritative backend-only data.
 *
 * Returns null when no such company exists OR when it has been retired -
 * a deactivated company is not a provisioning destination, and the
 * caller must fail closed on that BEFORE any Supabase Auth identity is
 * created, so an unusable company can never leave a half-provisioned
 * Auth user behind.
 */
export async function resolveProvisioningCompany(
  code: string,
  queryFn: QueryFn = query,
): Promise<AuthoritativeCompany | null> {
  const result = await queryFn<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM companies WHERE code = $1 AND deactivated_at IS NULL`,
    [code],
  );
  const row = result.rows[0];
  return row ? { id: row.id, code: row.code, name: row.name } : null;
}

export type ProvisioningDestinationRefusal =
  | 'company_not_found'
  | 'team_position_not_assignable';

export type ProvisioningDestination =
  | { ok: true; company: AuthoritativeCompany }
  | { ok: false; reason: ProvisioningDestinationRefusal };

/**
 * The ONE question employee provisioning actually needs answered: may
 * this employee be placed at this Company + Team + Position, right now?
 *
 * Asked as a single statement rather than as "does the company exist?"
 * followed by "is the combination assignable?", because those two
 * answers are individually true for a Team + Position belonging to a
 * DIFFERENT company. Only the join proves the destination is coherent.
 *
 * Every condition below must hold:
 *
 *   * the company exists and is ACTIVE;
 *   * the Team + Position exists and is ACTIVE;
 *   * its owning team exists, is ACTIVE, and belongs to THAT company;
 *   * the combination carries `site_manager_assignable` - the
 *     operator-controlled flag that says a manager may place someone
 *     here at all. Existence is deliberately not sufficient: an
 *     assignment may carry security-sensitive capabilities.
 *
 * Anything else fails closed, and the refusal never distinguishes
 * "belongs to another company" from "does not exist" - a caller learns
 * nothing about structure it did not already name.
 *
 * NOT THE FINAL AUTHORITY, AND NOT MEANT TO BE. Migration 0035's
 * triggers re-check the active chain inside the writing transaction, and
 * migration 0019's guard re-checks that the profile's company owns the
 * team behind its assignment. This exists so a bad destination is
 * refused BEFORE any external Auth work happens - it closes the window,
 * it does not replace the database.
 */
export async function resolveProvisioningDestination(
  companyCode: string,
  teamPositionId: string,
  queryFn: QueryFn = query,
): Promise<ProvisioningDestination> {
  const company = await resolveProvisioningCompany(companyCode, queryFn);
  if (!company) return { ok: false, reason: 'company_not_found' };

  const destination = await queryFn<{ exists: boolean }>(
    `SELECT TRUE AS exists
       FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id
       JOIN companies c ON c.id = t.company_id
      WHERE tp.id = $1
        AND c.id = $2
        AND tp.site_manager_assignable = TRUE
        AND tp.deactivated_at IS NULL
        AND t.deactivated_at IS NULL
        AND c.deactivated_at IS NULL`,
    [teamPositionId, company.id],
  );
  if (destination.rows.length === 0) {
    return { ok: false, reason: 'team_position_not_assignable' };
  }
  return { ok: true, company };
}
