import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelPermit,
  closePermit,
  createDraftPermit,
  croFallbackApprove,
  croSendBackToApplicant,
  forwardToHseReview,
  getJsaById,
  getOwnPermit,
  getPermitById,
  getPermitLifecycleEvents,
  getPermitWithJsa,
  holdPermit,
  hseApprove,
  hseSendBackToCro,
  listOwnPermits,
  listPermitsByStatus,
  PERMIT_CLOSED_EVENT_TYPE,
  renewPermit,
  resubmitPermit,
  resumePermit,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type PermitRow,
  type PermitsServiceDeps,
} from './service.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const NO_HSE_WINDOW_STATUSES = new Set(['DRAFT', 'PENDING_CRO', 'PENDING_CORRECTION']);
const ALWAYS_HSE_WINDOW_STATUSES = new Set(['PENDING_HSE']);
const MAYBE_HSE_WINDOW_STATUSES = new Set(['ISSUED', 'HELD', 'CLOSED', 'CANCELLED']);
const ISSUED_OR_LATER_STATUSES = new Set(['ISSUED', 'HELD', 'CLOSED', 'CANCELLED']);

/**
 * Mirrors migration 0008/0010/0012's permits CHECK constraints
 * (permits_hse_window_status_consistent, permits_hse_deadline_exact,
 * permits_issued_at_consistent, permits_closure_consistent,
 * permits_hold_consistent, permits_cancellation_consistent), so a
 * service.ts bug that would violate them fails the same way it would
 * against the real database.
 */
