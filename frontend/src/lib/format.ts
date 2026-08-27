/**
 * Display formatting. Nothing here is authoritative: a permit's validity,
 * its expiry, and every timestamp are computed by the backend from its
 * own clock. These functions only render what the server already decided.
 */

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const DATE_ONLY = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY.format(date);
}

/** An ISO instant as the value a `datetime-local` input expects, in the viewer's own timezone. */
export function toLocalInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The reverse: a `datetime-local` value as the ISO-8601 UTC instant the backend's schema requires. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Relative wording for a notification list ("4 minutes ago"), falling back to an absolute date. */
export function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (seconds < 604_800) {
    const days = Math.floor(seconds / 86_400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return formatDate(value);
}

/** A stable, human-readable id for `aria-describedby`/`htmlFor` pairs. */
let idCounter = 0;
export function nextFieldId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
