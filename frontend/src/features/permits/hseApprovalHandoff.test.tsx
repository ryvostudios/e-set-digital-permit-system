import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import type { PermitDetailResponse } from '../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * WHAT HSE SEES AFTER THEY PRESS "APPROVE AND ISSUE".
 *
 * Reported from UAT: the approval worked - the permit was issued, the
 * PDF was generated, the applicant and the CRO could both see it - and
 * the reviewer who had just issued it was left looking at "That record is
 * not available" on the same URL.
 *
 * THE CAUSE WAS THE BACKEND'S READ RULE, and it is fixed there:
 * `STATUS_VIEW_CAPABILITIES.ISSUED` did not include `permit.hse_review`,
 * so the re-read that follows every action came back 404. These specs
 * describe the browser's half of that sequence against a backend that
 * now answers correctly - and the last one deliberately proves the
 * frontend does NOT paper over a 404 when it genuinely gets one.
 */

const HSE = () =>
  normalEmployee({
    auth: { id: 'user-hse', email: 'hse@eset.example.com' },
    profile: {
      displayName: 'Sana Iqbal',
      company: { code: 'E_SET', name: 'E-SET' },
      teamName: 'HSE',
      positionName: 'HSE Officer',
    },
    capabilities: ['permit.hse_review'],
  });

const pendingHse = (): PermitDetailResponse =>
  permitDetail({
    permit: permit({
      permit_type: 'HOT_WORK',
      form_version: 'HOT_WORK_V1',
      status: 'PENDING_HSE',
      version: 4,
      permitDisplayNumber: 'HW-3',
    }),
    jsa: jsa(),
    availableActions: ['hse_approve', 'hse_send_back'],
  });

/** The same permit as the backend now returns it to HSE, one request later. */
const issued = (): PermitDetailResponse =>
  permitDetail({
    permit: permit({
      permit_type: 'HOT_WORK',
      form_version: 'HOT_WORK_V1',
      status: 'ISSUED',
      version: 5,
      permitDisplayNumber: 'HW-3',
      issued_at: '2026-08-21T09:00:00.000Z',
    }),
    jsa: jsa(),
    // HSE holds no hold/cancel/close capability, so the server offers
    // them nothing - which is exactly right.
    availableActions: [],
  });

/**
 * @param approval what the backend answers to the approval itself
 * @param afterApproval what the following re-read answers
 */
function renderApproval(options: {
  approval?: { status: number; body?: unknown };
  afterApproval?: { status: number; body?: unknown };
} = {}) {
  let approved = false;
  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': () => {
      if (!approved) return { body: pendingHse() };
      return options.afterApproval ?? { body: issued() };
    },
    'POST /api/v1/permits/permit-1/hse-approve': () => {
      const outcome = options.approval ?? { status: 200, body: {} };
      if (outcome.status < 300) approved = true;
      return outcome;
    },
  });
  renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    HSE(),
    { route: '/permits/permit-1' },
  );
  return harness;
}

async function approve() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /approve and issue/i }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: /approve and issue/i }));
}

describe('approving as HSE', () => {
  it('confirms the issuance and keeps the permit on screen', async () => {
    renderApproval();
    await approve();

    expect(await screen.findByText('Permit issued successfully.')).toBeInTheDocument();
    // THE BUG: this used to be "That record is not available."
    expect(screen.queryByText(/that record is not available/i)).not.toBeInTheDocument();
    // The same permit, still open, now in its new state.
    expect(screen.getByRole('heading', { level: 1, name: /permit HW-3/i })).toBeInTheDocument();
    // The status badge now reads Issued (the word also appears as a
    // field label on the document, hence the count rather than one).
    await waitFor(() => expect(screen.getAllByText(/^Issued$/i).length).toBeGreaterThan(0));
  });

  it('leaves HSE with no approval or edit action on the issued permit', async () => {
    renderApproval();
    await approve();
    await screen.findByText('Permit issued successfully.');

    await waitFor(() =>
      expect(screen.getByText(/no actions are available to you on this permit right now/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /approve and issue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /return to cro/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    // ...and it did not silently acquire someone else's actions either.
    expect(screen.queryByRole('button', { name: /close permit/i })).not.toBeInTheDocument();
  });

  it('re-reads the record from the server rather than assuming the new state', async () => {
    const harness = renderApproval();
    await approve();
    await screen.findByText('Permit issued successfully.');

    // One read to open it, one after the action. The screen shows what
    // the server returned, never a locally invented ISSUED.
    await waitFor(() =>
      expect(harness.calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1),
    );
    const approval = harness.calls.find((call) => call.method === 'POST')!;
    // The version the screen was showing - so a permit that moved on in
    // the meantime is refused rather than overwritten.
    expect(approval.body).toEqual({ version: 4 });
  });
});

describe('a racing or stale approval', () => {
  it('says nothing about issuance when the version is stale, and re-reads', async () => {
    // Somebody else moved the permit first: the CRO fallback-approved it
    // while this reviewer was reading.
    const harness = renderApproval({
      approval: {
        status: 409,
        body: { code: 'conflict', message: 'This record changed since you opened it. Reload and try again.' },
      },
    });
    await approve();

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since you opened it/i);
    expect(screen.queryByText('Permit issued successfully.')).not.toBeInTheDocument();
    // A conflict re-reads, so the screen stops offering what is no longer true.
    await waitFor(() =>
      expect(harness.calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1),
    );
  });

  it('does NOT invent a permit when the record really is unreadable', async () => {
    // If the re-read genuinely 404s, the screen must say so. The fix for
    // this bug was to make the backend answer correctly - not to teach
    // the frontend to pretend.
    renderApproval({
      afterApproval: { status: 404, body: { code: 'not_found', message: 'That record is not available.' } },
    });
    await approve();

    expect(await screen.findByText(/that record is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /permit HW-3/i })).not.toBeInTheDocument();
  });
});
