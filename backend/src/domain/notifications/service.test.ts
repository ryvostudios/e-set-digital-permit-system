import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNotification,
  listNotifications,
  markNotificationRead,
  notifyRecipients,
  type NotificationRow,
  type NotificationsServiceDeps,
} from './service.js';

/**
 * A minimal in-memory stand-in for the `notifications` table - just
 * enough to exercise `service.ts`'s own SQL shapes (idempotent insert,
 * recipient-scoped read/update) without a live database. Mirrors the
 * exact conflict/authorization semantics migration 0013 enforces at the
 * database level (the UNIQUE(source_event_id, recipient_user_id)
 * constraint, and recipient-only visibility), so a bug in `service.ts`
 * would fail here the same way it would against real Postgres.
 */
class FakeNotificationsDb {
  rows: NotificationRow[] = [];
  private counter = 0;

  deps(): NotificationsServiceDeps {
    const query = (async (text: string, params: unknown[] = []) => {
      const sql = text.trim();

      if (sql.startsWith('INSERT INTO notifications')) {
        const [recipientUserId, permitId, sourceEventId, notificationType, title, message] = params as [
          string,
          string | null,
          string,
          string,
          string,
          string,
        ];
        const conflict = this.rows.some(
          (r) => r.source_event_id === sourceEventId && r.recipient_user_id === recipientUserId,
        );
        if (conflict) return { rows: [] };
        this.counter += 1;
        const row: NotificationRow = {
          id: `notification-${this.counter}`,
          recipient_user_id: recipientUserId,
          permit_id: permitId,
          source_event_id: sourceEventId,
          notification_type: notificationType,
          title,
          message,
          created_at: new Date(2026, 0, 1, 0, 0, this.counter).toISOString(),
          read_at: null,
        };
        this.rows.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2')) {
        const [id, recipientUserId] = params as [string, string];
        const row = this.rows.find((r) => r.id === id && r.recipient_user_id === recipientUserId);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE notifications SET read_at')) {
        const [id, recipientUserId] = params as [string, string];
        const index = this.rows.findIndex((r) => r.id === id && r.recipient_user_id === recipientUserId);
        if (index === -1) return { rows: [] };
        this.rows[index] = { ...this.rows[index]!, read_at: '2026-01-02T00:00:00.000Z' };
        return { rows: [this.rows[index]!] };
      }
      if (sql.startsWith('SELECT * FROM notifications WHERE recipient_user_id')) {
        const [recipientUserId, pageSize, offset] = params as [string, number, number];
        const unreadOnly = sql.includes('read_at IS NULL');
        const rows = this.rows
          .filter((r) => r.recipient_user_id === recipientUserId && (!unreadOnly || r.read_at === null))
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
          .slice(offset, offset + pageSize);
        return { rows };
      }
      if (sql.startsWith('SELECT COUNT(*)::text AS count FROM notifications WHERE recipient_user_id')) {
        const [recipientUserId] = params as [string];
        const unreadOnly = sql.includes('read_at IS NULL');
        const count = this.rows.filter(
          (r) => r.recipient_user_id === recipientUserId && (!unreadOnly || r.read_at === null),
        ).length;
        return { rows: [{ count: String(count) }] };
      }

      throw new Error(`FakeNotificationsDb: unhandled query: ${sql}`);
    }) as NotificationsServiceDeps['query'];
    return { query };
  }
}

test('createNotification inserts a new row', async () => {
  const db = new FakeNotificationsDb();
  const notification = await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: 'permit-1',
    sourceEventId: 'event-1',
    notificationType: 'PERMIT_ISSUED',
    title: 'Permit issued',
    message: 'Permit 1 was issued.',
  });
  assert.ok(notification);
  assert.equal(notification?.recipient_user_id, 'user-1');
  assert.equal(notification?.read_at, null);
});

test('createNotification is idempotent for the same (source_event_id, recipient) pair - a retried/racing call never creates a duplicate', async () => {
  const db = new FakeNotificationsDb();
  const input = {
    recipientUserId: 'user-1',
    permitId: 'permit-1',
    sourceEventId: 'event-1',
    notificationType: 'PERMIT_ISSUED',
    title: 'Permit issued',
    message: 'Permit 1 was issued.',
  };
  const first = await createNotification(db.deps().query, input);
  const second = await createNotification(db.deps().query, input);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(db.rows.length, 1);
});

