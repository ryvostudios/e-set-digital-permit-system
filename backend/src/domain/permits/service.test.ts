import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closePermit,
  createDraftPermit,
  croFallbackApprove,
  forwardToHseReview,
  getJsaById,
  getOwnPermit,
  getPermitById,
  getPermitLifecycleEvents,
  getPermitWithJsa,
  hseApprove,
  listOwnPermits,
  listPermitsByStatus,
  PERMIT_CLOSED_EVENT_TYPE,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type PermitRow,
  type PermitsServiceDeps,
} from './service.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const PRE_HSE_STATUSES = new Set(['DRAFT', 'PENDING_CRO']);
const HSE_WINDOW_STATUSES = new Set(['PENDING_HSE', 'ISSUED', 'CLOSED']);
const ISSUED_OR_LATER_STATUSES = new Set(['ISSUED', 'CLOSED']);

/**
 * Mirrors migration 0008/0010's permits CHECK constraints
 * (permits_hse_window_status_consistent, permits_hse_deadline_exact,
 * permits_issued_at_consistent, permits_closure_consistent), so a
 * service.ts bug that would violate them fails the same way it would
 * against the real database.
 */
function assertPermitInvariants(permit: PermitRow): void {
  const hasWindow = permit.hse_review_started_at !== null && permit.hse_review_deadline_at !== null;
  const noWindow = permit.hse_review_started_at === null && permit.hse_review_deadline_at === null;
  const windowStatusOk =
    (PRE_HSE_STATUSES.has(permit.status) && noWindow) || (HSE_WINDOW_STATUSES.has(permit.status) && hasWindow);
  if (!windowStatusOk) {
    throw new Error(
      `simulated CHECK constraint violation: permits_hse_window_status_consistent (status=${permit.status}, started=${permit.hse_review_started_at}, deadline=${permit.hse_review_deadline_at})`,
    );
  }
  if (permit.hse_review_started_at !== null && permit.hse_review_deadline_at !== null) {
    const started = new Date(permit.hse_review_started_at).getTime();
    const deadline = new Date(permit.hse_review_deadline_at).getTime();
    if (deadline !== started + FIVE_MINUTES_MS) {
      throw new Error(
        `simulated CHECK constraint violation: permits_hse_deadline_exact (started=${permit.hse_review_started_at}, deadline=${permit.hse_review_deadline_at})`,
      );
    }
  }
  if (ISSUED_OR_LATER_STATUSES.has(permit.status) !== (permit.issued_at !== null)) {
    throw new Error(
      `simulated CHECK constraint violation: permits_issued_at_consistent (status=${permit.status}, issued_at=${permit.issued_at})`,
    );
  }
  const closureOk =
    (permit.status === 'CLOSED' && permit.closed_by !== null && permit.closed_at !== null) ||
    (permit.status !== 'CLOSED' &&
      permit.closed_by === null &&
      permit.closed_at === null &&
      permit.closure_remarks === null);
  if (!closureOk) {
    throw new Error(
      `simulated CHECK constraint violation: permits_closure_consistent (status=${permit.status}, closed_by=${permit.closed_by}, closed_at=${permit.closed_at}, closure_remarks=${permit.closure_remarks})`,
    );
  }
}

/**
 * A minimal in-memory stand-in for Postgres that understands only the
 * exact query shapes `service.ts` issues, so these tests exercise the
 * service's transaction/locking/conflict logic without a live database.
 *
 * `now` stands in for the database's `now()` - tests advance it to
 * simulate time passing for the 5-minute HSE review window, instead of
 * relying on wall-clock time or any client-supplied value.
 */
interface FakeLifecycleEvent {
  permit_id: string;
  event_type: string;
  actor_user_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
}

