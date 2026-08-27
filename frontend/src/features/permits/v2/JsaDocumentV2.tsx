import type { JsaDefinition } from '../../../api/catalogue';
import {
  DocField,
  DocSection,
  DocumentMasthead,
  FieldRow,
  SelectionBand,
  YesNoField,
  type DocumentMode,
} from './primitives';
import { emptyTaskAnalysisRow, type JsaValuesV2, type SelectionValues, type TaskAnalysisRow } from './values';
import './paperV2.css';

/**
 * The JSA - TWO documents, rendered one after the other.
 *
 * They share this file because they are one form, but they are never
 * merged into a single panel: each carries its own masthead and its own
 * PAGE n OF 2 banner, and page 1's content (the required-permit ticks and
 * the sixteen HSE categories) never appears inside page 2's element, nor
 * the reverse. Tests assert that separation by querying within each page.
 *
 * The HSE checklist is a TICK band, not Yes/No/N/A - the printed form
 * offers no response columns there, so none are rendered.
 */

interface Props {
  definition: JsaDefinition;
  values: JsaValuesV2;
  mode: DocumentMode;
  onChange?: (next: JsaValuesV2) => void;
  authoritative?: { jsaNumber?: string; completedBy?: string };
}

const ISSUER = 'E-SET · Strategic Engineering Technologies (Pvt.) Limited';

