import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import { ceo, croEmployee, hseApprover, jsa, normalEmployee, permit, permitDetail } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { PermitDetailPage } from './PermitDetailPage';

/**
 * The permit record.
 *
 * The rules under test are the ones the backend owns and this screen
 * must merely reflect: which actions exist comes from `availableActions`
 * and nothing else, every mutation carries the permit's `version`, and
 * the record is always re-read afterwards rather than optimistically
 * transitioned.
 */

function renderDetail(detail: ReturnType<typeof permitDetail>, user = normalEmployee(), extraRoutes = {}) {
  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': { body: detail },
    ...extraRoutes,
  });
  const rendered = renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    user,
    { route: '/permits/permit-1' },
  );
  return { ...harness, ...rendered };
}

describe('the record', () => {
  it('shows the permit number, its status, and the linked JSA number', async () => {
    renderDetail(permitDetail());
    expect(await screen.findByRole('heading', { level: 1, name: /permit 000001/i })).toBeInTheDocument();
    expect(screen.getAllByText(/draft/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/JSA 000001/)).toBeInTheDocument();
  });

  it('presents Permit, JSA, and History as three sections of one record', async () => {
    renderDetail(permitDetail());
    await screen.findByRole('heading', { level: 1, name: /permit 000001/i });
    const tabs = screen.getByRole('tablist', { name: /permit record sections/i });
    expect(within(tabs).getByRole('tab', { name: /^permit$/i })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /job safety analysis/i })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /history/i })).toBeInTheDocument();
  });

  it('says the JSA is incomplete rather than showing an empty form as if it were filled in', async () => {
    const user = userEvent.setup();
    renderDetail(permitDetail());
    await screen.findByRole('heading', { level: 1, name: /permit 000001/i });

    await user.click(screen.getByRole('tab', { name: /job safety analysis/i }));
    expect(await screen.findByText(/has not been completed yet/i)).toBeInTheDocument();
  });
});

describe('the applicant on a submitted permit', () => {
  it('reads "Mr. NAME of Company COMPANY" for a normal applicant', async () => {
    renderDetail(
      permitDetail({
        permit: permit({
          status: 'PENDING_CRO',
          applicant_identity_kind: 'NORMAL',
          applicant_display_name: 'Ali Khan',
          applicant_company_code: 'ZPL',
          applicant_company_name: 'ZPL',
        }),
      }),
    );
    expect(await screen.findByText('Mr. Ali Khan of Company ZPL')).toBeInTheDocument();
  });

  it('reads a privileged applicant as the personal name alone', async () => {
    renderDetail(
      permitDetail({
        permit: permit({
          status: 'PENDING_CRO',
          applicant_identity_kind: 'PRIVILEGED',
          applicant_display_name: 'Farhan Aziz',
          applicant_company_code: 'E_SET',
          applicant_company_name: 'E-SET',
        }),
      }),
      ceo(),
    );
    expect(await screen.findByText('Farhan Aziz')).toBeInTheDocument();
    expect(screen.queryByText(/Mr\. Farhan Aziz of Company/)).not.toBeInTheDocument();
  });

  it('is never an editable field, at any status', async () => {
    renderDetail(permitDetail({ permit: permit({ status: 'PENDING_CRO' }), availableActions: ['forward_hse'] }), croEmployee());
    await screen.findByRole('heading', { level: 1, name: /permit 000001/i });
    expect(screen.queryByLabelText(/applicant/i)).not.toBeInTheDocument();
  });
});

