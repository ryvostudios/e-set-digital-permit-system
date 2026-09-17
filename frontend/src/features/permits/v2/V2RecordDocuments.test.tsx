import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type {
  JsaFormPayload,
  PermitDetailResponse,
  PermitFormPayload,
  PermitSignature,
  PermitStatus,
} from '../../../api/types';
import { PERMIT_STATUSES } from '../../../api/types';
import { croEmployee, jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';
import { emptyJsaValues, emptyPermitValues } from './values';
import type { FormCatalogue } from '../../../api/catalogue';

/**
 * THE HOSTED BLANK SCREEN, SECOND CAUSE: a V2 record drawn by the V1
 * renderer.
 *
 * `PermitDetailPage` sent a V2 record to `V2DraftScreen` only when it was
 * a DRAFT its owner could edit. Everything else - a draft someone else is
 * looking at, a permit under CRO or HSE review, an issued or closed one -
 * fell through to the tabbed view and its V1 `PermitDocument` /
 * `JsaDocument`. Those read a V1 payload's arrays straight off whatever
 * they are handed:
 *
 *     ChecklistTable({ items }) -> items.length === 0
 *
 * A V2 payload has no `generalWork` array to read, so `items` was
 * `undefined` and the record screen went blank with
 * `Cannot read properties of undefined (reading 'length')`.
 *
 * These specs walk the whole V2 lifecycle through the real route and the
 * real components. They fail against the version that fell through to V1.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const wtg = catalogue.permits.WTG_WORK;

/**
 * A STRUCTURALLY COMPLETE V2 payload - and therefore one that carries
 * none of the arrays the V1 `ChecklistTable` reads. This is the hosted
 * failure fixture: nothing about it is malformed, it is simply the other
 * generation's shape.
 */
const V2_PERMIT_PAYLOAD = emptyPermitValues('WTG_WORK', wtg) as unknown as PermitFormPayload;
const V2_JSA_PAYLOAD = emptyJsaValues(catalogue) as unknown as JsaFormPayload;

/** The same, half-filled: what the server stores for a partly completed permit. */
const PARTIAL_V2_PERMIT_PAYLOAD = {
  permitIssue: { wtgNumber: 'WTG-14' },
  sections: { [wtg.checklistSections[0]!.id]: { [wtg.checklistSections[0]!.items[0]!.id]: { response: 'NO' } } },
} as unknown as PermitFormPayload;

const PARTIAL_V2_JSA_PAYLOAD = { page1: { siteOrWtg: 'North Farm' } } as unknown as JsaFormPayload;

function signature(): PermitSignature {
  return {
    id: 'sig-1',
    permit_id: 'permit-1',
    source_event_id: 'event-1',
    signature_role: 'CRO',
    signer_user_id: 'user-cro',
    signer_display_name: 'Hamza Tariq',
    signer_team_position_id: 'tp-ebop-cro',
    signer_team_name: 'E-BOP',
    signer_position_name: 'CRO',
    signed_at: '2026-08-21T09:00:00.000Z',
    created_at: '2026-08-21T09:00:00.000Z',
  };
}

function v2Detail(overrides: {
  status?: PermitStatus;
  availableActions?: PermitDetailResponse['availableActions'];
  permitPayload?: PermitFormPayload | null;
  jsaPayload?: JsaFormPayload | null;
  signatures?: PermitSignature[];
} = {}): PermitDetailResponse {
  const status = overrides.status ?? 'PENDING_CRO';
  return permitDetail({
    permit: permit({
      permit_type: 'WTG_WORK',
      form_version: 'WTG_WORK_V2',
      status,
      form_payload: overrides.permitPayload === undefined ? V2_PERMIT_PAYLOAD : overrides.permitPayload,
      issued_at: status === 'ISSUED' || status === 'CLOSED' ? '2026-08-21T09:00:00.000Z' : null,
    }),
    jsa: jsa({
      form_version: 'JSA_V2',
      form_payload: overrides.jsaPayload === undefined ? V2_JSA_PAYLOAD : overrides.jsaPayload,
    }),
    availableActions: overrides.availableActions ?? [],
    signatures: overrides.signatures ?? [],
  });
}

function renderRecord(detail: PermitDetailResponse, user = normalEmployee()) {
  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': { body: detail },
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
  });
  return {
    ...harness,
    ...renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      user,
      { route: '/permits/permit-1' },
    ),
  };
}

