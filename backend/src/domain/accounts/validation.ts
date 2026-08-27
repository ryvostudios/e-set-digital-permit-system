import { z } from 'zod';
import { COMPANY_CODES } from './companies.js';
import { INDIVIDUALLY_GRANTABLE_CAPABILITIES } from './userPermissions.js';

/**
 * Request contracts for account management.
 *
 * Every schema is `.strict()`, so a body may carry ONLY the fields named
 * here. That is what structurally prevents mass assignment: there is no
 * `role`, `capabilities`, `privileged`, `state`, `mustChangePassword`,
 * `userId`, or `email` field on the self-service endpoint for a client
 * to smuggle in, and supplying one is a 400 rather than a silently
 * ignored extra key.
 */

/**
 * Password shape accepted at the API boundary.
 *
 * Deliberately NOT an invented composition policy (no bespoke
 * character-class rules): Supabase Auth holds the project's configured
 * password policy and remains the authority, and this backend must not
 * quietly diverge from it. What is enforced here is the minimum sanity
 * bound the repository already uses for an operator-set password
 * (`scripts/bootstrapCeo.ts`: 12..256) plus a rejection of values that
 * are only whitespace - obviously invalid input that should never reach
 * Auth at all.
 *
 * Not trimmed: leading/trailing whitespace is legitimate password
 * content, and silently rewriting a credential would mean the stored
 * password differs from what the human typed.
 */
export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(256)
  .refine((value) => value.trim().length > 0, { message: 'password must not be blank' });

/**
 * Self-service password change. The target is ALWAYS the authenticated
 * caller (`req.auth.id`), so there is deliberately no target field of
 * any kind - `.strict()` rejects `userId`, `email`, `targetUserId`,
 * `displayName`, `role` and anything else outright.
 */
export const changePasswordBodySchema = z
  .object({
    newPassword: passwordSchema,
  })
  .strict();

/**
 * Site Manager employee provisioning. Only genuine provisioning input is
 * accepted: no privileged role, no capability list, no account state,
 * and no user id - the new identity's id is assigned by Supabase Auth,
 * never chosen by the caller.
 */
export const createEmployeeBodySchema = z
  .object({
    email: z.string().trim().email().max(254),
    temporaryPassword: passwordSchema,
    displayName: z.string().trim().min(1).max(120),
    companyCode: z.enum(COMPANY_CODES),
    teamPositionId: z.string().uuid(),
  })
  .strict();

/**
 * CEO establishes an E-SET SITE_MANAGER privileged account.
 *
 * Deliberately carries NO company, team, or position field: a privileged
 * system account has none, and `.strict()` means a client that supplies
 * one is rejected rather than silently ignored. It also carries no role
 * field - the role this endpoint grants is fixed in the service, so no
 * request body can choose CEO.
 */
export const createSiteManagerBodySchema = z
  .object({
    email: z.string().trim().email().max(254),
    temporaryPassword: passwordSchema,
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

/** Grant/revoke SITE_MANAGER. The target is the validated route parameter; the body carries nothing at all. */
export const privilegedRoleChangeBodySchema = z.object({}).strict();

/**
 * Employee update. Every field is optional but the object may not be
 * empty, and `.strict()` means anything not named here - a role, a
 * capability list, an account state, an audit field - is rejected rather
 * than ignored. Company and Team + Position must move together, because
 * an assignment is only valid against the company that owns its team.
 */
export const updateEmployeeBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    companyCode: z.enum(COMPANY_CODES).optional(),
    teamPositionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.displayName === undefined && body.companyCode === undefined && body.teamPositionId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field must be supplied' });
    }
    if ((body.companyCode === undefined) !== (body.teamPositionId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'companyCode and teamPositionId must be changed together',
        path: ['teamPositionId'],
      });
    }
  });

/**
 * Manager-initiated login-email transition. A new temporary password is
 * MANDATORY: changing the address without rotating the credential would
 * leave the old password valid on the new login.
 */
export const changeEmployeeEmailBodySchema = z
  .object({
    newEmail: z.string().trim().email().max(254),
    temporaryPassword: passwordSchema,
  })
  .strict();

/** Individual permission grant/revoke. The capability is a closed set, never an arbitrary name or array. */
export const employeePermissionBodySchema = z
  .object({
    capability: z.enum(INDIVIDUALLY_GRANTABLE_CAPABILITIES),
  })
  .strict();

/** Bounded pagination for the administrative audit history. */
export const employeeHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/**
 * Employee directory listing. Bounded pagination identical to the audit
 * history above, plus the three filters that map onto genuinely existing
 * columns (display name, account state, company code) - `.strict()`
 * rejects any other query key rather than ignoring it, so no filter can
 * be smuggled in that this schema does not name.
 */
export const employeeListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().min(1).max(120).optional(),
    state: z.enum(['ACTIVE', 'DISABLED', 'DELETED']).optional(),
    companyCode: z.enum(COMPANY_CODES).optional(),
  })
  .strict();

/** The privileged account a CEO-only action targets. */
export const privilegedUserIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

/** Site Manager forgotten-password reset. The target comes from the authenticated, validated route parameter - never from the body. */
export const resetEmployeePasswordBodySchema = z
  .object({
    temporaryPassword: passwordSchema,
  })
  .strict();

export const employeeIdParamsSchema = z.object({
  id: z.string().uuid('id must be a UUID'),
});
