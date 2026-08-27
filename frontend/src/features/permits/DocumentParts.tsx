import type { ReactNode } from 'react';
import type { ChecklistItem, DescriptionRow, SelectionOption } from '../../api/types';
import './paper.css';

/**
 * The building blocks of the controlled-document presentation, shared by
 * the Permit and the JSA so the two read as one piece of paperwork.
 *
 * Every value rendered here comes from the API as plain text and is
 * placed in the DOM as a React child, which escapes it. No component in
 * this application ever injects raw HTML - see `test/security.test.ts`,
 * which enforces that over the whole source tree - so a string returned
 * by the server can never become markup.
 */

export function DocumentSection({
  number,
  title,
  note,
  flush = false,
  children,
}: {
  number: string;
  title: string;
  note?: string;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="doc__section">
      <div className="doc__section-head">
        <span className="doc__section-number">{number}</span>
        <h3 className="doc__section-title">{title}</h3>
        {note ? <span className="doc__section-note">{note}</span> : null}
      </div>
      <div className={flush ? 'doc__section-body doc__section-body--flush' : 'doc__section-body'}>{children}</div>
    </section>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="doc__fields">{children}</div>;
}

export function DocumentField({
  label,
  value,
  full = false,
  strong = false,
}: {
  label: string;
  value: ReactNode;
  full?: boolean;
  strong?: boolean;
}) {
  const isEmpty = value === null || value === undefined || value === '';
  return (
    <div className={full ? 'doc__field doc__field--full' : 'doc__field'}>
      <span className="doc__field-label">{label}</span>
      <span
        className={[
          'doc__field-value',
          strong ? 'doc__field-value--strong' : '',
          isEmpty ? 'doc__field-value--empty' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {isEmpty ? 'Not recorded' : value}
      </span>
    </div>
  );
}

/**
 * One printed checklist band. `YES` / `NO` / `NA` are the form's three
 * real answers - `NA` is not the same as `NO`, so it is rendered as its
 * own distinct state rather than as a blank.
 */
export function ChecklistTable({ caption, items }: { caption: string; items: ChecklistItem[] }) {
  if (items.length === 0) {
    return <p className="muted text-sm">No entries recorded for {caption}.</p>;
  }
  return (
    <table className="doc__grid">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Response</th>
          <th scope="col">Remarks</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${item.label}-${index}`}>
            <td data-label="Item">{item.label}</td>
            <td data-label="Response">
              <span className={`doc__response doc__response--${item.response}`}>{item.response}</span>
            </td>
            <td data-label="Remarks">{item.remarks ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A "select all that apply" band, with the printed option text beside each box. */
export function TickList({ label, options }: { label: string; options: SelectionOption[] }) {
  if (options.length === 0) {
    return <p className="muted text-sm">No {label.toLowerCase()} recorded.</p>;
  }
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
      <legend className="doc__field-label" style={{ marginBottom: 'var(--space-2)' }}>
        {label}
      </legend>
      <div className="doc__ticks">
        {options.map((option, index) => (
          <span key={`${option.label}-${index}`} className={option.selected ? 'doc__tick' : 'doc__tick doc__tick--off'}>
            <span className="doc__tick-box" aria-hidden="true">
              {option.selected ? '✓' : ''}
            </span>
            <span>
              <span className="sr-only">{option.selected ? 'Selected: ' : 'Not selected: '}</span>
              {option.label}
              {option.remarks ? <span className="muted"> — {option.remarks}</span> : null}
            </span>
          </span>
        ))}
      </div>
    </fieldset>
  );
}

/** Named booleans (Cold Work's supplied Nature of Work / Hazard lists) as the same tick band. */
export function BooleanTickList({ label, entries }: { label: string; entries: { label: string; value: boolean }[] }) {
  return (
    <TickList label={label} options={entries.map((entry) => ({ label: entry.label, selected: entry.value }))} />
  );
}

export function DescriptionTable({ caption, rows }: { caption: string; rows: DescriptionRow[] }) {
  if (rows.length === 0) return <p className="muted text-sm">No {caption.toLowerCase()} recorded.</p>;
  return (
    <table className="doc__grid">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{caption}</th>
          <th scope="col">Remarks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.description}-${index}`}>
            <td data-label={caption}>{row.description}</td>
            <td data-label="Remarks">{row.remarks ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
