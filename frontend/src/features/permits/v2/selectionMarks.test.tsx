import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import { ROUTES } from '../../../app/routes';
import type { FormCatalogue, PermitTypeKey } from '../../../api/catalogue';
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
 * WHAT A SELECTED ANSWER LOOKS LIKE.
 *
 * The read-only document used to print a selected value as `×` - a small
 * multiplication sign. On a safety permit that reads as a FAILURE, not as
 * "this is the answer that was given", and at 0.75rem it was hard to tell
 * from an empty box at all. A permit whose NO column was ticked looked
 * exactly like a permit with something wrong with it.
 *
 * It is now a drawn checkmark, and a checkmark means one thing only:
 * THIS IS THE SELECTED VALUE. NO gets a checkmark in the NO column, the
 * way a person ticks a paper form. Nothing means "selected" by drawing a
 * cross.
 *
 * These specs run through the real record route and the real shared
 * components, so CRO review, HSE review and the applicant's read-only
 * view are all the same assertion - which is the point: they are one
 * renderer, not three.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const wtg = catalogue.permits.WTG_WORK;

/** The band with a YES / NO / N/A column set, and its first three questions. */
const band = wtg.checklistSections[0]!;
const [first, second, third, fourth] = band.items;

function payload(responses: Record<string, string>): PermitFormPayload {
  const base = emptyPermitValues('WTG_WORK', wtg) as unknown as Record<string, unknown>;
  const sections = base.sections as Record<string, Record<string, { response: string | null }>>;
  return {
    ...base,
    sections: {
      ...sections,
      [band.id]: {
        ...sections[band.id],
        ...Object.fromEntries(Object.entries(responses).map(([id, response]) => [id, { response }])),
      },
    },
  } as unknown as PermitFormPayload;
}

const JSA_PAYLOAD = emptyJsaValues(catalogue) as unknown as JsaFormPayload;

