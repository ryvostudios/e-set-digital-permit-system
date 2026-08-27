import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import type { FormCatalogue, PermitTypeKey } from '../../../api/catalogue';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
import { emptyJsaValues, emptyPermitValues } from './values';

/**
 * The authoritative documents.
 *
 * These use the SAME catalogue snapshot the browser specs render, and a
 * backend test fails if that snapshot drifts from what the API serves -
 * so "the wording is consumed, not duplicated" is enforced end to end
 * rather than asserted here in isolation.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const PERMIT_TYPES: PermitTypeKey[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

function renderPermit(permitType: PermitTypeKey, mode: 'edit' | 'read' = 'edit') {
  const definition = catalogue.permits[permitType];
  return render(
    <PermitDocumentV2
      permitType={permitType}
      definition={definition}
      values={emptyPermitValues(permitType, definition)}
      mode={mode}
      authoritative={{ permitNumber: '729', applicantName: 'Ali Khan', applicantCompany: 'ZPL', jsaNumber: '3' }}
    />,
  );
}

function renderJsa(mode: 'edit' | 'read' = 'edit') {
  return render(
    <JsaDocumentV2
      definition={catalogue.jsa}
      values={emptyJsaValues(catalogue)}
      mode={mode}
      authoritative={{ jsaNumber: '3', completedBy: 'Ali Khan — Technician' }}
    />,
  );
}

describe('every permit definition renders from the catalogue', () => {
  for (const permitType of PERMIT_TYPES) {
    it(`renders ${permitType} with every printed question, in catalogue order`, () => {
      renderPermit(permitType);
      const definition = catalogue.permits[permitType];

      for (const section of definition.checklistSections) {
        const band = screen.getByTestId(`checklist-${section.id}`);
        const questions = within(band)
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent);
        expect(questions, `${section.id}`).toEqual(section.items.map((item) => item.label));
      }
    });
  }
});

describe('printed tick semantics', () => {
  it('WTG safety bands offer Yes/No/N-A', () => {
    renderPermit('WTG_WORK');
    const band = screen.getByTestId('checklist-general_work');
    const headers = within(band).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers.slice(1)).toEqual(['Yes', 'No', 'N/A']);
  });

  it('WTG Isolation Points does NOT offer N/A - the printed band has no such column', () => {
    renderPermit('WTG_WORK');
    const band = screen.getByTestId('checklist-isolation_points');
    const headers = within(band).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers.slice(1)).toEqual(['Yes', 'No']);
    expect(headers).not.toContain('N/A');
  });

  it('the 008 permits are Yes/No only throughout', () => {
    renderPermit('COLD_WORK');
    for (const section of catalogue.permits.COLD_WORK.checklistSections) {
      const band = screen.getByTestId(`checklist-${section.id}`);
      const headers = within(band).getAllByRole('columnheader').map((h) => h.textContent?.trim());
      expect(headers.slice(1)).toEqual(['Yes', 'No']);
    }
  });
});

describe('permit-specific differences survive', () => {
  it('Hot Work offers exactly four Nature of Work options, without Inspection', () => {
    renderPermit('HOT_WORK');
    const band = screen.getByTestId('selection-nature_of_work');
    const options = within(band).getAllByRole('checkbox');
    expect(options).toHaveLength(4);
    expect(within(band).queryByLabelText('INSPECTION')).not.toBeInTheDocument();
  });

  it('Cold Work includes INSPECTION', () => {
    renderPermit('COLD_WORK');
    const band = screen.getByTestId('selection-nature_of_work');
    expect(within(band).getAllByRole('checkbox')).toHaveLength(5);
    expect(within(band).getByLabelText('INSPECTION')).toBeInTheDocument();
  });

  it("Hot Work's General Requirements is not Cold Work's", () => {
    const hot = renderPermit('HOT_WORK');
    const hotQuestions = within(screen.getByTestId('checklist-general_requirements'))
      .getAllByRole('rowheader')
      .map((c) => c.textContent);
    hot.unmount();

    renderPermit('COLD_WORK');
    const coldQuestions = within(screen.getByTestId('checklist-general_requirements'))
      .getAllByRole('rowheader')
      .map((c) => c.textContent);

    expect(hotQuestions).toContain('METAL THICKNESS FOR WELDING');
    expect(coldQuestions).not.toContain('METAL THICKNESS FOR WELDING');
    expect(hotQuestions).not.toEqual(coldQuestions);
  });

  it('Confined Space renders its three-row gas-test record', () => {
    renderPermit('CONFINED_SPACE_ENTRY');
    const table = screen.getByTestId('gas-test-record');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(3);
  });
});

describe('the JSA is two documents', () => {
  it('renders page 1 and page 2 as separate, labelled pages', () => {
    renderJsa();
    expect(screen.getByTestId('jsa-page-1')).toHaveTextContent('PAGE 1 OF 2');
    expect(screen.getByTestId('jsa-page-2')).toHaveTextContent('PAGE 2 OF 2');
  });

  it('page 1 carries all sixteen HSE categories, and page 2 carries none of them', () => {
    renderJsa();
    const page1 = within(screen.getByTestId('jsa-page-1'));
    const page2 = within(screen.getByTestId('jsa-page-2'));
    expect(catalogue.jsa.page1.hseChecklistCategories).toHaveLength(16);
    for (const category of catalogue.jsa.page1.hseChecklistCategories) {
      expect(page1.getByTestId(`selection-${category.id}`)).toBeInTheDocument();
      expect(page2.queryByTestId(`selection-${category.id}`)).not.toBeInTheDocument();
    }
  });

  it('page 1 shows each HSE category by its printed name', () => {
    renderJsa();
    const page1 = within(screen.getByTestId('jsa-page-1'));
    for (const category of catalogue.jsa.page1.hseChecklistCategories) {
      expect(page1.getByRole('heading', { name: category.title })).toBeInTheDocument();
    }
  });

  it('the HSE checklist is a TICK band - no Yes/No/N/A controls', () => {
    renderJsa();
    const band = within(screen.getByTestId('selection-ergonomic'));
    expect(band.getAllByRole('checkbox').length).toBe(
      catalogue.jsa.page1.hseChecklistCategories.find((c) => c.id === 'ergonomic')!.options.length,
    );
    expect(band.queryAllByRole('radio')).toHaveLength(0);
  });

  it('required permits offers all eight printed options plus Other', () => {
    renderJsa();
    const band = within(screen.getByTestId('selection-required_permits'));
    expect(band.getAllByRole('checkbox')).toHaveLength(8);
    expect(band.getByLabelText('Other(s)')).toBeInTheDocument();
  });

  it('the Task Analysis table has exactly five printed columns, on page 2', () => {
    renderJsa();
    const table = within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(catalogue.jsa.page2.taskAnalysisColumns.map((c) => c.label));
    expect(headers).toHaveLength(5);
    expect(within(screen.getByTestId('jsa-page-1')).queryByTestId('task-analysis')).not.toBeInTheDocument();
  });
});

describe('edit and read-only are the same document', () => {
  it('edit mode offers controls that actually record an answer', async () => {
    // Stateful, because the document is a controlled component: without a
    // real owner the click would be swallowed and the test would prove
    // nothing about the control.
    function Harness() {
      const definition = catalogue.permits.WTG_WORK;
      const [values, setValues] = useState(() => emptyPermitValues('WTG_WORK', definition));
      return (
        <PermitDocumentV2
          permitType="WTG_WORK"
          definition={definition}
          values={values}
          mode="edit"
          onChange={setValues}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const band = within(screen.getByTestId('checklist-general_work'));
    const yes = band.getAllByRole('radio')[0]!;
    expect(yes).not.toBeChecked();
    await user.click(yes);
    expect(yes).toBeChecked();
  });

  it('read-only mode renders the SAME questions with no controls', () => {
    const edit = renderPermit('WTG_WORK', 'edit');
    const editQuestions = within(screen.getByTestId('checklist-general_work'))
      .getAllByRole('rowheader')
      .map((c) => c.textContent);
    edit.unmount();

    renderPermit('WTG_WORK', 'read');
    const readBand = within(screen.getByTestId('checklist-general_work'));
    expect(readBand.getAllByRole('rowheader').map((c) => c.textContent)).toEqual(editQuestions);
    expect(readBand.queryAllByRole('radio')).toHaveLength(0);
    expect(readBand.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('server-authoritative fields', () => {
  it('are displayed but never rendered as editable controls', () => {
    renderPermit('COLD_WORK', 'edit');
    for (const label of ['Permit No.', 'Applicant', 'Company', 'JSA No.']) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText('729')).toBeInTheDocument();
    expect(screen.getByText('Ali Khan')).toBeInTheDocument();
  });

  it("the JSA's completed-by identity is not editable either", () => {
    renderJsa('edit');
    expect(screen.getByText('JSA completed by')).toBeInTheDocument();
    expect(screen.queryByLabelText('JSA completed by')).not.toBeInTheDocument();
  });
});

describe('the renderer only ever draws what the catalogue defines', () => {
  it('an item absent from the catalogue cannot appear', () => {
    renderPermit('WTG_WORK');
    // A plausible-looking safety question that is NOT in the transcription.
    expect(screen.queryByText(/Has the site been evacuated\?/i)).not.toBeInTheDocument();
  });

  it('a catalogue with an extra item renders exactly that item - nothing is hard-coded', () => {
    const definition = structuredClone(catalogue.permits.WTG_WORK);
    definition.checklistSections[0]!.items.push({ id: 'zz', label: 'An added printed question' });
    render(
      <PermitDocumentV2
        permitType="WTG_WORK"
        definition={definition}
        values={emptyPermitValues('WTG_WORK', definition)}
        mode="edit"
      />,
    );
    expect(screen.getByText('An added printed question')).toBeInTheDocument();
  });
});

describe('a new form starts UNANSWERED, never pre-set to N/A', () => {
  it('leaves every Yes/No/N-A radio unselected on a blank permit', () => {
    renderPermit('WTG_WORK', 'edit');
    const band = within(screen.getByTestId('checklist-general_work'));
    const radios = band.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    // Not one of them is checked - in particular, NOT the N/A column.
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(0);
  });

  it('leaves the Yes/No-only isolation band unselected too', () => {
    renderPermit('WTG_WORK', 'edit');
    const band = within(screen.getByTestId('checklist-isolation_points'));
    expect(band.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });

  it("does not pre-answer the JSA's printed Yes/No questions", () => {
    renderJsa('edit');
    const page1 = within(screen.getByTestId('jsa-page-1'));
    const permitsQuestion = page1.getAllByRole('radio');
    expect(permitsQuestion.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);

    const page2 = within(screen.getByTestId('jsa-page-2'));
    expect(page2.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });

  it('records N/A only when a person actually chooses it', async () => {
    function Harness() {
      const definition = catalogue.permits.WTG_WORK;
      const [values, setValues] = useState(() => emptyPermitValues('WTG_WORK', definition));
      return (
        <PermitDocumentV2
          permitType="WTG_WORK"
          definition={definition}
          values={values}
          mode="edit"
          onChange={setValues}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const band = within(screen.getByTestId('checklist-general_work'));
    const na = band.getAllByRole('radio')[2]!; // Yes, No, N/A
    expect(na).not.toBeChecked();
    await user.click(na);
    expect(na).toBeChecked();
  });
});
