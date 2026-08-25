import { z } from 'zod';

// The one permit form field DECISIONS.md documents concretely: "Company
// field includes ESET, SGRE, ZPL, Other; choosing Other allows free-text
// entry." The rest of the official form layout is not yet defined.
export const companySchema = z.enum(['ESET', 'SGRE', 'ZPL', 'OTHER']);

export const permitIdParamsSchema = z.object({
  id: z.string().uuid('id must be a UUID'),
});

// Bounded pagination shared by every list endpoint (GET /permits/mine,
// GET /permits/queue). `page` is 1-based. `pageSize` has both a safe
// default and a hard maximum - a client can never request an unbounded
// (or merely very large) result set by supplying a huge value; Zod
// clamps this at the validation boundary, before any query is built, so
// no route/service code has to remember to re-check it.
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// A hard ceiling on the COMPUTED offset ((page - 1) * pageSize), not
// just on `page` alone. Bounding `page` by itself is not enough:
// `pageSize` is exactly the multiplier that turns a merely-large page
// number into a pathological OFFSET - e.g. page=1_000_000 with the max
// pageSize (100) is still "a large but plausible page" by page-count
// alone, but produces OFFSET 99_999_900, which is both a wasteful,
// full-table-scanning query and (at more extreme inputs, e.g.
// page=Number.MAX_SAFE_INTEGER) a value that isn't even safely
// representable arithmetic. 100_000 is generous relative to any list
// this system actually produces (single-site permit volume) while still
// rejecting deliberately pathological requests.
export const MAX_PAGINATION_OFFSET = 100_000;

const rawPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/**
 * Shared by every schema below that composes pagination (both
 * `paginationQuerySchema` itself and `permitQueueQuerySchema`, which
 * can't simply inherit a `.refine()` through `.shape` spreading - see
 * `permitQueueQuerySchema`) so the offset bound can never drift between
 * them. Computes `(page - 1) * pageSize` itself, defensively, rather
 * than trusting `page`/`pageSize` are already safe integers: guards
 * against both the ordinary case (offset legitimately too large) and
 * the arithmetic edge case (the multiplication itself overflowing past
 * `Number.MAX_SAFE_INTEGER`, which - unlike a plain magnitude
 * comparison - `Number.isSafeInteger` catches even if the result were
 * ever `NaN`/non-finite, where a naive `offset > MAX_PAGINATION_OFFSET`
 * comparison alone would not reliably reject it).
 */
function rejectExcessivePaginationOffset(
  value: { page: number; pageSize: number },
  ctx: z.RefinementCtx,
): void {
  // page/pageSize already failed their own int/min/max checks above;
  // don't pile on a second, confusing issue about their (non-finite)
  // product too.
  if (!Number.isFinite(value.page) || !Number.isFinite(value.pageSize)) return;

  const offset = (value.page - 1) * value.pageSize;
  if (!Number.isSafeInteger(offset) || offset > MAX_PAGINATION_OFFSET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `(page - 1) * pageSize must not exceed ${MAX_PAGINATION_OFFSET} - got page=${value.page}, pageSize=${value.pageSize}`,
      path: ['page'],
    });
  }
}

export const paginationQuerySchema = rawPaginationQuerySchema.superRefine(rejectExcessivePaginationOffset);

// The only statuses with a defined "who may view this queue" capability
// (see domain/permits/access.ts::STATUS_VIEW_CAPABILITIES) - DRAFT is
// never queue-able (creator-only, never a capability-gated queue), and
// CLOSED has no queue use case yet, so neither is accepted here.
export const permitQueueQuerySchema = z
  .object({
    status: z.enum(['PENDING_CRO', 'PENDING_HSE', 'ISSUED']),
    ...rawPaginationQuerySchema.shape,
  })
  .superRefine(rejectExcessivePaginationOffset);

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
