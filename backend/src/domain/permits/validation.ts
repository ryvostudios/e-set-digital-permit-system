import { z } from 'zod';

// The one permit form field DECISIONS.md documents concretely: "Company
// field includes ESET, SGRE, ZPL, Other; choosing Other allows free-text
// entry." The rest of the official form layout is not yet defined.
export const companySchema = z.enum(['ESET', 'SGRE', 'ZPL', 'OTHER']);

export const permitIdParamsSchema = z.object({
  id: z.string().uuid('id must be a UUID'),
});

export const createPermitBodySchema = z.object({}).strict();

export const updatePermitBodySchema = z
  .object({
    version: z.number().int().positive(),
    company: companySchema.optional(),
    companyOther: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((body) => body.company !== 'OTHER' || Boolean(body.companyOther), {
    message: 'companyOther is required when company is OTHER',
    path: ['companyOther'],
  });

export const submitPermitBodySchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

// CRO forward-to-HSE, HSE approve, and CRO fallback approve all take the
// same shape - only the expected current version, for the optimistic
// concurrency check. Kept as separate schemas (one per endpoint,
// matching the rest of this file) since each represents a distinct API
// contract that could diverge later.
export const forwardToHseBodySchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const hseApproveBodySchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const fallbackApproveBodySchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

// Whether closure remarks must be mandatory is not finalized
// (DECISIONS.md), so `closureRemarks` stays optional - only its shape
// (trimmed, non-empty when present, length-capped like the project's
// other free-text field, `companyOther`) is validated here. `.strict()`
// also means closed_by/closed_at can't be smuggled in via the body -
// those are always server-derived (see domain/permits/service.ts).
export const closePermitBodySchema = z
  .object({
    version: z.number().int().positive(),
    closureRemarks: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