class FakeDb {
  permits = new Map<string, PermitRow>();
  jsas = new Map<string, JsaRow>();
  // Only rows that actually "committed" - unlike `queries` below, which
  // logs every attempted query regardless of outcome, this is emptied
  // back out on a simulated rollback (see `withTransaction`), so it's
  // what a later read would actually see.
  lifecycleEvents: FakeLifecycleEvent[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  now = new Date();
  // Test-only failure injection: when set, the next matching INSERT INTO
  // permit_lifecycle_events throws instead of succeeding, simulating a
  // mid-transaction database failure so tests can verify rollback.
  failNextLifecycleEventInsert: { eventType: string } | null = null;
  private permitSeq = 0;
  private jsaSeq = 0;
  private permitCounter = 0;
  private jsaCounter = 0;

  /** Validates (as the real CHECK constraints would) before storing. */
  private setPermit(permit: PermitRow): PermitRow {
    assertPermitInvariants(permit);
    this.permits.set(permit.id, permit);
    return permit;
  }

  private rawQuery = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.trim();
    this.queries.push({ sql, params });

    if (sql.startsWith('INSERT INTO jsas')) {
      const [createdBy] = params as [string];
      this.jsaCounter += 1;
      this.jsaSeq += 1;
      const jsa: JsaRow = {
        id: `jsa-${this.jsaCounter}`,
        jsa_sequence: String(this.jsaSeq),
        created_by: createdBy,
        created_at: this.now.toISOString(),
      };
      this.jsas.set(jsa.id, jsa);
      return { rows: [jsa] };
    }
    if (sql.startsWith('INSERT INTO permits')) {
      const [jsaId, createdBy, siteTimezone] = params as [string, string, string];
      this.permitCounter += 1;
      this.permitSeq += 1;
      // Offsetting each permit's created_at by its insertion order (like
      // a real database's sub-millisecond timestamp precision would)
      // keeps pagination ordering deterministic in these tests without
      // every test having to manually advance `this.now` between
      // creates - mirrors why the real SQL also adds `id` as a tiebreaker
      // (see listOwnPermits/listPermitsByStatus in service.ts).
      const createdAt = new Date(this.now.getTime() + this.permitCounter).toISOString();
      const permit: PermitRow = {
        id: `permit-${this.permitCounter}`,
        permit_sequence: String(this.permitSeq),
        jsa_id: jsaId,
        status: 'DRAFT',
        version: 1,
        created_by: createdBy,
        previous_permit_id: null,
        site_timezone: siteTimezone,
        company: null,
        company_other: null,
        submitted_at: null,
        hse_review_started_at: null,
        hse_review_deadline_at: null,
        issued_at: null,
        closed_by: null,
        closed_at: null,
        closure_remarks: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      return { rows: [this.setPermit(permit)] };
    }
    if (sql.startsWith('INSERT INTO permit_lifecycle_events')) {
      const [permitId, eventType, actorUserId, fromStatus, toStatus, reason] = params as [
        string,
        string,
        string,
        string | null,
        string,
        string | null,
      ];
      if (this.failNextLifecycleEventInsert?.eventType === eventType) {
        this.failNextLifecycleEventInsert = null;
        throw new Error(`simulated database failure inserting ${eventType} lifecycle event`);
      }
      // Mirrors migration 0006/0008/0010's permit_lifecycle_events_event_status_consistent
      // CHECK constraint, so a violation here fails the same way it would
      // against the real database.
      const allowed =
        (eventType === 'CREATED' && fromStatus === null && toStatus === 'DRAFT') ||
        (eventType === 'SUBMITTED' && fromStatus === 'DRAFT' && toStatus === 'PENDING_CRO') ||
        (eventType === 'CRO_FORWARDED_HSE' && fromStatus === 'PENDING_CRO' && toStatus === 'PENDING_HSE') ||
        (eventType === 'HSE_APPROVED' && fromStatus === 'PENDING_HSE' && toStatus === 'ISSUED') ||
        (eventType === 'CRO_FALLBACK_APPROVED' && fromStatus === 'PENDING_HSE' && toStatus === 'ISSUED') ||
        (eventType === PERMIT_CLOSED_EVENT_TYPE && fromStatus === 'ISSUED' && toStatus === 'CLOSED');
      if (!allowed) {
        throw new Error(
          `simulated CHECK constraint violation: permit_lifecycle_events_event_status_consistent (event_type=${eventType}, from_status=${fromStatus}, to_status=${toStatus})`,
        );
      }
      this.lifecycleEvents.push({
        permit_id: permitId,
        event_type: eventType,
        actor_user_id: actorUserId,
        from_status: fromStatus,
        to_status: toStatus,
        reason: reason ?? null,
      });
      return { rows: [] };
    }
    if (sql.includes('fallback_eligible')) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const fallbackEligible = existing.hse_review_deadline_at
        ? this.now.getTime() >= new Date(existing.hse_review_deadline_at).getTime()
        : null;
      return { rows: [{ ...existing, fallback_eligible: fallbackEligible }] };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE id = $1 AND created_by = $2')) {
      const [id, createdBy] = params as [string, string];
      const permit = this.permits.get(id);
      return permit && permit.created_by === createdBy ? { rows: [permit] } : { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE id = $1 FOR UPDATE')) {
      const [id] = params as [string];
      const permit = this.permits.get(id);
      return permit ? { rows: [permit] } : { rows: [] };
    }
    if (sql === 'SELECT * FROM permits WHERE id = $1') {
      const [id] = params as [string];
      const permit = this.permits.get(id);
      return permit ? { rows: [permit] } : { rows: [] };
    }
    if (sql === 'SELECT * FROM jsas WHERE id = $1') {
      const [id] = params as [string];
      const jsa = this.jsas.get(id);
      return jsa ? { rows: [jsa] } : { rows: [] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes('SET company')) {
      const [company, companyOther, id] = params as [string | null, string | null, string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        company: company as PermitRow['company'],
        company_other: companyOther,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_CRO'")) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'PENDING_CRO',
        version: existing.version + 1,
        submitted_at: this.now.toISOString(),
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_HSE'")) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'PENDING_HSE',
        hse_review_started_at: this.now.toISOString(),
        hse_review_deadline_at: new Date(this.now.getTime() + FIVE_MINUTES_MS).toISOString(),
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'ISSUED'")) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'ISSUED',
        issued_at: this.now.toISOString(),
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'CLOSED'")) {
      const [id, closedBy, closureRemarks] = params as [string, string, string | null];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'CLOSED',
        closed_by: closedBy,
        closed_at: this.now.toISOString(),
        closure_remarks: closureRemarks,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('SELECT p.*')) {
      const [id] = params as [string];
      const permit = this.permits.get(id);
      if (!permit) return { rows: [] };
      const jsa = this.jsas.get(permit.jsa_id);
      if (!jsa) return { rows: [] };
      return {
        rows: [
          {
            ...permit,
            jsa_row_id: jsa.id,
            jsa_sequence: jsa.jsa_sequence,
            jsa_created_by: jsa.created_by,
            jsa_created_at: jsa.created_at,
          },
        ],
      };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE created_by = $1 ORDER BY')) {
      const [createdBy, limit, offset] = params as [string, number, number];
      const rows = [...this.permits.values()]
        .filter((p) => p.created_by === createdBy)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(offset, offset + limit);
      return { rows };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE created_by = $1')) {
      const [createdBy] = params as [string];
      const count = [...this.permits.values()].filter((p) => p.created_by === createdBy).length;
      return { rows: [{ count: String(count) }] };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE status = $1 ORDER BY')) {
      const [status, limit, offset] = params as [PermitRow['status'], number, number];
      const rows = [...this.permits.values()]
        .filter((p) => p.status === status)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .slice(offset, offset + limit);
      return { rows };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE status = $1')) {
      const [status] = params as [PermitRow['status']];
      const count = [...this.permits.values()].filter((p) => p.status === status).length;
      return { rows: [{ count: String(count) }] };
    }
    if (sql.startsWith('SELECT * FROM permit_lifecycle_events WHERE permit_id = $1')) {
      const [permitId] = params as [string];
      const rows = this.lifecycleEvents
        .filter((e) => e.permit_id === permitId)
        .map((e, index) => ({ id: `event-${permitId}-${index}`, ordinal: String(index + 1), occurred_at: this.now.toISOString(), ...e }));
      return { rows };
    }

    throw new Error(`FakeDb: unhandled query: ${sql}`);
  };

  // Simulates Postgres's `FOR UPDATE` row-locking: a real transaction
  // blocks a second transaction's `FOR UPDATE` on the same row until the
  // first commits, so the second sees the already-updated row instead of
  // racing it. A single lock (rather than per-row) is a coarser
  // simulation, but is behaviorally identical for two transactions
  // targeting the same permit, which is what the race test below needs.
  private txLock: Promise<unknown> = Promise.resolve();

  deps(): PermitsServiceDeps {
    const query = this.rawQuery as PermitsServiceDeps['query'];
    const withTransaction = (async <T>(fn: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
      const previous = this.txLock;
      let release = (): void => {};
      this.txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      // Minimal rollback simulation: snapshot both mutable stores before
      // running the transaction body, and restore them if it throws -
      // just enough to prove nothing a failed transaction wrote survives,
      // without building a general transaction log.
      const permitsSnapshot = new Map(this.permits);
      const lifecycleEventsSnapshot = [...this.lifecycleEvents];
      try {
        return await fn({ query });
      } catch (err) {
        this.permits = permitsSnapshot;
        this.lifecycleEvents = lifecycleEventsSnapshot;
        throw err;
      } finally {
        release();
      }
    }) as PermitsServiceDeps['withTransaction'];
    return { query, withTransaction };
  }

  /** Advances the fake DB's authoritative clock by `ms` milliseconds. */
  advanceTime(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

/** Drives a fresh permit through DRAFT -> PENDING_CRO -> PENDING_HSE for tests that start from PENDING_HSE. */
async function createPendingHsePermit(db: FakeDb, actorUserId = 'owner'): Promise<PermitRow> {
  const { permit } = await createDraftPermit(actorUserId, 'UTC', db.deps());
  const updated = await updateDraftPermit(
    actorUserId,
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  if (updated.outcome !== 'ok') throw new Error('setup failed: updateDraftPermit');
  const submitted = await submitPermit(actorUserId, permit.id, { expectedVersion: updated.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed: submitPermit');
  const forwarded = await forwardToHseReview(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );
  if (forwarded.outcome !== 'ok') throw new Error('setup failed: forwardToHseReview');
  return forwarded.permit;
}

/** Drives a fresh permit all the way through to ISSUED for tests that start from ISSUED. */
async function createIssuedPermit(db: FakeDb, actorUserId = 'owner'): Promise<PermitRow> {
  const pending = await createPendingHsePermit(db, actorUserId);
  const approved = await hseApprove('hse-1', pending.id, { expectedVersion: pending.version }, db.deps());
  if (approved.outcome !== 'ok') throw new Error('setup failed: hseApprove');
  return approved.permit;
}

test('createDraftPermit generates unique permit/JSA numbers per call and records a CREATED event', async () => {
  const db = new FakeDb();
  const first = await createDraftPermit('user-1', 'UTC', db.deps());
  const second = await createDraftPermit('user-1', 'UTC', db.deps());

  assert.notEqual(first.permit.permit_sequence, second.permit.permit_sequence);
  assert.notEqual(first.jsa.jsa_sequence, second.jsa.jsa_sequence);
  assert.equal(first.permit.status, 'DRAFT');
  assert.equal(first.permit.version, 1);

  const createdEvents = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(createdEvents.length, 2);
});

test('createDraftPermit produces unique numbers under concurrent calls', async () => {
  const db = new FakeDb();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => createDraftPermit('user-1', 'UTC', db.deps())),
  );
  const permitSequences = results.map((r) => r.permit.permit_sequence);
  const jsaSequences = results.map((r) => r.jsa.jsa_sequence);
  assert.equal(new Set(permitSequences).size, permitSequences.length);
  assert.equal(new Set(jsaSequences).size, jsaSequences.length);
});

test('getOwnPermit returns null for a permit that exists but belongs to someone else (no existence leak)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const asOwner = await getOwnPermit('owner', permit.id, db.deps());
  const asOther = await getOwnPermit('someone-else', permit.id, db.deps());
  const missing = await getOwnPermit('owner', 'no-such-id', db.deps());

  assert.equal(asOwner?.id, permit.id);
  assert.equal(asOther, null);
  assert.equal(missing, null);
});

test('updateDraftPermit rejects a stale version instead of silently overwriting', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version + 1, company: 'ESET' },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
  const stillDraft = await getOwnPermit('owner', permit.id, db.deps());
  assert.equal(stillDraft?.company, null);
  assert.equal(stillDraft?.version, permit.version);
});

test('updateDraftPermit rejects updating a permit that is no longer DRAFT', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  assert.equal(submitted.outcome, 'ok');

  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version + 2, company: 'SGRE' },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_draft' });
});

test('submitPermit rejects the transition when the required company field is missing', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await submitPermit('owner', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'invalid', reason: 'missing_required_fields' });
});

