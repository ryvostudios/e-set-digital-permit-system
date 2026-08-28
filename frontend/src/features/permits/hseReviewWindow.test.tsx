import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import type { AvailableAction, PermitDetailResponse } from '../../api/types';
import { croEmployee, hseApprover, jsa, normalEmployee, permit, permitDetail } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * THE HSE APPROVAL PRIORITY WINDOW, ON SCREEN.
 *
 * A CRO forwarding to HSE starts a five-minute window in which HSE alone
 * may act; after it, an authorized CRO may approve as a fallback too, and
 * the first successful approval issues the permit.
 *
 * Two things are being tested here, and only two - because only two are
 * the browser's business:
 *
 *   1. BOTH ROLES SEE THE SAME CLOCK, drawn from the server's deadline
 *      and the server's own time, never the device's.
 *   2. THE CONTROLS COME FROM THE SERVER. `availableActions` decides what
 *      is on screen; the countdown never grants or removes an action by
 *      itself. When it runs out the record is RE-READ, and whatever the
 *      server then offers is what appears.
 *
 * Every authorization decision is the backend's, and is proven there:
 * `service.test.ts` covers early rejection, the exact 4:59.999/5:00.000
 * boundary, and the one-winner race.
 */

const FORWARDED_AT = '2026-08-20T10:00:00.000Z';
const DEADLINE = '2026-08-20T10:05:00.000Z';

function pendingHse(options: {
  serverTime: string;
  actions: AvailableAction[];
  status?: 'PENDING_HSE' | 'ISSUED';
  deadline?: string | null;
}): PermitDetailResponse {
  const status = options.status ?? 'PENDING_HSE';
  return permitDetail({
    permit: permit({
      status,
      permit_type: 'HOT_WORK',
      permit_sequence: '3',
      permitDisplayNumber: 'HW-3',
      hse_review_started_at: status === 'PENDING_HSE' ? FORWARDED_AT : null,
      hse_review_deadline_at: options.deadline === undefined ? (status === 'PENDING_HSE' ? DEADLINE : null) : options.deadline,
      issued_at: status === 'ISSUED' ? '2026-08-20T10:06:30.000Z' : null,
    }),
    jsa: jsa(),
    availableActions: options.actions,
    serverTime: options.serverTime,
  });
}

