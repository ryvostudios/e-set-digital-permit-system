import { z } from 'zod';

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
    teamPositionId: z.string().uuid(),
  })
  .strict();

/** Site Manager forgotten-password reset. The target comes from the authenticated, validated route parameter - never from the body. */
export const resetEmployeePasswordBodySchema = z
  .object({
    temporaryPassword: passwordSchema,
  })
  .strict();

export const employeeIdParamsSchema = z.object({
  id: z.string().uuid('id must be a UUID'),
});
