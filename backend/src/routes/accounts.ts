import { Router, type Request, type Response } from 'express';
import {
  authorizeAccountManagement,
  isManageableTarget,
  teamPositionIsSiteManagerAssignable,
} from '../authz/accountManagement.js';
import { createSupabaseAccountAdmin } from '../domain/accounts/admin.js';
import {
  changeEmployeeEmail,
  deleteEmployeeAccount,
  loadEmployeeAuditHistory,
  loadEmployeeDetail,
  setEmployeeAccountState,
  transferEmployee,
  updateEmployeeDisplayName,
} from '../domain/accounts/employees.js';
import { listEmployees, listSiteManagers, loadOrganization } from '../domain/accounts/directory.js';
import { setUserCapabilityGrant } from '../domain/accounts/userPermissions.js';
import { resolveProvisioningCompany } from '../domain/accounts/companies.js';
import {
  createSiteManagerAccount,
  grantSiteManager,
  revokeSiteManager,
} from '../domain/accounts/privilegedManagement.js';
import {
  changeOwnPassword,
  createEmployeeAccount,
  defaultAccountsServiceDeps,
  resetEmployeePassword,
  type AccountsServiceDeps,
} from '../domain/accounts/service.js';
import {
  changeEmployeeEmailBodySchema,
  changePasswordBodySchema,
  createEmployeeBodySchema,
  createSiteManagerBodySchema,
  employeeHistoryQuerySchema,
  employeeIdParamsSchema,
  employeeListQuerySchema,
  employeePermissionBodySchema,
  privilegedRoleChangeBodySchema,
  privilegedUserIdParamsSchema,
  resetEmployeePasswordBodySchema,
  updateEmployeeBodySchema,
} from '../domain/accounts/validation.js';
import { resolvePrivilegedAccess } from '../authz/privilegedAccess.js';
import { query } from '../db/pool.js';
import { createPrivilegedAccessAdmin, type PrivilegedAccessAdmin } from '../db/privilegedPool.js';
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
 * The caller must hold CEO or E-SET SITE_MANAGER privileged access - the
 * authority account management comes from (see
 * authz/accountManagement.ts). Team + Position capabilities are
 * deliberately NOT consulted: a privileged system account has no Team and
 * no Position at all. A denial is always the same generic 403, which
 * never says what was missing.
 */
async function authorize(req: Request, res: Response): Promise<string | null> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return null;
  try {
    const authorization = await authorizeAccountManagement(userId);
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
    if (result.outcome === 'refused') {
      // There is deliberately no anytime "change my password" feature:
      // this endpoint exists only to satisfy an outstanding forced
      // change. Refused BEFORE Supabase Auth was touched.
      res.status(409).json({
        error: 'conflict',
        reason: result.reason,
        message: 'No password change is currently required for this account',
      });
      return;
    }
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
 * CEO or E-SET Site Manager provisions a NORMAL employee account: a
 * Company, a Team + Position, a display name, an email, and a temporary
 * password. This endpoint can only ever create a normal organizational
 * employee - it writes `app_user_access`, `user_team_positions` and
 * `workforce_profiles`, and never `privileged_access_events`, so it
 * cannot mint a CEO, a Site Manager, or any other privileged account.
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
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;

    const body = createEmployeeBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    // The client supplies only a strict V1 code. Resolve the authoritative
    // id/name before the privileged Auth client, so missing or unknown company
    // data cannot leave an Auth identity behind.
    const company = await resolveProvisioningCompany(body.data.companyCode);
    if (!company) {
      res.status(400).json({
        error: 'invalid_request',
        reason: 'company_not_found',
        message: 'The requested company is not available for employee provisioning',
      });
      return;
    }

    // The Team + Position must genuinely exist AND carry the operator-
    // controlled site_manager_assignable flag. Checked BEFORE the Auth
    // Admin credential is even resolved, so an invalid request never
    // reaches the privileged client at all. This endpoint never creates
    // a Team + Position, and never writes `team_position_capabilities`
    // or `privileged_access_events` - so provisioning can only ever
    // place a new employee into an assignment the organization HAS
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

    const result = await createEmployeeAccount(actorUserId, {
      email: body.data.email,
      temporaryPassword: body.data.temporaryPassword,
      displayName: body.data.displayName,
      companyId: company.id,
      teamPositionId: body.data.teamPositionId,
    }, deps);

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
    const actorUserId = await authorize(req, res);
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


/**
 * Privileged administration is unavailable rather than partially working
 * when the separate `PRIVILEGED_DATABASE_URL` channel is not configured -
 * the same fail-closed posture the Auth Admin credential uses. The
 * response never names the missing credential.
 */
function sendPrivilegedChannelUnavailable(res: Response): void {
  res.status(503).json({
    error: 'privileged_management_unavailable',
    message: 'Privileged account administration is not available right now',
  });
}

/** Resolves the narrow privileged adapter, or null when its dedicated login is absent. */
function resolvePrivilegedAdmin(): PrivilegedAccessAdmin | null {
  return createPrivilegedAccessAdmin();
}

/**
 * CEO-ONLY authority. Site Manager administration is deliberately a
 * narrower gate than `authorize()` above: holding SOME privileged role is
 * not enough, because a Site Manager must never be able to mint or
 * unmake another Site Manager, nor reach the CEO tier. Resolved from the
 * append-only grant log on every request, so a revoked CEO loses this
 * immediately.
 */
async function authorizeCeo(req: Request, res: Response): Promise<string | null> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return null;
  try {
    const roles = await resolvePrivilegedAccess(userId);
    if (!roles.has('CEO')) {
      sendForbidden(res);
      return null;
    }
    return userId;
  } catch {
    sendForbidden(res);
    return null;
  }
}

