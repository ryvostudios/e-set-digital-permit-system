import { Pool } from 'pg';
import { env } from '../config/env.js';
import { buildSslConfig, toSafeDbErrorMessage } from './pool.js';

/**
 * A SEPARATE database channel for the one operation the ordinary runtime
 * credential must never be able to perform: appending a CEO-authorized
 * SITE_MANAGER grant or revoke.
 *
 * WHY THIS EXISTS. `privileged_access_events` is what decides who holds
 * system authority. If the ordinary `app_runtime` login could write it -
 * whether by direct INSERT or by EXECUTE on a grant function - then
 * possession of `DATABASE_URL` alone would be enough to hand out
 * SITE_MANAGER, because the caller could simply pass the real CEO's id
 * as the actor. Route-level CEO checks are irrelevant to someone
 * speaking SQL directly. So the write lives behind a different login
 * entirely: `privileged_runtime`, which holds CONNECT, schema USAGE, and
 * EXECUTE on exactly one hardened function - and no table privilege of
 * any kind (see DEPLOYMENT.md).
 *
 * TWO INDEPENDENT GATES, NEITHER SUFFICIENT ALONE:
 *   1. HTTP - the authenticated caller is re-resolved as an active CEO
 *      from `privileged_access_events` on every request.
 *   2. DATABASE - the SECURITY DEFINER function independently re-derives
 *      the supplied actor's CEO status, hardcodes the role literal
 *      'SITE_MANAGER', and refuses a self-change, a CEO target, a
 *      workforce employee, or a target with no privileged identity.
 * A leaked `app_runtime` credential passes neither: it cannot reach the
 * function at all.
 *
 * DELIBERATELY NARROW. This module exports no pool, no client, and no
 * generic query function - only the two privileged operations. There is
 * nothing here for a permit, account, or notification service to reach
 * through, and adding one would require editing this file on purpose.
 *
 * FAIL CLOSED. When `PRIVILEGED_DATABASE_URL` is absent the adapter is
 * simply unavailable and the CEO endpoints return a sanitized 503, the
 * same posture the Auth Admin credential uses. Ordinary backend startup
 * and every non-privileged request are unaffected.
 */

let privilegedPool: Pool | undefined;

/**
 * A small, independent pool. It is intentionally tiny: this channel
 * serves rare CEO administration, never request-path traffic, so it must
 * not be able to consume connection headroom the application depends on.
 * Timeouts mirror the main pool's bounded posture.
 */
function getPrivilegedPool(): Pool | null {
  if (!env.PRIVILEGED_DATABASE_URL) return null;
  privilegedPool ??= new Pool({
    connectionString: env.PRIVILEGED_DATABASE_URL,
    ssl: buildSslConfig(),
    max: 2,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });
  return privilegedPool;
}

/** Whether privileged administration is configured at all. Callers turn `false` into a sanitized "unavailable" response - never into a silent success. */
export function isPrivilegedChannelConfigured(): boolean {
  return Boolean(env.PRIVILEGED_DATABASE_URL);
}

/**
 * The ONLY statement this channel ever runs. The role written is fixed
 * inside the database function, so no argument here - correct, buggy, or
 * hostile - can produce a CEO grant.
 */
const RECORD_GRANT_SQL = 'SELECT public.record_site_manager_grant($1, $2, $3)';

export type PrivilegedGrantResult = { ok: true } | { ok: false; reason: 'unavailable' | 'refused' };

/**
 * The narrow interface the account domain depends on. Keeping it an
 * interface (rather than importing the pool directly) is what lets the
 * service be tested without a database while still making it impossible
 * for that service to issue any other privileged statement.
 */
export interface PrivilegedAccessAdmin {
  recordSiteManagerGrant(actorUserId: string, targetUserId: string): Promise<PrivilegedGrantResult>;
  recordSiteManagerRevoke(actorUserId: string, targetUserId: string): Promise<PrivilegedGrantResult>;
}

async function record(
  actorUserId: string,
  targetUserId: string,
  action: 'GRANTED' | 'REVOKED',
): Promise<PrivilegedGrantResult> {
  const pool = getPrivilegedPool();
  if (!pool) return { ok: false, reason: 'unavailable' };
  try {
    await pool.query(RECORD_GRANT_SQL, [actorUserId, targetUserId, action]);
    return { ok: true };
  } catch (err) {
    // The function raises a descriptive exception for every refusal it
    // enforces (non-CEO actor, CEO target, workforce employee, missing
    // privileged identity). None of that detail - and no connection
    // string - may reach a log line or a response.
    console.error('Privileged access write failed:', toSafeDbErrorMessage(err));
    return { ok: false, reason: 'refused' };
  }
}

/** The real adapter. Returns null when the privileged channel is not configured, so callers must fail closed explicitly. */
export function createPrivilegedAccessAdmin(): PrivilegedAccessAdmin | null {
  if (!isPrivilegedChannelConfigured()) return null;
  return {
    recordSiteManagerGrant: (actorUserId, targetUserId) => record(actorUserId, targetUserId, 'GRANTED'),
    recordSiteManagerRevoke: (actorUserId, targetUserId) => record(actorUserId, targetUserId, 'REVOKED'),
  };
}

/** Releases the privileged pool, mirroring `closePool()` for orderly shutdown. */
export async function closePrivilegedPool(): Promise<void> {
  const existing = privilegedPool;
  privilegedPool = undefined;
  if (existing) await existing.end();
}