/** Opens the JSA tab and waits for the document that tab draws. */
async function openJsaTab() {
  const visible = screen.queryByTestId('jsa-page-1');
  if (visible) return visible;
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /job safety analysis/i }));
  return screen.findByTestId('jsa-page-1');
}

describe('continuous CRO and HSE review', () => {
  for (const review of [
    { status: 'PENDING_CRO' as const, user: croEmployee(), actions: ['forward_hse', 'send_back'] as const },
    { status: 'PENDING_HSE' as const, user: normalEmployee({ capabilities: ['permit.hse_review'] }), actions: ['hse_approve', 'hse_send_back'] as const },
  ]) {
    it(`${review.status} keeps Permit, JSA page 1 and JSA page 2 in one read-only document beside History`, async () => {
      renderRecord(v2Detail({ status: review.status, availableActions: [...review.actions] }), review.user);

      const document = await screen.findByTestId('continuous-review-document');
      expect(await within(document).findByTestId('permit-document-WTG_WORK')).toBeInTheDocument();
      expect(within(document).getByTestId('jsa-page-1')).toBeInTheDocument();
      expect(within(document).getByTestId('jsa-page-2')).toBeInTheDocument();
      expect(screen.getByTestId('review-history-column')).not.toBe(document);
      expect(screen.queryByRole('tablist', { name: /permit record sections/i })).not.toBeInTheDocument();
      expect(within(document).queryAllByRole('textbox')).toHaveLength(0);
      expect(within(document).queryAllByRole('radio')).toHaveLength(0);
    });
  }

  it('preserves CRO send-back and forward actions', async () => {
    renderRecord(v2Detail({ status: 'PENDING_CRO', availableActions: ['forward_hse', 'send_back'] }), croEmployee());
    expect(await screen.findByRole('button', { name: /forward to hse/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /return for correction/i })).toBeInTheDocument();
  });

  it('preserves HSE approval and send-back actions', async () => {
    renderRecord(v2Detail({ status: 'PENDING_HSE', availableActions: ['hse_approve', 'hse_send_back'] }));
    expect(await screen.findByRole('button', { name: /approve and issue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /return to cro/i })).toBeInTheDocument();
  });
});

describe('a V2 draft its owner may edit', () => {
  it('still opens the V2 editor, unchanged', async () => {
    renderRecord(v2Detail({ status: 'DRAFT', availableActions: ['update', 'submit'] }));
    expect(await screen.findByTestId('permit-draft-editor')).toBeInTheDocument();
    // The editor, not the tabbed record view.
    expect(screen.queryByRole('tablist', { name: /permit record sections/i })).not.toBeInTheDocument();
  });
});

