-- Completes the agreed Permit workflow: CRO send-back to applicant, HSE
-- send-back to CRO, Hold, Resume, Cancel, and Renewal - resolving
-- DECISIONS.md's previously-open decisions #2 (Hold allowed states), #3
-- (Cancel allowed states), #6 (CRO/HSE send-back target state), and #7
-- (status of a renewed permit).
--
-- Widens existing CHECK constraints and appends new columns/indexes;
-- never edits an already-applied migration (0001-0011). Every existing
-- row remains valid under every widened constraint below (each widened
-- CHECK is a strict superset of the constraint it replaces - every
-- previously-allowed value/combination is still allowed), so this is
-- safe to run against the live table with existing rows.

-- New persisted statuses:
--   PENDING_CORRECTION - CRO sent the permit back to the original
--     applicant for correction (a distinct, clearly-named state -
--     deliberately NOT reusing DRAFT, which would conflate "never
--     submitted" with "sent back after review" and lose the CRO-review
--     history that got it there).
--   HELD               - CRO placed an ISSUED permit on hold.
--   CANCELLED          - CRO cancelled the permit (terminal).
-- HSE send-back does NOT introduce a new status: it returns the permit
-- to PENDING_CRO (WORKFLOW.md: "HSE ... does NOT send directly to
-- applicant ... permit returns to CRO").
ALTER TABLE permits DROP CONSTRAINT permits_status_valid;
ALTER TABLE permits ADD CONSTRAINT permits_status_valid
  CHECK (status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'PENDING_CORRECTION', 'ISSUED', 'HELD', 'CANCELLED', 'CLOSED'));

-- The HSE review window: DRAFT/PENDING_CRO/PENDING_CORRECTION never
-- carry it (unchanged from before, PENDING_CORRECTION added alongside
-- them); PENDING_HSE always carries it (unchanged - a permit cannot be
-- PENDING_HSE without having just been forwarded, which always opens a
-- fresh window). ISSUED/HELD/CLOSED/CANCELLED normally carry it too
-- (they were, transitively, once PENDING_HSE) - EXCEPT a renewed permit
-- (`previous_permit_id IS NOT NULL`), which is created directly as
-- ISSUED and explicitly has NO HSE review/timer at all
-- ("NO CRO review, NO HSE review, NO 5-minute timer for renewal").
ALTER TABLE permits DROP CONSTRAINT permits_hse_window_status_consistent;
ALTER TABLE permits ADD CONSTRAINT permits_hse_window_status_consistent CHECK (
  (status IN ('DRAFT', 'PENDING_CRO', 'PENDING_CORRECTION') AND hse_review_started_at IS NULL AND hse_review_deadline_at IS NULL)
  OR (status = 'PENDING_HSE' AND hse_review_started_at IS NOT NULL AND hse_review_deadline_at IS NOT NULL)
  OR (
    status IN ('ISSUED', 'HELD', 'CLOSED', 'CANCELLED')
    AND (
      (hse_review_started_at IS NOT NULL AND hse_review_deadline_at IS NOT NULL)
      OR (hse_review_started_at IS NULL AND hse_review_deadline_at IS NULL AND previous_permit_id IS NOT NULL)
    )
  )
);

-- issued_at is set if and only if the permit has ever been issued -
-- widened from ('ISSUED','CLOSED') to also cover HELD (an ISSUED permit
-- that was placed on hold - still carries its original issued_at, which
-- Resume/validity both depend on being unchanged) and CANCELLED (only
-- reachable from ISSUED/HELD, so always carries issued_at too).
ALTER TABLE permits DROP CONSTRAINT permits_issued_at_consistent;
ALTER TABLE permits ADD CONSTRAINT permits_issued_at_consistent CHECK (
  (status IN ('ISSUED', 'HELD', 'CLOSED', 'CANCELLED')) = (issued_at IS NOT NULL)
);

-- Hold metadata: actor/timestamp/mandatory reason, present if and only
-- if the permit is CURRENTLY held - cleared (not merely left stale) on
-- Resume/Close/Cancel, matching the existing closed_by/closed_at
-- pattern's exact-correspondence style. Full history of every past
-- hold/resume cycle remains in permit_lifecycle_events (append-only)
-- regardless of what the mutable row currently holds.
ALTER TABLE permits
  ADD COLUMN held_by UUID REFERENCES auth.users (id) ON DELETE RESTRICT,
  ADD COLUMN held_at TIMESTAMPTZ,
  ADD COLUMN hold_reason TEXT;

ALTER TABLE permits ADD CONSTRAINT permits_hold_consistent CHECK (
  (status = 'HELD' AND held_by IS NOT NULL AND held_at IS NOT NULL AND hold_reason IS NOT NULL AND btrim(hold_reason) <> '')
  OR (status <> 'HELD' AND held_by IS NULL AND held_at IS NULL AND hold_reason IS NULL)
);

