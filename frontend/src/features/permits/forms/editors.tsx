import { useId } from 'react';
import type { ChecklistItem, ChecklistResponse, DescriptionRow, SelectionOption } from '../../../api/types';
import { Button } from '../../../ui/Button';
import { Input, Textarea } from '../../../ui/Field';
import { DocumentSection } from '../DocumentParts';
import '../paper.css';

/**
 * Repeatable editors for the bands the real forms print.
 *
 * WHY THE ITEM TEXT IS TYPED RATHER THAN CHOSEN. The authoritative
 * per-template catalogue of checklist questions, hazards and PPE options
 * is not supplied anywhere in this repository, and inventing safety
 * wording is forbidden. The backend models these bands as repeatable
 * labelled rows for exactly that reason, so this editor does the same:
 * the printed text travels with the answer instead of being guessed
 * here. Where a real option list WAS supplied (Cold Work's Nature of
 * Work and Hazards), it is a fixed set of named booleans instead - see
 * `ColdWorkFields`.
 *
 * Every band the backend requires to be non-empty starts with one row,
 * so a person is never left staring at an empty section wondering
 * whether it applies.
 */

const RESPONSES: ChecklistResponse[] = ['YES', 'NO', 'NA'];

const RESPONSE_HELP: Record<ChecklistResponse, string> = {
  YES: 'Yes',
  NO: 'No',
  NA: 'Not applicable',
};

function ResponseChoice({
  value,
  onChange,
  name,
  disabled,
  legend,
}: {
  value: ChecklistResponse;
  onChange: (next: ChecklistResponse) => void;
  name: string;
  disabled: boolean;
  legend: string;
}) {
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="sr-only">{legend}</legend>
      <div className="response-group">
        {RESPONSES.map((response) => (
          <label key={response} className="response-option">
            <input
              type="radio"
              name={name}
              value={response}
              checked={value === response}
              disabled={disabled}
              onChange={() => onChange(response)}
            />
            <span aria-hidden="true">{response}</span>
            <span className="sr-only">{RESPONSE_HELP[response]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ChecklistEditor({
  label,
  items,
  onChange,
  disabled,
  itemNoun = 'item',
}: {
  label: string;
  items: ChecklistItem[];
  onChange: (next: ChecklistItem[]) => void;
  disabled: boolean;
  itemNoun?: string;
}) {
  const groupId = useId();

  function update(index: number, patch: Partial<ChecklistItem>): void {
    onChange(items.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  return (
    <div className="stack stack--tight">
      <p className="doc__field-label">{label}</p>
      <ul className="repeat-list">
        {items.map((item, index) => (
          <li key={index} className="repeat-row">
            <div className="repeat-row__head">
              <span>
                {label} — {itemNoun} {index + 1}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || items.length <= 1}
                onClick={() => onChange(items.filter((_, position) => position !== index))}
              >
                Remove
              </Button>
            </div>

            <Input
              label={`${itemNoun.charAt(0).toUpperCase()}${itemNoun.slice(1)} as printed on the form`}
              value={item.label}
              maxLength={300}
              disabled={disabled}
              onChange={(event) => update(index, { label: event.target.value })}
            />

            <div className="form-grid">
              <div className="field">
                <span className="field__label" id={`${groupId}-${index}-response`}>
                  Response
                </span>
                <ResponseChoice
                  legend={`Response for ${item.label || `${itemNoun} ${index + 1}`}`}
                  name={`${groupId}-${index}`}
                  value={item.response}
                  disabled={disabled}
                  onChange={(response) => update(index, { response })}
                />
              </div>

              <Input
                label="Remarks"
                value={item.remarks ?? ''}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => update(index, { remarks: event.target.value })}
              />
            </div>
          </li>
        ))}
      </ul>

      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || items.length >= 80}
          onClick={() => onChange([...items, { label: '', response: 'NA' }])}
        >
          Add {itemNoun}
        </Button>
      </div>
    </div>
  );
}

export function SelectionEditor({
  label,
  options,
  onChange,
  disabled,
}: {
  label: string;
  options: SelectionOption[];
  onChange: (next: SelectionOption[]) => void;
  disabled: boolean;
}) {
  function update(index: number, patch: Partial<SelectionOption>): void {
    onChange(options.map((option, position) => (position === index ? { ...option, ...patch } : option)));
  }

  return (
    <div className="stack stack--tight">
      <p className="doc__field-label">{label}</p>
      <ul className="repeat-list">
        {options.map((option, index) => (
          <li key={index} className="repeat-row">
            <div className="repeat-row__head">
              <span>
                {label} — option {index + 1}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || options.length <= 1}
                onClick={() => onChange(options.filter((_, position) => position !== index))}
              >
                Remove
              </Button>
            </div>

            <div className="form-grid">
              <Input
                label="Option as printed on the form"
                value={option.label}
                maxLength={200}
                disabled={disabled}
                onChange={(event) => update(index, { label: event.target.value })}
              />
              <Input
                label="Remarks"
                value={option.remarks ?? ''}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => update(index, { remarks: event.target.value })}
              />
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={option.selected}
                disabled={disabled}
                onChange={(event) => update(index, { selected: event.target.checked })}
              />
              <span>Ticked on the form</span>
            </label>
          </li>
        ))}
      </ul>

      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || options.length >= 60}
          onClick={() => onChange([...options, { label: '', selected: false }])}
        >
          Add option
        </Button>
      </div>
    </div>
  );
}

export function DescriptionRowsEditor({
  label,
  rows,
  onChange,
  disabled,
  max = 60,
}: {
  label: string;
  rows: DescriptionRow[];
  onChange: (next: DescriptionRow[]) => void;
  disabled: boolean;
  max?: number;
}) {
  function update(index: number, patch: Partial<DescriptionRow>): void {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="stack stack--tight">
      <p className="doc__field-label">{label}</p>
      {rows.length === 0 ? <p className="muted text-sm">None recorded. This section may be left empty.</p> : null}
      <ul className="repeat-list">
        {rows.map((row, index) => (
          <li key={index} className="repeat-row">
            <div className="repeat-row__head">
              <span>
                {label} — entry {index + 1}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, position) => position !== index))}
              >
                Remove
              </Button>
            </div>
            <div className="form-grid">
              <Input
                label="Description"
                value={row.description}
                maxLength={300}
                disabled={disabled}
                onChange={(event) => update(index, { description: event.target.value })}
              />
              <Input
                label="Remarks"
                value={row.remarks ?? ''}
                maxLength={500}
                disabled={disabled}
                onChange={(event) => update(index, { remarks: event.target.value })}
              />
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || rows.length >= max}
          onClick={() => onChange([...rows, { description: '' }])}
        >
          Add entry
        </Button>
      </div>
    </div>
  );
}

