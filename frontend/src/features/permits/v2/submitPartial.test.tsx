import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { FormCatalogue, PermitTypeKey } from '../../../api/catalogue';
import type { PermitDetailResponse, PermitFormPayload, PermitType } from '../../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';

/**
 * SUBMITTING A PARTLY COMPLETED V2 PERMIT.
 *
 * The rule, which the server owns: a permit may be submitted partly
 * completed - a blank printed question usually means "not applicable to
 * this job" - and the ONLY refusal is a document carrying nothing anyone
 * entered, which comes back as `empty_submission`.
 *
 * The screen used to break that rule without ever deciding anything.
 * Everything typed into the document lives in React state until it is
 * saved, and Submit called the submit endpoint directly - so a permit
 * filled in and submitted in one sitting reached a server that had never
 * been sent it, still holding `form_payload = NULL`. The server refused
 * it as "missing required fields", and filling the form in further could
 * never clear that, because the problem was never the form.
 *
 * These specs drive the real screen against a fake backend that applies
 * the REAL rule: it refuses a submission when no permit form was ever
 * stored, and refuses an empty one with `empty_submission`. Passing them
 * requires the screen to send the document before asking for a decision
 * on it.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;

const PERMIT_TYPES: { type: PermitTypeKey; label: string; field: string }[] = [
  { type: 'WTG_WORK', label: 'WTG Work', field: 'WTG Number' },
  { type: 'COLD_WORK', label: 'Cold Work', field: 'Equipment' },
  { type: 'HOT_WORK', label: 'Hot Work', field: 'Equipment' },
  { type: 'CONFINED_SPACE_ENTRY', label: 'Confined Space Entry', field: 'Equipment' },
];

/**
 * A backend that stores what it is sent and applies the submission rule
 * to THAT - not to whatever the test wishes had been sent.
 */
function stubPermitBackend(permitType: PermitTypeKey, storedPermitForm: PermitFormPayload | null = null) {
  const state = {
    version: 3,
    permitForm: storedPermitForm as unknown,
    jsaForm: null as unknown,
    submitted: false,
    submitBody: null as unknown,
  };

  const detail = (): PermitDetailResponse =>
    permitDetail({
      permit: permit({
        permit_type: permitType as PermitType,
        form_version: `${permitType}_V2`,
        status: 'DRAFT',
        version: state.version,
        form_payload: state.permitForm as PermitFormPayload | null,
      }),
      jsa: jsa({ form_version: 'JSA_V2', form_payload: state.jsaForm as never }),
      availableActions: ['update', 'submit'],
    });

  /** Mirrors `hasMeaningfulSubmissionContent`: text, a tick, or a Yes/No/N-A a person chose. */
  const meaningful = (value: unknown): boolean => {
    if (typeof value === 'string') return value.trim() !== '';
    if (value === true) return true;
    if (Array.isArray(value)) return value.some(meaningful);
    if (value && typeof value === 'object') return Object.values(value).some(meaningful);
    return false;
  };

  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': () => ({ body: detail() }),
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
    'PATCH /api/v1/permits/permit-1': (_url, init) => {
      state.permitForm = (JSON.parse(String(init?.body)) as { form: unknown }).form;
      state.version += 1;
      return { body: { permit: detail().permit } };
    },
    'PATCH /api/v1/permits/permit-1/jsa': (_url, init) => {
      state.jsaForm = (JSON.parse(String(init?.body)) as { form: unknown }).form;
      state.version += 1;
      return { body: { permit: detail().permit, jsa: detail().jsa } };
    },
    'POST /api/v1/permits/permit-1/submit': (_url, init) => {
      state.submitBody = JSON.parse(String(init?.body));
      // The server's own order of refusals, in the server's own words.
      if (!state.permitForm || !state.jsaForm) {
        return {
          status: 422,
          body: {
            error: 'invalid_state',
            reason: 'missing_required_fields',
            message: 'Permit is missing required fields for submission',
          },
        };
      }
      if (!meaningful(state.permitForm) && !meaningful(state.jsaForm)) {
        return {
          status: 422,
          body: {
            error: 'invalid_state',
            reason: 'empty_submission',
            message: 'Enter at least one detail before submitting this permit',
          },
        };
      }
      state.submitted = true;
      return { body: { permit: { ...detail().permit, status: 'PENDING_CRO' } } };
    },
  });

  return { state, ...harness };
}

