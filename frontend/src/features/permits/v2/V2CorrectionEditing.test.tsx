import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { FormCatalogue } from '../../../api/catalogue';
import type { AvailableAction, JsaFormPayload, PermitFormPayload, PermitStatus } from '../../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';

/**
 * CORRECTING A V2 PERMIT A CRO SENT BACK.
 *
 * The backend calls exactly two statuses editable - `EDITABLE_STATUSES`
 * is `['DRAFT', 'PENDING_CORRECTION']` - and grants `update` on both to
 * the permit's owner. A correction the applicant cannot actually correct
 * is not a correction workflow, so PENDING_CORRECTION opens the SAME V2
 * editor a draft does.
 *
 * What differs is only the onward action. A returned permit is
 * RESUBMITTED: `POST /permits/:id/resubmit`, its own transition
 * (PENDING_CORRECTION -> PENDING_CRO) and its own lifecycle event. Sending
 * it through the initial-submission endpoint would be the wrong
 * transition, so these specs pin the endpoint, not just the outcome.
 *
 * AUTHORITY IS THE SERVER'S, THROUGHOUT. Every control here follows the
 * record's `availableActions`; no rule in the browser reads a status or a
 * role and decides someone may edit.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const wtg = catalogue.permits.WTG_WORK;
const firstSection = wtg.checklistSections[0]!;

/** A partly completed V2 permit, as the server stores one. */
const STORED_PERMIT = {
  permitIssue: { wtgNumber: 'WTG-14', windFarmName: 'North Farm' },
  sections: { [firstSection.id]: { [firstSection.items[0]!.id]: { response: 'NO' } } },
} as unknown as PermitFormPayload;

const STORED_JSA = { page1: { siteOrWtg: 'North Farm' } } as unknown as JsaFormPayload;

function renderCorrection({
  status = 'PENDING_CORRECTION' as PermitStatus,
  availableActions = ['update', 'resubmit'] as AvailableAction[],
  formVersion = 'WTG_WORK_V2',
  /**
   * A V1 record carries a V1 payload. `null` is the honest one to use
   * here: this file is about routing and the onward action, and a real
   * V1 form fixture would only add noise. (Handing a V1 record a V2
   * payload is precisely the hosted crash, so it must not be done even
   * in a test.)
   */
  permitPayload = STORED_PERMIT as PermitFormPayload | null,
  extraRoutes = {},
}: {
  status?: PermitStatus;
  availableActions?: AvailableAction[];
  formVersion?: string;
  permitPayload?: PermitFormPayload | null;
  extraRoutes?: Record<string, unknown>;
} = {}) {
  const detail = permitDetail({
    permit: permit({
      permit_type: 'WTG_WORK',
      form_version: formVersion,
      status,
      version: 7,
      form_payload: permitPayload,
    }),
    jsa: jsa({
      form_version: formVersion.endsWith('_V2') ? 'JSA_V2' : 'JSA_V1',
      form_payload: formVersion.endsWith('_V2') ? STORED_JSA : null,
    }),
    availableActions,
    history: [
      {
        id: 'event-9',
        permit_id: 'permit-1',
        event_type: 'CRO_SENT_BACK_TO_APPLICANT',
        from_status: 'PENDING_CRO',
        to_status: 'PENDING_CORRECTION',
        reason: 'Isolation points are incomplete.',
        occurred_at: '2026-08-22T10:00:00.000Z',
      },
    ] as never,
  });

  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': { body: detail },
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
    'PATCH /api/v1/permits/permit-1': { body: { permit: { ...detail.permit, version: 8 } } },
    'PATCH /api/v1/permits/permit-1/jsa': { body: { permit: { ...detail.permit, version: 9 }, jsa: detail.jsa } },
    'POST /api/v1/permits/permit-1/resubmit': { body: { permit: { ...detail.permit, status: 'PENDING_CRO' } } },
    'POST /api/v1/permits/permit-1/submit': { body: { permit: { ...detail.permit, status: 'PENDING_CRO' } } },
    ...extraRoutes,
  });

  return {
    ...harness,
    ...renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
        <Route path={ROUTES.records} element={<div data-testid="records-page" />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    ),
  };
}

