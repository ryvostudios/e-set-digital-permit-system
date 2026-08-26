import { Router, type Request, type Response } from 'express';
import {
  authorizeAccountManagement,
  isManageableTarget,
  teamPositionIsSiteManagerAssignable,
  type AccountManagementCapability,
} from '../authz/accountManagement.js';
import { createSupabaseAccountAdmin } from '../domain/accounts/admin.js';
import {
  changeOwnPassword,
  createEmployeeAccount,
  defaultAccountsServiceDeps,
  resetEmployeePassword,
  type AccountsServiceDeps,
} from '../domain/accounts/service.js';
import {
  changePasswordBodySchema,
  createEmployeeBodySchema,
  employeeIdParamsSchema,
  resetEmployeePasswordBodySchema,
} from '../domain/accounts/validation.js';
import { requireAuth, requireAuthDuringPasswordChange } from '../middleware/auth.js';
import { accountLimiter, managerAccountLimiter } from '../middleware/rateLimit.js';

export const accountsRouter = Router();

/**
 * Employee account provisioning and password management.
 *
 * Nothing in this file logs, echoes, or persists a password: the only
 * place a password value exists is the validated request body, which is
 * passed straight to the Supabase Auth Admin adapter and never written
 * to a business table, a response, an audit row, or a log line. Request
 * logging (`middleware/requestLog.ts`) records method/path/status only,
 * never bodies.
 */

function sendValidationError(res: Response, issues: unknown): void {
  res.status(400).json({ error: 'invalid_request', message: 'Invalid request', issues });
}

function sendForbidden(res: Response): void {
  res.status(403).json({ error: 'forbidden', message: 'Insufficient authority for account management' });
}

/**
 * Account management is unavailable rather than partially working when
 * the server-only Auth Admin credential is not configured - the same
 * fail-closed posture PDF storage uses. The response never names the
 * missing credential.
 */
function sendAccountAdminUnavailable(res: Response): void {
  res.status(503).json({
    error: 'account_management_unavailable',
    message: 'Account management is not available right now',
  });
}

function getAuthenticatedUserId(req: Request, res: Response): string | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return null;
  }
  return req.auth.id;
}

/** Resolves the service dependencies, or null when the Auth Admin credential is absent. */
function resolveDeps(): AccountsServiceDeps | null {
  const admin = createSupabaseAccountAdmin();
  return admin ? defaultAccountsServiceDeps(admin) : null;
}

/**
 * Both authorities must hold (capability AND CEO/Site Manager privileged
 * access - see authz/accountManagement.ts). A denial is always the same
 * generic 403: which of the two was missing is not disclosed.
 */
async function authorize(
  req: Request,
  res: Response,
  capability: AccountManagementCapability,
): Promise<string | null> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return null;
  try {
    const authorization = await authorizeAccountManagement(userId, capability);
    if (!authorization.authorized) {
      sendForbidden(res);
      return null;
    }
    return userId;
  } catch {
    // Default-deny on any resolution failure, exactly like
    // requireCapability/requirePrivilegedAccess.
    sendForbidden(res);
    return null;
  }
}

/**
 * The authenticated user replaces their own password.
 *
 * Mounted with `requireAuthDuringPasswordChange` so it stays reachable
 * while a forced change is outstanding - that is the entire point of the
 * endpoint - and it exposes no application data of any kind. The target
 * is always `req.auth.id`; the body carries only the new password, and
 * `.strict()` refuses any attempt to name another account.
 */
accountsRouter.post(
  '/auth/change-password',
  requireAuthDuringPasswordChange,
  accountLimiter,
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const body = changePasswordBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    const result = await changeOwnPassword(userId, body.data.newPassword, deps);
    if (result.outcome !== 'ok') {
      // Both failure modes are safe and recoverable: either nothing
      // changed, or the password changed while the account still owes a
      // change - so the caller may simply retry. The reason is a fixed
      // enum, never an underlying error.
      res.status(503).json({
        error: 'password_change_failed',
        reason: result.reason,
        message: 'The password could not be changed. Please try again.',
      });
      return;
    }

    res.status(200).json({ status: 'ok', mustChangePassword: false });
  },
);

/**
 * Site Manager provisions a normal employee account.
 *
 * `requireAuth` (not the password-change variant) is deliberate: a
 * manager who themselves owe a password change may not provision
 * accounts.
 */
accountsRouter.post(
  '/admin/employees',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res, 'employee.create');
    if (!actorUserId) return;

    const body = createEmployeeBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    // The Team + Position must genuinely exist AND carry the operator-
    // controlled site_manager_assignable flag. Checked BEFORE the Auth
    // Admin credential is even resolved, so an invalid request never
    // reaches the privileged client at all. This endpoint never creates
    // a Team + Position, and never writes `team_position_capabilities`
    // or `privileged_access_events` - so provisioning can only ever
    // place a new employee into an assignment the organization has not
    // explicitly approved for this provisioning flow.
    if (!(await teamPositionIsSiteManagerAssignable(body.data.teamPositionId))) {
      res.status(400).json({
        error: 'invalid_request',
        reason: 'team_position_not_assignable',
        message: 'The requested Team + Position is not available for employee provisioning',
      });
      return;
    }

    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    const result = await createEmployeeAccount(actorUserId, body.data, deps);

    if (result.outcome === 'conflict') {
      res.status(409).json({ error: 'conflict', reason: result.reason, message: 'That email cannot be used' });
      return;
    }
    if (result.outcome === 'failed') {
      if (result.reason === 'provisioning_orphan_requires_operator') {
        // Operator-visible, sanitized: the half-created Auth identity has
        // NO app_user_access row, so it cannot reach any application
        // endpoint - but it should still be cleaned up manually.
        console.error(
          JSON.stringify({
            event: 'employee_provisioning_orphan',
            requestId: req.requestId,
            orphanUserId: result.orphanUserId,
          }),
        );
      }
      res.status(503).json({
        error: 'provisioning_failed',
        reason: result.reason === 'provisioning_orphan_requires_operator' ? 'provisioning_failed' : result.reason,
        message: 'The employee account could not be provisioned',
      });
      return;
    }

    // The temporary password is NEVER echoed back.
    res.status(201).json({ employee: { userId: result.userId, mustChangePassword: true } });
  },
);

/**
 * Site Manager sets a new temporary password on a forgotten-password
 * account. The target is the validated route parameter, checked against
 * the protected-identity rules before anything is written.
 */
accountsRouter.post(
  '/admin/employees/:id/reset-password',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res, 'employee.reset_password');
    if (!actorUserId) return;

    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = resetEmployeePasswordBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    // Protected-identity guard, from the authoritative append-only
    // governance log: a CEO or Site Manager account can never be reset
    // through the normal-employee flow, and neither can the caller's own
    // account (self-service password change exists for that).
    const eligibility = await isManageableTarget(actorUserId, params.data.id);
    if (!eligibility.eligible) {
      sendForbidden(res);
      return;
    }

    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    const result = await resetEmployeePassword(actorUserId, params.data.id, body.data.temporaryPassword, deps);

    if (result.outcome === 'not_found') {
      res.status(404).json({ error: 'not_found', message: 'Employee account not found' });
      return;
    }
    if (result.outcome === 'not_manageable') {
      sendForbidden(res);
      return;
    }
    if (result.outcome === 'failed') {
      res.status(503).json({
        error: 'password_reset_failed',
        reason: result.reason,
        message: 'The password could not be reset. Please try again.',
      });
      return;
    }

    res.status(200).json({ status: 'ok', employee: { userId: params.data.id, mustChangePassword: true } });
  },
);
