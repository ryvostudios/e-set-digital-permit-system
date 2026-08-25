-- CRO -> HSE review and 5-minute fallback approval.
--
-- Implements only the two transitions DECISIONS.md/WORKFLOW.md state
-- unambiguously:
--   PENDING_CRO -> PENDING_HSE  (CRO forwards; opens the HSE review
--     window - hse_review_started_at/hse_review_deadline_at, enforced
--     with authoritative backend/database timestamps per SECURITY.md
--     "Time and Enforcement Integrity")
--   PENDING_HSE -> ISSUED       (valid HSE approval, or valid CRO
--     fallback approval once the window has genuinely expired)
--
-- HSE/CRO send-back is NOT implemented here: WORKFLOW.md/DECISIONS.md
-- describe the *action* ("HSE may ... send back to the original creator
-- for correction") but never name the resulting persisted status, unlike
-- PENDING_CRO/PENDING_HSE/ISSUED/CLOSED, which are all explicitly named.
-- Inventing a status for it would be exactly the unresolved behavior
-- this project's process forbids - see the implementation report's
-- "unresolved decisions".
--
-- The gap between the window expiring and CRO actually performing
-- fallback approval is explicitly UNRESOLVED (DECISIONS.md open decision
-- #1: "HSE window expired, fallback approval not yet performed"). No new
-- status is added for it - the permit simply stays PENDING_HSE until an
-- authorized action (HSE approval or CRO fallback approval) occurs.
-- There is deliberately no background job or automatic transition on
-- timeout; eligibility is computed on demand, from database-authoritative
-- time, only when CRO actually attempts fallback approval.

ALTER TABLE permits
  ADD COLUMN hse_review_started_at TIMESTAMPTZ,
  ADD COLUMN hse_review_deadline_at TIMESTAMPTZ;

ALTER TABLE permits DROP CONSTRAINT permits_status_valid;
ALTER TABLE permits ADD CONSTRAINT permits_status_valid
  CHECK (status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED'));

-- Exact per-status pairing: DRAFT/PENDING_CRO never carry HSE-window
-- timestamps (they haven't been forwarded yet); PENDING_HSE/ISSUED
-- always carry both (a permit can't be PENDING_HSE or ISSUED without
-- having actually gone through the forward-to-HSE step that opens the
-- window). Both columns are set together, only by forwardToHseReview.
ALTER TABLE permits ADD CONSTRAINT permits_hse_window_status_consistent CHECK (
  (status IN ('DRAFT', 'PENDING_CRO') AND hse_review_started_at IS NULL AND hse_review_deadline_at IS NULL)
  OR (status IN ('PENDING_HSE', 'ISSUED') AND hse_review_started_at IS NOT NULL AND hse_review_deadline_at IS NOT NULL)
);
-- The HSE review window is exactly 5 minutes - not merely "after start".
ALTER TABLE permits ADD CONSTRAINT permits_hse_deadline_exact CHECK (
  hse_review_deadline_at IS NULL OR hse_review_deadline_at = hse_review_started_at + INTERVAL '5 minutes'
);
-- issued_at is set if and only if the permit is ISSUED.
ALTER TABLE permits ADD CONSTRAINT permits_issued_at_consistent CHECK (
  (status = 'ISSUED') = (issued_at IS NOT NULL)
);

-- Widen the lifecycle event/status domain to the two new transitions.
-- permit_lifecycle_events_event_type_check / _from_status_check /
-- _to_status_check are the names Postgres assigned automatically to the
-- inline, unnamed CHECKs in migration 0006 (its deterministic default
-- for a single-column inline CHECK is "<table>_<column>_check").
ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_type_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_type_check
  CHECK (event_type IN ('CREATED', 'SUBMITTED', 'CRO_FORWARDED_HSE', 'HSE_APPROVED', 'CRO_FALLBACK_APPROVED'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_from_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_from_status_check
  CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE'));

ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_to_status_check;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_to_status_check
  CHECK (to_status IN ('DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED'));

-- Pins each of the two new events to its exact from/to status pair, same
-- as migration 0006 did for CREATED/SUBMITTED - HSE_APPROVED and
-- CRO_FALLBACK_APPROVED are distinguished from each other (both land on
-- ISSUED) so the audit trail records *how* a permit was issued.
ALTER TABLE permit_lifecycle_events DROP CONSTRAINT permit_lifecycle_events_event_status_consistent;
ALTER TABLE permit_lifecycle_events ADD CONSTRAINT permit_lifecycle_events_event_status_consistent CHECK (
  (event_type = 'CREATED' AND from_status IS NULL AND to_status = 'DRAFT')
  OR (event_type = 'SUBMITTED' AND from_status = 'DRAFT' AND to_status = 'PENDING_CRO')
  OR (event_type = 'CRO_FORWARDED_HSE' AND from_status = 'PENDING_CRO' AND to_status = 'PENDING_HSE')
  OR (event_type = 'HSE_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
  OR (event_type = 'CRO_FALLBACK_APPROVED' AND from_status = 'PENDING_HSE' AND to_status = 'ISSUED')
);
