import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { resolvePrivilegedAccess } from '../authz/privilegedAccess.js';
import { query, toSafeDbErrorMessage, withTransaction } from '../db/pool.js';
import { resolvePrivilegedDisplayName } from '../domain/accounts/privilegedIdentities.js';
import { AuthWorkBusy } from '../domain/auth/authWork.js';
import { login } from '../domain/auth/login.js';
import {
  clearSessionCookie,
  readSessionToken,
  revokeSessionByToken,
  setSessionCookie,
} from '../domain/auth/sessions.js';
import { requireAuthDuringPasswordChange } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';

export const authRouter = Router();

/**
 * Sign-in body. The email is not format-validated here on purpose: any
 * string that is not a known login simply fails like a wrong password,
 * so the response never distinguishes "not an email" from "no account".
 */
const loginBodySchema = z
  .object({
    email: z.string().max(320),
    password: z.string().min(1).max(1024),
    remember: z.boolean().optional().default(false),
  })
  .strict();

/**
 * Permit-owned sign-in (domain/auth/login.ts). On success the only thing
 * returned is the HttpOnly session cookie - no token, id or identity is
 * in the body; the frontend asks `/auth/me` who it is, as before. Every
 * credential failure is the same 401.
 *
 * Before any password work: only the short per-client-address burst
 * limit. Nothing keyed by the email can refuse an attempt, so failures
 * sent by someone else never stop a correct password from being verified.
 * When this process's password-work capacity is full (A05-P1), the attempt
 * is refused at once with a generic 429 - the same whatever the email - and
 * a client that disconnects while queued leaves the queue.
 */
authRouter.post('/auth/login', loginLimiter, async (req: Request, res: Response) => {
  const body = loginBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid request' });
    return;
  }
  const abandoned = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abandoned.abort(); });
  try {
    const result = await login(body.data, { query, withTransaction }, { signal: abandoned.signal });
    if (result.outcome !== 'ok') {
      res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
      return;
    }
    setSessionCookie(res, result.token, body.data.remember);
    res.status(204).end();
  } catch (err) {
    if (err instanceof AuthWorkBusy) {
      if (abandoned.signal.aborted) return;
      res.set('Retry-After', '2');
      res.status(429).json({ error: 'sign_in_busy', message: 'Too many sign-in attempts right now. Please try again in a moment.' });
      return;
    }
    console.error('Sign-in failed:', toSafeDbErrorMessage(err));
    res.status(503).json({ error: 'sign_in_unavailable', message: 'Sign-in is unavailable right now. Please try again.' });
  }
});

/**
 * Ends THIS session: the server-side row is revoked (a copied cookie stops
 * working immediately) and the browser cookie is cleared. Idempotent, and
 * deliberately not behind `requireAuth`, so a disabled or already-expired
 * session can still be cleaned up. Other devices are unaffected.
 */
authRouter.post('/auth/logout', async (req: Request, res: Response) => {
  const token = readSessionToken(req);
  try {
    if (token) await revokeSessionByToken(query, token);
  } catch (err) {
    console.error('Sign-out revocation failed:', toSafeDbErrorMessage(err));
    res.status(503).json({ error: 'sign_out_unavailable', message: 'Sign-out could not be completed. Please try again.' });
    return;
  }
  clearSessionCookie(res);
  res.status(204).end();
});

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