/**
 * CEO establishes a new E-SET SITE_MANAGER privileged account.
 *
 * This is NOT the employee endpoint and shares none of its machinery: it
 * writes `privileged_identities` and `privileged_access_events` and
 * never `workforce_profiles`, `user_team_positions` or a company - so
 * the account it creates has an authoritative personal name and no
 * fabricated organizational membership. Multiple active Site Managers
 * are expected; nothing here is a singleton.
 */
accountsRouter.post(
  '/admin/site-managers',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorizeCeo(req, res);
    if (!actorUserId) return;

    const body = createSiteManagerBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }
    // Both credentials must be present before ANY Auth work begins:
    // creating an Auth identity we could not then grant would leave a
    // named account with no authority for no reason.
    const privileged = resolvePrivilegedAdmin();
    if (!privileged) {
      sendPrivilegedChannelUnavailable(res);
      return;
    }

    const result = await createSiteManagerAccount(actorUserId, body.data, deps, privileged);
    if (result.outcome === 'conflict') {
      res.status(409).json({ error: 'conflict', reason: result.reason, message: 'That email cannot be used' });
      return;
    }
    if (result.outcome === 'failed') {
      if (result.reason === 'provisioning_orphan_requires_operator') {
        console.error(
          JSON.stringify({
            event: 'site_manager_provisioning_orphan',
            requestId: req.requestId,
            orphanUserId: result.orphanUserId,
          }),
        );
      }
      if (result.reason === 'grant_not_recorded') {
        // The account exists and is named but holds NO privilege. Safe,
        // and retryable through the grant endpoint - so it is reported
        // distinctly rather than as a generic provisioning failure.
        console.error(
          JSON.stringify({
            event: 'site_manager_grant_not_recorded',
            requestId: req.requestId,
            userId: result.userId,
          }),
        );
        res.status(503).json({
          error: 'privileged_grant_failed',
          reason: 'grant_not_recorded',
          message: 'The account was created but its Site Manager authority was not granted. Retry the grant.',
        });
        return;
      }
      res.status(503).json({
        error: 'provisioning_failed',
        reason: result.reason === 'provisioning_orphan_requires_operator' ? 'provisioning_failed' : result.reason,
        message: 'The Site Manager account could not be provisioned',
      });
      return;
    }

    // The temporary password is NEVER echoed back.
    res.status(201).json({ siteManager: { userId: result.userId, mustChangePassword: true } });
  },
);

/** CEO re-grants SITE_MANAGER to an existing, previously revoked privileged identity. */
accountsRouter.post(
  '/admin/site-managers/:id/grant',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeSiteManagerGrant(req, res, 'grant'),
);

/** CEO revokes SITE_MANAGER. The account and its identity survive; only the authority is withdrawn. */
accountsRouter.post(
  '/admin/site-managers/:id/revoke',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeSiteManagerGrant(req, res, 'revoke'),
);

