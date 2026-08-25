-- Permit closure: ISSUED -> CRO CLOSE -> CLOSED.
--
-- "Closure replaces the old V5.19 closure workflow. There is no creator
-- closure request and no creator final closure step... Only CRO closes a
-- permit... Closure records the authoritative actor, timestamp, and any
-- closure information/remarks" (WORKFLOW.md); "Closed permits are
-- immutable historical records through ordinary operations"
-- (DECISIONS.md). Only ISSUED -> CLOSED is implemented here - no
-- send-back, hold, resume, cancellation, expiry, or renewal.
--
-- Whether closure remarks must be mandatory is not finalized, so
-- `closure_remarks` is optional storage only - no CHECK requires it to
-- be non-empty. That is intentionally left for later tightening, not
-- decided here.

ALTER TABLE permits
  ADD COLUMN closed_by UUID REFERENCES auth.users (id) ON DELETE RESTRICT,
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN closure_remarks TEXT;

ALTER TABLE permits DROP CONSTRAINT permits_status_valid;
ALTER TABLE permits ADD CONSTRAINT permits_status_valid
  CHECK (status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'CLOSED'));

-- issued_at was previously required iff status = ISSUED; a CLOSED permit
-- was necessarily issued first, so it must still carry issued_at too.
ALTER TABLE permits DROP CONSTRAINT permits_issued_at_consistent;
ALTER TABLE permits ADD CONSTRAINT permits_issued_at_consistent CHECK (
  (status IN ('ISSUED', 'CLOSED')) = (issued_at IS NOT NULL)
);

-- The HSE review window was previously required (both timestamps set)
-- only for PENDING_HSE/ISSUED; a CLOSED permit inherits those from when
-- it was issued and must still carry them (they are never cleared by
-- closure), so the "has window" branch must include CLOSED too. This
-- widens migration 0008's permits_hse_window_status_consistent - without
-- this, closing a permit would violate that pre-existing constraint.
ALTER TABLE permits DROP CONSTRAINT permits_hse_window_status_consistent;
ALTER TABLE permits ADD CONSTRAINT permits_hse_window_status_consistent CHECK (
  (status IN ('DRAFT', 'PENDING_CRO') AND hse_review_started_at IS NULL AND hse_review_deadline_at IS NULL)
  OR (status IN ('PENDING_HSE', 'ISSUED', 'CLOSED') AND hse_review_started_at IS NOT NULL AND hse_review_deadline_at IS NOT NULL)
);

-- Closure metadata (closed_by, closed_at, closure_remarks) only ever
-- appears on a CLOSED permit, never on a pre-closure status - and once
-- CLOSED, closed_by/closed_at are required (closure_remarks stays
-- optional, per the note above).
ALTER TABLE permits ADD CONSTRAINT permits_closure_consistent CHECK (
  (status = 'CLOSED' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
  OR (status <> 'CLOSED' AND closed_by IS NULL AND closed_at IS NULL AND closure_remarks IS NULL)
);

-- Widen the lifecycle event/status domain to the new transition.
-- permit_lifecycle_events_event_type_check / _from_status_check /
-- _to_status_check / _event_status_consistent are all explicitly named
-- (migration 0008 gave them these names when it recreated what had been
-- unnamed inline CHECKs in 0006), so no name-guessing is needed here.
ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_type_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_type_check
  CHECK (event_type IN ('CREATED', 'SUBMITTED', 'CRO_FORWARDED_HSE', 'HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'CLOSED'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_from_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_from_status_check
  CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_to_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_to_status_check
  CHECK (to_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'CLOSED'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_status_consistent;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_status_consistent CHECK (
  (event_type = 'CREATED' AND from_status IS NULL AND to_status = 'DRAFT')
  OR (event_type = 'SUBMITTED' AND from_status = 'DRAFT' AND to_status = 'PENDING_CRO')
  OR (event_type = 'CRO_FORWARDED_HSE' AND from_status = 'PENDING_CRO' AND to_status = 'PENDING_HSE')
  OR (event_type = 'HSE_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
  OR (event_type = 'CRO_FALLBACK_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
  OR (event_type = 'CLOSED' AND from_status = 'ISSUED' AND to_status = 'CLOSED')
);

-- No new tables, no privilege/RLS changes needed: `permits` and
-- `permit_lifecycle_events` already have RLS enabled and PUBLIC/anon/
-- authenticated revoked (migration 0006); ADD COLUMN/ADD CONSTRAINT does
-- not reset either. The append-only UPDATE/DELETE/TRUNCATE triggers on
-- permit_lifecycle_events (0006) are untouched and still apply to the
-- new CLOSED event rows.