describe('a V2 permit returned for correction', () => {
  it('opens the V2 editing controls for an applicant the server says may update it', async () => {
    renderCorrection();
    expect(await screen.findByTestId('permit-draft-editor')).toBeInTheDocument();

    // Real controls, not the read-only document.
    const band = within(screen.getByTestId(`checklist-${firstSection.id}`));
    expect(band.getAllByRole('radio').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('WTG Number')).toBeInstanceOf(HTMLInputElement);
  });

  it('never renders a V1 editor or a V1 document', async () => {
    renderCorrection();
    await screen.findByTestId('permit-draft-editor');

    // The V1 editor is reached through this button, and its fields carry
    // wording the V2 catalogue does not.
    expect(screen.queryByRole('button', { name: /edit permit and jsa/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Permit information' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Response' })).not.toBeInTheDocument();
    // The tabbed record view is not used for an editable record at all.
    expect(screen.queryByRole('tablist', { name: /permit record sections/i })).not.toBeInTheDocument();
  });

  it('shows the applicant why it came back', async () => {
    renderCorrection();
    await screen.findByTestId('permit-draft-editor');
    // The status badge also reads "Returned for correction", so this
    // asserts the banner's own copy and the CRO's reason.
    expect(screen.getByTestId('correction-context')).toBeInTheDocument();
    expect(screen.getByText(/correct it below and resubmit it/i)).toBeInTheDocument();
    expect(screen.getByText(/isolation points are incomplete/i)).toBeInTheDocument();
  });

  it('keeps the values already stored, including a partial payload', async () => {
    renderCorrection();
    await screen.findByTestId('permit-draft-editor');

    expect((screen.getByLabelText('WTG Number') as HTMLInputElement).value).toBe('WTG-14');
    expect((screen.getByLabelText('Wind Farm Name') as HTMLInputElement).value).toBe('North Farm');
    expect((screen.getByLabelText('Site / WTG') as HTMLInputElement).value).toBe('North Farm');

    // The stored answer survives; the bands the payload never carried are
    // present and unanswered.
    const band = within(screen.getByTestId(`checklist-${firstSection.id}`));
    const checked = band.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('aria-label', expect.stringContaining('No'));
    expect(screen.getByTestId('checklist-isolation_points')).toBeInTheDocument();
  });

  it('saves through the V2 save path, carrying the permit version', async () => {
    const user = userEvent.setup();
    const { calls } = renderCorrection();
    await screen.findByTestId('permit-draft-editor');

    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    const permitSave = calls.find((call) => call.method === 'PATCH' && call.url === '/api/v1/permits/permit-1');
    const jsaSave = calls.find((call) => call.method === 'PATCH' && call.url === '/api/v1/permits/permit-1/jsa');
    expect(permitSave).toBeDefined();
    expect(jsaSave).toBeDefined();

    // The permit's own concurrency token, then the version its save
    // returned - one document, one token.
    expect((permitSave!.body as { version: number }).version).toBe(7);
    expect((jsaSave!.body as { version: number }).version).toBe(8);

    // V2 payload shapes, not V1 ones.
    const saved = (permitSave!.body as { form: Record<string, unknown> }).form;
    expect(saved.sections).toBeTypeOf('object');
    expect(saved.generalWork).toBeUndefined();
  });

  it('resubmits through the correction endpoint, never the initial-submit one', async () => {
    const user = userEvent.setup();
    const { calls } = renderCorrection();
    await screen.findByTestId('permit-draft-editor');

    // The button says what the action is.
    const resubmit = screen.getByRole('button', { name: /^resubmit$/i });
    expect(screen.queryByRole('button', { name: /^submit$/i })).not.toBeInTheDocument();

    await user.click(resubmit);
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

    const posted = calls.filter((call) => call.method === 'POST');
    expect(posted.map((call) => call.url)).toEqual(['/api/v1/permits/permit-1/resubmit']);
    expect(calls.some((call) => call.url.endsWith('/submit'))).toBe(false);

    // Resubmitting sends the corrected document before asking for the
    // decision on it - the same rule as a first submission - so the
    // version posted is the one those saves returned (7 -> 8 -> 9).
    expect(
      calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      'PATCH /api/v1/permits/permit-1',
      'PATCH /api/v1/permits/permit-1/jsa',
      'POST /api/v1/permits/permit-1/resubmit',
    ]);
    expect(posted[0]!.body).toEqual({ version: 9 });
  });

  it('leaves the correction screen once the resubmission succeeds', async () => {
    const user = userEvent.setup();
    renderCorrection();
    await screen.findByTestId('permit-draft-editor');

    await user.click(screen.getByRole('button', { name: /^resubmit$/i }));
    expect(await screen.findByTestId('records-page')).toBeInTheDocument();
    expect(screen.queryByTestId('permit-draft-editor')).not.toBeInTheDocument();
    expect(screen.getByText(/permit resubmitted for cro review/i)).toBeInTheDocument();
  });

  it('offers no onward action when the server does not', async () => {
    // `update` without `resubmit`: the document may be corrected, but
    // sending it on is not this person's to do.
    renderCorrection({ availableActions: ['update'] });
    await screen.findByTestId('permit-draft-editor');
    expect(screen.queryByRole('button', { name: /^resubmit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^submit$/i })).not.toBeInTheDocument();
    // Editing itself is untouched.
    expect(screen.getByRole('button', { name: /save draft/i })).toBeInTheDocument();
  });
});