function renderDraft(permitType: PermitTypeKey, storedPermitForm: PermitFormPayload | null = null) {
  const backend = stubPermitBackend(permitType, storedPermitForm);
  return {
    ...backend,
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

/** Types one meaningful value into the document - nothing else is filled in. */
async function enterOneDetail(field: string, value: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(field), value);
}

async function clickSubmit() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^submit$/i }));
}

describe('a partly completed V2 permit submits', () => {
  for (const { type, label, field } of PERMIT_TYPES) {
    it(`${label}: one entered detail is enough to reach the server`, async () => {
      const { state } = renderDraft(type);
      await screen.findByTestId('permit-draft-editor');

      await enterOneDetail(field, 'Nacelle 12');
      await clickSubmit();

      await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
      expect(state.submitted).toBe(true);
      // What the applicant typed actually reached the server.
      expect(JSON.stringify(state.permitForm)).toContain('Nacelle 12');
    });

    it(`${label}: the screen does not block it, and never says "missing required fields"`, async () => {
      renderDraft(type);
      await screen.findByTestId('permit-draft-editor');

      await enterOneDetail(field, 'Nacelle 12');
      await clickSubmit();

      await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
      expect(screen.queryByText(/missing required fields/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/still need an answer/i)).not.toBeInTheDocument();
    });

    it(`${label}: the document is sent before the decision is asked for`, async () => {
      const { calls } = renderDraft(type);
      await screen.findByTestId('permit-draft-editor');

      await enterOneDetail(field, 'Nacelle 12');
      await clickSubmit();
      await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

      const order = calls
        .filter((call) => call.method !== 'GET')
        .map((call) => `${call.method} ${call.url}`);
      expect(order).toEqual([
        'PATCH /api/v1/permits/permit-1',
        'PATCH /api/v1/permits/permit-1/jsa',
        'POST /api/v1/permits/permit-1/submit',
      ]);
    });

    it(`${label}: the submitted version is the one the save returned`, async () => {
      const { state, calls } = renderDraft(type);
      await screen.findByTestId('permit-draft-editor');

      await enterOneDetail(field, 'Nacelle 12');
      await clickSubmit();
      await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

      const permitSave = calls.find((c) => c.method === 'PATCH' && c.url === '/api/v1/permits/permit-1');
      const jsaSave = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/jsa'));
      // 3 -> 4 -> 5: one document, one concurrency token, carried through.
      expect((permitSave!.body as { version: number }).version).toBe(3);
      expect((jsaSave!.body as { version: number }).version).toBe(4);
      expect(state.submitBody).toEqual({ version: 5 });
    });
  }
});

describe('a document with nothing in it is still refused', () => {
  it('reports empty_submission in the server’s words, not "missing required fields"', async () => {
    renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');

    // Nothing is entered at all.
    await clickSubmit();

    expect(await screen.findByText(/enter at least one detail before submitting this permit/i)).toBeInTheDocument();
    expect(screen.queryByText(/missing required fields/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('records-page')).not.toBeInTheDocument();
  });

  it('sent the blank document, so the server judged the real thing', async () => {
    const { state } = renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');
    await clickSubmit();
    await screen.findByText(/enter at least one detail/i);

    // The blank but structurally complete document reached the server...
    expect(state.permitForm).not.toBeNull();
    expect(state.jsaForm).not.toBeNull();
    // ...and it fabricated no answers on the way: every response is still null.
    const sections = (state.permitForm as { sections: Record<string, Record<string, { response: unknown }>> }).sections;
    const responses = Object.values(sections).flatMap((band) => Object.values(band).map((item) => item.response));
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every((response) => response === null)).toBe(true);
  });
});

