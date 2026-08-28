import type { QueryFn } from '../../db/pool.js';
import { createNotification, notifyRecipients } from '../notifications/service.js';
import { resolveCroRecipients, resolveHseRecipients } from '../notifications/recipients.js';
import { buildWhatsappPayload, enqueueWhatsappMessage } from '../notifications/whatsappOutbox.js';
import {
  buildIssuedPermitSnapshot,
  createIssuedDocumentSnapshot,
  getIssuedSnapshotForPermit,
  type IssuanceEventMetadata,
} from './documents.js';
import { toDisplayNumber, toPermitLabel } from './numbering.js';
import type { JsaRow, PermitRow } from './service.js';
import { buildSnapshotSignatureSet, getPermitSignatures, type SnapshotSignatureSet } from './signatures.js';

/**
 * Every function below is called from INSIDE the same open transaction
 * as the permit-transition it corresponds to (see the call sites in
 * `service.ts`), immediately after that transition's own
 * `permit_lifecycle_events` row is inserted - `sourceEventId` is always
 * that row's own `id`. This is what "notification/outbox/snapshot
 * creation occurs atomically with the DB workflow transition" actually
 * means here: if the transaction later fails for any reason, everything
 * these functions wrote rolls back together with the permit's own status
 * change - a successful transition can never "lose" its notifications.
 *
 * Kept as one function per lifecycle event (not a single generic
 * dispatcher) to match this file's neighbors in `service.ts`, where
 * every transition is its own explicit function rather than a shared,
 * parameterized one.
 */

function permitNumberOf(permit: PermitRow): string {
  return toDisplayNumber(BigInt(permit.permit_sequence));
}

/**
 * How a permit is NAMED in prose - "Cold Work Permit 1".
 *
 * Each permit type has been numbered in its own series since migration
 * 0033, so "Permit 1" alone names four different permits and a person
 * reading a notification cannot tell which one moved. The type goes
 * beside the number here, in the human-readable text only: the
 * authoritative Permit No. carried by the record, the PDF, the issued
 * snapshot and the WhatsApp payload below is still the bare stored
 * number, unprefixed.
 */
function permitLabelOf(permit: PermitRow): string {
  return toPermitLabel(permit.permit_type, BigInt(permit.permit_sequence));
}

function jsaNumberOf(jsa: JsaRow): string {
  return toDisplayNumber(BigInt(jsa.jsa_sequence));
}

export class ResponsibilityRecipientUnavailableError extends Error {
  constructor(public readonly responsibility: 'CRO' | 'HSE') {
    super(`No eligible ${responsibility} recipient is configured`);
    this.name = 'ResponsibilityRecipientUnavailableError';
  }
}

/** Applicant submits (DRAFT -> PENDING_CRO) or resubmits (PENDING_CORRECTION -> PENDING_CRO) - notify every current CRO recipient. */
export async function onPermitSubmittedOrResubmitted(
  queryFn: QueryFn,
  input: { permit: PermitRow; sourceEventId: string; resubmitted: boolean },
): Promise<void> {
  const recipients = await resolveCroRecipients(queryFn);
  if (recipients.length === 0) throw new ResponsibilityRecipientUnavailableError('CRO');
  const permitLabel = permitLabelOf(input.permit);
  await notifyRecipients(queryFn, recipients, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: input.resubmitted ? 'PERMIT_RESUBMITTED' : 'PERMIT_SUBMITTED',
    title: `${permitLabel} ${input.resubmitted ? 'resubmitted' : 'submitted'} for CRO review`,
    message: `${permitLabel} is awaiting CRO review.`,
  });
}

