import type { ReactNode } from 'react';
import { asApiError } from '../api/errors';
import { Button } from './Button';

/** A short, non-technical message with a severity. Never carries server internals. */
export function Alert({
  tone = 'info',
  title,
  children,
  requestId,
  role,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  requestId?: string | null;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`alert alert--${tone}`} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      <div className="alert__body">
        {title ? <p className="alert__title">{title}</p> : null}
        <div>{children}</div>
        {requestId ? <p className="alert__meta">Reference: {requestId}</p> : null}
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="btn__spinner" style={{ color: 'var(--brand-primary)' }} aria-hidden="true" />
      <p className="state__body">{label}…</p>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {children ? <div className="state__body">{children}</div> : null}
      {action}
    </div>
  );
}

/**
 * The one way a failed load is presented.
 *
 * The message comes from the centralized error model, so the person sees
 * "You do not have permission to do this" rather than a status code, and
 * never a stack trace, SQL, or an environment variable name. Where the
 * backend returned a correlation id, it is offered as a reference so an
 * operator can find the request - the only diagnostic detail shown.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = asApiError(error);
  const canRetry = onRetry && apiError.code !== 'forbidden' && apiError.code !== 'not_found';
  return (
    <div className="state">
      <p className="state__title">
        {apiError.code === 'forbidden'
          ? 'Not available to you'
          : apiError.code === 'not_found'
            ? 'Not found'
            : 'Could not load this'}
      </p>
      <p className="state__body">{apiError.message}</p>
      {apiError.requestId ? <p className="alert__meta">Reference: {apiError.requestId}</p> : null}
      {canRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ height = '1rem', width = '100%' }: { height?: string; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

/** A few skeleton rows, for a list that is loading for the first time. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 'var(--space-5)' }} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height="1.25rem" />
      ))}
    </div>
  );
}