function detailFor(
  permitPayload: PermitFormPayload,
  options: { status?: PermitStatus; type?: PermitTypeKey; jsaPayload?: JsaFormPayload } = {},
): PermitDetailResponse {
  const type = options.type ?? 'WTG_WORK';
  return permitDetail({
    permit: permit({
      permit_type: type,
      form_version: `${type}_V2`,
      status: options.status ?? 'PENDING_CRO',
      form_payload: permitPayload,
    }),
    jsa: jsa({ form_version: 'JSA_V2', form_payload: options.jsaPayload ?? JSA_PAYLOAD }),
    availableActions: [],
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

/** The drawn marks inside an element - the one thing that says "selected". */
const marksIn = (element: Element): SVGSVGElement[] => [
  ...element.querySelectorAll<SVGSVGElement>('svg.doc__check'),
];

/**
 * Which response column a row's mark landed in, by index, or null when
 * the row carries no mark at all. The columns are printed in the order
 * the band declares - YES, NO, N/A.
 */
function markedColumn(row: Element): number | null {
  const cells = [...row.querySelectorAll('td')];
  const index = cells.findIndex((cell) => marksIn(cell).length > 0);
  return index === -1 ? null : index;
}

async function rowFor(label: string): Promise<HTMLElement> {
  const table = await screen.findByTestId(`checklist-${band.id}`);
  const heading = within(table).getByText(label);
  return heading.closest('tr')!;
}

// ---------------------------------------------------------------------
// YES / NO / N/A
// ---------------------------------------------------------------------

describe('a checklist answer', () => {
  it('puts ONE checkmark in the YES column for a YES answer', async () => {
    renderRecord(detailFor(payload({ [first!.id]: 'YES' })));
    const row = await rowFor(first!.label);
    expect(markedColumn(row)).toBe(0);
    expect(marksIn(row)).toHaveLength(1);
  });

  it('puts ONE checkmark in the NO column for a NO answer - not a cross, not a red mark', async () => {
    renderRecord(detailFor(payload({ [second!.id]: 'NO' })));
    const row = await rowFor(second!.label);
    expect(markedColumn(row)).toBe(1);
    expect(marksIn(row)).toHaveLength(1);
  });

  it('puts ONE checkmark in the N/A column for an N/A answer', async () => {
    renderRecord(detailFor(payload({ [third!.id]: 'NA' })));
    const row = await rowFor(third!.label);
    expect(markedColumn(row)).toBe(2);
    expect(marksIn(row)).toHaveLength(1);
  });

  it('leaves an unanswered row completely unmarked - no response is invented', async () => {
    renderRecord(detailFor(payload({ [first!.id]: 'YES' })));
    const row = await rowFor(fourth!.label);
    expect(markedColumn(row)).toBeNull();
    expect(marksIn(row)).toHaveLength(0);
  });

  it('marks each answer independently, in its own row and column', async () => {
    renderRecord(
      detailFor(payload({ [first!.id]: 'YES', [second!.id]: 'NO', [third!.id]: 'NA' })),
    );
    expect(markedColumn(await rowFor(first!.label))).toBe(0);
    expect(markedColumn(await rowFor(second!.label))).toBe(1);
    expect(markedColumn(await rowFor(third!.label))).toBe(2);
  });
});

// ---------------------------------------------------------------------
// The old mark is gone
// ---------------------------------------------------------------------

describe('the old ambiguous mark', () => {
  it('appears nowhere in a rendered V2 permit document', async () => {
    const { container } = renderRecord(
      detailFor(payload({ [first!.id]: 'YES', [second!.id]: 'NO', [third!.id]: 'NA' })),
    );
    await rowFor(first!.label);
    const document_ = container.textContent ?? '';
    expect(document_).not.toContain('×');
    expect(document_).not.toContain('✗');
    expect(document_).not.toContain('✕');
    // ...and the marks that ARE there are drawn, not typed.
    expect(marksIn(container).length).toBeGreaterThan(0);
  });

  it('appears nowhere in a rendered JSA either, which marks its own selections the same way', async () => {
    // A JSA with a real selection on it, so this cannot pass merely
    // because nothing was ticked.
    const requiredPermits = catalogue.jsa.page1.requiredPermits;
    const chosen = requiredPermits.options[0]!;
    const base = emptyJsaValues(catalogue) as unknown as Record<string, Record<string, unknown>>;
    const jsaPayload = {
      ...base,
      page1: {
        ...base.page1,
        requiredPermits: { ...(base.page1!.requiredPermits as object), [chosen.id]: true },
      },
    } as unknown as JsaFormPayload;

    const { container } = renderRecord(detailFor(payload({ [first!.id]: 'YES' }), { jsaPayload }));
    await userEvent.setup().click(await screen.findByRole('tab', { name: /job safety analysis/i }));
    const page1 = await screen.findByTestId('jsa-page-1');

    const band_ = within(page1).getByTestId(`selection-${requiredPermits.id}`);
    const selected = within(band_).getByText(chosen.label).closest('li')!;
    expect(marksIn(selected)).toHaveLength(1);
    expect(container.textContent ?? '').not.toContain('×');
  });
});

// ---------------------------------------------------------------------
// Multi-select bands
// ---------------------------------------------------------------------

describe('a multi-select band', () => {
  it('checks the selected options and leaves the rest empty', async () => {
    const base = emptyPermitValues('WTG_WORK', wtg) as unknown as Record<string, unknown>;
    const ppe = wtg.ppe!;
    const chosen = ppe.options[0]!;
    const notChosen = ppe.options[1]!;
    const withPpe = {
      ...base,
      ppe: { ...(base.ppe as object), [chosen.id]: true, [notChosen.id]: false },
    } as unknown as PermitFormPayload;

    renderRecord(detailFor(withPpe));

    const list = await screen.findByTestId(`selection-${ppe.id}`);
    const selected = within(list).getByText(chosen.label).closest('li')!;
    const unselected = within(list).getByText(notChosen.label).closest('li')!;
    expect(marksIn(selected)).toHaveLength(1);
    expect(marksIn(unselected)).toHaveLength(0);
    // The unselected option is still PRINTED - it is empty, not missing.
    expect(unselected.textContent).toContain(notChosen.label);
  });
});

// ---------------------------------------------------------------------
// Every surface that draws the document
// ---------------------------------------------------------------------

describe('every review surface', () => {
  const answered = () => payload({ [first!.id]: 'YES', [second!.id]: 'NO', [third!.id]: 'NA' });

  it('shows the CRO the new mark while the permit is with them', async () => {
    renderRecord(detailFor(answered(), { status: 'PENDING_CRO' }), croEmployee());
    expect(markedColumn(await rowFor(second!.label))).toBe(1);
  });

  it('shows the HSE reviewer the same mark', async () => {
    const hse = normalEmployee({
      auth: { id: 'user-hse', email: 'hse@eset.example.com' },
      profile: { displayName: 'Sana Iqbal', company: { code: 'E_SET', name: 'E-SET' }, teamName: 'HSE', positionName: 'HSE Officer' },
      capabilities: ['permit.hse_review'],
    });
    renderRecord(detailFor(answered(), { status: 'PENDING_HSE' }), hse);
    expect(markedColumn(await rowFor(second!.label))).toBe(1);
  });

  it('shows the applicant the same mark on their own issued record', async () => {
    renderRecord(detailFor(answered(), { status: 'ISSUED' }), normalEmployee());
    expect(markedColumn(await rowFor(second!.label))).toBe(1);
  });

  it('is one renderer, so a closed record marks identically', async () => {
    renderRecord(detailFor(answered(), { status: 'CLOSED' }), croEmployee());
    expect(markedColumn(await rowFor(second!.label))).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Every permit type
// ---------------------------------------------------------------------

describe('every permit type', () => {
  // WTG prints three response columns; the other three print two. A test
  // that assumed one shape would pass for the wrong reason.
  const types: PermitTypeKey[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

  for (const type of types) {
    it(`marks a ${type} answer in its own column set`, async () => {
      const definition = catalogue.permits[type]!;
      const section = definition.checklistSections[0]!;
      const item = section.items[0]!;
      const base = emptyPermitValues(type, definition) as unknown as Record<string, unknown>;
      const sections = base.sections as Record<string, Record<string, unknown>>;
      const form = {
        ...base,
        sections: { ...sections, [section.id]: { ...sections[section.id], [item.id]: { response: 'NO' } } },
      } as unknown as PermitFormPayload;

      renderRecord(detailFor(form, { type }));

      const table = await screen.findByTestId(`checklist-${section.id}`);
      const row = within(table).getByText(item.label).closest('tr')!;
      const cells = [...row.querySelectorAll('td')];
      // NO is the second column whether the band prints two columns or three.
      expect(cells).toHaveLength(section.responses === 'YES_NO_NA' ? 3 : 2);
      expect(markedColumn(row)).toBe(1);
      expect(marksIn(row)).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------
// The mark itself
// ---------------------------------------------------------------------

describe('the mark', () => {
  it('is a drawn shape, not a font glyph, and is hidden from screen readers', async () => {
    const { container } = renderRecord(detailFor(payload({ [first!.id]: 'YES' })));
    await rowFor(first!.label);
    const mark = marksIn(container)[0]!;

    expect(mark.tagName.toLowerCase()).toBe('svg');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    // A single stroked path: down-right into the vertex, then up-right.
    // Not two crossing strokes.
    const paths = [...mark.querySelectorAll('path')];
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('stroke')).toBe('currentColor');
    expect(paths[0]!.getAttribute('fill')).toBe('none');
  });

  it('takes its colour from the document token, never a hard-coded hex', async () => {
    const { container } = renderRecord(detailFor(payload({ [first!.id]: 'YES' })));
    await rowFor(first!.label);
    const mark = marksIn(container)[0]!;
    // `currentColor` on the path, inherited from the tick box - so the
    // colour lives in the stylesheet's token, not in this component.
    expect(mark.outerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
