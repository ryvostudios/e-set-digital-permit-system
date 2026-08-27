import { useState } from 'react';
import { listPermitQueue } from '../../api/endpoints';
import type { PermitListResponse } from '../../api/types';
import { useApiResource } from '../../lib/useApiResource';
import { ErrorState, SkeletonRows } from '../../ui/Feedback';
import { PageHeader, Pagination } from '../../ui/Layout';
import { PermitList } from '../permits/PermitList';

/**
 * A capability-gated review queue.
 *
 * The queue is fetched from `GET /permits/queue`, which checks the
 * caller's capability for the requested status server-side and answers
 * 403 if they do not hold it. That refusal is shown honestly rather than
 * hidden: a person who reaches this route without the authority sees
 * "You do not have permission to do this", not an empty list that looks
 * like there is no work.
 *
 * This is also why the route stays reachable at all. Hiding the
 * navigation link is a courtesy; the server is what decides.
 */
export function ReviewQueue({
  eyebrow,
  title,
  description,
  status,
  emptyMessage,
}: {
  eyebrow: string;
  title: string;
  description: string;
  status: 'PENDING_CRO' | 'PENDING_HSE' | 'ISSUED';
  emptyMessage: string;
}) {
  const [page, setPage] = useState(1);
  const resource = useApiResource<PermitListResponse>(
    (signal) => listPermitQueue({ status, page, pageSize: 20 }, signal),
    [status, page],
  );

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />

      <div className="card">
        {resource.initialLoading ? (
          <SkeletonRows rows={5} />
        ) : resource.error ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : (
          <>
            <PermitList permits={resource.data?.permits ?? []} emptyMessage={emptyMessage} />
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
      </div>
    </>
  );
}