function assertPermitInvariants(permit: PermitRow): void {
  const hasWindow = permit.hse_review_started_at !== null && permit.hse_review_deadline_at !== null;
  const noWindow = permit.hse_review_started_at === null && permit.hse_review_deadline_at === null;
  // ISSUED/HELD/CLOSED/CANCELLED normally carry the window (they were,
  // transitively, once PENDING_HSE) - EXCEPT a renewed permit
  // (previous_permit_id set), which skips review entirely and so never
  // has one (migration 0012's carve-out).
  const renewalWindowCarveOut = noWindow && permit.previous_permit_id !== null;
  const windowStatusOk =
    (NO_HSE_WINDOW_STATUSES.has(permit.status) && noWindow) ||
    (ALWAYS_HSE_WINDOW_STATUSES.has(permit.status) && hasWindow) ||
    (MAYBE_HSE_WINDOW_STATUSES.has(permit.status) && (hasWindow || renewalWindowCarveOut));
  if (!windowStatusOk) {
    throw new Error(
      `simulated CHECK constraint violation: permits_hse_window_status_consistent (status=${permit.status}, started=${permit.hse_review_started_at}, deadline=${permit.hse_review_deadline_at}, previous_permit_id=${permit.previous_permit_id})`,
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
  const holdOk =
    (permit.status === 'HELD' &&
      permit.held_by !== null &&
      permit.held_at !== null &&
      permit.hold_reason !== null &&
      permit.hold_reason.trim() !== '') ||
    (permit.status !== 'HELD' && permit.held_by === null && permit.held_at === null && permit.hold_reason === null);
  if (!holdOk) {
    throw new Error(
      `simulated CHECK constraint violation: permits_hold_consistent (status=${permit.status}, held_by=${permit.held_by}, held_at=${permit.held_at}, hold_reason=${permit.hold_reason})`,
    );
  }
  const cancellationOk =
    (permit.status === 'CANCELLED' && permit.cancelled_by !== null && permit.cancelled_at !== null) ||
    (permit.status !== 'CANCELLED' &&
      permit.cancelled_by === null &&
      permit.cancelled_at === null &&
      permit.cancel_reason === null);
  if (!cancellationOk) {
    throw new Error(
      `simulated CHECK constraint violation: permits_cancellation_consistent (status=${permit.status}, cancelled_by=${permit.cancelled_by}, cancelled_at=${permit.cancelled_at}, cancel_reason=${permit.cancel_reason})`,
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
    if (sql.startsWith('INSERT INTO permits') && sql.includes('previous_permit_id')) {
      // renewPermit's INSERT - distinct column list/params shape from the
      // plain draft-creation INSERT below. Checked FIRST/more
      // specifically: both this and the plain-creation INSERT literally
      // start with "INSERT INTO permits", so order matters here.
      const [jsaId, createdBy, previousPermitId, siteTimezone, company, companyOther] = params as [
        string,
        string,
        string,
        string,
        PermitRow['company'],
        string | null,
      ];
      // Mirrors permits_previous_permit_id_unique (migration 0012): at
      // most one permit may ever point back at a given previous permit.
      const alreadyRenewed = [...this.permits.values()].some((p) => p.previous_permit_id === previousPermitId);
      if (alreadyRenewed) {
        const uniqueViolation = new Error('simulated unique_violation: permits_previous_permit_id_unique') as Error & {
          code: string;
          constraint: string;
        };
        uniqueViolation.code = '23505';
        uniqueViolation.constraint = 'permits_previous_permit_id_unique';
        throw uniqueViolation;
      }
      this.permitCounter += 1;
      this.permitSeq += 1;
      const createdAt = new Date(this.now.getTime() + this.permitCounter).toISOString();
      const permit: PermitRow = {
        id: `permit-${this.permitCounter}`,
        permit_sequence: String(this.permitSeq),
        jsa_id: jsaId,
        status: 'ISSUED',
        version: 1,
        created_by: createdBy,
        previous_permit_id: previousPermitId,
        site_timezone: siteTimezone,
        company,
        company_other: companyOther,
        submitted_at: null,
        hse_review_started_at: null,
        hse_review_deadline_at: null,
        issued_at: this.now.toISOString(),
        closed_by: null,
        closed_at: null,
        closure_remarks: null,
        held_by: null,
        held_at: null,
        hold_reason: null,
        cancelled_by: null,
        cancelled_at: null,
        cancel_reason: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      return { rows: [this.setPermit(permit)] };
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
        held_by: null,
        held_at: null,
        hold_reason: null,
        cancelled_by: null,
        cancelled_at: null,
        cancel_reason: null,
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
      // Mirrors migration 0006/0008/0010/0012's
      // permit_lifecycle_events_event_status_consistent CHECK constraint,
      // so a violation here fails the same way it would against the real
      // database.
      const allowed =
        (eventType === 'CREATED' && fromStatus === null && toStatus === 'DRAFT') ||
        (eventType === 'SUBMITTED' && fromStatus === 'DRAFT' && toStatus === 'PENDING_CRO') ||
        (eventType === 'CRO_FORWARDED_HSE' && fromStatus === 'PENDING_CRO' && toStatus === 'PENDING_HSE') ||
        (eventType === 'HSE_APPROVED' && fromStatus === 'PENDING_HSE' && toStatus === 'ISSUED') ||
        (eventType === 'CRO_FALLBACK_APPROVED' && fromStatus === 'PENDING_HSE' && toStatus === 'ISSUED') ||
        (eventType === PERMIT_CLOSED_EVENT_TYPE && (fromStatus === 'ISSUED' || fromStatus === 'HELD') && toStatus === 'CLOSED') ||
        (eventType === 'CRO_SENT_BACK_TO_APPLICANT' && fromStatus === 'PENDING_CRO' && toStatus === 'PENDING_CORRECTION') ||
        (eventType === 'APPLICANT_RESUBMITTED' && fromStatus === 'PENDING_CORRECTION' && toStatus === 'PENDING_CRO') ||
        (eventType === 'HSE_SENT_BACK_TO_CRO' && fromStatus === 'PENDING_HSE' && toStatus === 'PENDING_CRO') ||
        (eventType === 'HELD' && fromStatus === 'ISSUED' && toStatus === 'HELD') ||
        (eventType === 'RESUMED' && fromStatus === 'HELD' && toStatus === 'ISSUED') ||
        (eventType === 'CANCELLED' && (fromStatus === 'ISSUED' || fromStatus === 'HELD') && toStatus === 'CANCELLED') ||
        (eventType === 'RENEWED' && fromStatus === null && toStatus === 'ISSUED');
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
    if (sql.startsWith('SELECT p.*, now() AS db_now FROM permits p WHERE p.id = $1 FOR UPDATE')) {
      // resumePermit/renewPermit's DB-authoritative-time read - `db_now`
      // is `this.now` (the fake DB's own clock), deliberately never the
      // real wall clock, so tests can prove application-clock skew has
      // no effect (see the "DB-authoritative time" test group below).
      const [id] = params as [string];
      const permit = this.permits.get(id);
      return permit ? { rows: [{ ...permit, db_now: this.now.toISOString() }] } : { rows: [] };
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
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_CRO'") && sql.includes('hse_review_started_at = NULL')) {
      // hseSendBackToCro's UPDATE - distinct from submit/resubmit below:
      // clears the HSE window ("the timer stops immediately"), never
      // touches submitted_at. Checked first/more specifically, since
      // both this and the submit/resubmit UPDATE contain
      // "SET status = 'PENDING_CRO'".
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'PENDING_CRO',
        hse_review_started_at: null,
        hse_review_deadline_at: null,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_CRO'")) {
      // submitPermit (DRAFT -> PENDING_CRO) and resubmitPermit
      // (PENDING_CORRECTION -> PENDING_CRO) issue the exact same UPDATE -
      // they differ only in their WHERE-clause source-status check
      // (already enforced above, in the service layer) and which
      // lifecycle event they record.
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
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_CORRECTION'")) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'PENDING_CORRECTION',
        version: existing.version + 1,
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
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'ISSUED'") && sql.includes('held_by = NULL')) {
      // resumePermit's UPDATE - distinct from hseApprove/croFallbackApprove
      // below: never touches issued_at (resume must not restart/extend
      // validity), clears the hold columns instead. Checked first/more
      // specifically for the same reason as the PENDING_CRO split above.
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'ISSUED',
        held_by: null,
        held_at: null,
        hold_reason: null,
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
        held_by: null,
        held_at: null,
        hold_reason: null,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'HELD'")) {
      const [id, heldBy, holdReason] = params as [string, string, string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'HELD',
        held_by: heldBy,
        held_at: this.now.toISOString(),
        hold_reason: holdReason,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'CANCELLED'")) {
      const [id, cancelledBy, cancelReason] = params as [string, string, string | null];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'CANCELLED',
        cancelled_by: cancelledBy,
        cancelled_at: this.now.toISOString(),
        cancel_reason: cancelReason,
        held_by: null,
        held_at: null,
        hold_reason: null,
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

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_editable' });
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

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_closable' });
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

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_closable' });
});

test('closePermit rejects a PENDING_HSE permit (wrong state rejected)', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_closable' });
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

  assert.deepEqual(secondClose, { outcome: 'conflict', reason: 'not_closable' });
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
  assert.deepEqual(updateAttempt, { outcome: 'conflict', reason: 'not_editable' });

  const submitAttempt = await submitPermit('owner', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(submitAttempt, { outcome: 'conflict', reason: 'not_draft' });

  const resubmitAttempt = await resubmitPermit(
    'owner',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(resubmitAttempt, { outcome: 'conflict', reason: 'not_pending_correction' });

  const forwardAttempt = await forwardToHseReview(
    'cro-1',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(forwardAttempt, { outcome: 'conflict', reason: 'not_pending_cro' });

  const sendBackAttempt = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(sendBackAttempt, { outcome: 'conflict', reason: 'not_pending_cro' });

  const hseAttempt = await hseApprove('hse-1', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(hseAttempt, { outcome: 'conflict', reason: 'not_pending_hse' });

  const hseSendBackAttempt = await hseSendBackToCro(
    'hse-1',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(hseSendBackAttempt, { outcome: 'conflict', reason: 'not_pending_hse' });

  const holdAttempt = await holdPermit(
    'cro-1',
    permit.id,
    { expectedVersion: closed.permit.version, reason: 'unsafe conditions' },
    db.deps(),
  );
  assert.deepEqual(holdAttempt, { outcome: 'conflict', reason: 'not_issued' });

  const resumeAttempt = await resumePermit('cro-1', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(resumeAttempt, { outcome: 'conflict', reason: 'not_held' });

  const cancelAttempt = await cancelPermit('cro-1', permit.id, { expectedVersion: closed.permit.version }, db.deps());
  assert.deepEqual(cancelAttempt, { outcome: 'conflict', reason: 'not_cancellable' });

  const closeAgainAttempt = await closePermit(
    'cro-1',
    permit.id,
    { expectedVersion: closed.permit.version },
    db.deps(),
  );
  assert.deepEqual(closeAgainAttempt, { outcome: 'conflict', reason: 'not_closable' });
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
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
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

  // A valid HELD row passes.
  assert.doesNotThrow(() =>
    assertPermitInvariants({
      ...base,
      status: 'HELD',
      held_by: 'cro-3',
      held_at: '2026-01-01T02:00:00.000Z',
      hold_reason: 'unsafe wind conditions',
    }),
  );
  // HELD without hold metadata, or hold metadata on a non-HELD row,
  // violates permits_hold_consistent.
  assert.throws(() => assertPermitInvariants({ ...base, status: 'HELD' }), /permits_hold_consistent/);
  assert.throws(
    () => assertPermitInvariants({ ...base, held_by: 'cro-3', held_at: '2026-01-01T02:00:00.000Z', hold_reason: 'x' }),
    /permits_hold_consistent/,
  );
  // A blank (whitespace-only) hold_reason on a HELD row also violates it -
  // mirrors the database CHECK's btrim(hold_reason) <> '' clause.
  assert.throws(
    () =>
      assertPermitInvariants({
        ...base,
        status: 'HELD',
        held_by: 'cro-3',
        held_at: '2026-01-01T02:00:00.000Z',
        hold_reason: '   ',
      }),
    /permits_hold_consistent/,
  );

  // A valid CANCELLED row passes.
  assert.doesNotThrow(() =>
    assertPermitInvariants({
      ...base,
      status: 'CANCELLED',
      cancelled_by: 'cro-3',
      cancelled_at: '2026-01-01T02:00:00.000Z',
    }),
  );
  // CANCELLED without cancellation metadata, or cancellation metadata on
  // a non-CANCELLED row, violates permits_cancellation_consistent.
  assert.throws(() => assertPermitInvariants({ ...base, status: 'CANCELLED' }), /permits_cancellation_consistent/);
  assert.throws(
    () => assertPermitInvariants({ ...base, cancelled_by: 'cro-3', cancelled_at: '2026-01-01T02:00:00.000Z' }),
    /permits_cancellation_consistent/,
  );
});

// --- Workflow completion: CRO/HSE send-back, Hold, Resume, Cancel, Renewal ---

// Any real "now" during this project's lifetime is safely past this UTC
// instant's next midnight - used to construct already-expired fixtures
// without depending on wall-clock timing at test-run time.
const LONG_PAST_ISSUED_AT = '2020-01-01T00:00:00.000Z';

async function createHeldPermit(
  db: FakeDb,
  actorUserId = 'owner',
  croId = 'cro-2',
  reason = 'unsafe wind conditions',
): Promise<PermitRow> {
  const issued = await createIssuedPermit(db, actorUserId);
  const held = await holdPermit(croId, issued.id, { expectedVersion: issued.version, reason }, db.deps());
  if (held.outcome !== 'ok') throw new Error('setup failed: holdPermit');
  return held.permit;
}

async function createClosedPermit(db: FakeDb, actorUserId = 'owner'): Promise<PermitRow> {
  const issued = await createIssuedPermit(db, actorUserId);
  const closed = await closePermit('cro-2', issued.id, { expectedVersion: issued.version }, db.deps());
  if (closed.outcome !== 'ok') throw new Error('setup failed: closePermit');
  return closed.permit;
}

/** Test-only fixture manipulation - directly backdates a permit's issued_at (never exposed through any real service function) so expiry-dependent tests (Resume/Renew) don't depend on wall-clock timing at test-run time. */
function backdateIssuedAt(db: FakeDb, permit: PermitRow, issuedAtIso: string): PermitRow {
  const updated: PermitRow = { ...permit, issued_at: issuedAtIso };
  db.permits.set(permit.id, updated);
  return updated;
}

// --- CRO send-back to applicant / applicant resubmission ---

test('croSendBackToApplicant: PENDING_CRO -> PENDING_CORRECTION, recording the CRO actor and an optional reason', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');

  const result = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version, reason: 'missing hazard signage' },
    db.deps(),
  );

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_CORRECTION');
  // Permit Number / JSA Number unchanged.
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const sentBack = events.find((e) => e.event_type === 'CRO_SENT_BACK_TO_APPLICANT');
  assert.ok(sentBack);
  assert.equal(sentBack?.actor_user_id, 'cro-1');
  assert.equal(sentBack?.from_status, 'PENDING_CRO');
  assert.equal(sentBack?.to_status, 'PENDING_CORRECTION');
  assert.equal(sentBack?.reason, 'missing hazard signage');
});

test('croSendBackToApplicant rejects a permit that is not PENDING_CRO (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  const result = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_cro' });
});

test('croSendBackToApplicant rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const result = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('the applicant CAN edit a PENDING_CORRECTION permit (updateDraftPermit widened beyond DRAFT)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');

  const edited = await updateDraftPermit(
    'applicant-1',
    permit.id,
    { expectedVersion: sentBack.permit.version, company: 'SGRE' },
    db.deps(),
  );

  assert.equal(edited.outcome, 'ok');
  if (edited.outcome !== 'ok') return;
  assert.equal(edited.permit.company, 'SGRE');
  assert.equal(edited.permit.status, 'PENDING_CORRECTION');
});

test('resubmitPermit: PENDING_CORRECTION -> PENDING_CRO, only by the original applicant', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');

  // Someone who is NOT the original applicant cannot resubmit - the
  // ownership-scoped query finds no matching row for them.
  const notOwner = await resubmitPermit(
    'someone-else',
    permit.id,
    { expectedVersion: sentBack.permit.version },
    db.deps(),
  );
  assert.deepEqual(notOwner, { outcome: 'not_found' });

  const result = await resubmitPermit(
    'applicant-1',
    permit.id,
    { expectedVersion: sentBack.permit.version },
    db.deps(),
  );
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_CRO');
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const resubmitted = events.find((e) => e.event_type === 'APPLICANT_RESUBMITTED');
  assert.ok(resubmitted);
  assert.equal(resubmitted?.actor_user_id, 'applicant-1');
  assert.equal(resubmitted?.from_status, 'PENDING_CORRECTION');
  assert.equal(resubmitted?.to_status, 'PENDING_CRO');
});

test('resubmitPermit rejects a permit that is not PENDING_CORRECTION', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  const result = await resubmitPermit('applicant-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_correction' });
});

test('resubmitPermit rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());

  const result = await resubmitPermit('applicant-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('resubmitPermit rejects when required fields are missing (defensive - unreachable via the normal API, since submission already required company, but re-checked here anyway)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', db.deps());
  await updateDraftPermit('applicant-1', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');
  db.permits.set(permit.id, { ...sentBack.permit, company: null });

  const result = await resubmitPermit(
    'applicant-1',
    permit.id,
    { expectedVersion: sentBack.permit.version },
    db.deps(),
  );
  assert.deepEqual(result, { outcome: 'invalid', reason: 'missing_required_fields' });
});

test('a full send-back/resubmit/re-forward cycle: old review history is retained, and re-forwarding opens a completely NEW 5-minute window', async () => {
  const db = new FakeDb();
  const pending = await createPendingHsePermit(db, 'applicant-1'); // first forward
  const firstWindowStart = pending.hse_review_started_at;

  db.advanceTime(60_000); // 1 minute passes
  const sentBackByHse = await hseSendBackToCro('hse-1', pending.id, { expectedVersion: pending.version }, db.deps());
  if (sentBackByHse.outcome !== 'ok') throw new Error('setup failed');
  assert.equal(sentBackByHse.permit.status, 'PENDING_CRO');
  assert.equal(sentBackByHse.permit.hse_review_started_at, null);
  assert.equal(sentBackByHse.permit.hse_review_deadline_at, null);

  const sentBackToApplicant = await croSendBackToApplicant(
    'cro-1',
    pending.id,
    { expectedVersion: sentBackByHse.permit.version },
    db.deps(),
  );
  if (sentBackToApplicant.outcome !== 'ok') throw new Error('setup failed');

  db.advanceTime(60_000);
  const resubmitted = await resubmitPermit(
    'applicant-1',
    pending.id,
    { expectedVersion: sentBackToApplicant.permit.version },
    db.deps(),
  );
  if (resubmitted.outcome !== 'ok') throw new Error('setup failed');

  db.advanceTime(60_000);
  const reforwarded = await forwardToHseReview(
    'cro-1',
    pending.id,
    { expectedVersion: resubmitted.permit.version },
    db.deps(),
  );
  assert.equal(reforwarded.outcome, 'ok');
  if (reforwarded.outcome !== 'ok') return;

  // A completely new window - never reused/continued from the first one.
  assert.notEqual(reforwarded.permit.hse_review_started_at, firstWindowStart);
  const newStarted = new Date(reforwarded.permit.hse_review_started_at as string).getTime();
  const newDeadline = new Date(reforwarded.permit.hse_review_deadline_at as string).getTime();
  assert.equal(newDeadline - newStarted, FIVE_MINUTES_MS);

  // Every step of history remains, in order - nothing overwritten/lost.
  const events = await getPermitLifecycleEvents(pending.id, db.deps());
  assert.deepEqual(events.map((e) => e.event_type), [
    'CREATED',
    'SUBMITTED',
    'CRO_FORWARDED_HSE',
    'HSE_SENT_BACK_TO_CRO',
    'CRO_SENT_BACK_TO_APPLICANT',
    'APPLICANT_RESUBMITTED',
    'CRO_FORWARDED_HSE',
  ]);
});

// --- HSE send-back to CRO ---

test('hseSendBackToCro: PENDING_HSE -> PENDING_CRO, clearing the HSE review window immediately', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);

  const result = await hseSendBackToCro(
    'hse-1',
    permit.id,
    { expectedVersion: permit.version, reason: 'incomplete isolation plan' },
    db.deps(),
  );

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_CRO');
  assert.equal(result.permit.hse_review_started_at, null);
  assert.equal(result.permit.hse_review_deadline_at, null);
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const sentBack = events.find((e) => e.event_type === 'HSE_SENT_BACK_TO_CRO');
  assert.ok(sentBack);
  assert.equal(sentBack?.actor_user_id, 'hse-1');
  assert.equal(sentBack?.reason, 'incomplete isolation plan');
});

test('hseSendBackToCro rejects a permit that is not PENDING_HSE', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const result = await hseSendBackToCro('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_hse' });
});

