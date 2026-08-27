import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/**
 * Form primitives.
 *
 * Every control here is wired to a real `<label htmlFor>`, and any hint
 * or error text is referenced by `aria-describedby` - so a screen reader
 * announces the label, the requirement, and the failure together. An
 * invalid control also carries `aria-invalid`, because a red border is
 * not a message.
 */

interface FieldShellProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  hintId: string;
  errorId: string;
  children: ReactNode;
}

function FieldShell({ label, htmlFor, required, hint, error, hintId, errorId, children }: FieldShellProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(hint: unknown, error: unknown, hintId: string, errorId: string): string | undefined {
  const ids = [hint ? hintId : null, error ? errorId : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  compact?: boolean;
}

export function Input({ label, hint, error, compact = false, required, ...rest }: InputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      {...(required ? { required: true } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      hintId={hintId}
      errorId={errorId}
    >
      <input
        {...rest}
        id={id}
        required={required}
        className={compact ? 'input input--compact' : 'input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'compact'> {}

/**
 * A password field with a show/hide control.
 *
 * The value lives only in the caller's React state for as long as the
 * form is open. Nothing here writes it to storage, sends it anywhere but
 * the endpoint the caller chose, or logs it.
 */
export function PasswordInput({ label, hint, error, required, ...rest }: PasswordInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [revealed, setRevealed] = useState(false);

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      {...(required ? { required: true } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      hintId={hintId}
      errorId={errorId}
    >
      <div className="password-field">
        <input
          {...rest}
          id={id}
          required={required}
          type={revealed ? 'text' : 'password'}
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, hintId, errorId)}
        />
        {/*
          An explicit accessible name, rather than one assembled from a
          visible word plus a visually-hidden one - the two would be
          announced run together.
        */}
        <button
          type="button"
          className="password-field__toggle"
          onClick={() => setRevealed((value) => !value)}
          aria-pressed={revealed}
          aria-controls={id}
          aria-label={revealed ? 'Hide password' : 'Show password'}
        >
          <span aria-hidden="true">{revealed ? 'Hide' : 'Show'}</span>
        </button>
      </div>
    </FieldShell>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  compact?: boolean;
  children: ReactNode;
}

export function Select({ label, hint, error, compact = false, required, children, ...rest }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      {...(required ? { required: true } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      hintId={hintId}
      errorId={errorId}
    >
      <select
        {...rest}
        id={id}
        required={required}
        className={compact ? 'select input--compact' : 'select'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

export function Textarea({ label, hint, error, required, ...rest }: TextareaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      {...(required ? { required: true } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      hintId={hintId}
      errorId={errorId}
    >
      <textarea
        {...rest}
        id={id}
        required={required}
        className="textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  label: ReactNode;
}

export function Checkbox({ label, disabled, ...rest }: CheckboxProps) {
  return (
    <label className={disabled ? 'check check--disabled' : 'check'}>
      <input {...rest} type="checkbox" disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

/** A form-level error, announced as soon as it appears. */
export function FormError({ message, requestId }: { message: string; requestId?: string | null }) {
  return (
    <div className="alert alert--danger" role="alert">
      <div className="alert__body">
        <p>{message}</p>
        {requestId ? <p className="alert__meta">Reference: {requestId}</p> : null}
      </div>
    </div>
  );
}
