import { Router, type Request, type Response } from 'express';
import { listNotifications, markNotificationRead, type NotificationRow } from '../domain/notifications/service.js';
import { notificationIdParamsSchema, notificationListQuerySchema } from '../domain/permits/validation.js';
import type { Page } from '../domain/permits/service.js';
import { requireAuth } from '../middleware/auth.js';
import { mutationLimiter } from '../middleware/rateLimit.js';

export const notificationsRouter = Router();

function serializeNotification(notification: NotificationRow) {
  return notification;
}

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

function getAuthenticatedUserId(req: Request, res: Response): string | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    return null;
  }
  return req.auth.id;
}

/**
 * The caller's OWN notifications, newest first - `recipient_user_id =
 * caller` is the sole scope (see
 * domain/notifications/service.ts::listNotifications), never anything
 * the request can widen - "only-recipient-can-view own notifications".
 * `?unread=true` returns only unread notifications; bounded pagination
 * matches every other list endpoint in this API.
 */
notificationsRouter.get('/notifications', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const parsed = notificationListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  const page = await listNotifications(
    userId,
    { page: parsed.data.page, pageSize: parsed.data.pageSize },
    { unreadOnly: parsed.data.unread === 'true' },
  );
  res.status(200).json({ notifications: page.items.map(serializeNotification), pagination: serializePagination(page) });
});

/**
 * Marks ONE of the caller's own notifications read. `recipient_user_id =
 * caller` is the sole authorization gate (see
 * domain/notifications/service.ts::markNotificationRead) - a
 * notification belonging to another user responds identically to a
 * nonexistent one (404, never 403), the same IDOR-safe pattern every
 * other object-access check in this API already follows - "caller
 * cannot mark another user's notification read".
 */
notificationsRouter.post(
  '/notifications/:id/read',
  requireAuth,
  mutationLimiter,
  async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const params = notificationIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error.issues);
      return;
    }

    const result = await markNotificationRead(userId, params.data.id);
    if (result.outcome === 'not_found') {
      res.status(404).json({ error: 'not_found', message: 'Notification not found' });
      return;
    }
    res.status(200).json({ notification: serializeNotification(result.notification) });
  },
);