/** Renders the record screen as a given person, with a stubbed server. */
function renderRecord(detail: PermitDetailResponse, viewer: ReturnType<typeof croEmployee>) {
  const harness = stubFetch({ 'GET /api/v1/permits/permit-1': () => ({ body: detail }) });
  return {
    ...harness,
    ...renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      viewer,
      { route: '/permits/permit-1' },
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------
// The CRO screen
// ---------------------------------------------------------------------

describe('the CRO screen while HSE has priority', () => {
  it('shows the countdown and offers no fallback', async () => {
    // 30 seconds in: 4:30 left.
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:00:30.000Z', actions: ['send_back', 'hold'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');

    expect(screen.getByText('HSE approval priority')).toBeInTheDocument();
    expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent('04:30');
    expect(screen.getByText(/fallback approval becomes available/i)).toBeInTheDocument();
    // The server offered no fallback, so there is none to press.
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();
  });

  it('counts down as time passes', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:00:30.000Z', actions: ['send_back'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent('04:30');

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent('04:20'));
  });

  it('re-reads the record when the window runs out, so the fallback appears on the server’s terms', async () => {
    let expired = false;
    const harness = stubFetch({
      'GET /api/v1/permits/permit-1': () => ({
        body: expired
          ? pendingHse({ serverTime: '2026-08-20T10:05:01.000Z', actions: ['fallback_approve', 'send_back'] })
          : pendingHse({ serverTime: '2026-08-20T10:04:57.000Z', actions: ['send_back'] }),
      }),
    });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      croEmployee(),
      { route: '/permits/permit-1' },
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();

    // The server would now offer the fallback.
    expired = true;
    await vi.advanceTimersByTimeAsync(4_000);

    await waitFor(() => expect(screen.getByTestId('hse-review-window')).toHaveAttribute('data-expired', 'true'));
    // It appeared because the record was re-read, not because a local
    // timer decided the CRO may act.
    await waitFor(() =>
      expect(harness.calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1),
    );
    expect(await screen.findByRole('button', { name: /fallback/i })).toBeInTheDocument();
  });

  it('says the window ended without claiming HSE may no longer approve', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:06:00.000Z', actions: ['fallback_approve'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent(/priority window ended/i);
    expect(screen.getByText(/HSE may still approve/i)).toBeInTheDocument();
    expect(screen.queryByText(/HSE can no longer|HSE may not/i)).not.toBeInTheDocument();
  });

  it('shows no countdown once the permit has been issued', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:07:00.000Z', actions: ['close'], status: 'ISSUED' }),
      croEmployee(),
    );
    await screen.findByRole('heading', { level: 1, name: /permit HW-3/i });
    expect(screen.queryByTestId('hse-review-window')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// The HSE screen
// ---------------------------------------------------------------------

describe('the HSE screen', () => {
  it('shows the same countdown, and Approve, during the window', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:00:28.000Z', actions: ['hse_approve', 'send_back'] }),
      hseApprover(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByText('HSE approval priority')).toBeInTheDocument();
    expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent('04:32');
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('STILL offers Approve after the window expires while nobody has won', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:06:00.000Z', actions: ['hse_approve', 'send_back'] }),
      hseApprover(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByTestId('hse-review-window')).toHaveAttribute('data-expired', 'true');
    // The window is a PRIORITY, not a deadline for HSE.
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByText(/HSE may still approve/i)).toBeInTheDocument();
  });

  /**
   * THE MANDATORY RULE. Once CRO fallback has issued the permit, HSE must
   * not still be looking at an Approve button - the record is ISSUED and
   * the only actions are the ones that belong to an issued permit.
   */
  it('shows ISSUED and NO Approve button once CRO fallback has won', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:07:00.000Z', actions: [], status: 'ISSUED' }),
      hseApprover(),
    );
    await screen.findByRole('heading', { level: 1, name: /permit HW-3/i });

    expect(screen.getAllByText(/issued/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send back/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hse-review-window')).not.toBeInTheDocument();
  });

  it('picks that up on a re-fetch, not from a local timer', async () => {
    let issuedByCro = false;
    stubFetch({
      'GET /api/v1/permits/permit-1': () => ({
        body: issuedByCro
          ? pendingHse({ serverTime: '2026-08-20T10:07:00.000Z', actions: [], status: 'ISSUED' })
          : pendingHse({ serverTime: '2026-08-20T10:04:58.000Z', actions: ['hse_approve'] }),
      }),
    });
    const { unmount } = renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      hseApprover(),
      { route: '/permits/permit-1' },
    );
    await screen.findByRole('button', { name: /approve/i });

    // CRO wins in the meantime; HSE reopens the record.
    issuedByCro = true;
    unmount();
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      hseApprover(),
      { route: '/permits/permit-1' },
    );

    await screen.findByRole('heading', { level: 1, name: /permit HW-3/i });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hse-review-window')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// The clock the countdown trusts
// ---------------------------------------------------------------------

describe('the countdown does not trust the device clock', () => {
  it('shows the same remaining time however wrong the device clock is', async () => {
    // The device is an hour fast. Measured against `Date.now()` the
    // window would look long expired; measured against the server's own
    // time, which is what this does, it reads 4:30.
    vi.setSystemTime(new Date('2026-08-20T11:00:30.000Z'));
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:00:30.000Z', actions: ['send_back'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByTestId('hse-review-window-state')).toHaveTextContent('04:30');
    expect(screen.getByTestId('hse-review-window')).toHaveAttribute('data-expired', 'false');
  });

  it('a device clock set backwards cannot resurrect an expired window', async () => {
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:06:00.000Z', actions: ['fallback_approve'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.getByTestId('hse-review-window')).toHaveAttribute('data-expired', 'true');
  });

  it('a manipulated clock cannot conjure a fallback button the server did not offer', async () => {
    vi.setSystemTime(new Date('2026-08-20T23:59:00.000Z'));
    renderRecord(
      // The server still says the window is running and offers no fallback.
      pendingHse({ serverTime: '2026-08-20T10:00:10.000Z', actions: ['send_back'] }),
      croEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();
  });
});

describe('an ordinary employee', () => {
  it('sees neither the fallback action nor an approval control', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:06:00.000Z', actions: [] }),
      normalEmployee(),
    );
    await screen.findByTestId('hse-review-window');
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    // The window is visible - it is information, not an authority.
    expect(screen.getByText('HSE approval priority')).toBeInTheDocument();
  });
});

describe('a permit with no window', () => {
  it('renders no countdown when the deadline is absent', async () => {
    renderRecord(
      pendingHse({ serverTime: '2026-08-20T10:00:30.000Z', actions: ['hse_approve'], deadline: null }),
      hseApprover(),
    );
    await screen.findByRole('heading', { level: 1, name: /permit HW-3/i });
    expect(screen.queryByTestId('hse-review-window')).not.toBeInTheDocument();
  });
});