describe('what the applicant answered survives the submit', () => {
  it('keeps NO and N/A exactly, and leaves the rest unanswered', async () => {
    const user = userEvent.setup();
    const { state } = renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');

    const section = catalogue.permits.WTG_WORK.checklistSections[0]!;
    const band = within(screen.getByTestId(`checklist-${section.id}`));
    const radios = band.getAllByRole('radio');
    await user.click(radios[1]!); // first question: No
    await user.click(radios[5]!); // second question: N/A

    await clickSubmit();
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

    const answers = (state.permitForm as { sections: Record<string, Record<string, { response: unknown }>> })
      .sections[section.id]!;
    expect(answers[section.items[0]!.id]!.response).toBe('NO');
    expect(answers[section.items[1]!.id]!.response).toBe('NA');
    // Everything nobody answered is still null - not defaulted to NO or NA.
    for (const item of section.items.slice(2)) {
      expect(answers[item.id]!.response).toBeNull();
    }
  });

  it('a NO on its own is meaningful enough to submit', async () => {
    const user = userEvent.setup();
    const { state } = renderDraft('COLD_WORK');
    await screen.findByTestId('permit-draft-editor');

    const section = catalogue.permits.COLD_WORK.checklistSections[0]!;
    const band = within(screen.getByTestId(`checklist-${section.id}`));
    await user.click(band.getAllByRole('radio')[1]!); // No

    await clickSubmit();
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
    expect(state.submitted).toBe(true);
  });
});

describe('saving a draft is unchanged', () => {
  it('still saves without submitting', async () => {
    const user = userEvent.setup();
    const { state, calls } = renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');

    await enterOneDetail('WTG Number', 'WTG-14');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/submit'))).toBe(false);
    expect(state.submitted).toBe(false);
    expect(JSON.stringify(state.permitForm)).toContain('WTG-14');
  });

  it('a save then a submit still submits the current version', async () => {
    const user = userEvent.setup();
    const { state } = renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');

    await enterOneDetail('WTG Number', 'WTG-14');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));
    await clickSubmit();

    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
    expect(state.submitted).toBe(true);
    // 3 -> 4 -> 5 from the explicit save, then 5 -> 6 -> 7 from the submit.
    expect(state.submitBody).toEqual({ version: 7 });
  });
});

describe('a failed save does not become a failed submit', () => {
  it('reports the save error and never calls submit', async () => {
    const backend = stubFetch({
      'GET /api/v1/permits/permit-1': {
        body: permitDetail({
          permit: permit({
            permit_type: 'WTG_WORK',
            form_version: 'WTG_WORK_V2',
            status: 'DRAFT',
            version: 3,
            form_payload: null,
          }),
          jsa: jsa({ form_version: 'JSA_V2', form_payload: null }),
          availableActions: ['update', 'submit'],
        }),
      },
      'GET /api/v1/permits/catalogue': { body: catalogueFixture },
      'PATCH /api/v1/permits/permit-1': { status: 409, body: { error: 'conflict', reason: 'stale_version' } },
    });
    renderAs(
      <Routes>
        <Route path={ROUTES.permitPattern} element={<PermitDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/permits/permit-1' },
    );
    await screen.findByTestId('permit-draft-editor');

    await enterOneDetail('WTG Number', 'WTG-14');
    await clickSubmit();

    await waitFor(() =>
      expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(true),
    );
    // Submit is never reached, and nothing entered is lost.
    expect(backend.calls.some((call) => call.url.endsWith('/submit'))).toBe(false);
    expect((screen.getByLabelText('WTG Number') as HTMLInputElement).value).toBe('WTG-14');
  });
});
