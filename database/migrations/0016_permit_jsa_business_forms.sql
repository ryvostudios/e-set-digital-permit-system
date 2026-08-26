-- Permit/JSA business form content, workforce signing identity, and
-- authoritative digital signatures.
--
-- Migrations 0001-0015 are immutable, applied history and are never
-- edited by this file. Every change here is additive, except two
-- deliberately-widened allowlists (`permit_document_jobs`'s renderer
-- identity) which remain explicit allowlists and stay a strict superset
-- of what they replace, so no previously-valid row becomes invalid.
--
-- MODEL: hybrid relational + strictly validated versioned JSONB.
--   * Workflow/search/lifecycle fields that the backend queries, joins,
--     filters or constrains on stay real relational columns.
--   * The permit-type-specific and JSA form CONTENT is stored as a
--     versioned JSONB payload (`form_version` + `form_payload`),
--     validated by the matching strict Zod schema
--     (backend/src/domain/permits/forms.ts) BEFORE it is ever written -
--     unknown properties are rejected, and a payload for one permit
--     template can never be stored against another template.
--   * The promoted relational columns (`wind_farm`, `wtg_number`,
--     `work_description`, `loto_number`, `jsas.site_or_wtg`,
--     `jsas.job_description`) are SERVER-DERIVED PROJECTIONS of the
--     validated payload, written in the same statement as the payload
--     itself, never independently client-supplied. The JSONB payload
--     remains the authoritative form content.
--
-- NOTHING in this migration invents a business rule, a checklist
-- question, a status, a capability, or a number format. Open decisions
-- (behavior in the gap after HSE window expiry, whether closure remarks
-- are mandatory, the human-visible Permit/JSA number format) are
-- untouched.

