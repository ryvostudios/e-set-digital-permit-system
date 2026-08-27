import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyPagination, normalEmployee } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { NotificationsPage } from './NotificationsPage';

/**
 * Notifications.
 *
 * The rule with teeth: A NOTIFICATION IS NOT AN AUTHORIZATION. Following
 * a permit link makes an ordinary authorized request, and no token, id
 * shortcut, or other bypass travels with it.
 */

const NOTIFICATION = {
  id: 'notification-1',
  recipient_user_id: 'user-normal',
  permit_id: 'permit-1',
  source_event_id: 'event-1',
  notification_type: 'PERMIT_ISSUED',
  title: 'Permit 000001 issued',
  message: 'The permit has been issued.',
  created_at: '2026-08-20T10:00:00.000Z',
  read_at: null as string | null,
};

function listResponse(notifications: unknown[]) {
  return {
    body: {
      notifications,
      pagination: emptyPagination({ totalCount: notifications.length, totalPages: 1 }),
    },
  };
}

describe('the list', () => {
  it('opens on unread, and asks the server for unread only', async () => {
    const { calls } = stubFetch({ 'GET /api/v1/notifications': listResponse([NOTIFICATION]) });
    renderAs(<NotificationsPage />, normalEmployee());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toContain('unread=true');
    expect(await screen.findByText('Permit 000001 issued')).toBeInTheDocument();
  });

  it('marks unread notifications visibly, not by colour alone', async () => {
    stubFetch({ 'GET /api/v1/notifications': listResponse([NOTIFICATION]) });
    renderAs(<NotificationsPage />, normalEmployee());
    expect(await screen.findByText(/unread/i)).toBeInTheDocument();
  });

  it('switches to all notifications on request', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/v1/notifications': listResponse([NOTIFICATION]) });
    renderAs(<NotificationsPage />, normalEmployee());
    await screen.findByText('Permit 000001 issued');

    await user.click(screen.getByRole('tab', { name: /^all$/i }));

    await waitFor(() => expect(calls.some((call) => !call.url.includes('unread=true'))).toBe(true));
  });

  it('shows an explicit empty state', async () => {
    stubFetch({ 'GET /api/v1/notifications': listResponse([]) });
    renderAs(<NotificationsPage />, normalEmployee());
    expect(await screen.findByText(/no unread notifications/i)).toBeInTheDocument();
  });
});

describe('marking as read', () => {
  it('posts to the notification’s own endpoint and re-reads the list', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/notifications': listResponse([NOTIFICATION]),
      'POST /api/v1/notifications/notification-1/read': {
        body: { notification: { ...NOTIFICATION, read_at: '2026-08-20T11:00:00.000Z' } },
      },
    });
    renderAs(<NotificationsPage />, normalEmployee());

    await user.click(await screen.findByRole('button', { name: /mark as read/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('/read'))).toBe(true));
    await waitFor(() => {
      const reads = calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/v1/notifications?'));
      expect(reads.length).toBeGreaterThan(1);
    });
  });

  it('reports a 404 (someone else’s notification) without technical detail', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/v1/notifications': listResponse([NOTIFICATION]),
      'POST /api/v1/notifications/notification-1/read': { status: 404, body: { error: 'not_found' } },
    });
    renderAs(<NotificationsPage />, normalEmployee());

    await user.click(await screen.findByRole('button', { name: /mark as read/i }));
    expect(await screen.findByText(/that record is not available/i)).toBeInTheDocument();
  });
});

describe('permit links', () => {
  it('are offered only when the notification actually names a permit', async () => {
    stubFetch({ 'GET /api/v1/notifications': listResponse([{ ...NOTIFICATION, permit_id: null }]) });
    renderAs(<NotificationsPage />, normalEmployee());

    await screen.findByText('Permit 000001 issued');
    expect(screen.queryByRole('button', { name: /open permit/i })).not.toBeInTheDocument();
  });

  it('navigate normally - no token or bypass travels with the link', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/notifications': listResponse([NOTIFICATION]),
      'GET /api/v1/permits/permit-1': { status: 404, body: { error: 'not_found' } },
    });
    renderAs(<NotificationsPage />, normalEmployee());

    await user.click(await screen.findByRole('button', { name: /open permit/i }));

    // Whatever the permit screen then requests is an ordinary
    // authorized read; nothing about the notification widens it.
    for (const call of calls) {
      expect(call.url).not.toMatch(/token|signature|access_token|bypass/i);
    }
  });
});

describe('untrusted content', () => {
  it('renders a hostile title and message as TEXT, never as markup', async () => {
    stubFetch({
      'GET /api/v1/notifications': listResponse([
        {
          ...NOTIFICATION,
          title: '<img src=x onerror="window.__xss=1">',
          message: '<script>window.__xss=1</script>',
        },
      ]),
    });
    renderAs(<NotificationsPage />, normalEmployee());

    expect(await screen.findByText('<img src=x onerror="window.__xss=1">')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
