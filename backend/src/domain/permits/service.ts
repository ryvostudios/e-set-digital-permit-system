import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { MAX_PAGE_SIZE, MAX_PAGINATION_OFFSET } from './validation.js';

export type PermitStatus = 'DRAFT' | 'PENDING_CRO' | 'PENDING_HSE' | 'ISSUED' | 'CLOSED';
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
  | { outcome: 'conflict'; reason: 'not_draft' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * Updates a DRAFT permit's editable fields (currently just `company` /
 * `company_other` - the only field DECISIONS.md documents). Only applies
 * if the permit belongs to `actorUserId`, is still DRAFT, and
 * `expectedVersion` matches the current row version - otherwise it's a
 * conflict, never a silent overwrite (SECURITY.md). The read-then-write
 * happens under a row lock (`FOR UPDATE`) inside one transaction so the
 * check and the write are atomic even under concurrent requests.
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
    if (existing.status !== 'DRAFT') return { outcome: 'conflict', reason: 'not_draft' };
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
  return deps.withTransaction(async (client) => {
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

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [permitId, 'SUBMITTED', actorUserId, 'DRAFT', 'PENDING_CRO'],
    );

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
  return deps.withTransaction(async (client) => {
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

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [permitId, 'CRO_FORWARDED_HSE', actorUserId, 'PENDING_CRO', 'PENDING_HSE'],
    );

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

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [permitId, 'HSE_APPROVED', actorUserId, 'PENDING_HSE', 'ISSUED'],
    );

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

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [permitId, 'CRO_FALLBACK_APPROVED', actorUserId, 'PENDING_HSE', 'ISSUED'],
    );

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
  | { outcome: 'conflict'; reason: 'not_issued' | 'stale_version' }
  | { outcome: 'ok'; permit: PermitRow };

/**
 * The only implemented closure transition: ISSUED -> CLOSED ("Only CRO
 * closes a permit" - WORKFLOW.md; there is no creator closure request or
 * creator final closure step, and no two-stage closure workflow). Same
 * no-ownership-scoping as the other CRO/HSE review actions above (CRO
 * closes permits it did not create); `permit.close` (already-seeded
 * capability) is the sole authorization gate, backed by the row lock +
 * status/version check.
 *
 * `closed_by` is always `actorUserId` (the authenticated actor) and
 * `closed_at` is always the database's own `now()` - the caller has no
 * way to supply either (see `CloseInput`, which only accepts the
 * expected version and optional remarks); this is what makes spoofing
 * either one impossible, not any extra validation.
 *
 * Whether closure remarks must be mandatory is unresolved (DECISIONS.md);
 * `closureRemarks` is stored as-is when provided and left NULL
 * otherwise - no rule here requires it to be non-empty.
 *
 * Every other permit-mutating function above already only applies to one
 * specific `status` value (DRAFT/PENDING_CRO/PENDING_HSE) and rejects
 * anything else as a conflict, so a CLOSED permit is already unreachable
 * through every one of those paths, including a second call to this
 * function - immutability of a closed permit falls directly out of that
 * existing per-function status check, without any additional mechanism.
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
    if (existing.status !== 'ISSUED') return { outcome: 'conflict', reason: 'not_issued' };
    if (existing.version !== input.expectedVersion) return { outcome: 'conflict', reason: 'stale_version' };

    const closureRemarks = input.closureRemarks ?? null;

    const updateResult = await client.query<PermitRow>(
      `UPDATE permits
          SET status = 'CLOSED',
              closed_by = $2,
              closed_at = now(),
              closure_remarks = $3,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [permitId, actorUserId, closureRemarks],
    );
    const permit = requireRow(updateResult.rows);

    await client.query(
      `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [permitId, PERMIT_CLOSED_EVENT_TYPE, actorUserId, 'ISSUED', 'CLOSED', closureRemarks],
    );

    return { outcome: 'ok', permit };
  });
}