test('hseSendBackToCro rejects a stale version', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  // A mismatched version - too high, not "reused" - since PENDING_HSE
  // can't be re-reached to naturally produce a lagging version the way
  // e.g. croSendBackToApplicant's equivalent test does via DRAFT's extra
  // update/submit steps.
  const result = await hseSendBackToCro('hse-1', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('a simulated HSE-approve-vs-HSE-send-back race cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);

  const [approveResult, sendBackResult] = await Promise.all([
    hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps()),
    hseSendBackToCro('hse-2', permit.id, { expectedVersion: permit.version }, db.deps()),
  ]);

  const outcomes = [approveResult.outcome, sendBackResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

test('a simulated CRO-fallback-approve-vs-HSE-send-back race cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);

  const [fallbackResult, sendBackResult] = await Promise.all([
    croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps()),
    hseSendBackToCro('hse-1', permit.id, { expectedVersion: permit.version }, db.deps()),
  ]);

  const outcomes = [fallbackResult.outcome, sendBackResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

// --- Hold ---

test('holdPermit: ISSUED -> HELD, recording the actor, DB-authoritative time, and the mandatory reason', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await holdPermit(
    'cro-2',
    permit.id,
    { expectedVersion: permit.version, reason: 'crane inspection overdue' },
    db.deps(),
  );

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'HELD');
  assert.equal(result.permit.held_by, 'cro-2');
  assert.ok(result.permit.held_at);
  assert.equal(result.permit.hold_reason, 'crane inspection overdue');
  // Same Permit Number / JSA Number.
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const held = events.find((e) => e.event_type === 'HELD');
  assert.ok(held);
  assert.equal(held?.actor_user_id, 'cro-2');
  assert.equal(held?.reason, 'crane inspection overdue');
});

test('holdPermit only applies from ISSUED (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit: draft } = await createDraftPermit('owner', 'UTC', db.deps());
  const draftResult = await holdPermit('cro-1', draft.id, { expectedVersion: draft.version, reason: 'x' }, db.deps());
  assert.deepEqual(draftResult, { outcome: 'conflict', reason: 'not_issued' });

  const held = await createHeldPermit(db);
  const alreadyHeldResult = await holdPermit(
    'cro-1',
    held.id,
    { expectedVersion: held.version, reason: 'x' },
    db.deps(),
  );
  assert.deepEqual(alreadyHeldResult, { outcome: 'conflict', reason: 'not_issued' });
});

test('holdPermit rejects a stale version', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const result = await holdPermit('cro-3', permit.id, { expectedVersion: permit.version + 1, reason: 'y' }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

// --- Resume ---

test('resumePermit: HELD -> ISSUED before the original midnight expiry, without touching issued_at/numbers', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);

  const result = await resumePermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'ISSUED');
  assert.equal(result.permit.held_by, null);
  assert.equal(result.permit.held_at, null);
  assert.equal(result.permit.hold_reason, null);
  // issued_at, and so the original midnight boundary, is untouched.
  assert.equal(result.permit.issued_at, held.issued_at);
  assert.equal(result.permit.permit_sequence, held.permit_sequence);
  assert.equal(result.permit.jsa_id, held.jsa_id);
  // No NEW HSE timer - resume doesn't touch these at all, so whatever
  // this permit already carried (its original real review window, from
  // when it was first forwarded to HSE, long before ever being held) is
  // exactly what it still carries - never cleared, never regenerated.
  assert.equal(result.permit.hse_review_started_at, held.hse_review_started_at);
  assert.equal(result.permit.hse_review_deadline_at, held.hse_review_deadline_at);

  const events = await getPermitLifecycleEvents(held.id, db.deps());
  const resumed = events.find((e) => e.event_type === 'RESUMED');
  assert.ok(resumed);
  assert.equal(resumed?.actor_user_id, 'cro-3');
  assert.equal(resumed?.from_status, 'HELD');
  assert.equal(resumed?.to_status, 'ISSUED');
});