async function changeSiteManagerGrant(
  req: Request,
  res: Response,
  action: 'grant' | 'revoke',
): Promise<void> {
  const actorUserId = await authorizeCeo(req, res);
  if (!actorUserId) return;

  const params = privilegedUserIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }
  // The body carries nothing: the role is fixed by the endpoint, so no
  // request can widen a SITE_MANAGER change into a CEO change.
  const body = privilegedRoleChangeBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    sendValidationError(res, body.error.issues);
    return;
  }

  const deps = resolveDeps();
  if (!deps) {
    sendAccountAdminUnavailable(res);
    return;
  }
  const privileged = resolvePrivilegedAdmin();
  if (!privileged) {
    sendPrivilegedChannelUnavailable(res);
    return;
  }

  const result = action === 'grant'
    ? await grantSiteManager(actorUserId, params.data.id, deps, privileged)
    : await revokeSiteManager(actorUserId, params.data.id, deps, privileged);

  if (result.outcome === 'not_found') {
    res.status(404).json({ error: 'not_found', message: 'Privileged account not found' });
    return;
  }
  if (result.outcome === 'refused') {
    // A normal employee can never be promoted, the CEO tier is not
    // reachable from here, and an account already in the requested state
    // is a conflict rather than a silent success.
    res.status(409).json({
      error: 'conflict',
      reason: result.reason,
      message: 'That privileged role change is not permitted',
    });
    return;
  }
  if (result.outcome === 'failed') {
    res.status(503).json({
      error: 'privileged_change_failed',
      reason: result.reason,
      message: 'The privileged role could not be changed. Please try again.',
    });
    return;
  }

  res.status(200).json({ status: 'ok', siteManager: { userId: params.data.id, active: action === 'grant' } });
}

// ---------------------------------------------------------------------
// Normal employee lifecycle (CEO or E-SET SITE_MANAGER)
// ---------------------------------------------------------------------

/**
 * Maps a lifecycle outcome onto the HTTP shape the account API already
 * uses. `not_found` and `target_is_privileged` deliberately produce the
 * SAME 404: the employee API must not become a way to discover that a
 * given id belongs to a CEO or Site Manager.
 */
function sendLifecycleFailure(
  res: Response,
  result: { outcome: string; reason?: string },
): void {
  if (result.outcome === 'not_found') {
    res.status(404).json({ error: 'not_found', message: 'Employee account not found' });
    return;
  }
  if (result.outcome === 'refused' && result.reason === 'target_is_privileged') {
    res.status(404).json({ error: 'not_found', message: 'Employee account not found' });
    return;
  }
  if (result.outcome === 'refused') {
    res.status(409).json({ error: 'conflict', reason: result.reason, message: 'That change is not permitted' });
    return;
  }
  if (result.outcome === 'invalid') {
    res.status(400).json({ error: 'invalid_request', reason: result.reason, message: 'Invalid employee update' });
    return;
  }
  res.status(503).json({
    error: 'employee_update_failed',
    reason: result.reason,
    message: 'The change could not be applied. Please try again.',
  });
}

/**
 * The normal-employee directory. READ ONLY, behind exactly the same
 * `authorize()` gate (CEO or E-SET SITE_MANAGER privileged access) as
 * every mutating employee endpoint below, so it grants no visibility the
 * caller does not already have. Privileged accounts are excluded by the
 * query itself, so this can never enumerate the CEO / Site Manager tier.
 *
 * Registered BEFORE `/admin/employees/:id`: Express matches in
 * registration order, and a literal path must be declared ahead of a
 * param route that could otherwise swallow it.
 */
accountsRouter.get(
  '/admin/employees',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;
    const parsed = employeeListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    const { page, pageSize, search, state, companyCode } = parsed.data;
    const result = await listEmployees(query, { search, state, companyCode }, { page, pageSize });
    res.status(200).json({
      employees: result.items,
      pagination: {
        page,
        pageSize,
        totalCount: result.totalCount,
        totalPages: result.totalCount === 0 ? 0 : Math.ceil(result.totalCount / pageSize),
      },
    });
  },
);

/**
 * The operator-owned Team + Position structure a manager may provision
 * into - the authoritative source for the Company/Team/Position choices
 * on the create and transfer screens, so no `teamPositionId` ever has to
 * be duplicated in, or guessed by, a client. Only combinations already
 * flagged `site_manager_assignable` (migration 0020) are returned, which
 * is the same flag the create/transfer endpoints independently re-check
 * before writing anything.
 */
accountsRouter.get(
  '/admin/organization',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;
    res.status(200).json({ companies: await loadOrganization(query) });
  },
);

