import type { ReactNode } from 'react';
import type { CatalogueItem, ChecklistSectionDef, SelectionSectionDef } from '../../../api/catalogue';
import { CheckMark } from '../CheckMark';
import type { ChecklistAnswers, ChecklistResponse, SelectionValues } from './values';

/**
 * The document primitives.
 *
 * TWO PROPERTIES MATTER MORE THAN ANYTHING ELSE HERE.
 *
 * 1. NO SAFETY WORDING LIVES IN THIS FILE. Every label comes from the
 *    catalogue prop. These components know there is "a section with items"
 *    and nothing about what the items say, so the editor cannot drift from
 *    the read-only document or from the PDF.
 *
 * 2. ONE COMPONENT SERVES BOTH MODES. `mode` switches a cell between a
 *    real control and a rendered value, but the table, its columns, its
 *    order and its headings are the same code either way. That is what
 *    makes "what the applicant filled in" and "what the reviewer sees"
 *    structurally the same document rather than two designs that happen
 *    to look similar.
 */

export type DocumentMode = 'edit' | 'read';

/**
 * A stable DOM id for one payload location.
 *
 * The server reports an unanswered question as a PAYLOAD PATH
 * (`["sections","general_work","a","response"]`). Deriving the element id
 * from that same path is what lets the editor take someone straight to
 * the control without the frontend keeping its own map of questions - and
 * therefore without a second copy of the completeness rules that could
 * drift from the server's.
 */
export function pathId(path: readonly string[]): string {
  return `fld-${path.join('-')}`;
}

/** Paths the server said are unanswered, as ids, for highlighting. */
export type InvalidPaths = ReadonlySet<string>;

const RESPONSES_BY_DOMAIN: Record<string, ChecklistResponse[]> = {
  YES_NO_NA: ['YES', 'NO', 'NA'],
  YES_NO: ['YES', 'NO'],
};

/** The printed column headings for a band, so 'NA' never appears where the form has no N/A column. */
export function responseColumns(section: ChecklistSectionDef): ChecklistResponse[] {
  return RESPONSES_BY_DOMAIN[section.responses] ?? ['YES', 'NO'];
}

const RESPONSE_LABEL: Record<ChecklistResponse, string> = { YES: 'Yes', NO: 'No', NA: 'N/A' };

export function DocSection({
  title,
  printedNumber,
  children,
  note,
}: {
  title: string;
  printedNumber?: string | null;
  children: ReactNode;
  note?: string;
}) {
  return (
    <section className="doc__section" aria-label={title}>
      <div className="doc__section-head">
        {printedNumber ? <span className="doc__section-number">{printedNumber}</span> : null}
        <h3 className="doc__section-title">{title}</h3>
      </div>
      {note ? <p className="doc__section-note">{note}</p> : null}
      <div className="doc__section-body">{children}</div>
    </section>
  );
}

/**
 * A printed safety checklist band: one row per question, one column per
 * tick the form actually prints. Wrapped in a scroll container so a wide
 * band scrolls WITHIN the document on a phone rather than pushing the
 * page sideways.
 */
