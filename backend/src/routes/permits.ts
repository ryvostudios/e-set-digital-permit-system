import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { toDisplayNumber } from '../domain/permits/numbering.js';
import {
  closePermit,
  createDraftPermit,
  croFallbackApprove,
  forwardToHseReview,
  getOwnPermit,
  hseApprove,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type PermitRow,
} from '../domain/permits/service.js';
import {
  closePermitBodySchema,
  createPermitBodySchema,
  fallbackApproveBodySchema,
  forwardToHseBodySchema,
  hseApproveBodySchema,
  permitIdParamsSchema,
  submitPermitBodySchema,
  updatePermitBodySchema,
} from '../domain/permits/validation.js';
import { requireAuth } from '../middleware/auth.js';
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

permitsRouter.post('/permits', requireAuth, requireCapability('permit.create'), async (req: Request, res: Response) => {
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

permitsRouter.get(
  '/permits/:id',
  requireAuth,
  requireCapability('permit.create'),
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = permitIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }

    const permit = await getOwnPermit(userId, params.data.id);
    if (!permit) {
      sendNotFound(res);
      return;
    }
    res.status(200).json({ permit: serializePermit(permit) });
  },
);

permitsRouter.patch(
  '/permits/:id',
  requireAuth,
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