test('submitPermit requires companyOther when company is OTHER before allowing submission', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'OTHER', companyOther: 'Acme Contracting' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;

  const result = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
});

test('submitPermit performs the only implemented transition, DRAFT -> PENDING_CRO, once the required field is set', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;

  const result = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_CRO');
  assert.ok(result.permit.submitted_at);
});

test('submitPermit rejects submitting an already-submitted permit (invalid transition rejection)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;
  const firstSubmit = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.equal(firstSubmit.outcome, 'ok');
  if (firstSubmit.outcome !== 'ok') return;

  const secondSubmit = await submitPermit(
    'owner',
    permit.id,
    { expectedVersion: firstSubmit.permit.version },
    db.deps(),
  );

  assert.deepEqual(secondSubmit, { outcome: 'conflict', reason: 'not_draft' });
});

test('lifecycle events are only ever inserted, never updated or deleted (immutability at the application boundary)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const lifecycleEventQueries = db.queries.filter((q) => q.sql.includes('permit_lifecycle_events'));
  assert.ok(lifecycleEventQueries.length >= 2);
  for (const q of lifecycleEventQueries) {
    assert.ok(
      q.sql.startsWith('INSERT INTO permit_lifecycle_events'),
      `expected only INSERTs against permit_lifecycle_events, got: ${q.sql}`,
    );
  }
});

