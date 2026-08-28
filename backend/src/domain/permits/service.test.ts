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
  listOwnDrafts,
  listPermitsByStatus,
  PERMIT_CLOSED_EVENT_TYPE,
  renewPermit,
  resubmitPermit,
  resumePermit,
  submitPermit,
  updateDraftPermit,
  updateLinkedJsa,
  type UpdateDraftOutcome,
  type JsaRow,
  type PermitRow,
  type Company,
  type PermitsServiceDeps,
} from './service.js';
import { PERMIT_TYPES, type PermitType } from './forms.js';
import { toPermitNumber } from './numbering.js';
import {
  makeHotWorkForm,
  makeJsaFormColumns,
  makePermitFormColumns,
} from './formFixtures.test.js';
import { answeredJsaV2, answeredWtgPermitV2, blankJsaFormV2, blankPermitV2, partialPermitV2 } from '../../test/v2Forms.js';
import { ACTIVE_FORM_GENERATION, jsaFormVersionFor, permitFormVersionFor } from './formGeneration.js';
import type { SubmitOutcome } from './service.js';

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
  if (permit.status !== 'DRAFT' && (!permit.permit_type || !permit.form_version || !permit.form_payload)) {
    throw new Error(
      `simulated CHECK constraint violation: permits_form_required_after_draft (status=${permit.status}, permit_type=${permit.permit_type}, form_version=${permit.form_version})`,
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
  id: string;
  permit_id: string;
  event_type: string;
  actor_user_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  occurred_at: string;
}

/**
 * The four new tables this batch adds (migration 0013), simulated just
 * enough for `service.ts`'s workflow-side-effect wiring
 * (`domain/permits/workflowSideEffects.ts`) to run against `FakeDb`
 * exactly like it would against real Postgres - idempotent inserts via
 * the same conflict keys the real UNIQUE constraints enforce, and rolled
 * back together with everything else on a simulated transaction
 * failure. Deeper behavioral coverage of these tables' OWN modules lives
 * in their own dedicated test files (domain/notifications/*.test.ts,
 * domain/permits/documents.test.ts), which use their own lightweight
 * query stubs rather than this class.
 */
interface FakeNotification {
  id: string;
  recipient_user_id: string;
  permit_id: string | null;
  source_event_id: string;
  notification_type: string;
  title: string;
  message: string;
  created_at: string;
  read_at: string | null;
}

interface FakeWhatsappOutboxMessage {
  id: string;
  permit_id: string;
  source_event_id: string;
  event_type: string;
  payload: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempt_count: number;
  last_error: string | null;
  last_attempted_at: string | null;
  sent_at: string | null;
  created_at: string;
}

interface FakeIssuedDocumentSnapshot {
  id: string;
  permit_id: string;
  source_event_id: string;
  snapshot: unknown;
  snapshot_hash: string;
  created_at: string;
}

interface FakePermitDocumentJob {
  id: string;
  snapshot_id: string;
  status: 'PENDING' | 'GENERATED' | 'FAILED';
  storage_path: string | null;
  file_hash: string | null;
  generated_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

class FakeDb {
  permits = new Map<string, PermitRow>();
  jsas = new Map<string, JsaRow>();
  // Only rows that actually "committed" - unlike `queries` below, which
  // logs every attempted query regardless of outcome, this is emptied
  // back out on a simulated rollback (see `withTransaction`), so it's
  // what a later read would actually see.
  lifecycleEvents: FakeLifecycleEvent[] = [];
  // Capability -> the set of user ids who hold it, for
  // `resolveUserIdsWithCapabilities` (notification-recipient
  // resolution) - see `grantCapability` below. Deliberately NOT part of
  // the transaction rollback snapshot: granting a capability is test
  // fixture setup, never something a permit transition itself writes.
  capabilityAssignments = new Map<string, Set<string>>();
  zeroRecipientCapabilities = new Set<string>();
  notifications: FakeNotification[] = [];
  // Workforce signing identities (migration 0016). FIXTURE SHORTCUT:
  // any actor resolves to a derived default profile unless a test
  // explicitly overrides it (`setWorkforceProfile`) or explicitly
  // removes it (`removeWorkforceProfile`), so pre-existing workflow
  // tests - which are about transitions, not identity - need no setup,
  // while the fail-closed tests can still express "this user has no
  // profile" and "this user's primary assignment is not one they hold".
  workforceProfiles = new Map<string, {
    display_name: string;
    company_code: string;
    company_name: string;
    primary_team_position_id: string;
    team_name: string;
    position_name: string;
  }>();
  usersWithoutSigningIdentity = new Set<string>();
  permitSignatures: Array<{
    id: string;
    permit_id: string;
    source_event_id: string;
    signature_role: string;
    signer_user_id: string;
    signer_display_name: string;
    signer_team_position_id: string;
    signer_team_name: string;
    signer_position_name: string;
    signed_at: string;
    created_at: string;
  }> = [];
  whatsappOutbox: FakeWhatsappOutboxMessage[] = [];
  documentSnapshots: FakeIssuedDocumentSnapshot[] = [];
  documentJobs: FakePermitDocumentJob[] = [];
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
  private lifecycleEventCounter = 0;
  private notificationCounter = 0;
  private whatsappOutboxCounter = 0;
  private documentSnapshotCounter = 0;
  private documentJobCounter = 0;
  private signatureCounter = 0;

  /** Test fixture setup: gives `userId` an authoritative workforce signing identity. */
  setWorkforceProfile(
    userId: string,
    profile: { display_name: string; primary_team_position_id: string; team_name: string; position_name: string },
  ): void {
    this.workforceProfiles.set(userId, { company_code: 'E_SET', company_name: 'E-SET', ...profile });
  }

  /** Test fixture setup: removes a signing identity, so any signing action by that user must fail closed. Covers both "no profile row" and "the profile's primary assignment is not one this user holds" - the resolver's join returns no row either way. */
  removeWorkforceProfile(userId: string): void {
    this.workforceProfiles.delete(userId);
    this.usersWithoutSigningIdentity.add(userId);
  }

  /** Test fixture setup: restores the legacy "draft with no company recorded" state. */
  clearPermitCompany(permitId: string): void {
    const permit = this.permits.get(permitId);
    if (!permit) throw new Error(`FakeDb: no permit ${permitId}`);
    this.permits.set(permitId, { ...permit, company: null, company_other: null });
  }

  /** Test fixture setup: undoes the fake's draft-creation form shortcut, restoring the real "draft with no form yet" state. */
  clearPermitForm(permitId: string): void {
    const permit = this.permits.get(permitId);
    if (!permit) throw new Error(`FakeDb: no permit ${permitId}`);
    this.permits.set(permitId, {
      ...permit,
      form_payload: null,
      wind_farm: null,
      wtg_number: null,
      work_description: null,
      loto_number: null,
    });
  }

  /** Test fixture setup: undoes the fake's JSA-creation form shortcut. */
  clearJsaForm(jsaId: string): void {
    const jsa = this.jsas.get(jsaId);
    if (!jsa) throw new Error(`FakeDb: no jsa ${jsaId}`);
    this.jsas.set(jsaId, { ...jsa, form_version: null, form_payload: null, site_or_wtg: null, job_description: null });
  }

  /** Test fixture setup: grants `userId` a capability, for the notification-recipient-resolution queries `workflowSideEffects.ts` issues (`resolveCroRecipients`/`resolveHseRecipients`). Not a simulation of the real Team + Position -> Capabilities join - just enough surface for these tests. */
  grantCapability(userId: string, capability: string): void {
    const holders = this.capabilityAssignments.get(capability) ?? new Set<string>();
    holders.add(userId);
    this.capabilityAssignments.set(capability, holders);
  }

  denyRecipientsFor(...capabilities: string[]): void {
    for (const capability of capabilities) this.zeroRecipientCapabilities.add(capability);
  }

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
        // FIXTURE SHORTCUT: the real INSERT leaves the JSA form NULL
        // (it is filled by a later PATCH /permits/:id/jsa). Pre-filling
        // it here keeps every pre-existing workflow test - which is about
        // transitions, not form content - unchanged. Tests that need the
        // genuinely-incomplete case call `clearJsaForm`.
        ...makeJsaFormColumns(),
        created_at: this.now.toISOString(),
        updated_at: this.now.toISOString(),
      };
      this.jsas.set(jsa.id, jsa);
      return { rows: [jsa] };
    }
    if (sql.startsWith('INSERT INTO permits') && sql.includes('previous_permit_id')) {
      // renewPermit's INSERT - distinct column list/params shape from the
      // plain draft-creation INSERT below. Checked FIRST/more
      // specifically: both this and the plain-creation INSERT literally
      // start with "INSERT INTO permits", so order matters here.
      const [
        jsaId,
        createdBy,
        previousPermitId,
        siteTimezone,
        company,
        companyOther,
        applicantIdentityKind,
        applicantDisplayName,
        applicantCompanyCode,
        applicantCompanyName,
        permitType,
        formVersion,
        formPayloadJson,
        windFarm,
        wtgNumber,
        workDescription,
        lotoNumber,
      ] = params as [
        string,
        string,
        string,
        string,
        PermitRow['company'],
        string | null,
        PermitRow['applicant_identity_kind'],
        string | null,
        PermitRow['applicant_company_code'],
        string | null,
        PermitRow['permit_type'],
        PermitRow['form_version'],
        string,
        string | null,
        string | null,
        string | null,
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
        applicant_identity_kind: applicantIdentityKind,
        applicant_display_name: applicantDisplayName,
        applicant_company_code: applicantCompanyCode,
        applicant_company_name: applicantCompanyName,
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
        permit_type: permitType,
        form_version: formVersion,
        form_payload: JSON.parse(formPayloadJson) as PermitRow['form_payload'],
        wind_farm: windFarm,
        wtg_number: wtgNumber,
        work_description: workDescription,
        loto_number: lotoNumber,
        created_at: createdAt,
        updated_at: createdAt,
      };
      return { rows: [this.setPermit(permit)] };
    }
    if (sql.startsWith('INSERT INTO permits')) {
      const [jsaId, createdBy, siteTimezone, permitType, formVersion] = params as [
        string,
        string,
        string,
        NonNullable<PermitRow['permit_type']>,
        NonNullable<PermitRow['form_version']>,
      ];
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
        // FIXTURE SHORTCUT (see the jsas insert above): the real INSERT
        // stores only the type/version and leaves `form_payload` NULL.
        ...makePermitFormColumns(),
        permit_type: permitType,
        form_version: formVersion,
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
      this.lifecycleEventCounter += 1;
      const eventId = `event-${this.lifecycleEventCounter}`;
      this.lifecycleEvents.push({
        id: eventId,
        permit_id: permitId,
        event_type: eventType,
        actor_user_id: actorUserId,
        from_status: fromStatus,
        to_status: toStatus,
        reason: reason ?? null,
        occurred_at: this.now.toISOString(),
      });
      // Real Postgres only returns a row here when the caller's INSERT
      // has a RETURNING clause - matched the same way every other
      // RETURNING-vs-not branch in this fake would be, by what the real
      // SQL actually contains.
      return {
        rows: sql.includes('RETURNING')
          ? [{ id: eventId, event_type: eventType, actor_user_id: actorUserId, occurred_at: this.now.toISOString(), snapshot_taken_at: this.now.toISOString() }]
          : [],
      };
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
    if (sql.startsWith('UPDATE permits') && sql.includes('SET company') && sql.includes('form_payload')) {
      const [company, companyOther, formPayloadJson, windFarm, wtgNumber, workDescription, lotoNumber, id] =
        params as [string | null, string | null, string, string | null, string | null, string | null, string | null, string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        company: company as PermitRow['company'],
        company_other: companyOther,
        form_payload: JSON.parse(formPayloadJson) as PermitRow['form_payload'],
        wind_farm: windFarm,
        wtg_number: wtgNumber,
        work_description: workDescription,
        loto_number: lotoNumber,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
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
    if (sql.startsWith('UPDATE permits SET version = version + 1')) {
      // updateLinkedJsa's permit-version bump: the Permit + JSA are one
      // document under one optimistic-concurrency token.
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        version: existing.version + 1,
        updated_at: this.now.toISOString(),
      };
      return { rows: [this.setPermit(updated)] };
    }
    if (sql.startsWith('UPDATE jsas')) {
      const [formVersion, formPayloadJson, siteOrWtg, jobDescription, id] =
        params as [JsaRow['form_version'], string, string, string, string];
      const existing = this.jsas.get(id);
      if (!existing) return { rows: [] };
      const updated: JsaRow = {
        ...existing,
        form_version: formVersion,
        form_payload: JSON.parse(formPayloadJson) as JsaRow['form_payload'],
        site_or_wtg: siteOrWtg,
        job_description: jobDescription,
        updated_at: this.now.toISOString(),
      };
      this.jsas.set(id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith('SELECT form_payload FROM jsas WHERE id = $1')) {
      const [id] = params as [string];
      const jsa = this.jsas.get(id);
      return { rows: jsa ? [{ form_payload: jsa.form_payload }] : [] };
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
        ...(sql.includes('applicant_identity_kind') ? {
          company: (params[1] as PermitRow['company']),
          company_other: null,
          applicant_identity_kind: params[2] as 'NORMAL' | 'PRIVILEGED',
          applicant_display_name: params[3] as string,
          applicant_company_code: params[4] as 'E_SET' | 'ZPL' | 'SGRE',
          applicant_company_name: params[5] as string,
        } : {}),
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
            jsa_updated_at: jsa.updated_at,
            jsa_form_version: jsa.form_version,
            jsa_form_payload: jsa.form_payload,
            jsa_site_or_wtg: jsa.site_or_wtg,
            jsa_job_description: jsa.job_description,
          },
        ],
      };
    }
    if (!sql.startsWith('SELECT COUNT') && sql.includes('FROM permits WHERE created_by = $1 AND status <>')) {
      const [createdBy, limit, offset] = params as [string, number, number];
      const rows = [...this.permits.values()]
        .filter((p) => p.created_by === createdBy && p.status !== 'DRAFT')
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(offset, offset + limit);
      return { rows };
    }
    // My Drafts: the caller's own DRAFT permits only.
    if (!sql.startsWith('SELECT COUNT') && sql.includes("WHERE created_by = $1 AND status = 'DRAFT'")) {
      const [createdBy, limit, offset] = params as [string, number, number];
      const rows = [...this.permits.values()]
        .filter((p) => p.created_by === createdBy && p.status === 'DRAFT')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
        .slice(offset, offset + limit);
      return { rows };
    }
    if (sql.startsWith('SELECT COUNT') && sql.includes("WHERE created_by = $1 AND status = 'DRAFT'")) {
      const [createdBy] = params as [string];
      const count = [...this.permits.values()].filter((p) => p.created_by === createdBy && p.status === 'DRAFT').length;
      return { rows: [{ count: String(count) }] };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM permits WHERE created_by = $1')) {
      const [createdBy] = params as [string];
      const count = [...this.permits.values()].filter((p) => p.created_by === createdBy && p.status !== 'DRAFT').length;
      return { rows: [{ count: String(count) }] };
    }
    if (!sql.startsWith('SELECT COUNT') && sql.includes('FROM permits WHERE status = $1 ORDER BY')) {
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
        .map((e, index) => ({ ordinal: String(index + 1), ...e }));
      return { rows };
    }

    // --- Workforce signing identity + digital signatures (migration 0016) ---
    if (sql.includes('FROM privileged_access_events') && sql.includes('JOIN privileged_identities')) {
      return { rows: [] };
    }
    // Checked BEFORE recipient resolution below: both queries mention
    // `user_team_positions`, and this one is the more specific shape.
    if (sql.includes('FROM workforce_profiles')) {
      const [userId] = params as [string];
      if (this.usersWithoutSigningIdentity.has(userId)) return { rows: [] };
      const profile = this.workforceProfiles.get(userId) ?? {
        display_name: `Display Name of ${userId}`,
        company_code: 'E_SET',
        company_name: 'E-SET',
        primary_team_position_id: `tp-${userId}`,
        team_name: `Team of ${userId}`,
        position_name: `Position of ${userId}`,
      };
      return { rows: [profile] };
    }
    if (sql.startsWith('INSERT INTO permit_signatures')) {
      const [permitId, sourceEventId, role, signerUserId, displayName, teamPositionId, teamName, positionName] =
        params as [string, string, string, string, string, string, string, string];
      const event = this.lifecycleEvents.find((e) => e.id === sourceEventId);
      // Mirrors migration 0016's permit_signature_authenticity_guard: the
      // signer must BE the authenticated actor of the event, the event
      // must belong to the same permit, and the role must match the event
      // type that produced it.
      const rolePinnedToEvent =
        (role === 'APPLICANT' && (event?.event_type === 'SUBMITTED' || event?.event_type === 'APPLICANT_RESUBMITTED')) ||
        (role === 'CRO' && event?.event_type === 'CRO_FORWARDED_HSE') ||
        (role === 'HSE' && event?.event_type === 'HSE_APPROVED') ||
        (role === 'CRO_FALLBACK' && event?.event_type === 'CRO_FALLBACK_APPROVED') ||
        (role === 'RENEWAL' && event?.event_type === 'RENEWED');
      if (!event || event.permit_id !== permitId || event.actor_user_id !== signerUserId || !rolePinnedToEvent) {
        throw new Error(
          `simulated constraint trigger violation: permit_signature_authenticity_guard (role=${role}, event=${event?.event_type}, actor=${event?.actor_user_id}, signer=${signerUserId})`,
        );
      }
      this.signatureCounter += 1;
      const row = {
        id: `signature-${this.signatureCounter}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        signature_role: role,
        signer_user_id: signerUserId,
        signer_display_name: displayName,
        signer_team_position_id: teamPositionId,
        signer_team_name: teamName,
        signer_position_name: positionName,
        signed_at: this.now.toISOString(),
        created_at: this.now.toISOString(),
      };
      this.permitSignatures.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM permit_signatures s')) {
      const [permitId] = params as [string];
      const rows = this.permitSignatures.filter((r) => r.permit_id === permitId);
      return { rows };
    }
    if (sql.startsWith('SELECT id, snapshot, snapshot_hash FROM issued_document_snapshots')) {
      const [permitId] = params as [string];
      const row = this.documentSnapshots.find((sn) => sn.permit_id === permitId);
      return { rows: row ? [{ id: row.id, snapshot: row.snapshot, snapshot_hash: row.snapshot_hash }] : [] };
    }

    // --- Notification-recipient resolution (authz/capabilities.ts::resolveUserIdsWithCapabilities) ---
    if (sql.includes('FROM user_team_positions')) {
      const [capabilityNames] = params as [string[]];
      if (capabilityNames.some((capability) => this.zeroRecipientCapabilities.has(capability))) return { rows: [] };
      const userIds = new Set<string>();
      for (const capability of capabilityNames) {
        for (const userId of this.capabilityAssignments.get(capability) ?? []) userIds.add(userId);
      }
      if (userIds.size === 0) {
        userIds.add(capabilityNames.includes('permit.hse_review') ? 'default-hse-recipient' : 'default-cro-recipient');
      }
      return { rows: [...userIds].map((user_id) => ({ user_id })) };
    }

    // --- Notifications (domain/notifications/service.ts) ---
    if (sql.startsWith('INSERT INTO notifications')) {
      const [recipientUserId, permitId, sourceEventId, notificationType, title, message] = params as [
        string,
        string | null,
        string,
        string,
        string,
        string,
      ];
      const alreadyExists = this.notifications.some(
        (n) => n.source_event_id === sourceEventId && n.recipient_user_id === recipientUserId,
      );
      if (alreadyExists) return { rows: [] }; // ON CONFLICT (source_event_id, recipient_user_id) DO NOTHING
      this.notificationCounter += 1;
      const row: FakeNotification = {
        id: `notification-${this.notificationCounter}`,
        recipient_user_id: recipientUserId,
        permit_id: permitId,
        source_event_id: sourceEventId,
        notification_type: notificationType,
        title,
        message,
        created_at: this.now.toISOString(),
        read_at: null,
      };
      this.notifications.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2')) {
      const [id, recipientUserId] = params as [string, string];
      const row = this.notifications.find((n) => n.id === id && n.recipient_user_id === recipientUserId);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('UPDATE notifications SET read_at')) {
      const [id, recipientUserId] = params as [string, string];
      const index = this.notifications.findIndex((n) => n.id === id && n.recipient_user_id === recipientUserId);
      if (index === -1) return { rows: [] };
      const updated: FakeNotification = { ...this.notifications[index]!, read_at: this.now.toISOString() };
      this.notifications[index] = updated;
      return { rows: [updated] };
    }
    if (sql.startsWith('SELECT * FROM notifications WHERE recipient_user_id')) {
      const [recipientUserId, pageSize, offset] = params as [string, number, number];
      const unreadOnly = sql.includes('read_at IS NULL');
      const rows = this.notifications
        .filter((n) => n.recipient_user_id === recipientUserId && (!unreadOnly || n.read_at === null))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(offset, offset + pageSize);
      return { rows };
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM notifications WHERE recipient_user_id')) {
      const [recipientUserId] = params as [string];
      const unreadOnly = sql.includes('read_at IS NULL');
      const count = this.notifications.filter(
        (n) => n.recipient_user_id === recipientUserId && (!unreadOnly || n.read_at === null),
      ).length;
      return { rows: [{ count: String(count) }] };
    }

    // --- WhatsApp outbox (domain/notifications/whatsappOutbox.ts) ---
    if (sql.startsWith('INSERT INTO whatsapp_outbox_messages')) {
      const [permitId, sourceEventId, eventType, payload] = params as [string, string, string, string];
      const alreadyExists = this.whatsappOutbox.some((m) => m.source_event_id === sourceEventId);
      if (alreadyExists) return { rows: [] }; // ON CONFLICT (source_event_id) DO NOTHING
      this.whatsappOutboxCounter += 1;
      const row: FakeWhatsappOutboxMessage = {
        id: `outbox-${this.whatsappOutboxCounter}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        event_type: eventType,
        payload,
        status: 'PENDING',
        attempt_count: 0,
        last_error: null,
        last_attempted_at: null,
        sent_at: null,
        created_at: this.now.toISOString(),
      };
      this.whatsappOutbox.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT * FROM whatsapp_outbox_messages WHERE status IN')) {
      const [limit] = params as [number];
      const rows = this.whatsappOutbox
        .filter((m) => m.status === 'PENDING' || m.status === 'FAILED')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit);
      return { rows };
    }
    if (sql.startsWith('UPDATE whatsapp_outbox_messages') && sql.includes("status = 'SENT'")) {
      const [id] = params as [string];
      const index = this.whatsappOutbox.findIndex((m) => m.id === id);
      if (index !== -1) {
        const existing = this.whatsappOutbox[index]!;
        this.whatsappOutbox[index] = {
          ...existing,
          status: 'SENT',
          sent_at: this.now.toISOString(),
          last_attempted_at: this.now.toISOString(),
          attempt_count: existing.attempt_count + 1,
          last_error: null,
        };
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE whatsapp_outbox_messages') && sql.includes("status = 'FAILED'")) {
      const [id, lastError] = params as [string, string];
      const index = this.whatsappOutbox.findIndex((m) => m.id === id);
      if (index !== -1) {
        const existing = this.whatsappOutbox[index]!;
        this.whatsappOutbox[index] = {
          ...existing,
          status: 'FAILED',
          last_attempted_at: this.now.toISOString(),
          attempt_count: existing.attempt_count + 1,
          last_error: lastError,
        };
      }
      return { rows: [] };
    }

    // --- Immutable issued-document snapshot + PDF job (domain/permits/documents.ts) ---
    if (sql.startsWith('INSERT INTO issued_document_snapshots')) {
      const [permitId, sourceEventId, snapshotJson, snapshotHash] = params as [string, string, string, string];
      const alreadyExists = this.documentSnapshots.some((s) => s.permit_id === permitId);
      if (alreadyExists) return { rows: [] }; // ON CONFLICT (permit_id) DO NOTHING
      this.documentSnapshotCounter += 1;
      const row: FakeIssuedDocumentSnapshot = {
        id: `snapshot-${this.documentSnapshotCounter}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        snapshot: JSON.parse(snapshotJson) as unknown,
        snapshot_hash: snapshotHash,
        created_at: this.now.toISOString(),
      };
      this.documentSnapshots.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith('SELECT id FROM issued_document_snapshots WHERE permit_id = $1')) {
      const [permitId] = params as [string];
      const row = this.documentSnapshots.find((s) => s.permit_id === permitId);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (sql.startsWith('INSERT INTO permit_document_jobs')) {
      const [snapshotId] = params as [string];
      const alreadyExists = this.documentJobs.some((j) => j.snapshot_id === snapshotId);
      if (alreadyExists) return { rows: [] }; // ON CONFLICT (snapshot_id) DO NOTHING
      this.documentJobCounter += 1;
      const row: FakePermitDocumentJob = {
        id: `job-${this.documentJobCounter}`,
        snapshot_id: snapshotId,
        status: 'PENDING',
        storage_path: null,
        file_hash: null,
        generated_at: null,
        attempt_count: 0,
        last_error: null,
        created_at: this.now.toISOString(),
        updated_at: this.now.toISOString(),
      };
      this.documentJobs.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO issued_document_snapshot_integrity')) return { rows: [] };
    if (sql.startsWith('SELECT s.*, j.id AS job_id')) {
      const [permitId] = params as [string];
      const snapshot = this.documentSnapshots.find((s) => s.permit_id === permitId);
      if (!snapshot) return { rows: [] };
      const job = this.documentJobs.find((j) => j.snapshot_id === snapshot.id);
      if (!job) return { rows: [] };
      return {
        rows: [
          {
            ...snapshot,
            job_id: job.id,
            job_status: job.status,
            job_storage_path: job.storage_path,
            job_file_hash: job.file_hash,
            job_generated_at: job.generated_at,
            job_attempt_count: job.attempt_count,
            job_last_error: job.last_error,
            job_created_at: job.created_at,
            job_updated_at: job.updated_at,
          },
        ],
      };
    }
    if (sql.startsWith('SELECT j.id, j.snapshot_id, s.snapshot, s.permit_id')) {
      const [limit] = params as [number];
      const rows = this.documentJobs
        .filter((j) => j.status === 'PENDING' || j.status === 'FAILED')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((j) => {
          const snapshot = this.documentSnapshots.find((s) => s.id === j.snapshot_id);
          if (!snapshot) throw new Error(`FakeDb: document job ${j.id} has no matching snapshot`);
          return { id: j.id, snapshot_id: j.snapshot_id, snapshot: snapshot.snapshot, permit_id: snapshot.permit_id };
        });
      return { rows };
    }
    if (sql.startsWith('UPDATE permit_document_jobs') && sql.includes("status = 'GENERATED'")) {
      const [id, storagePath, fileHash] = params as [string, string, string];
      const index = this.documentJobs.findIndex((j) => j.id === id);
      if (index !== -1) {
        const existing = this.documentJobs[index]!;
        this.documentJobs[index] = {
          ...existing,
          status: 'GENERATED',
          storage_path: storagePath,
          file_hash: fileHash,
          generated_at: this.now.toISOString(),
          attempt_count: existing.attempt_count + 1,
          last_error: null,
          updated_at: this.now.toISOString(),
        };
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE permit_document_jobs') && sql.includes("status = 'FAILED'")) {
      const [id, lastError] = params as [string, string];
      const index = this.documentJobs.findIndex((j) => j.id === id);
      if (index !== -1) {
        const existing = this.documentJobs[index]!;
        this.documentJobs[index] = {
          ...existing,
          status: 'FAILED',
          attempt_count: existing.attempt_count + 1,
          last_error: lastError,
          updated_at: this.now.toISOString(),
        };
      }
      return { rows: [] };
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
      const jsasSnapshot = new Map(this.jsas);
      const signaturesSnapshot = [...this.permitSignatures];
      const lifecycleEventsSnapshot = [...this.lifecycleEvents];
      const notificationsSnapshot = [...this.notifications];
      const whatsappOutboxSnapshot = [...this.whatsappOutbox];
      const documentSnapshotsSnapshot = [...this.documentSnapshots];
      const documentJobsSnapshot = [...this.documentJobs];
      try {
        return await fn({ query });
      } catch (err) {
        this.permits = permitsSnapshot;
        this.jsas = jsasSnapshot;
        this.permitSignatures = signaturesSnapshot;
        this.lifecycleEvents = lifecycleEventsSnapshot;
        this.notifications = notificationsSnapshot;
        this.whatsappOutbox = whatsappOutboxSnapshot;
        this.documentSnapshots = documentSnapshotsSnapshot;
        this.documentJobs = documentJobsSnapshot;
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

/**
 * Fills a draft with a COMPLETE authoritative document.
 *
 * New drafts are created in the active generation (V2), and a V2 permit
 * may not be submitted while any printed safety question is unanswered -
 * that refusal is the point of the contract. So every helper that drives
 * a permit past DRAFT has to answer the form first, exactly as an
 * applicant would. The payloads come from the catalogue, so they stay
 * complete as the forms change.
 */
async function fillDraftForSubmission(
  db: FakeDb,
  actorUserId: string,
  permitId: string,
  version: number,
  company: { company: Company; companyOther?: string } = { company: 'ESET' },
): Promise<UpdateDraftOutcome> {
  const updated = await updateDraftPermit(
    actorUserId,
    permitId,
    { expectedVersion: version, ...company, form: answeredWtgPermitV2() },
    db.deps(),
  );
  if (updated.outcome !== 'ok') return updated;
  const jsa = await updateLinkedJsa(
    actorUserId,
    permitId,
    { expectedVersion: updated.permit.version, form: answeredJsaV2() },
    db.deps(),
  );
  if (jsa.outcome !== 'ok') throw new Error('setup failed: updateLinkedJsa');
  // The permit row AFTER both writes, so the caller version token is current.
  return { outcome: 'ok', permit: jsa.permit };
}

/** Drives a fresh permit through DRAFT -> PENDING_CRO -> PENDING_HSE for tests that start from PENDING_HSE. */
async function createPendingHsePermit(db: FakeDb, actorUserId = 'owner'): Promise<PermitRow> {
  const { permit } = await createDraftPermit(actorUserId, 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, actorUserId, permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit(actorUserId, permit.id, { expectedVersion: ready.permit.version }, db.deps());
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
  const first = await createDraftPermit('user-1', 'UTC', 'WTG_WORK', db.deps());
  const second = await createDraftPermit('user-1', 'UTC', 'WTG_WORK', db.deps());

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
    Array.from({ length: 10 }, () => createDraftPermit('user-1', 'UTC', 'WTG_WORK', db.deps())),
  );
  const permitSequences = results.map((r) => r.permit.permit_sequence);
  const jsaSequences = results.map((r) => r.jsa.jsa_sequence);
  assert.equal(new Set(permitSequences).size, permitSequences.length);
  assert.equal(new Set(jsaSequences).size, jsaSequences.length);
});

test('getOwnPermit returns null for a permit that exists but belongs to someone else (no existence leak)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const asOwner = await getOwnPermit('owner', permit.id, db.deps());
  const asOther = await getOwnPermit('someone-else', permit.id, db.deps());
  const missing = await getOwnPermit('owner', 'no-such-id', db.deps());

  assert.equal(asOwner?.id, permit.id);
  assert.equal(asOther, null);
  assert.equal(missing, null);
});

test('updateDraftPermit rejects a stale version instead of silently overwriting', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');

  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: ready.permit.version + 1, company: 'SGRE' },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_editable' });
});

test('submitPermit derives and freezes applicant company when the legacy draft company is missing', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  // The document is complete, but the legacy `company` column is not set -
  // which is the thing under test, so it is cleared after filling.
  const ready = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  db.clearPermitCompany(permit.id);

  const result = await submitPermit('owner', permit.id, { expectedVersion: ready.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome === 'ok') {
    assert.equal(result.permit.applicant_company_code, 'E_SET');
    assert.equal(result.permit.company, 'ESET');
  }
});

test('submitPermit requires companyOther when company is OTHER before allowing submission', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version, {
    company: 'OTHER',
    companyOther: 'Acme Contracting',
  });
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;

  const result = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
});

test('submitPermit performs the only implemented transition, DRAFT -> PENDING_CRO, once the required field is set', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  await submitPermit('owner', permit.id, { expectedVersion: ready.permit.version }, db.deps());

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  await submitPermit('owner', permit.id, { expectedVersion: ready.permit.version }, db.deps());

  const insertedEvents = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(insertedEvents.length, 2);
  assert.deepEqual(insertedEvents[0]?.params, [permit.id, 'CREATED', 'owner', null, 'DRAFT']);
  assert.deepEqual(insertedEvents[1]?.params, [permit.id, 'SUBMITTED', 'owner', 'DRAFT', 'PENDING_CRO']);
});

test('an event/status pair outside the allowed set is rejected (simulated DB CHECK constraint)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const result = await forwardToHseReview('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_cro' });
});

test('forwardToHseReview rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

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
    // Reads are fine (the signature lookup joins this table); what must
    // never appear is a mutation of an already-recorded event.
    assert.ok(
      q.sql.startsWith('INSERT INTO permit_lifecycle_events') || q.sql.startsWith('SELECT'),
      `expected only INSERTs/SELECTs against permit_lifecycle_events, got: ${q.sql}`,
    );
    assert.ok(
      !/(UPDATE|DELETE|TRUNCATE)[^a-zA-Z]*permit_lifecycle_events/i.test(q.sql),
      `expected no mutation of permit_lifecycle_events, got: ${q.sql}`,
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const result = await closePermit('cro-2', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_closable' });
});

test('closePermit rejects a PENDING_CRO permit (wrong state rejected)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
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
    ...makePermitFormColumns(),
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
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
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
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const result = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_cro' });
});

test('croSendBackToApplicant rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());

  const result = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('the applicant CAN edit a PENDING_CORRECTION permit (updateDraftPermit widened beyond DRAFT)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
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
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
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
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const result = await resubmitPermit('applicant-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_pending_correction' });
});

test('resubmitPermit rejects a stale version', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());

  const result = await resubmitPermit('applicant-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
});

test('resubmitPermit rejects when the frozen applicant identity is missing', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant(
    'cro-1',
    permit.id,
    { expectedVersion: submitted.permit.version },
    db.deps(),
  );
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');
  db.permits.set(permit.id, { ...sentBack.permit, applicant_identity_kind: null });

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
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
  const { permit: draft } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
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

  const { permit: draft } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
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
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  db.queries = [];

  await getPermitById(permit.id, db.deps());

  assert.equal(
    db.queries.some((q) => q.sql.includes('jsas')),
    false,
  );
});

test('getJsaById returns the JSA for a permit\'s jsa_id', async () => {
  const db = new FakeDb();
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const found = await getJsaById(permit.jsa_id, db.deps());

  assert.deepEqual(found, jsa);
});

test('getJsaById throws for an id with no matching row (FK-guaranteed invariant, not a normal not-found)', async () => {
  const db = new FakeDb();
  await assert.rejects(() => getJsaById('no-such-jsa', db.deps()));
});

const DEFAULT_PAGE = { page: 1, pageSize: 20 };

test('listOwnPermits returns only the given user\'s non-DRAFT records, most recent first', async () => {
  const db = new FakeDb();
  const first = await createDraftPermit('owner-a', 'UTC', 'WTG_WORK', db.deps());
  const second = await createDraftPermit('owner-a', 'UTC', 'WTG_WORK', db.deps());
  await createDraftPermit('owner-b', 'UTC', 'WTG_WORK', db.deps());
  db.permits.get(first.permit.id)!.status = 'PENDING_CRO';
  db.permits.get(second.permit.id)!.status = 'ISSUED';

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
    const created = await createDraftPermit('owner-a', 'UTC', 'WTG_WORK', db.deps());
    db.permits.get(created.permit.id)!.status = 'PENDING_CRO';
  }
  await createDraftPermit('owner-b', 'UTC', 'WTG_WORK', db.deps());

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

test('a PARTIALLY completed permit submits to the CRO - blank printed questions do not block it', async () => {
  // The business rule: the authoritative forms cover every job the
  // company does, so most questions do not apply to any given one.
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const saved = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET', form: partialPermitV2('WTG_WORK') },
    db.deps(),
  );
  assert.equal(saved.outcome, 'ok');
  if (saved.outcome !== 'ok') return;
  const jsa = await updateLinkedJsa('owner', permit.id, { expectedVersion: saved.permit.version, form: blankJsaFormV2() }, db.deps());
  assert.equal(jsa.outcome, 'ok');
  if (jsa.outcome !== 'ok') return;

  const submitted = await submitPermit('owner', permit.id, { expectedVersion: jsa.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok', 'a partially completed permit must reach the CRO');
  if (submitted.outcome !== 'ok') return;
  assert.equal(submitted.permit.status, 'PENDING_CRO');

  // What the applicant left blank is still blank on the submitted record -
  // nothing was defaulted, and no answer was invented.
  const stored = db.permits.get(permit.id)!.form_payload as unknown as { sections: Record<string, Record<string, { response: string | null }>> };
  const answers = Object.values(stored.sections).flatMap((section) => Object.values(section));
  assert.ok(answers.some((answer) => answer.response === null), 'blanks survived submission');
});

test('an EMPTY permit cannot be submitted by accident', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'COLD_WORK', db.deps());
  const saved = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET', form: blankPermitV2('COLD_WORK') },
    db.deps(),
  );
  assert.equal(saved.outcome, 'ok', 'an empty draft still SAVES');
  if (saved.outcome !== 'ok') return;
  const jsa = await updateLinkedJsa('owner', permit.id, { expectedVersion: saved.permit.version, form: blankJsaFormV2() }, db.deps());
  if (jsa.outcome !== 'ok') throw new Error('setup failed');

  const submitted = await submitPermit('owner', permit.id, { expectedVersion: jsa.permit.version }, db.deps());
  assert.deepEqual(submitted, { outcome: 'invalid', reason: 'empty_submission' });
  assert.equal(db.permits.get(permit.id)!.status, 'DRAFT', 'the refusal changed nothing');
});

test('every V2 permit type accepts a partial draft and a partial submission', async () => {
  for (const permitType of PERMIT_TYPES) {
    const db = new FakeDb();
    const { permit } = await createDraftPermit('owner', 'UTC', permitType, db.deps());
    const saved = await updateDraftPermit(
      'owner',
      permit.id,
      { expectedVersion: permit.version, company: 'ESET', form: partialPermitV2(permitType) },
      db.deps(),
    );
    assert.equal(saved.outcome, 'ok', `${permitType}: a partial draft must save`);
    if (saved.outcome !== 'ok') return;
    const jsa = await updateLinkedJsa('owner', permit.id, { expectedVersion: saved.permit.version, form: blankJsaFormV2() }, db.deps());
    if (jsa.outcome !== 'ok') throw new Error(`${permitType}: JSA setup failed`);

    const submitted = await submitPermit('owner', permit.id, { expectedVersion: jsa.permit.version }, db.deps());
    assert.equal(submitted.outcome, 'ok', `${permitType}: a partial permit must submit`);
  }
});


test('listOwnPermits excludes an owner\'s DRAFT while listOwnDrafts includes exactly that own draft', async () => {
  const db = new FakeDb();
  const ownDraft = await createDraftPermit('owner-a', 'UTC', 'WTG_WORK', db.deps());
  await createDraftPermit('owner-b', 'UTC', 'WTG_WORK', db.deps());

  const records = await listOwnPermits('owner-a', DEFAULT_PAGE, db.deps());
  const drafts = await listOwnDrafts('owner-a', DEFAULT_PAGE, db.deps());
  assert.deepEqual(records.items, []);
  assert.deepEqual(drafts.items.map((permit) => permit.id), [ownDraft.permit.id]);
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
  const created = await createDraftPermit('owner-a', 'UTC', 'WTG_WORK', db.deps());
  // A formal record, not a draft - listOwnPermits is the record list now.
  db.permits.get(created.permit.id)!.status = 'PENDING_CRO';
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
  await createDraftPermit('owner-b', 'UTC', 'WTG_WORK', db.deps());

  const page = await listPermitsByStatus('PENDING_HSE', DEFAULT_PAGE, db.deps());

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, pendingHse.id);
});

test('listPermitsByStatus: pagination metadata is accurate and ordering is oldest-first (FIFO) across pages', async () => {
  const db = new FakeDb();
  const permits = [];
  for (let i = 0; i < 3; i += 1) {
    const { permit } = await createDraftPermit('someone', 'UTC', 'WTG_WORK', db.deps());
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
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  await submitPermit('owner', permit.id, { expectedVersion: ready.permit.version }, db.deps());

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

// --- Workflow side effects: notifications, WhatsApp outbox, immutable issued-document snapshots ---
//
// These prove `service.ts` actually WIRES `workflowSideEffects.ts` into
// every relevant transition, atomically with it (same simulated
// transaction, same FakeDb rollback). Deeper behavioral coverage of the
// notification/outbox/document MODULES themselves (idempotency, payload
// content, recipient de-duplication, PDF generation, storage adapters)
// lives in their own dedicated test files
// (domain/notifications/*.test.ts, domain/permits/documents.test.ts).

test('submitPermit notifies every CRO-capability holder, de-duplicated across multiple capabilities', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  db.grantCapability('cro-a', 'permit.forward_hse'); // same person, two CRO capabilities
  db.grantCapability('cro-b', 'permit.hold');

  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');

  const recipients = db.notifications.filter((n) => n.permit_id === permit.id).map((n) => n.recipient_user_id);
  assert.deepEqual(recipients.sort(), ['cro-a', 'cro-b']);
  assert.equal(db.notifications.filter((n) => n.notification_type === 'PERMIT_SUBMITTED').length, 2);
});

test('resubmitPermit notifies CRO recipients with a distinct notification type from the original submission', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.close');
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant('cro-a', permit.id, { expectedVersion: submitted.permit.version }, db.deps());
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');

  const resubmitted = await resubmitPermit('applicant-1', permit.id, { expectedVersion: sentBack.permit.version }, db.deps());
  assert.equal(resubmitted.outcome, 'ok');

  const types = db.notifications.filter((n) => n.permit_id === permit.id).map((n) => n.notification_type);
  assert.ok(types.includes('PERMIT_SENT_BACK_FOR_CORRECTION'));
  assert.ok(types.includes('PERMIT_RESUBMITTED'));
});

test('forwardToHseReview notifies every HSE-capability holder', async () => {
  const db = new FakeDb();
  db.grantCapability('hse-a', 'permit.hse_review');
  const pendingCro = await (async () => {
    const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
    const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
    if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
    const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
    if (submitted.outcome !== 'ok') throw new Error('setup failed');
    return submitted.permit;
  })();

  const forwarded = await forwardToHseReview('cro-1', pendingCro.id, { expectedVersion: pendingCro.version }, db.deps());
  assert.equal(forwarded.outcome, 'ok');

  const hseNotifications = db.notifications.filter((n) => n.notification_type === 'PERMIT_FORWARDED_HSE');
  assert.equal(hseNotifications.length, 1);
  assert.equal(hseNotifications[0]?.recipient_user_id, 'hse-a');
});

test('hseApprove issuance: notifies the applicant AND every CRO recipient, creates the immutable issued-document snapshot, its PDF job, and the ISSUED WhatsApp outbox message - all atomically', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  const pending = await createPendingHsePermit(db, 'applicant-1');

  const approved = await hseApprove('hse-1', pending.id, { expectedVersion: pending.version }, db.deps());
  assert.equal(approved.outcome, 'ok');
  if (approved.outcome !== 'ok') return;

  const issuedNotifications = db.notifications.filter((n) => n.notification_type === 'PERMIT_ISSUED');
  assert.deepEqual(
    issuedNotifications.map((n) => n.recipient_user_id).sort(),
    ['applicant-1', 'cro-a'],
  );

  assert.equal(db.documentSnapshots.length, 1);
  assert.equal(db.documentSnapshots[0]?.permit_id, approved.permit.id);
  const snapshot = db.documentSnapshots[0]?.snapshot as {
    issuanceEventId: string; issuanceEventType: string; issuanceActorUserId: string; issuanceOccurredAt: string;
    snapshotTakenAt: string; issuedAt: string;
  };
  const issuanceEvent = db.lifecycleEvents.find((event) => event.event_type === 'HSE_APPROVED');
  assert.equal(snapshot.issuanceEventId, issuanceEvent?.id);
  assert.equal(snapshot.issuanceEventType, 'HSE_APPROVED');
  assert.equal(snapshot.issuanceActorUserId, 'hse-1');
  assert.equal(snapshot.issuanceOccurredAt, issuanceEvent?.occurred_at);
  assert.equal(snapshot.snapshotTakenAt, issuanceEvent?.occurred_at);
  assert.equal(snapshot.issuedAt, db.now.toISOString());
  assert.equal(db.documentJobs.length, 1);
  assert.equal(db.documentJobs[0]?.status, 'PENDING');

  const outboxMessages = db.whatsappOutbox.filter((m) => m.permit_id === approved.permit.id);
  assert.equal(outboxMessages.length, 1);
  assert.equal(outboxMessages[0]?.event_type, 'ISSUED');
});

test('croFallbackApprove issuance creates the same set of side effects as hseApprove', async () => {
  const db = new FakeDb();
  const pending = await createPendingHsePermit(db, 'applicant-1');
  db.advanceTime(5 * 60 * 1000 + 1);

  const approved = await croFallbackApprove('cro-1', pending.id, { expectedVersion: pending.version }, db.deps());
  assert.equal(approved.outcome, 'ok');
  if (approved.outcome !== 'ok') return;

  assert.equal(db.documentSnapshots.length, 1);
  assert.equal(db.whatsappOutbox.filter((m) => m.event_type === 'ISSUED').length, 1);
});

test('holdPermit: the WhatsApp outbox message includes the mandatory hold reason', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db, 'applicant-1');

  const held = await holdPermit('cro-1', issued.id, { expectedVersion: issued.version, reason: 'unsafe wind conditions' }, db.deps());
  assert.equal(held.outcome, 'ok');

  const message = db.whatsappOutbox.find((m) => m.event_type === 'HELD');
  assert.ok(message);
  const payload = JSON.parse(message!.payload) as { holdReason?: string };
  assert.equal(payload.holdReason, 'unsafe wind conditions');

  const notification = db.notifications.find((n) => n.notification_type === 'PERMIT_HELD');
  assert.equal(notification?.recipient_user_id, 'applicant-1');
});

test('resumePermit, cancelPermit, and closePermit each notify the applicant and enqueue their own WhatsApp outbox event', async () => {
  const heldDb = new FakeDb();
  const held = await createHeldPermit(heldDb, 'applicant-1');
  const resumed = await resumePermit('cro-1', held.id, { expectedVersion: held.version }, heldDb.deps());
  assert.equal(resumed.outcome, 'ok');
  assert.equal(heldDb.notifications.find((n) => n.notification_type === 'PERMIT_RESUMED')?.recipient_user_id, 'applicant-1');
  assert.equal(heldDb.whatsappOutbox.filter((m) => m.event_type === 'RESUMED').length, 1);

  const cancelDb = new FakeDb();
  const toCancel = await createIssuedPermit(cancelDb, 'applicant-1');
  const cancelled = await cancelPermit('cro-1', toCancel.id, { expectedVersion: toCancel.version, reason: 'no longer needed' }, cancelDb.deps());
  assert.equal(cancelled.outcome, 'ok');
  assert.equal(cancelDb.notifications.find((n) => n.notification_type === 'PERMIT_CANCELLED')?.recipient_user_id, 'applicant-1');
  assert.equal(cancelDb.whatsappOutbox.filter((m) => m.event_type === 'CANCELLED').length, 1);

  const closeDb = new FakeDb();
  const toClose = await createIssuedPermit(closeDb, 'applicant-1');
  const closed = await closePermit('cro-1', toClose.id, { expectedVersion: toClose.version }, closeDb.deps());
  assert.equal(closed.outcome, 'ok');
  assert.equal(closeDb.notifications.find((n) => n.notification_type === 'PERMIT_CLOSED')?.recipient_user_id, 'applicant-1');
  assert.equal(closeDb.whatsappOutbox.filter((m) => m.event_type === 'CLOSED').length, 1);
});

test('renewPermit: notifies the applicant with the NEW Permit Number, creates a NEW snapshot for the new permit, and never touches the old permit\'s own snapshot', async () => {
  const db = new FakeDb();
  const closed = await createClosedPermit(db, 'applicant-1');
  const backdated = backdateIssuedAt(db, closed, '2020-01-01T00:00:00.000Z');
  db.now = new Date('2020-01-02T00:00:00.000Z');

  // The old permit gets its own issued-document snapshot too, exactly
  // like any other issued permit - renewal must never touch it.
  const oldPendingHse = await createPendingHsePermit(db, 'other-applicant');
  const oldApproved = await hseApprove('hse-1', oldPendingHse.id, { expectedVersion: oldPendingHse.version }, db.deps());
  if (oldApproved.outcome !== 'ok') throw new Error('setup failed');
  const oldSnapshotBefore = db.documentSnapshots.find((s) => s.permit_id === oldApproved.permit.id);
  assert.ok(oldSnapshotBefore);

  const renewed = await renewPermit('cro-1', backdated.id, db.deps());
  assert.equal(renewed.outcome, 'ok');
  if (renewed.outcome !== 'ok') return;

  const renewalNotification = db.notifications.find((n) => n.notification_type === 'PERMIT_RENEWED');
  assert.equal(renewalNotification?.recipient_user_id, 'applicant-1');
  assert.equal(renewalNotification?.permit_id, renewed.permit.id);

  const newSnapshot = db.documentSnapshots.find((s) => s.permit_id === renewed.permit.id);
  assert.ok(newSnapshot);
  assert.notEqual(newSnapshot?.id, oldSnapshotBefore?.id);

  const oldSnapshotAfter = db.documentSnapshots.find((s) => s.id === oldSnapshotBefore?.id);
  assert.deepEqual(oldSnapshotAfter, oldSnapshotBefore);

  const outboxMessage = db.whatsappOutbox.find((m) => m.event_type === 'RENEWED');
  assert.ok(outboxMessage);
  const payload = JSON.parse(outboxMessage!.payload) as { previousPermitNumber?: string; newPermitNumber?: string };
  // Both are the formatted, prefixed numbers - the renewal message names
  // the permits the way every other surface does.
  assert.equal(payload.previousPermitNumber, toPermitNumber('WTG_WORK', closed.permit_sequence));
  assert.equal(payload.newPermitNumber, toPermitNumber('WTG_WORK', renewed.permit.permit_sequence));
});

test('a mid-transaction failure rolls back the notification/outbox/snapshot rows together with the permit transition itself - a successful transition never partially loses its side effects, and a failed one never partially keeps them', async () => {
  const db = new FakeDb();
  const pending = await createPendingHsePermit(db, 'applicant-1');
  const notificationsBefore = db.notifications.length;
  const outboxBefore = db.whatsappOutbox.length;
  const snapshotsBefore = db.documentSnapshots.length;
  const jobsBefore = db.documentJobs.length;
  db.failNextLifecycleEventInsert = { eventType: 'HSE_APPROVED' };

  await assert.rejects(() => hseApprove('hse-1', pending.id, { expectedVersion: pending.version }, db.deps()));

  assert.equal(db.notifications.length, notificationsBefore);
  assert.equal(db.whatsappOutbox.length, outboxBefore);
  assert.equal(db.documentSnapshots.length, snapshotsBefore);
  assert.equal(db.documentJobs.length, jobsBefore);
  // The permit itself is unaffected too - still PENDING_HSE.
  const permitAfter = await getPermitById(pending.id, db.deps());
  assert.equal(permitAfter?.status, 'PENDING_HSE');
});

test('submitPermit fails closed and rolls back when no CRO recipient exists', async () => {
  const db = new FakeDb();
  db.denyRecipientsFor('permit.cro_review', 'permit.forward_hse', 'permit.send_back', 'permit.close', 'permit.hold', 'permit.cancel');
  const { permit } = await createDraftPermit('applicant', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant', permit.id, 1);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const beforeEvents = db.lifecycleEvents.length;
  const result = await submitPermit('applicant', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  assert.deepEqual(result, { outcome: 'conflict', reason: 'no_responsible_recipient', responsibility: 'CRO' });
  assert.equal(db.permits.get(permit.id)?.status, 'DRAFT');
  assert.equal(db.lifecycleEvents.length, beforeEvents);
  assert.equal(db.notifications.length, 0);
});

test('resubmitPermit fails closed and rolls back when no CRO recipient exists', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('applicant', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant', permit.id, 1);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const corrected = await croSendBackToApplicant('cro', permit.id, { expectedVersion: submitted.permit.version, reason: 'correct' }, db.deps());
  if (corrected.outcome !== 'ok') throw new Error('setup failed');
  db.denyRecipientsFor('permit.cro_review', 'permit.forward_hse', 'permit.send_back', 'permit.close', 'permit.hold', 'permit.cancel');
  const beforeEvents = db.lifecycleEvents.length;
  const result = await resubmitPermit('applicant', permit.id, { expectedVersion: corrected.permit.version }, db.deps());
  assert.equal(result.outcome, 'conflict');
  assert.equal(db.permits.get(permit.id)?.status, 'PENDING_CORRECTION');
  assert.equal(db.lifecycleEvents.length, beforeEvents);
});

test('fallback-only CRO is not an HSE recipient: forward rolls back every field and side effect', async () => {
  const forwardDb = new FakeDb();
  forwardDb.grantCapability('fallback-cro', 'permit.fallback_approve');
  const { permit } = await createDraftPermit('applicant', 'UTC', 'WTG_WORK', forwardDb.deps());
  const ready = await fillDraftForSubmission(forwardDb, 'applicant', permit.id, 1);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant', permit.id, { expectedVersion: ready.permit.version }, forwardDb.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  forwardDb.denyRecipientsFor('permit.hse_review');
  const forwardEvents = forwardDb.lifecycleEvents.length;
  const forward = await forwardToHseReview('cro', permit.id, { expectedVersion: submitted.permit.version }, forwardDb.deps());
  assert.deepEqual(forward, { outcome: 'conflict', reason: 'no_responsible_recipient', responsibility: 'HSE' });
  const unchanged = forwardDb.permits.get(permit.id);
  assert.equal(unchanged?.status, 'PENDING_CRO');
  assert.equal(unchanged?.version, submitted.permit.version);
  assert.equal(unchanged?.hse_review_started_at, null);
  assert.equal(unchanged?.hse_review_deadline_at, null);
  assert.equal(forwardDb.lifecycleEvents.length, forwardEvents);
  assert.equal(forwardDb.notifications.filter((row) => row.notification_type === 'PERMIT_FORWARDED_HSE').length, 0);
});

test('HSE send-back fails closed when no real CRO reviewer exists', async () => {
  const sendBackDb = new FakeDb();
  const pendingHse = await createPendingHsePermit(sendBackDb, 'applicant');
  sendBackDb.denyRecipientsFor('permit.cro_review', 'permit.forward_hse', 'permit.send_back', 'permit.close', 'permit.hold', 'permit.cancel');
  const sendBackEvents = sendBackDb.lifecycleEvents.length;
  const sentBack = await hseSendBackToCro('hse', pendingHse.id, { expectedVersion: pendingHse.version, reason: 'review again' }, sendBackDb.deps());
  assert.deepEqual(sentBack, { outcome: 'conflict', reason: 'no_responsible_recipient', responsibility: 'CRO' });
  assert.equal(sendBackDb.permits.get(pendingHse.id)?.status, 'PENDING_HSE');
  assert.equal(sendBackDb.lifecycleEvents.length, sendBackEvents);
});

// ---------------------------------------------------------------------
// Permit/JSA form content and authoritative digital signatures
// (migration 0016)
// ---------------------------------------------------------------------

/** Drives a fresh permit to ISSUED via CRO fallback approval instead of HSE approval. */
async function createFallbackIssuedPermit(db: FakeDb, actorUserId = 'owner'): Promise<PermitRow> {
  const pending = await createPendingHsePermit(db, actorUserId);
  db.advanceTime(FIVE_MINUTES_MS);
  const approved = await croFallbackApprove('cro-1', pending.id, { expectedVersion: pending.version }, db.deps());
  if (approved.outcome !== 'ok') throw new Error('setup failed: croFallbackApprove');
  return approved.permit;
}

test('createDraftPermit fixes the permit template and derives its form version server-side', async () => {
  const db = new FakeDb();
  for (const permitType of PERMIT_TYPES) {
    const { permit, jsa } = await createDraftPermit('owner', 'UTC', permitType, db.deps());
    assert.equal(permit.permit_type, permitType);
    assert.equal(permit.form_version, permitFormVersionFor(permitType, ACTIVE_FORM_GENERATION));
    assert.equal(permit.status, 'DRAFT');
    assert.ok(jsa.id);
  }
  // The version is never taken from a caller - it is looked up from the
  // type, and the INSERT binds both.
  const insert = db.queries.find((q) => q.sql.startsWith('INSERT INTO permits'));
  assert.deepEqual(insert?.params.slice(3), ['WTG_WORK', permitFormVersionFor('WTG_WORK', ACTIVE_FORM_GENERATION)]);
});

test('a draft form edit stores the validated payload and its derived relational projection', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  db.clearPermitForm(permit.id);

  const form = answeredWtgPermitV2({ windFarmName: 'Gharo', wtgNumber: 'WTG-11' });
  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET', form },
    db.deps(),
  );
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.deepEqual(result.permit.form_payload, form);
  assert.equal(result.permit.wind_farm, 'Gharo');
  assert.equal(result.permit.wtg_number, 'WTG-11');
  assert.equal(result.permit.work_description, 'Work');
  assert.equal(result.permit.version, permit.version + 1);
});

test('a form payload belonging to another template is rejected for the permit own type', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET', form: makeHotWorkForm() },
    db.deps(),
  );
  assert.equal(result.outcome, 'invalid');
  if (result.outcome === 'invalid') assert.equal(result.reason, 'invalid_form_payload');
});

test('an unknown form property is rejected rather than stored', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, form: { ...answeredWtgPermitV2(), croSignature: 'Bilal Ahmed' } },
    db.deps(),
  );
  assert.equal(result.outcome, 'invalid');
});

test('form editing follows the same ownership/status/version rules as every other draft edit', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const asOther = await updateDraftPermit(
    'someone-else',
    permit.id,
    { expectedVersion: permit.version, form: answeredWtgPermitV2() },
    db.deps(),
  );
  assert.deepEqual(asOther, { outcome: 'not_found' });

  const stale = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version + 5, form: answeredWtgPermitV2() },
    db.deps(),
  );
  assert.deepEqual(stale, { outcome: 'conflict', reason: 'stale_version' });
});

test('an ISSUED permit form and JSA are immutable through the ordinary edit paths', async () => {
  const db = new FakeDb();
  const issued = await createIssuedPermit(db);

  const permitEdit = await updateDraftPermit(
    'owner',
    issued.id,
    { expectedVersion: issued.version, form: answeredWtgPermitV2({ windFarmName: 'Rewritten' }) },
    db.deps(),
  );
  assert.deepEqual(permitEdit, { outcome: 'conflict', reason: 'not_editable' });

  const jsaEdit = await updateLinkedJsa(
    'owner',
    issued.id,
    { expectedVersion: issued.version, form: answeredJsaV2() },
    db.deps(),
  );
  assert.deepEqual(jsaEdit, { outcome: 'conflict', reason: 'not_editable' });
});

test('a permit sent back for correction can be edited again, and its form change is stored', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');

  const corrected = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: sentBack.permit.version, form: answeredWtgPermitV2({ windFarmName: 'Corrected Farm' }) },
    db.deps(),
  );
  assert.equal(corrected.outcome, 'ok');
  if (corrected.outcome === 'ok') assert.equal(corrected.permit.wind_farm, 'Corrected Farm');
});

test('the linked JSA is edited under the permit own lock, ownership, and version token', async () => {
  const db = new FakeDb();
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());

  const form = answeredJsaV2();
  const result = await updateLinkedJsa('owner', permit.id, { expectedVersion: permit.version, form }, db.deps());
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.jsa.id, jsa.id, 'the same JSA row is edited - never replaced');
  assert.equal(result.jsa.form_version, jsaFormVersionFor(ACTIVE_FORM_GENERATION));
  assert.deepEqual(result.jsa.form_payload, form);
  assert.equal(result.jsa.site_or_wtg, form.page1.siteOrWtg);
  assert.equal(result.jsa.job_description, form.page1.jobOrWork);
  assert.equal(result.permit.version, permit.version + 1, 'permit + JSA share one concurrency token');

  const stale = await updateLinkedJsa('owner', permit.id, { expectedVersion: permit.version, form }, db.deps());
  assert.deepEqual(stale, { outcome: 'conflict', reason: 'stale_version' });

  const asOther = await updateLinkedJsa('someone-else', permit.id, { expectedVersion: result.permit.version, form }, db.deps());
  assert.deepEqual(asOther, { outcome: 'not_found' });

  const invalid = await updateLinkedJsa(
    'owner',
    permit.id,
    { expectedVersion: result.permit.version, form: { ...form, unexpected: true } },
    db.deps(),
  );
  assert.equal(invalid.outcome, 'invalid');
});

test('a permit cannot be submitted while its own form or its JSA is incomplete', async () => {
  const db = new FakeDb();
  const { permit, jsa } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');

  db.clearPermitForm(permit.id);
  const withoutPermitForm = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.deepEqual(withoutPermitForm, { outcome: 'invalid', reason: 'missing_required_fields' });

  const restored = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: updated.permit.version, form: answeredWtgPermitV2() },
    db.deps(),
  );
  if (restored.outcome !== 'ok') throw new Error('setup failed');

  db.clearJsaForm(jsa.id);
  const withoutJsa = await submitPermit('owner', permit.id, { expectedVersion: restored.permit.version }, db.deps());
  assert.deepEqual(withoutJsa, { outcome: 'invalid', reason: 'missing_required_fields' });

  const jsaCompleted = await updateLinkedJsa(
    'owner',
    permit.id,
    { expectedVersion: restored.permit.version, form: answeredJsaV2() },
    db.deps(),
  );
  if (jsaCompleted.outcome !== 'ok') throw new Error('setup failed');
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: jsaCompleted.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');
});

test('the applicant signs by submitting: the signature is the authenticated actor, never a supplied name', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('owner', {
    display_name: 'Ayesha Khan',
    primary_team_position_id: 'tp-1',
    team_name: 'Maintenance Team A',
    position_name: 'Technician',
  });
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');
  await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(db.permitSignatures.length, 1);
  const signature = db.permitSignatures[0]!;
  assert.equal(signature.signature_role, 'APPLICANT');
  assert.equal(signature.signer_user_id, 'owner');
  assert.equal(signature.signer_display_name, 'Ayesha Khan');
  assert.equal(signature.signer_position_name, 'Technician');
  assert.equal(signature.signer_team_name, 'Maintenance Team A');
});

test('CRO and HSE signatures are likewise the authenticated actors of their own actions', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('cro-1', {
    display_name: 'Bilal Ahmed',
    primary_team_position_id: 'tp-2',
    team_name: 'Operations',
    position_name: 'Control Room Operator',
  });
  db.setWorkforceProfile('hse-1', {
    display_name: 'Cara Noor',
    primary_team_position_id: 'tp-3',
    team_name: 'HSE',
    position_name: 'HSE Officer',
  });
  await createIssuedPermit(db);

  const roles = db.permitSignatures.map((row) => [row.signature_role, row.signer_user_id, row.signer_display_name]);
  assert.deepEqual(roles, [
    ['APPLICANT', 'owner', 'Display Name of owner'],
    ['CRO', 'cro-1', 'Bilal Ahmed'],
    ['HSE', 'hse-1', 'Cara Noor'],
  ]);
});

test('a signer with no workforce profile FAILS CLOSED: the whole transition rolls back', async () => {
  const db = new FakeDb();
  db.removeWorkforceProfile('owner');
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');

  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.deepEqual(submitted, { outcome: 'conflict', reason: 'missing_signing_identity' });

  const after = await getPermitById(permit.id, db.deps());
  assert.equal(after?.status, 'DRAFT', 'the permit never moved');
  assert.equal(after?.version, updated.permit.version, 'the version never advanced');
  assert.equal(db.permitSignatures.length, 0);
  assert.equal(db.lifecycleEvents.filter((e) => e.event_type === 'SUBMITTED').length, 0);
  assert.equal(db.notifications.length, 0);
});

test('a CRO with no signing identity cannot forward, and an HSE with none cannot approve', async () => {
  const forwardDb = new FakeDb();
  forwardDb.removeWorkforceProfile('cro-1');
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', forwardDb.deps());
  const updated = await fillDraftForSubmission(forwardDb, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, forwardDb.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');

  const forwarded = await forwardToHseReview('cro-1', permit.id, { expectedVersion: submitted.permit.version }, forwardDb.deps());
  assert.deepEqual(forwarded, { outcome: 'conflict', reason: 'missing_signing_identity' });
  assert.equal((await getPermitById(permit.id, forwardDb.deps()))?.status, 'PENDING_CRO');

  const approveDb = new FakeDb();
  approveDb.removeWorkforceProfile('hse-1');
  const pending = await createPendingHsePermit(approveDb);
  const approved = await hseApprove('hse-1', pending.id, { expectedVersion: pending.version }, approveDb.deps());
  assert.deepEqual(approved, { outcome: 'conflict', reason: 'missing_signing_identity' });
  assert.equal((await getPermitById(pending.id, approveDb.deps()))?.status, 'PENDING_HSE');
  assert.equal(approveDb.documentSnapshots.length, 0, 'no issued document was created');
});

test('CRO fallback approval signs as CRO FALLBACK and never fabricates an HSE signature', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('cro-1', {
    display_name: 'Bilal Ahmed',
    primary_team_position_id: 'tp-2',
    team_name: 'Operations',
    position_name: 'Control Room Operator',
  });
  const issued = await createFallbackIssuedPermit(db);

  const roles = db.permitSignatures.map((row) => row.signature_role);
  assert.deepEqual(roles, ['APPLICANT', 'CRO', 'CRO_FALLBACK']);
  assert.ok(!roles.includes('HSE'));

  const snapshot = db.documentSnapshots.find((s) => s.permit_id === issued.id)?.snapshot as {
    signatures: { hse: unknown; croFallback: { displayName: string; role: string } | null };
    issuanceEventType: string;
  };
  assert.equal(snapshot.issuanceEventType, 'CRO_FALLBACK_APPROVED');
  assert.equal(snapshot.signatures.hse, null);
  assert.equal(snapshot.signatures.croFallback?.displayName, 'Bilal Ahmed');
  assert.equal(snapshot.signatures.croFallback?.role, 'CRO_FALLBACK');
});

test('the issued snapshot freezes the signature identities that existed at issuance', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('owner', {
    display_name: 'Ayesha Khan',
    primary_team_position_id: 'tp-1',
    team_name: 'Maintenance Team A',
    position_name: 'Technician',
  });
  const issued = await createIssuedPermit(db);
  const snapshot = db.documentSnapshots.find((s) => s.permit_id === issued.id)?.snapshot as {
    signatures: { applicant: { displayName: string; designation: string } };
    permitType: string;
    permitForm: unknown;
    jsaForm: unknown;
  };
  assert.equal(snapshot.signatures.applicant.displayName, 'Ayesha Khan');
  assert.equal(snapshot.signatures.applicant.designation, 'Technician, Maintenance Team A');
  assert.equal(snapshot.permitType, 'WTG_WORK');
  assert.ok(snapshot.permitForm);
  assert.ok(snapshot.jsaForm);

  // The employee is promoted and renamed AFTER issuance.
  db.setWorkforceProfile('owner', {
    display_name: 'A. Khan',
    primary_team_position_id: 'tp-9',
    team_name: 'Maintenance Team B',
    position_name: 'Senior Technician',
  });
  const stillFrozen = db.documentSnapshots.find((s) => s.permit_id === issued.id)?.snapshot as {
    signatures: { applicant: { displayName: string; designation: string } };
  };
  assert.equal(stillFrozen.signatures.applicant.displayName, 'Ayesha Khan');
  assert.equal(stillFrozen.signatures.applicant.designation, 'Technician, Maintenance Team A');
});

test('a resubmitted permit is issued carrying the LAST applicant signature, with every earlier one retained', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('owner', {
    display_name: 'Ayesha Khan',
    primary_team_position_id: 'tp-1',
    team_name: 'Maintenance Team A',
    position_name: 'Technician',
  });
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  const updated = await fillDraftForSubmission(db, 'owner', permit.id, permit.version);
  if (updated.outcome !== 'ok') throw new Error('setup failed');
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  if (submitted.outcome !== 'ok') throw new Error('setup failed');
  const sentBack = await croSendBackToApplicant('cro-1', permit.id, { expectedVersion: submitted.permit.version }, db.deps());
  if (sentBack.outcome !== 'ok') throw new Error('setup failed');

  db.setWorkforceProfile('owner', {
    display_name: 'Ayesha Khan',
    primary_team_position_id: 'tp-1',
    team_name: 'Maintenance Team A',
    position_name: 'Senior Technician',
  });
  const resubmitted = await resubmitPermit('owner', permit.id, { expectedVersion: sentBack.permit.version }, db.deps());
  if (resubmitted.outcome !== 'ok') throw new Error('setup failed');
  const forwarded = await forwardToHseReview('cro-1', permit.id, { expectedVersion: resubmitted.permit.version }, db.deps());
  if (forwarded.outcome !== 'ok') throw new Error('setup failed');
  const approved = await hseApprove('hse-1', permit.id, { expectedVersion: forwarded.permit.version }, db.deps());
  if (approved.outcome !== 'ok') throw new Error('setup failed');

  const applicantSignatures = db.permitSignatures.filter((row) => row.signature_role === 'APPLICANT');
  assert.equal(applicantSignatures.length, 2, 'both signing acts remain recorded');

  const snapshot = db.documentSnapshots[0]?.snapshot as {
    signatures: { applicant: { designation: string } };
  };
  assert.equal(snapshot.signatures.applicant.designation, 'Senior Technician, Maintenance Team A');
});

test('a renewed permit carries over the form content and inherits the frozen signatures, plus its own renewal signature', async () => {
  const db = new FakeDb();
  db.setWorkforceProfile('cro-2', {
    display_name: 'Dania Iqbal',
    primary_team_position_id: 'tp-4',
    team_name: 'Operations',
    position_name: 'Control Room Operator',
  });
  const issued = await createIssuedPermit(db);
  const closed = await closePermit('cro-1', issued.id, { expectedVersion: issued.version }, db.deps());
  if (closed.outcome !== 'ok') throw new Error('setup failed: closePermit');
  db.advanceTime(48 * 60 * 60 * 1000);

  const renewed = await renewPermit('cro-2', issued.id, db.deps());
  assert.equal(renewed.outcome, 'ok');
  if (renewed.outcome !== 'ok') return;

  assert.equal(renewed.permit.previous_permit_id, issued.id);
  assert.equal(renewed.permit.jsa_id, issued.jsa_id, 'the same JSA is reused');
  assert.notEqual(renewed.permit.permit_sequence, issued.permit_sequence, 'a new Permit Number');
  assert.equal(renewed.permit.permit_type, issued.permit_type);
  assert.deepEqual(renewed.permit.form_payload, issued.form_payload);
  assert.equal(renewed.permit.wind_farm, issued.wind_farm);

  const renewalSignatures = db.permitSignatures.filter((row) => row.permit_id === renewed.permit.id);
  assert.deepEqual(renewalSignatures.map((row) => row.signature_role), ['RENEWAL']);
  assert.equal(renewalSignatures[0]?.signer_display_name, 'Dania Iqbal');

  const snapshot = db.documentSnapshots.find((s) => s.permit_id === renewed.permit.id)?.snapshot as {
    signatures: {
      applicant: { displayName: string } | null;
      hse: { displayName: string } | null;
      renewal: { displayName: string } | null;
    };
    previousPermitNumber: string;
  };
  // The snapshot carries the FORMATTED number, as every surface does.
  assert.equal(snapshot.previousPermitNumber, toPermitNumber('WTG_WORK', issued.permit_sequence));
  assert.equal(snapshot.signatures.applicant?.displayName, 'Display Name of owner');
  assert.equal(snapshot.signatures.hse?.displayName, 'Display Name of hse-1');
  assert.equal(snapshot.signatures.renewal?.displayName, 'Dania Iqbal');
});

test('a renewing CRO with no signing identity cannot renew - and the old permit stays untouched', async () => {
  const db = new FakeDb();
  db.removeWorkforceProfile('cro-2');
  const issued = await createIssuedPermit(db);
  const closed = await closePermit('cro-1', issued.id, { expectedVersion: issued.version }, db.deps());
  if (closed.outcome !== 'ok') throw new Error('setup failed');
  db.advanceTime(48 * 60 * 60 * 1000);

  const renewed = await renewPermit('cro-2', issued.id, db.deps());
  assert.deepEqual(renewed, { outcome: 'conflict', reason: 'missing_signing_identity' });

  const old = await getPermitById(issued.id, db.deps());
  assert.equal(old?.status, 'CLOSED');
  assert.equal(old?.version, closed.permit.version);
  assert.equal([...db.permits.values()].filter((p) => p.previous_permit_id === issued.id).length, 0);
});

test('list endpoints return summaries without form payloads; detail keeps the full form', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', 'WTG_WORK', db.deps());
  // The record list excludes drafts, so this one has to be a record.
  db.permits.get(permit.id)!.status = 'PENDING_CRO';

  const listed = await listOwnPermits('owner', { page: 1, pageSize: 20 }, db.deps());
  const listQuery = db.queries.find(
    (q) => !q.sql.startsWith('SELECT COUNT') && q.sql.includes('FROM permits WHERE created_by = $1 AND status <>'),
  );
  assert.ok(listQuery);
  assert.ok(!listQuery.sql.includes('form_payload'), 'the list query must never select form_payload');
  assert.ok(listQuery.sql.includes('permit_type'), 'the list still carries the searchable relational fields');
  assert.equal(listed.items.length, 1);

  const detail = await getPermitById(permit.id, db.deps());
  assert.ok(detail?.form_payload, 'permit detail carries the full validated form');
});

/**
 * PER-TYPE PERMIT NUMBERING (migration 0033): notification prose names
 * the type, the authoritative number stays bare.
 *
 * Since each type is numbered in its own series, "Permit 1 issued" names
 * four different permits. The human-readable text therefore carries the
 * type beside the number - and ONLY that text does: the WhatsApp payload,
 * the snapshot and the record all keep the bare stored number.
 *
 * All four type labels are covered as a unit in numbering.test.ts; these
 * prove the wiring, using the WTG form the shared fixtures answer.
 */
test('notification prose names the permit type beside the number', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  const { permit } = await createDraftPermit('applicant-1', 'UTC', 'WTG_WORK', db.deps());
  const ready = await fillDraftForSubmission(db, 'applicant-1', permit.id, permit.version);
  if (ready.outcome !== 'ok') throw new Error('setup failed: fillDraftForSubmission');
  const submitted = await submitPermit('applicant-1', permit.id, { expectedVersion: ready.permit.version }, db.deps());
  assert.equal(submitted.outcome, 'ok');

  const notification = db.notifications.find((n) => n.notification_type === 'PERMIT_SUBMITTED');
  assert.ok(notification, 'a submission notification must exist');
  // The number a person reads is the prefixed one - `WTG-3`, not `3`.
  const number = toPermitNumber('WTG_WORK', submitted.permit.permit_sequence);
  assert.match(number, /^WTG-\d+$/);
  assert.equal(notification.title, `WTG Work Permit ${number} submitted for CRO review`);
  assert.equal(notification.message, `WTG Work Permit ${number} is awaiting CRO review.`);
  // The type is added BESIDE the number, never substituted for it.
  assert.ok(notification.title.includes(String(number)));
});

test('every notification a permit produces names its type, at every transition', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  db.grantCapability('hse-1', 'permit.hse_review');
  const issued = await createIssuedPermit(db, 'owner');

  const forThisPermit = db.notifications.filter((n) => n.permit_id === issued.id);
  assert.ok(forThisPermit.length > 0);
  for (const notification of forThisPermit) {
    assert.ok(
      notification.title.startsWith('WTG Work Permit '),
      `title must name the type, got "${notification.title}"`,
    );
    assert.ok(notification.message.includes('WTG Work Permit '), notification.message);
    // No bare "Permit N" survives anywhere a person reads.
    assert.ok(!/^Permit \d/.test(notification.title));
  }
});

test('the WhatsApp payload carries the same permit number every other surface shows', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  db.grantCapability('hse-1', 'permit.hse_review');
  const issued = await createIssuedPermit(db, 'owner');

  const outbox = db.whatsappOutbox.find((m) => m.permit_id === issued.id);
  assert.ok(outbox, 'an ISSUED outbox message must exist');
  // The fake stores the payload exactly as the column does: JSON text.
  const payload = JSON.parse(outbox.payload) as { permitNumber: string };
  /*
    A WhatsApp message is read by a person, so it carries the same
    authoritative number as the register, the record and the PDF. One
    permit must not be called `WTG-3` on screen and `3` in the message
    that tells someone about it.
  */
  assert.equal(payload.permitNumber, toPermitNumber('WTG_WORK', issued.permit_sequence));
  assert.match(payload.permitNumber, /^WTG-\d+$/);
});

/**
 * SUBMITTING END TO END, FOR EVERY PERMIT TYPE.
 *
 * `partialSubmission.test.ts` pins the RULE
 * (`hasMeaningfulSubmissionContent`). These pin what `submitPermit`
 * actually does with it, because the hosted regression was not in the
 * rule at all - the screen submitted before saving, so the server was
 * asked to judge a permit it had never been sent and refused it as
 * `missing_required_fields`. Once the document is stored, a partly
 * completed one of ANY type must reach PENDING_CRO, and only a document
 * with nothing in it comes back as `empty_submission`.
 */
async function storeAndSubmit(
  db: FakeDb,
  permitType: PermitType,
  permitForm: unknown,
  jsaForm: unknown,
): Promise<SubmitOutcome> {
  const { permit } = await createDraftPermit('applicant-1', 'UTC', permitType, db.deps());
  const savedPermit = await updateDraftPermit(
    'applicant-1',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET', form: permitForm },
    db.deps(),
  );
  if (savedPermit.outcome !== 'ok') throw new Error(`setup failed: permit save (${savedPermit.outcome})`);
  const savedJsa = await updateLinkedJsa(
    'applicant-1',
    permit.id,
    { expectedVersion: savedPermit.permit.version, form: jsaForm },
    db.deps(),
  );
  if (savedJsa.outcome !== 'ok') throw new Error('setup failed: jsa save');
  return submitPermit('applicant-1', permit.id, { expectedVersion: savedJsa.permit.version }, db.deps());
}

for (const permitType of ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const) {
  test(`${permitType}: a partly completed permit submits to PENDING_CRO`, async () => {
    const db = new FakeDb();
    db.grantCapability('cro-a', 'permit.cro_review');
    const result = await storeAndSubmit(db, permitType, partialPermitV2(permitType), blankJsaFormV2());

    assert.equal(result.outcome, 'ok', `${permitType} must be submittable partly completed`);
    if (result.outcome !== 'ok') throw new Error('unreachable');
    assert.equal(result.permit.status, 'PENDING_CRO');
  });

  test(`${permitType}: a partly completed permit is never refused as missing_required_fields`, async () => {
    const db = new FakeDb();
    db.grantCapability('cro-a', 'permit.cro_review');
    const result = await storeAndSubmit(db, permitType, partialPermitV2(permitType), blankJsaFormV2());
    assert.notDeepEqual(result, { outcome: 'invalid', reason: 'missing_required_fields' });
  });

  test(`${permitType}: a completely blank permit and JSA is refused as empty_submission`, async () => {
    const db = new FakeDb();
    db.grantCapability('cro-a', 'permit.cro_review');
    const result = await storeAndSubmit(db, permitType, blankPermitV2(permitType), blankJsaFormV2());
    // The accurate refusal, and specifically NOT the missing-fields one.
    assert.deepEqual(result, { outcome: 'invalid', reason: 'empty_submission' });
  });

  test(`${permitType}: a blank permit still submits when the JSA carries the content`, async () => {
    const db = new FakeDb();
    db.grantCapability('cro-a', 'permit.cro_review');
    const result = await storeAndSubmit(db, permitType, blankPermitV2(permitType), answeredJsaV2());
    assert.equal(result.outcome, 'ok', 'content anywhere in the document is enough');
  });
}

test('an unanswered question stays null through submission - nothing is defaulted', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  const result = await storeAndSubmit(db, 'WTG_WORK', partialPermitV2('WTG_WORK'), blankJsaFormV2());
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') throw new Error('unreachable');

  const stored = result.permit.form_payload as unknown as { sections: Record<string, Record<string, { response: unknown }>> };
  const responses = Object.values(stored.sections).flatMap((band) =>
    Object.values(band).map((item) => item.response),
  );
  assert.ok(responses.length > 0);
  // Whatever the fixture answered is kept; everything else is still null,
  // never turned into NO or NA on the way past.
  assert.ok(responses.every((response) => response === null || response === 'YES' || response === 'NO' || response === 'NA'));
  assert.ok(responses.some((response) => response === null), 'blank questions must remain blank');
});

test('an N/A answer alone is enough to submit, because choosing it is a judgement', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  // WTG, not Cold Work: the 008 forms print no N/A column at all, and the
  // schema is right to refuse one there.
  const blank = blankPermitV2('WTG_WORK') as { sections: Record<string, Record<string, { response: unknown }>> };
  const sectionId = Object.keys(blank.sections)[0]!;
  const itemId = Object.keys(blank.sections[sectionId]!)[0]!;
  blank.sections[sectionId]![itemId]!.response = 'NA';

  const result = await storeAndSubmit(db, 'WTG_WORK', blank, blankJsaFormV2());
  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') throw new Error('unreachable');
  const stored = result.permit.form_payload as unknown as { sections: Record<string, Record<string, { response: unknown }>> };
  assert.equal(stored.sections[sectionId]![itemId]!.response, 'NA', 'NA must survive exactly');
});

// ---------------------------------------------------------------------
// The HSE priority window: the parts the matrix asked for that were not
// already pinned
// ---------------------------------------------------------------------

/**
 * THE WINDOW IS A PRIORITY, NOT A DEADLINE FOR HSE.
 *
 * When it expires nothing happens to the permit: it stays PENDING_HSE
 * until somebody acts. HSE keeps its ordinary approval, and an authorized
 * CRO merely becomes eligible as well. The first successful approval
 * wins, and the loser is refused because the permit has moved on - not
 * because a clock said so.
 */

test('expiry issues nothing by itself - the permit simply waits', async () => {
  const db = new FakeDb();
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS * 4);

  // Nobody has acted. The permit is exactly where it was.
  const stored = db.permits.get(permit.id)!;
  assert.equal(stored.status, 'PENDING_HSE');
  assert.equal(stored.issued_at, null);
  assert.equal(stored.version, permit.version, 'no version was consumed by time passing');
  // And no issuance side effect happened.
  assert.equal(db.documentSnapshots.length, 0, 'no snapshot may be created by expiry');
  assert.equal(db.documentJobs.length, 0, 'and no document job either');
});

test('HSE may still approve long after the window expired, while nobody has won', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS + 60_000); // 10:06

  const result = await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok', 'the window never removes HSE authority');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'ISSUED');
  // And it is recorded as an ordinary HSE approval, not a fallback.
  const events = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(events.at(-1)?.params?.[1], 'HSE_APPROVED');
});

test('exactly one issuance snapshot exists, whichever path won', async () => {
  for (const winner of ['HSE', 'CRO'] as const) {
    const db = new FakeDb();
    db.grantCapability('cro-a', 'permit.cro_review');
    const permit = await createPendingHsePermit(db);
    db.advanceTime(FIVE_MINUTES_MS);

    const issued =
      winner === 'HSE'
        ? await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps())
        : await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
    assert.equal(issued.outcome, 'ok', `${winner} must win`);

    // One permit, one immutable snapshot - the same issuance path for both.
    assert.equal(db.documentSnapshots.length, 1, `${winner}: exactly one snapshot`);
    assert.equal(db.documentSnapshots[0]!.permit_id, permit.id);
    assert.equal(db.documentJobs.length, 1, `${winner}: exactly one document job`);

    // The loser's attempt afterwards creates no second one.
    const loser =
      winner === 'HSE'
        ? await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps())
        : await hseApprove('hse-1', permit.id, { expectedVersion: permit.version }, db.deps());
    assert.notEqual(loser.outcome, 'ok', `${winner}: the loser must be refused`);
    assert.equal(db.documentSnapshots.length, 1, `${winner}: still exactly one snapshot`);
    assert.equal(db.documentJobs.length, 1, `${winner}: still exactly one document job`);
  }
});

test('the winning path is distinguishable in the lifecycle record', async () => {
  // HSE wins.
  const hseDb = new FakeDb();
  hseDb.grantCapability('cro-a', 'permit.cro_review');
  const hsePermit = await createPendingHsePermit(hseDb);
  await hseApprove('hse-1', hsePermit.id, { expectedVersion: hsePermit.version }, hseDb.deps());
  const hseEvents = hseDb.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(hseEvents.at(-1)?.params?.[1], 'HSE_APPROVED');
  assert.equal(hseEvents.at(-1)?.params?.[2], 'hse-1', 'the actual actor is recorded');

  // CRO fallback wins.
  const croDb = new FakeDb();
  croDb.grantCapability('cro-a', 'permit.cro_review');
  const croPermit = await createPendingHsePermit(croDb);
  croDb.advanceTime(FIVE_MINUTES_MS);
  await croFallbackApprove('cro-9', croPermit.id, { expectedVersion: croPermit.version }, croDb.deps());
  const croEvents = croDb.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(croEvents.at(-1)?.params?.[1], 'CRO_FALLBACK_APPROVED', 'a fallback is not an HSE approval');
  assert.equal(croEvents.at(-1)?.params?.[2], 'cro-9', 'the CRO who actually pressed it');
});

test('any authorized CRO may fall back - not only the one who forwarded', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  // `createPendingHsePermit` forwards as cro-1; a different CRO acts here.
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);

  const result = await croFallbackApprove('a-different-cro', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  const events = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(events.at(-1)?.params?.[2], 'a-different-cro');
});

test('a stale replay of the losing approval cannot issue a second time', async () => {
  const db = new FakeDb();
  db.grantCapability('cro-a', 'permit.cro_review');
  const permit = await createPendingHsePermit(db);
  db.advanceTime(FIVE_MINUTES_MS);

  const won = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
  assert.equal(won.outcome, 'ok');

  // The same request replayed - the version it carries is now stale AND
  // the permit is no longer PENDING_HSE. Either alone is enough.
  for (let replay = 0; replay < 3; replay += 1) {
    const again = await croFallbackApprove('cro-1', permit.id, { expectedVersion: permit.version }, db.deps());
    assert.notEqual(again.outcome, 'ok', 'a replay must never issue again');
  }
  assert.equal(db.documentSnapshots.length, 1, 'still exactly one issuance');
  assert.equal(db.documentJobs.length, 1, 'and one document job');
});
