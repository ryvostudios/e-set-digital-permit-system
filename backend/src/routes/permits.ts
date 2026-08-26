import { Router, type Request, type Response } from 'express';
import { resolveUserCapabilities } from '../authz/capabilities.js';
import { env } from '../config/env.js';
import {
  canViewPermit,
  computeAvailableActions,
  computePermitValidity,
  computeViewableStatuses,
  STATUS_VIEW_CAPABILITIES,
} from '../domain/permits/access.js';
import { getDocumentForPermit, hasExpectedFileHash, resolveDocumentStorageAdapter } from '../domain/permits/documents.js';
import { toDisplayNumber } from '../domain/permits/numbering.js';
import { searchPermitLifecycleEvents, searchPermits } from '../domain/permits/search.js';
import {
  cancelPermit,
  closePermit,
  createDraftPermit,
  croFallbackApprove,
  croSendBackToApplicant,
  forwardToHseReview,
  getJsaById,
  getPermitById,
  getPermitLifecycleEvents,
  holdPermit,
  hseApprove,
  hseSendBackToCro,
  listOwnPermits,
  listPermitsByStatus,
  renewPermit,
  resubmitPermit,
  resumePermit,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type LifecycleEventRow,
  type Page,
  type PermitRow,
} from '../domain/permits/service.js';
import {
  cancelBodySchema,
  closePermitBodySchema,
  createPermitBodySchema,
  fallbackApproveBodySchema,
  forwardToHseBodySchema,
  holdBodySchema,
  hseApproveBodySchema,
  hseSendBackBodySchema,
  lifecycleEventSearchQuerySchema,
  paginationQuerySchema,
  permitIdParamsSchema,
  permitQueueQuerySchema,
  permitSearchQuerySchema,
  renewBodySchema,
  resubmitBodySchema,
  resumeBodySchema,
  sendBackBodySchema,
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
 * Permit search/filtering - scoped by the EXACT SAME access model as
 * every other permit read endpoint (`canViewPermit`/
 * `STATUS_VIEW_CAPABILITIES`, via `computeViewableStatuses`): a general
 * authenticated user searches only within permits they already own or
 * already hold a capability-granted view into - "a search must NEVER
 * reveal a permit the caller cannot normally view; do not add broad
 * access merely for search". Filters map only to genuinely existing
 * columns (Permit Number, JSA Number, status, applicant/created_by, date
 * range, company - see `permitSearchQuerySchema`); bounded pagination,
 * deterministic ordering, and parameterized SQL are enforced by
 * `domain/permits/search.ts::searchPermits`, the same module the COUNT
 * query goes through too, so result count and returned rows can never
 * diverge in authorization scope.
 *
 * Registered before `/permits/:id` for the same routing reason as
 * `/permits/mine` and `/permits/queue` above.
 */
permitsRouter.get('/permits/search', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const parsed = permitSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  const capabilities = await resolveUserCapabilities(userId);
  const page = await searchPermits(
    { viewerId: userId, allowedStatuses: computeViewableStatuses(capabilities) },
    {
      permitNumber: parsed.data.permitNumber,
      jsaNumber: parsed.data.jsaNumber,
      status: parsed.data.status,
      company: parsed.data.company,
      createdBy: parsed.data.createdBy,
      createdFrom: parsed.data.createdFrom,
      createdTo: parsed.data.createdTo,
    },
    { page: parsed.data.page, pageSize: parsed.data.pageSize },
  );

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
 *
 * With NO filter/pagination query params, behaves exactly as before
 * (every event, unfiltered, in chronological order, under the `events`
 * key alone) - preserving the existing contract exactly. Supplying any
 * filter (`eventType`, `actorUserId`, `fromStatus`, `toStatus`,
 * `occurredFrom`/`occurredTo`) or pagination (`page`/`pageSize`) switches
 * to the filtered/paginated path (`domain/permits/search.ts::searchPermitLifecycleEvents`),
 * which additionally returns a `pagination` block - "Filtering/search
 * over permit lifecycle history... Pagination + deterministic
 * chronological ordering". READ ONLY either way: this never creates an
 * update/delete/history-editing capability - the table's own append-only
 * triggers make that impossible regardless of what a query here asks
 * for.
 */
permitsRouter.get('/permits/:id/history', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const params = permitIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, params.error.issues);
    return;
  }
  const filterQuery = lifecycleEventSearchQuerySchema.safeParse(req.query);
  if (!filterQuery.success) {
    sendValidationError(res, filterQuery.error.issues);
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

  const hasFilters = Object.keys(filterQuery.data).length > 0;
  if (!hasFilters) {
    const events: LifecycleEventRow[] = await getPermitLifecycleEvents(params.data.id);
    res.status(200).json({ events });
    return;
  }

  const page = await searchPermitLifecycleEvents(
    params.data.id,
    {
      eventType: filterQuery.data.eventType,
      actorUserId: filterQuery.data.actorUserId,
      fromStatus: filterQuery.data.fromStatus,
      toStatus: filterQuery.data.toStatus,
      occurredFrom: filterQuery.data.occurredFrom,
      occurredTo: filterQuery.data.occurredTo,
    },
    { page: filterQuery.data.page ?? 1, pageSize: filterQuery.data.pageSize ?? 20 },
  );
  res.status(200).json({ events: page.items, pagination: serializePagination(page) });
});

