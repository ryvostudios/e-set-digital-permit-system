import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { JsaFormPayload, PermitFormPayload } from '../../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';

/**
 * THE HOSTED BLANK SCREEN.
 *
 * A V2 draft whose stored payload was PARTIAL - the state a permit is in
 * as soon as a partly completed one can be saved - loaded from the API
 * successfully and then took the page blank, because the screen used the
 * stored payload whole (`stored ?? blank`) the moment it was non-null and
 * handed the documents collections that were not there.
 *
 * This spec drives the real route: the record endpoint returns a partial
 * V2 draft, exactly as the server stores one, and the editor must come up
 * with the applicant's own values in it. It fails against the
 * `?? blank` version of V2DraftScreen and passes against the hydrated one.
 */

const catalogue = catalogueFixture as unknown as { permits: Record<string, { checklistSections: { id: string; items: { id: string }[] }[] }> };
const firstSection = catalogue.permits.WTG_WORK!.checklistSections[0]!;

/**
 * What the backend stores for a barely-started WTG draft. Every printed
 * field the applicant never touched is simply ABSENT - no `sections`
 * beyond the one band they opened, no `isolationPoints`, no `ppe`, and a
 * JSA with no page 2 at all.
 */
const PARTIAL_PERMIT_PAYLOAD = {
  permitIssue: { wtgNumber: 'WTG-14', windFarmName: 'North Farm' },
  sections: {
    [firstSection.id]: { [firstSection.items[0]!.id]: { response: 'NO' } },
  },
} as unknown as PermitFormPayload;

const PARTIAL_JSA_PAYLOAD = {
  page1: { siteOrWtg: 'North Farm' },
} as unknown as JsaFormPayload;

function renderPartialV2Draft() {
  const detail = permitDetail({
    permit: permit({
      permit_type: 'WTG_WORK',
      form_version: 'WTG_WORK_V2',
      status: 'DRAFT',
      form_payload: PARTIAL_PERMIT_PAYLOAD,
    }),
    jsa: jsa({ form_version: 'JSA_V2', form_payload: PARTIAL_JSA_PAYLOAD }),
    availableActions: ['update'],
  });

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
      normalEmployee(),
      { route: '/permits/permit-1' },
    ),
  };
}

describe('a V2 draft whose stored payload is partial', () => {
  it('opens the editor instead of a blank page', async () => {
    renderPartialV2Draft();
    expect(await screen.findByTestId('permit-draft-editor')).toBeInTheDocument();
    expect(screen.getByTestId('permit-document-WTG_WORK')).toBeInTheDocument();
    expect(screen.getByTestId('jsa-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('jsa-page-2')).toBeInTheDocument();
  });

  it('shows every printed band, including the ones the payload never carried', async () => {
    renderPartialV2Draft();
    await screen.findByTestId('permit-draft-editor');

    for (const section of catalogue.permits.WTG_WORK!.checklistSections) {
      expect(screen.getByTestId(`checklist-${section.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('checklist-isolation_points')).toBeInTheDocument();
    // The JSA collection the blank screen died on.
    expect(within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis')).toBeInTheDocument();
  });

  it('keeps what the applicant had already entered', async () => {
    renderPartialV2Draft();
    await screen.findByTestId('permit-draft-editor');

    expect((screen.getByLabelText('WTG Number') as HTMLInputElement).value).toBe('WTG-14');
    expect((screen.getByLabelText('Wind Farm Name') as HTMLInputElement).value).toBe('North Farm');
    expect((screen.getByLabelText('Site / WTG') as HTMLInputElement).value).toBe('North Farm');
  });

  it('does not answer the questions the payload left out', async () => {
    renderPartialV2Draft();
    await screen.findByTestId('permit-draft-editor');

    const band = within(screen.getByTestId(`checklist-${firstSection.id}`));
    const checked = band.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked);
    // Exactly the one answer that was stored - the stored 'NO', and
    // nothing hydration decided on the applicant's behalf.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('aria-label', expect.stringContaining('No'));

    const isolation = within(screen.getByTestId('checklist-isolation_points'));
    expect(isolation.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });
});
