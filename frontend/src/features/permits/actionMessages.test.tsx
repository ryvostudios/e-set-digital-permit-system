import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import type { AvailableAction, CurrentUser, PermitDetailResponse, PermitStatus } from '../../api/types';
import { croEmployee, jsa, normalEmployee, permit, permitDetail } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * WHAT THE PERSON IS TOLD WHEN A PERMIT CHANGES STATE.
 *
 * Three transitions end a review, and each was previously confirmed in
 * the words of the BUTTON rather than of the outcome - "Approve as CRO
 * fallback — done." left the reader to work out that the permit is now
 * issued. They now say what happened to the permit.
 *
 * TWO PROPERTIES MATTER MORE THAN THE WORDING.
 *
 * 1. THE BACKEND SAYS SO FIRST. The message is shown only after the
 *    mutation resolves. A refused transition - a stale version, a lost
 *    authority, a permit that has moved on - produces an error and no
 *    confirmation, and these specs prove that by failing the request.
 *
 * 2. IT DOES NOT SURVIVE A RELOAD. The confirmation is transient state
 *    in the toast provider, not anything read back from the record, so
 *    opening an already-issued permit says nothing. A permit's state is
 *    read from the record; only the act of changing it is announced.
 */

const ISSUED_MESSAGE = 'Permit issued successfully.';
const CLOSED_MESSAGE = 'Permit closed successfully.';

function detail(status: PermitStatus, actions: AvailableAction[]): PermitDetailResponse {
  return permitDetail({
    permit: permit({
      permit_type: 'HOT_WORK',
      form_version: 'HOT_WORK_V1',
      status,
      version: 4,
      permitDisplayNumber: 'HW-3',
      issued_at: status === 'ISSUED' || status === 'CLOSED' ? '2026-08-21T09:00:00.000Z' : null,
    }),
    jsa: jsa(),
    availableActions: actions,
  });
}

/**
 * Renders the record, then answers the mutation with `outcome`. The GET
 * that follows returns the permit in its new state, exactly as the real
 * screen re-reads it.
 */
function renderWith(options: {
  status: PermitStatus;
  actions: AvailableAction[];
  method: 'POST';
  path: string;
  outcome?: { status: number; body?: unknown };
  after?: PermitStatus;
  user?: CurrentUser;
}) {
  let done = false;
  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': () => ({
      body: done && options.after ? detail(options.after, []) : detail(options.status, options.actions),
    }),
    [`${options.method} /api/v1/permits/permit-1${options.path}`]: () => {
      const outcome = options.outcome ?? { status: 200, body: {} };
      if (outcome.status < 300) done = true;
      return outcome;
    },
  });
  renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    options.user ?? croEmployee(),
    { route: '/permits/permit-1' },
  );
  return harness;
}

/** Presses an action button and confirms the dialog it opens. */
async function act(button: RegExp, confirm: RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  await user.click(await within(dialog).findByRole('button', { name: confirm }));
}

// ---------------------------------------------------------------------
// Issued
// ---------------------------------------------------------------------