-- =====================================================================
-- 1. Workforce signing identity
-- =====================================================================
--
-- The system had no trustworthy employee display-name source: Supabase
-- Auth carries only an email and client-writable `user_metadata`, and
-- neither may ever appear on a permit as a person's authoritative
-- signature. This is the smallest normalized authoritative identity
-- model that digital signatures require - a display name plus the
-- primary Team + Position that is the AUTHORITATIVE SIGNING DESIGNATION
-- printed next to that name.
--
-- Authorization is COMPLETELY UNCHANGED by this table: capabilities are
-- still derived only from user_team_positions -> team_positions ->
-- team_position_capabilities -> capabilities (migration 0002). The
-- signing designation names which of a user's assignments is printed on
-- a document; it grants nothing and is never consulted by
-- authz/capabilities.ts.
--
-- The composite foreign key below is the database-enforced guarantee
-- that a user's primary (signing) assignment is an assignment THAT SAME
-- USER actually holds - it references `user_team_positions
-- (user_id, team_position_id)`, which migration 0002 already made
-- UNIQUE, so a profile can never designate a Team + Position belonging
-- to somebody else, and the underlying assignment cannot be deleted out
-- from under a profile (ON DELETE RESTRICT).
--
-- No row is inserted here. Existing Auth identities deliberately do NOT
-- receive an invented display name - provisioning is an explicit,
-- separate step performed after this migration. Until a user has a
-- profile, every action that would produce a signature FAILS CLOSED (see
-- backend/src/domain/permits/signatures.ts); the backend never falls
-- back to an email, `user_metadata`, a client-supplied name, or a
-- client-supplied position.
CREATE TABLE workforce_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  primary_team_position_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workforce_profiles_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT workforce_profiles_primary_assignment_held_by_user
    FOREIGN KEY (user_id, primary_team_position_id)
    REFERENCES user_team_positions (user_id, team_position_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Timestamps are database-authoritative (never client- or
-- application-clock supplied), matching migration 0015's
-- app_user_access trigger exactly: SECURITY INVOKER with a pinned
-- search_path, and `created_at` is preserved across updates.
CREATE FUNCTION public.workforce_profiles_authoritative_timestamps() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workforce_profiles_authoritative_timestamps() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workforce_profiles_authoritative_timestamps_trigger
  BEFORE INSERT OR UPDATE ON workforce_profiles
  FOR EACH ROW EXECUTE FUNCTION public.workforce_profiles_authoritative_timestamps();

ALTER TABLE workforce_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE workforce_profiles FROM PUBLIC, anon, authenticated;

-- Supports the ON DELETE/UPDATE RESTRICT checks on the composite FK
-- above (Postgres has no index on the referencing side by default).
CREATE INDEX workforce_profiles_primary_team_position_idx
  ON workforce_profiles (primary_team_position_id);

-- =====================================================================
-- 2. Permit business form content
-- =====================================================================
--
-- A permit now has exactly one of the four confirmed V1 templates.
-- `permit_type` is the relational, searchable, constraint-bearing field;
-- `form_version` pins which schema version validated `form_payload`, so
-- an already-stored payload is always interpretable by the exact schema
-- that accepted it even after a future V2 is added.
ALTER TABLE permits
  ADD COLUMN permit_type TEXT,
  ADD COLUMN form_version TEXT,
  ADD COLUMN form_payload JSONB,
  ADD COLUMN wind_farm TEXT,
  ADD COLUMN wtg_number TEXT,
  ADD COLUMN work_description TEXT,
  ADD COLUMN loto_number TEXT;

ALTER TABLE permits ADD CONSTRAINT permits_permit_type_valid CHECK (
  permit_type IS NULL
  OR permit_type IN ('WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY')
);

-- The permit type and its form version can never disagree: a WTG_WORK
-- permit can only ever carry a WTG_WORK_V1 payload, so a payload
-- belonging to a different template cannot be stored against this permit
-- even if application validation were somehow bypassed.
-- Written NULL-safely on purpose: a CHECK that evaluates to NULL is
-- SATISFIED in PostgreSQL, so the IS NOT NULL guards below are what make
-- "a version without a type" (and vice versa) genuinely impossible,
-- rather than quietly allowed by three-valued logic.
ALTER TABLE permits ADD CONSTRAINT permits_form_version_matches_type CHECK (
  (permit_type IS NULL AND form_version IS NULL)
  OR (
    permit_type IS NOT NULL AND form_version IS NOT NULL
    AND (
      (permit_type = 'WTG_WORK' AND form_version = 'WTG_WORK_V1')
      OR (permit_type = 'COLD_WORK' AND form_version = 'COLD_WORK_V1')
      OR (permit_type = 'HOT_WORK' AND form_version = 'HOT_WORK_V1')
      OR (permit_type = 'CONFINED_SPACE_ENTRY' AND form_version = 'CONFINED_SPACE_ENTRY_V1')
    )
  )
);

-- A payload is always a JSON object (never a bare scalar/array), and
-- never exists without the type/version that says how to read it.
ALTER TABLE permits ADD CONSTRAINT permits_form_payload_typed CHECK (
  form_payload IS NULL
  OR (permit_type IS NOT NULL AND jsonb_typeof(form_payload) = 'object')
);

-- Existing rows are checked BEFORE the completeness constraint below is
-- installed. Any permit that already left DRAFT predates the form model
-- and cannot be given form content without inventing business data, so
-- the whole migration aborts with an explicit message rather than
-- silently fabricating or weakening the invariant.
DO $$
DECLARE
  legacy_count BIGINT;
BEGIN
  SELECT count(*) INTO legacy_count FROM public.permits WHERE status <> 'DRAFT';
  IF legacy_count <> 0 THEN
    RAISE EXCEPTION
      '0016 refused: % permit(s) are already beyond DRAFT and predate the permit form model; their form content cannot be invented. Remove these pre-form records (they are pre-go-live test data) and re-run.',
      legacy_count;
  END IF;
END;
$$;

-- Completeness floor: a permit may only be incomplete while it is still
-- a DRAFT. The instant it is submitted (or is created directly as ISSUED
-- by renewal), its type, form version and payload must all be present -
-- database-enforced, not merely checked in application code.
ALTER TABLE permits ADD CONSTRAINT permits_form_required_after_draft CHECK (
  status = 'DRAFT'
  OR (permit_type IS NOT NULL AND form_version IS NOT NULL AND form_payload IS NOT NULL)
);

CREATE INDEX permits_permit_type_idx ON permits (permit_type);
CREATE INDEX permits_wtg_number_idx ON permits (wtg_number) WHERE wtg_number IS NOT NULL;

-- =====================================================================
-- 3. JSA business form content
-- =====================================================================
--
-- One shared JSA_V1 across all four permit templates (the confirmed
-- decision). The JSA row is still created with, and reused by, its
-- permit lineage exactly as migration 0006 defined - renewal continues
-- to reuse the SAME jsa row/number, so a renewed permit reuses this same
-- payload with no copy and no edit to historical JSA data.
ALTER TABLE jsas
  ADD COLUMN form_version TEXT,
  ADD COLUMN form_payload JSONB,
  ADD COLUMN site_or_wtg TEXT,
  ADD COLUMN job_description TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- NULL-safe for the same reason as permits_form_version_matches_type above.
ALTER TABLE jsas ADD CONSTRAINT jsas_form_payload_consistent CHECK (
  (form_version IS NULL AND form_payload IS NULL)
  OR (
    form_version IS NOT NULL AND form_version = 'JSA_V1'
    AND form_payload IS NOT NULL AND jsonb_typeof(form_payload) = 'object'
  )
);

CREATE FUNCTION public.jsas_authoritative_timestamps() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.jsas_authoritative_timestamps() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER jsas_authoritative_timestamps_trigger
  BEFORE INSERT OR UPDATE ON jsas
  FOR EACH ROW EXECUTE FUNCTION public.jsas_authoritative_timestamps();

-- Cross-table completeness: a permit may not leave DRAFT while its
-- linked JSA has no payload. A CHECK constraint cannot see another
-- table, so this is a deferrable-capable constraint trigger - the same
-- mechanism migration 0015 already uses for cross-table lifecycle
-- attribution.
CREATE FUNCTION public.permit_requires_completed_jsa() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  linked_payload JSONB;
BEGIN
  IF NEW.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  SELECT form_payload INTO linked_payload FROM public.jsas WHERE id = NEW.jsa_id;
  IF linked_payload IS NULL THEN
    RAISE EXCEPTION 'permit % cannot leave DRAFT while its linked JSA has no completed form', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.permit_requires_completed_jsa() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER permits_require_completed_jsa
  AFTER INSERT OR UPDATE ON permits
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION public.permit_requires_completed_jsa();

-- =====================================================================
-- 4. Authoritative digital signatures
-- =====================================================================
--
-- A signature row is created ONLY as a side effect of an authenticated
-- workflow action, inside that action's own transaction, and its
-- identity is copied from `workforce_profiles` + the signer's primary
-- Team + Position at that instant. The copied name/team/position are
-- what make historical documents stable: a later profile rename or a
-- later change of primary assignment cannot reach back into a signature
-- that was already recorded.
--
-- No API accepts a signer name, designation or user id - the applicant
-- signs by performing the authenticated submission, CRO by performing
-- the authenticated CRO action, HSE by performing the authenticated HSE
-- approval. The guard function below enforces that at the database
-- level, not merely in application code:
--   * the signature's permit must be the lifecycle event's permit;
--   * the signer must BE that lifecycle event's authenticated actor;
--   * each signature role is pinned to the exact event type that can
--     produce it - in particular CRO_FALLBACK_APPROVED can only ever
--     produce a CRO_FALLBACK signature, so a fallback approval can never
--     fabricate an HSE signature.
--
-- Append-only, for every role including the backend's own, using the
-- same forbid_mutation() mechanism as permit_lifecycle_events (0006) and
-- issued_document_snapshots (0013).
CREATE TABLE permit_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
  source_event_id UUID NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT,
  signature_role TEXT NOT NULL,
  signer_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  signer_display_name TEXT NOT NULL,
  signer_team_position_id UUID NOT NULL REFERENCES team_positions (id) ON DELETE RESTRICT,
  signer_team_name TEXT NOT NULL,
  signer_position_name TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permit_signatures_role_valid CHECK (
    signature_role IN ('APPLICANT', 'CRO', 'HSE', 'CRO_FALLBACK', 'RENEWAL')
  ),
  CONSTRAINT permit_signatures_display_name_not_blank CHECK (btrim(signer_display_name) <> ''),
  CONSTRAINT permit_signatures_team_name_not_blank CHECK (btrim(signer_team_name) <> ''),
  CONSTRAINT permit_signatures_position_name_not_blank CHECK (btrim(signer_position_name) <> ''),
  -- Exactly one signature per authenticated signing action. A retried or
  -- racing transaction can never record the same act twice.
  CONSTRAINT permit_signatures_source_event_unique UNIQUE (source_event_id)
);
ALTER TABLE permit_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit_signatures FROM PUBLIC, anon, authenticated;