/**
 * The immutable, combined Permit+JSA PDF for an issued (or post-issued:
 * HELD/CANCELLED/CLOSED) permit - "CORE BUSINESS RULE: every ISSUED
 * permit has ONE combined PDF containing PERMIT then JSA". Authorizes
 * the permit FIRST (`getPermitById` + `canViewPermit`), exactly like
 * permit detail/history above, BEFORE ever looking up the document -
 * "authorize permit visibility BEFORE document/file retrieval". Never
 * returns a fake/placeholder PDF: if generation/storage hasn't completed
 * yet (or the configured storage adapter isn't set up), this responds
 * with an explicit processing/unavailable status instead.
 */
permitsRouter.get('/permits/:id/pdf', requireAuth, async (req: Request, res: Response) => {
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

  // Only ISSUED (or an issued permit's later HELD/CANCELLED/CLOSED
  // state) ever has a document at all - `issued_at` is set if and only
  // if the permit has ever been issued (permits_issued_at_consistent).
  // DRAFT/PENDING_* permits are never issued, so this is a 404, not a
  // "still generating" response - there is nothing to generate yet.
  if (!permit.issued_at) {
    sendNotFound(res);
    return;
  }

  const lookup = await getDocumentForPermit(params.data.id);
  if (!lookup) {
    // An issued permit that somehow has no snapshot row would be a bug
    // elsewhere (issuance is supposed to create one atomically) - still
    // handled safely here as "not yet available" rather than a 500.
    res.status(202).json({ status: 'processing', message: 'The permit document has not been generated yet' });
    return;
  }

  if (lookup.job.status !== 'GENERATED' || !lookup.job.storage_path) {
    res.status(202).json({
      status: lookup.job.status === 'FAILED' ? 'failed' : 'processing',
      message:
        lookup.job.status === 'FAILED'
          ? 'PDF generation previously failed and will be retried'
          : 'The permit document is still being generated',
    });
    return;
  }

  const storage = resolveDocumentStorageAdapter();
  const download = await storage.download(lookup.job.storage_path);
  if (!download.ok) {
    res.status(503).json({ error: 'storage_unavailable', message: 'The permit document could not be retrieved right now' });
    return;
  }

  if (!hasExpectedFileHash(download.data, lookup.job.file_hash)) {
    console.error(
      JSON.stringify({
        event: 'permit_document_integrity_failure',
        requestId: req.requestId,
        permitId: permit.id,
      }),
    );
    res.status(500).json({ error: 'document_integrity_error', message: 'The permit document failed integrity verification' });
    return;
  }

  const safeFileName = `permit-${toDisplayNumber(BigInt(permit.permit_sequence))}.pdf`;
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
  res.send(download.data);
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

/**
 * Applicant resubmission after a CRO send-back: PENDING_CORRECTION ->
 * PENDING_CRO. Same ownership-scoping as `/submit` (only the original
 * applicant may resubmit their own permit) - `permit.submit` is reused
 * as the authorization gate, the same capability that gates the
 * original submission, since resubmitting is the same underlying
 * "finalize and send to CRO" authority.
 */
permitsRouter.post(
  '/permits/:id/resubmit',
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
    const body = resubmitBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await resubmitPermit(userId, params.data.id, { expectedVersion: body.data.version });

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
        .json({ error: 'invalid_state', message: 'Permit is missing required fields for resubmission', reason: result.reason });
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

/** CRO send-back to applicant: PENDING_CRO -> PENDING_CORRECTION. */
permitsRouter.post(
  '/permits/:id/send-back',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.send_back'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = sendBackBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await croSendBackToApplicant(userId, params.data.id, {
      expectedVersion: body.data.version,
      reason: body.data.reason,
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

/**
 * HSE send-back to CRO: PENDING_HSE -> PENDING_CRO (never directly to
 * the applicant). Authorized by `permit.hse_review` - the same
 * capability that gates `/hse-approve` - since both are HSE's two
 * possible verdicts on a pending review.
 */
permitsRouter.post(
  '/permits/:id/hse-send-back',
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
    const body = hseSendBackBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await hseSendBackToCro(userId, params.data.id, {
      expectedVersion: body.data.version,
      reason: body.data.reason,
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

/** CRO Hold: ISSUED -> HELD. `reason` is mandatory (holdBodySchema requires it). */
permitsRouter.post(
  '/permits/:id/hold',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.hold'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = holdBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await holdPermit(userId, params.data.id, {
      expectedVersion: body.data.version,
      reason: body.data.reason,
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

/**
 * CRO Resume: HELD -> ISSUED, only strictly before the permit's original
 * midnight expiry. Never touches `issued_at` - resume cannot extend
 * validity or restart it (see domain/permits/service.ts::resumePermit).
 */
permitsRouter.post(
  '/permits/:id/resume',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.resume'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = resumeBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await resumePermit(userId, params.data.id, { expectedVersion: body.data.version });

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    if (result.outcome === 'expired') {
      res.status(409).json({
        error: 'conflict',
        message: "The permit's midnight expiry has already passed - it can no longer be resumed",
        reason: 'expired',
      });
      return;
    }
    res.status(200).json({ permit: serializePermit(result.permit) });
  },
);

/**
 * CRO Cancel: ISSUED or HELD -> CANCELLED, permanently. `reason` is
 * optional - not documented as mandatory.
 */
permitsRouter.post(
  '/permits/:id/cancel',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.cancel'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = cancelBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await cancelPermit(userId, params.data.id, {
      expectedVersion: body.data.version,
      reason: body.data.reason,
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

// Closure: "Only CRO closes a permit" (WORKFLOW.md) - no creator
// closure request/final-closure step, so this follows the same
// no-ownership-scoping pattern as forward-hse/hse-approve/
// fallback-approve above. closed_by/closed_at are never read from the
// request body (closePermitBodySchema only accepts version/
// closureRemarks) - they are always the authenticated actor and the
// database's own time. HELD is also closable now - see
// domain/permits/service.ts::closePermit.
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

/**
 * Renewal: creates a brand-new permit linked to the given, already-
 * CLOSED permit - not a mutation of it (see
 * domain/permits/service.ts::renewPermit for the full rules: same JSA,
 * new Permit Number, immediately ISSUED, no HSE timer). 201, not 200:
 * this creates a new resource, matching `POST /permits`'s own status
 * code for the same reason. The `:id` in the route refers to the OLD
 * (CLOSED) permit being renewed, not the new one being created.
 */
permitsRouter.post(
  '/permits/:id/renew',
  requireAuth,
  mutationLimiter,
  requireCapability('permit.renew'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }
    const body = renewBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      sendValidationError(res, body.error.issues);
      return;
    }

    const result = await renewPermit(userId, params.data.id);

    if (result.outcome === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (result.outcome === 'conflict') {
      sendConflict(res, result.reason);
      return;
    }
    res.status(201).json({ permit: serializePermit(result.permit), jsa: serializeJsa(result.jsa) });
  },
);
