import { Router, type Request, type Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { query } from '../db/pool.js';
import { requireAuthDuringPasswordChange } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * The caller's own display name and signing designation, if their
 * workforce profile is provisioned. Resolved with exactly the same join
 * the authoritative signing identity uses (migration 0016), so what the
 * frontend shows can never disagree with what a signature would say.
 * Returns null while a profile is missing - never an email, never a
 * client-supplied name, never a guess.
 */
async function loadOwnProfile(userId: string): Promise<{
  displayName: string;
  teamName: string;
  positionName: string;
} | null> {
  const result = await query<{ display_name: string; team_name: string; position_name: string }>(
    `SELECT wp.display_name, t.name AS team_name, p.name AS position_name
       FROM workforce_profiles wp
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
       JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
      WHERE wp.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? { displayName: row.display_name, teamName: row.team_name, positionName: row.position_name }
    : null;
}

/**
 * Identity plus the caller's own effective capabilities (Team + Position
 * -> Capabilities, resolved the same way `requireCapability` does) - so
 * the frontend can decide what to show without duplicating the
 * authorization model. This is a display convenience only: every actual
 * mutation/read endpoint independently re-resolves and re-checks
 * capabilities server-side (SECURITY.md default-deny; ARCHITECTURE.md -
 * frontend visibility is never a security control).
 */
authRouter.get('/auth/me', requireAuthDuringPasswordChange, async (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }
  // Deliberately mounted with `requireAuthDuringPasswordChange`: an
  // account that owes a password change must still be able to discover
  // that fact, and this endpoint exposes no application data.
  //
  // `mustChangePassword` is the ONLY credential information exposed - a
  // single boolean. No password, temporary password, token, credential
  // timestamp, Auth admin detail, or reason-for-reset is returned.
  const [capabilities, profile] = await Promise.all([
    resolveUserCapabilities(req.auth.id),
    loadOwnProfile(req.auth.id),
  ]);
  res.status(200).json({
    // Explicitly shaped, never a spread of the internal identity object:
    // a field added to `AuthIdentity` later can never leak into this
    // response by accident.
    auth: { id: req.auth.id, email: req.auth.email },
    accessState: 'ACTIVE',
    mustChangePassword: req.auth.mustChangePassword,
    profile,
    capabilities: [...capabilities],
  });
});