test('createDraftPermit/submitPermit only ever write event/status pairs the database CHECK constraint allows', async () => {
  // FakeDb's INSERT INTO permit_lifecycle_events handler mirrors migration
  // 0006's permit_lifecycle_events_event_status_consistent CHECK constraint
  // and throws on a disallowed pair - so simply not throwing here is the
  // assertion that both real call sites (CREATED/SUBMITTED) stay compliant.
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const insertedEvents = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(insertedEvents.length, 2);
  assert.deepEqual(insertedEvents[0]?.params, [permit.id, 'CREATED', 'owner', null, 'DRAFT']);
  assert.deepEqual(insertedEvents[1]?.params, [permit.id, 'SUBMITTED', 'owner', 'DRAFT', 'PENDING_CRO']);
});

test('an event/status pair outside the allowed set is rejected (simulated DB CHECK constraint)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  await assert.rejects(
    () =>
      db
        .deps()
        .query(
          `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
           VALUES ($1, $2, $3, $4, $5)`,
          [permit.id, 'SUBMITTED', 'owner', null, 'PENDING_CRO'],
        ),
    /CHECK constraint/,
  );
});

// --- CRO -> HSE review and 5-minute fallback approval ---

test('forwardToHseReview rejects a permit that is not PENDING_CRO (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await forwardToHseReview('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_cro' });
});

test('forwardToHseReview rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');
  if (submitted.outcome !== 'ok') return;

  const result = await forwardToHseReview(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version + 1 },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('forwardToHseReview atomically opens the HSE review window (exactly 5 minutes) and records CRO_FORWARDED_HSE, using DB-authoritative time', async () => {
  const db = new FakeDb();
  db.now = new Date('2026-01-01T00:00:00.000Z');
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');
  if (submitted.outcome !== 'ok') return;

  const result = await forwardToHseReview(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_HSE');
  // Not the caller's/browser's time - the fake DB's own authoritative
  // clock, which the service never receives as an input parameter.
  assert.equal(result.permit.hse_review_started_at, db.now.toISOString());
  assert.equal(
    new Date(result.permit.hse_review_deadline_at ?? '').getTime() -
      new Date(result.permit.hse_review_started_at ?? '').getTime(),
    FIVE_MINUTES_MS,
  );
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);

  const events = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.deepEqual(events[2]?.params, [permit.id, 'CRO_FORWARDED_HSE', 'cro-1', 'PENDING_CRO', 'PENDING_HSE']);
});

test('hseApprove rejects a permit that is not PENDING_HSE (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_hse' });
});

test('hseApprove succeeds before the 5-minute window times out, issuing the permit', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);

  const result = await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'ISSUED');
  assert.equal(result.permit.issued_at, db.now.toISOString());
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);
});

test('croFallbackApprove is denied before 5 minutes have elapsed', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS - 1);

  const result = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'too_early' });
});

