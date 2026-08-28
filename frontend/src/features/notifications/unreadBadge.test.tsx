import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import { emptyPagination, normalEmployee } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { AppShell } from '../../layout/AppShell';
import { NotificationsPage } from './NotificationsPage';

/**
 * THE UNREAD BADGE AND THE UNREAD LIST ARE ONE FACT.
 *
 * The list lives on this screen; the two badges (header and sidebar) are
 * drawn by `AppShell` from its own count request. Marking a notification
 * read used to re-read only the list, so the screen said "You have no
 * unread notifications" while both badges still read 2 - until a full
 * page load.
 *
 * These specs render the badges and the list TOGETHER, the way a person
 * actually sees them, and drive a stateful fake backend: marking read is
 * a real POST that sets `read_at`, and every subsequent read comes from
 * that same state. Nothing is asserted about local bookkeeping, so the
 * only way to pass is for the count to be re-read from the server.
 */

interface FakeNotification {
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

function notification(id: string, title: string): FakeNotification {
  return {
    id,
    recipient_user_id: 'user-normal',
    permit_id: null,
    source_event_id: `event-${id}`,
    notification_type: 'PERMIT_ISSUED',
    title,
    message: 'The permit moved.',
    created_at: '2026-08-20T10:00:00.000Z',
    read_at: null,
  };
}

/**
 * A backend that actually remembers. `read_at` is SET, never removed, so
 * these specs also prove no row is deleted: the All view keeps showing
 * everything after it has been read.
 */
function stubNotificationBackend(rows: FakeNotification[]) {
  const state = rows.map((row) => ({ ...row }));

  const routes: Record<string, (url: URL) => { body: unknown }> = {
    'GET /api/v1/notifications': (url) => {
      const unreadOnly = url.searchParams.get('unread') === 'true';
      const visible = unreadOnly ? state.filter((row) => row.read_at === null) : state;
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return {
        body: {
          // The count badge asks for pageSize=1 and reads only
          // `pagination.totalCount`, so the page slice must not change it.
          notifications: visible.slice(0, pageSize),
          pagination: emptyPagination({ totalCount: visible.length, totalPages: 1, pageSize }),
        },
      };
    },
  };

  for (const row of state) {
    routes[`POST /api/v1/notifications/${row.id}/read`] = () => {
      row.read_at = '2026-08-20T11:00:00.000Z';
      return { body: { notification: { ...row } } };
    };
  }

  return { state, ...stubFetch(routes as never) };
}

/** The notifications screen inside the real application frame, badges and all. */
function renderWithBadges(rows: FakeNotification[]) {
  const backend = stubNotificationBackend(rows);
  return {
    ...backend,
    ...renderAs(
      <Routes>
        <Route element={<AppShell />}>
          <Route path={ROUTES.notifications} element={<NotificationsPage />} />
        </Route>
      </Routes>,
      normalEmployee(),
      { route: ROUTES.notifications },
    ),
  };
}

/** The header bell's count, read from its accessible name. */
function headerBadgeCount(): number {
  const bell = screen.getByRole('button', { name: /^notifications/i });
  const match = /\((\d+) unread\)/.exec(bell.getAttribute('aria-label') ?? '');
  return match ? Number(match[1]) : 0;
}

/** The sidebar link's count bubble. */
function sidebarBadgeText(): string | null {
  const link = screen.getByRole('link', { name: /notifications/i });
  return link.querySelector('.nav__count')?.textContent ?? null;
}

async function markRead(title: string) {
  const user = userEvent.setup();
  const row = screen.getByText(title).closest('li');
  expect(row).not.toBeNull();
  await user.click(within(row as HTMLElement).getByRole('button', { name: /mark as read/i }));
}

const TWO = [notification('n-1', 'Permit 000001 issued'), notification('n-2', 'Permit 000002 issued')];

describe('the unread badge follows the unread list', () => {
  it('starts at 2 in both badges, matching two unread notifications', async () => {
    renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');

    await waitFor(() => expect(headerBadgeCount()).toBe(2));
    expect(sidebarBadgeText()).toBe('2');
    expect(screen.getByText('Permit 000002 issued')).toBeInTheDocument();
  });

  it('drops to 1 the moment one is marked read', async () => {
    renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(2));

    await markRead('Permit 000001 issued');

    await waitFor(() => expect(headerBadgeCount()).toBe(1));
    expect(sidebarBadgeText()).toBe('1');
    // The list agrees: the one still unread is the only one left.
    expect(screen.queryByText('Permit 000001 issued')).not.toBeInTheDocument();
    expect(screen.getByText('Permit 000002 issued')).toBeInTheDocument();
  });

  it('reaches 0 on the second, and both badges disappear', async () => {
    renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');

    await markRead('Permit 000001 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(1));

    await markRead('Permit 000002 issued');

    await waitFor(() => expect(headerBadgeCount()).toBe(0));
    // Not "0" rendered - gone.
    expect(sidebarBadgeText()).toBeNull();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('leaves the Unread view empty once everything is read', async () => {
    renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');

    await markRead('Permit 000001 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(1));
    await markRead('Permit 000002 issued');

    expect(await screen.findByText(/you have no unread notifications/i)).toBeInTheDocument();
    // ...and the badge is not still contradicting that message.
    expect(headerBadgeCount()).toBe(0);
    expect(sidebarBadgeText()).toBeNull();
  });

  it('keeps every notification in the All view - nothing is deleted', async () => {
    const user = userEvent.setup();
    const { state } = renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');

    await markRead('Permit 000001 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(1));
    await markRead('Permit 000002 issued');
    await screen.findByText(/you have no unread notifications/i);

    await user.click(screen.getByRole('tab', { name: /^all$/i }));

    expect(await screen.findByText('Permit 000001 issued')).toBeInTheDocument();
    expect(screen.getByText('Permit 000002 issued')).toBeInTheDocument();
    // Read, not removed: the rows still exist and carry a read timestamp.
    expect(state).toHaveLength(2);
    expect(state.every((row) => row.read_at !== null)).toBe(true);
    expect(screen.queryByRole('button', { name: /mark as read/i })).not.toBeInTheDocument();
  });

  it('re-reads the count from the server rather than adjusting it locally', async () => {
    const { calls } = renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');
    const before = calls.filter((call) => call.url.includes('unread=true')).length;

    await markRead('Permit 000001 issued');

    // A fresh unread request follows the mark-read, so the badge can
    // never drift from what the backend would say.
    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes('unread=true')).length).toBeGreaterThan(before),
    );
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/read'))).toBe(true);
  });

  it('is still correct after a reload of the whole frame', async () => {
    const { unmount } = renderWithBadges(TWO);
    await screen.findByText('Permit 000001 issued');
    await markRead('Permit 000001 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(1));
    unmount();

    // A page refresh: the frame mounts again and asks the server, which
    // still holds one unread.
    renderWithBadges([{ ...TWO[0]!, read_at: '2026-08-20T11:00:00.000Z' }, TWO[1]!]);
    await screen.findByText('Permit 000002 issued');
    await waitFor(() => expect(headerBadgeCount()).toBe(1));
    expect(sidebarBadgeText()).toBe('1');
  });
});