export function ChecklistBand({
  section,
  answers,
  mode,
  onChange,
  path = [],
  invalid,
}: {
  section: ChecklistSectionDef;
  answers: ChecklistAnswers;
  mode: DocumentMode;
  onChange?: (next: ChecklistAnswers) => void;
  /** Where this band lives in the payload, e.g. `['sections','general_work']`. */
  path?: readonly string[];
  invalid?: InvalidPaths;
}) {
  const columns = responseColumns(section);

  return (
    <div className="doc__scroll">
      <table className="doc__table" data-testid={`checklist-${section.id}`}>
        <thead>
          <tr>
            <th scope="col" className="doc__table-question">
              <span className="sr-only">{section.title}</span>
            </th>
            {columns.map((column) => (
              <th scope="col" key={column} className="doc__table-tick">
                {RESPONSE_LABEL[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.items.map((item) => {
            const current = answers[item.id]?.response ?? null;
            const itemPath = [...path, item.id, 'response'];
            const id = pathId(itemPath);
            const isInvalid = invalid?.has(id) ?? false;
            return (
              <tr
                key={item.id}
                id={id}
                data-unanswered={isInvalid ? 'true' : undefined}
                className={isInvalid ? 'doc__row--unanswered' : undefined}
              >
                <th scope="row" className="doc__table-question">
                  {item.label}
                </th>
                {columns.map((column) => (
                  <td key={column} className="doc__table-tick">
                    {mode === 'edit' ? (
                      <input
                        type="radio"
                        name={`${section.id}.${item.id}`}
                        // The first column is the focus target the editor
                        // sends the applicant to.
                        {...(column === columns[0] ? { 'data-focus-target': id } : {})}
                        aria-invalid={isInvalid || undefined}
                        aria-label={`${item.label} — ${RESPONSE_LABEL[column]}`}
                        checked={current === column}
                        onChange={() =>
                          onChange?.({ ...answers, [item.id]: { ...answers[item.id], response: column } })
                        }
                      />
                    ) : (
                      <span
                        className={current === column ? 'doc__tick-box doc__tick-box--on' : 'doc__tick-box'}
                        aria-label={`${item.label} — ${RESPONSE_LABEL[column]}${current === column ? ' (selected)' : ''}`}
                      >
                        {current === column ? <CheckMark /> : null}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A printed tick-box band (Nature of Work, hazards, PPE, JSA checklist categories). */
export function SelectionBand({
  section,
  values,
  mode,
  onChange,
  columns = 2,
  showTitle = false,
}: {
  section: SelectionSectionDef;
  values: SelectionValues;
  mode: DocumentMode;
  onChange?: (next: SelectionValues) => void;
  columns?: number;
  /** The printed band heading. The JSA's HSE checklist prints one per category. */
  showTitle?: boolean;
}) {
  return (
    <div data-testid={`selection-${section.id}`}>
      {showTitle ? <h4 className="doc__band-title">{section.title}</h4> : null}
      <ul className="doc__ticks" style={{ ['--doc-tick-columns' as string]: String(columns) }}>
        {section.options.map((option) => {
          const checked = values[option.id] === true;
          return (
            <li key={option.id} className={checked ? 'doc__tick' : 'doc__tick doc__tick--off'}>
              {mode === 'edit' ? (
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={option.label}
                    onChange={(event) => onChange?.({ ...values, [option.id]: event.target.checked })}
                  />
                  <span>{option.label}</span>
                </label>
              ) : (
                <>
                  <span className="doc__tick-box" aria-hidden="true">
                    {checked ? <CheckMark /> : null}
                  </span>
                  <span>{option.label}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {section.hasOther ? (
        <DocField
          label="Other(s)"
          value={typeof values.other === 'string' ? values.other : ''}
          mode={mode}
          onChange={(next) => onChange?.({ ...values, other: next })}
        />
      ) : null}
    </div>
  );
}

/** One labelled field. `type` covers the date and time inputs the forms print. */
export function DocField({
  label,
  value,
  mode,
  onChange,
  type = 'text',
  multiline = false,
  full = false,
  /** Server-authoritative values are DISPLAYED but never editable. */
  authoritative = false,
  hideLabel = false,
}: {
  label: string;
  value: string;
  mode: DocumentMode;
  onChange?: (next: string) => void;
  type?: 'text' | 'date' | 'time' | 'datetime-local';
  multiline?: boolean;
  full?: boolean;
  authoritative?: boolean;
  /**
   * Inside a table cell the column heading already names the field, and
   * the printed form carries no per-cell label. The text is kept for
   * assistive technology and hidden visually.
   */
  hideLabel?: boolean;
}) {
  const editable = mode === 'edit' && !authoritative;
  return (
    <div className={full ? 'doc__field doc__field--full' : 'doc__field'}>
      <span className={hideLabel ? 'sr-only' : 'doc__field-label'}>{label}</span>
      {editable ? (
        multiline ? (
          <textarea
            className="doc__input"
            aria-label={label}
            value={value}
            rows={3}
            onChange={(event) => onChange?.(event.target.value)}
          />
        ) : (
          <input
            className="doc__input"
            type={type}
            aria-label={label}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
        )
      ) : (
        <span className={value ? 'doc__field-value' : 'doc__field-value doc__field-value--empty'}>
          {value || '—'}
          {authoritative && mode === 'edit' ? (
            <span className="doc__field-note"> (set by the system)</span>
          ) : null}
        </span>
      )}
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="doc__fields">{children}</div>;
}

/** A printed Yes/No question that is not part of a checklist band. */
export function YesNoField({
  label,
  value,
  mode,
  onChange,
  path = [],
  invalid,
}: {
  label: string;
  /** null = unanswered. Neither box is ticked until a person answers. */
  value: 'YES' | 'NO' | null;
  mode: DocumentMode;
  onChange?: (next: 'YES' | 'NO') => void;
  path?: readonly string[];
  invalid?: InvalidPaths;
}) {
  const id = pathId(path);
  const isInvalid = invalid?.has(id) ?? false;
  return (
    <div
      className={isInvalid ? 'doc__field doc__field--full doc__row--unanswered' : 'doc__field doc__field--full'}
      id={path.length ? id : undefined}
      data-unanswered={isInvalid ? 'true' : undefined}
    >
      <span className="doc__field-label">{label}</span>
      <span className="doc__response-group">
        {(['YES', 'NO'] as const).map((option) =>
          mode === 'edit' ? (
            <label key={option} className="doc__response">
              <input
                type="radio"
                name={label}
                {...(option === 'YES' && path.length ? { 'data-focus-target': id } : {})}
                aria-invalid={isInvalid || undefined}
                aria-label={`${label} — ${RESPONSE_LABEL[option]}`}
                checked={value === option}
                onChange={() => onChange?.(option)}
              />
              <span>{RESPONSE_LABEL[option]}</span>
            </label>
          ) : (
            <span key={option} className="doc__response">
              <span className="doc__tick-box" aria-hidden="true">
                {value === option ? <CheckMark /> : null}
              </span>
              <span>{RESPONSE_LABEL[option]}</span>
            </span>
          ),
        )}
      </span>
    </div>
  );
}

/** The signature/authorization strip. Always read-only: these identities are server-derived. */
export function AuthorizationBand({ title, signatories }: { title: string; signatories: CatalogueItem[] }) {
  return (
    <DocSection title={title}>
      <div className="doc__signatures">
        {signatories.map((signatory) => (
          <div className="doc__signature" key={signatory.id}>
            <span className="doc__signature-role">{signatory.label}</span>
            <span className="doc__signature-mark">Recorded digitally on approval</span>
          </div>
        ))}
      </div>
    </DocSection>
  );
}

export function DocumentMasthead({
  issuer,
  title,
  reference,
  pageLabel,
}: {
  issuer: string;
  title: string;
  reference?: string | null;
  pageLabel?: string;
}) {
  return (
    <header className="doc__masthead">
      <div>
        <p className="doc__issuer">{issuer}</p>
        <p className="doc__title">{title}</p>
      </div>
      <dl className="doc__refs">
        {reference ? (
          <>
            <dt>Ref</dt>
            <dd>{reference}</dd>
          </>
        ) : null}
        {pageLabel ? (
          <>
            <dt>Page</dt>
            <dd>{pageLabel}</dd>
          </>
        ) : null}
      </dl>
    </header>
  );
}
