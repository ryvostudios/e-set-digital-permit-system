import { query, type QueryFn } from '../../db/pool.js';
import { randomUUID } from 'node:crypto';

/** The six lifecycle events the business rule requires a company WhatsApp group message for - see this batch's WhatsApp outbox requirement and WORKFLOW.md's "Notifications (Future)" section. */
export type WhatsappEventType = 'ISSUED' | 'HELD' | 'RESUMED' | 'CANCELLED' | 'RENEWED' | 'CLOSED';

/**
 * The server-generated message content - never client-influenced, never
 * carrying a secret/credential (SECURITY.md). Every field is plain,
 * already-public-within-the-org business data (permit/JSA numbers,
 * status, hold reason, renewal lineage) - nothing here could enable log
 * or header injection when rendered as plain WhatsApp message text
 * (no control characters are ever included; every source field is
 * either a server-derived number or free text that already passed this
 * codebase's `.trim().max(2000)` validation on the way in - see
 * validation.ts).
 */
export interface WhatsappOutboxPayload {
  eventType: WhatsappEventType;
  permitNumber: string;
  jsaNumber: string;
  status: string;
  occurredAt: string;
  /** ISSUED/HELD/RESUMED/CANCELLED/CLOSED/RENEWED - mandatory in the message whenever the permit is (or was, at HELD time) actually held. */
  holdReason?: string;
  /** RENEWED only - the OLD Permit Number being superseded. */
  previousPermitNumber?: string;
  /** RENEWED only - "identify the NEW Permit Number", the whole point of a renewal notification. */
  newPermitNumber?: string;
}

export interface WhatsappOutboxRow {
  id: string;
  permit_id: string;
  source_event_id: string;
  event_type: WhatsappEventType;
  payload: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
  last_attempted_at: string | null;
  sent_at: string | null;
  created_at: string;
}

/**
 * Builds the payload for one qualifying lifecycle event. A thin,
 * pure function deliberately kept separate from the DB insert
 * (`enqueueWhatsappMessage` below) so its content can be unit tested
 * without a database at all.
 */
export function buildWhatsappPayload(
  eventType: WhatsappEventType,
  params: {
    permitNumber: string;
    jsaNumber: string;
    status: string;
    occurredAt: string;
    holdReason?: string | null;
    previousPermitNumber?: string | null;
    newPermitNumber?: string | null;
  },
): WhatsappOutboxPayload {
  const payload: WhatsappOutboxPayload = {
    eventType,
    permitNumber: params.permitNumber,
    jsaNumber: params.jsaNumber,
    status: params.status,
    occurredAt: params.occurredAt,
  };
  if (params.holdReason) payload.holdReason = params.holdReason;
  if (params.previousPermitNumber) payload.previousPermitNumber = params.previousPermitNumber;
  if (params.newPermitNumber) payload.newPermitNumber = params.newPermitNumber;
  return payload;
}

/**
 * Durably enqueues one outbox message, atomically with the caller's
 * already-open permit-transition transaction (see
 * domain/permits/workflowSideEffects.ts) - the permit transition itself
 * never depends on WhatsApp, or any provider, being reachable; this only
 * ever writes a local Postgres row. Idempotent via
 * `whatsapp_outbox_source_event_unique` (migration 0013):
 * `ON CONFLICT (source_event_id) DO NOTHING` guarantees exactly one
 * outbox message per qualifying lifecycle event even under a
 * retried/racing transition.
 */