/** CRO forwards to HSE (PENDING_CRO -> PENDING_HSE) - notify every current HSE recipient. */
export async function onForwardedToHse(
  queryFn: QueryFn,
  input: { permit: PermitRow; sourceEventId: string },
): Promise<void> {
  const recipients = await resolveHseRecipients(queryFn);
  if (recipients.length === 0) throw new ResponsibilityRecipientUnavailableError('HSE');
  const permitLabel = permitLabelOf(input.permit);
  await notifyRecipients(queryFn, recipients, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_FORWARDED_HSE',
    title: `${permitLabel} forwarded for HSE review`,
    message: `${permitLabel} was forwarded by CRO and is awaiting HSE review.`,
  });
}

/** HSE sends back to CRO (PENDING_HSE -> PENDING_CRO) - notify every current CRO recipient. */
export async function onHseSentBackToCro(
  queryFn: QueryFn,
  input: { permit: PermitRow; sourceEventId: string },
): Promise<void> {
  const recipients = await resolveCroRecipients(queryFn);
  if (recipients.length === 0) throw new ResponsibilityRecipientUnavailableError('CRO');
  const permitLabel = permitLabelOf(input.permit);
  await notifyRecipients(queryFn, recipients, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_HSE_SENT_BACK',
    title: `${permitLabel} sent back by HSE`,
    message: `${permitLabel} was sent back by HSE and requires further CRO review.`,
  });
}

/** CRO sends back to the applicant (PENDING_CRO -> PENDING_CORRECTION) - notify only the original applicant. */
export async function onCroSentBackToApplicant(
  queryFn: QueryFn,
  input: { permit: PermitRow; sourceEventId: string },
): Promise<void> {
  const permitLabel = permitLabelOf(input.permit);
  await createNotification(queryFn, {
    recipientUserId: input.permit.created_by,
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_SENT_BACK_FOR_CORRECTION',
    title: `${permitLabel} sent back for correction`,
    message: `${permitLabel} was sent back by CRO and needs correction before it can be resubmitted.`,
  });
}

/**
 * Issuance (PENDING_HSE -> ISSUED, via either HSE approval or CRO
 * fallback approval) - notifies the applicant AND every current CRO
 * recipient ("Issued -> notify applicant AND appropriate CRO users"),
 * captures the immutable issued-document snapshot, and enqueues the
 * ISSUED WhatsApp outbox message. All three happen in this one function
 * so a caller (service.ts) can't accidentally do one without the
 * others.
 */
export async function onPermitIssued(
  queryFn: QueryFn,
  input: { permit: PermitRow; jsa: JsaRow; issuanceEvent: IssuanceEventMetadata },
): Promise<void> {
  const sourceEventId = input.issuanceEvent.id;
  const permitNumber = permitNumberOf(input.permit);
  const permitLabel = permitLabelOf(input.permit);
  const jsaNumber = jsaNumberOf(input.jsa);

  const croRecipients = await resolveCroRecipients(queryFn);
  await notifyRecipients(queryFn, [input.permit.created_by, ...croRecipients], {
    permitId: input.permit.id,
    sourceEventId,
    notificationType: 'PERMIT_ISSUED',
    title: `${permitLabel} issued`,
    message: `${permitLabel} (JSA ${jsaNumber}) has been issued.`,
  });

  // The signatures already recorded against this permit - the applicant's
  // submission, CRO's authorization, and either HSE's approval or CRO's
  // fallback approval, each frozen when it was actually performed. They
  // are read back here rather than re-resolved from anyone's profile.
  const signatures = buildSnapshotSignatureSet(await getPermitSignatures(queryFn, input.permit.id));
  const snapshot = buildIssuedPermitSnapshot(input.permit, input.jsa, null, input.issuanceEvent, signatures);
  await createIssuedDocumentSnapshot(queryFn, {
    permitId: input.permit.id,
    sourceEventId,
    snapshot,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.permit.id,
    sourceEventId,
    eventType: 'ISSUED',
    payload: buildWhatsappPayload('ISSUED', {
      permitNumber,
      jsaNumber,
      status: 'ISSUED',
      occurredAt: input.issuanceEvent.occurred_at,
    }),
  });
}

