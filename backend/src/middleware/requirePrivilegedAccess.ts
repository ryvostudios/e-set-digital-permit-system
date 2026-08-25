import type { NextFunction, Request, Response } from 'express';
import { resolvePrivilegedAccess, type PrivilegedRole } from '../authz/privilegedAccess.js';
import { toSafeDbErrorMessage } from '../db/pool.js';

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
}

function sendForbidden(res: Response): void {
  res.status(403).json({ error: 'forbidden', message: 'Privileged access required' });
}

/**
 * Express middleware factory enforcing default-deny privileged-access
 * authorization (CEO / Site Manager) for a single required role. Must run
 * after `requireAuth`. Mirrors `requireCapability` - not currently wired
 * to any route (no privileged-only action exists yet), provided as
 * foundation only.
 *
 * Default-deny: an unauthenticated request, a resolution error, or a
 * resolved set that doesn't contain the required role all result in the
 * same outcome - denied. Nothing here can fail open.
 *
 * `resolve` is injectable (defaulting to the real DB-backed resolver) so
 * this can be unit tested without a live database.
 */
export function requirePrivilegedAccess(
  role: PrivilegedRole,
  resolve: (userId: string) => Promise<Set<PrivilegedRole>> = resolvePrivilegedAccess,
) {
  return async function requirePrivilegedAccessMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.auth) {
      sendUnauthorized(res);
      return;
    }

    try {
      const roles = await resolve(req.auth.id);
      if (!roles.has(role)) {
        sendForbidden(res);
        return;
      }
      next();
    } catch (err) {
      console.error('Privileged access resolution failed:', toSafeDbErrorMessage(err));
      sendForbidden(res);
    }
  };
}
