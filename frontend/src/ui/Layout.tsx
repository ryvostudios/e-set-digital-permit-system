import { useState, type ReactNode } from 'react';
import type { PermitStatus } from '../api/types';
import { Button } from './Button';

/** A page's title block. One per screen, so heading order is predictable. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
        <h1 className="page-header__title">{title}</h1>
        {description ? <div className="page-header__description">{description}</div> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  flush = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card__header">
          {typeof title === 'string' ? <h2 className="card__title">{title}</h2> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

/**
 * A filter panel that starts OPEN on a wide screen and COLLAPSED on a
 * phone.
 *
 * On a 390px screen an expanded filter form fills the entire first
 * viewport, so the records a person came to read are pushed off-screen
 * behind controls they usually do not need. A native `<details>` keeps
 * that behaviour keyboard-accessible and announced without any custom
 * disclosure logic.
 */
export function FilterPanel({ title, children }: { title: string; children: ReactNode }) {
  const [open] = useState(() => {
    try {
      return window.matchMedia('(min-width: 52rem)').matches;
    } catch {
      return true;
    }
  });

  return (
    <details className="filter-panel" open={open}>
      <summary className="filter-panel__summary">{title}</summary>
      <div className="filter-panel__body">{children}</div>
    </details>
  );
}

const STATUS_LABELS: Record<PermitStatus, string> = {
  DRAFT: 'Draft',
  PENDING_CRO: 'Pending CRO',
  PENDING_HSE: 'Pending HSE',
  PENDING_CORRECTION: 'Returned for correction',
  ISSUED: 'Issued',
  HELD: 'On hold',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
};

export function permitStatusLabel(status: PermitStatus | string): string {
  return STATUS_LABELS[status as PermitStatus] ?? status;
}

/**
 * A permit status.
 *
 * The status TEXT is always present - colour reinforces it and never
 * carries the meaning on its own, so the badge stays readable in
 * greyscale, in bright sunlight, and to a colour-blind reader.
 */
export function StatusBadge({ status }: { status: PermitStatus | string }) {
  return (
    <span className={`badge badge--${status}`}>
      <span className="badge__dot" aria-hidden="true" />
      {permitStatusLabel(status)}
    </span>
  );
}

/** A general-purpose labelled badge (account state, permission state). */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
  busy = false,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  busy?: boolean;
}) {
  if (totalCount === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalCount);

  return (
    <nav className="pagination" aria-label="Pagination">
      <p>
        Showing {first}–{last} of {totalCount}
      </p>
      <div className="pagination__controls">
        <Button size="sm" variant="secondary" disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span aria-current="page">
          Page {page} of {Math.max(totalPages, 1)}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

export interface TabDefinition {
  id: string;
  label: string;
}

/** A tablist with roving selection. Panels are the caller's responsibility. */
export function Tabs({
  tabs,
  activeId,
  onChange,
  label,
}: {
  tabs: TabDefinition[];
  activeId: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="tabs__tab"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === activeId}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === activeId ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const index = tabs.findIndex((entry) => entry.id === activeId);
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              onChange(tabs[(index + 1) % tabs.length]?.id ?? activeId);
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onChange(tabs[(index - 1 + tabs.length) % tabs.length]?.id ?? activeId);
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, activeId, children }: { id: string; activeId: string; children: ReactNode }) {
  if (id !== activeId) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