describe('available actions come from the server', () => {
  it('shows none when the backend offers none', async () => {
    renderDetail(permitDetail({ availableActions: [] }));
    expect(await screen.findByText(/no actions are available to you/i)).toBeInTheDocument();
  });

  it('shows exactly the CRO actions the backend offers on a PENDING_CRO permit', async () => {
    renderDetail(
      permitDetail({ permit: permit({ status: 'PENDING_CRO' }), availableActions: ['forward_hse', 'send_back'] }),
      croEmployee(),
    );
    expect(await screen.findByRole('button', { name: /forward to hse/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /return for correction/i })).toBeInTheDocument();
    // Not offered by the backend, so not shown - even though this CRO
    // holds the capabilities for them at other statuses.
    expect(screen.queryByRole('button', { name: /place on hold/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve and issue/i })).not.toBeInTheDocument();
  });

  it('shows HSE actions only when the backend offers them', async () => {
    renderDetail(
      permitDetail({
        permit: permit({ status: 'PENDING_HSE' }),
        availableActions: ['hse_approve', 'hse_send_back'],
      }),
      hseApprover(),
    );
    expect(await screen.findByRole('button', { name: /approve and issue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /return to cro/i })).toBeInTheDocument();
  });

  it('does NOT invent a fallback approval from a local timer - only the backend offers it', async () => {
    // A permit whose HSE window expired long ago, but where the backend
    // did not offer `fallback_approve` (the caller lacks the capability).
    renderDetail(
      permitDetail({
        permit: permit({
          status: 'PENDING_HSE',
          hse_review_deadline_at: '2020-01-01T00:00:00.000Z',
        }),
        availableActions: [],
      }),
      croEmployee(),
    );
    await screen.findByText(/no actions are available to you/i);
    expect(screen.queryByRole('button', { name: /fallback/i })).not.toBeInTheDocument();
  });

  it('hides the edit control when the backend does not offer "update"', async () => {
    renderDetail(permitDetail({ availableActions: [] }));
    await screen.findByRole('heading', { level: 1, name: /permit 000001/i });
    expect(screen.queryByRole('button', { name: /edit permit and jsa/i })).not.toBeInTheDocument();
  });

  it('offers editing when the backend does', async () => {
    renderDetail(permitDetail({ availableActions: ['update', 'submit'] }));
    expect(await screen.findByRole('button', { name: /edit permit and jsa/i })).toBeInTheDocument();
  });
});

describe('performing an action', () => {
  it('confirms first, then sends the permit’s current version', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({ permit: permit({ version: 7 }), availableActions: ['submit'] }),
      normalEmployee(),
      { 'POST /api/v1/permits/permit-1/submit': { body: { permit: permit({ version: 8, status: 'PENDING_CRO' }) } } },
    );

    await user.click(await screen.findByRole('button', { name: /submit for cro review/i }));
    // A confirmation dialog, not an immediate mutation.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/identity will be recorded as the applicant/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/v1/permits/permit-1/submit')).toBe(true));
    const submitCall = calls.find((call) => call.url === '/api/v1/permits/permit-1/submit');
    expect(submitCall?.body).toEqual({ version: 7 });
  });

  it('re-reads the authoritative permit afterwards rather than assuming the new state', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({ availableActions: ['submit'] }),
      normalEmployee(),
      { 'POST /api/v1/permits/permit-1/submit': { body: { permit: permit({ status: 'PENDING_CRO' }) } } },
    );

    await user.click(await screen.findByRole('button', { name: /submit for cro review/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      const detailReads = calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/permits/permit-1');
      expect(detailReads.length).toBeGreaterThan(1);
    });
  });

  it('requires a hold reason before it will send anything', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({ permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }), availableActions: ['hold'] }),
      croEmployee(),
    );

    await user.click(await screen.findByRole('button', { name: /place on hold/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /place on hold/i }));

    expect(await within(dialog).findByText(/this is required/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('surfaces a version conflict in plain language and re-reads the record', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({ availableActions: ['submit'] }),
      normalEmployee(),
      {
        'POST /api/v1/permits/permit-1/submit': {
          status: 409,
          body: {
            error: 'conflict',
            reason: 'version_mismatch',
            message: 'Permit has changed or is not in the required state',
          },
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: /submit for cro review/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^submit$/i }));

    expect(await screen.findByText(/permit has changed or is not in the required state/i)).toBeInTheDocument();
    await waitFor(() => {
      const detailReads = calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/permits/permit-1');
      expect(detailReads.length).toBeGreaterThan(1);
    });
  });
});

