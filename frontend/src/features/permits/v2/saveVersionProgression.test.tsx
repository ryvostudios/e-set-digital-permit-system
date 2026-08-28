import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { PermitDetailResponse, PermitType } from '../../../api/types';
import { jsa, normalEmployee, permit, permitDetail } from '../../../test/factories';
import { renderAs, stubFetch } from '../../../test/harness';
import { PermitDetailPage } from '../PermitDetailPage';

/**
 * THE VERSION A SAVE ISSUES, AND WHAT HAPPENS WHEN THE SECOND WRITE FAILS.
 *
 * Saving is TWO requests - the permit, then its JSA - and each advances
 * the permit's version, because the two are one document under one
 * optimistic-concurrency token. That is the contract; nothing here
 * weakens it.
 *
 * What went wrong hosted: the permit write succeeded (version 2 -> 3) and
 * the JSA write was refused, so the screen kept version 2 while the
 * database had moved to 3. Every later save and submit then carried a
 * version the server had left behind and came back "Permit has changed or
 * is not in the required state" - permanently, until the page was
 * reloaded. The editor showed "Unsaved changes" throughout, because the
 * save that half-succeeded never completed.
 *
 * These specs drive the REAL orchestration in `V2DraftScreen` against a
 * server that tracks a real version, so the progression is observed
 * rather than mocked.
 */

const PERMIT_TYPES: { type: PermitType; field: string }[] = [
  { type: 'WTG_WORK', field: 'WTG Number' },
  { type: 'COLD_WORK', field: 'Equipment' },
  { type: 'HOT_WORK', field: 'Equipment' },
  { type: 'CONFINED_SPACE_ENTRY', field: 'Equipment' },
];

interface ServerOptions {
  /** Refuse the JSA write this many times before accepting it. */
  rejectJsaSaves?: number;
  status?: 'DRAFT' | 'PENDING_CORRECTION';
  actions?: PermitDetailResponse['availableActions'];
}

/**
 * A server that enforces the real optimistic-concurrency rule: a write
 * carrying anything but the current version is a 409, exactly as
 * `sendConflict` produces one.
 */
function stubVersionedBackend(permitType: PermitType, options: ServerOptions = {}) {
  const state = {
    version: 2,
    permitForm: null as unknown,
    jsaForm: null as unknown,
    status: options.status ?? ('DRAFT' as const),
    jsaRejectionsLeft: options.rejectJsaSaves ?? 0,
    submittedVersion: null as number | null,
    resubmittedVersion: null as number | null,
  };

  const conflict = {
    status: 409,
    body: { error: 'conflict', reason: 'stale_version', message: 'Permit has changed or is not in the required state' },
  };

  const detail = (): PermitDetailResponse =>
    permitDetail({
      permit: permit({
        permit_type: permitType,
        form_version: `${permitType}_V2`,
        status: state.status,
        version: state.version,
        form_payload: state.permitForm as never,
      }),
      jsa: jsa({ form_version: 'JSA_V2', form_payload: state.jsaForm as never }),
      availableActions: options.actions ?? ['update', 'submit'],
      history: [],
    });

  const readVersion = (init?: RequestInit): number =>
    (JSON.parse(String(init?.body)) as { version: number }).version;

  const harness = stubFetch({
    'GET /api/v1/permits/permit-1': () => ({ body: detail() }),
    'GET /api/v1/permits/catalogue': { body: catalogueFixture },
    'PATCH /api/v1/permits/permit-1': (_url, init) => {
      if (readVersion(init) !== state.version) return conflict;
      state.permitForm = (JSON.parse(String(init?.body)) as { form: unknown }).form;
      state.version += 1;
      return { body: { permit: detail().permit } };
    },
    'PATCH /api/v1/permits/permit-1/jsa': (_url, init) => {
      if (readVersion(init) !== state.version) return conflict;
      if (state.jsaRejectionsLeft > 0) {
        state.jsaRejectionsLeft -= 1;
        // The server refuses the CONTENT and leaves the version alone -
        // the permit write before it has already been applied.
        return {
          status: 400,
          body: { error: 'invalid_request', reason: 'invalid_form_payload', message: 'Invalid JSA form content' },
        };
      }
      state.jsaForm = (JSON.parse(String(init?.body)) as { form: unknown }).form;
      state.version += 1;
      return { body: { permit: detail().permit, jsa: detail().jsa } };
    },
    'POST /api/v1/permits/permit-1/submit': (_url, init) => {
      if (readVersion(init) !== state.version) return conflict;
      state.submittedVersion = readVersion(init);
      state.version += 1;
      state.status = 'DRAFT';
      return { body: { permit: detail().permit } };
    },
    'POST /api/v1/permits/permit-1/resubmit': (_url, init) => {
      if (readVersion(init) !== state.version) return conflict;
      state.resubmittedVersion = readVersion(init);
      state.version += 1;
      return { body: { permit: detail().permit } };
    },
  });

  return { state, ...harness };
}

