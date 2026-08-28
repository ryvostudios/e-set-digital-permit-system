import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import type { PermitClosure, PermitDetailResponse, PermitSignature } from '../../api/types';
import {
  actorIdentity,
  croEmployee,
  jsa,
  lifecycleEvent,
  permit,
  permitDetail,
  privilegedActorIdentity,
} from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * WHO CLOSED THE PERMIT.
 *
 * The CRO who closes a permit is very often not the CRO who reviewed or
 * forwarded it - the work runs for hours and shifts change. The record
 * has to show both, separately, and must never present the original
 * reviewer as the person who closed it.
 *
 * The screen shows what the SERVER recorded as the closing actor. It
 * derives nothing from the frozen CRO authorization on the document.
 */

const CLOSED_AT = '2026-08-29T11:15:00.000Z';

/** The frozen CRO authorization - a different person from the closer. */
const reviewingCro: PermitSignature = {
  id: 'sig-cro',
  permit_id: 'permit-1',
  source_event_id: 'event-1',
  signature_role: 'CRO',
  signer_user_id: 'cro-a',
  signer_display_name: 'Hamza Tariq',
  signer_team_position_id: 'tp-ebop-cro',
  signer_team_name: 'E-BOP',
  signer_position_name: 'CRO',
  signed_at: '2026-08-29T08:00:00.000Z',
  created_at: '2026-08-29T08:00:00.000Z',
};

const REMARKS = 'Work completed and area restored.';

/** CRO B, on the next shift - not the CRO who forwarded it. */
const closedByOsama: PermitClosure = {
  closedAt: CLOSED_AT,
  remarks: REMARKS,
  closedBy: actorIdentity({ userId: 'cro-b', displayName: 'Osama' }),
};

/** The same closure, performed by a privileged account instead. */
const closedByCeo: PermitClosure = {
  closedAt: CLOSED_AT,
  remarks: REMARKS,
  closedBy: privilegedActorIdentity(),
};

/** The forward, then the close - the history as the server records it. */
const closureHistory = (closure: PermitClosure) => [
  lifecycleEvent({
    id: 'event-1',
    event_type: 'CRO_FORWARDED_HSE',
    actor_user_id: 'cro-a',
    from_status: 'PENDING_CRO',
    to_status: 'PENDING_HSE',
    occurred_at: '2026-08-29T08:00:00.000Z',
    actor: actorIdentity({ userId: 'cro-a', displayName: 'Hamza Tariq' }),
  }),
  lifecycleEvent({
    id: 'event-9',
    event_type: 'PERMIT_CLOSED',
    actor_user_id: closure.closedBy?.userId ?? 'unknown',
    from_status: 'ISSUED',
    to_status: 'CLOSED',
    reason: closure.remarks,
    occurred_at: closure.closedAt,
    actor: closure.closedBy,
  }),
];

function renderClosed(closure: PermitClosure | null, overrides: Partial<PermitDetailResponse> = {}) {
  const detail = permitDetail({
    permit: permit({
      status: 'CLOSED',
      permit_type: 'HOT_WORK',
      permit_sequence: '3',
      permitDisplayNumber: 'HW-3',
      form_version: 'HOT_WORK_V1',
      issued_at: '2026-08-29T09:00:00.000Z',
      closed_by: closure?.closedBy?.userId ?? null,
      closed_at: closure?.closedAt ?? null,
      closure_remarks: closure?.remarks ?? null,
    }),
    jsa: jsa(),
    availableActions: [],
    signatures: [reviewingCro],
    closure,
    history: closure ? closureHistory(closure) : [],
    ...overrides,
  });
  stubFetch({ 'GET /api/v1/permits/permit-1': { body: detail } });
  return renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    croEmployee(),
    { route: '/permits/permit-1' },
  );
}

const closureSection = () => screen.getByRole('heading', { name: /^closure$/i }).closest('section')!;

