import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { MAX_PAGE_SIZE, MAX_PAGINATION_OFFSET } from './validation.js';
import { isPermitValid } from './validity.js';
import type { IssuanceEventMetadata } from './documents.js';
import {
  onCroSentBackToApplicant,
  onForwardedToHse,
  onHseSentBackToCro,
  onPermitCancelled,
  onPermitClosed,
  onPermitHeld,
  onPermitIssued,
  onPermitRenewed,
  onPermitResumed,
  onPermitSubmittedOrResubmitted,
  ResponsibilityRecipientUnavailableError,
} from './workflowSideEffects.js';

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION_SQLSTATE = '23505';

/** Whether `err` is a `pg` unique-constraint-violation error for exactly `constraintName` - used to turn a database-enforced race outcome (see `renewPermit`) into a normal conflict result, not an uncaught throw. */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE &&
    (err as { constraint?: unknown }).constraint === constraintName
  );
}

export type PermitStatus =
  | 'DRAFT'
  | 'PENDING_CRO'
  | 'PENDING_HSE'
  | 'PENDING_CORRECTION'
  | 'ISSUED'
  | 'HELD'
  | 'CANCELLED'
  | 'CLOSED';
export type Company = 'ESET' | 'SGRE' | 'ZPL' | 'OTHER';

