import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { FormCatalogue } from '../../../api/catalogue';
import type {
  CurrentUser,
  JsaFormPayload,
  PermitDetailResponse,
  PermitFormPayload,
  PermitStatus,
} from '../../../api/types';
import { croEmployee, jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';
import { emptyJsaValues, emptyPermitValues } from './values';

/**
 * THE AUTHORITATIVE IDENTITY BAND SAYS WHO, NOT HOW.
 *
 * The permit number, the JSA number and the applicant's own name are
 * server-derived: the applicant cannot type them, and never could. The
 * document used to say so out loud, printing "(set by the system)" after
 * each of those values while the permit was being filled in.
 *
 * That is an implementation detail wearing the clothes of a field.
 * Somebody reading their own name beside the word "Applicant" does not
 * need to be told which part of the software put it there, and the
 * absence of any control already says it cannot be typed over.
 *
 * SO THE WORDING IS GONE AND THE AUTHORITY IS NOT. These specs assert
 * both halves: the values are still displayed on every surface, there is
 * still no input for them anywhere, and the annotation appears nowhere.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const wtg = catalogue.permits.WTG_WORK;

/** Every phrasing of the same implementation detail. */
const SYSTEM_SET_WORDING =
  /set by the system|set by system|system[- ]set|automatically set|set automatically|auto-?filled|cannot be changed here|records this identity/i;

const PERMIT_PAYLOAD = emptyPermitValues('WTG_WORK', wtg) as unknown as PermitFormPayload;
const JSA_PAYLOAD = emptyJsaValues(catalogue) as unknown as JsaFormPayload;

const AUTHORITATIVE = {
  permitNumber: 'WTG-1',
  applicantName: 'Mr. Gulraiz',
  applicantCompany: 'E-SET',
  jsaNumber: '000001',
};

function detailFor(status: PermitStatus, actions: PermitDetailResponse['availableActions'] = []) {
  return permitDetail({
    permit: permit({
      permit_type: 'WTG_WORK',
      form_version: 'WTG_WORK_V2',
      status,
      permitDisplayNumber: AUTHORITATIVE.permitNumber,
      applicant_display_name: AUTHORITATIVE.applicantName,
      applicant_identity_kind: 'NORMAL',
      applicant_company_name: 'E-SET',
      form_payload: PERMIT_PAYLOAD,
      issued_at: status === 'ISSUED' || status === 'CLOSED' ? '2026-08-21T09:00:00.000Z' : null,
    }),
    jsa: jsa({ form_version: 'JSA_V2', form_payload: JSA_PAYLOAD, jsaDisplayNumber: AUTHORITATIVE.jsaNumber }),
    availableActions: actions,
  });
}

function renderRecord(detail: PermitDetailResponse, user: CurrentUser = normalEmployee()) {
  stubFetch({
    'GET /api/v1/permits/permit-1': { body: detail },
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
  });
  return renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    user,
    { route: '/permits/permit-1' },
  );
}

/** The band the identity is printed in, on whichever surface is rendered. */
async function identityBand(): Promise<HTMLElement> {
  const applicant = await screen.findByText('Applicant');
  return applicant.closest('.doc__fields, .doc__field, section, div')! as HTMLElement;
}

// ---------------------------------------------------------------------
// The applicant filling the permit in
// ---------------------------------------------------------------------

