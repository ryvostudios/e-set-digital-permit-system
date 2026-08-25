import { Router, type Request, type Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { env } from '../config/env.js';
import {
  canViewPermit,
  computeAvailableActions,
  computePermitValidity,
  STATUS_VIEW_CAPABILITIES,
} from '../domain/permits/access.js';
import { toDisplayNumber } from '../domain/permits/numbering.js';
import {
  closePermit,
  createDraftPermit,
  croFallbackApprove,
  forwardToHseReview,
  getJsaById,
  getPermitById,
  getPermitLifecycleEvents,
  hseApprove,
  listOwnPermits,
  listPermitsByStatus,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type LifecycleEventRow,
  type Page,
  type PermitRow,
} from '../domain/permits/service.js';
import {
  closePermitBodySchema,
  createPermitBodySchema,
  fallbackApproveBodySchema,
  forwardToHseBodySchema,
  hseApproveBodySchema,
  paginationQuerySchema,
  permitIdParamsSchema,
  permitQueueQuerySchema,
  submitPermitBodySchema,
  updatePermitBodySchema,
} from '../domain/permits/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { mutationLimiter } from '../middleware/rateLimit.js';
import { requireCapability } from '../middleware/requireCapability.js';

export const permitsRouter = Router();

// The display number format is not yet confirmed (see
// domain/permits/numbering.ts); serializing it here, at the response
// boundary, keeps that an easily-swappable presentation concern rather
// than something baked into stored data or the service layer.
function serializePermit(permit: PermitRow) {
  return { ...permit, permitDisplayNumber: toDisplayNumber(BigInt(permit.permit_sequence)) };
}

function serializeJsa(jsa: JsaRow) {
  return { ...jsa, jsaDisplayNumber: toDisplayNumber(BigInt(jsa.jsa_sequence)) };
}

/** The pagination metadata block attached to every paginated list response - the same shape regardless of which list endpoint produced it. */
function serializePagination(page: Page<unknown>) {
  return {
    page: page.page,
    pageSize: page.pageSize,
    totalCount: page.totalCount,
    totalPages: page.totalPages,
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
  };
}

function sendValidationError(res: Response, issues: unknown): void {
  res.status(400).json({ error: 'invalid_request', message: 'Invalid request', issues });
}

function sendNotFound(res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Permit not found' });
}

function sendConflict(res: Response, reason: string): void {
  res.status(409).json({ error: 'conflict', message: 'Permit has changed or is not in the required state', reason });
}

/** Guards handler bodies against a missing `req.auth` even though `requireAuth`/`requireCapability` already ran. */
function getAuthenticatedUserId(req: Request, res: Response): string | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return null;
  }
  return req.auth.id;
}

// Creating/editing/fetching a draft is gated on `permit.create`; the
// separate `permit.submit` capability gates only the DRAFT -> PENDING_CRO
// transition (least privilege - drafting and formally submitting are
// distinct grants). Every handler additionally scopes to the caller's own
// permits (created_by) at the service layer - capability alone is never
// enough for object access (SECURITY.md IDOR/BOLA guidance).

permitsRouter.post('/permits', requireAuth, mutationLimiter, requireCapability('permit.create'), async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const parsed = createPermitBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  const { permit, jsa } = await createDraftPermit(userId, env.SITE_TIMEZONE);
  res.status(201).json({ permit: serializePermit(permit), jsa: serializeJsa(jsa) });
});

// `/permits/mine` and `/permits/queue` are registered before the
// `/permits/:id` param route below - Express matches path segments in
// registration order, and both would otherwise be swallowed by `:id`
// (e.g. a request to /permits/mine would match :id="mine").

/**
 * The caller's own permits (any status) - "current user's permit list".
 * Ownership-based, not capability-gated: access is `created_by = me`,
 * enforced entirely by `listOwnPermits`'s query. Deliberately requires
 * no specific capability beyond being authenticated - a user who once
 * held `permit.create` (and so has historical permits) but has since
 * lost it must still be able to see their own history; requiring
 * `permit.create` here would incorrectly couple "can list what I already
 * created" to "can create new ones".
 *
 * Paginated (`page`/`pageSize` query params, validated/clamped by
 * `paginationQuerySchema` - safe defaults, hard max page size) so this
 * can never retrieve an unbounded result set; omitting both params keeps
 * working exactly as before pagination was added (page 1, the default
 * page size), just now with a `pagination` block alongside `permits`.
 */
permitsRouter.get('/permits/mine', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const query = paginationQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendValidationError(res, query.error.issues);
    return;
  }

  const page = await listOwnPermits(userId, query.data);
  res.status(200).json({ permits: page.items.map(serializePermit), pagination: serializePagination(page) });
});

/**
 * The capability-gated work queue for one status - WORKFLOW.md's "common
 * queue" (not scoped by ownership). Which capability a given `status`
 * requires is data-dependent (the query param), so - unlike every other
 * route here - the capability check happens inside the handler rather
 * than via a fixed `requireCapability(...)` middleware; it uses the same
 * default-deny resolver (`resolveUserCapabilities`) and the same
 * status->capability mapping that governs read access to a single permit
 * (`domain/permits/access.ts`), so it can't drift from that.
 *
 * Paginated the same way, and for the same reason, as `/permits/mine`
 * above (`permitQueueQuerySchema` composes `paginationQuerySchema`).
 */