export interface PermitRow {
  id: string;
  // Raw, authoritative numbering value (from permit_number_seq via the
  // column DEFAULT) - a bigint, returned by pg as a string. The
  // human-visible display format is not confirmed yet; see
  // domain/permits/numbering.ts::toDisplayNumber.
  permit_sequence: string;
  jsa_id: string;
  status: PermitStatus;
  version: number;
  created_by: string;
  previous_permit_id: string | null;
  site_timezone: string;
  company: Company | null;
  company_other: string | null;
  submitted_at: string | null;
  // Set together, DB-side, by forwardToHseReview - the authoritative
  // start/deadline of HSE's 5-minute review window (SECURITY.md "Time
  // and Enforcement Integrity"; never derived from client/browser time).
  hse_review_started_at: string | null;
  hse_review_deadline_at: string | null;
  issued_at: string | null;
  // Set together, DB-side, by closePermit - never derived from
  // client-supplied values (SECURITY.md).
  closed_by: string | null;
  closed_at: string | null;
  closure_remarks: string | null;
  // Set together, DB-side, by holdPermit; cleared (NULL) by resumePermit/
  // closePermit/cancelPermit - present if and only if status = 'HELD'
  // (permits_hold_consistent). `hold_reason` is mandatory whenever set.
  held_by: string | null;
  held_at: string | null;
  hold_reason: string | null;
  // Set together, DB-side, by cancelPermit - present if and only if
  // status = 'CANCELLED' (permits_cancellation_consistent). Never
  // cleared: cancellation is terminal.
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface JsaRow {
  id: string;
  // Raw, authoritative numbering value (from jsa_number_seq via the
  // column DEFAULT) - see the note on PermitRow.permit_sequence.
  jsa_sequence: string;
  created_by: string;
  created_at: string;
}

export interface LifecycleEventRow {
  id: string;
  // Raw ordering value (BIGSERIAL, returned by pg as a string) - see the
  // note on PermitRow.permit_sequence for why bigints come back as text.
  ordinal: string;
  permit_id: string;
  event_type: string;
  actor_user_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  occurred_at: string;
}

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

/** Injectable so this module can be unit tested without a live database. */
export interface PermitsServiceDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

const defaultDeps: PermitsServiceDeps = { query, withTransaction };

type MissingResponsibilityRecipientOutcome = {
  outcome: 'conflict';
  reason: 'no_responsible_recipient';
  responsibility: 'CRO' | 'HSE';
};

async function runResponsibilityHandoff<T>(
  deps: PermitsServiceDeps,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | MissingResponsibilityRecipientOutcome> {
  try {
    return await deps.withTransaction(work);
  } catch (err) {
    if (err instanceof ResponsibilityRecipientUnavailableError) {
      return { outcome: 'conflict', reason: 'no_responsible_recipient', responsibility: err.responsibility };
    }
    throw err;
  }
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected a database row but got none');
  }
  return row;
}

/**
 * Creates a new draft permit and its JSA in a single transaction. Both
 * numbering values (permit_sequence/jsa_sequence) are generated
 * DB-side, by the columns' own DEFAULT nextval(...) expressions
 * (atomic/unique/concurrency-safe) - the backend never computes or
 * formats a number before insert, only reads back whatever Postgres
 * generated via RETURNING *. The permit is inserted as DRAFT owned by
 * `actorUserId`, and a CREATED lifecycle event is recorded.
 * `siteTimezone` is snapshotted onto the permit row so a later change to
 * the backend's configured site timezone can't retroactively change how
 * this permit's validity is evaluated.
 */
export async function createDraftPermit(
  actorUserId: string,
  siteTimezone: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<{ permit: PermitRow; jsa: JsaRow }> {
  return deps.withTransaction(async (client) => {
    const jsaResult = await client.query<JsaRow>('INSERT INTO jsas (created_by) VALUES ($1) RETURNING *', [
      actorUserId,
    ]);
    const jsa = requireRow(jsaResult.rows);

    const permitResult = await client.query<PermitRow>(
      `INSERT INTO permits (jsa_id, created_by, site_timezone, status)
       VALUES ($1, $2, $3, 'DRAFT')
       RETURNING *`,
      [jsa.id, actorUserId, siteTimezone],
    );
    const permit = requireRow(permitResult.rows);

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [permit.id, 'CREATED', actorUserId, null, 'DRAFT'],
    );

    return { permit, jsa };
  });
}

/**
 * Fetches a permit only if it belongs to `actorUserId`. Returns null for
 * both "no such permit" and "exists but isn't yours" - the same response
 * either way avoids confirming another user's permit ID exists (IDOR/BOLA,
 * SECURITY.md).
 */
export async function getOwnPermit(
  actorUserId: string,
  permitId: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<PermitRow | null> {
  const result = await deps.query<PermitRow>('SELECT * FROM permits WHERE id = $1 AND created_by = $2', [
    permitId,
    actorUserId,
  ]);
  return result.rows[0] ?? null;
}

/**
 * Fetches a permit only - no JSA join, no ownership/capability filter.
 * Deliberately separate from `getPermitWithJsa`: callers that must
 * authorize the caller against the permit (`domain/permits/access.ts::canViewPermit`)
 * before touching any related/child data (the JSA, lifecycle history)
 * use this first, so an unauthorized request never causes a second
 * table to be read.
 */
export async function getPermitById(
  permitId: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<PermitRow | null> {
  const result = await deps.query<PermitRow>('SELECT * FROM permits WHERE id = $1', [permitId]);
  return result.rows[0] ?? null;
}

/**
 * Fetches a JSA by its own id - the row referenced by a permit's
 * `jsa_id`. `permits.jsa_id` is `NOT NULL REFERENCES jsas (id) ON DELETE
 * RESTRICT` (migration 0006), so this always resolves for a real
 * permit's `jsa_id`; a missing row here would mean that invariant was
 * violated, not a normal "not found", so - like the RETURNING-row reads
 * above - it throws via `requireRow` rather than returning null.
 */
export async function getJsaById(jsaId: string, deps: PermitsServiceDeps = defaultDeps): Promise<JsaRow> {
  const result = await deps.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [jsaId]);
  return requireRow(result.rows);
}

interface PermitWithJsaRow extends PermitRow {
  jsa_row_id: string;
  jsa_sequence: string;
  jsa_created_by: string;
  jsa_created_at: string;
}

function splitPermitJsaRow(row: PermitWithJsaRow): { permit: PermitRow; jsa: JsaRow } {
  const { jsa_row_id, jsa_sequence, jsa_created_by, jsa_created_at, ...permit } = row;
  return {
    permit,
    jsa: { id: jsa_row_id, jsa_sequence, created_by: jsa_created_by, created_at: jsa_created_at },
  };
}

/**
 * Fetches a permit together with its JSA by ID alone - no ownership or
 * capability filter. This is a raw lookup only; callers (route handlers)
 * are responsible for authorizing the result before returning it to a
 * client (see `domain/permits/access.ts::canViewPermit`) - mirroring how
 * `forwardToHseReview`/`hseApprove`/etc. above look up by ID and leave
 * authorization to the capability check around them, since CRO/HSE read
 * access is not ownership-based either.
 *
 * Because this always reads the JSA too, callers that need to authorize
 * the caller BEFORE any child-table read happens (permit detail,
 * history) should use `getPermitById` + `canViewPermit` first, and only
 * call `getJsaById` afterward - not this. This function remains for
 * cases (tests, and any future caller) that legitimately want both
 * unconditionally in one round trip.
 */
export async function getPermitWithJsa(
  permitId: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<{ permit: PermitRow; jsa: JsaRow } | null> {
  const result = await deps.query<PermitWithJsaRow>(
    `SELECT p.*, j.id AS jsa_row_id, j.jsa_sequence, j.created_by AS jsa_created_by, j.created_at AS jsa_created_at
       FROM permits p
       JOIN jsas j ON j.id = p.jsa_id
      WHERE p.id = $1`,
    [permitId],
  );
  const row = result.rows[0];
  return row ? splitPermitJsaRow(row) : null;
}

export interface PageParams {
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Shared shape/math for every paginated list below - so `hasNextPage`/`totalPages` can't drift between them. */
function toPage<T>(items: T[], pageParams: PageParams, totalCount: number): Page<T> {
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageParams.pageSize);
  return {
    items,
    page: pageParams.page,
    pageSize: pageParams.pageSize,
    totalCount,
    totalPages,
    hasNextPage: pageParams.page < totalPages,
    hasPreviousPage: pageParams.page > 1,
  };
}

/**
 * The route layer already rejects an invalid `page`/`pageSize` (and any
 * combination whose offset exceeds `MAX_PAGINATION_OFFSET`) before this
 * is ever called - see
 * `domain/permits/validation.ts::{paginationQuerySchema,rejectExcessivePaginationOffset}`.
 * This does NOT assume that already happened: it independently
 * re-derives every invariant from scratch (page/pageSize shape first,
 * then the offset computed from them), so a pathological OFFSET can
 * never reach the database even if some future caller invoked
 * `listOwnPermits`/`listPermitsByStatus` directly, bypassing route
 * validation entirely. Throws (never clamps) before any query runs.
 */
function pageOffset(pageParams: PageParams): number {
  const { page, pageSize } = pageParams;

  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError(`invalid pagination: page must be a safe integer >= 1 (got ${page})`);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`invalid pagination: pageSize must be a safe integer in [1, ${MAX_PAGE_SIZE}] (got ${pageSize})`);
  }

  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGINATION_OFFSET) {
    throw new RangeError(
      `invalid pagination: offset must be a safe integer in [0, ${MAX_PAGINATION_OFFSET}] (page=${page}, pageSize=${pageSize}, offset=${offset})`,
    );
  }
  return offset;
}