/** A group of fixed, supplied tick-box options modelled as named booleans. */
export function BooleanGroupEditor<K extends string>({
  label,
  entries,
  values,
  onChange,
  disabled,
}: {
  label: string;
  entries: { key: K; label: string }[];
  values: Record<K, boolean>;
  onChange: (next: Record<K, boolean>) => void;
  disabled: boolean;
}) {
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="doc__field-label" style={{ marginBottom: 'var(--space-1)' }}>
        {label}
      </legend>
      <div className="doc__ticks">
        {entries.map((entry) => (
          <label key={entry.key} className={disabled ? 'check check--disabled' : 'check'}>
            <input
              type="checkbox"
              checked={values[entry.key]}
              disabled={disabled}
              onChange={(event) => onChange({ ...values, [entry.key]: event.target.checked })}
            />
            <span>{entry.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A free-text section rendered inside the document frame. */
export function NotesSection({
  number,
  title,
  fields,
  disabled,
}: {
  number: string;
  title: string;
  disabled: boolean;
  fields: { label: string; value: string; maxLength: number; onChange: (next: string) => void }[];
}) {
  return (
    <DocumentSection number={number} title={title}>
      <div className="form-grid form-grid--full">
        {fields.map((field) => (
          <Textarea
            key={field.label}
            label={field.label}
            value={field.value}
            maxLength={field.maxLength}
            disabled={disabled}
            onChange={(event) => field.onChange(event.target.value)}
          />
        ))}
      </div>
    </DocumentSection>
  );
}
