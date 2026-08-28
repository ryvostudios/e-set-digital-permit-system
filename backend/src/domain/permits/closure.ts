import type { QueryFn } from '../../db/pool.js';
import { resolvePermitActorIdentities, type PermitActorIdentity } from './actorIdentity.js';
import type { PermitRow } from './service.js';

/**
 * WHO ACTUALLY CLOSED THE PERMIT.
 *
 * A permit is closed by whichever CRO is on duty when the work finishes,
 * and that is very often not the CRO who reviewed or forwarded it hours
 * earlier. Both facts belong in the record and neither may be inferred
 * from the other: the CRO authorization on the issued document is frozen
 * evidence of who authorized the work, and the closure is separate
 * evidence of who signed it off as finished.
 *
 * `permits.closed_by` already stores the authenticated actor who
 * performed the close - the service writes `actorUserId`, never a value
 * from the request - so nothing about the workflow changes here. What was
 * missing is that a raw user id cannot be shown to anyone.
 *
 * The closer is resolved by the SHARED actor resolver, the same one that
 * names actors in the permit's history, so a CRO and a privileged
 * CEO/System Site Manager who closes a permit are both named, and both
 * described the way the rest of the application describes them. See
 * `actorIdentity.ts` for the read-time limitation that resolution
 * carries.
 */

/** The closer is an actor like any other; the alias is kept for readability at call sites. */
export type PermitCloserIdentity = PermitActorIdentity;

export interface PermitClosure {
  closedAt: string;
  remarks: string | null;
  /** Null when the closer has no resolvable identity. Never invented. */
  closedBy: PermitCloserIdentity | null;
}

/**
 * The closure record for a permit, given already-resolved actor
 * identities, or null if the permit is not closed.
 *
 * A permit closed by someone with no usable identity still returns its
 * closure - the timestamp and remarks are facts regardless - with
 * `closedBy` null rather than a fabricated name.
 */
export function buildPermitClosure(
  permit: Pick<PermitRow, 'status' | 'closed_by' | 'closed_at' | 'closure_remarks'>,
  actors: ReadonlyMap<string, PermitActorIdentity>,
): PermitClosure | null {
  if (permit.status !== 'CLOSED' || !permit.closed_at) return null;
  return {
    closedAt: permit.closed_at,
    remarks: permit.closure_remarks,
    closedBy: (permit.closed_by && actors.get(permit.closed_by)) || null,
  };
}

/** The closure record for a permit, resolving its closer. Null if not closed. */
export async function getPermitClosure(
  queryFn: QueryFn,
  permit: Pick<PermitRow, 'status' | 'closed_by' | 'closed_at' | 'closure_remarks'>,
): Promise<PermitClosure | null> {
  if (permit.status !== 'CLOSED' || !permit.closed_at) return null;
  const actors = await resolvePermitActorIdentities(queryFn, permit.closed_by ? [permit.closed_by] : []);
  return buildPermitClosure(permit, actors);
}