test('resumePermit fails once the permit\'s midnight expiry has passed', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);
  const backdated = backdateIssuedAt(db, held, LONG_PAST_ISSUED_AT);

  const result = await resumePermit('cro-3', backdated.id, { expectedVersion: backdated.version }, db.deps());

  assert.deepEqual(result, { outcome: 'expired' });
});

test('resumePermit only applies from HELD (wrong state rejected)', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db);
  const result = await resumePermit('cro-1', issued.id, { expectedVersion: issued.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_held' });
});

test('resumePermit rejects a stale version', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);
  const result = await resumePermit('cro-3', held.id, { expectedVersion: held.version + 1 }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('a simulated resume-vs-close race cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);

  const [resumeResult, closeResult] = await Promise.all([
    resumePermit('cro-1', held.id, { expectedVersion: held.version }, db.deps()),
    closePermit('cro-2', held.id, { expectedVersion: held.version }, db.deps()),
  ]);

  const outcomes = [resumeResult.outcome, closeResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

test('a simulated resume-vs-cancel race cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);

  const [resumeResult, cancelResult] = await Promise.all([
    resumePermit('cro-1', held.id, { expectedVersion: held.version }, db.deps()),
    cancelPermit('cro-2', held.id, { expectedVersion: held.version }, db.deps()),
  ]);

  const outcomes = [resumeResult.outcome, cancelResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

test('a simulated hold-vs-close race (both racing from ISSUED) cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db);

  const [holdResult, closeResult] = await Promise.all([
    holdPermit('cro-1', issued.id, { expectedVersion: issued.version, reason: 'x' }, db.deps()),
    closePermit('cro-2', issued.id, { expectedVersion: issued.version }, db.deps()),
  ]);

  const outcomes = [holdResult.outcome, closeResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

test('a simulated hold-vs-cancel race (both racing from ISSUED) cannot produce both outcomes - exactly one wins', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db);

  const [holdResult, cancelResult] = await Promise.all([
    holdPermit('cro-1', issued.id, { expectedVersion: issued.version, reason: 'x' }, db.deps()),
    cancelPermit('cro-2', issued.id, { expectedVersion: issued.version }, db.deps()),
  ]);

  const outcomes = [holdResult.outcome, cancelResult.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

// --- Cancel ---

test('cancelPermit: ISSUED -> CANCELLED, permanently, recording the actor and an optional reason', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const result = await cancelPermit(
    'cro-2',
    permit.id,
    { expectedVersion: permit.version, reason: 'work no longer required' },
    db.deps(),
  );

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'CANCELLED');
  assert.equal(result.permit.cancelled_by, 'cro-2');
  assert.ok(result.permit.cancelled_at);
  assert.equal(result.permit.cancel_reason, 'work no longer required');
  assert.equal(result.permit.permit_sequence, permit.permit_sequence);
  assert.equal(result.permit.jsa_id, permit.jsa_id);

  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const cancelled = events.find((e) => e.event_type === 'CANCELLED');
  assert.ok(cancelled);
  assert.equal(cancelled?.from_status, 'ISSUED');
  assert.equal(cancelled?.to_status, 'CANCELLED');
});

test('cancelPermit: HELD -> CANCELLED also succeeds, and clears the (now-stale) hold columns', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);

  const result = await cancelPermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'CANCELLED');
  assert.equal(result.permit.held_by, null);
  assert.equal(result.permit.held_at, null);
  assert.equal(result.permit.hold_reason, null);

  const events = await getPermitLifecycleEvents(held.id, db.deps());
  const cancelled = events.find((e) => e.event_type === 'CANCELLED');
  assert.equal(cancelled?.from_status, 'HELD');
});

test('cancelPermit rejects every source status except ISSUED/HELD', async () => {
  const db = new FakeDb();

  const { permit: draft } = await createDraftPermit('owner', 'UTC', db.deps());
  assert.deepEqual(
    await cancelPermit('cro-1', draft.id, { expectedVersion: draft.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_cancellable' },
  );

  const pendingHse = await createPendingHsePermit(db, 'owner-2');
  assert.deepEqual(
    await cancelPermit('cro-1', pendingHse.id, { expectedVersion: pendingHse.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_cancellable' },
  );

  const closed = await createClosedPermit(db, 'owner-3');
  assert.deepEqual(
    await cancelPermit('cro-1', closed.id, { expectedVersion: closed.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_cancellable' },
  );
});

test('cancelPermit rejects a stale version', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const result = await cancelPermit('cro-2', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('a simulated concurrent double-cancel race has exactly one winner', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);

  const [first, second] = await Promise.all([
    cancelPermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps()),
    cancelPermit('cro-3', permit.id, { expectedVersion: permit.version }, db.deps()),
  ]);

  const outcomes = [first.outcome, second.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('conflict'));
});

test('a CANCELLED permit is immutable through every other mutation path', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const cancelled = await cancelPermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(cancelled.outcome, 'ok');
  if (cancelled.outcome !== 'ok') return;

  assert.deepEqual(
    await updateDraftPermit('owner', permit.id, { expectedVersion: cancelled.permit.version, company: 'SGRE' }, db.deps()),
    { outcome: 'conflict', reason: 'not_editable' },
  );
  assert.deepEqual(
    await submitPermit('owner', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_draft' },
  );
  assert.deepEqual(
    await forwardToHseReview('cro-1', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_pending_cro' },
  );
  assert.deepEqual(
    await hseApprove('hse-1', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_pending_hse' },
  );
  assert.deepEqual(
    await holdPermit('cro-1', permit.id, { expectedVersion: cancelled.permit.version, reason: 'x' }, db.deps()),
    { outcome: 'conflict', reason: 'not_issued' },
  );
  assert.deepEqual(
    await resumePermit('cro-1', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_held' },
  );
  assert.deepEqual(
    await closePermit('cro-1', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_closable' },
  );
  assert.deepEqual(
    await cancelPermit('cro-1', permit.id, { expectedVersion: cancelled.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_cancellable' },
  );
});

// --- Close (widened to also accept HELD) ---

test('closePermit: HELD -> CLOSED also succeeds, records the correct from_status, and clears the hold columns', async () => {
  const db = new FakeDb();
  const held = await createHeldPermit(db);

  const result = await closePermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'CLOSED');
  assert.equal(result.permit.held_by, null);
  assert.equal(result.permit.held_at, null);
  assert.equal(result.permit.hold_reason, null);

  const events = await getPermitLifecycleEvents(held.id, db.deps());
  const closedEvent = events.find((e) => e.event_type === PERMIT_CLOSED_EVENT_TYPE);
  assert.equal(closedEvent?.from_status, 'HELD');
});

test('closePermit still works from ISSUED directly (regression - the HELD path is additive, not a replacement)', async () => {
  const db = new FakeDb();
  const permit = await createIssuedPermit(db);
  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  const events = await getPermitLifecycleEvents(permit.id, db.deps());
  const closedEvent = events.find((e) => e.event_type === PERMIT_CLOSED_EVENT_TYPE);
  assert.equal(closedEvent?.from_status, 'ISSUED');
});

// --- Renewal ---

test('renewPermit: creates a brand-new ISSUED permit, same JSA, new Permit Number, linked via previous_permit_id, no HSE timer', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db, 'applicant-1');
  const backdated = backdateIssuedAt(db, closed, LONG_PAST_ISSUED_AT);

  const result = await renewPermit('cro-1', backdated.id, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'ISSUED');
  assert.notEqual(result.permit.id, backdated.id);
  assert.notEqual(result.permit.permit_sequence, backdated.permit_sequence);
  assert.equal(result.permit.jsa_id, backdated.jsa_id);
  assert.equal(result.jsa.id, backdated.jsa_id);
  assert.equal(result.permit.previous_permit_id, backdated.id);
  assert.equal(result.permit.created_by, backdated.created_by);
  assert.equal(result.permit.company, backdated.company);
  assert.equal(result.permit.site_timezone, backdated.site_timezone);
  assert.notEqual(result.permit.issued_at, backdated.issued_at);
  assert.ok(result.permit.issued_at);
  // No HSE review, no timer, for renewal.
  assert.equal(result.permit.hse_review_started_at, null);
  assert.equal(result.permit.hse_review_deadline_at, null);
  assert.equal(result.permit.submitted_at, null);

  const newEvents = await getPermitLifecycleEvents(result.permit.id, db.deps());
  assert.equal(newEvents.length, 1);
  assert.equal(newEvents[0]?.event_type, 'RENEWED');
  assert.equal(newEvents[0]?.from_status, null);
  assert.equal(newEvents[0]?.to_status, 'ISSUED');
  assert.equal(newEvents[0]?.actor_user_id, 'cro-1');
});

test('renewPermit never mutates the old permit - it remains CLOSED, same version, exact same row', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db, 'applicant-1');
  const backdated = backdateIssuedAt(db, closed, LONG_PAST_ISSUED_AT);
  const oldEventsBefore = await getPermitLifecycleEvents(backdated.id, db.deps());

  await renewPermit('cro-1', backdated.id, db.deps());

  const oldPermitAfter = await getPermitById(backdated.id, db.deps());
  assert.equal(oldPermitAfter?.status, 'CLOSED');
  assert.equal(oldPermitAfter?.version, backdated.version);
  const oldEventsAfter = await getPermitLifecycleEvents(backdated.id, db.deps());
  assert.equal(oldEventsAfter.length, oldEventsBefore.length, 'no new event should be recorded on the OLD permit');
});

test('renewPermit rejects a permit that is not CLOSED', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db);
  const result = await renewPermit('cro-1', issued.id, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_closed' });
});

test('renewPermit rejects renewal before the old permit\'s midnight expiry has passed', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db); // issued/closed "now" - not yet expired
  const result = await renewPermit('cro-1', closed.id, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_yet_expired' });
});

test('renewPermit rejects a nonexistent permit', async () => {
  const db = new FakeDb();
  const result = await renewPermit('cro-1', 'no-such-permit', db.deps());
  assert.deepEqual(result, { outcome: 'not_found' });
});

test('a simulated double-renewal race on the SAME old permit has exactly one winner', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db, 'applicant-1');
  const backdated = backdateIssuedAt(db, closed, LONG_PAST_ISSUED_AT);

  const [first, second] = await Promise.all([
    renewPermit('cro-1', backdated.id, db.deps()),
    renewPermit('cro-2', backdated.id, db.deps()),
  ]);

  const outcomes = [first.outcome, second.outcome];
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `expected exactly one winner, got: ${outcomes.join(', ')}`);
  assert.ok(
    outcomes.includes('conflict'),
    `expected the loser to see a conflict (already_renewed), got: ${outcomes.join(', ')}`,
  );
  const loser = first.outcome === 'ok' ? second : first;
  assert.deepEqual(loser, { outcome: 'conflict', reason: 'already_renewed' });
});

test('renewal numbering: concurrent renewals of DIFFERENT old permits each get a unique new Permit Number', async () => {
  const db = new FakeDb();
  const closedA = backdateIssuedAt(db, await createClosedPermit(db, 'applicant-a'), LONG_PAST_ISSUED_AT);
  const closedB = backdateIssuedAt(db, await createClosedPermit(db, 'applicant-b'), LONG_PAST_ISSUED_AT);

  const [resultA, resultB] = await Promise.all([
    renewPermit('cro-1', closedA.id, db.deps()),
    renewPermit('cro-1', closedB.id, db.deps()),
  ]);

  assert.equal(resultA.outcome, 'ok');
  assert.equal(resultB.outcome, 'ok');
  if (resultA.outcome !== 'ok' || resultB.outcome !== 'ok') return;
  assert.notEqual(resultA.permit.permit_sequence, resultB.permit.permit_sequence);
  assert.notEqual(resultA.permit.id, resultB.permit.id);
});

test('a renewed (new) permit is immediately closable/cancellable but never re-renewable/re-reviewable - normal status rules apply to it exactly like any other ISSUED permit', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db, 'applicant-1');
  const backdated = backdateIssuedAt(db, closed, LONG_PAST_ISSUED_AT);
  const renewed = await renewPermit('cro-1', backdated.id, db.deps());
  if (renewed.outcome !== 'ok') throw new Error('setup failed');

  // Cannot be "re-renewed" - it isn't CLOSED.
  assert.deepEqual(await renewPermit('cro-1', renewed.permit.id, db.deps()), {
    outcome: 'conflict',
    reason: 'not_closed',
  });
  // Cannot be forwarded/approved - it was never a review-pending permit.
  assert.deepEqual(
    await forwardToHseReview('cro-1', renewed.permit.id, { expectedVersion: renewed.permit.version }, db.deps()),
    { outcome: 'conflict', reason: 'not_pending_cro' },
  );
  // Ordinary ISSUED actions work normally on it.
  const held = await holdPermit(
    'cro-1',
    renewed.permit.id,
    { expectedVersion: renewed.permit.version, reason: 'x' },
    db.deps(),
  );
  assert.equal(held.outcome, 'ok');
});

// --- DB-authoritative time: application-server clock skew must never
// affect a midnight/expiry authorization decision (resumePermit,
// renewPermit, and - for completeness - the already-DB-computed HSE
// fallback-approve eligibility). Each test below deliberately fakes the
// application process's own `Date` (via node:test's `t.mock.timers`) to
// report a WRONG "now" - one that would flip the outcome if the
// production code ever read it - while independently controlling the
// fake database's own clock (`db.now`, what the FakeDb's `now() AS
// db_now`/`now()` SQL expressions actually return). The real service
// functions never call `new Date()`/`Date.now()` for these decisions
// any more, so the faked application clock must have zero effect; the
// outcome must track `db.now` alone. ---

const MIDNIGHT_TEST_ISSUED_AT = '2026-03-05T09:00:00.000Z'; // UTC site_timezone -> next midnight is 2026-03-06T00:00:00.000Z
const MIDNIGHT_TEST_EXPIRY = '2026-03-06T00:00:00.000Z';

test('resumePermit: DB time strictly BEFORE midnight succeeds, even while the application clock falsely reports being long AFTER midnight', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const held = await createHeldPermit(db);
  assert.equal(held.issued_at, MIDNIGHT_TEST_ISSUED_AT);

  db.now = new Date('2026-03-05T23:59:59.000Z'); // DB: strictly before midnight
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-10T00:00:00.000Z') }); // app clock: days after midnight
  try {
    const result = await resumePermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());
    assert.equal(result.outcome, 'ok');
  } finally {
    t.mock.timers.reset();
  }
});