describe('the permit document', () => {
  it('is not offered before the permit has been issued', async () => {
    renderDetail(permitDetail());
    await screen.findByRole('heading', { level: 1, name: /permit 000001/i });
    expect(screen.queryByRole('button', { name: /download permit document/i })).not.toBeInTheDocument();
  });

  it('is offered once issued', async () => {
    renderDetail(
      permitDetail({
        permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }),
        validity: { isValid: true, expiresAt: '2026-08-21T19:00:00.000Z' },
      }),
    );
    expect(await screen.findByRole('button', { name: /download permit document/i })).toBeInTheDocument();
  });

  it('reports unavailable storage professionally, without naming any infrastructure', async () => {
    const user = userEvent.setup();
    renderDetail(
      permitDetail({ permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }) }),
      normalEmployee(),
      { 'GET /api/v1/permits/permit-1/pdf': { status: 503, body: { error: 'storage_unavailable' } } },
    );

    await user.click(await screen.findByRole('button', { name: /download permit document/i }));

    const notice = await screen.findByText(/document storage is not configured for this environment/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).not.toMatch(/bucket|s3|supabase|key|secret|endpoint/i);
  });

  it('says the document is still being prepared for a 202', async () => {
    const user = userEvent.setup();
    renderDetail(
      permitDetail({ permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }) }),
      normalEmployee(),
      { 'GET /api/v1/permits/permit-1/pdf': { status: 202, body: { status: 'processing' } } },
    );

    await user.click(await screen.findByRole('button', { name: /download permit document/i }));
    expect(await screen.findByText(/still being prepared/i)).toBeInTheDocument();
  });
});

describe('history', () => {
  it('reads as plain sentences and exposes no database internals', async () => {
    const user = userEvent.setup();
    renderDetail(
      permitDetail({
        permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }),
        history: [
          {
            id: 'event-1',
            ordinal: '4211',
            permit_id: 'permit-1',
            event_type: 'HSE_APPROVED',
            actor_user_id: '9f1a2b3c-0000-4000-8000-000000000001',
            from_status: 'PENDING_HSE',
            to_status: 'ISSUED',
            reason: null,
            occurred_at: '2026-08-20T10:00:00.000Z',
          },
        ],
      }),
    );

    await user.click(await screen.findByRole('tab', { name: /history/i }));

    expect(await screen.findByText(/approved by hse/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending HSE → Issued/)).toBeInTheDocument();
    // No ordinal, no event id, no permit id, no actor UUID.
    expect(screen.queryByText('4211')).not.toBeInTheDocument();
    expect(screen.queryByText(/9f1a2b3c/)).not.toBeInTheDocument();
    expect(screen.queryByText('HSE_APPROVED')).not.toBeInTheDocument();
  });
});

describe('signatures', () => {
  it('shows a normal signer with their frozen designation', async () => {
    renderDetail(
      permitDetail({
        permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }),
        signatures: [
          {
            id: 'sig-1',
            permit_id: 'permit-1',
            source_event_id: 'event-1',
            signature_role: 'HSE',
            signer_user_id: 'user-hse',
            signer_display_name: 'Sana Malik',
            signer_identity_kind: 'NORMAL',
            signer_team_position_id: 'tp-hse',
            signer_team_name: 'HSE',
            signer_position_name: 'Team Lead',
            signed_at: '2026-08-20T10:00:00.000Z',
            created_at: '2026-08-20T10:00:00.000Z',
          },
        ],
      }),
    );

    expect(await screen.findByText('Sana Malik')).toBeInTheDocument();
    expect(screen.getByText(/Team Lead · HSE/)).toBeInTheDocument();
  });

  it('shows a privileged signer with no fabricated Team or Position', async () => {
    renderDetail(
      permitDetail({
        permit: permit({ status: 'ISSUED', issued_at: '2026-08-20T09:00:00.000Z' }),
        signatures: [
          {
            id: 'sig-2',
            permit_id: 'permit-1',
            source_event_id: 'event-2',
            signature_role: 'APPLICANT',
            signer_user_id: 'user-ceo',
            signer_display_name: 'Farhan Aziz',
            signer_identity_kind: 'PRIVILEGED',
            signer_team_position_id: null,
            signer_team_name: null,
            signer_position_name: null,
            signed_at: '2026-08-20T09:00:00.000Z',
            created_at: '2026-08-20T09:00:00.000Z',
          },
        ],
      }),
      ceo(),
    );

    expect(await screen.findByText('Farhan Aziz')).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toHaveTextContent('CEO');
  });
});