permitsRouter.get('/permits/queue', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const query = permitQueueQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendValidationError(res, query.error.issues);
    return;
  }

  const capabilities = await resolveUserCapabilities(userId);
  const requiredCapabilities = STATUS_VIEW_CAPABILITIES[query.data.status];
  const authorized = requiredCapabilities.some((capability) => capabilities.has(capability));
  if (!authorized) {
    res.status(403).json({ error: 'forbidden', message: 'Insufficient capability' });
    return;
  }

  const page = await listPermitsByStatus(query.data.status, query.data);
  res.status(200).json({ permits: page.items.map(serializePermit), pagination: serializePagination(page) });
});

/**
 * Permit detail, together with its JSA, computed validity (once issued),
 * and a display-only `availableActions` hint. Access is granted to the
 * creator (any status) or to anyone holding a capability applicable to
 * the permit's current status (`canViewPermit`) - broader than plain
 * ownership, matching CRO/HSE's non-ownership access to the same permits
 * they can already act on via the mutation endpoints below. A permit
 * that exists but the caller isn't authorized to see responds exactly
 * like a nonexistent one (404), never 403 - the same
 * existence-hiding IDOR precaution the rest of this file already follows.
 *
 * The permit is fetched and authorized FIRST (`getPermitById` +
 * `canViewPermit`); the JSA is only fetched afterward, via `getJsaById`,
 * so an unauthorized caller's request never causes the JSA row to be
 * read at all.
 */
permitsRouter.get('/permits/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const params = permitIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }

  const permit = await getPermitById(params.data.id);
  if (!permit) {
    sendNotFound(res);
    return;
  }

  const capabilities = await resolveUserCapabilities(userId);
  if (!canViewPermit(permit, userId, capabilities)) {
    sendNotFound(res);
    return;
  }

  const jsa = await getJsaById(permit.jsa_id);
  const validity = computePermitValidity(permit, new Date());
  const availableActions = computeAvailableActions(permit, userId, capabilities, Date.now());

  res.status(200).json({
    permit: serializePermit(permit),
    jsa: serializeJsa(jsa),
    validity,
    availableActions,
  });
});

/**
 * A permit's append-only lifecycle history. Same view-authorization as
 * permit detail (permit fetched/authorized first, via `getPermitById` +
 * `canViewPermit`, before anything else is read) - but this endpoint has
 * no use for the JSA at all, so it never fetches one.
 */
permitsRouter.get('/permits/:id/history', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const params = permitIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }

  const permit = await getPermitById(params.data.id);
  if (!permit) {
    sendNotFound(res);
    return;
  }

  const capabilities = await resolveUserCapabilities(userId);
  if (!canViewPermit(permit, userId, capabilities)) {
    sendNotFound(res);
    return;
  }

  const events: LifecycleEventRow[] = await getPermitLifecycleEvents(params.data.id);
  res.status(200).json({ events });
});

permitsRouter.patch(
  '/permits/:id',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.create'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = updatePermitBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await updateDraftPermit(userId, params.data.id, {
      expectedVersion: body.data.version,
      company: body.data.company,
      companyOther: body.data.companyOther,
    });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

permitsRouter.post(
  '/permits/:id/submit',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.submit'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = submitPermitBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await submitPermit(userId, params.data.id, { expectedVersion: body.data.version });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    if (result.outcome === 'invalid') {
      res
        .status(422)
        .json({ error: 'invalid_state', message: 'Permit is missing required fields for submission', reason: result.reason });
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

// CRO forward-to-HSE, HSE approve, and CRO fallback approve act on any
// permit in the relevant state, not just permits the caller created
// (WORKFLOW.md's "common queue") - so, unlike the draft endpoints above,
// there is no ownership check; the service layer already enforces
// row-locked status/version checks, and capability is the only
// authorization gate here (SECURITY.md default-deny).

permitsRouter.post(
  '/permits/:id/forward-hse',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.forward_hse'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = forwardToHseBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await forwardToHseReview(userId, params.data.id, { expectedVersion: body.data.version });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

permitsRouter.post(
  '/permits/:id/hse-approve',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.hse_review'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = hseApproveBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await hseApprove(userId, params.data.id, { expectedVersion: body.data.version });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

permitsRouter.post(
  '/permits/:id/fallback-approve',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.fallback_approve'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = fallbackApproveBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await croFallbackApprove(userId, params.data.id, { expectedVersion: body.data.version });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    if (result.outcome === 'too_early') {
      res.status(409).json({
        error: 'conflict',
        message: 'The HSE review window has not expired yet',
        reason: 'window_not_expired',
      });
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

// Closure: "Only CRO closes a permit" (WORKFLOW.md) - no creator
// closure request/final-closure step, so this follows the same
// no-ownership-scoping pattern as forward-hse/hse-approve/
// fallback-approve above. closed_by/closed_at are never read from the
// request body (closePermitBodySchema only accepts version/
// closureRemarks) - they are always the authenticated actor and the
// database's own time.
permitsRouter.post(
  '/permits/:id/close',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.close'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = closePermitBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await closePermit(userId, params.data.id, {
      expectedVersion: body.data.version,
      closureRemarks: body.data.closureRemarks,
    });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);
