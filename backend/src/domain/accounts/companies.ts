import { query, type QueryFn } from '../../db/pool.js';

/**
 * Authoritative company membership for NORMAL employees.
 *
 * Every normal employee belongs to exactly one company. The company is
 * server-side authoritative data: provisioning accepts one strict code
 * from this closed set and resolves it against the backend-only
 * `companies` table (migration 0018). It is NEVER inferred from an email
 * address or its domain, from Supabase `user_metadata`, from a permit
 * payload, from client state, or from a Team or Position name - and the
 * client can supply neither a company name, nor a company object, nor a
 * database identifier, nor a list of companies (see
 * `validation.ts::createEmployeeBodySchema`, which is `.strict()`).
 *
 * CEO and E-SET SITE_MANAGER are privileged SYSTEM accounts and have no
 * company membership at all; they are not provisioned through the
 * employee endpoints, so they never reach this module.
 */

export const COMPANY_CODES = ['E_SET', 'ZPL', 'SGRE'] as const;
export type CompanyCode = (typeof COMPANY_CODES)[number];

export interface AuthoritativeCompany {
  id: string;
  code: CompanyCode;
  name: string;
}

/**
 * Resolves a validated code against authoritative backend-only data.
 * Returns null when no such company exists - the caller must fail closed
 * on that BEFORE any Supabase Auth identity is created, so an unknown
 * company can never leave a half-provisioned Auth user behind.
 */
export async function resolveProvisioningCompany(
  code: CompanyCode,
  queryFn: QueryFn = query,
): Promise<AuthoritativeCompany | null> {
  const result = await queryFn<{ id: string; code: CompanyCode; name: string }>(
    `SELECT id, code, name FROM companies WHERE code = $1`,
    [code],
  );
  const row = result.rows[0];
  return row ? { id: row.id, code: row.code, name: row.name } : null;
}