describe('every V2 record the owner may not edit renders the V2 documents', () => {
  const cases: { label: string; status: PermitStatus }[] = [
    { label: 'a DRAFT someone else is looking at', status: 'DRAFT' },
    { label: 'PENDING_CRO', status: 'PENDING_CRO' },
    { label: 'PENDING_HSE', status: 'PENDING_HSE' },
    { label: 'PENDING_CORRECTION', status: 'PENDING_CORRECTION' },
    { label: 'ISSUED', status: 'ISSUED' },
    { label: 'HELD', status: 'HELD' },
    { label: 'CANCELLED', status: 'CANCELLED' },
    { label: 'CLOSED', status: 'CLOSED' },
  ];

  for (const { label, status } of cases) {
    it(`${label} draws the V2 permit document, not the V1 one`, async () => {
      renderRecord(v2Detail({ status }));
      expect(await screen.findByTestId('permit-document-WTG_WORK')).toBeInTheDocument();

      // Every printed band, from the catalogue.
      for (const section of wtg.checklistSections) {
        expect(screen.getByTestId(`checklist-${section.id}`)).toBeInTheDocument();
      }
      // V1-only furniture: its own "Permit information" band and its
      // Item/Response/Remarks checklist columns.
      expect(screen.queryByRole('heading', { name: 'Permit information' })).not.toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Response' })).not.toBeInTheDocument();
    });

    it(`${label} draws the V2 JSA document, not the V1 one`, async () => {
      renderRecord(v2Detail({ status }));
      await screen.findByTestId('permit-document-WTG_WORK');
      await openJsaTab();

      expect(screen.getByTestId('jsa-page-2')).toBeInTheDocument();
      expect(within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Job information' })).not.toBeInTheDocument();
    });
  }

  it('covers every status the backend defines', () => {
    expect(cases.map((entry) => entry.status).sort()).toEqual([...PERMIT_STATUSES].sort());
  });
});

describe('the record is read-only', () => {
  it('renders no controls on a V2 permit under review', async () => {
    renderRecord(v2Detail({ status: 'PENDING_CRO' }));
    await screen.findByTestId('permit-document-WTG_WORK');
    const band = within(screen.getByTestId(`checklist-${wtg.checklistSections[0]!.id}`));
    expect(band.queryAllByRole('radio')).toHaveLength(0);
    expect(band.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('stays read-only for a V2 correction the viewer has no authority over', async () => {
    // Same status, no `update` hint: a reviewer looking at someone
    // else's returned permit reads it, and edits nothing.
    renderRecord(v2Detail({ status: 'PENDING_CORRECTION', availableActions: [] }));
    await screen.findByTestId('permit-document-WTG_WORK');
    expect(screen.queryByTestId('permit-draft-editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resubmit/i })).not.toBeInTheDocument();
    const band = within(screen.getByTestId(`checklist-${wtg.checklistSections[0]!.id}`));
    expect(band.queryAllByRole('radio')).toHaveLength(0);
  });
});

describe('the authorizations a V2 record carries', () => {
  it('shows the frozen digital signatures, as the V1 record does', async () => {
    renderRecord(v2Detail({ status: 'ISSUED', signatures: [signature()] }), croEmployee());
    await screen.findByTestId('permit-document-WTG_WORK');
    expect(screen.getByText('Hamza Tariq')).toBeInTheDocument();
    expect(screen.getByText('CRO · E-BOP')).toBeInTheDocument();
  });

  it('says so plainly when nothing has been signed yet', async () => {
    renderRecord(v2Detail({ status: 'PENDING_CRO' }));
    await screen.findByTestId('permit-document-WTG_WORK');
    expect(screen.getByText(/no authorizations have been recorded yet/i)).toBeInTheDocument();
  });
});

describe('a partial or absent V2 payload', () => {
  it('renders a partly completed V2 record without crashing', async () => {
    renderRecord(
      v2Detail({
        status: 'PENDING_CRO',
        permitPayload: PARTIAL_V2_PERMIT_PAYLOAD,
        jsaPayload: PARTIAL_V2_JSA_PAYLOAD,
      }),
    );
    expect(await screen.findByTestId('permit-document-WTG_WORK')).toBeInTheDocument();
    // What the applicant did enter is shown...
    expect(screen.getByText('WTG-14')).toBeInTheDocument();
    // ...and the bands they never reached are present and unanswered.
    for (const section of wtg.checklistSections) {
      expect(screen.getByTestId(`checklist-${section.id}`)).toBeInTheDocument();
    }
    await openJsaTab();
    expect(within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis')).toBeInTheDocument();
  });

  it('says a V2 permit has not been filled in rather than showing a blank form as filled', async () => {
    renderRecord(v2Detail({ status: 'DRAFT', permitPayload: null, jsaPayload: null }));
    await screen.findByTestId('permit-document-WTG_WORK');
    expect(screen.getByText(/this permit has not been filled in yet/i)).toBeInTheDocument();

    await openJsaTab();
    expect(screen.getByText(/has not been completed yet/i)).toBeInTheDocument();
  });
});

describe('a V1 record is untouched', () => {
  it('still renders through the V1 documents', async () => {
    const detail = permitDetail({
      permit: permit({
        permit_type: 'WTG_WORK',
        form_version: 'WTG_WORK_V1',
        status: 'PENDING_CRO',
        form_payload: null,
      }),
      availableActions: [],
    });
    const { calls } = renderRecord(detail);
    // The V1 document's own furniture, which the V2 document has not.
    expect(await screen.findByRole('heading', { name: 'Permit information' })).toBeInTheDocument();
    expect(screen.queryByTestId('permit-document-WTG_WORK')).not.toBeInTheDocument();

    // ...and a V1 record does not fetch a catalogue it never draws from.
    expect(calls.filter((call) => call.url.includes('/catalogue'))).toHaveLength(0);
  });

  it('still offers the V1 editor to an owner the server says may update', async () => {
    const detail = permitDetail({
      permit: permit({ permit_type: 'WTG_WORK', form_version: 'WTG_WORK_V1', status: 'PENDING_CORRECTION' }),
      availableActions: ['update', 'resubmit'],
    });
    renderRecord(detail);
    expect(await screen.findByRole('button', { name: /edit permit and jsa/i })).toBeInTheDocument();
  });
});
