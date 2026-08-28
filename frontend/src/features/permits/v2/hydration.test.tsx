import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import catalogueFixture from '../../../../e2e/fixtures/catalogue.json';
import type { FormCatalogue } from '../../../api/catalogue';
import { JsaDocumentV2 } from './JsaDocumentV2';
import { PermitDocumentV2 } from './PermitDocumentV2';
import {
  emptyJsaValues,
  emptyPermitValues,
  hydrateJsaValuesV2,
  hydratePermitValuesV2,
  type ChecklistAnswers,
  type JsaValuesV2,
  type PermitValuesV2,
  type SelectionValues,
  type TaskAnalysisRow,
} from './values';

/**
 * HYDRATING A PARTIAL STORED PAYLOAD.
 *
 * A partly completed permit is a legitimate thing to save and to submit,
 * and the V2 contract stores exactly what the applicant had: a printed
 * field nobody touched is simply ABSENT from the stored payload. Taking
 * such a payload as it is (`stored ?? blank`) hands the renderers a
 * document with collections missing, and the first one to walk a
 * collection that is not there takes the whole screen blank.
 *
 * These specs pin the two halves of the contract that make that safe:
 * the STRUCTURE always arrives complete, and the CONTENT is never
 * invented - an unanswered question stays unanswered, a deliberate 'NO'
 * or 'NA' stays exactly itself, and a list someone emptied stays empty.
 */

const catalogue = catalogueFixture as unknown as FormCatalogue;
const wtg = catalogue.permits.WTG_WORK;

/** The shape the SERVER stores for a permit somebody has barely started. */
function partialWtgPayload(): unknown {
  return {
    permitIssue: { wtgNumber: 'WTG-14' },
    sections: {
      general_work: {
        [wtg.checklistSections[0]!.items[0]!.id]: { response: 'NO' },
      },
    },
  };
}

/** The same for the JSA: page 1 begun, page 2 never opened. */
function partialJsaPayload(): unknown {
  return { page1: { siteOrWtg: 'North Farm' } };
}

function renderPermit(values: PermitValuesV2) {
  return render(<PermitDocumentV2 permitType="WTG_WORK" definition={wtg} values={values} mode="edit" />);
}

function renderJsa(values: JsaValuesV2) {
  return render(<JsaDocumentV2 definition={catalogue.jsa} values={values} mode="edit" />);
}