function renderDraft(permitType: PermitType, options: ServerOptions = {}) {
  const backend = stubVersionedBackend(permitType, options);
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

const type = async (field: string, value: string) => {
  await userEvent.setup().type(screen.getByLabelText(field), value);
};
const click = async (name: RegExp) => {
  await userEvent.setup().click(screen.getByRole('button', { name }));
};

/** The versions carried by every non-GET request, in order. */
function sentVersions(calls: { method: string; url: string; body: unknown }[]): { call: string; version: number }[] {
  return calls
    .filter((c) => c.method !== 'GET')
    .map((c) => ({ call: `${c.method} ${c.url}`, version: (c.body as { version: number }).version }));
}

describe('the version a save issues is the version the next request uses', () => {
  for (const { type: permitType, field } of PERMIT_TYPES) {
    it(`${permitType}: direct submit of unsaved edits walks 2 -> 3 -> 4 and submits 4`, async () => {
      const { state, calls } = renderDraft(permitType);
      await screen.findByTestId('permit-draft-editor');

      await type(field, 'Drills');
      await click(/^submit$/i);

      await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
      expect(sentVersions(calls)).toEqual([
        { call: 'PATCH /api/v1/permits/permit-1', version: 2 },
        { call: 'PATCH /api/v1/permits/permit-1/jsa', version: 3 },
        { call: 'POST /api/v1/permits/permit-1/submit', version: 4 },
      ]);
      expect(state.submittedVersion).toBe(4);
    });
  }

  it('Save Draft then Submit needs no reload, and never repeats a version', async () => {
    const { state, calls } = renderDraft('HOT_WORK');
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/save draft/i);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    await click(/^submit$/i);
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

    expect(sentVersions(calls).map((entry) => entry.version)).toEqual([2, 3, 4, 5, 6]);
    expect(state.submittedVersion).toBe(6);
    expect(screen.queryByText(/permit has changed/i)).not.toBeInTheDocument();
  });

  it('two sequential saves each advance by two, with no conflict', async () => {
    const { state, calls } = renderDraft('COLD_WORK');
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/save draft/i);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    await type('Area', 'wtg');
    await click(/save draft/i);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    expect(sentVersions(calls).map((entry) => entry.version)).toEqual([2, 3, 4, 5]);
    expect(state.version).toBe(6);
    expect(screen.queryByText(/permit has changed/i)).not.toBeInTheDocument();
  });

  it('the JSA save is what advances the version the second time', async () => {
    const { state, calls } = renderDraft('WTG_WORK');
    await screen.findByTestId('permit-draft-editor');

    await type('WTG Number', 'WTG-14');
    await click(/save draft/i);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    const jsaSave = calls.find((c) => c.url.endsWith('/jsa'));
    // It carries the version the PERMIT save returned...
    expect((jsaSave!.body as { version: number }).version).toBe(3);
    // ...and leaves the permit a version further on again.
    expect(state.version).toBe(4);
  });
});