export async function enqueueWhatsappMessage(
  queryFn: QueryFn,
  input: { permitId: string; sourceEventId: string; eventType: WhatsappEventType; payload: WhatsappOutboxPayload },
): Promise<void> {
  await queryFn(
    `INSERT INTO whatsapp_outbox_messages (permit_id, source_event_id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [input.permitId, input.sourceEventId, input.eventType, JSON.stringify(input.payload)],
  );
}

export type WhatsappFailureCode =
  | 'WHATSAPP_PROVIDER_NOT_CONFIGURED'
  | 'WHATSAPP_PROVIDER_TIMEOUT'
  | 'WHATSAPP_PROVIDER_REJECTED'
  | 'WHATSAPP_PROVIDER_UNAVAILABLE'
  | 'WHATSAPP_DELIVERY_FAILED';
export type WhatsappSendResult = { ok: true } | { ok: false; code: WhatsappFailureCode; retryable: boolean };

/**
 * The provider/adapter boundary. No real implementation is wired up in
 * this batch - the actual WhatsApp group delivery mechanism/provider is
 * an explicitly unresolved business decision (DECISIONS.md) - so only
 * the interface exists; `disabledWhatsappProvider` below is the only
 * implementation shipped, and it never fakes success.
 */
export interface WhatsappProvider {
  deliveryGuarantee: 'DISABLED' | 'PROVIDER_IDEMPOTENCY' | 'PROVIDER_RECONCILIATION';
  requestTimeoutMs: number;
  send(payload: WhatsappOutboxPayload, context: { idempotencyKey: string }): Promise<WhatsappSendResult>;
}

/**
 * The safe default: always reports failure, with a message that
 * explains WHY rather than looking like a real delivery error - "do not
 * fake success; leave provider delivery disabled/pending and report this
 * as the one manual integration requirement" (this batch's WhatsApp
 * requirement). Never invents/hard-codes an unofficial WhatsApp API call
 * of any kind.
 */
export const disabledWhatsappProvider: WhatsappProvider = {
  deliveryGuarantee: 'DISABLED',
  requestTimeoutMs: 30_000,
  async send(): Promise<WhatsappSendResult> {
    return {
      ok: false,
      code: 'WHATSAPP_PROVIDER_NOT_CONFIGURED',
      retryable: true,
    };
  },
};

export const OUTBOX_LEASE_SECONDS = 300;

export function assertWhatsappProviderSafe(provider: WhatsappProvider): void {
  if (provider.deliveryGuarantee === 'DISABLED') return;
  if (!['PROVIDER_IDEMPOTENCY', 'PROVIDER_RECONCILIATION'].includes(provider.deliveryGuarantee)) {
    throw new Error('WhatsApp provider lacks a durable delivery guarantee');
  }
  if (!Number.isSafeInteger(provider.requestTimeoutMs) || provider.requestTimeoutMs < 1 || provider.requestTimeoutMs >= OUTBOX_LEASE_SECONDS * 1000) {
    throw new Error('WhatsApp provider timeout must be positive and shorter than the worker lease');
  }
}

export interface ProcessOutboxDeps {
  query: QueryFn;
}

export interface ProcessOutboxResult {
  processed: number;
  sent: number;
  failed: number;
}

/**
 * Sends up to `batchSize` PENDING (or previously FAILED, so a transient
 * failure is retried, not abandoned) outbox messages via `provider`,
 * oldest first. Not invoked automatically anywhere in this backend - no
 * cron/scheduler exists in this codebase (ARCHITECTURE.md's "no
 * infrastructure without an actual current requirement") - this is
 * meant to be run by an operator-scheduled process
 * (`npm run outbox:whatsapp:process`, see package.json) once a real
 * provider is configured. Each message is attempted independently: one
 * message's failure never blocks the rest of the batch.
 */
export async function processPendingWhatsappOutbox(
  deps: ProcessOutboxDeps = { query },
  provider: WhatsappProvider = disabledWhatsappProvider,
  batchSize = 25,
): Promise<ProcessOutboxResult> {
  assertWhatsappProviderSafe(provider);
  const claimToken = randomUUID();
  const pending = await deps.query<WhatsappOutboxRow>(
    `WITH claimable AS (
       SELECT id
         FROM whatsapp_outbox_messages
        WHERE (
          (status IN ('PENDING', 'FAILED') AND next_attempt_at <= now())
          OR (status = 'PROCESSING' AND claimed_at < now() - ($3 * INTERVAL '1 second'))
        )
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE whatsapp_outbox_messages m
        SET status = 'PROCESSING', claim_token = $2, claimed_at = now(),
            attempt_count = attempt_count + 1, last_attempted_at = now()
       FROM claimable
      WHERE m.id = claimable.id
      RETURNING m.*`,
    [batchSize, claimToken, OUTBOX_LEASE_SECONDS],
  );

  let sent = 0;
  let failed = 0;
  for (const row of pending.rows) {
    let result: WhatsappSendResult;
    try {
      const payload = JSON.parse(row.payload) as WhatsappOutboxPayload;
      result = await provider.send(payload, { idempotencyKey: row.source_event_id });
    } catch {
      result = { ok: false, code: 'WHATSAPP_DELIVERY_FAILED', retryable: true };
    }

    if (result.ok) {
      const finalized = await deps.query<{ id: string }>(
        `UPDATE whatsapp_outbox_messages
            SET status = 'SENT', sent_at = now(), claim_token = NULL, claimed_at = NULL,
                last_error = NULL
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2
          RETURNING id`,
        [row.id, claimToken],
      );
      if (finalized.rows.length > 0) sent += 1;
    } else {
      const finalized = await deps.query<{ id: string }>(
        `UPDATE whatsapp_outbox_messages
            SET status = 'FAILED', claim_token = NULL, claimed_at = NULL, last_error = $3,
                next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) * INTERVAL '1 second')
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2
          RETURNING id`,
        [row.id, claimToken, result.code],
      );
      if (finalized.rows.length > 0) failed += 1;
    }
  }

  return { processed: pending.rows.length, sent, failed };
}