test('resumePermit: DB time AT midnight is rejected, even while the application clock falsely reports being BEFORE midnight', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const held = await createHeldPermit(db);

  db.now = new Date(MIDNIGHT_TEST_EXPIRY); // DB: exactly at midnight
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-05T10:00:00.000Z') }); // app clock: hours before midnight
  try {
    const result = await resumePermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());
    assert.deepEqual(result, { outcome: 'expired' });
  } finally {
    t.mock.timers.reset();
  }
});

test('resumePermit: DB time AFTER midnight is rejected, even while the application clock falsely reports being BEFORE midnight', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const held = await createHeldPermit(db);

  db.now = new Date('2026-03-06T00:00:01.000Z'); // DB: just after midnight
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-05T10:00:00.000Z') }); // app clock: hours before midnight
  try {
    const result = await resumePermit('cro-3', held.id, { expectedVersion: held.version }, db.deps());
    assert.deepEqual(result, { outcome: 'expired' });
  } finally {
    t.mock.timers.reset();
  }
});

test('renewPermit: DB time strictly BEFORE expiry is rejected, even while the application clock falsely reports being AFTER expiry', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const closed = await createClosedPermit(db, 'applicant-1');
  assert.equal(closed.issued_at, MIDNIGHT_TEST_ISSUED_AT);

  db.now = new Date('2026-03-05T23:59:59.000Z'); // DB: strictly before expiry
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-10T00:00:00.000Z') }); // app clock: days after expiry
  try {
    const result = await renewPermit('cro-1', closed.id, db.deps());
    assert.deepEqual(result, { outcome: 'conflict', reason: 'not_yet_expired' });
  } finally {
    t.mock.timers.reset();
  }
});