/**
 * Every permit `actorUserId` created, most recent first - the creator's
 * own list/dashboard view. Bounded by `pageParams` (validated/clamped
 * before this is ever called - see `domain/permits/validation.ts::paginationQuerySchema`),
 * so this never retrieves an unbounded result set regardless of how many
 * permits the caller has created. `created_at DESC, id DESC` is a
 * deterministic total order - `id` breaks ties when two permits share a
 * `created_at` (otherwise possible, if not likely, and would otherwise
 * make page boundaries non-deterministic under LIMIT/OFFSET).
 */
export async function listOwnPermits(
  actorUserId: string,
  pageParams: PageParams,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<Page<PermitRow>> {
  const [rowsResult, countResult] = await Promise.all([
    deps.query<PermitRow>(
      'SELECT * FROM permits WHERE created_by = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
      [actorUserId, pageParams.pageSize, pageOffset(pageParams)],
    ),
    deps.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM permits WHERE created_by = $1', [
      actorUserId,
    ]),
  ]);
  return toPage(rowsResult.rows, pageParams, Number(countResult.rows[0]?.count ?? '0'));
}

/**
 * Every permit currently in `status`, oldest first (FIFO work queue) -
 * not scoped by ownership. Callers authorize which `status` a given
 * caller may request (see `domain/permits/access.ts::STATUS_VIEW_CAPABILITIES`)
 * before calling this. Bounded by `pageParams` the same way, and for the
 * same reason, as `listOwnPermits` above; `created_at ASC, id ASC` keeps
 * the FIFO ordering deterministic under LIMIT/OFFSET for the same
 * tie-breaking reason.
 */
