import { Link } from 'react-router-dom';
import { listMyPermits, listNotifications, listPermitQueue } from '../../api/endpoints';
import type { NotificationListResponse, PermitListResponse } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { useCurrentUser } from '../../auth/useAuth';
import { formatRelative } from '../../lib/format';
import { useApiResource } from '../../lib/useApiResource';
import { ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Card, PageHeader } from '../../ui/Layout';
import { PermitList } from '../permits/PermitList';

/**
 * The operational home screen.
 *
 * It answers one question: what needs attention right now. Everything on
 * it is a real list the backend already exposes - the caller's own
 * permits, their review queue if they have one, and their unread
 * notifications. NO STATISTIC IS INVENTED: there is no throughput chart,
 * no compliance score, and no counter the API does not actually return.
 * The one number shown, the queue depth, is the `totalCount` the
 * paginated endpoint itself reports.
 */

function QueueCard({
  title,
  status,
  to,
  emptyMessage,
}: {
  title: string;
  status: 'PENDING_CRO' | 'PENDING_HSE';
  to: string;
  emptyMessage: string;
}) {
  const resource = useApiResource<PermitListResponse>(
    (signal) => listPermitQueue({ status, pageSize: 5 }, signal),
    [status],
  );

  return (
    <Card
      title={title}
      actions={
        <Link className="btn btn--ghost btn--sm" to={to}>
          Open queue
        </Link>
      }
      flush
    >
      {resource.initialLoading ? (
        <SkeletonRows rows={3} />
      ) : resource.error ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <ErrorState error={resource.error} onRetry={resource.reload} />
        </div>
      ) : (
        <>
          {resource.data && resource.data.pagination.totalCount > 0 ? (
            <p className="muted text-sm" style={{ padding: 'var(--space-3) var(--space-5) 0' }}>
              {resource.data.pagination.totalCount} awaiting review
              {resource.data.pagination.totalCount > 5 ? ' — showing the five oldest' : ''}.
            </p>
          ) : null}
          <PermitList permits={resource.data?.permits ?? []} emptyMessage={emptyMessage} />
        </>
      )}
    </Card>
  );
}

function UnreadNotifications() {
  const resource = useApiResource<NotificationListResponse>(
    (signal) => listNotifications({ unread: 'true', pageSize: 5 }, signal),
    [],
  );

  if (resource.initialLoading) return <SkeletonRows rows={3} />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  const notifications = resource.data?.notifications ?? [];
  if (notifications.length === 0) {
    return <p className="muted">Nothing unread.</p>;
  }

  return (
    <ul className="stack stack--tight" style={{ listStyle: 'none' }}>
      {notifications.map((notification) => (
        <li key={notification.id}>
          <p style={{ fontWeight: 600 }}>{notification.title}</p>
          <p className="muted text-sm">{formatRelative(notification.created_at)}</p>
        </li>
      ))}
    </ul>
  );
}

function MyRecentPermits() {
  const resource = useApiResource<PermitListResponse>((signal) => listMyPermits({ pageSize: 5 }, signal), []);

  if (resource.initialLoading) return <SkeletonRows rows={4} />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <PermitList
      permits={resource.data?.permits ?? []}
      emptyMessage="You have not raised any permits yet."
    />
  );
}

export function HomePage() {
  const { capabilities } = useCurrentUser();

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`Good day, ${capabilities.displayName}`}
        description={
          capabilities.profile
            ? `${capabilities.profile.positionName} · ${capabilities.profile.teamName} · ${capabilities.profile.company.name}`
            : null
        }
        actions={
          capabilities.canApplyForPermits ? (
            <Link className="btn btn--primary" to={ROUTES.apply}>
              Apply for permit
            </Link>
          ) : null
        }
      />

      <div className="stack">
        {capabilities.canReviewAsCro ? (
          <QueueCard
            title="Awaiting your CRO review"
            status="PENDING_CRO"
            to={ROUTES.croQueue}
            emptyMessage="No permits are waiting for CRO review."
          />
        ) : null}

        {capabilities.canReviewAsHse ? (
          <QueueCard
            title="Awaiting your HSE approval"
            status="PENDING_HSE"
            to={ROUTES.hseQueue}
            emptyMessage="No permits are waiting for HSE approval."
          />
        ) : null}

        <Card
          title={capabilities.canViewAllPermits ? 'Recent permit activity' : 'Your recent permits'}
          actions={
            <Link className="btn btn--ghost btn--sm" to={ROUTES.records}>
              All records
            </Link>
          }
          flush
        >
          <MyRecentPermits />
        </Card>

        <div className="grid-2">
          <Card
            title="Unread notifications"
            actions={
              <Link className="btn btn--ghost btn--sm" to={ROUTES.notifications}>
                View all
              </Link>
            }
          >
            <UnreadNotifications />
          </Card>

          {capabilities.canManageEmployees ? (
            <Card title="Administration">
              <p className="muted" style={{ marginBottom: 'var(--space-4)' }}>
                You manage employee accounts for E-SET, ZPL, and SGRE.
              </p>
              <div className="row">
                <Link className="btn btn--secondary btn--sm" to={ROUTES.employees}>
                  Employees
                </Link>
                <Link className="btn btn--secondary btn--sm" to={ROUTES.employeeNew}>
                  Add employee
                </Link>
                {capabilities.canManageSiteManagers ? (
                  <Link className="btn btn--secondary btn--sm" to={ROUTES.siteManagers}>
                    System Site Managers
                  </Link>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>

        {!capabilities.canApplyForPermits && !capabilities.canReviewAsCro && !capabilities.canReviewAsHse ? (
          <Card title="Your access">
            <p className="muted">
              Your role does not currently include raising or reviewing permits. You can still open the permit records
              you are authorized to see.
            </p>
            <div className="row" style={{ marginTop: 'var(--space-4)' }}>
              <Link className="btn btn--secondary btn--sm" to={ROUTES.records}>
                Permit records
              </Link>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