describe('failure to load', () => {
  it('shows "not found" for a 404 rather than an empty record', async () => {
    stubFetch({ 'GET /api/v1/permits/permit-1': { status: 404, body: { error: 'not_found' } } });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    );
    expect(await screen.findByText(/that record is not available/i)).toBeInTheDocument();
  });

  it('shows a permission refusal honestly rather than a blank page', async () => {
    stubFetch({ 'GET /api/v1/permits/permit-1': { status: 403, body: { error: 'forbidden' } } });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    );
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });

  it('offers a retry for a server failure, and shows a reference id', async () => {
    stubFetch({
      'GET /api/v1/permits/permit-1': {
        status: 500,
        body: { error: 'internal_error' },
        headers: { 'x-request-id': 'req-abc' },
      },
    });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    );
    expect(await screen.findByText(/reference: req-abc/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('sends only the form and the version, never a status or an identity', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({
        permit: permit({ version: 3, form_payload: null }),
        jsa: jsa(),
        availableActions: ['update'],
      }),
      normalEmployee(),
      {
        'PATCH /api/v1/permits/permit-1': { body: { permit: permit({ version: 4 }) } },
        'PATCH /api/v1/permits/permit-1/jsa': { body: { permit: permit({ version: 5 }), jsa: jsa() } },
      },
    );

    await user.click(await screen.findByRole('button', { name: /edit permit and jsa/i }));
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const permitPatch = calls.find((call) => call.url === '/api/v1/permits/permit-1' && call.method === 'PATCH');
    expect(Object.keys(permitPatch?.body as object).sort()).toEqual(['form', 'version']);
    expect(permitPatch?.body).toMatchObject({ version: 3 });
  });

  it('chains the JSA save onto the version the permit save returned', async () => {
    const user = userEvent.setup();
    const { calls } = renderDetail(
      permitDetail({ permit: permit({ version: 3 }), availableActions: ['update'] }),
      normalEmployee(),
      {
        'PATCH /api/v1/permits/permit-1': { body: { permit: permit({ version: 4 }) } },
        'PATCH /api/v1/permits/permit-1/jsa': { body: { permit: permit({ version: 5 }), jsa: jsa() } },
      },
    );

    await user.click(await screen.findByRole('button', { name: /edit permit and jsa/i }));
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const jsaPatch = calls.find((call) => call.url === '/api/v1/permits/permit-1/jsa');
      expect(jsaPatch?.body).toMatchObject({ version: 4 });
    });
  });

  it('shows the backend’s field-level validation issues', async () => {
    const user = userEvent.setup();
    renderDetail(
      permitDetail({ permit: permit({ version: 3 }), availableActions: ['update'] }),
      normalEmployee(),
      {
        'PATCH /api/v1/permits/permit-1': {
          status: 400,
          body: {
            error: 'invalid_request',
            message: 'Invalid permit form content',
            reason: 'invalid_form_payload',
            issues: [{ path: ['windFarm'], message: 'Required' }],
          },
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: /edit permit and jsa/i }));
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/windFarm: Required/)).toBeInTheDocument();
  });
});
