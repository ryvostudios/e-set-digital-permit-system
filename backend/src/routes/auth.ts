import { Router, type Request, type Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * Identity plus the caller's own effective capabilities (Team + Position
 * -> Capabilities, resolved the same way `requireCapability` does) - so
 * the frontend can decide what to show without duplicating the
 * authorization model. This is a display convenience only: every actual
 * mutation/read endpoint independently re-resolves and re-checks
 * capabilities server-side (SECURITY.md default-deny; ARCHITECTURE.md -
 * frontend visibility is never a security control).
 */
authRouter.get('/auth/me', requireAuth, async (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }
  const capabilities = await resolveUserCapabilities(req.auth.id);
  res.status(200).json({ auth: req.auth, capabilities: [...capabilities] });
});
