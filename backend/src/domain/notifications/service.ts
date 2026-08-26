import { query, type QueryFn } from '../../db/pool.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGINATION_OFFSET } from '../permits/validation.js';
import type { Page, PageParams } from '../permits/service.js';

export interface NotificationRow {
  id: string;
  recipient_user_id: string;
  permit_id: string | null;
  source_event_id: string;
  notification_type: string;
  title: string;
  message: string;
  created_at: string;
  read_at: string | null;
}

/** Injectable so this module can be unit tested without a live database - mirrors `domain/permits/service.ts::PermitsServiceDeps`. */
export interface NotificationsServiceDeps {
  query: QueryFn;
}

const defaultDeps: NotificationsServiceDeps = { query };

export interface CreateNotificationInput {
  recipientUserId: string;
  /** Nullable - see the doc comment on `notifications.permit_id` (migration 0013). Always set for every workflow notification this batch creates. */
  permitId: string | null;
  sourceEventId: string;
  notificationType: string;
  title: string;
  message: string;
}

/**
 * Inserts one notification. Idempotent via
 * `notifications_source_event_recipient_unique` (migration 0013) - a
 * retried/racing call for the SAME (event, recipient) pair is silently
 * absorbed (`ON CONFLICT ... DO NOTHING`), never a duplicate row and
 * never a thrown unique-violation the caller has to handle. Returns null
 * on that conflict path (nothing was inserted); returns the inserted row
 * otherwise.
 */
export async function createNotification(queryFn: QueryFn, input: CreateNotificationInput): Promise<NotificationRow | null> {
  const result = await queryFn<NotificationRow>(
    `INSERT INTO notifications (recipient_user_id, permit_id, source_event_id, notification_type, title, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_event_id, recipient_user_id) DO NOTHING
     RETURNING *`,
    [input.recipientUserId, input.permitId, input.sourceEventId, input.notificationType, input.title, input.message],
  );
  return result.rows[0] ?? null;
}

/**
 * Fans a single notification out to every id in `recipientUserIds`,
 * de-duplicating first - "avoid duplicate recipients where a user has
 * multiple [Team + Position] assignments" (this batch's notifications
 * requirement). Combined with `createNotification`'s own idempotency,
 * this is safe to call more than once for the same underlying event
 * (e.g. a caller retrying after a partial failure) without ever
 * producing two notifications for the same recipient about the same
 * event.
 */
export async function notifyRecipients(
  queryFn: QueryFn,
  recipientUserIds: readonly string[],
  input: Omit<CreateNotificationInput, 'recipientUserId'>,
): Promise<void> {
  const uniqueRecipients = [...new Set(recipientUserIds)];
  for (const recipientUserId of uniqueRecipients) {
    await createNotification(queryFn, { ...input, recipientUserId });
  }
}

/** Mirrors `domain/permits/service.ts::toPage` - same shape/math, kept local rather than shared since the two lists could independently evolve (matches this codebase's existing preference - see validation.ts's per-endpoint body schemas). */
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

/** Mirrors `domain/permits/service.ts::pageOffset` - re-derives every pagination invariant from scratch rather than trusting the route layer already validated it, for the same defense-in-depth reason. */
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

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
}

/**
 * `actorUserId`'s own notifications, newest first - scoped entirely by
 * `recipient_user_id = actorUserId` (never by anything the caller
 * supplies), so this can never return another user's notification -
 * "only-recipient-can-view/mark-own-notifications". `pageParams`
 * defaults match `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` used everywhere
 * else in the API, for the same bounded-result-set reason as
 * `listOwnPermits`.
 */
export async function listNotifications(
  actorUserId: string,
  pageParams: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  options: ListNotificationsOptions = {},
  deps: NotificationsServiceDeps = defaultDeps,
): Promise<Page<NotificationRow>> {
  const offset = pageOffset(pageParams);
  const unreadClause = options.unreadOnly ? 'AND read_at IS NULL' : '';
  const [rowsResult, countResult] = await Promise.all([
    deps.query<NotificationRow>(
      `SELECT * FROM notifications WHERE recipient_user_id = $1 ${unreadClause} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [actorUserId, pageParams.pageSize, offset],
    ),
    deps.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications WHERE recipient_user_id = $1 ${unreadClause}`,
      [actorUserId],
    ),
  ]);
  return toPage(rowsResult.rows, pageParams, Number(countResult.rows[0]?.count ?? '0'));
}

export type MarkNotificationReadOutcome = { outcome: 'not_found' } | { outcome: 'ok'; notification: NotificationRow };

/**
 * Marks one of `actorUserId`'s OWN notifications read.
 * `recipient_user_id = actorUserId` in both the lookup and the update is
 * the sole authorization gate - a notification that exists but belongs
 * to someone else responds identically to a nonexistent one (not_found),
 * the same existence-hiding IDOR precaution every other object-access
 * check in this codebase already follows (see
 * domain/permits/service.ts::getOwnPermit). Idempotent: re-marking an
 * already-read notification returns it unchanged rather than erroring or
 * re-stamping `read_at`.
 */
export async function markNotificationRead(
  actorUserId: string,
  notificationId: string,
  deps: NotificationsServiceDeps = defaultDeps,
): Promise<MarkNotificationReadOutcome> {
  const existingResult = await deps.query<NotificationRow>(
    'SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2',
    [notificationId, actorUserId],
  );
  const existing = existingResult.rows[0];
  if (!existing) return { outcome: 'not_found' };
  if (existing.read_at !== null) return { outcome: 'ok', notification: existing };

  const updateResult = await deps.query<NotificationRow>(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND recipient_user_id = $2 RETURNING *',
    [notificationId, actorUserId],
  );
  const updated = updateResult.rows[0];
  if (!updated) return { outcome: 'not_found' };
  return { outcome: 'ok', notification: updated };
}