-- Cancellation metadata: actor/timestamp are mandatory once cancelled
-- (a database-enforced floor under "actor identities server-authoritative,
-- timestamps DB-authoritative"); `cancel_reason` stays optional
-- (WORKFLOW.md/this batch's rules do not mandate a cancellation reason,
-- matching how `closure_remarks` was deliberately left optional in
-- migration 0010 for the same "not currently mandated" reasoning).
-- Cancellation is terminal, so - unlike hold - these are never cleared
-- once set.
ALTER TABLE permits
  ADD COLUMN cancelled_by UUID REFERENCES auth.users (id) ON DELETE RESTRICT,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancel_reason TEXT;

ALTER TABLE permits ADD CONSTRAINT permits_cancellation_consistent CHECK (
  (status = 'CANCELLED' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
  OR (status <> 'CANCELLED' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
);

-- Renewal concurrency safety: a given permit can be the source of AT
-- MOST ONE renewal. This partial unique index is the actual enforcement
-- mechanism for "no double renewal" - a `SELECT ... FOR UPDATE` on the
-- OLD permit alone cannot detect a prior renewal, because renewing does
-- not modify the old permit's own row (it stays untouched, per "Old
-- permit remains CLOSED and immutable") - only a database-level
-- uniqueness constraint on the new row's `previous_permit_id` can. A
-- second, concurrent renewal attempt fails this constraint atomically;
-- the application (see domain/permits/service.ts::renewPermit) catches
-- that specific violation and reports it as a normal conflict, not a
-- crash.
CREATE UNIQUE INDEX permits_previous_permit_id_unique ON permits (previous_permit_id) WHERE previous_permit_id IS NOT NULL;

-- Widen the lifecycle event/status domain to every new transition.
-- permit_lifecycle_events_event_type_check / _from_status_check /
-- _to_status_check / _event_status_consistent are all explicitly named
-- (migration 0008 gave them these names when it recreated what had been
-- unnamed inline CHECKs in 0006).
ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_type_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_type_check
  CHECK (event_type IN (
    'CREATED', 'SUBMITTED', 'CRO_FORWARDED_HSE', 'HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'CLOSED',
    'CRO_SENT_BACK_TO_APPLICANT', 'APPLICANT_RESUBMITTED', 'HSE_SENT_BACK_TO_CRO',
    'HELD', 'RESUMED', 'CANCELLED', 'RENEWED'
  ));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_from_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_from_status_check
  CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'PENDING_CORRECTION', 'ISSUED', 'HELD'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_to_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_to_status_check
  CHECK (to_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'PENDING_CORRECTION', 'ISSUED', 'HELD', 'CLOSED', 'CANCELLED'));

-- Exact per-event from/to status pairing, same discipline as migrations
-- 0006/0008/0010. RENEWED is recorded on the NEW permit's own event
-- stream (from_status NULL -> to_status ISSUED), directly analogous to
-- CREATED's NULL -> DRAFT - the link back to the source permit is the
-- new row's `previous_permit_id` column itself (a real FK), not a
-- lifecycle event field, so no event is recorded on the OLD permit: it
-- stays genuinely untouched by renewal, not just unchanged in status.
ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_status_consistent;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_status_consistent CHECK (
  (event_type = 'CREATED' AND from_status IS NULL AND to_status = 'DRAFT')
  OR (event_type = 'SUBMITTED' AND from_status = 'DRAFT' AND to_status = 'PENDING_CRO')
  OR (event_type = 'CRO_FORWARDED_HSE' AND from_status = 'PENDING_CRO' AND to_status = 'PENDING_HSE')
  OR (event_type = 'HSE_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
  OR (event_type = 'CRO_FALLBACK_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
  OR (event_type = 'CLOSED' AND from_status IN ('ISSUED', 'HELD') AND to_status = 'CLOSED')
  OR (event_type = 'CRO_SENT_BACK_TO_APPLICANT' AND from_status = 'PENDING_CRO' AND to_status = 'PENDING_CORRECTION')
  OR (event_type = 'APPLICANT_RESUBMITTED' AND from_status = 'PENDING_CORRECTION' AND to_status = 'PENDING_CRO')
  OR (event_type = 'HSE_SENT_BACK_TO_CRO' AND from_status = 'PENDING_HSE' AND to_status = 'PENDING_CRO')
  OR (event_type = 'HELD' AND from_status = 'ISSUED' AND to_status = 'HELD')
  OR (event_type = 'RESUMED' AND from_status = 'HELD' AND to_status = 'ISSUED')
  OR (event_type = 'CANCELLED' AND from_status IN ('ISSUED', 'HELD') AND to_status = 'CANCELLED')
  OR (event_type = 'RENEWED' AND from_status IS NULL AND to_status = 'ISSUED')
);

-- No new tables, no privilege/RLS changes: `permits` and
-- `permit_lifecycle_events` already have RLS enabled and PUBLIC/anon/
-- authenticated revoked (migration 0006); ADD COLUMN/ADD CONSTRAINT/
-- CREATE INDEX do not reset either. The append-only UPDATE/DELETE/
-- TRUNCATE triggers on permit_lifecycle_events (0006) are untouched and
-- still apply to every new event type above. No SECURITY DEFINER
-- functions, no new policies, no anon/authenticated grants.