CREATE INDEX permit_signatures_permit_role_idx ON permit_signatures (permit_id, signature_role);

CREATE FUNCTION public.permit_signature_authenticity_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_permit UUID;
  event_type TEXT;
  event_actor UUID;
BEGIN
  SELECT e.permit_id, e.event_type, e.actor_user_id
    INTO event_permit, event_type, event_actor
    FROM public.permit_lifecycle_events e
   WHERE e.id = NEW.source_event_id;

  IF event_permit IS NULL OR NEW.permit_id IS DISTINCT FROM event_permit THEN
    RAISE EXCEPTION 'signature lifecycle event does not belong to its permit';
  END IF;

  -- The signer IS the authenticated actor of the recorded action. No
  -- signature can ever name anybody other than the person whose
  -- authenticated action produced it.
  IF NEW.signer_user_id IS DISTINCT FROM event_actor THEN
    RAISE EXCEPTION 'signature signer is not the authenticated actor of its lifecycle event';
  END IF;

  IF NOT (
    (NEW.signature_role = 'APPLICANT' AND event_type IN ('SUBMITTED', 'APPLICANT_RESUBMITTED'))
    OR (NEW.signature_role = 'CRO' AND event_type = 'CRO_FORWARDED_HSE')
    OR (NEW.signature_role = 'HSE' AND event_type = 'HSE_APPROVED')
    OR (NEW.signature_role = 'CRO_FALLBACK' AND event_type = 'CRO_FALLBACK_APPROVED')
    OR (NEW.signature_role = 'RENEWAL' AND event_type = 'RENEWED')
  ) THEN
    RAISE EXCEPTION 'signature role % does not match lifecycle event type %', NEW.signature_role, event_type;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.permit_signature_authenticity_guard() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER permit_signatures_authenticity
  AFTER INSERT OR UPDATE ON permit_signatures
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION public.permit_signature_authenticity_guard();

