import type { NextFunction, Request, Response } from 'express';
import { resolvePrivilegedAccess } from '../authz/privilegedAccess.js';
import { resolveUserCapabilities } from '../authz/capabilities.js';

/** CEO or an explicit, currently active individual CMS grant. */
export function requireCmsManage(
  resolveRoles: typeof resolvePrivilegedAccess = resolvePrivilegedAccess,
  resolveCapabilities: typeof resolveUserCapabilities = resolveUserCapabilities,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
      return;
    }
    try {
      const [roles, capabilities] = await Promise.all([
        resolveRoles(req.auth.id), resolveCapabilities(req.auth.id),
      ]);
      if (roles.has('CEO') || capabilities.has('permit.cms.manage')) { next(); return; }
    } catch { /* authorization resolution fails closed */ }
    res.status(403).json({ error: 'forbidden', message: 'CMS authority required' });
  };
}