/**
 * CEO-ONLY. The Site Manager tier, so the CEO administration screen can
 * name the identities its grant/revoke endpoints act on. Gated by
 * `authorizeCeo` - the same narrower gate those mutations use, because a
 * Site Manager must not be able to enumerate the tier they cannot
 * administer.
 */
accountsRouter.get(
  '/admin/site-managers',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorizeCeo(req, res);
    if (!actorUserId) return;
    res.status(200).json({ siteManagers: await listSiteManagers(query) });
  },
);

/** One normal employee's management view. Privileged targets are indistinguishable from missing ones. */
accountsRouter.get(
  '/admin/employees/:id',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;
    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const detail = await loadEmployeeDetail(query, params.data.id);
    if (!detail) {
      res.status(404).json({ error: 'not_found', message: 'Employee account not found' });
      return;
    }
    res.status(200).json({ employee: detail });
  },
);

/**
 * Display name and/or organizational transfer. Both are handled here
 * because they are the two things an employee "profile edit" screen
 * changes, and doing them in one request keeps the audit trail ordered.
 * Each is applied by its own transaction-safe service call.
 */
accountsRouter.patch(
  '/admin/employees/:id',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;
    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = updateEmployeeBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }
    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    if (body.data.displayName !== undefined) {
      const renamed = await updateEmployeeDisplayName(actorUserId, params.data.id, body.data.displayName, deps);
      // `unchanged` is not an error when other fields still apply.
      if (renamed.outcome !== 'ok' && !(renamed.outcome === 'invalid' && renamed.reason === 'unchanged')) {
        sendLifecycleFailure(res, renamed);
        return;
      }
    }

    if (body.data.companyCode !== undefined && body.data.teamPositionId !== undefined) {
      const company = await resolveProvisioningCompany(body.data.companyCode);
      if (!company) {
        res.status(400).json({
          error: 'invalid_request',
          reason: 'company_not_found',
          message: 'The requested company is not available',
        });
        return;
      }
      const transferred = await transferEmployee(
        actorUserId,
        params.data.id,
        { companyId: company.id, teamPositionId: body.data.teamPositionId },
        deps,
      );
      if (transferred.outcome !== 'ok' && !(transferred.outcome === 'invalid' && transferred.reason === 'unchanged')) {
        sendLifecycleFailure(res, transferred);
        return;
      }
    }

    res.status(200).json({ status: 'ok', employee: { userId: params.data.id } });
  },
);

/**
 * Manager-initiated login-email transition. The new temporary password
 * is mandatory and is never echoed back; the employee must replace it
 * before regaining normal access.
 */
accountsRouter.post(
  '/admin/employees/:id/change-email',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorize(req, res);
    if (!actorUserId) return;
    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = changeEmployeeEmailBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }
    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    const result = await changeEmployeeEmail(actorUserId, params.data.id, body.data, deps);
    if (result.outcome === 'conflict') {
      res.status(409).json({ error: 'conflict', reason: result.reason, message: 'That email cannot be used' });
      return;
    }
    if (result.outcome !== 'ok') {
      sendLifecycleFailure(res, result);
      return;
    }
    res.status(200).json({ status: 'ok', employee: { userId: params.data.id, mustChangePassword: true } });
  },
);

/** Disable: access ends on the target's very next request. */
accountsRouter.post(
  '/admin/employees/:id/disable',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeEmployeeState(req, res, 'DISABLED'),
);

/** Re-enable: the same Company, Team, Position and permissions are still there. */
accountsRouter.post(
  '/admin/employees/:id/enable',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeEmployeeState(req, res, 'ACTIVE'),
);

async function changeEmployeeState(
  req: Request,
  res: Response,
  nextState: 'ACTIVE' | 'DISABLED',
): Promise<void> {
  const actorUserId = await authorize(req, res);
  if (!actorUserId) return;
  const params = employeeIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }
  const deps = resolveDeps();
  if (!deps) {
    sendAccountAdminUnavailable(res);
    return;
  }
  const result = await setEmployeeAccountState(actorUserId, params.data.id, nextState, deps);
  if (result.outcome !== 'ok') {
    sendLifecycleFailure(res, result);
    return;
  }
  res.status(200).json({ status: 'ok', employee: { userId: params.data.id, state: nextState } });
}

/**
 * CEO-ONLY permanent deletion. A Site Manager holds full authority over
 * normal employees but not this: destroying a login is the one employee
 * operation reserved to the higher tier, so the gate is `authorizeCeo`,
 * not `authorize`.
 */
