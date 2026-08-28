import type { PermitActorIdentity } from '../../api/types';

/**
 * WHO DID IT - one way of saying it, everywhere it is said.
 *
 * The closure section and the permit history both have to name a person
 * who acted on the permit. They name them the same way, from the same
 * server-resolved identity, so the two never disagree and neither is a
 * bespoke string built at its own call site.
 *
 * A privileged account (CEO / System Site Manager) has no team or
 * position, so its role label stands in for a job title. An employee
 * gets their real position and team. Whatever is missing is simply
 * omitted rather than filled in.
 */

/** "CRO · E-BOP", or "CEO" for a privileged actor. Empty when nothing is known. */
export function actorRoleContext(actor: PermitActorIdentity | null | undefined): string {
  if (!actor) return '';
  if (actor.privilegedRole) return actor.privilegedRole;
  return [actor.positionName, actor.teamName].filter(Boolean).join(' · ');
}

/**
 * An actor named inline, as "Osama — CRO · E-BOP".
 *
 * Renders the explicit unknown when the server could not resolve the
 * identity: the action was certainly performed by someone, and saying
 * so is more honest than showing nothing or guessing a name.
 */
export function EventActor({
  actor,
  label,
}: {
  actor: PermitActorIdentity | null;
  label: string;
}) {
  const context = actorRoleContext(actor);
  return (
    <p className="text-sm" style={{ marginTop: 'var(--space-2)' }}>
      <span className="muted">{label} </span>
      {actor ? (
        <>
          <span style={{ fontWeight: 600 }}>{actor.displayName}</span>
          {context ? <span className="muted">{` — ${context}`}</span> : null}
        </>
      ) : (
        <span className="muted">an account that can no longer be identified</span>
      )}
    </p>
  );
}