describe('a partial stored payload still renders', () => {
  it('renders a partial WTG permit as the whole printed document', () => {
    const values = hydratePermitValuesV2('WTG_WORK', wtg, partialWtgPayload());
    renderPermit(values);

    // Every printed band is present, not only the one that was stored.
    for (const section of wtg.checklistSections) {
      expect(screen.getByTestId(`checklist-${section.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('checklist-isolation_points')).toBeInTheDocument();
    expect(screen.getByTestId(`selection-${wtg.ppe!.id}`)).toBeInTheDocument();
    expect((screen.getByLabelText('WTG Number') as HTMLInputElement).value).toBe('WTG-14');
  });

  it('renders a JSA whose page 2 collections were never stored', () => {
    const values = hydrateJsaValuesV2(catalogue, partialJsaPayload());
    renderJsa(values);

    expect(screen.getByTestId('jsa-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('jsa-page-2')).toBeInTheDocument();
    // The task-analysis table is the collection the blank screen died on.
    const table = within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
    expect((screen.getByLabelText('Site / WTG') as HTMLInputElement).value).toBe('North Farm');
  });

  it('does not crash when participants is missing', () => {
    const stored = { page1: {}, page2: { toolsAndMaterials: 'Torque wrench' } };
    const values = hydrateJsaValuesV2(catalogue, stored);
    expect(values.page2.participants).toEqual([]);
    expect(() => renderJsa(values)).not.toThrow();
  });

  it('does not crash when taskAnalysis is missing', () => {
    const values = hydrateJsaValuesV2(catalogue, { page1: {}, page2: {} });
    // A blank ROW, not a fabricated answer: every cell is empty.
    expect(values.page2.taskAnalysis).toEqual([
      {
        sequenceOfTasks: '',
        possibleHazardousEvents: '',
        energySources: [],
        triggeringEventsToStopWork: '',
        protectiveActionsOrMeasures: '',
      },
    ]);
    expect(() => renderJsa(values)).not.toThrow();
  });

  it('completes a half-written task-analysis row rather than dropping it', () => {
    const values = hydrateJsaValuesV2(catalogue, {
      page1: {},
      page2: { taskAnalysis: [{ sequenceOfTasks: 'Isolate the turbine' }] },
    });
    const rows = values.page2.taskAnalysis as TaskAnalysisRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sequenceOfTasks).toBe('Isolate the turbine');
    expect(rows[0]!.energySources).toEqual([]);
    renderJsa(values);
    expect((screen.getByLabelText('Row 1 sequence of tasks') as HTMLInputElement).value).toBe(
      'Isolate the turbine',
    );
  });

  it('accepts a payload that is null - a draft nobody has saved yet', () => {
    expect(hydratePermitValuesV2('WTG_WORK', wtg, null)).toEqual(emptyPermitValues('WTG_WORK', wtg));
    expect(hydrateJsaValuesV2(catalogue, null)).toEqual(emptyJsaValues(catalogue));
  });
});

describe('what a person entered survives hydration exactly', () => {
  it('keeps stored scalars - text, ticks and an explicit false', () => {
    const first = wtg.ppe!.options[0]!.id;
    const second = wtg.ppe!.options[1]!.id;
    const values = hydratePermitValuesV2('WTG_WORK', wtg, {
      permitIssue: { windFarmName: 'North Farm', descriptionOfWork: '' },
      ppe: { [first]: true, [second]: false },
    });
    const permitIssue = values.permitIssue as Record<string, unknown>;
    expect(permitIssue.windFarmName).toBe('North Farm');
    expect(permitIssue.descriptionOfWork).toBe('');
    const ppe = values.ppe as SelectionValues;
    expect(ppe[first]).toBe(true);
    expect(ppe[second]).toBe(false);
  });

  it('keeps a stored NO and a stored NA exactly as answered', () => {
    const section = wtg.checklistSections[0]!;
    const first = section.items[0]!.id;
    const second = section.items[1]!.id;
    const values = hydratePermitValuesV2('WTG_WORK', wtg, {
      sections: { [section.id]: { [first]: { response: 'NO' }, [second]: { response: 'NA' } } },
    });
    const answers = (values.sections as Record<string, ChecklistAnswers>)[section.id]!;
    expect(answers[first]!.response).toBe('NO');
    expect(answers[second]!.response).toBe('NA');
  });

  it('leaves an unanswered question null - hydration never answers one', () => {
    const section = wtg.checklistSections[0]!;
    const answered = section.items[0]!.id;
    const values = hydratePermitValuesV2('WTG_WORK', wtg, {
      sections: { [section.id]: { [answered]: { response: 'YES' } } },
    });
    const answers = (values.sections as Record<string, ChecklistAnswers>)[section.id]!;
    expect(answers[answered]!.response).toBe('YES');
    for (const item of section.items.slice(1)) {
      expect(answers[item.id]!.response, item.id).toBeNull();
    }

    // An explicitly stored null is not "missing" either - it stays null.
    const explicit = hydratePermitValuesV2('WTG_WORK', wtg, {
      sections: { [section.id]: { [answered]: { response: null } } },
    });
    const explicitAnswers = (explicit.sections as Record<string, ChecklistAnswers>)[section.id]!;
    expect(explicitAnswers[answered]!.response).toBeNull();
  });

  it('keeps the JSA Yes/No questions as answered, including a stored null', () => {
    const first = catalogue.jsa.page2.emergencyQuestions[0]!;
    const second = catalogue.jsa.page2.emergencyQuestions[1]!;
    const values = hydrateJsaValuesV2(catalogue, {
      page1: { anyPermitsRequired: 'NO' },
      page2: { emergencyQuestions: { [first.id]: 'YES', [second.id]: null } },
    });
    expect(values.page1.anyPermitsRequired).toBe('NO');
    const questions = values.page2.emergencyQuestions as Record<string, string | null>;
    expect(questions[first.id]).toBe('YES');
    expect(questions[second.id]).toBeNull();
  });

  it('keeps an explicitly stored empty array empty - it is not "missing"', () => {
    const values = hydrateJsaValuesV2(catalogue, {
      page1: {},
      page2: { taskAnalysis: [], participants: [] },
    });
    expect(values.page2.taskAnalysis).toEqual([]);
    expect(values.page2.participants).toEqual([]);

    // And the document renders with no rows rather than inventing one.
    renderJsa(values);
    const table = within(screen.getByTestId('jsa-page-2')).getByTestId('task-analysis');
    expect(within(table).getAllByRole('row')).toHaveLength(1); // the header row alone
  });

  it('replaces the default array wholesale rather than merging it positionally', () => {
    const values = hydrateJsaValuesV2(catalogue, {
      page1: {},
      page2: {
        taskAnalysis: [{ sequenceOfTasks: 'A', energySources: ['M'] }, { sequenceOfTasks: 'B' }],
      },
    });
    const rows = values.page2.taskAnalysis as TaskAnalysisRow[];
    expect(rows.map((row) => row.sequenceOfTasks)).toEqual(['A', 'B']);
    expect(rows[0]!.energySources).toEqual(['M']);
    expect(rows[1]!.energySources).toEqual([]);
  });

  it('keeps stored keys the blank form does not carry', () => {
    const section = wtg.checklistSections[0]!;
    const item = section.items[0]!.id;
    const values = hydratePermitValuesV2('WTG_WORK', wtg, {
      sections: { [section.id]: { [item]: { response: 'YES', remarks: 'Checked with the CRO' } } },
    });
    const answers = (values.sections as Record<string, ChecklistAnswers>)[section.id]!;
    expect(answers[item]!.remarks).toBe('Checked with the CRO');
  });
});

describe('hydration does not touch what it was given', () => {
  it('leaves the stored permit payload unchanged', () => {
    const stored = partialWtgPayload();
    const before = structuredClone(stored);
    const values = hydratePermitValuesV2('WTG_WORK', wtg, stored);
    expect(stored).toEqual(before);

    // ...and the result shares no reference with it, so editing cannot
    // reach back into the payload the record was read from.
    (values.permitIssue as Record<string, unknown>).wtgNumber = 'WTG-99';
    expect(stored).toEqual(before);
  });

  it('leaves the stored JSA payload unchanged, nested collections included', () => {
    const stored = {
      page1: {},
      page2: { taskAnalysis: [{ sequenceOfTasks: 'Isolate', energySources: ['M'] }] },
    };
    const before = structuredClone(stored);
    const values = hydrateJsaValuesV2(catalogue, stored);
    (values.page2.taskAnalysis as TaskAnalysisRow[])[0]!.energySources.push('E');
    expect(stored).toEqual(before);
  });

  it('does not let two hydrations of the same payload share state', () => {
    const stored = partialJsaPayload();
    const first = hydrateJsaValuesV2(catalogue, stored);
    const second = hydrateJsaValuesV2(catalogue, stored);
    (first.page2.taskAnalysis as TaskAnalysisRow[])[0]!.sequenceOfTasks = 'changed';
    expect((second.page2.taskAnalysis as TaskAnalysisRow[])[0]!.sequenceOfTasks).toBe('');
  });
});

describe('a structurally wrong stored value cannot blank the screen', () => {
  it('falls back to the blank structure where storage holds the wrong kind of value', () => {
    const values = hydrateJsaValuesV2(catalogue, {
      page1: null,
      page2: { taskAnalysis: 'not a table', emergencyContacts: 7 },
    });
    expect(values.page1).toEqual(emptyJsaValues(catalogue).page1);
    expect(Array.isArray(values.page2.taskAnalysis)).toBe(true);
    expect(() => renderJsa(values)).not.toThrow();
  });
});