accountsRouter.delete(
  '/admin/employees/:id',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorizeCeo(req, res);
    if (!actorUserId) return;
    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const deps = resolveDeps();
    if (!deps) {
      sendAccountAdminUnavailable(res);
      return;
    }

    const result = await deleteEmployeeAccount(actorUserId, params.data.id, deps);
    if (result.outcome === 'failed' && result.reason === 'auth_delete_failed') {
      // The account is already tombstoned and can reach nothing; only the
      // Supabase identity remains, which an operator must remove.
      console.error(
        JSON.stringify({
          event: 'employee_auth_identity_not_removed',
          requestId: req.requestId,
          userId: params.data.id,
        }),
      );
      res.status(503).json({
        error: 'deletion_incomplete',
        reason: 'auth_delete_failed',
        message: 'The account was disabled permanently but its login could not be removed. Retry.',
      });
      return;
    }
    if (result.outcome !== 'ok') {
      sendLifecycleFailure(res, result);
      return;
    }
    res.status(200).json({ status: 'ok', employee: { userId: params.data.id, state: 'DELETED' } });
  },
);

/**
 * One employee's ADMINISTRATIVE/SECURITY audit trail - who created the
 * account, who reset its password, when it was disabled.
 *
 * CEO ONLY, deliberately narrower than every other endpoint on this
 * router. A Site Manager performs routine employee administration and
 * therefore APPEARS in this log as an actor; letting them read it would
 * let the administered watch the record of their own administration.
 * That is a different question from whether they may administer, so it
 * gets a different gate: `authorizeCeo`, resolved from the append-only
 * grant log on every request, never from a JWT claim.
 *
 * This is NOT permit workflow history. A permit's own lifecycle
 * (`permit_lifecycle_events` - created, submitted, reviewed, issued) is
 * business information the people working the permit legitimately need,
 * and is served by the permit routes under permit authorization. Only
 * the account/security audit is restricted here.
 */
accountsRouter.get(
  '/admin/employees/:id/history',
  requireAuth,
  managerAccountLimiter,
  async (req: Request, res: Response) => {
    const actorUserId = await authorizeCeo(req, res);
    if (!actorUserId) return;
    const params = employeeIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const pagination = employeeHistoryQuerySchema.safeParse(req.query);
    if (!pagination.success) {
      sendValidationError(res, pagination.error.issues);
      return;
    }
    // A privileged target is hidden here too, so the history endpoint
    // cannot be used to enumerate the privileged tier either.
    const detail = await loadEmployeeDetail(query, params.data.id);
    if (!detail) {
      res.status(404).json({ error: 'not_found', message: 'Employee account not found' });
      return;
    }
    const { page, pageSize } = pagination.data;
    const history = await loadEmployeeAuditHistory(query, params.data.id, pageSize, (page - 1) * pageSize);
    res.status(200).json({
      items: history.items,
      page,
      pageSize,
      totalCount: history.totalCount,
      totalPages: history.totalCount === 0 ? 0 : Math.ceil(history.totalCount / pageSize),
    });
  },
);

/** Grant an individual permission (currently only `permit.view_all`). */
accountsRouter.post(
  '/admin/employees/:id/permissions',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeEmployeePermission(req, res, 'GRANTED'),
);

/** Revoke it. Broad visibility ends on the target's very next request. */
accountsRouter.delete(
  '/admin/employees/:id/permissions',
  requireAuth,
  managerAccountLimiter,
  (req: Request, res: Response) => changeEmployeePermission(req, res, 'REVOKED'),
);

async function changeEmployeePermission(
  req: Request,
  res: Response,
  action: 'GRANTED' | 'REVOKED',
): Promise<void> {
  const actorUserId = await authorize(req, res);
  if (!actorUserId) return;
  const params = employeeIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }
  const body = employeePermissionBodySchema.safeParse(req.body);
  if (!body.success) {
    sendValidationError(res, body.error.issues);
    return;
  }
  const deps = resolveDeps();
  if (!deps) {
    sendAccountAdminUnavailable(res);
    return;
  }
  const result = await setUserCapabilityGrant(
    actorUserId,
    params.data.id,
    body.data.capability,
    action,
    deps,
  );
  if (result.outcome !== 'ok') {
    sendLifecycleFailure(res, result);
    return;
  }
  res.status(200).json({
    status: 'ok',
    employee: { userId: params.data.id, capability: body.data.capability, active: action === 'GRANTED' },
  });
}
