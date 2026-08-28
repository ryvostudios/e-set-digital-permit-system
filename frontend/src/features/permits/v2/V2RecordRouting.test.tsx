import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { JsaFormPayload, PermitDetailResponse, PermitFormPayload, PermitStatus } from '../../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';

/**
 * WHICH RENDERER A RECORD REACHES.
 *
 * The sibling spec proves the V2 documents come out right. This one
 * proves the negative that the hosted failure was: a V2 record must never
 * be handed to the V1 `PermitDocument` or `JsaDocument` at all.
 *
 * Asserting that from the DOM alone is indirect - it infers "V1 did not
 * run" from V1 furniture being absent. So the two legacy documents are
 * replaced here by markers. If the record screen ever routes a V2 record
 * to one of them again, the marker appears and these fail, whatever the
 * legacy component would have done with the payload.
 *
 * They are ONLY markers in this file. The real V1 documents are rendered,
 * unmocked, by `PermitDetailPage.test.tsx` and by the sibling spec.
 */

vi.mock('../PermitDocument', () => ({
  PermitDocument: () => <div data-testid="v1-permit-document" />,
}));

vi.mock('../JsaDocument', () => ({
  JsaDocument: () => <div data-testid="v1-jsa-document" />,
}));

// The V1 EDITORS matter for the same reason: a V2 permit returned for
// correction is editable, and must be edited in the V2 editor.
vi.mock('../forms/PermitFormFields', () => ({
  PermitFormFields: () => <div data-testid="v1-permit-fields" />,
}));

vi.mock('../forms/JsaFormFields', () => ({
  JsaFormFields: () => <div data-testid="v1-jsa-fields" />,
}));

const catalogue = catalogueFixture as unknown as { permits: Record<string, unknown> };

/** A V2 payload. Its defining property here is that it holds none of the V1 arrays. */
const V2_PERMIT_PAYLOAD = { permitIssue: { wtgNumber: 'WTG-14' }, sections: {} } as unknown as PermitFormPayload;
const V2_JSA_PAYLOAD = { page1: { siteOrWtg: 'North Farm' } } as unknown as JsaFormPayload;

function detailFor(formVersion: string, status: PermitStatus): PermitDetailResponse {
  return permitDetail({
    permit: permit({
      permit_type: 'WTG_WORK',
      form_version: formVersion,
      status,
      form_payload: V2_PERMIT_PAYLOAD,
    }),
    jsa: jsa({ form_payload: V2_JSA_PAYLOAD }),
    availableActions: [],
  });
}

function renderRecord(detail: PermitDetailResponse) {
  stubFetch({
    'GET /api/v1/permits/permit-1': { body: detail },
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
  });
  return renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    normalEmployee(),
    { route: '/permits/permit-1' },
  );
}

const V2_STATUSES: PermitStatus[] = [
  'DRAFT',
  'PENDING_CRO',
  'PENDING_HSE',
  'PENDING_CORRECTION',
  'ISSUED',
  'HELD',
  'CANCELLED',
  'CLOSED',
];

describe('a V2 record never reaches a V1 renderer', () => {
  for (const status of V2_STATUSES) {
    it(`does not render the V1 permit document for ${status}`, async () => {
      renderRecord(detailFor('WTG_WORK_V2', status));
      await screen.findByTestId('permit-document-WTG_WORK');
      expect(screen.queryByTestId('v1-permit-document')).not.toBeInTheDocument();
    });

    it(`does not render the V1 JSA document for ${status}`, async () => {
      const user = userEvent.setup();
      renderRecord(detailFor('WTG_WORK_V2', status));
      await screen.findByTestId('permit-document-WTG_WORK');
      await user.click(screen.getByRole('tab', { name: /job safety analysis/i }));
      await screen.findByTestId('jsa-page-1');
      expect(screen.queryByTestId('v1-jsa-document')).not.toBeInTheDocument();
    });
  }

  it('edits a returned V2 permit in the V2 editor, never the V1 one', async () => {
    // PENDING_CORRECTION + `update` is a real grant the backend makes
    // (its EDITABLE_STATUSES are DRAFT and PENDING_CORRECTION), so this
    // record IS editable - just never by the V1 editor.
    const detail = detailFor('WTG_WORK_V2', 'PENDING_CORRECTION');
    renderRecord({ ...detail, availableActions: ['update', 'resubmit'] });
    await screen.findByTestId('permit-draft-editor');
    expect(screen.queryByTestId('v1-permit-fields')).not.toBeInTheDocument();
    expect(screen.queryByTestId('v1-jsa-fields')).not.toBeInTheDocument();
    expect(screen.queryByTestId('v1-permit-document')).not.toBeInTheDocument();
  });

  it('holds for every V2 permit type, not only WTG', async () => {
    for (const permitType of ['COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const) {
      expect(catalogue.permits[permitType]).toBeTruthy();
      const detail = permitDetail({
        permit: permit({
          permit_type: permitType,
          form_version: `${permitType}_V2`,
          status: 'PENDING_CRO',
          form_payload: { workWindow: {}, sections: {} } as unknown as PermitFormPayload,
        }),
        jsa: jsa({ form_payload: V2_JSA_PAYLOAD }),
        availableActions: [],
      });
      const { unmount } = renderRecord(detail);
      await screen.findByTestId(`permit-document-${permitType}`);
      expect(screen.queryByTestId('v1-permit-document')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('a V1 record still goes to the V1 renderers', () => {
  it('renders the V1 permit document', async () => {
    renderRecord(detailFor('WTG_WORK_V1', 'PENDING_CRO'));
    expect(await screen.findByTestId('v1-permit-document')).toBeInTheDocument();
    expect(screen.queryByTestId('permit-document-WTG_WORK')).not.toBeInTheDocument();
  });

  it('renders the V1 JSA document', async () => {
    const user = userEvent.setup();
    renderRecord(detailFor('WTG_WORK_V1', 'PENDING_CRO'));
    await screen.findByTestId('v1-permit-document');
    await user.click(screen.getByRole('tab', { name: /job safety analysis/i }));
    expect(await screen.findByTestId('v1-jsa-document')).toBeInTheDocument();
    expect(screen.queryByTestId('jsa-page-1')).not.toBeInTheDocument();
  });

  it('still edits a returned V1 permit in the V1 editor', async () => {
    const user = userEvent.setup();
    const detail = detailFor('WTG_WORK_V1', 'PENDING_CORRECTION');
    renderRecord({ ...detail, availableActions: ['update', 'resubmit'] });
    await user.click(await screen.findByRole('button', { name: /edit permit and jsa/i }));
    expect(await screen.findByTestId('v1-permit-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('permit-draft-editor')).not.toBeInTheDocument();
  });

  it('routes on the stored form_version alone, never on status or payload shape', async () => {
    // Same V2-shaped payload, V1 form_version: the SERVER's column is
    // what decides, so this goes to V1 - the browser never inspects the
    // payload to guess a generation.
    renderRecord(detailFor('WTG_WORK_V1', 'ISSUED'));
    expect(await screen.findByTestId('v1-permit-document')).toBeInTheDocument();
  });
});