test('croFallbackApprove is allowed at/after 5 minutes have elapsed, using DB-authoritative time only', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);

  const result = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'ISSUED');
  assert.equal(result.permit.issued_at, db.now.toISOString());
  // Fallback approval preserves Permit/JSA numbering.
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.deepEqual(events.at(-1)?.params, [permit.id, 'CRO_FALLBACK_APPROVED', 'cro-1', 'PENDING_HSE', 'ISSUED']);
});

test('an HSE action permanently prevents fallback approval, even after the window has expired', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  const approved = await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(approved.outcome, 'ok');
  db.advanceTime(FIVE_MINUTES_MS);

  const result = await croFallbackApprove(
    'cro-1',
    permit.id,
    { expectedVersion: permit.version + 1 },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_hse' });
});

test('a fallback approval permanently prevents a later HSE approval', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);
  const fallback = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(fallback.outcome, 'ok');

  const result = await hseApprove('hse-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_hse' });
});

test('a simulated HSE/fallback race cannot produce two approvals - exactly one wins', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);

  const [hseResult, fallbackResult] = await Promise.all([
    hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps()),
    croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps()),
  ]);

  const outcomes = [hseResult.outcome, fallbackResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'), `expected the loser to see a conflict, got: ${outcomes.join(', ')}`);

  const final = await getOwnPermit('owner', permit.id, db.deps());
  assert.equal(final?.status, 'ISSUED');
  assert.equal(final?.version, permit.version + 1);
});

test('CRO/HSE lifecycle events remain insert-only through the full forward/approve flow (immutability at the application boundary)', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);
  await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());

  const lifecycleQueries = db.queries.filter((q) => q.sql.includes('permit_lifecycle_events'));
  assert.ok(lifecycleQueries.length >= 4);
  for (const q of lifecycleQueries) {
    assert.ok(
      q.sql.startsWith('INSERT INTO permit_lifecycle_events'),
      `expected only INSERTs against permit_lifecycle_events, got: ${q.sql}`,
    );
  }
});

// --- Permit closure: ISSUED -> CRO CLOSE -> CLOSED ---

test('closePermit transitions ISSUED -> CLOSED, recording the actor and DB-authoritative time', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'CLOSED');
  // Actor recorded as closed_by - the authenticated caller, not anything
  // client-supplied (closePermit's own input type has no such field).
  assert.equal(result.permit.closed_by, 'cro-2');
  // closed_at set, from the fake DB's authoritative clock.
  assert.equal(result.permit.closed_at, db.now.toISOString());
});

test('closePermit persists optional closure remarks when provided, and leaves them null when omitted', async () => {
  const db = new FakeDb();

  const withRemarks = await createIssuedPermit(db, 'owner-1');
  const closedWithRemarks = await closePermit(
    'cro-2',
    withRemarks.id,
    { expectedVersion: withRemarks.version, closureRemarks: 'Area inspected, all clear.' },
    db.deps(),
  );
  assert.equal(closedWithRemarks.outcome, 'ok');
  if (closedWithRemarks.outcome === 'ok') {
    assert.equal(closedWithRemarks.permit.closure_remarks, 'Area inspected, all clear.');
  }

  const withoutRemarks = await createIssuedPermit(db, 'owner-2');
  const closedWithoutRemarks = await closePermit(
    'cro-2',
    withoutRemarks.id,
    { expectedVersion: withoutRemarks.version },
    db.deps(),
  );
  assert.equal(closedWithoutRemarks.outcome, 'ok');
  if (closedWithoutRemarks.outcome === 'ok') {
    assert.equal(closedWithoutRemarks.permit.closure_remarks, null);
  }
});

test('closePermit preserves the Permit Number (permit_sequence) and JSA (jsa_id) unchanged', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);
});

test('closePermit appends a CLOSED lifecycle event atomically with the status transition', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await closePermit(
    'cro-2',
    permit.id,
    { expectedVersion: permit.version, closureRemarks: 'Site secured.' },
    db.deps(),
  );
  assert.equal(result.outcome, 'ok');

  const events = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  const closedEvent = events.at(-1);
  assert.deepEqual(closedEvent?.params, [
    permit.id,
    PERMIT_CLOSED_EVENT_TYPE,
    'cro-2',
    'ISSUED',
    'CLOSED',
    'Site secured.',
  ]);
  // Atomic: both the status-changing UPDATE and the event INSERT happen
  // together - see the next test for the failure/rollback side of this.
  const closeUpdate = db.queries.find((q) => q.sql.startsWith('UPDATE permits') && q.sql.includes("SET status = 'CLOSED'"));
  assert.ok(closeUpdate, 'expected the CLOSED status UPDATE to have run alongside the lifecycle event INSERT');
});

