import { query, type QueryFn } from '../../db/pool.js';
import { MAX_PAGE_SIZE, MAX_PAGINATION_OFFSET } from './validation.js';
import { permitSummaryColumns } from './service.js';
import type { PermitType } from './forms.js';
import type { Company, LifecycleEventRow, Page, PageParams, PermitSummaryRow, PermitStatus } from './service.js';

/** Mirrors `domain/permits/service.ts::toPage` - see that file's doc comment on why this is duplicated rather than shared. */
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

/** Mirrors `domain/permits/service.ts::pageOffset` - re-derives every pagination invariant independently rather than trusting the route layer already validated it (same defense-in-depth reasoning). */
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

export interface PermitSearchAccess {
  /** The caller - always included via `created_by = viewerId`, regardless of capabilities, matching every other read endpoint's ownership rule. */
  viewerId: string;
  /** Every status the caller's capabilities additionally grant non-owner visibility into - see `domain/permits/access.ts::computeViewableStatuses`. Never expanded "for search" beyond what that same function already grants for direct permit access. */
  allowedStatuses: readonly PermitStatus[];
  /** Current DB-backed individual/privileged broad visibility. */
  viewAll?: boolean | undefined;
}

export interface PermitSearchFilters {
  permitNumber?: number | undefined;
  jsaNumber?: number | undefined;
  status?: PermitStatus | undefined;
  company?: Company | undefined;
  permitType?: PermitType | undefined;
  createdBy?: string | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
}

/**
 * Builds the shared WHERE clause (and its bound params) used by BOTH the
 * rows query and the COUNT query below - the same object, not two
 * independently-written clauses - so "COUNT and result query must use
 * identical authorization scope" holds structurally, not by manual
 * discipline. The access predicate (`created_by = viewer OR status =
 * ANY(allowedStatuses)`) always comes first and is never conditional -
 * every other filter below only NARROWS within it, never widens it, so
 * a search can never surface a permit `canViewPermit` would deny.
 */
function buildSearchWhere(access: PermitSearchAccess, filters: PermitSearchFilters): { clause: string; params: unknown[] } {
  const params: unknown[] = [access.viewerId, access.allowedStatuses];
  let clause = access.viewAll ? 'TRUE' : '(p.created_by = $1 OR p.status = ANY($2))';

  if (filters.permitNumber !== undefined) {
    params.push(String(filters.permitNumber));
    clause += ` AND p.permit_sequence = $${params.length}`;
  }
  if (filters.jsaNumber !== undefined) {
    params.push(String(filters.jsaNumber));
    clause += ` AND j.jsa_sequence = $${params.length}`;
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    clause += ` AND p.status = $${params.length}`;
  }
  if (filters.company !== undefined) {
    params.push(filters.company);
    clause += ` AND p.company = $${params.length}`;
  }
  if (filters.permitType !== undefined) {
    params.push(filters.permitType);
    clause += ` AND p.permit_type = $${params.length}`;
  }
  if (filters.createdBy !== undefined) {
    params.push(filters.createdBy);
    clause += ` AND p.created_by = $${params.length}`;
  }
  if (filters.createdFrom !== undefined) {
    params.push(filters.createdFrom.toISOString());
    clause += ` AND p.created_at >= $${params.length}`;
  }
  if (filters.createdTo !== undefined) {
    params.push(filters.createdTo.toISOString());
    clause += ` AND p.created_at <= $${params.length}`;
  }

  return { clause, params };
}

/**
 * Permit search/filtering, scoped by the exact same access model as
 * every other permit read endpoint (`access.ts::canViewPermit` /
 * `STATUS_VIEW_CAPABILITIES`) - "a search must NEVER reveal a permit the
 * caller cannot normally view". Every filter is a parameterized,
 * strictly-typed value (never string-concatenated into SQL) - permit/JSA
 * number lookups by exact sequence match cannot be used to enumerate
 * permits outside the caller's own access, since the access predicate is
 * always ANDed in first, at the database level, not applied afterward.
 * Deterministic ordering (`created_at DESC, id DESC`) and
 * caller-independent bounded pagination match `listOwnPermits`/
 * `listPermitsByStatus`.
 */
