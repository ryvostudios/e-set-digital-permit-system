import type { LifecycleEvent } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { permitStatusLabel } from '../../ui/Layout';
import { EventActor } from './EventActor';
import { lifecycleEventLabel } from './labels';

/**
 * The permit's append-only history, in plain language.
 *
 * WHAT IS DELIBERATELY NOT SHOWN: the append-only ordinal, the event id,
 * the permit id, and any actor's raw user id. A history screen exists so
 * a person can read what happened to this permit, not so raw database
 * internals leak into the UI. The identities that authorized the work
 * are shown as frozen signatures on the permit itself, where they carry
 * a real name and designation.
 *
 * CLOSURE IS THE EXCEPTION, and has to be. Nothing else on the record
 * names the person who closed the permit: closing produces no signature,
 * and the CRO who closes is very often not the CRO who authorized the
 * work. So the closing event names its actor - the real actor the server
 * recorded on the immutable event, resolved server-side, never read off
 * a signature or off the Closure section beside it.
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
          {/* The closure is the one transition whose actor exists nowhere
              else on the record. `to_status` decides it, so the rule is
              about what happened rather than about one event-type
              spelling. */}
          {event.to_status === 'CLOSED' ? <EventActor actor={event.actor} label="Closed by" /> : null}
          {event.reason ? <p style={{ marginTop: 'var(--space-2)' }}>“{event.reason}”</p> : null}
        </li>
      ))}
    </ol>
  );
}