test('closePermit rolls back entirely if the CLOSED lifecycle event insert fails - the permit stays exactly as it was', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  db.failNextLifecycleEventInsert = { eventType: PERMIT_CLOSED_EVENT_TYPE };

  await assert.rejects(
    () => closePermit('cro-2', permit.id, { expectedVersion: permit.version, closureRemarks: 'Site secured.' }, db.deps()),
    /simulated database failure inserting CLOSED lifecycle event/,
  );

  // Nothing from the failed transaction survives: the permit UPDATE that
  // ran before the failing INSERT was rolled back along with it.
  const afterFailure = await getOwnPermit('owner', permit.id, db.deps());
  assert.equal(afterFailure?.status, 'ISSUED');
  assert.equal(afterFailure?.version, permit.version);
  assert.equal(afterFailure?.closed_by, null);
  assert.equal(afterFailure?.closed_at, null);
  assert.equal(afterFailure?.closure_remarks, null);

  const survivingClosedEvents = db.lifecycleEvents.filter((e) => e.event_type === PERMIT_CLOSED_EVENT_TYPE);
  assert.equal(survivingClosedEvents.length, 0, 'expected no CLOSED lifecycle event to survive the rollback');

  // The failure injection is one-shot - closing should succeed normally
  // afterwards, proving the permit really was left closeable (i.e. still
  // ISSUED at its original version), not stuck in a half-updated state.
  const retried = await closePermit(
    'cro-2',
    permit.id,
    { expectedVersion: permit.version, closureRemarks: 'Site secured.' },
    db.deps(),
  );
  assert.equal(retried.outcome, 'ok');
});

test('closePermit rejects a DRAFT permit (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_issued' });
});

test('closePermit rejects a PENDING_CRO permit (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');
  if (submitted.outcome !== 'ok') return;

  const result = await closePermit('cro-2', permit.id, { expectedVersion: submitted.permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_issued' });
});

test('closePermit rejects a PENDING_HSE permit (wrong state rejected)', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_issued' });
});

test('closePermit rejects an already-CLOSED permit (cannot close again)', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const firstClose = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(firstClose.outcome, 'ok');
  if (firstClose.outcome !== 'ok') return;

  const secondClose = await closePermit(
    'cro-3',
    permit.id,
    { expectedVersion: firstClose.permit.version },
    db.deps(),
  );

  assert.deepEqual(secondClose, { outcome: 'conflict', reason: 'not_issued' });
});

test('closePermit rejects a stale version instead of silently overwriting', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('a simulated concurrent double-close race has exactly one winner', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const [first, second] = await Promise.all([
    closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps()),
    closePermit('cro-3', permit.id, { expectedVersion: permit.version }, db.deps()),
  ]);

  const outcomes = [first.outcome, second.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'), `expected the loser to see a conflict, got: ${outcomes.join(', ')}`);

  const final = await getOwnPermit('owner', permit.id, db.deps());
  assert.equal(final?.status, 'CLOSED');
  assert.equal(final?.version, permit.version + 1);
});

test('every other permit-mutating path already rejects a CLOSED permit (immutability falls out of existing status checks)', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const closed = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(closed.outcome, 'ok');
  if (closed.outcome !== 'ok') return;

  const updateAttempt = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: closed.permit.version, company: 'SGRE' },
    db.deps(),
  );
  assert.deepEqual(updateAttempt, { outcome: 'conflict', reason: 'not_draft' });

  const submitAttempt = await submitPermit('owner', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(submitAttempt, { outcome: 'conflict', reason: 'not_draft' });

  const forwardAttempt = await forwardToHseReview(
    'cro-1',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(forwardAttempt, { outcome: 'conflict', reason: 'not_pending_cro' });

  const hseAttempt = await hseApprove('hse-1', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(hseAttempt, { outcome: 'conflict', reason: 'not_pending_hse' });
});

test('assertPermitInvariants (mirroring permits_closure_consistent/permits_issued_at_consistent) rejects invalid closure states', () => {
  const base: PermitRow = {
    id: 'permit-x',
    permit_sequence: '1',
    jsa_id: 'jsa-x',
    status: 'ISSUED',
    version: 3,
    created_by: 'owner',
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: '2026-01-01T00:00:00.000Z',
    hse_review_started_at: '2026-01-01T00:00:00.000Z',
    hse_review_deadline_at: '2026-01-01T00:05:00.000Z',
    issued_at: '2026-01-01T00:05:00.000Z',
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
  };

  // A valid ISSUED row and a valid CLOSED row both pass.
  assert.doesNotThrow(() => assertPermitInvariants(base));
  assert.doesNotThrow(() =>
    assertPermitInvariants({
      ...base,
      status: 'CLOSED',
      closed_by: 'cro-2',
      closed_at: '2026-01-01T01:00:00.000Z',
    }),
  );

  // CLOSED without closed_by/closed_at violates permits_closure_consistent.
  assert.throws(() => assertPermitInvariants({ ...base, status: 'CLOSED' }), /permits_closure_consistent/);
  // Closure metadata present on a non-CLOSED permit also violates it.
  assert.throws(
    () => assertPermitInvariants({ ...base, closed_by: 'cro-2', closed_at: '2026-01-01T01:00:00.000Z' }),
    /permits_closure_consistent/,
  );
  assert.throws(() => assertPermitInvariants({ ...base, closure_remarks: 'leftover' }), /permits_closure_consistent/);
  // CLOSED without issued_at violates permits_issued_at_consistent (a
  // permit must have been issued before it can be closed).
  assert.throws(
    () =>
      assertPermitInvariants({
        ...base,
        status: 'CLOSED',
        closed_by: 'cro-2',
        closed_at: '2026-01-01T01:00:00.000Z',
        issued_at: null,
      }),
    /permits_issued_at_consistent/,
  );
});

// --- Read APIs: permit detail+JSA, own/queue lists, lifecycle history ---

test('getPermitWithJsa returns the permit joined with its JSA, for any permit id (no ownership filter)', async () => {
  const db = new FakeDb();
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', db.deps());

  const found = await getPermitWithJsa(permit.id, db.deps());

  assert.ok(found);
  assert.equal(found?.permit.id, permit.id);
  assert.equal(found?.jsa.id, jsa.id);
  assert.equal(found?.jsa.jsa_sequence, jsa.jsa_sequence);
});

test('getPermitWithJsa returns null for a nonexistent permit', async () => {
  const db = new FakeDb();
  const found = await getPermitWithJsa('no-such-permit', db.deps());
  assert.equal(found, null);
});

test('getPermitById returns the permit only - no JSA join, no ownership filter', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const found = await getPermitById(permit.id, db.deps());

  assert.deepEqual(found, permit);
});

