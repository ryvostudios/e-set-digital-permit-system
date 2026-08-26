import type { NextFunction, Request, Response } from 'express';
import { query, type QueryFn } from '../db/pool.js';
import { supabase, toSafeAuthErrorMessage } from '../lib/supabase.js';

/** Minimal, validated authentication identity attached to a request. Proves identity only — not authorization. */
export interface AuthIdentity {
  id: string;
  email: string | null;
  /**
   * Application-side credential state, read from `app_user_access` on
   * every authenticated request. `true` means the account holds a
   * temporary password that has not been replaced yet, and normal
   * application access is withheld until it is (see `requireAuth`).
   */
  mustChangePassword: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthIdentity;
  }
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
}

/**
 * The one response shape the frontend uses to detect "this session is
 * authenticated but must finish changing its password first". It carries
 * no detail about the credential itself - only that a change is
 * outstanding.
 */
export function sendPasswordChangeRequired(res: Response): void {
  res.status(403).json({
    error: 'password_change_required',
    reason: 'PASSWORD_CHANGE_REQUIRED',
    message: 'A password change is required before this account can be used',
  });
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface AppUserAccessState {
  state: 'ACTIVE' | 'DISABLED';
  must_change_password: boolean;
}

/**
 * The single per-request account-state read. Missing rows fail closed:
 * migration 0015 backfilled every existing Auth identity, and
 * provisioning inserts one for every new employee, so a missing row means
 * an Auth identity that was never (or only half-) provisioned - which
 * must never obtain access.
 *
 * Returns the credential state alongside ACTIVE/DISABLED so a
 * manager-initiated password reset takes effect on the very NEXT request
 * made with an already-issued token, without a second query and without
 * ever reading `auth.sessions`.
 */
export async function loadAppUserAccess(
  userId: string,
  queryFn: QueryFn = query,
): Promise<AppUserAccessState | null> {
  const result = await queryFn<AppUserAccessState>(
    'SELECT state, must_change_password FROM app_user_access WHERE user_id = $1',
    [userId],
  );
  return result.rows[0] ?? null;
}

/** Preserved for callers that only need the pre-existing ACTIVE/DISABLED answer. */
export async function isAppUserActive(userId: string, queryFn: QueryFn = query): Promise<boolean> {
  const access = await loadAppUserAccess(userId, queryFn);
  return access?.state === 'ACTIVE';
}

/**
 * Verifies the caller's Supabase access token server-side and attaches
 * the resulting identity to `req.auth`. Rejects with 401 on any missing
 * or invalid token, or on any account that is not ACTIVE. Never trusts a
 * client-supplied user/session object.
 *
 * Shared by both exported guards below; it deliberately does NOT decide
 * the forced-password-change question, so the two guards differ in
 * exactly one place.
 */
async function authenticate(req: Request, res: Response): Promise<AuthIdentity | null> {
  const token = extractBearerToken(req.header('authorization'));
  if (!token) {
    sendUnauthorized(res);
    return null;
  }

  try {
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data) {
      sendUnauthorized(res);
      return null;
    }

    const { claims } = data;
    const access = await loadAppUserAccess(claims.sub);
    if (access?.state !== 'ACTIVE') {
      sendUnauthorized(res);
      return null;
    }
    return {
      id: claims.sub,
      email: claims.email ?? null,
      mustChangePassword: access.must_change_password,
    };
  } catch (err) {
    console.error('Authentication verification failed:', toSafeAuthErrorMessage(err));
    sendUnauthorized(res);
    return null;
  }
}

/**
 * The default guard for every application route.
 *
 * FAIL-CLOSED BY DESIGN: an account with an outstanding password change
 * is refused here, so a route that simply uses `requireAuth` - including
 * any route added in future - is automatically covered. Only the two
 * endpoints that must remain reachable during a forced change opt out,
 * explicitly, by using `requireAuthDuringPasswordChange` below. There is
 * therefore no "alternate route" that quietly skips the check, because
 * skipping it requires naming a different middleware.
 *
 * This is also what makes a manager-initiated reset effective
 * IMMEDIATELY: an access token issued before the reset still verifies
 * against Supabase (it remains cryptographically valid until it
 * expires), but the account-state read above now reports
 * `must_change_password = true`, so the request is refused here rather
 * than proceeding to any Permit/JSA/records/admin operation.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;
  if (auth.mustChangePassword) {
    req.auth = auth;
    sendPasswordChangeRequired(res);
    return;
  }
  req.auth = auth;
  next();
}

/**
 * Authentication WITHOUT the forced-password-change gate - for the
 * minimum set of endpoints that must stay reachable while a change is
 * outstanding: reading one's own state (`/auth/me`) and performing the
 * change itself (`/auth/change-password`).
 *
 * Everything else `requireAuth` enforces (real token verification,
 * ACTIVE account) still applies unchanged, so this is never a way to
 * reach application data - the routes that use it expose none.
 */
export async function requireAuthDuringPasswordChange(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = await authenticate(req, res);
  if (!auth) return;
  req.auth = auth;
  next();
}
