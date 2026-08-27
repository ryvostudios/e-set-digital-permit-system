import { ReviewQueue } from './ReviewQueue';

/**
 * The Control Room Operator review queue.
 *
 * CRO authority belongs to exactly one Team + Position - E-SET / E-BOP /
 * CRO - and comes solely from that combination's capabilities. A
 * privileged system account (CEO or E-SET SITE_MANAGER) is NOT
 * automatically a CRO: it holds no Team or Position at all, so it holds
 * none of the CRO capabilities, and the backend refuses its CRO actions
 * exactly as it would anyone else's.
 *
 * Opening a permit from here shows the complete Permit, its JSA, the
 * applicant identity, the status, the history, and only the actions the
 * backend says are currently available.
 */
export function CroQueuePage() {
  return (
    <ReviewQueue
      eyebrow="Review"
      title="CRO review queue"
      description="Permits submitted by applicants and awaiting Control Room Operator authorization."
      status="PENDING_CRO"
      emptyMessage="No permits are waiting for CRO review."
    />
  );
}