describe('the Closure section', () => {
  it('is its own section on a closed permit', async () => {
    renderClosed(closedByOsama);
    expect(await screen.findByRole('heading', { name: /^closure$/i })).toBeInTheDocument();
  });

  it('names the person who actually closed it', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = within(closureSection());
    expect(section.getByText('Closed by')).toBeInTheDocument();
    expect(section.getByText('Osama')).toBeInTheDocument();
  });

  it('shows the closer’s role and team', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    expect(within(closureSection()).getByText('CRO · E-BOP')).toBeInTheDocument();
  });

  it('does NOT present the reviewing CRO as the closer', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = within(closureSection());
    // Hamza authorized the work and still appears in the signature band -
    // but he did not close it, and the Closure section must not say so.
    expect(section.queryByText('Hamza Tariq')).not.toBeInTheDocument();
    expect(screen.getByText('Hamza Tariq')).toBeInTheDocument();
  });

  it('shows the closing time in the readable format, never a raw ISO string', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = closureSection();
    expect(within(section).getByText('Closed at')).toBeInTheDocument();
    expect(section.textContent).not.toContain(CLOSED_AT);
    expect(section.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('shows the closure remarks', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    expect(within(closureSection()).getByText('Work completed and area restored.')).toBeInTheDocument();
  });

  it('keeps blank remarks blank rather than inventing text', async () => {
    renderClosed({ ...closedByOsama, remarks: null });
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = within(closureSection());
    expect(section.getByText('Remarks')).toBeInTheDocument();
    // The section still names the closer; only the remarks are empty.
    expect(section.getByText('Osama')).toBeInTheDocument();
    expect(section.queryByText(/completed|restored|none|n\/a/i)).not.toBeInTheDocument();
  });

  it('says plainly when the closer cannot be named, rather than guessing', async () => {
    renderClosed({ ...closedByOsama, closedBy: null });
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = within(closureSection());
    expect(section.getByText(/no account record is available to name them/i)).toBeInTheDocument();
    // And it certainly does not fall back to the reviewing CRO.
    expect(section.queryByText('Hamza Tariq')).not.toBeInTheDocument();
  });

  it('does not appear on a permit that is not closed', async () => {
    stubFetch({
      'GET /api/v1/permits/permit-1': {
        body: permitDetail({
          permit: permit({ status: 'ISSUED', form_version: 'HOT_WORK_V1', permitDisplayNumber: 'HW-3' }),
          closure: null,
        }),
      },
    });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      croEmployee(),
      { route: '/permits/permit-1' },
    );
    await screen.findByRole('heading', { level: 1, name: /permit HW-3/i });
    expect(screen.queryByRole('heading', { name: /^closure$/i })).not.toBeInTheDocument();
  });
});

describe('the frozen authorizations', () => {
  it('are still shown, unchanged, beside the closure', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    // The CRO who authorized the work is still named as the signer.
    expect(screen.getByText('Hamza Tariq')).toBeInTheDocument();
    expect(screen.getAllByText(/CRO/).length).toBeGreaterThan(0);
  });
});

async function openHistory() {
  await userEvent.setup().click(screen.getByRole('tab', { name: /history/i }));
}

describe('the closing actor in the history', () => {
  it('names the CRO who actually closed it', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(within(closed).getByText('Closed by')).toBeInTheDocument();
    expect(within(closed).getByText('Osama')).toBeInTheDocument();
    expect(within(closed).getByText(/CRO · E-BOP/)).toBeInTheDocument();
  });

  it('does NOT name the CRO who forwarded it as the closer', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(within(closed).queryByText('Hamza Tariq')).not.toBeInTheDocument();
    // Hamza's own event is still there, and still his.
    const forwarded = screen.getByText(/forwarded/i).closest('li')!;
    expect(within(forwarded).queryByText('Closed by')).not.toBeInTheDocument();
  });

  it('carries the closure remarks on the closure event', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(within(closed).getByText(new RegExp(REMARKS))).toBeInTheDocument();
    expect(within(closed).getByText(/ISSUED|Issued/)).toBeInTheDocument();
  });

  it('names a privileged closer by their role, not as unknown', async () => {
    renderClosed(closedByCeo);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(within(closed).getByText('Ayesha Khan')).toBeInTheDocument();
    expect(within(closed).getByText(/CEO/)).toBeInTheDocument();
    expect(within(closed).queryByText(/no longer be identified/i)).not.toBeInTheDocument();
  });

  it('says plainly that an unresolvable closer is unidentified, and guesses no one', async () => {
    renderClosed({ ...closedByOsama, closedBy: null });
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(within(closed).getByText(/no longer be identified/i)).toBeInTheDocument();
    expect(within(closed).queryByText('Hamza Tariq')).not.toBeInTheDocument();
    expect(within(closed).queryByText('Osama')).not.toBeInTheDocument();
  });

  it('leaves the earlier events exactly as they were', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    // The forward still reads as the same transition it always did, and
    // shows no actor line - closure is the one event that names one.
    const forwarded = (await screen.findByText(/forwarded/i)).closest('li')!;
    expect(forwarded.textContent).toMatch(/Pending CRO/i);
    expect(within(forwarded).queryByText('Hamza Tariq')).not.toBeInTheDocument();
  });

  it('never shows a raw user id', async () => {
    renderClosed(closedByOsama);
    await screen.findByRole('heading', { name: /^closure$/i });
    await openHistory();

    const closed = (await screen.findByText(/permit closed/i)).closest('li')!;
    expect(closed.textContent).not.toContain('cro-b');
    expect(closed.textContent).not.toContain('cro-a');
  });
});

describe('a privileged closer in the Closure section', () => {
  it('is named, with their role standing in for a job title', async () => {
    renderClosed(closedByCeo);
    await screen.findByRole('heading', { name: /^closure$/i });
    const section = within(closureSection());
    expect(section.getByText('Ayesha Khan')).toBeInTheDocument();
    expect(section.getByText('CEO')).toBeInTheDocument();
    // No team or position is invented for an account that holds none.
    expect(section.queryByText(/E-BOP/)).not.toBeInTheDocument();
    expect(section.queryByText(/no account record is available/i)).not.toBeInTheDocument();
  });
});