test('getPermitById returns null for a nonexistent permit', async () => {
  const db = new FakeDb();
  const found = await getPermitById('no-such-permit', db.deps());
  assert.equal(found, null);
});

test('getPermitById never queries the jsas table (proves detail/history can authorize before any JSA read)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  db.queries = [];

  await getPermitById(permit.id, db.deps());

  assert.equal(
    db.queries.some((q) => q.sql.includes('jsas')),
    false,
  );
});

test('getJsaById returns the JSA for a permit\'s jsa_id', async () => {
  const db = new FakeDb();
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', db.deps());

  const found = await getJsaById(permit.jsa_id, db.deps());

  assert.deepEqual(found, jsa);
});

test('getJsaById throws for an id with no matching row (FK-guaranteed invariant, not a normal not-found)', async () => {
  const db = new FakeDb();
  await assert.rejects(() => getJsaById('no-such-jsa', db.deps()));
});

const DEFAULT_PAGE = { page: 1, pageSize: 20 };

test('listOwnPermits returns only the given user\'s permits, most recent first', async () => {
  const db = new FakeDb();
  const first = await createDraftPermit('owner-a', 'UTC', db.deps());
  const second = await createDraftPermit('owner-a', 'UTC', db.deps());
  await createDraftPermit('owner-b', 'UTC', db.deps());

  const page = await listOwnPermits('owner-a', DEFAULT_PAGE, db.deps());

  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((p) => p.created_by === 'owner-a'));
  assert.deepEqual(
    page.items.map((p) => p.id).sort(),
    [first.permit.id, second.permit.id].sort(),
  );
  // most recent first: `second` was created after `first`.
  assert.deepEqual(page.items.map((p) => p.id), [second.permit.id, first.permit.id]);
});

test('listOwnPermits: pagination metadata is accurate, and a page never includes another user\'s permits (no cross-user leakage under pagination)', async () => {
  const db = new FakeDb();
  for (let i = 0; i < 5; i += 1) {
    await createDraftPermit('owner-a', 'UTC', db.deps());
  }
  await createDraftPermit('owner-b', 'UTC', db.deps());

  const firstPage = await listOwnPermits('owner-a', { page: 1, pageSize: 2 }, db.deps());
  const secondPage = await listOwnPermits('owner-a', { page: 2, pageSize: 2 }, db.deps());
  const thirdPage = await listOwnPermits('owner-a', { page: 3, pageSize: 2 }, db.deps());

  assert.equal(firstPage.totalCount, 5);
  assert.equal(firstPage.totalPages, 3);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasNextPage, true);
  assert.equal(firstPage.hasPreviousPage, false);

  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.hasNextPage, true);
  assert.equal(secondPage.hasPreviousPage, true);

  assert.equal(thirdPage.items.length, 1);
  assert.equal(thirdPage.hasNextPage, false);
  assert.equal(thirdPage.hasPreviousPage, true);

  const allIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((p) => p.id);
  assert.equal(new Set(allIds).size, 5, 'no permit repeated across pages');
  assert.ok(
    [...firstPage.items, ...secondPage.items, ...thirdPage.items].every((p) => p.created_by === 'owner-a'),
    'owner-b\'s permit must never appear on any of owner-a\'s pages',
  );
});

test('listOwnPermits: an empty result set reports zero totalPages/totalCount, not an error', async () => {
  const db = new FakeDb();
  const page = await listOwnPermits('nobody-has-created-anything', DEFAULT_PAGE, db.deps());
  assert.deepEqual(page.items, []);
  assert.equal(page.totalCount, 0);
  assert.equal(page.totalPages, 0);
  assert.equal(page.hasNextPage, false);
  assert.equal(page.hasPreviousPage, false);
});

// --- Service-layer pagination defense: independently re-derives every
// invariant (page shape, pageSize shape, THEN the computed offset) from
// scratch, never assuming route-level validation already ran - see
// `pageOffset` in service.ts. Every invalid case below must reject
// BEFORE any SQL query executes (proven via `db.queries.length === 0`
// after the rejection), and never silently clamp to a nearby valid
// value.

const INVALID_PAGE_PARAMS: Array<{ label: string; pageParams: { page: number; pageSize: number } }> = [
  { label: 'page = 0', pageParams: { page: 0, pageSize: 20 } },
  { label: 'page = -1', pageParams: { page: -1, pageSize: 20 } },
  { label: 'fractional page', pageParams: { page: 1.5, pageSize: 20 } },
  { label: 'unsafe-integer page', pageParams: { page: Number.MAX_SAFE_INTEGER + 10, pageSize: 20 } },
  { label: 'pageSize = 0', pageParams: { page: 1, pageSize: 0 } },
  { label: 'negative pageSize', pageParams: { page: 1, pageSize: -5 } },
  { label: 'fractional pageSize', pageParams: { page: 1, pageSize: 2.5 } },
  { label: 'pageSize > 100', pageParams: { page: 1, pageSize: 101 } },
  { label: 'unsafe-integer pageSize', pageParams: { page: 1, pageSize: Number.MAX_SAFE_INTEGER } },
  { label: 'offset above 100000', pageParams: { page: 1002, pageSize: 100 } },
];