export async function listPermitsByStatus(
  status: PermitStatus,
  pageParams: PageParams,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<Page<PermitRow>> {
  const [rowsResult, countResult] = await Promise.all([
    deps.query<PermitRow>(
      'SELECT * FROM permits WHERE status = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3',
      [status, pageParams.pageSize, pageOffset(pageParams)],
    ),
    deps.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM permits WHERE status = $1', [status]),
  ]);
  return toPage(rowsResult.rows, pageParams, Number(countResult.rows[0]?.count ?? '0'));
}

/** A permit's full append-only lifecycle history, in the order it happened. */
export async function getPermitLifecycleEvents(
  permitId: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<LifecycleEventRow[]> {
  const result = await deps.query<LifecycleEventRow>(
    'SELECT * FROM permit_lifecycle_events WHERE permit_id = $1 ORDER BY ordinal ASC',
    [permitId],
  );
  return result.rows;
}

export interface UpdateDraftInput {
  expectedVersion: number;
  company?: Company | undefined;
  companyOther?: string | undefined;
}

export type UpdateDraftOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_editable' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

// A permit is editable by its creator in exactly two statuses: DRAFT
// (never submitted yet) and PENDING_CORRECTION (CRO sent it back for
// correction - "Applicant must be able to edit it", this batch's CRO
// send-back rules). Shared with `resubmitPermit`'s ownership/edit-status
// story below.
const EDITABLE_STATUSES: readonly PermitStatus[] = ['DRAFT', 'PENDING_CORRECTION'];

/**
 * Updates a DRAFT-or-PENDING_CORRECTION permit's editable fields
 * (currently just `company` / `company_other` - the only field
 * DECISIONS.md documents). Only applies if the permit belongs to
 * `actorUserId`, is in an editable status, and `expectedVersion` matches
 * the current row version - otherwise it's a conflict, never a silent
 * overwrite (SECURITY.md). The read-then-write happens under a row lock
 * (`FOR UPDATE`) inside one transaction so the check and the write are
 * atomic even under concurrent requests.
 */
export async function updateDraftPermit(
  actorUserId: string,
  permitId: string,
  input: UpdateDraftInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<UpdateDraftOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>(
      'SELECT * FROM permits WHERE id = $1 AND created_by = $2 FOR UPDATE',
      [permitId, actorUserId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (!EDITABLE_STATUSES.includes(existing.status)) return { outcome: 'conflict', reason: 'not_editable' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const nextCompany = input.company ?? existing.company;
    const nextCompanyOther = input.company !== undefined ? (input.companyOther ?? null) : existing.company_other;

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET company = $1, company_other = $2, version = version + 1, updated_at = now()
        WHERE id = $3
        RETURNING *`,
      [nextCompany, nextCompanyOther, permitId],
    );
    return { outcome: 'ok', permit: requireRow(updateResult.rows) };
  });
}

export interface SubmitInput {
  expectedVersion: number;
}

export type SubmitOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_draft' | 'stale_version' }
  | MissingResponsibilityRecipientOutcome
  | { outcome: 'invalid'; reason: 'missing_required_fields' }
  | { outcome: 'ok'; permit: PermitRow };

function isSubmittable(permit: PermitRow): boolean {
  if (!permit.company) return false;
  if (permit.company === 'OTHER' && !permit.company_other) return false;
  return true;
}

/**
 * The only implemented transition: DRAFT -> PENDING_CRO ("Submission
 * always goes to CRO first" - DECISIONS.md/WORKFLOW.md, unambiguous).
 * Same ownership/status/version-conflict checks as `updateDraftPermit`,
 * plus a required-field check (`company`, per DECISIONS.md) before the
 * transition is allowed. Records a SUBMITTED lifecycle event in the same
 * transaction as the status change.
 */
export async function submitPermit(
  actorUserId: string,
  permitId: string,
  input: SubmitInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<SubmitOutcome> {
  return runResponsibilityHandoff(deps, async (client) => {
    const existingResult = await client.query<PermitRow>(
      'SELECT * FROM permits WHERE id = $1 AND created_by = $2 FOR UPDATE',
      [permitId, actorUserId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'DRAFT') return { outcome: 'conflict', reason: 'not_draft' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };
    if (!isSubmittable(existing)) return { outcome: 'invalid', reason: 'missing_required_fields' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'PENDING_CRO', version = version + 1, submitted_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [permitId, 'SUBMITTED', actorUserId, 'DRAFT', 'PENDING_CRO'],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    await onPermitSubmittedOrResubmitted(client.query.bind(client), { permit, sourceEventId, resubmitted: false });

    return { outcome: 'ok', permit };
  });
}

export interface ResubmitInput {
  expectedVersion: number;
}

export type ResubmitOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_correction' | 'stale_version' }
  | MissingResponsibilityRecipientOutcome
  | { outcome: 'invalid'; reason: 'missing_required_fields' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * Applicant resubmission after a CRO send-back: PENDING_CORRECTION ->
 * PENDING_CRO ("Applicant resubmission returns permit to PENDING_CRO" -
 * this batch's CRO send-back rules). Same ownership/status/version-
 * conflict shape as `submitPermit` (only the original applicant may
 * resubmit their own permit - `created_by = actorUserId`, not just any
 * capability holder), and the same required-field re-check
 * (`isSubmittable`) - a resubmission must clear the same completeness
 * bar the original submission did. Deliberately a separate function
 * from `submitPermit` rather than widening it to accept either source
 * status: the two record different, distinctly-named lifecycle events
 * (SUBMITTED vs APPLICANT_RESUBMITTED), matching every other
 * status-specific transition in this file.
 */
export async function resubmitPermit(
  actorUserId: string,
  permitId: string,
  input: ResubmitInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<ResubmitOutcome> {
  return runResponsibilityHandoff(deps, async (client) => {
    const existingResult = await client.query<PermitRow>(
      'SELECT * FROM permits WHERE id = $1 AND created_by = $2 FOR UPDATE',
      [permitId, actorUserId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_CORRECTION') return { outcome: 'conflict', reason: 'not_pending_correction' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };
    if (!isSubmittable(existing)) return { outcome: 'invalid', reason: 'missing_required_fields' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'PENDING_CRO', version = version + 1, submitted_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [permitId, 'APPLICANT_RESUBMITTED', actorUserId, 'PENDING_CORRECTION', 'PENDING_CRO'],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    await onPermitSubmittedOrResubmitted(client.query.bind(client), { permit, sourceEventId, resubmitted: true });

    return { outcome: 'ok', permit };
  });
}

// CRO/HSE review actions (below) are never scoped by `created_by`: CRO
// and HSE act on permits they did not create - WORKFLOW.md's "common
// queue" - so object access is authorized by capability alone, backed by
// the row lock + status/version check making the actual state change
// atomic and race-safe. There is no ownership check to make here.

export interface ForwardToHseInput {
  expectedVersion: number;
}

export type ForwardToHseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_cro' | 'stale_version' }
  | MissingResponsibilityRecipientOutcome
  | { outcome: 'ok'; permit: PermitRow };

/**
 * The only implemented CRO review transition: PENDING_CRO -> PENDING_HSE
 * ("CRO forwarding to HSE moves the permit to PENDING_HSE and starts a
 * strict 5-minute HSE review window" - DECISIONS.md). Opens the window
 * using DB-authoritative time in a single statement (`now()` is stable
 * for the whole transaction), so `hse_review_started_at` and
 * `hse_review_deadline_at` are always exactly 5 minutes apart. Records a
 * CRO_FORWARDED_HSE lifecycle event in the same transaction.
 */
export async function forwardToHseReview(
  actorUserId: string,
  permitId: string,
  input: ForwardToHseInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<ForwardToHseOutcome> {
  return runResponsibilityHandoff(deps, async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_CRO') return { outcome: 'conflict', reason: 'not_pending_cro' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'PENDING_HSE',
              hse_review_started_at = now(),
              hse_review_deadline_at = now() + INTERVAL '5 minutes',
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [permitId, 'CRO_FORWARDED_HSE', actorUserId, 'PENDING_CRO', 'PENDING_HSE'],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    await onForwardedToHse(client.query.bind(client), { permit, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

export interface SendBackInput {
  expectedVersion: number;
  reason?: string | undefined;
}

export type SendBackOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_cro' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * CRO send-back to applicant: PENDING_CRO -> PENDING_CORRECTION ("While
 * permit is PENDING_CRO: CRO may send it back to the original applicant
 * for correction" - this batch's CRO send-back rules). Same
 * no-ownership-scoping as `forwardToHseReview` (CRO acts on permits it
 * did not create); `permit.send_back` is the sole authorization gate.
 * `reason` is optional (not documented as mandatory, unlike Hold's
 * reason) but recorded on the lifecycle event when supplied.
 */
export async function croSendBackToApplicant(
  actorUserId: string,
  permitId: string,
  input: SendBackInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<SendBackOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_CRO') return { outcome: 'conflict', reason: 'not_pending_cro' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const reason = input.reason ?? null;
    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'PENDING_CORRECTION', version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [permitId, 'CRO_SENT_BACK_TO_APPLICANT', actorUserId, 'PENDING_CRO', 'PENDING_CORRECTION', reason],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    await onCroSentBackToApplicant(client.query.bind(client), { permit, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

export interface HseApproveInput {
  expectedVersion: number;
}

export type HseApproveOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_hse' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * HSE approval: PENDING_HSE -> ISSUED ("A permit becomes ISSUED via...
 * valid HSE approval" - WORKFLOW.md). Deliberately has no time-based
 * gate: whether HSE may still act after the 5-minute window has expired
 * but before CRO has performed fallback approval is explicitly
 * UNRESOLVED (DECISIONS.md open decision #1) - restricting it here would
 * be answering that open question, not implementing a confirmed rule.
 * The row lock (shared with `croFallbackApprove`) is what actually
 * matters for correctness: once either this or fallback approval
 * commits, the permit is no longer PENDING_HSE, so the other is
 * rejected by the status check - exactly one approval path can win.
 */
export async function hseApprove(
  actorUserId: string,
  permitId: string,
  input: HseApproveInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<HseApproveOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_HSE') return { outcome: 'conflict', reason: 'not_pending_hse' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'ISSUED', issued_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<IssuanceEventMetadata>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, event_type, actor_user_id, occurred_at, now() AS snapshot_taken_at`,
      [permitId, 'HSE_APPROVED', actorUserId, 'PENDING_HSE', 'ISSUED'],
    );
    const issuanceEvent = requireRow(eventResult.rows);
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitIssued(client.query.bind(client), { permit, jsa, issuanceEvent });

    return { outcome: 'ok', permit };
  });
}

export interface HseSendBackInput {
  expectedVersion: number;
  reason?: string | undefined;
}

export type HseSendBackOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_hse' | 'stale_version' }
  | MissingResponsibilityRecipientOutcome
  | { outcome: 'ok'; permit: PermitRow };

/**
 * HSE send-back to CRO: PENDING_HSE -> PENDING_CRO ("HSE may send permit
 * back to CRO. HSE does NOT send directly to applicant. active 5-minute
 * HSE timer stops immediately" - this batch's HSE send-back rules).
 * Clears `hse_review_started_at`/`hse_review_deadline_at` back to NULL
 * in the same statement as the status change - this IS "the timer
 * stops immediately" (there is no separate timer/job to cancel; the
 * timer is purely these two columns, and PENDING_CRO requires them NULL
 * - permits_hse_window_status_consistent). Old HSE review
 * attempts/history remain fully auditable via permit_lifecycle_events
 * (this event, and any prior CRO_FORWARDED_HSE), unaffected by clearing
 * the live columns. When CRO forwards again later, `forwardToHseReview`
 * unconditionally sets fresh `now()`/`now() + 5 minutes` regardless of
 * this permit's history, so a re-forward always starts a completely new
 * window - never a reused/continued deadline - with no change needed
 * here to guarantee that.
 *
 * Deliberately has no time-based gate on when HSE may send back, for
 * the same reason `hseApprove` doesn't: whether HSE may still act after
 * the window has expired is explicitly UNRESOLVED (DECISIONS.md open
 * decision #1); restricting it here would be answering that open
 * question. Authorized by `permit.hse_review` - the same capability
 * that gates `hseApprove` - since both are HSE's two possible verdicts
 * on a pending review, not two separately-grantable authorities.
 */
export async function hseSendBackToCro(
  actorUserId: string,
  permitId: string,
  input: HseSendBackInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<HseSendBackOutcome> {
  return runResponsibilityHandoff(deps, async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_HSE') return { outcome: 'conflict', reason: 'not_pending_hse' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const reason = input.reason ?? null;
    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'PENDING_CRO',
              hse_review_started_at = NULL,
              hse_review_deadline_at = NULL,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [permitId, 'HSE_SENT_BACK_TO_CRO', actorUserId, 'PENDING_HSE', 'PENDING_CRO', reason],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    await onHseSentBackToCro(client.query.bind(client), { permit, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

export interface FallbackApproveInput {
  expectedVersion: number;
}

export type FallbackApproveOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_pending_hse' | 'stale_version' }
  | { outcome: 'too_early' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * CRO fallback approval: PENDING_HSE -> ISSUED, but only once the
 * 5-minute HSE review window has genuinely expired ("If HSE does not
 * act within the window, CRO gains fallback approval authority" -
 * WORKFLOW.md; note "does not act", not "does not approve" - there is no
 * separate check for whether HSE sent the permit back, since send-back
 * isn't implemented). Eligibility is computed by the database itself
 * (`now() >= hse_review_deadline_at`, evaluated under the same row lock
 * used to read the rest of the permit) - never by the backend's or a
 * client's clock. No background job ever calls this: eligibility is only
 * ever evaluated when CRO actually attempts the action, and nothing
 * transitions the permit automatically just because the deadline passed.
 * Shares the row lock with `hseApprove`, so exactly one of the two can
 * ever win a race for the same permit.
 */
export async function croFallbackApprove(
  actorUserId: string,
  permitId: string,
  input: FallbackApproveInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<FallbackApproveOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow & { fallback_eligible: boolean | null }>(
      `SELECT *, (now() >= hse_review_deadline_at) AS fallback_eligible
         FROM permits
        WHERE id = $1
        FOR UPDATE`,
      [permitId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'PENDING_HSE') return { outcome: 'conflict', reason: 'not_pending_hse' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };
    if (!existing.fallback_eligible) return { outcome: 'too_early' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'ISSUED', issued_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<IssuanceEventMetadata>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, event_type, actor_user_id, occurred_at, now() AS snapshot_taken_at`,
      [permitId, 'CRO_FALLBACK_APPROVED', actorUserId, 'PENDING_HSE', 'ISSUED'],
    );
    const issuanceEvent = requireRow(eventResult.rows);
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitIssued(client.query.bind(client), { permit, jsa, issuanceEvent });

    return { outcome: 'ok', permit };
  });
}

export interface HoldInput {
  expectedVersion: number;
  /** Mandatory - "HOLD REASON IS MANDATORY" (this batch's Hold rules); enforced again at the database level (permits_hold_consistent), not just here. */
  reason: string;
}

export type HoldOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_issued' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * CRO Hold: ISSUED -> HELD ("Only CRO may HOLD an ISSUED permit" - this
 * batch's Hold rules; only ISSUED, not any mid-review state, resolving
 * DECISIONS.md's previously-open decision #2). Same numbering/no-
 * ownership-scoping pattern as `closePermit` below. `held_by`/`held_at`
 * are always the authenticated actor and the database's own time - the
 * caller has no way to supply either (see `HoldInput`, which only
 * accepts the expected version and the reason).
 */
export async function holdPermit(
  actorUserId: string,
  permitId: string,
  input: HoldInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<HoldOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'ISSUED') return { outcome: 'conflict', reason: 'not_issued' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'HELD', held_by = $2, held_at = now(), hold_reason = $3, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId, actorUserId, input.reason],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [permitId, 'HELD', actorUserId, 'ISSUED', 'HELD', input.reason],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitHeld(client.query.bind(client), { permit, jsa, sourceEventId, holdReason: input.reason });

    return { outcome: 'ok', permit };
  });
}

export interface ResumeInput {
  expectedVersion: number;
}

export type ResumeOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_held' | 'stale_version' }
  | { outcome: 'expired' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * CRO Resume: HELD -> ISSUED, but only strictly before the permit's
 * ORIGINAL midnight expiry ("Resume is allowed only BEFORE the existing
 * permit midnight expiry... At or after midnight: resume must fail" -
 * this batch's Resume rules). `issued_at` is never touched by Hold or
 * Resume, so the expiry boundary (`computeNextMidnightUtc(issued_at,
 * site_timezone)`, via `isPermitValid`) is exactly the SAME boundary the
 * permit had before it was ever held - resume cannot extend validity,
 * restart it, or create a new HSE timer, because nothing about
 * `issued_at`/`hse_review_*` is ever written here.
 *
 * Uses DATABASE-authoritative time (`now()`, selected as `db_now` in the
 * same `FOR UPDATE` statement that locks the permit row - one round
 * trip, one consistent instant) for the expiry decision - never the
 * application server's own clock (`new Date()`/`Date.now()`). The
 * backend process's clock can skew from the database's; only the
 * database's `now()` is what "authoritative time" means for a
 * midnight-sensitive authorization decision (SECURITY.md "Time and
 * Enforcement Integrity"). This mirrors exactly how
 * `croFallbackApprove` below already computes its own time-gated
 * eligibility (`now() >= hse_review_deadline_at`) inside the query
 * itself rather than in application code.
 */
export async function resumePermit(
  actorUserId: string,
  permitId: string,
  input: ResumeInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<ResumeOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow & { db_now: string }>(
      'SELECT p.*, now() AS db_now FROM permits p WHERE p.id = $1 FOR UPDATE',
      [permitId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'HELD') return { outcome: 'conflict', reason: 'not_held' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    // permits_issued_at_consistent guarantees issued_at is set for HELD.
    if (!isPermitValid(new Date(existing.issued_at as string), existing.site_timezone, new Date(existing.db_now))) {
      return { outcome: 'expired' };
    }

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'ISSUED', held_by = NULL, held_at = NULL, hold_reason = NULL, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [permitId, 'RESUMED', actorUserId, 'HELD', 'ISSUED'],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitResumed(client.query.bind(client), { permit, jsa, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

export interface CancelInput {
  expectedVersion: number;
  reason?: string | undefined;
}

export type CancelOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_cancellable' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

const CANCELLABLE_STATUSES: readonly PermitStatus[] = ['ISSUED', 'HELD'];

/**
 * CRO Cancel: ISSUED or HELD -> CANCELLED, permanently ("Only CRO may
 * cancel AFTER issuance. Allowed source states: ISSUED, HELD" - this
 * batch's Cancel rules, resolving DECISIONS.md's previously-open
 * decision #3). Every other permit-mutating function in this file only
 * applies to one specific non-CANCELLED status and rejects anything
 * else as a conflict, so a CANCELLED permit is already unreachable
 * through every one of those paths, including a second call to this
 * one - immutability falls directly out of those existing per-function
 * status checks, the same way CLOSED's immutability already does
 * (see `closePermit`'s doc comment), without any additional mechanism.
 * `cancel_reason` is optional - not documented as mandatory.
 */
export async function cancelPermit(
  actorUserId: string,
  permitId: string,
  input: CancelInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<CancelOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (!CANCELLABLE_STATUSES.includes(existing.status)) return { outcome: 'conflict', reason: 'not_cancellable' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const fromStatus = existing.status;
    const reason = input.reason ?? null;

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'CANCELLED',
              cancelled_by = $2,
              cancelled_at = now(),
              cancel_reason = $3,
              held_by = NULL,
              held_at = NULL,
              hold_reason = NULL,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId, actorUserId, reason],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [permitId, 'CANCELLED', actorUserId, fromStatus, 'CANCELLED', reason],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitCancelled(client.query.bind(client), { permit, jsa, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

/**
 * The lifecycle event type recorded for the ISSUED -> CLOSED transition.
 * Named as its own constant, rather than an inline literal in
 * `closePermit` below, so the event name itself ("CLOSED", per the
 * currently documented lifecycle naming) can be revised later without
 * touching the transition/workflow logic that decides *when* a permit is
 * closed.
 */
export const PERMIT_CLOSED_EVENT_TYPE = 'CLOSED';

export interface CloseInput {
  expectedVersion: number;
  closureRemarks?: string | undefined;
}

export type CloseOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_closable' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

const CLOSABLE_STATUSES: readonly PermitStatus[] = ['ISSUED', 'HELD'];

/**
 * Closure: ISSUED -> CLOSED, or HELD -> CLOSED ("CRO may close a HELD
 * permit. Allowed: before midnight, after midnight" - this batch's
 * Close-HELD rule, added alongside the original ISSUED -> CLOSED path;
 * "Only CRO closes a permit" - WORKFLOW.md; there is no creator closure
 * request or creator final closure step, and no two-stage closure
 * workflow). Same no-ownership-scoping as the other CRO/HSE review
 * actions above (CRO closes permits it did not create); `permit.close`
 * (already-seeded capability) is the sole authorization gate, backed by
 * the row lock + status/version check. No time-of-day gate at all -
 * closing a HELD permit is allowed both before and after its midnight
 * expiry, unlike Resume, which is time-gated.
 *
 * `closed_by` is always `actorUserId` (the authenticated actor) and
 * `closed_at` is always the database's own `now()` - the caller has no
 * way to supply either (see `CloseInput`, which only accepts the
 * expected version and optional remarks); this is what makes spoofing
 * either one impossible, not any extra validation. Closing FROM held
 * also clears `held_by`/`held_at`/`hold_reason` (permits_hold_consistent
 * requires them NULL once status is no longer HELD) - the full hold
 * history remains in permit_lifecycle_events regardless.
 *
 * Whether closure remarks must be mandatory is unresolved (DECISIONS.md);
 * `closureRemarks` is stored as-is when provided and left NULL
 * otherwise - no rule here requires it to be non-empty.
 *
 * Every other permit-mutating function above already only applies to one
 * or two specific source `status` values and rejects anything else as a
 * conflict, so a CLOSED permit is already unreachable through every one
 * of those paths, including a second call to this function -
 * immutability of a closed permit falls directly out of that existing
 * per-function status check, without any additional mechanism.
 */
export async function closePermit(
  actorUserId: string,
  permitId: string,
  input: CloseInput,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<CloseOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow>('SELECT * FROM permits WHERE id = $1 FOR UPDATE', [
      permitId,
    ]);
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (!CLOSABLE_STATUSES.includes(existing.status)) return { outcome: 'conflict', reason: 'not_closable' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const fromStatus = existing.status;
    const closureRemarks = input.closureRemarks ?? null;

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'CLOSED',
              closed_by = $2,
              closed_at = now(),
              closure_remarks = $3,
              held_by = NULL,
              held_at = NULL,
              hold_reason = NULL,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId, actorUserId, closureRemarks],
    );
    const permit = requireRow(updateResult.rows);

    const eventResult = await client.query<{ id: string }>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [permitId, PERMIT_CLOSED_EVENT_TYPE, actorUserId, fromStatus, 'CLOSED', closureRemarks],
    );
    const sourceEventId = requireRow(eventResult.rows).id;
    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);
    await onPermitClosed(client.query.bind(client), { permit, jsa, sourceEventId });

    return { outcome: 'ok', permit };
  });
}

export type RenewOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; reason: 'not_closed' | 'not_yet_expired' | 'already_renewed' }
  | { outcome: 'ok'; permit: PermitRow; jsa: JsaRow };

/**
 * Renewal: creates a brand-new permit record linked to (not a mutation
 * of) the given, already-CLOSED permit ("Previous permit MUST be CLOSED
 * first... Renewal creates a NEW permit record" - this batch's Renewal
 * rules, resolving DECISIONS.md's previously-open decision #7). Requires
 * the OLD permit's own midnight expiry to have genuinely passed
 * (`isPermitValid` on ITS `issued_at`/`site_timezone`, using
 * DATABASE-authoritative time - see `resumePermit`'s doc comment for why
 * this must never be the application server's own clock) - regardless
 * of when it happened to be closed, since closing before vs. after
 * midnight doesn't change when renewal becomes allowed ("If a held
 * permit reaches midnight and work must continue: CRO closes it first,
 * then renews it").
 *
 * The new permit: gets a brand-new Permit Number (via the same
 * `permit_number_seq` DEFAULT every other permit insert uses - atomic/
 * unique/concurrency-safe, nothing new here); reuses the SAME `jsa_id`
 * (same JSA row, same JSA Number - never a new JSA, never a JSA edit);
 * carries over `created_by`/`company`/`company_other`/`site_timezone`
 * from the old permit (the same underlying applicant/work/site
 * continuing, not a new submission); is created directly as `ISSUED`
 * with a fresh `issued_at = now()` (its own new midnight boundary); and
 * has NO HSE review window at all (`hse_review_started_at`/
 * `hse_review_deadline_at` both NULL - "NO CRO review, NO HSE review, NO
 * 5-minute timer for renewal", allowed by
 * `permits_hse_window_status_consistent`'s renewal carve-out). The OLD
 * permit is never written to by this function at all - not even its
 * `version` - it stays exactly as it was ("Old permit remains CLOSED and
 * immutable").
 *
 * Concurrency: two concurrent renewal attempts on the SAME old permit
 * cannot both succeed. The `FOR UPDATE` lock on the old permit
 * serializes the two attempts, but - because the old row is never
 * written to - the lock alone can't tell the second attempt "this was
 * already renewed"; that guarantee comes from
 * `permits_previous_permit_id_unique` (a partial unique index on
 * `previous_permit_id`, migration 0012): the second transaction's INSERT
 * violates it and is caught here as `{ outcome: 'conflict', reason:
 * 'already_renewed' }`, never an uncaught 500.
 */
export async function renewPermit(
  actorUserId: string,
  oldPermitId: string,
  deps: PermitsServiceDeps = defaultDeps,
): Promise<RenewOutcome> {
  return deps.withTransaction(async (client) => {
    const existingResult = await client.query<PermitRow & { db_now: string }>(
      'SELECT p.*, now() AS db_now FROM permits p WHERE p.id = $1 FOR UPDATE',
      [oldPermitId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return { outcome: 'not_found' };
    if (existing.status !== 'CLOSED') return { outcome: 'conflict', reason: 'not_closed' };

    // permits_issued_at_consistent guarantees issued_at is set for CLOSED.
    if (isPermitValid(new Date(existing.issued_at as string), existing.site_timezone, new Date(existing.db_now))) {
      return { outcome: 'conflict', reason: 'not_yet_expired' };
    }

    let permit: PermitRow;
    try {
      const insertResult = await client.query<PermitRow>(
        `INSERT INTO permits (
           jsa_id, created_by, previous_permit_id, site_timezone, company, company_other,
           status, issued_at, hse_review_started_at, hse_review_deadline_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'ISSUED', now(), NULL, NULL)
         RETURNING *`,
        [existing.jsa_id, existing.created_by, existing.id, existing.site_timezone, existing.company, existing.company_other],
      );
      permit = requireRow(insertResult.rows);
    } catch (err) {
      if (isUniqueViolation(err, 'permits_previous_permit_id_unique')) {
        return { outcome: 'conflict', reason: 'already_renewed' };
      }
      throw err;
    }

    const eventResult = await client.query<IssuanceEventMetadata>(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, event_type, actor_user_id, occurred_at, now() AS snapshot_taken_at`,
      [permit.id, 'RENEWED', actorUserId, null, 'ISSUED'],
    );
    const issuanceEvent = requireRow(eventResult.rows);

    const jsaResult = await client.query<JsaRow>('SELECT * FROM jsas WHERE id = $1', [permit.jsa_id]);
    const jsa = requireRow(jsaResult.rows);

    await onPermitRenewed(client.query.bind(client), { newPermit: permit, oldPermit: existing, jsa, issuanceEvent });

    return { outcome: 'ok', permit, jsa };
  });
}