/** CRO Hold (ISSUED -> HELD) - notify the applicant; WhatsApp message MUST include the hold reason. */
export async function onPermitHeld(
  queryFn: QueryFn,
  input: { permit: PermitRow; jsa: JsaRow; sourceEventId: string; holdReason: string },
): Promise<void> {
  const permitNumber = permitNumberOf(input.permit);
  const permitLabel = permitLabelOf(input.permit);
  const jsaNumber = jsaNumberOf(input.jsa);

  await createNotification(queryFn, {
    recipientUserId: input.permit.created_by,
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_HELD',
    title: `${permitLabel} placed on hold`,
    message: `${permitLabel} (JSA ${jsaNumber}) was placed on hold: ${input.holdReason}`,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    eventType: 'HELD',
    payload: buildWhatsappPayload('HELD', {
      permitNumber,
      jsaNumber,
      status: 'HELD',
      occurredAt: input.permit.held_at as string,
      holdReason: input.holdReason,
    }),
  });
}

/** CRO Resume (HELD -> ISSUED) - notify the applicant. */
export async function onPermitResumed(
  queryFn: QueryFn,
  input: { permit: PermitRow; jsa: JsaRow; sourceEventId: string },
): Promise<void> {
  const permitNumber = permitNumberOf(input.permit);
  const permitLabel = permitLabelOf(input.permit);
  const jsaNumber = jsaNumberOf(input.jsa);

  await createNotification(queryFn, {
    recipientUserId: input.permit.created_by,
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_RESUMED',
    title: `${permitLabel} resumed`,
    message: `${permitLabel} (JSA ${jsaNumber}) has been resumed and is valid again.`,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    eventType: 'RESUMED',
    payload: buildWhatsappPayload('RESUMED', {
      permitNumber,
      jsaNumber,
      status: 'ISSUED',
      occurredAt: input.permit.updated_at,
    }),
  });
}

/** CRO Cancel (ISSUED/HELD -> CANCELLED) - notify the applicant. */
export async function onPermitCancelled(
  queryFn: QueryFn,
  input: { permit: PermitRow; jsa: JsaRow; sourceEventId: string },
): Promise<void> {
  const permitNumber = permitNumberOf(input.permit);
  const permitLabel = permitLabelOf(input.permit);
  const jsaNumber = jsaNumberOf(input.jsa);

  await createNotification(queryFn, {
    recipientUserId: input.permit.created_by,
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_CANCELLED',
    title: `${permitLabel} cancelled`,
    message: `${permitLabel} (JSA ${jsaNumber}) has been cancelled.`,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    eventType: 'CANCELLED',
    payload: buildWhatsappPayload('CANCELLED', {
      permitNumber,
      jsaNumber,
      status: 'CANCELLED',
      occurredAt: input.permit.cancelled_at as string,
    }),
  });
}

/** CRO Close (ISSUED/HELD -> CLOSED) - notify the applicant. */
export async function onPermitClosed(
  queryFn: QueryFn,
  input: { permit: PermitRow; jsa: JsaRow; sourceEventId: string },
): Promise<void> {
  const permitNumber = permitNumberOf(input.permit);
  const permitLabel = permitLabelOf(input.permit);
  const jsaNumber = jsaNumberOf(input.jsa);

  await createNotification(queryFn, {
    recipientUserId: input.permit.created_by,
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    notificationType: 'PERMIT_CLOSED',
    title: `${permitLabel} closed`,
    message: `${permitLabel} (JSA ${jsaNumber}) has been closed.`,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.permit.id,
    sourceEventId: input.sourceEventId,
    eventType: 'CLOSED',
    payload: buildWhatsappPayload('CLOSED', {
      permitNumber,
      jsaNumber,
      status: 'CLOSED',
      occurredAt: input.permit.closed_at as string,
    }),
  });
}