describe('a V2 draft is unaffected', () => {
  it('still submits through the initial-submission endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = renderCorrection({ status: 'DRAFT', availableActions: ['update', 'submit'] });
    await screen.findByTestId('permit-draft-editor');

    expect(screen.queryByRole('button', { name: /^resubmit$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

    const posted = calls.filter((call) => call.method === 'POST');
    expect(posted.map((call) => call.url)).toEqual(['/api/v1/permits/permit-1/submit']);
    expect(screen.getByText(/permit submitted for cro review/i)).toBeInTheDocument();
  });

  it('shows no correction banner on a draft', async () => {
    renderCorrection({ status: 'DRAFT', availableActions: ['update', 'submit'] });
    await screen.findByTestId('permit-draft-editor');
    expect(screen.queryByTestId('correction-context')).not.toBeInTheDocument();
  });
});

describe('a V1 permit returned for correction is unchanged', () => {
  it('still uses the V1 record view and its own editor', async () => {
    const user = userEvent.setup();
    renderCorrection({ formVersion: 'WTG_WORK_V1', permitPayload: null });

    // The V1 tabbed record view, with its Edit control - not the V2 editor.
    expect(await screen.findByRole('button', { name: /edit permit and jsa/i })).toBeInTheDocument();
    expect(screen.queryByTestId('permit-draft-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: /permit record sections/i })).toBeInTheDocument();
    // The V1 screen's own send-back notice, not the V2 banner.
    expect(screen.getByText(/a control room operator has returned this permit/i)).toBeInTheDocument();
    expect(screen.queryByTestId('correction-context')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /edit permit and jsa/i }));
    expect(await screen.findByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });

  it('still offers resubmit from the V1 action bar', async () => {
    renderCorrection({ formVersion: 'WTG_WORK_V1', permitPayload: null });
    await screen.findByRole('button', { name: /edit permit and jsa/i });
    expect(screen.getByRole('button', { name: /resubmit/i })).toBeInTheDocument();
  });
});