describe('approving a permit', () => {
  it('tells the HSE reviewer the permit is issued', async () => {
    renderWith({
      status: 'PENDING_HSE',
      actions: ['hse_approve'],
      method: 'POST',
      path: '/hse-approve',
      after: 'ISSUED',
      user: normalEmployee({
        auth: { id: 'user-hse', email: 'hse@eset.example.com' },
        capabilities: ['permit.hse_review'],
      }),
    });

    await act(/approve and issue/i, /approve and issue/i);

    expect(await screen.findByText(ISSUED_MESSAGE)).toBeInTheDocument();
    // In the live region, so it is announced and not merely drawn.
    expect(screen.getByText(ISSUED_MESSAGE).closest('[role="status"]')).not.toBeNull();
  });

  it('tells the CRO the permit is issued when they approve as fallback', async () => {
    renderWith({
      status: 'PENDING_HSE',
      actions: ['fallback_approve'],
      method: 'POST',
      path: '/fallback-approve',
      after: 'ISSUED',
    });

    await act(/approve as cro fallback/i, /approve as fallback/i);

    // The authority recorded differs from an HSE approval; the outcome
    // for the permit does not, and that is what is reported.
    expect(await screen.findByText(ISSUED_MESSAGE)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Closed
// ---------------------------------------------------------------------

describe('closing a permit', () => {
  it('tells the CRO the permit is closed', async () => {
    renderWith({
      status: 'ISSUED',
      actions: ['close'],
      method: 'POST',
      path: '/close',
      after: 'CLOSED',
    });

    await act(/close permit/i, /close permit/i);

    expect(await screen.findByText(CLOSED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(ISSUED_MESSAGE)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Only when the backend agreed
// ---------------------------------------------------------------------

describe('a transition the backend refuses', () => {
  const refusals = [
    { label: 'a stale version (409)', status: 409, code: 'conflict' },
    { label: 'a lost authority (403)', status: 403, code: 'forbidden' },
    { label: 'a permit that moved on (422)', status: 422, code: 'unprocessable' },
  ];

  for (const refusal of refusals) {
    it(`says nothing about issuance on ${refusal.label}`, async () => {
      renderWith({
        status: 'PENDING_HSE',
        actions: ['hse_approve'],
        method: 'POST',
        path: '/hse-approve',
        outcome: { status: refusal.status, body: { code: refusal.code, message: 'Refused.' } },
        user: normalEmployee({
          auth: { id: 'user-hse', email: 'hse@eset.example.com' },
          capabilities: ['permit.hse_review'],
        }),
      });

      await act(/approve and issue/i, /approve and issue/i);

      // The failure is reported, in the dialog, as an alert - a conflict
      // repeats the backend's own wording, the others use the written
      // message for their code.
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /refused|do not have permission|changed since you opened it|not in a state/i,
      );
      // ...and success is not.
      expect(screen.queryByText(ISSUED_MESSAGE)).not.toBeInTheDocument();
    });
  }

  it('says nothing about closure when the close is refused', async () => {
    renderWith({
      status: 'ISSUED',
      actions: ['close'],
      method: 'POST',
      path: '/close',
      outcome: { status: 409, body: { code: 'conflict', message: 'This permit has moved on.' } },
    });

    await act(/close permit/i, /close permit/i);

    // A conflict is one of the two codes whose backend wording is shown
    // verbatim, so the person is told what actually happened.
    expect(await screen.findByRole('alert')).toHaveTextContent(/moved on/i);
    expect(screen.queryByText(CLOSED_MESSAGE)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Not a property of the record
// ---------------------------------------------------------------------

describe('opening a permit that is already in its new state', () => {
  it('says nothing - the confirmation belongs to the act, not the record', async () => {
    stubFetch({ 'GET /api/v1/permits/permit-1': { body: detail('ISSUED', ['close']) } });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      croEmployee(),
      { route: '/permits/permit-1' },
    );

    await screen.findByRole('button', { name: /close permit/i });
    expect(screen.queryByText(ISSUED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(CLOSED_MESSAGE)).not.toBeInTheDocument();
  });

  it('says nothing on a closed permit either', async () => {
    stubFetch({ 'GET /api/v1/permits/permit-1': { body: detail('CLOSED', []) } });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      croEmployee(),
      { route: '/permits/permit-1' },
    );

    await screen.findByText(/no actions are available/i);
    expect(screen.queryByText(CLOSED_MESSAGE)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Everything else is unchanged
// ---------------------------------------------------------------------

describe('the other workflow actions', () => {
  it('keep their existing generic confirmation', async () => {
    renderWith({
      status: 'ISSUED',
      actions: ['hold'],
      method: 'POST',
      path: '/hold',
      after: 'HELD',
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /place on hold/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Weather');
    await user.click(within(dialog).getByRole('button', { name: /place on hold/i }));

    await waitFor(() => expect(screen.getByText(/place on hold — done\./i)).toBeInTheDocument());
    expect(screen.queryByText(ISSUED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(CLOSED_MESSAGE)).not.toBeInTheDocument();
  });
});
