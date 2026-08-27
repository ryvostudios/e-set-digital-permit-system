import { ReviewQueue } from './ReviewQueue';

/**
 * The HSE review queue.
 *
 * HSE approval authority belongs to exactly two Team + Position
 * combinations - E-SET / HSE / Team Lead and E-SET / HSE / Paramedic -
 * and comes solely from the `permit.hse_review` capability those
 * combinations carry.
 *
 * ZPL's "HSE" POSITION IS NOT AN HSE APPROVER. It is a different
 * company's job title and carries no permit approval capability at all,
 * so it never reaches this queue and the backend refuses its approval
 * attempts. The two are unrelated objects that happen to share a word.
 *
 * The review window and any CRO fallback after it are enforced entirely
 * by the backend's own clock. Nothing here times anything.
 */
export function HseQueuePage() {
  return (
    <ReviewQueue
      eyebrow="Review"
      title="HSE review queue"
      description="Permits authorized by CRO and awaiting HSE approval."
      status="PENDING_HSE"
      emptyMessage="No permits are waiting for HSE review."
    />
  );
}
