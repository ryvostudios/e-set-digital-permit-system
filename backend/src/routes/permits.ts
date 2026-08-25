import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { toDisplayNumber } from '../domain/permits/numbering.js';
import {
  createDraftPermit,
  getOwnPermit,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type PermitRow,
} from '../domain/permits/service.js';
import {
  createPermitBodySchema,
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
  res.status(409).json({ error: 'conflict', message: 'Permit has changed or is no longer a draft', reason });
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
