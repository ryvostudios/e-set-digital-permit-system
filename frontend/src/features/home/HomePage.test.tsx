import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ceo,
  croEmployee,
  emptyPagination,
  hseApprover,
  normalEmployee,
  permitSummary,
  siteManager,
} from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { HomePage } from './HomePage';

/**
 * The operational home screen.
 *
 * It must show what needs attention and NOTHING INVENTED - no statistic
 * the API does not return. It must also present each identity correctly:
 * a normal employee by Position and Company, a privileged account with no
 * organizational line at all.
 */

function quietBackend(overrides: Record<string, unknown> = {}) {
  return stubFetch({
    'GET /api/v1/permits/mine': {
      body: { permits: [], pagination: emptyPagination() },
    },
    'GET /api/v1/permits/queue': {
      body: { permits: [], pagination: emptyPagination() },
    },
    'GET /api/v1/notifications': {
      body: { notifications: [], pagination: emptyPagination() },
    },
    ...overrides,
  } as never);
}

describe('the greeting', () => {
  it('names a normal employee and shows their Position, Team, and Company', async () => {
    quietBackend();
    renderAs(<HomePage />, normalEmployee());

    expect(await screen.findByRole('heading', { level: 1, name: /good day, ali khan/i })).toBeInTheDocument();
    expect(screen.getByText(/Engineer · ZPL · ZPL/)).toBeInTheDocument();
  });

  it('greets a privileged account by name and adds NO account explanation', async () => {
    // A privileged account has no Company/Team/Position, so it simply has
    // no organizational line - the header is not filled with a
    // description of what the account is instead.
    quietBackend();
    renderAs(<HomePage />, ceo());

    expect(await screen.findByRole('heading', { level: 1, name: /good day, farhan aziz/i })).toBeInTheDocument();
    expect(screen.queryByText(/no company, team, or position/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/privileged system account/i)).not.toBeInTheDocument();
  });
});

describe('the applicant identity box', () => {
  // Removed from the home screen. The applicant identity is still frozen
  // server-side onto the permit when the workflow records it - it is
  // simply not previewed here, for any role.
  const actors = [
    ['a normal employee', normalEmployee],
    ['the CEO', ceo],
    ['a Site Manager', siteManager],
    ['a CRO', croEmployee],
  ] as const;

  for (const [label, actor] of actors) {
    it('is not shown to ' + label, async () => {
      quietBackend();
      renderAs(<HomePage />, actor());
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByText(/your recorded applicant identity/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/of Company/i)).not.toBeInTheDocument();
    });
  }
});

describe('what each role sees', () => {
  it('shows a CRO their review queue', async () => {
    const { calls } = quietBackend();
    renderAs(<HomePage />, croEmployee());

    expect(await screen.findByText(/awaiting your cro review/i)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.url.includes('status=PENDING_CRO'))).toBe(true));
  });

  it('shows an HSE approver their queue', async () => {
    const { calls } = quietBackend();
    renderAs(<HomePage />, hseApprover());

    expect(await screen.findByText(/awaiting your hse approval/i)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.url.includes('status=PENDING_HSE'))).toBe(true));
  });

  it('shows an ordinary employee neither queue', async () => {
    const { calls } = quietBackend();
    renderAs(<HomePage />, normalEmployee());

    await screen.findByRole('heading', { level: 1, name: /good day/i });
    expect(screen.queryByText(/awaiting your cro review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting your hse approval/i)).not.toBeInTheDocument();
    // The queue endpoint is not called at all.
    expect(calls.every((call) => !call.url.includes('/permits/queue'))).toBe(true);
  });

  it('shows administration shortcuts to a privileged manager', async () => {
    quietBackend();
    renderAs(<HomePage />, siteManager());

    expect(await screen.findByRole('link', { name: /^employees$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add employee/i })).toBeInTheDocument();
    // Site Manager administration is CEO-only.
    expect(screen.queryByRole('link', { name: /site managers/i })).not.toBeInTheDocument();
  });

  it('shows the CEO the Site Manager shortcut as well', async () => {
    quietBackend();
    renderAs(<HomePage />, ceo());
    expect(await screen.findByRole('link', { name: /site managers/i })).toBeInTheDocument();
  });

  it('shows an ordinary employee no administration shortcuts', async () => {
    quietBackend();
    renderAs(<HomePage />, normalEmployee());
    await screen.findByRole('heading', { level: 1, name: /good day/i });
    expect(screen.queryByRole('link', { name: /^employees$/i })).not.toBeInTheDocument();
  });
});

describe('statistics', () => {
  it('shows only the queue depth the paginated endpoint itself reports', async () => {
    quietBackend({
      'GET /api/v1/permits/queue': {
        body: {
          permits: [permitSummary({ status: 'PENDING_CRO' })],
          pagination: emptyPagination({ totalCount: 12, totalPages: 3 }),
        },
      },
    });
    renderAs(<HomePage />, croEmployee());

    expect(await screen.findByText(/12 awaiting review/i)).toBeInTheDocument();
  });

  it('invents no other figure - no chart, no score, no throughput', async () => {
    quietBackend();
    renderAs(<HomePage />, croEmployee());
    await screen.findByRole('heading', { level: 1, name: /good day/i });

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/compliance score|throughput|average time|this month|trend/i);
    expect(document.querySelector('canvas')).toBeNull();
  });
});

describe('a role with neither application nor review authority', () => {
  it('is told so plainly rather than shown an empty dashboard', async () => {
    quietBackend();
    renderAs(<HomePage />, normalEmployee({ capabilities: [] }));

    expect(await screen.findByText(/does not currently include raising or reviewing permits/i)).toBeInTheDocument();
  });
});
