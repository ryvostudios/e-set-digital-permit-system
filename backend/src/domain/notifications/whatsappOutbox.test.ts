import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import {
  buildWhatsappPayload,
  disabledWhatsappProvider,
  enqueueWhatsappMessage,
  processPendingWhatsappOutbox,
  type WhatsappOutboxRow,
  type WhatsappProvider,
  type WhatsappSendResult,
} from './whatsappOutbox.js';

class FakeOutboxDb {
  rows: WhatsappOutboxRow[] = [];
  private counter = 0;

  query: QueryFn = (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('INSERT INTO whatsapp_outbox_messages')) {
      const [permitId, sourceEventId, eventType, payload] = params as [string, string, WhatsappOutboxRow['event_type'], string];
      if (this.rows.some((r) => r.source_event_id === sourceEventId)) return { rows: [] };
      this.counter += 1;
      const row: WhatsappOutboxRow = {
        id: `outbox-${this.counter}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        event_type: eventType,
        payload,
        status: 'PENDING',
        attempt_count: 0,
        claim_token: null,
        claimed_at: null,
        next_attempt_at: '2026-01-01T00:00:00.000Z',
        last_error: null,
        last_attempted_at: null,
        sent_at: null,
        created_at: new Date(2026, 0, 1, 0, 0, this.counter).toISOString(),
      };
      this.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('WITH claimable AS')) {
      const [limit, claimToken] = params as [number, string];
      const rows = this.rows
        .filter((r) => r.status === 'PENDING' || r.status === 'FAILED' || (r.status === 'PROCESSING' && r.claimed_at === 'stale'))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((row) => {
          row.status = 'PROCESSING';
          row.claim_token = claimToken;
          row.claimed_at = 'now';
          row.attempt_count += 1;
          return row;
        });
      return { rows };
    }
    if (sql.startsWith('UPDATE whatsapp_outbox_messages') && sql.includes("status = 'SENT'")) {
      const [id, claimToken] = params as [string, string];
      const index = this.rows.findIndex((r) => r.id === id);
      if (index !== -1 && this.rows[index]!.claim_token === claimToken) {
        this.rows[index] = { ...this.rows[index]!, status: 'SENT', sent_at: 'now', claim_token: null, claimed_at: null };
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE whatsapp_outbox_messages') && sql.includes("status = 'FAILED'")) {
      const [id, claimToken, lastError] = params as [string, string, string];
      const index = this.rows.findIndex((r) => r.id === id);
      if (index !== -1 && this.rows[index]!.claim_token === claimToken) {
        this.rows[index] = {
          ...this.rows[index]!,
          status: 'FAILED',
          claim_token: null,
          claimed_at: null,
          last_error: lastError,
        };
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }

    throw new Error(`FakeOutboxDb: unhandled query: ${sql}`);
  }) as QueryFn;
}

test('buildWhatsappPayload: HELD includes the mandatory hold reason', () => {
  const payload = buildWhatsappPayload('HELD', {
    permitNumber: '1045',
    jsaNumber: '234',
    status: 'HELD',
    occurredAt: '2026-01-01T00:00:00.000Z',
    holdReason: 'unsafe wind conditions',
  });
  assert.equal(payload.holdReason, 'unsafe wind conditions');
});

test('buildWhatsappPayload: non-HELD events never carry a hold reason field', () => {
  const payload = buildWhatsappPayload('ISSUED', {
    permitNumber: '1045',
    jsaNumber: '234',
    status: 'ISSUED',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(payload.holdReason, undefined);
});

test('buildWhatsappPayload: RENEWED carries both the previous and new Permit Number', () => {
  const payload = buildWhatsappPayload('RENEWED', {
    permitNumber: '1046',
    jsaNumber: '234',
    status: 'ISSUED',
    occurredAt: '2026-01-02T00:00:00.000Z',
    previousPermitNumber: '1045',
    newPermitNumber: '1046',
  });
  assert.equal(payload.previousPermitNumber, '1045');
  assert.equal(payload.newPermitNumber, '1046');
});

test('enqueueWhatsappMessage is idempotent per source_event_id - a retried/racing transition never creates two outbox messages for the same event', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', {
    permitNumber: '1045',
    jsaNumber: '234',
    status: 'ISSUED',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  assert.equal(db.rows.length, 1);
});

test('disabledWhatsappProvider never reports success - it is the safe default when no provider is configured', async () => {
  const result = await disabledWhatsappProvider.send(
    buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' }),
    { idempotencyKey: 'event-1' },
  );
  assert.equal(result.ok, false);
});

test('processPendingWhatsappOutbox: with the disabled provider, every message ends up FAILED (never falsely marked SENT)', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });

  const result = await processPendingWhatsappOutbox({ query: db.query }, disabledWhatsappProvider);
  assert.equal(result.processed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(db.rows[0]?.status, 'FAILED');
  assert.ok(db.rows[0]?.last_error);
});

test('processPendingWhatsappOutbox: a working provider marks the message SENT and records sent_at', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });

  const workingProvider: WhatsappProvider = { async send(): Promise<WhatsappSendResult> { return { ok: true }; } };
  const result = await processPendingWhatsappOutbox({ query: db.query }, workingProvider);
  assert.equal(result.sent, 1);
  assert.equal(db.rows[0]?.status, 'SENT');
});

test('processPendingWhatsappOutbox: retries a previously FAILED message', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  await processPendingWhatsappOutbox({ query: db.query }, disabledWhatsappProvider);
  assert.equal(db.rows[0]?.status, 'FAILED');
  assert.equal(db.rows[0]?.attempt_count, 1);

  const workingProvider: WhatsappProvider = { async send(): Promise<WhatsappSendResult> { return { ok: true }; } };
  await processPendingWhatsappOutbox({ query: db.query }, workingProvider);
  assert.equal(db.rows[0]?.status, 'SENT');
  assert.equal(db.rows[0]?.attempt_count, 2);
});

test('concurrent WhatsApp workers cannot send the same active claim twice and receive the lifecycle idempotency key', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const keys: string[] = [];
  const provider: WhatsappProvider = { async send(_payload, context) { keys.push(context.idempotencyKey); await gate; return { ok: true }; } };
  const first = processPendingWhatsappOutbox({ query: db.query }, provider);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await processPendingWhatsappOutbox({ query: db.query }, provider);
  release();
  await first;
  assert.deepEqual(keys, ['event-1']);
  assert.equal(second.processed, 0);
});

test('stale WhatsApp claims are recoverable and an obsolete claimant cannot finalize a newer claim', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  db.rows[0]!.status = 'PROCESSING';
  db.rows[0]!.claim_token = 'obsolete';
  db.rows[0]!.claimed_at = 'stale';
  const provider: WhatsappProvider = { async send() { return { ok: true }; } };
  await processPendingWhatsappOutbox({ query: db.query }, provider);
  assert.equal(db.rows[0]?.status, 'SENT');
  const staleFinalize = await db.query("UPDATE whatsapp_outbox_messages SET status = 'SENT' WHERE id = $1 AND claim_token = $2 RETURNING id", ['outbox-1', 'obsolete']);
  assert.equal(staleFinalize.rows.length, 0);
});

test('provider exceptions persist only a fixed safe category and never raw secret-bearing text', async () => {
  const db = new FakeOutboxDb();
  const payload = buildWhatsappPayload('ISSUED', { permitNumber: '1', jsaNumber: '1', status: 'ISSUED', occurredAt: '2026-01-01T00:00:00.000Z' });
  await enqueueWhatsappMessage(db.query, { permitId: 'permit-1', sourceEventId: 'event-1', eventType: 'ISSUED', payload });
  const hostile = 'https://secret.example/?token=SUPER_SECRET_TOKEN Authorization: Bearer abc123 sb_secret_FAKE_SECRET';
  await processPendingWhatsappOutbox({ query: db.query }, { async send() { throw new Error(hostile); } });
  assert.equal(db.rows[0]?.last_error, 'WHATSAPP_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(db.rows), /SUPER_SECRET_TOKEN|abc123|sb_secret_FAKE_SECRET/);
});
