import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { supabase } from '../lib/supabase.js';

/**
 * Exercises the REAL Express app/router over actual HTTP requests - see
 * routes/permits.test.ts's doc comment for the general pattern (only
 * Supabase token verification and `Pool.prototype.query` are stubbed).
 */

const VALID_TOKEN = 'notif-route-test-valid-token';
const AUTHENTICATED_USER_ID = 'notif-route-test-user-id';

let mockNotificationRows: Record<string, unknown>[] = [];
let mockMarkReadRow: Record<string, unknown> | null = null;
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

function makeNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    recipient_user_id: AUTHENTICATED_USER_ID,
    permit_id: '22222222-2222-2222-2222-222222222222',
    source_event_id: '33333333-3333-3333-3333-333333333333',
    notification_type: 'PERMIT_ISSUED',
    title: 'Permit issued',
    message: 'Permit 1 was issued.',
    created_at: '2026-01-01T00:00:00.000Z',
    read_at: null,
    ...overrides,
  };
}

const originalGetClaims = supabase.auth.getClaims;
const originalPoolQuery = Pool.prototype.query;

before(() => {
  supabase.auth.getClaims = (async (token: string) => {
    if (token !== VALID_TOKEN) return { data: null, error: new Error('invalid token') };
    return { data: { claims: { sub: AUTHENTICATED_USER_ID, email: null } }, error: null };
  }) as typeof supabase.auth.getClaims;

  Pool.prototype.query = (async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).trim();
    capturedQueries.push({ sql, params });

    if (sql.includes('FROM app_user_access')) return { rows: [{ state: 'ACTIVE', must_change_password: false }] };

    if (sql.startsWith('SELECT * FROM notifications WHERE recipient_user_id')) {
      return { rows: mockNotificationRows };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM notifications WHERE recipient_user_id')) {
      return { rows: [{ count: String(mockNotificationRows.length) }] };
    }
    if (sql.startsWith('SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2')) {
      const [id, recipientUserId] = params as [string, string];
      if (mockMarkReadRow && mockMarkReadRow.id === id && mockMarkReadRow.recipient_user_id === recipientUserId) {
        return { rows: [mockMarkReadRow] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE notifications SET read_at')) {
      const [id, recipientUserId] = params as [string, string];
      if (mockMarkReadRow && mockMarkReadRow.id === id && mockMarkReadRow.recipient_user_id === recipientUserId) {
        return { rows: [{ ...mockMarkReadRow, read_at: '2026-01-02T00:00:00.000Z' }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query;
});

after(() => {
  supabase.auth.getClaims = originalGetClaims;
  Pool.prototype.query = originalPoolQuery;
});

beforeEach(() => {
  mockNotificationRows = [];
  mockMarkReadRow = null;
  capturedQueries = [];
});

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function getRequest(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'GET', headers });
}

function postRequest(url: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/api/v1${path}`, { method: 'POST', headers });
}

test('GET /notifications denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await getRequest(url, '/notifications')).status, 401);
  } finally {
    await close();
  }
});

test('GET /notifications returns the caller\'s own notifications, scoped by their own id', async () => {
  mockNotificationRows = [makeNotification()];
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/notifications', VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { notifications: unknown[]; pagination: { totalCount: number } };
    assert.equal(body.notifications.length, 1);
    assert.ok(capturedQueries.some((q) => q.params[0] === AUTHENTICATED_USER_ID));
  } finally {
    await close();
  }
});

test('GET /notifications?unread=true adds the unread filter to the query', async () => {
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/notifications?unread=true', VALID_TOKEN);
    assert.equal(res.status, 200);
    assert.ok(capturedQueries.some((q) => q.sql.includes('read_at IS NULL')));
  } finally {
    await close();
  }
});

test('GET /notifications rejects an invalid pageSize (400)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await getRequest(url, '/notifications?pageSize=99999', VALID_TOKEN);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('POST /notifications/:id/read denies an unauthenticated request (401)', async () => {
  const { url, close } = await startServer();
  try {
    assert.equal((await postRequest(url, '/notifications/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/read')).status, 401);
  } finally {
    await close();
  }
});

test('POST /notifications/:id/read marks the caller\'s own notification read', async () => {
  mockMarkReadRow = makeNotification({ recipient_user_id: AUTHENTICATED_USER_ID });
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, `/notifications/${mockMarkReadRow.id}/read`, VALID_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { notification: { read_at: string | null } };
    assert.ok(body.notification.read_at);
  } finally {
    await close();
  }
});

test('POST /notifications/:id/read returns 404 (not 403) for another user\'s notification - IDOR-safe', async () => {
  mockMarkReadRow = makeNotification({ recipient_user_id: 'someone-else' });
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, `/notifications/${mockMarkReadRow.id}/read`, VALID_TOKEN);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /notifications/:id/read returns 404 for a nonexistent notification', async () => {
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, '/notifications/00000000-0000-0000-0000-000000000000/read', VALID_TOKEN);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /notifications/:id/read rejects a non-UUID id (400)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await postRequest(url, '/notifications/not-a-uuid/read', VALID_TOKEN);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