test('renewPermit: DB time exactly AT expiry succeeds, even while the application clock falsely reports being BEFORE expiry', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const closed = await createClosedPermit(db, 'applicant-1');

  db.now = new Date(MIDNIGHT_TEST_EXPIRY); // DB: exactly at expiry
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-05T10:00:00.000Z') }); // app clock: hours before expiry
  try {
    const result = await renewPermit('cro-1', closed.id, db.deps());
    assert.equal(result.outcome, 'ok');
  } finally {
    t.mock.timers.reset();
  }
});

test('renewPermit: DB time AFTER expiry succeeds, even while the application clock falsely reports being BEFORE expiry', async (t) => {
  const db = new FakeDb();
  db.now = new Date(MIDNIGHT_TEST_ISSUED_AT);
  const closed = await createClosedPermit(db, 'applicant-1');

  db.now = new Date('2026-03-06T00:00:01.000Z'); // DB: just after expiry
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-05T10:00:00.000Z') }); // app clock: hours before expiry
  try {
    const result = await renewPermit('cro-1', closed.id, db.deps());
    assert.equal(result.outcome, 'ok');
  } finally {
    t.mock.timers.reset();
  }
});

test('croFallbackApprove: eligibility remains DB-authoritative even while the application clock falsely reports being before the deadline (verifies the same class of bug is NOT present here)', async (t) => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS); // DB: the 5-minute window has genuinely elapsed

  t.mock.timers.enable({ apis: ['Date'], now: new Date('2020-01-01T00:00:00.000Z') }); // app clock: long before the window even opened
  try {
    const result = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
    assert.equal(result.outcome, 'ok');
  } finally {
    t.mock.timers.reset();
  }
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