describe('a rejected JSA save does not strand the editor a version behind', () => {
  it('the next attempt uses the version the permit save already issued', async () => {
    // Exactly the hosted sequence: permit write applied, JSA write refused.
    const { state, calls } = renderDraft('HOT_WORK', { rejectJsaSaves: 1 });
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/^submit$/i);

    // The first attempt fails on the JSA content, and says so.
    expect(await screen.findByText(/some details are not valid/i)).toBeInTheDocument();
    expect(state.version).toBe(3);
    expect(state.submittedVersion).toBeNull();

    // The applicant simply tries again - no reload, no manual step.
    await click(/^submit$/i);
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());

    // The retry picks up at 3, the version the first permit write issued,
    // instead of repeating 2 and conflicting forever.
    expect(sentVersions(calls)).toEqual([
      { call: 'PATCH /api/v1/permits/permit-1', version: 2 },
      { call: 'PATCH /api/v1/permits/permit-1/jsa', version: 3 },
      { call: 'PATCH /api/v1/permits/permit-1', version: 3 },
      { call: 'PATCH /api/v1/permits/permit-1/jsa', version: 4 },
      { call: 'POST /api/v1/permits/permit-1/submit', version: 5 },
    ]);
    expect(state.submittedVersion).toBe(5);
    // The conflict message never appears at all.
    expect(screen.queryByText(/permit has changed or is not in the required state/i)).not.toBeInTheDocument();
  });

  it('a half-completed save leaves the work on screen and the permit editable', async () => {
    renderDraft('HOT_WORK', { rejectJsaSaves: 1 });
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/^submit$/i);
    await screen.findByText(/some details are not valid/i);

    // Nothing the applicant typed is lost, and the editor still works.
    expect((screen.getByLabelText('Equipment') as HTMLInputElement).value).toBe('Drills');
    expect(screen.getByRole('button', { name: /save draft/i })).toBeEnabled();
  });

  it('Save Draft after a rejected JSA save also recovers', async () => {
    const { state, calls } = renderDraft('COLD_WORK', { rejectJsaSaves: 1 });
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/save draft/i);
    await screen.findByText(/some details are not valid/i);

    await click(/save draft/i);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/draft saved/i));

    expect(sentVersions(calls).map((entry) => entry.version)).toEqual([2, 3, 3, 4]);
    expect(state.version).toBe(5);
  });
});

describe('correction resubmit follows the same progression', () => {
  it('saves the corrected document, then resubmits with the version those saves issued', async () => {
    const { state, calls } = renderDraft('HOT_WORK', {
      status: 'PENDING_CORRECTION',
      actions: ['update', 'resubmit'],
    });
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/^resubmit$/i);

    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
    expect(sentVersions(calls)).toEqual([
      { call: 'PATCH /api/v1/permits/permit-1', version: 2 },
      { call: 'PATCH /api/v1/permits/permit-1/jsa', version: 3 },
      { call: 'POST /api/v1/permits/permit-1/resubmit', version: 4 },
    ]);
    expect(state.resubmittedVersion).toBe(4);
    expect(state.submittedVersion).toBeNull();
  });

  it('recovers from a rejected JSA save without a reload', async () => {
    const { state } = renderDraft('HOT_WORK', {
      status: 'PENDING_CORRECTION',
      actions: ['update', 'resubmit'],
      rejectJsaSaves: 1,
    });
    await screen.findByTestId('permit-draft-editor');

    await type('Equipment', 'Drills');
    await click(/^resubmit$/i);
    await screen.findByText(/some details are not valid/i);

    await click(/^resubmit$/i);
    await waitFor(() => expect(screen.getByTestId('records-page')).toBeInTheDocument());
    expect(state.resubmittedVersion).toBe(5);
  });
});

describe('optimistic concurrency is still enforced', () => {
  it('a genuinely stale editor is still refused, not retried around', async () => {
    const { state, calls } = renderDraft('HOT_WORK');
    await screen.findByTestId('permit-draft-editor');

    // Someone or something else moves the permit on underneath.
    state.version = 9;

    await type('Equipment', 'Drills');
    await click(/^submit$/i);

    expect(await screen.findByText(/permit has changed or is not in the required state/i)).toBeInTheDocument();
    // One attempt, refused. No blind retry, and nothing was submitted.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(state.submittedVersion).toBeNull();
    expect(screen.queryByTestId('records-page')).not.toBeInTheDocument();
  });
});
