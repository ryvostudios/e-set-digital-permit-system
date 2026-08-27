import { Router, type Request, type Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { resolvePrivilegedAccess } from '../authz/privilegedAccess.js';
import { query } from '../db/pool.js';
import { resolvePrivilegedDisplayName } from '../domain/accounts/privilegedIdentities.js';
import { requireAuthDuringPasswordChange } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * The caller's own ORGANIZATIONAL identity - display name, authoritative
 * Company, and signing designation - if their workforce profile is
 * provisioned. Resolved with exactly the same join the authoritative
 * signing identity uses (migrations 0016 + 0018), so what the frontend
 * shows can never disagree with what a signature would say, and the
 * Company shown is the one authoritative membership row, never an email
 * domain, `user_metadata`, a Team/Position name, or client state.
 *
 * Returns null while a profile is missing - never an email, never a
 * client-supplied name, never a guess. A CEO or E-SET SITE_MANAGER is a
 * privileged SYSTEM account with no Company, Team or Position, so this is
 * legitimately null for them: `privilegedRoles` identifies them and
 * `privilegedDisplayName` carries their authoritative personal name.
 * They are never presented as normal E-SET company members.
 */
async function loadOwnProfile(userId: string): Promise<{
  displayName: string;
  company: { code: string; name: string };
  teamName: string;
  positionName: string;
} | null> {
  const result = await query<{
    display_name: string;
    company_code: string;
    company_name: string;
    team_name: string;
    position_name: string;
  }>(
    `SELECT wp.display_name, c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name
       FROM workforce_profiles wp
       JOIN companies c ON c.id = wp.company_id
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
        AND utp.ended_at IS NULL
       JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
      WHERE wp.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        displayName: row.display_name,
        company: { code: row.company_code, name: row.company_name },
        teamName: row.team_name,
        positionName: row.position_name,
      }
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
  const [capabilities, privilegedRoles, profile, privilegedDisplayName] = await Promise.all([
    resolveUserCapabilities(req.auth.id),
    resolvePrivilegedAccess(req.auth.id),
    loadOwnProfile(req.auth.id),
    resolvePrivilegedDisplayName(req.auth.id),
  ]);
  res.status(200).json({
    // Explicitly shaped, never a spread of the internal identity object:
    // a field added to `AuthIdentity` later can never leak into this
    // response by accident.
    auth: { id: req.auth.id, email: req.auth.email },
    accessState: 'ACTIVE',
    mustChangePassword: req.auth.mustChangePassword,
    profile,
    // The caller's OWN currently active privileged system grants, read
    // from the authoritative append-only log. This is how the frontend
    // tells a privileged system account (no Company/Team/Position) apart
    // from an organizational employee, and it is a display convenience
    // only: account management re-resolves this server-side on every
    // request (authz/accountManagement.ts). It exposes nothing about any
    // other account.
    privilegedRoles: [...privilegedRoles],
    // A privileged system account's authoritative personal name, from
    // `privileged_identities` (migration 0019). It is the ONLY identity
    // field such an account has - there is no company, team or position
    // to report, and none is fabricated. Null for a normal employee,
    // whose name lives in `profile.displayName` instead, so exactly one
    // of the two is ever populated.
    privilegedDisplayName,
    capabilities: [...capabilities],
  });
});
