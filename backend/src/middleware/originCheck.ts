import type { NextFunction, Request, Response } from 'express';
import { isAllowedOrigin } from '../config/cors.js';
import { readSessionToken } from '../domain/auth/sessions.js';

/**
 * CROSS-SITE REQUEST FORGERY GUARD for cookie-authenticated requests.
 *
 * The Permit session is an ambient credential: the browser attaches the
 * cookie by itself. Three layers keep another site from using it:
 *   1. the cookie is SameSite=Lax, so browsers do not attach it to
 *      cross-site subresource or form POST requests;
 *   2. CORS (config/cors.ts) refuses any request whose Origin is not an
 *      allowlisted frontend origin;
 *   3. this guard: a state-changing request that carries a session cookie
 *      (and sign-in itself, which would otherwise allow login CSRF) must
 *      PROVE its origin - an allowlisted Origin header, or failing that an
 *      allowlisted Referer. A request that proves nothing is refused,
 *      covering clients that omit Origin.
 *
 * Requests without a session cookie gain nothing from forgery and fall
 * through to normal authentication, which refuses them.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const guarded = readSessionToken(req) !== null || /(?:^|;\s*)permit_session=/.test(req.header('cookie') ?? '')
    || req.path === '/auth/login';
  if (!guarded) {
    next();
    return;
  }
  const origin = req.header('origin') ?? refererOrigin(req.header('referer'));
  if (origin && isAllowedOrigin(origin)) {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
}
