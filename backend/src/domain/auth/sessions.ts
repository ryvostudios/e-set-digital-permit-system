import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import type { QueryFn } from '../../db/pool.js';

/**
 * Permit browser sessions.
 *
 * SERVER-SIDE, NOT A SIGNED TOKEN. The cookie carries 32 random bytes and
 * nothing else; `permit.user_sessions` stores only their SHA-256 digest.
 * A session is valid while its row exists, is unrevoked and unexpired, so
 * revocation is real and immediate:
 *
 *   logout ........................ this session
 *   own password change ........... every OTHER session of the account
 *   manager reset / email change .. every session of the account
 *   disable / delete .............. every session of the account
 *
 * There is no signing secret to protect, rotate or share: a database
 * read-only leak yields digests, which cannot be turned back into
 * cookies. The account-state gate (`app_user_access`) is still applied on
 * every request by middleware/auth.ts, so a disabled account is refused
 * even before its sessions are revoked.
 */

export const SESSION_COOKIE = 'permit_session';
/** Scoped to the API: the cookie is never sent with page or asset requests. */
const COOKIE_PATH = '/api/v1';
/** Browser-session sign-in (Remember me unchecked): closes with the browser, and never outlives this. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Remember me checked: a persistent cookie with this lifetime. */
export const REMEMBERED_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The session token from the request's Cookie header, if it is well-formed. */
export function readSessionToken(req: Request): string | null {
  const header = req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_FORMAT.test(value) ? value : null;
  }
  return null;
}

function cookieOptions(): CookieOptions {
  // Host-only (no Domain), so no other application on a sibling host -
  // ESDMS included - ever receives it.
  return { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: COOKIE_PATH };
}

export function setSessionCookie(res: Response, token: string, remember: boolean): void {
  res.cookie(SESSION_COOKIE, token, remember ? { ...cookieOptions(), maxAge: REMEMBERED_SESSION_TTL_MS } : cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export async function createSession(queryFn: QueryFn, userId: string, remember: boolean): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = remember ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS;
  await queryFn(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + $3::bigint * interval '1 millisecond')`,
    [userId, tokenDigest(token), ttlMs],
  );
  return token;
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  email: string | null;
}

export async function findActiveSession(queryFn: QueryFn, token: string): Promise<ActiveSession | null> {
  const result = await queryFn<{ session_id: string; user_id: string; email: string | null }>(
    `SELECT s.id AS session_id, s.user_id, u.email
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenDigest(token)],
  );
  const row = result.rows[0];
  return row ? { sessionId: row.session_id, userId: row.user_id, email: row.email } : null;
}

export async function revokeSessionByToken(queryFn: QueryFn, token: string): Promise<void> {
  await queryFn('UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    tokenDigest(token),
  ]);
}

/** Revokes every live session of an account, optionally keeping the caller's own. */
export async function revokeUserSessions(queryFn: QueryFn, userId: string, exceptSessionId?: string): Promise<void> {
  await queryFn(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
}