for (const { label, pageParams } of INVALID_PAGE_PARAMS) {
  test(`listOwnPermits: rejects ${label} before any SQL query executes (defensive, independent of route validation)`, async () => {
    const db = new FakeDb();
    await assert.rejects(() => listOwnPermits('owner-a', pageParams, db.deps()), RangeError);
    assert.equal(db.queries.length, 0, 'no SQL query should have run for an invalid pageParams');
  });

  test(`listPermitsByStatus: rejects ${label} before any SQL query executes (defensive, independent of route validation)`, async () => {
    const db = new FakeDb();
    await assert.rejects(() => listPermitsByStatus('ISSUED', pageParams, db.deps()), RangeError);
    assert.equal(db.queries.length, 0, 'no SQL query should have run for an invalid pageParams');
  });
}

test('listOwnPermits: the exact maximum allowed offset (100_000) succeeds - the boundary itself is valid, not rejected', async () => {
  const db = new FakeDb();
  const page = await listOwnPermits('owner-a', { page: 1001, pageSize: 100 }, db.deps());
  assert.deepEqual(page.items, []);
  assert.ok(db.queries.length > 0, 'a valid request must still actually query the database');
});

test('listPermitsByStatus: the exact maximum allowed offset (100_000) succeeds', async () => {
  const db = new FakeDb();
  const page = await listPermitsByStatus('ISSUED', { page: 1001, pageSize: 100 }, db.deps());
  assert.deepEqual(page.items, []);
  assert.ok(db.queries.length > 0, 'a valid request must still actually query the database');
});

test('listOwnPermits: ordinary valid pagination still succeeds unaffected by the defensive checks', async () => {
  const db = new FakeDb();
  await createDraftPermit('owner-a', 'UTC', db.deps());
  const page = await listOwnPermits('owner-a', { page: 1, pageSize: 20 }, db.deps());
  assert.equal(page.items.length, 1);
});

test('listPermitsByStatus: ordinary valid pagination still succeeds unaffected by the defensive checks', async () => {
  const db = new FakeDb();
  const pendingHse = await createPendingHsePermit(db, 'owner-a');
  const page = await listPermitsByStatus('PENDING_HSE', { page: 1, pageSize: 20 }, db.deps());
  assert.deepEqual(page.items.map((p) => p.id), [pendingHse.id]);
});

test('listPermitsByStatus returns only permits currently in that status, regardless of who created them', async () => {
  const db = new FakeDb();
  const pendingHse = await createPendingHsePermit(db, 'owner-a');
  await createDraftPermit('owner-b', 'UTC', db.deps());

  const page = await listPermitsByStatus('PENDING_HSE', DEFAULT_PAGE, db.deps());

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, pendingHse.id);
});

test('listPermitsByStatus: pagination metadata is accurate and ordering is oldest-first (FIFO) across pages', async () => {
  const db = new FakeDb();
  const permits = [];
  for (let i = 0; i < 3; i += 1) {
    const { permit } = await createDraftPermit('someone', 'UTC', db.deps());
    permits.push(permit);
  }

  const firstPage = await listPermitsByStatus('DRAFT', { page: 1, pageSize: 2 }, db.deps());
  const secondPage = await listPermitsByStatus('DRAFT', { page: 2, pageSize: 2 }, db.deps());

  assert.equal(firstPage.totalCount, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.deepEqual(
    firstPage.items.map((p) => p.id),
    [permits[0]?.id, permits[1]?.id],
  );
  assert.deepEqual(secondPage.items.map((p) => p.id), [permits[2]?.id]);
});

test('getPermitLifecycleEvents returns the append-only history for a permit, in order', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const events = await getPermitLifecycleEvents(permit.id, db.deps());

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event_type, 'CREATED');
  assert.equal(events[1]?.event_type, 'SUBMITTED');
});

test('JSA data is never modified through the full permit lifecycle (no JSA mutation code path exists)', async () => {
  const db = new FakeDb();
  const pendingHse = await createPendingHsePermit(db);
  const jsaBefore = await getPermitWithJsa(pendingHse.id, db.deps());
  assert.ok(jsaBefore);

  const approved = await hseApprove('hse-1', pendingHse.id, { expectedVersion: pendingHse.version }, db.deps());
  assert.equal(approved.outcome, 'ok');
  if (approved.outcome !== 'ok') return;
  const closed = await closePermit('cro-2', pendingHse.id, { expectedVersion: approved.permit.version }, db.deps());
  assert.equal(closed.outcome, 'ok');

  // The JSA belonging to the permit that just went through the full
  // lifecycle - fetched fresh, after closure - is byte-identical to what
  // it was before HSE approval/closure. There is no JSA update function
  // anywhere in this module that could have changed it.
  const jsaAfter = await getPermitWithJsa(pendingHse.id, db.deps());
  assert.ok(jsaAfter);
  assert.deepEqual(jsaAfter?.jsa, jsaBefore?.jsa);
});
