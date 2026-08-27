import { Link } from 'react-router-dom';
import { listMyDrafts } from '../../api/endpoints';
import type { PermitListResponse } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { useApiResource } from '../../lib/useApiResource';
import { ErrorState, SkeletonRows } from '../../ui/Feedback';
import { PageHeader, StatusBadge } from '../../ui/Layout';
import { permitTypeLabel } from './labels';

/**
 * The applicant's own unfinished permits.
 *
 * SEPARATE FROM PERMIT RECORDS ON PURPOSE. A draft is private work in
 * progress; Permit Records is the formal workflow list. Keeping them
 * apart is also what stops broad record visibility - CEO, Site Manager,
 * `permit.view_all` - from surfacing other people's half-finished safety
 * documents: this screen calls an endpoint scoped by `created_by` that
 * takes no parameter capable of widening it.
 */
export function MyDraftsPage() {
  const resource = useApiResource<PermitListResponse>((signal) => listMyDrafts({ pageSize: 50 }, signal), []);
  const drafts = resource.data?.permits ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="My drafts"
        description="Permits you have started but not yet submitted. Only you can see these."
      />

      <div className="card" data-testid="my-drafts">
        {resource.initialLoading ? (
          <SkeletonRows rows={3} />
        ) : resource.error ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : drafts.length === 0 ? (
          <div className="state">
            <p className="state__title">No drafts</p>
            <p className="state__body">
              Permits you start appear here until you submit them.{' '}
              <Link to={ROUTES.apply}>Apply for a permit</Link>.
            </p>
          </div>
        ) : (
          <ul className="record-list">
            {drafts.map((permit) => (
              <li key={permit.id} className="record-list__item" data-testid="my-draft-row">
                <div className="record-list__head">
                  <span style={{ fontWeight: 600 }}>
                    {permitTypeLabel(permit.permit_type)} · {permit.permitDisplayNumber}
                  </span>
                  <StatusBadge status={permit.status} />
                </div>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-2)' }}>
                  <span className="muted text-sm">
                    Last saved {new Date(permit.updated_at).toLocaleString()}
                  </span>
                  <Link className="btn btn--secondary btn--sm" to={ROUTES.permit(permit.id)}>
                    Continue editing
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
