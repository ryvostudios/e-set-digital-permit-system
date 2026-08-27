import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listNotifications, markNotificationRead } from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import type { AppNotification, NotificationListResponse } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { formatRelative } from '../../lib/format';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Alert, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Badge, Card, PageHeader, Pagination, Tabs } from '../../ui/Layout';

/**
 * Notifications.
 *
 * A NOTIFICATION IS NOT AN AUTHORIZATION. Being told that a permit moved
 * does not grant the right to open it: following the link makes an
 * ordinary authorized request, and if the person may not see that permit
 * the detail screen says so. That is why a notification link is a plain
 * navigation and never carries a token, an id shortcut, or any other
 * bypass.
 *
 * A link can also go stale - the permit may since have been deleted from
 * view, or the reader's permissions may have narrowed. That is handled
 * as an ordinary "not available" rather than an error state.
 */

function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
  busy,
}: {
  notification: AppNotification;
  onOpen: (permitId: string) => void;
  onMarkRead: (id: string) => void;
  busy: boolean;
}) {
  const unread = notification.read_at === null;

  return (
    <li
      className="record-list__item"
      style={unread ? { borderLeft: '3px solid var(--brand-primary)' } : undefined}
    >
      <div className="record-list__head">
        <span style={{ fontWeight: unread ? 700 : 500 }}>{notification.title}</span>
        {unread ? <Badge tone="warning">Unread</Badge> : null}
      </div>
      <p className="muted">{notification.message}</p>
      <div className="row" style={{ marginTop: 'var(--space-3)', justifyContent: 'space-between' }}>
        <span className="muted text-sm">{formatRelative(notification.created_at)}</span>
        <span className="row">
          {notification.permit_id ? (
            <Button size="sm" variant="secondary" onClick={() => onOpen(notification.permit_id as string)}>
              Open permit
            </Button>
          ) : null}
          {unread ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMarkRead(notification.id)}>
              Mark as read
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

const TABS = [
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All' },
];

export function NotificationsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'unread' | 'all'>('unread');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resource = useApiResource<NotificationListResponse>(
    (signal) => listNotifications({ page, pageSize: 20, ...(tab === 'unread' ? { unread: 'true' } : {}) }, signal),
    [tab, page],
  );

  // Defensive: a response missing this key must render an empty list,
  // never crash the screen.
  const notifications = resource.data?.notifications ?? [];

  async function handleMarkRead(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await markNotificationRead(id);
      resource.reload();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Notifications"
        description="Workflow updates for permits you are involved with."
      />

      <div className="stack">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Tabs
          tabs={TABS}
          activeId={tab}
          label="Notification filter"
          onChange={(next) => {
            setTab(next as 'unread' | 'all');
            setPage(1);
          }}
        />

        <Card flush>
          {resource.initialLoading ? (
            <SkeletonRows rows={4} />
          ) : resource.error ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : notifications.length === 0 ? (
            <div className="state">
              <p className="state__body">
                {tab === 'unread' ? 'You have no unread notifications.' : 'You have no notifications yet.'}
              </p>
            </div>
          ) : (
            <>
              <ul className="record-list">
                {notifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    busy={busyId === notification.id}
                    onMarkRead={(id) => void handleMarkRead(id)}
                    onOpen={(permitId) => navigate(ROUTES.permit(permitId))}
                  />
                ))}
              </ul>
              {resource.data ? (
                <Pagination
                  page={resource.data.pagination.page}
                  pageSize={resource.data.pagination.pageSize}
                  totalCount={resource.data.pagination.totalCount}
                  totalPages={resource.data.pagination.totalPages}
                  busy={resource.loading}
                  onPageChange={setPage}
                />
              ) : null}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