export async function searchPermits(
  access: PermitSearchAccess,
  filters: PermitSearchFilters,
  pageParams: PageParams,
  deps: { query: QueryFn } = { query },
): Promise<Page<PermitSummaryRow>> {
  const offset = pageOffset(pageParams);
  const { clause, params } = buildSearchWhere(access, filters);

  // Search results are summaries: the permit-type-specific `form_payload`
  // is deliberately never selected here, so a search response can never
  // carry a full form payload per row (only permit detail does).
  const rowsResult = await deps.query<PermitSummaryRow>(
    `SELECT ${permitSummaryColumns('p')} FROM permits p JOIN jsas j ON j.id = p.jsa_id
      WHERE ${clause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageParams.pageSize, offset],
  );
  const countResult = await deps.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM permits p JOIN jsas j ON j.id = p.jsa_id WHERE ${clause}`,
    params,
  );

  return toPage(rowsResult.rows, pageParams, Number(countResult.rows[0]?.count ?? '0'));
}

export interface LifecycleEventSearchFilters {
  eventType?: string | undefined;
  actorUserId?: string | undefined;
  fromStatus?: string | undefined;
  toStatus?: string | undefined;
  occurredFrom?: Date | undefined;
  occurredTo?: Date | undefined;
}

/**
 * Filtered, paginated lifecycle/audit history for ONE already-authorized
 * permit - `permitId` is always fixed by the caller (route layer already
 * ran `getPermitById` + `canViewPermit` before this is ever called, same
 * as the unfiltered `getPermitLifecycleEvents`), so no separate access
 * predicate is needed here beyond that. READ ONLY: this file contains no
 * UPDATE/DELETE against `permit_lifecycle_events` - the table's own
 * append-only triggers (migration 0006) make that impossible regardless.
 * Deterministic chronological ordering (`ordinal ASC`, the table's own
 * true insertion order) is preserved under LIMIT/OFFSET exactly like the
 * unfiltered version.
 */
export async function searchPermitLifecycleEvents(
  permitId: string,
  filters: LifecycleEventSearchFilters,
  pageParams: PageParams,
  deps: { query: QueryFn } = { query },
): Promise<Page<LifecycleEventRow>> {
  const offset = pageOffset(pageParams);
  const params: unknown[] = [permitId];
  let clause = 'permit_id = $1';

  if (filters.eventType !== undefined) {
    params.push(filters.eventType);
    clause += ` AND event_type = $${params.length}`;
  }
  if (filters.actorUserId !== undefined) {
    params.push(filters.actorUserId);
    clause += ` AND actor_user_id = $${params.length}`;
  }
  if (filters.fromStatus !== undefined) {
    params.push(filters.fromStatus);
    clause += ` AND from_status = $${params.length}`;
  }
  if (filters.toStatus !== undefined) {
    params.push(filters.toStatus);
    clause += ` AND to_status = $${params.length}`;
  }
  if (filters.occurredFrom !== undefined) {
    params.push(filters.occurredFrom.toISOString());
    clause += ` AND occurred_at >= $${params.length}`;
  }
  if (filters.occurredTo !== undefined) {
    params.push(filters.occurredTo.toISOString());
    clause += ` AND occurred_at <= $${params.length}`;
  }

  const rowsResult = await deps.query<LifecycleEventRow>(
    `SELECT * FROM permit_lifecycle_events
      WHERE ${clause}
      ORDER BY ordinal ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageParams.pageSize, offset],
  );
  const countResult = await deps.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM permit_lifecycle_events WHERE ${clause}`,
    params,
  );

  return toPage(rowsResult.rows, pageParams, Number(countResult.rows[0]?.count ?? '0'));
}