CREATE TRIGGER permit_signatures_append_only
  BEFORE UPDATE OR DELETE ON permit_signatures
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER permit_signatures_no_truncate
  BEFORE TRUNCATE ON permit_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- =====================================================================
-- 5. Deterministic renderer identity for the combined Permit + JSA PDF
-- =====================================================================
--
-- The issued document now renders Permit page(s) -> JSA page 1 -> JSA
-- page 2 from the immutable snapshot, which is a different renderer from
-- the one migration 0015 pinned as 'PDFKIT_V1'. The allowlist is widened
-- (never replaced): 'PDFKIT_V1' remains valid so any historical job row
-- stays valid, and the restrict-update trigger from 0015 still refuses
-- to change an already-established renderer_version/expected_file_hash
-- or to touch a GENERATED row at all.
ALTER TABLE permit_document_jobs DROP CONSTRAINT permit_document_jobs_render_identity_consistent;
ALTER TABLE permit_document_jobs
  ADD CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
    (renderer_version IS NULL AND expected_file_hash IS NULL)
    OR (
      renderer_version IN ('PDFKIT_V1', 'PDFKIT_V2')
      AND expected_file_hash IS NOT NULL
      AND btrim(expected_file_hash) <> ''
    )
  );

-- No new capability is seeded, no policy is created, no anon/
-- authenticated grant is issued anywhere in this migration, and no
-- SECURITY DEFINER function is introduced. Every new table follows the
-- established RLS-enabled + REVOKE ALL FROM PUBLIC, anon, authenticated
-- pattern; every new trigger function is SECURITY INVOKER with a pinned
-- search_path (migration 0014's hardening).