/**
 * The signature block a renewed permit inherits from the permit it
 * renews. Fails closed if that permit somehow has no issued snapshot:
 * every CLOSED permit was issued, and every issued permit is snapshotted
 * atomically with its issuance, so a missing one means the renewal
 * cannot honestly reproduce who authorized the work - which is refused
 * rather than papered over with an empty signature block.
 */
async function inheritedRenewalSignatures(
  queryFn: QueryFn,
  oldPermitId: string,
): Promise<SnapshotSignatureSet> {
  const previous = await getIssuedSnapshotForPermit(queryFn, oldPermitId);
  if (!previous) {
    throw new Error(`Cannot renew permit ${oldPermitId}: it has no immutable issued snapshot to inherit signatures from`);
  }
  return {
    applicant: previous.snapshot.signatures.applicant,
    cro: previous.snapshot.signatures.cro,
    hse: previous.snapshot.signatures.hse,
    croFallback: previous.snapshot.signatures.croFallback,
    // The previous permit's own renewal signature is not carried forward:
    // this permit's renewal signature is the one recorded for THIS
    // renewal action.
    renewal: null,
  };
}

/**
 * Renewal (creates a brand-new ISSUED permit linked to the old, CLOSED
 * one) - notifies the applicant, identifying the NEW Permit Number
 * ("Renewed -> notify applicant and identify the NEW Permit Number"),
 * captures the new permit's own immutable issued-document snapshot (same
 * JSA, new Permit Number), and enqueues the RENEWED WhatsApp outbox
 * message carrying both the previous and new Permit Number. Recorded on
 * the NEW permit's own notification/outbox/snapshot rows - the OLD
 * permit is never written to by renewal at all (see
 * `renewPermit` in service.ts).
 */
export async function onPermitRenewed(
  queryFn: QueryFn,
  input: { newPermit: PermitRow; oldPermit: PermitRow; jsa: JsaRow; issuanceEvent: IssuanceEventMetadata },
): Promise<void> {
  const sourceEventId = input.issuanceEvent.id;
  const newPermitNumber = permitNumberOf(input.newPermit);
  const oldPermitNumber = permitNumberOf(input.oldPermit);
  const jsaNumber = jsaNumberOf(input.jsa);

  await createNotification(queryFn, {
    recipientUserId: input.newPermit.created_by,
    permitId: input.newPermit.id,
    sourceEventId,
    notificationType: 'PERMIT_RENEWED',
    title: `Permit ${oldPermitNumber} renewed as ${newPermitNumber}`,
    message: `Permit ${oldPermitNumber} (JSA ${jsaNumber}) was renewed. The new Permit Number is ${newPermitNumber}.`,
  });

  // A renewal has no CRO/HSE review of its own, so the applicant/CRO/HSE
  // signatures on the renewed document are exactly the ones already
  // frozen on the permit being renewed - copied from that permit's
  // immutable snapshot, never re-resolved from a live profile and never
  // fabricated. The renewing CRO's own signature is added on top.
  const inherited = await inheritedRenewalSignatures(queryFn, input.oldPermit.id);
  const signatures = buildSnapshotSignatureSet(
    await getPermitSignatures(queryFn, input.newPermit.id),
    inherited,
  );
  const snapshot = buildIssuedPermitSnapshot(
    input.newPermit,
    input.jsa,
    input.oldPermit,
    input.issuanceEvent,
    signatures,
  );
  await createIssuedDocumentSnapshot(queryFn, {
    permitId: input.newPermit.id,
    sourceEventId,
    snapshot,
  });

  await enqueueWhatsappMessage(queryFn, {
    permitId: input.newPermit.id,
    sourceEventId,
    eventType: 'RENEWED',
    payload: buildWhatsappPayload('RENEWED', {
      permitNumber: newPermitNumber,
      jsaNumber,
      status: 'ISSUED',
      occurredAt: input.issuanceEvent.occurred_at,
      previousPermitNumber: oldPermitNumber,
      newPermitNumber,
    }),
  });
}
