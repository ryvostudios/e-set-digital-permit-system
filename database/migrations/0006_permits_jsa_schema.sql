-- Permit/JSA core domain foundation.
--
-- Implements only what DECISIONS.md/WORKFLOW.md confirm unambiguously: a
-- Draft is created, may be edited while still a Draft, and its first (and
-- only implemented) transition is Submit -> PENDING_CRO. CRO/HSE review,
-- hold/resume, cancel, renewal, and closure are deliberately not
-- implemented yet. The `status` and `permit_lifecycle_events.event_type`
-- domains below are intentionally narrow (covering only what this
-- migration's application code actually writes) and are expected to grow
-- via later migrations as each of those sections is actually built -
-- DATABASE.md: "Actual enum values for permit state beyond what
-- WORKFLOW.md already describes conceptually" are deliberately not
-- decided ahead of implementation.
--
-- Numbering: permit_sequence/jsa_sequence are the authoritative,
-- atomic/unique/concurrency-safe numbering data, generated directly by
-- dedicated sequences (nextval is never reused, even across a rolled
-- back transaction). The human-visible Permit/JSA number FORMAT is
-- explicitly NOT decided here - DECISIONS.md's "CW-1045" example
-- illustrates the numbering *rule* (same/new number across
-- review/renewal), not a confirmed business display format, and
-- DATABASE.md defers "the exact numbering/generation mechanism" to
-- implementation. No prefix/format is stored or guessed anywhere in this
-- schema; formatting a raw sequence value into a display string is a
-- single, swappable seam in the backend
-- (domain/permits/numbering.ts::toDisplayNumber), applied only where a
-- response is rendered - never persisted - so confirming the real format
-- later needs no migration and doesn't touch the numbering/renewal model.

CREATE SEQUENCE permit_number_seq AS BIGINT START WITH 1;
CREATE SEQUENCE jsa_number_seq AS BIGINT START WITH 1;
REVOKE ALL ON SEQUENCE permit_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE jsa_number_seq FROM PUBLIC, anon, authenticated;

-- A Job Safety Analysis. Created together with its permit and kept for
-- the lifetime of that permit's renewal lineage - a renewal (not yet
-- implemented) reuses this same row/jsa_sequence rather than creating a
-- new one.
CREATE TABLE jsas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jsa_sequence BIGINT NOT NULL DEFAULT nextval('jsa_number_seq'),
  created_by UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jsas_jsa_sequence_unique UNIQUE (jsa_sequence)
);
ALTER SEQUENCE jsa_number_seq OWNED BY jsas.jsa_sequence;
ALTER TABLE jsas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE jsas FROM PUBLIC, anon, authenticated;

-- `company` is the one permit form field DECISIONS.md documents
-- concretely ("Company field includes ESET, SGRE, ZPL, Other; choosing
-- Other allows free-text entry"); the rest of the official form layout is
-- deferred to when that section is actually built (DATABASE.md), so no
-- other business fields are added here.
--
-- `previous_permit_id` is the renewal lineage pointer: NULL for an
-- original permit, set on a renewed permit to point back at the permit it
-- renewed. It is only ever set at INSERT time (on the new row), never by
-- updating an old permit row, so issued/closed permit rows are never
-- mutated by a later renewal - DATABASE.md's "never overwrite historical
-- records" / immutable-snapshot principle. Renewal itself is not
-- implemented in this migration's application code.
--
-- `site_timezone` snapshots the backend's configured SITE_TIMEZONE at
-- creation time, so a later change to that configuration cannot silently
-- change how an existing permit's validity is (or was) evaluated.
--
-- `version` is the optimistic-concurrency token: every update increments
-- it, and updates are only applied when the caller's expected version
-- still matches (see domain/permits/service.ts) - a stale write is
-- rejected rather than silently overwritten (SECURITY.md).
CREATE TABLE permits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_sequence BIGINT NOT NULL DEFAULT nextval('permit_number_seq'),
  jsa_id UUID NOT NULL REFERENCES jsas (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  previous_permit_id UUID REFERENCES permits (id) ON DELETE RESTRICT,
  site_timezone TEXT NOT NULL,
  company TEXT,
  company_other TEXT,
  submitted_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permits_permit_sequence_unique UNIQUE (permit_sequence),
  CONSTRAINT permits_version_positive CHECK (version > 0),
  CONSTRAINT permits_site_timezone_not_blank CHECK (btrim(site_timezone) <> ''),
  CONSTRAINT permits_status_valid CHECK (status IN ('DRAFT', 'PENDING_CRO')),
  CONSTRAINT permits_company_valid CHECK (company IS NULL OR company IN ('ESET', 'SGRE', 'ZPL', 'OTHER')),
  CONSTRAINT permits_company_other_required CHECK (
    company IS DISTINCT FROM 'OTHER' OR (company_other IS NOT NULL AND btrim(company_other) <> '')
  ),
  CONSTRAINT permits_previous_not_self CHECK (previous_permit_id IS NULL OR previous_permit_id <> id),
  CONSTRAINT permits_submitted_at_consistent CHECK (submitted_at IS NULL OR status <> 'DRAFT')
);
ALTER SEQUENCE permit_number_seq OWNED BY permits.permit_sequence;
ALTER TABLE permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permits FROM PUBLIC, anon, authenticated;

CREATE INDEX permits_created_by_idx ON permits (created_by);
CREATE INDEX permits_jsa_id_idx ON permits (jsa_id);
CREATE INDEX permits_previous_permit_id_idx ON permits (previous_permit_id);

-- Append-only permit lifecycle/audit history: rows are inserted only,
-- never updated or deleted, by the application (see
-- domain/permits/service.ts) - DATABASE.md requires lifecycle/audit
-- history to be append-only.
CREATE TABLE permit_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  permit_id UUID NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'SUBMITTED')),
  actor_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'PENDING_CRO')),
  to_status TEXT NOT NULL CHECK (to_status IN ('DRAFT', 'PENDING_CRO')),
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Pins each implemented event to its exact from/to status pair, so no
  -- other event/status combination can ever be stored - matches only
  -- what domain/permits/service.ts actually writes (CREATED: NULL ->
  -- DRAFT; SUBMITTED: DRAFT -> PENDING_CRO). Extend this constraint
  -- alongside event_type/status when a future section adds more events.
  CONSTRAINT permit_lifecycle_events_event_status_consistent CHECK (
    (event_type = 'CREATED' AND from_status IS NULL AND to_status = 'DRAFT')
    OR (event_type = 'SUBMITTED' AND from_status = 'DRAFT' AND to_status = 'PENDING_CRO')
  )
);
ALTER TABLE permit_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit_lifecycle_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE permit_lifecycle_events_ordinal_seq FROM PUBLIC, anon, authenticated;

CREATE INDEX permit_lifecycle_events_permit_id_idx ON permit_lifecycle_events (permit_id);

-- Database-enforced append-only, for any role including the backend's
-- own - see forbid_mutation() in migration 0004_privileged_access.sql for
-- why a trigger (not just RLS/REVOKE) is required here.
CREATE TRIGGER permit_lifecycle_events_append_only
  BEFORE UPDATE OR DELETE ON permit_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- TRUNCATE bypasses row-level triggers (and RLS) entirely, so it needs
-- its own statement-level trigger to be blocked - see the matching note
-- in migration 0004_privileged_access.sql.
CREATE TRIGGER permit_lifecycle_events_no_truncate
  BEFORE TRUNCATE ON permit_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
