import type { NextFunction, Request, Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { toSafeDbErrorMessage } from '../db/pool.js';

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
}

function sendForbidden(res: Response): void {
  res.status(403).json({ error: 'forbidden', message: 'Insufficient capability' });
}

/**
 * Express middleware factory enforcing default-deny capability
 * authorization for a single required capability. Must run after
 * `requireAuth` (reads `req.auth`, never a client-supplied role/label).
 *
 * Default-deny: an unauthenticated request, a resolution error, or a
 * resolved set that simply doesn't contain the capability all result in
 * the same outcome - denied. Nothing here can fail open.
 *
 * `resolve` is injectable (defaulting to the real DB-backed resolver) so
 * this can be unit tested without a live database.
 */
export function requireCapability(
  capability: string,
  resolve: (userId: string) => Promise<Set<string>> = resolveUserCapabilities,
) {
  return async function requireCapabilityMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.auth) {
      sendUnauthorized(res);
      return;
    }

    try {
      const capabilities = await resolve(req.auth.id);
      if (!capabilities.has(capability)) {
        sendForbidden(res);
        return;
      }
      next();
    } catch (err) {
      console.error('Capability resolution failed:', toSafeDbErrorMessage(err));
      sendForbidden(res);
    }
  };
}
