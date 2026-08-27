import type { NextFunction, Request, Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { resolvePrivilegedAccess } from '../authz/privilegedAccess.js';
import { isPermitApplicantAuthorized } from '../domain/permits/access.js';

export function requirePermitApplicant(requiredCapability: 'permit.create' | 'permit.submit') {
 return function permitApplicantMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }
  void Promise.all([resolveUserCapabilities(req.auth.id), resolvePrivilegedAccess(req.auth.id)])
    .then(([capabilities, roles]) => {
      // Shared with `computeAvailableActions` so the write path and the
      // UI's action hint can never disagree about who may apply.
      if (!isPermitApplicantAuthorized(capabilities, roles, requiredCapability)) {
        res.status(403).json({ error: 'forbidden', message: 'Permit application is not allowed for this identity' });
        return;
      }
      next();
    })
    .catch(() => res.status(403).json({ error: 'forbidden', message: 'Permit application is not allowed for this identity' }));
 };
}