describe('the draft editor, where the wording used to appear', () => {
  it('shows the identity without explaining where it came from', async () => {
    // In the editor the band is drawn from the SIGNED-IN user, not from
    // the stored permit - it is who this draft will be recorded as.
    const { container } = renderRecord(detailFor('DRAFT', ['update', 'submit']), normalEmployee());
    await screen.findByTestId('permit-draft-editor');

    // The values are all still printed.
    expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0);
    expect(screen.getAllByText(AUTHORITATIVE.jsaNumber).length).toBeGreaterThan(0);

    expect(container.textContent ?? '').not.toMatch(SYSTEM_SET_WORDING);
  });

  it('still refuses to let the applicant type over any of it', async () => {
    const { container } = renderRecord(detailFor('DRAFT', ['update', 'submit']), normalEmployee());
    await screen.findByTestId('permit-draft-editor');

    // The editor has plenty of real inputs...
    expect(container.querySelectorAll('input, textarea').length).toBeGreaterThan(10);

    // ...and none of them holds an authoritative value. A field with no
    // control cannot be edited, whatever the screen says or does not say
    // about it.
    const controlValues = [...container.querySelectorAll<HTMLInputElement>('input, textarea')].map(
      (element) => element.value,
    );
    for (const value of ['Ali Khan', AUTHORITATIVE.jsaNumber, AUTHORITATIVE.permitNumber, 'E-SET']) {
      expect(controlValues).not.toContain(value);
      // Every printed copy of the value is text, never a control.
      for (const printed of screen.queryAllByText(value)) {
        expect(printed.closest('input, textarea, select')).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------
// Everyone else's view of the same document
// ---------------------------------------------------------------------

describe('every read-only surface', () => {
  const cases: Array<{ label: string; status: PermitStatus; user: () => CurrentUser }> = [
    { label: 'CRO review', status: 'PENDING_CRO', user: croEmployee },
    {
      label: 'HSE review',
      status: 'PENDING_HSE',
      user: () =>
        normalEmployee({
          auth: { id: 'user-hse', email: 'hse@eset.example.com' },
          capabilities: ['permit.hse_review'],
        }),
    },
    { label: 'the applicant’s issued record', status: 'ISSUED', user: normalEmployee },
    { label: 'a closed permit', status: 'CLOSED', user: croEmployee },
  ];

  for (const { label, status, user } of cases) {
    it(`${label} shows the identity and none of the wording`, async () => {
      const { container } = renderRecord(detailFor(status), user());
      await identityBand();

      expect(screen.getByText(AUTHORITATIVE.applicantName)).toBeInTheDocument();
      expect(screen.getByText(AUTHORITATIVE.permitNumber)).toBeInTheDocument();
      expect(container.textContent ?? '').not.toMatch(SYSTEM_SET_WORDING);
    });
  }

  it('keeps the applicant name, company, permit number and JSA number on the document', async () => {
    renderRecord(detailFor('ISSUED'));
    const band = within(await identityBand());
    expect(band.getByText('Applicant')).toBeInTheDocument();
    expect(screen.getByText(AUTHORITATIVE.applicantName)).toBeInTheDocument();
    expect(screen.getByText('E-SET')).toBeInTheDocument();
    expect(screen.getByText(AUTHORITATIVE.jsaNumber)).toBeInTheDocument();
  });

  it('the JSA carries its own authoritative numbers, unannotated', async () => {
    const { container } = renderRecord(detailFor('ISSUED'));
    await identityBand();
    await userEvent.setup().click(screen.getByRole('tab', { name: /job safety analysis/i }));
    await screen.findByTestId('jsa-page-1');

    expect(screen.getAllByText(AUTHORITATIVE.jsaNumber).length).toBeGreaterThan(0);
    expect(container.textContent ?? '').not.toMatch(SYSTEM_SET_WORDING);
  });

  it('offers no control for anything on a record under review', async () => {
    const { container } = renderRecord(detailFor('PENDING_CRO'), croEmployee());
    await identityBand();
    // A record under review is read-only throughout: the document draws
    // values, never inputs.
    expect(container.querySelectorAll('input, textarea')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// The V1 document, which explained itself in the same way
// ---------------------------------------------------------------------

/**
 * The V1 record's Applicant band used to carry a sentence saying the
 * identity "is recorded by the system when the permit is submitted".
 * It is gone: `DocumentField` already renders an unrecorded value as
 * "Not recorded", so the band reads correctly with nothing added, and
 * where the value DOES exist there was never anything to explain.
 */
function renderV1(applicantName: string | null, user: CurrentUser = normalEmployee()) {
  const detail = permitDetail({
    permit: permit({
      permit_type: 'HOT_WORK',
      form_version: 'HOT_WORK_V1',
      status: 'ISSUED',
      permitDisplayNumber: 'HW-3',
      issued_at: '2026-08-21T09:00:00.000Z',
      applicant_identity_kind: applicantName ? 'NORMAL' : null,
      applicant_display_name: applicantName,
      applicant_company_name: applicantName ? 'E-SET' : null,
    }),
    availableActions: [],
  });
  stubFetch({ 'GET /api/v1/permits/permit-1': { body: detail } });
  return renderAs(
    <Routes>
      <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
    </Routes>,
    user,
    { route: '/permits/permit-1' },
  );
}

describe('the V1 read-only document', () => {
  it('shows the applicant when there is one, and explains nothing', async () => {
    const { container } = renderV1('Gulraiz');
    const band = (await screen.findByRole('heading', { name: /^applicant$/i })).closest('section')!;

    expect(within(band).getByText('Mr. Gulraiz')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/is recorded by the system/i);
    expect(container.textContent ?? '').not.toMatch(SYSTEM_SET_WORDING);
  });

  it('says "Not recorded" - and nothing more - when no applicant is recorded yet', async () => {
    const { container } = renderV1(null);
    const band = (await screen.findByRole('heading', { name: /^applicant$/i })).closest('section')!;

    // The empty state the field already had, with no sentence beneath it.
    expect(within(band).getByText('Not recorded')).toBeInTheDocument();
    expect(within(band).queryByText(/recorded by the system/i)).not.toBeInTheDocument();
    expect(within(band).queryByText(/when the permit is submitted/i)).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(SYSTEM_SET_WORDING);
  });

  it('offers no control for the identity either way', async () => {
    const { container } = renderV1('Gulraiz', croEmployee());
    await screen.findByRole('heading', { name: /^applicant$/i });
    // A V1 record is read-only throughout: the document draws values.
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(screen.getByText('Mr. Gulraiz').closest('input, textarea, select')).toBeNull();
  });
});
