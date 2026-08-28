import type { PermitClosure as PermitClosureRecord } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { DocumentField, DocumentSection, FieldGrid } from './DocumentParts';
import { actorRoleContext } from './EventActor';

/**
 * WHO CLOSED THE PERMIT, AND WHEN.
 *
 * The CRO who closes a permit is very often not the CRO who reviewed or
 * forwarded it - the work runs for hours and shifts change. Both facts
 * belong in the record, and neither may be read off the other: the CRO
 * authorization on the issued document says who authorized the work, and
 * this says who signed it off as finished.
 *
 * It is therefore its own section rather than a line appended to the
 * authorization band, and it names the person the SERVER recorded as the
 * closing actor - never the original reviewer, and never a name derived
 * from a signature.
 *
 * BLANK STAYS BLANK. Closure remarks are optional; an empty one is shown
 * as empty rather than filled with something plausible. A closer with no
 * resolvable identity shows the closure without a name rather than
 * inventing one.
 *
 * The closer may be an ordinary CRO or a privileged account, so their
 * role comes from the shared actor presentation: a real position and
 * team for an employee, the privileged role label for a CEO / System
 * Site Manager, who has no team or position to show.
 */
export function PermitClosure({ closure }: { closure: PermitClosureRecord }) {
  const { closedBy } = closure;
  const roleContext = actorRoleContext(closedBy);

  return (
    <DocumentSection
      number="9"
      title="Closure"
      note="Recorded by the system when the permit was closed"
    >
      <FieldGrid>
        <DocumentField label="Closed by" value={closedBy?.displayName ?? ''} strong />
        {roleContext ? <DocumentField label="Role" value={roleContext} /> : null}
        {closedBy?.companyName ? <DocumentField label="Company" value={closedBy.companyName} /> : null}
        <DocumentField label="Closed at" value={formatDateTime(closure.closedAt)} />
        <DocumentField label="Remarks" value={closure.remarks ?? ''} full />
      </FieldGrid>
      {!closedBy ? (
        <p className="muted text-sm">
          The closing actor is recorded on the permit, but no account record is available to name them.
        </p>
      ) : null}
    </DocumentSection>
  );
}