test('notifyRecipients de-duplicates recipients before creating notifications - a user with multiple assignments is notified once', async () => {
  const db = new FakeNotificationsDb();
  await notifyRecipients(db.deps().query, ['cro-1', 'cro-2', 'cro-1', 'cro-2', 'cro-1'], {
    permitId: 'permit-1',
    sourceEventId: 'event-1',
    notificationType: 'PERMIT_SUBMITTED',
    title: 'Permit submitted',
    message: 'Permit 1 was submitted.',
  });
  assert.equal(db.rows.length, 2);
  assert.deepEqual(
    db.rows.map((r) => r.recipient_user_id).sort(),
    ['cro-1', 'cro-2'],
  );
});

test('listNotifications only returns the caller\'s own notifications - never another recipient\'s', async () => {
  const db = new FakeNotificationsDb();
  await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: null,
    sourceEventId: 'event-1',
    notificationType: 'X',
    title: 'a',
    message: 'a',
  });
  await createNotification(db.deps().query, {
    recipientUserId: 'user-2',
    permitId: null,
    sourceEventId: 'event-2',
    notificationType: 'X',
    title: 'b',
    message: 'b',
  });

  const page = await listNotifications('user-1', { page: 1, pageSize: 20 }, {}, db.deps());
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.recipient_user_id, 'user-1');
});

test('listNotifications: unreadOnly excludes already-read notifications', async () => {
  const db = new FakeNotificationsDb();
  await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: null,
    sourceEventId: 'event-1',
    notificationType: 'X',
    title: 'a',
    message: 'a',
  });
  const second = await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: null,
    sourceEventId: 'event-2',
    notificationType: 'X',
    title: 'b',
    message: 'b',
  });
  assert.ok(second);
  await markNotificationRead('user-1', second.id, db.deps());

  const unread = await listNotifications('user-1', { page: 1, pageSize: 20 }, { unreadOnly: true }, db.deps());
  assert.equal(unread.items.length, 1);
  assert.equal(unread.items[0]?.source_event_id, 'event-1');

  const all = await listNotifications('user-1', { page: 1, pageSize: 20 }, {}, db.deps());
  assert.equal(all.items.length, 2);
});

test('listNotifications: pagination is bounded and totalCount reflects the same scope as the returned rows', async () => {
  const db = new FakeNotificationsDb();
  for (let i = 0; i < 5; i += 1) {
    await createNotification(db.deps().query, {
      recipientUserId: 'user-1',
      permitId: null,
      sourceEventId: `event-${i}`,
      notificationType: 'X',
      title: `n${i}`,
      message: `n${i}`,
    });
  }
  const page = await listNotifications('user-1', { page: 1, pageSize: 2 }, {}, db.deps());
  assert.equal(page.items.length, 2);
  assert.equal(page.totalCount, 5);
  assert.equal(page.totalPages, 3);
  assert.equal(page.hasNextPage, true);
});

test('markNotificationRead: only the recipient can mark their own notification read - a different user gets not_found (IDOR-safe)', async () => {
  const db = new FakeNotificationsDb();
  const created = await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: null,
    sourceEventId: 'event-1',
    notificationType: 'X',
    title: 'a',
    message: 'a',
  });
  assert.ok(created);

  const result = await markNotificationRead('someone-else', created.id, db.deps());
  assert.equal(result.outcome, 'not_found');
  assert.equal(db.rows[0]?.read_at, null);
});

test('markNotificationRead: a nonexistent notification id returns not_found', async () => {
  const db = new FakeNotificationsDb();
  const result = await markNotificationRead('user-1', 'no-such-id', db.deps());
  assert.equal(result.outcome, 'not_found');
});

test('markNotificationRead: is idempotent - marking an already-read notification read again succeeds and does not error', async () => {
  const db = new FakeNotificationsDb();
  const created = await createNotification(db.deps().query, {
    recipientUserId: 'user-1',
    permitId: null,
    sourceEventId: 'event-1',
    notificationType: 'X',
    title: 'a',
    message: 'a',
  });
  assert.ok(created);

  const first = await markNotificationRead('user-1', created.id, db.deps());
  const second = await markNotificationRead('user-1', created.id, db.deps());
  assert.equal(first.outcome, 'ok');
  assert.equal(second.outcome, 'ok');
  if (first.outcome === 'ok' && second.outcome === 'ok') {
    assert.equal(first.notification.read_at, second.notification.read_at);
  }
});
