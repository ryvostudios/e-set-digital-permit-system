import type { LifecycleEvent } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { permitStatusLabel } from '../../ui/Layout';
import { lifecycleEventLabel } from './labels';

/**
 * The permit's append-only history, in plain language.
 *
 * WHAT IS DELIBERATELY NOT SHOWN: the append-only ordinal, the event id,
 * the permit id, and the actor's user id. A history screen exists so a
 * person can read what happened to this permit, not so raw database
 * internals leak into the UI. The identities that DO matter - who
 * authorized what - are shown as frozen signatures on the permit itself,
 * where they carry a real name and designation.
 */
export function PermitHistory({ events }: { events: LifecycleEvent[] }) {
  if (events.length === 0) {
    return <p className="muted">No activity has been recorded for this permit yet.</p>;
  }

  // The API returns chronological order; keep it, so the record reads
  // top to bottom the way the work actually happened.
  return (
    <ol className="record-list" style={{ listStyle: 'none' }}>
      {events.map((event) => (
        <li key={event.id} className="record-list__item">
          <div className="record-list__head">
            <span style={{ fontWeight: 600 }}>{lifecycleEventLabel(event.event_type)}</span>
            <span className="muted text-sm">{formatDateTime(event.occurred_at)}</span>
          </div>
          <p className="muted text-sm">
            {event.from_status
              ? `${permitStatusLabel(event.from_status)} → ${permitStatusLabel(event.to_status)}`
              : permitStatusLabel(event.to_status)}
          </p>
          {event.reason ? <p style={{ marginTop: 'var(--space-2)' }}>“{event.reason}”</p> : null}
        </li>
      ))}
    </ol>
  );
}