export function JsaDocumentV2({ definition, values, mode, onChange, authoritative }: Props) {
  const { page1, page2 } = definition;

  const setPage1 = (key: string, value: unknown) =>
    onChange?.({ ...values, page1: { ...values.page1, [key]: value } });
  const setPage2 = (key: string, value: unknown) =>
    onChange?.({ ...values, page2: { ...values.page2, [key]: value } });

  const p1 = (key: string): string => (typeof values.page1[key] === 'string' ? (values.page1[key] as string) : '');
  const p2 = (key: string): string => (typeof values.page2[key] === 'string' ? (values.page2[key] as string) : '');

  const hse = (values.page1.hseChecklist as Record<string, SelectionValues>) ?? {};
  const rows = (values.page2.taskAnalysis as TaskAnalysisRow[]) ?? [];
  const contacts = (values.page2.emergencyContacts as Record<string, string>) ?? {};
  const questions = (values.page2.emergencyQuestions as Record<string, 'YES' | 'NO' | null>) ?? {};

  const setRow = (index: number, next: Partial<TaskAnalysisRow>) =>
    setPage2('taskAnalysis', rows.map((row, i) => (i === index ? { ...row, ...next } : row)));

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* PAGE 1 OF 2                                                       */}
      {/* ---------------------------------------------------------------- */}
      <article className="doc doc__page" data-testid="jsa-page-1">
        <p className="doc__page-banner">Job Safety Analysis — {page1.pageLabel}</p>
        <DocumentMasthead
          issuer={ISSUER}
          title="Job Safety Analysis"
          reference={definition.formReference}
          pageLabel={page1.pageLabel}
        />

        <DocSection title="Job Information">
          <FieldRow>
            <DocField label="S. No." value={authoritative?.jsaNumber ?? ''} mode={mode} authoritative />
            <DocField
              label="JSA completed by"
              value={authoritative?.completedBy ?? ''}
              mode={mode}
              authoritative
            />
            <DocField
              label="Site / WTG"
              value={p1('siteOrWtg')}
              mode={mode}
              onChange={(next) => setPage1('siteOrWtg', next)}
            />
            <DocField
              label="Date / Time"
              value={p1('dateTime')}
              mode={mode}
              type="datetime-local"
              onChange={(next) => setPage1('dateTime', next)}
            />
            <DocField
              label="Job / Work"
              value={p1('jobOrWork')}
              mode={mode}
              multiline
              full
              onChange={(next) => setPage1('jobOrWork', next)}
            />
          </FieldRow>
        </DocSection>

        <DocSection title={page1.requiredPermits.title}>
          <YesNoField
            label={page1.requiredPermits.title}
            value={(values.page1.anyPermitsRequired as 'YES' | 'NO' | null) ?? null}
            mode={mode}
            onChange={(next) => setPage1('anyPermitsRequired', next)}
          />
          <SelectionBand
            section={page1.requiredPermits}
            values={(values.page1.requiredPermits as SelectionValues) ?? {}}
            mode={mode}
            onChange={(next) => setPage1('requiredPermits', next)}
            columns={3}
          />
        </DocSection>

        <DocSection title="HSE Checklist" note={page1.hseChecklistInstruction}>
          <div className="doc__hse-grid">
            {page1.hseChecklistCategories.map((category) => (
              <SelectionBand
                key={category.id}
                section={category}
                values={hse[category.id] ?? {}}
                mode={mode}
                onChange={(next) => setPage1('hseChecklist', { ...hse, [category.id]: next })}
                columns={1}
                showTitle
              />
            ))}
          </div>
        </DocSection>

        <p className="doc__reminder">{page1.reminder}</p>
        <p className="doc__footer">
          {definition.formReference} · {page1.pageLabel}
        </p>
      </article>

      {/* ---------------------------------------------------------------- */}
      {/* PAGE 2 OF 2                                                       */}
      {/* ---------------------------------------------------------------- */}
      <article className="doc doc__page" data-testid="jsa-page-2">
        <p className="doc__page-banner">Job Safety Analysis — {page2.pageLabel}</p>
        <DocumentMasthead
          issuer={ISSUER}
          title="Job Safety Analysis"
          reference={definition.formReference}
          pageLabel={page2.pageLabel}
        />

        <DocSection title="Emergency Response">
          <FieldRow>
            {page2.emergencyContacts.map((contact) => (
              <DocField
                key={contact.id}
                label={contact.label}
                value={contacts[contact.id] ?? ''}
                mode={mode}
                onChange={(next) => setPage2('emergencyContacts', { ...contacts, [contact.id]: next })}
              />
            ))}
          </FieldRow>
          {page2.emergencyQuestions.map((question) => (
            <YesNoField
              key={question.id}
              label={question.label}
              value={questions[question.id] ?? null}
              mode={mode}
              onChange={(next) => setPage2('emergencyQuestions', { ...questions, [question.id]: next })}
            />
          ))}
        </DocSection>

        <DocSection
          title="Task Analysis"
          note={`Energy sources: ${page2.energySourceLegend.map((e) => `${e.code} (${e.label})`).join(', ')}`}
        >
          <div className="doc__scroll">
            <table className="doc__table" data-testid="task-analysis">
              <thead>
                <tr>
                  {page2.taskAnalysisColumns.map((column) => (
                    <th scope="col" key={column.id}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td>
                      <DocField
                        label={`Row ${index + 1} sequence of tasks`}
                        value={row.sequenceOfTasks}
                        mode={mode}
                        hideLabel
                        onChange={(next) => setRow(index, { sequenceOfTasks: next })}
                      />
                    </td>
                    <td>
                      <DocField
                        label={`Row ${index + 1} possible hazardous events`}
                        value={row.possibleHazardousEvents}
                        mode={mode}
                        hideLabel
                        onChange={(next) => setRow(index, { possibleHazardousEvents: next })}
                      />
                    </td>
                    <td>
                      <span className="doc__response-group">
                        {page2.energySourceLegend.map((energy) => {
                          const on = row.energySources.includes(energy.code);
                          return mode === 'edit' ? (
                            <label key={energy.code} className="doc__response">
                              <input
                                type="checkbox"
                                aria-label={`Row ${index + 1} energy source ${energy.code} (${energy.label})`}
                                checked={on}
                                onChange={(event) =>
                                  setRow(index, {
                                    energySources: event.target.checked
                                      ? [...row.energySources, energy.code]
                                      : row.energySources.filter((code) => code !== energy.code),
                                  })
                                }
                              />
                              <span>{energy.code}</span>
                            </label>
                          ) : (
                            <span key={energy.code} className="doc__response">
                              <span className={on ? 'doc__tick-box doc__tick-box--on' : 'doc__tick-box'}>
                                {on ? '×' : ''}
                              </span>
                              <span>{energy.code}</span>
                            </span>
                          );
                        })}
                      </span>
                    </td>
                    <td>
                      <DocField
                        label={`Row ${index + 1} triggering events to stop the work`}
                        value={row.triggeringEventsToStopWork}
                        mode={mode}
                        hideLabel
                        onChange={(next) => setRow(index, { triggeringEventsToStopWork: next })}
                      />
                    </td>
                    <td>
                      <DocField
                        label={`Row ${index + 1} protective actions`}
                        value={row.protectiveActionsOrMeasures}
                        mode={mode}
                        hideLabel
                        onChange={(next) => setRow(index, { protectiveActionsOrMeasures: next })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mode === 'edit' ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setPage2('taskAnalysis', [...rows, emptyTaskAnalysisRow()])}
            >
              Add task row
            </button>
          ) : null}
        </DocSection>

        <DocSection title={page2.ppe.title}>
          <SelectionBand
            section={page2.ppe}
            values={(values.page2.ppe as SelectionValues) ?? {}}
            mode={mode}
            onChange={(next) => setPage2('ppe', next)}
            columns={3}
          />
        </DocSection>

        <DocSection title="Tools / Material needed">
          <DocField
            label="Tools / Material needed"
            value={p2('toolsAndMaterials')}
            mode={mode}
            multiline
            full
            onChange={(next) => setPage2('toolsAndMaterials', next)}
          />
        </DocSection>

        <DocSection title="Participants" note={page2.participantSignatureNote}>
          <p className="doc__field-note">
            Names recorded here are form content. The authoritative digital signatures are recorded by the
            system when each person acts.
          </p>
        </DocSection>

        <DocSection title="Approval signatures" note={page2.approvalNote}>
          <div className="doc__signatures">
            {page2.approvalSignatories.map((signatory) => (
              <div className="doc__signature" key={signatory.id}>
                <span className="doc__signature-role">{signatory.label}</span>
                <span className="doc__signature-mark">Recorded digitally on approval</span>
              </div>
            ))}
          </div>
          <p className="doc__field-note">{page2.closeOutNote}</p>
        </DocSection>

        <DocSection title="Additional comments">
          <DocField
            label="Additional comments"
            value={p2('comments')}
            mode={mode}
            multiline
            full
            onChange={(next) => setPage2('comments', next)}
          />
        </DocSection>

        <p className="doc__footer">
          {definition.formReference} · {page2.pageLabel}
        </p>
      </article>
    </>
  );
}
