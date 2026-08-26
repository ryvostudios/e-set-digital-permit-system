import { resolveUserIdsWithCapabilities } from '../../authz/capabilities.js';
import type { QueryFn } from '../../db/pool.js';

/**
 * The capabilities that identify "a CRO, for notification-recipient
 * purposes" - deliberately broader than
 * `domain/permits/access.ts::STATUS_VIEW_CAPABILITIES`'s per-status view
 * list (a different concern: who may currently SEE a permit in one
 * specific status) and kept as its own list here so the two can't
 * silently drift into meaning the same thing. Anyone holding at least
 * one of these is a CRO recipient for every CRO-facing notification
 * event (submission, resubmission, HSE send-back) - matching WORKFLOW.md's
 * "four CRO personnel, only one on duty" (there is no single "you are
 * THE on-duty CRO" flag; every currently-CRO-capable user is notified,
 * and the actually on-duty one is the one who acts).
 */
export const CRO_RECIPIENT_CAPABILITIES = [
  'permit.cro_review',
  'permit.forward_hse',
  'permit.send_back',
  'permit.hold',
  'permit.cancel',
  'permit.close',
] as const;

/** The HSE-equivalent of `CRO_RECIPIENT_CAPABILITIES` above. */
export const HSE_RECIPIENT_CAPABILITIES = ['permit.hse_review', 'permit.fallback_approve'] as const;

/**
 * Every user who should be notified as "the CRO" for a given event -
 * resolved entirely server-side from the authoritative Team + Position
 * -> Capabilities model (never client-influenceable). `queryFn` is
 * accepted explicitly (rather than defaulting to the pooled `query`) so
 * this can be called with an open transaction's own `client.query`
 * (see domain/permits/workflowSideEffects.ts) - notification-recipient
 * resolution reads the SAME in-flight transaction as the notification
 * rows it feeds, not a separate connection.
 */
export function resolveCroRecipients(queryFn: QueryFn): Promise<string[]> {
  return resolveUserIdsWithCapabilities(CRO_RECIPIENT_CAPABILITIES, queryFn);
}

/** The HSE-equivalent of `resolveCroRecipients` above. */
export function resolveHseRecipients(queryFn: QueryFn): Promise<string[]> {
  return resolveUserIdsWithCapabilities(HSE_RECIPIENT_CAPABILITIES, queryFn);
}
