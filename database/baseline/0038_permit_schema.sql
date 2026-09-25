-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Regenerate with database/baseline/tools/generate-baseline.sh.
--
-- Permit schema objects at migration 0038 (tables, sequences, constraints, indexes, functions, triggers, RLS).
--
-- Source: Permit migrations 0001-0038 (hashes in manifest.json), replayed on
-- a disposable cluster and moved from schema public to schema permit.
-- Installed only by the Permit migration runner, as permit_migrator, in
-- one transaction together with 0038_permit_privileges.sql.
--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: permit; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA permit; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: account_audit_events_authoritative_timestamp(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.account_audit_events_authoritative_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: allocate_permit_sequence(text); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.allocate_permit_sequence(p_permit_type text) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'permit'
    AS $$
DECLARE
  allocated BIGINT;
BEGIN
  UPDATE permit_number_counters
     SET next_value = next_value + 1,
         updated_at = now()
   WHERE permit_type = p_permit_type
  RETURNING next_value - 1 INTO allocated;

  IF allocated IS NULL THEN
    -- A permit type with no counter must fail the insert outright rather
    -- than fall back to some other series.
    RAISE EXCEPTION 'no permit number counter exists for permit_type %', p_permit_type;
  END IF;

  RETURN allocated;
END;
$$;


--
-- Name: app_user_access_authoritative_timestamps(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.app_user_access_authoritative_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.credentials_changed_at := CASE WHEN NEW.credentials_changed_at IS NULL THEN NULL ELSE now() END;
  ELSE
    NEW.created_at := OLD.created_at;
    IF NEW.credential_version < OLD.credential_version THEN
      RAISE EXCEPTION 'credential_version cannot decrease';
    END IF;
    -- DELETED is terminal. Nothing may bring an account back from it -
    -- not a re-enable, not a bug, not a hand-written UPDATE.
    IF OLD.state = 'DELETED' AND NEW.state <> 'DELETED' THEN
      RAISE EXCEPTION 'a DELETED account is terminal and cannot be reactivated';
    END IF;
    NEW.credentials_changed_at := CASE
      WHEN NEW.credentials_changed_at IS DISTINCT FROM OLD.credentials_changed_at THEN now()
      ELSE OLD.credentials_changed_at
    END;
  END IF;
  NEW.updated_at := now();
  NEW.disabled_at := CASE WHEN NEW.state = 'DISABLED' THEN COALESCE(OLD.disabled_at, now()) ELSE NULL END;
  NEW.deleted_at := CASE WHEN NEW.state = 'DELETED' THEN COALESCE(OLD.deleted_at, now()) ELSE NULL END;
  RETURN NEW;
END;
$$;


--
-- Name: companies_authoritative_created_at(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.companies_authoritative_created_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: companies_freeze_identity(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.companies_freeze_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'company id is immutable (company %)', OLD.id;
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'company code is immutable (company %, code %)', OLD.id, OLD.code;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: companies_guard_deactivation(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.companies_guard_deactivation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM permit.workforce_profiles wp
    JOIN permit.app_user_access a ON a.user_id = wp.user_id
   WHERE wp.company_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'company % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := permit.organization_required_coverage_gap(NEW.id, NULL, NULL);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating company % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: forbid_mutation(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted - this table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;


--
-- Name: grant_baseline_applicant_capabilities(uuid); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.grant_baseline_applicant_capabilities(p_team_position_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  available BIGINT;
  attached BIGINT;
BEGIN
  IF p_team_position_id IS NULL THEN
    RAISE EXCEPTION 'a team position is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permit.team_positions WHERE id = p_team_position_id) THEN
    RAISE EXCEPTION 'team position % does not exist', p_team_position_id;
  END IF;

  SELECT count(*) INTO available
    FROM permit.capabilities
   WHERE name IN ('permit.create', 'permit.submit');
  IF available <> 2 THEN
    RAISE EXCEPTION
      'the baseline applicant capabilities are not both defined (found %); refusing to create a partially capable Team + Position',
      available;
  END IF;

  INSERT INTO permit.team_position_capabilities (team_position_id, capability_id)
  SELECT p_team_position_id, c.id
    FROM permit.capabilities c
   WHERE c.name IN ('permit.create', 'permit.submit')
  ON CONFLICT DO NOTHING;

  -- Prove the postcondition rather than assume it: after this call the
  -- association holds both baseline capabilities, or the transaction
  -- fails.
  SELECT count(*) INTO attached
    FROM permit.team_position_capabilities tpc
    JOIN permit.capabilities c ON c.id = tpc.capability_id
   WHERE tpc.team_position_id = p_team_position_id
     AND c.name IN ('permit.create', 'permit.submit');
  IF attached <> 2 THEN
    RAISE EXCEPTION
      'team position % did not receive both baseline applicant capabilities (has %)',
      p_team_position_id, attached;
  END IF;
END;
$$;


--
-- Name: jsas_authoritative_timestamps(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.jsas_authoritative_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
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


--
-- Name: jsas_content_editable_only(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.jsas_content_editable_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'permit'
    AS $$
DECLARE
  linked_total INTEGER;
  linked_locked INTEGER;
  locked_status TEXT;
BEGIN
  IF NEW.form_version IS NOT DISTINCT FROM OLD.form_version
     AND NEW.form_payload IS NOT DISTINCT FROM OLD.form_payload
     AND NEW.site_or_wtg IS NOT DISTINCT FROM OLD.site_or_wtg
     AND NEW.job_description IS NOT DISTINCT FROM OLD.job_description THEN
    RETURN NEW;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status NOT IN ('DRAFT', 'PENDING_CORRECTION')),
         min(status) FILTER (WHERE status NOT IN ('DRAFT', 'PENDING_CORRECTION'))
    INTO linked_total, linked_locked, locked_status
    FROM permit.permits
   WHERE jsa_id = OLD.id;

  -- No visible linked permit means there is nothing that authorizes
  -- editing this JSA. The application only ever reaches a JSA through
  -- its permit, so this cannot happen on a legitimate path.
  IF linked_total = 0 THEN
    RAISE EXCEPTION 'JSA content cannot be changed: no editable permit is linked to this JSA';
  END IF;

  IF linked_locked > 0 THEN
    RAISE EXCEPTION 'JSA content cannot be changed while a linked permit is %', locked_status;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: notifications_restrict_update(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.notifications_restrict_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.recipient_user_id <> OLD.recipient_user_id
     OR NEW.permit_id IS DISTINCT FROM OLD.permit_id
     OR NEW.source_event_id <> OLD.source_event_id
     OR NEW.notification_type <> OLD.notification_type
     OR NEW.title <> OLD.title
     OR NEW.message <> OLD.message
     OR NEW.created_at <> OLD.created_at
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
  THEN
    RAISE EXCEPTION 'notification business fields and an existing read receipt are immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: organization_audit_events_authoritative_timestamp(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.organization_audit_events_authoritative_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: organization_required_coverage_gap(uuid, uuid, uuid); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.organization_required_coverage_gap(p_company_id uuid, p_team_id uuid, p_team_position_id uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT required.name
    FROM (VALUES
      ('permit.cro_review', 1),
      ('permit.hse_review', 1)
    ) AS required (name, minimum)
    JOIN permit.capabilities cap ON cap.name = required.name
    JOIN permit.team_position_capabilities tpc ON tpc.capability_id = cap.id
    JOIN permit.team_positions tp ON tp.id = tpc.team_position_id
    JOIN permit.teams t ON t.id = tp.team_id
    JOIN permit.companies c ON c.id = t.company_id
   WHERE tp.deactivated_at IS NULL
     AND t.deactivated_at IS NULL
     AND c.deactivated_at IS NULL
   GROUP BY required.name, required.minimum
  -- `count(*)` is coverage as it stands; the FILTERed count is coverage
  -- as it WOULD stand, excluding whatever this action retires.
  --
  -- A DEGRADED REQUIREMENT MUST NOT FREEZE THE ORGANIZATION. Comparing
  -- the post-action count against the minimum alone would refuse every
  -- deactivation for as long as coverage sat below it - including
  -- actions that have nothing to do with the capability, and including
  -- the very reassignments an administrator needs in order to restore
  -- coverage. So the bar is LEAST(minimum, current): an action is
  -- refused only when it NEWLY breaks the minimum, or REDUCES a count
  -- that is already short. An action that leaves the count untouched is
  -- always allowed, whatever the state.
  --
  --   min 1, now 1, after 0  -> 0 < least(1,1)=1  REFUSED  (newly breaks)
  --   min 1, now 0, after 0  -> 0 < least(1,0)=0  allowed  (unrelated)
  --   min 2, now 1, after 0  -> 0 < least(2,1)=1  REFUSED  (worsens)
  --   min 2, now 1, after 1  -> 1 < least(2,1)=1  allowed  (unrelated)
  --   min 2, now 3, after 1  -> 1 < least(2,3)=2  REFUSED  (newly breaks)
  --
  -- A capability with NO active holder at all produces no group here, so
  -- it is allowed - which is the same answer this predicate gives for
  -- `now 0, after 0`, so the two paths agree.
  HAVING count(*) FILTER (
           WHERE NOT (
             (p_company_id       IS NOT NULL AND c.id  = p_company_id)
             OR (p_team_id          IS NOT NULL AND t.id  = p_team_id)
             OR (p_team_position_id IS NOT NULL AND tp.id = p_team_position_id)
           )
         ) < LEAST(required.minimum, count(*))
   ORDER BY required.name
   LIMIT 1;
$$;


--
-- Name: permit_document_jobs_restrict_update(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.permit_document_jobs_restrict_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF OLD.status = 'GENERATED' THEN
    RAISE EXCEPTION 'generated document job is immutable';
  END IF;
  IF NEW.snapshot_id <> OLD.snapshot_id
     OR (OLD.renderer_version IS NOT NULL AND NEW.renderer_version IS DISTINCT FROM OLD.renderer_version)
     OR (OLD.expected_file_hash IS NOT NULL AND NEW.expected_file_hash IS DISTINCT FROM OLD.expected_file_hash)
  THEN
    RAISE EXCEPTION 'document attribution and established render identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: permit_requires_completed_jsa(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.permit_requires_completed_jsa() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  linked_payload JSONB;
BEGIN
  IF NEW.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  SELECT form_payload INTO linked_payload FROM permit.jsas WHERE id = NEW.jsa_id;
  IF linked_payload IS NULL THEN
    RAISE EXCEPTION 'permit % cannot leave DRAFT while its linked JSA has no completed form', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: permit_signature_authenticity_guard(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.permit_signature_authenticity_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  event_permit UUID;
  event_type TEXT;
  event_actor UUID;
BEGIN
  SELECT e.permit_id, e.event_type, e.actor_user_id
    INTO event_permit, event_type, event_actor
    FROM permit.permit_lifecycle_events e
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


--
-- Name: permits_assign_permit_sequence(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.permits_assign_permit_sequence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'permit'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A DRAFT IS NEVER NUMBERED. Not a typed one, not an untyped one, not
    -- one that arrives carrying a number someone put in the request. This
    -- is checked FIRST so no later branch can be read as an exception to
    -- it: whatever else is true of the row, a draft leaves here with NULL.
    IF NEW.status = 'DRAFT' THEN
      NEW.permit_sequence := NULL;
      RETURN NEW;
    END IF;

    IF NEW.permit_type IS NULL THEN
      -- A pre-form permit created already past DRAFT. These predate the
      -- permit type and have no series of their own, so they keep the
      -- original global sequence - the only remaining use of it, and one
      -- no current application path takes.
      IF NEW.permit_sequence IS NULL THEN
        NEW.permit_sequence := nextval('permit_number_seq');
      END IF;
      RETURN NEW;
    END IF;

    -- Created already past DRAFT with a type - a renewal. It is a permit
    -- from the moment it exists, so it is numbered from the moment it
    -- exists, out of its OWN type's series.
    NEW.permit_sequence := permit.allocate_permit_sequence(NEW.permit_type);
    RETURN NEW;
  END IF;

  -- ---------------- UPDATE ----------------
  --
  -- A SUBMITTED PERMIT NEVER GOES BACK TO BEING A DRAFT. No workflow does
  -- it, and allowing it would be a way to strip a permit of its number by
  -- the back door.
  IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION
      'permit % has already been submitted and cannot return to DRAFT', OLD.id;
  END IF;

  -- ONCE ISSUED, PERMANENT. A number that was issued at submission is
  -- never changed, cleared or recycled.
  IF OLD.status <> 'DRAFT'
     AND OLD.permit_sequence IS NOT NULL
     AND NEW.permit_sequence IS DISTINCT FROM OLD.permit_sequence
  THEN
    RAISE EXCEPTION
      'permit % already carries permit number %; a permit number is permanent and is never reassigned or recycled',
      OLD.id, OLD.permit_sequence;
  END IF;

  -- A DRAFT STAYS UNNUMBERED, however many times it is saved and whatever
  -- a request tries to put in the column. (A number a draft holds from
  -- the older rule is released here rather than frozen - it was never
  -- part of the register, because nothing was ever submitted under it.)
  IF NEW.status = 'DRAFT' THEN
    NEW.permit_sequence := NULL;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    -- THE FIRST SUCCESSFUL SUBMISSION, and the only place a permit gets
    -- its number. It happens inside the caller's transaction, so a
    -- submission that fails or rolls back leaves the permit a DRAFT with
    -- no number and consumes nothing.
    --
    -- The type must be known by now: the per-type series IS the register,
    -- and there is no series to draw from without one. A draft that
    -- somehow reached submission untyped is refused rather than quietly
    -- given a number from the legacy global sequence - that sequence
    -- exists for historical rows, not for new submissions.
    IF NEW.permit_type IS NULL THEN
      RAISE EXCEPTION
        'permit % cannot be submitted without a permit type: a permit number is issued from its type''s own series',
        NEW.id;
    END IF;
    NEW.permit_sequence := permit.allocate_permit_sequence(NEW.permit_type);
    RETURN NEW;
  END IF;

  -- Nothing may sit past DRAFT unnumbered by some other path.
  IF NEW.permit_sequence IS NULL THEN
    RAISE EXCEPTION 'permit % cannot leave DRAFT without a permit number', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: permits_freeze_applicant_identity(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.permits_freeze_applicant_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF OLD.applicant_display_name IS NOT NULL
     AND NEW.applicant_display_name IS DISTINCT FROM OLD.applicant_display_name THEN
    RAISE EXCEPTION 'the applicant identity of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_code IS NOT NULL
     AND NEW.applicant_company_code IS DISTINCT FROM OLD.applicant_company_code THEN
    RAISE EXCEPTION 'the applicant company of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_name IS NOT NULL
     AND NEW.applicant_company_name IS DISTINCT FROM OLD.applicant_company_name THEN
    RAISE EXCEPTION 'the applicant company name of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_id IS NOT NULL
     AND NEW.applicant_company_id IS DISTINCT FROM OLD.applicant_company_id THEN
    RAISE EXCEPTION 'the applicant company identity of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: privileged_identities_authoritative_timestamps(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.privileged_identities_authoritative_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
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


--
-- Name: record_site_manager_grant(uuid, uuid, text); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.record_site_manager_grant(p_actor_user_id uuid, p_target_user_id uuid, p_action text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  actor_is_ceo BOOLEAN;
  target_is_ceo BOOLEAN;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('GRANTED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid privileged action %', p_action;
  END IF;
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'both an actor and a target are required';
  END IF;
  IF p_actor_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'a CEO may not change their own privileged role';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM permit.privileged_access_events
       WHERE user_id = p_actor_user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.role = 'CEO' AND latest.action = 'GRANTED'
  ) INTO actor_is_ceo;
  IF NOT actor_is_ceo THEN
    RAISE EXCEPTION 'only an active CEO may administer SITE_MANAGER';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permit.app_user_access WHERE user_id = p_target_user_id) THEN
    RAISE EXCEPTION 'target account % does not exist', p_target_user_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM permit.privileged_access_events
       WHERE user_id = p_target_user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.role = 'CEO' AND latest.action = 'GRANTED'
  ) INTO target_is_ceo;
  IF target_is_ceo THEN
    RAISE EXCEPTION 'the CEO tier is not administrable through SITE_MANAGER administration';
  END IF;

  IF p_action = 'GRANTED' THEN
    -- Redundant with the trigger in section 2, deliberately: this path
    -- must refuse a promotion on its own terms, not merely as a side
    -- effect of a guard someone could later reason about separately.
    IF EXISTS (SELECT 1 FROM permit.workforce_profiles WHERE user_id = p_target_user_id) THEN
      RAISE EXCEPTION 'user % is a normal workforce employee and cannot receive privileged access', p_target_user_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM permit.privileged_identities WHERE user_id = p_target_user_id) THEN
      RAISE EXCEPTION 'user % has no authoritative privileged identity', p_target_user_id;
    END IF;
  END IF;

  -- 'SITE_MANAGER' is a hardcoded literal, never a parameter.
  INSERT INTO permit.privileged_access_events (user_id, role, action, actor_user_id, reason)
  VALUES (
    p_target_user_id,
    'SITE_MANAGER',
    p_action,
    p_actor_user_id,
    CASE WHEN p_action = 'GRANTED' THEN 'SITE_MANAGER granted by CEO' ELSE 'SITE_MANAGER revoked by CEO' END
  );
END;
$$;


--
-- Name: reject_individually_grantable_team_position(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.reject_individually_grantable_team_position() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM permit.capabilities
     WHERE id = NEW.capability_id AND individually_grantable
  ) THEN
    RAISE EXCEPTION
      'capability % is an INDIVIDUAL permission and must not be attached to a Team + Position',
      NEW.capability_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: reject_privileged_grant_for_employee(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.reject_privileged_grant_for_employee() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM permit.workforce_profiles WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION
      'user % is a normal workforce employee and must not be granted privileged system access; retire the organizational identity first as an explicit transition',
      NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: support_event_linkage_guard(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.support_event_linkage_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  authoritative_type TEXT;
  authoritative_permit UUID;
BEGIN
  SELECT event_type, permit_id INTO authoritative_type, authoritative_permit
    FROM permit.permit_lifecycle_events WHERE id = NEW.source_event_id;
  IF authoritative_permit IS NULL OR NEW.permit_id IS DISTINCT FROM authoritative_permit THEN
    RAISE EXCEPTION 'support row lifecycle event does not belong to its permit';
  END IF;
  IF TG_TABLE_NAME = 'issued_document_snapshots'
     AND authoritative_type NOT IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'RENEWED') THEN
    RAISE EXCEPTION 'snapshot source is not an issuance lifecycle event';
  END IF;
  IF TG_TABLE_NAME = 'whatsapp_outbox_messages'
     AND NOT (
       ((to_jsonb(NEW)->>'event_type') = 'ISSUED' AND authoritative_type IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED'))
       OR ((to_jsonb(NEW)->>'event_type') = authoritative_type
           AND (to_jsonb(NEW)->>'event_type') IN ('HELD', 'RESUMED', 'CANCELLED', 'RENEWED', 'CLOSED'))
     ) THEN
    RAISE EXCEPTION 'WhatsApp event type does not match its lifecycle event';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: team_positions_guard_deactivation(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.team_positions_guard_deactivation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM permit.workforce_profiles wp
    JOIN permit.app_user_access a ON a.user_id = wp.user_id
   WHERE wp.primary_team_position_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'team position % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := permit.organization_required_coverage_gap(NULL, NULL, NEW.id);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating team position % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: team_positions_require_active_team(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.team_positions_require_active_team() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM permit.teams t
      JOIN permit.companies c ON c.id = t.company_id
     WHERE t.id = NEW.team_id
       AND (t.deactivated_at IS NOT NULL OR c.deactivated_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'team % is inactive, or belongs to an inactive company, and cannot receive new positions',
      NEW.team_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: teams_guard_deactivation(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.teams_guard_deactivation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM permit.workforce_profiles wp
    JOIN permit.app_user_access a ON a.user_id = wp.user_id
    JOIN permit.team_positions tp ON tp.id = wp.primary_team_position_id
   WHERE tp.team_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'team % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := permit.organization_required_coverage_gap(NULL, NEW.id, NULL);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating team % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: teams_require_active_company(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.teams_require_active_company() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM permit.companies
     WHERE id = NEW.company_id AND deactivated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'company % is inactive and cannot receive new teams', NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: user_capability_grants_authoritative_timestamp(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.user_capability_grants_authoritative_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: user_capability_grants_guard(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.user_capability_grants_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permit.capabilities
     WHERE id = NEW.capability_id AND individually_grantable
  ) THEN
    RAISE EXCEPTION
      'capability % may not be granted to an individual user; only Team + Position grants it',
      NEW.capability_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM permit.privileged_access_events
       WHERE user_id = NEW.user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.action = 'GRANTED'
  ) THEN
    RAISE EXCEPTION
      'user % is a privileged system account and does not receive individual organizational permissions',
      NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: user_team_positions_authoritative_period(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.user_team_positions_authoritative_period() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.started_at := now();
    NEW.created_at := now();
    IF NEW.ended_at IS NOT NULL THEN NEW.ended_at := now(); END IF;
  ELSE
    NEW.started_at := CASE
      WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NULL THEN now()
      ELSE OLD.started_at
    END;
    NEW.created_at := OLD.created_at;
    NEW.ended_at := CASE
      WHEN NEW.ended_at IS NULL THEN NULL
      WHEN OLD.ended_at IS NULL THEN now()
      ELSE OLD.ended_at
    END;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: user_team_positions_require_active_organization(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.user_team_positions_require_active_organization() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM permit.team_positions tp
      JOIN permit.teams t ON t.id = tp.team_id
      JOIN permit.companies c ON c.id = t.company_id
     WHERE tp.id = NEW.team_position_id
       AND (tp.deactivated_at IS NOT NULL
            OR t.deactivated_at IS NOT NULL
            OR c.deactivated_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'team position % is inactive, or sits under an inactive team or company, and cannot receive new assignments',
      NEW.team_position_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: whatsapp_outbox_restrict_update(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.whatsapp_outbox_restrict_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF OLD.status = 'SENT' THEN
    RAISE EXCEPTION 'a SENT WhatsApp outbox row is immutable';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.permit_id <> OLD.permit_id
     OR NEW.source_event_id <> OLD.source_event_id
     OR NEW.event_type <> OLD.event_type
     OR NEW.payload <> OLD.payload
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'WhatsApp outbox business fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: workforce_profiles_authoritative_timestamps(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.workforce_profiles_authoritative_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
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


--
-- Name: workforce_profiles_company_matches_team(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.workforce_profiles_company_matches_team() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  team_company UUID;
BEGIN
  SELECT t.company_id INTO team_company
    FROM permit.team_positions tp
    JOIN permit.teams t ON t.id = tp.team_id
   WHERE tp.id = NEW.primary_team_position_id;
  IF team_company IS NULL THEN
    RAISE EXCEPTION 'primary team position % does not resolve to a team', NEW.primary_team_position_id;
  END IF;
  IF team_company <> NEW.company_id THEN
    RAISE EXCEPTION
      'employee company % does not own the team behind assignment %; cross-company assignment is not permitted',
      NEW.company_id, NEW.primary_team_position_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: workforce_profiles_primary_assignment_current(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.workforce_profiles_primary_assignment_current() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permit.user_team_positions
     WHERE user_id = NEW.user_id
       AND team_position_id = NEW.primary_team_position_id
       AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'primary assignment % is not a CURRENT assignment held by user %',
      NEW.primary_team_position_id, NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: workforce_profiles_reject_privileged_identity(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.workforce_profiles_reject_privileged_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT DISTINCT ON (role) role, action
          FROM permit.privileged_access_events
         WHERE user_id = NEW.user_id
         ORDER BY role, ordinal DESC
      ) latest
     WHERE latest.action = 'GRANTED'
  ) THEN
    RAISE EXCEPTION
      'user % holds privileged system access (CEO/SITE_MANAGER) and must not be given an organizational company, team or position profile',
      NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: workforce_profiles_require_active_organization(); Type: FUNCTION; Schema: permit; Owner: -
--

CREATE FUNCTION permit.workforce_profiles_require_active_organization() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  inactive TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.primary_team_position_id IS NOT DISTINCT FROM OLD.primary_team_position_id THEN
    RETURN NEW;
  END IF;

  SELECT CASE
           WHEN c.deactivated_at IS NOT NULL THEN 'company'
           WHEN t.deactivated_at IS NOT NULL THEN 'team'
           WHEN tp.deactivated_at IS NOT NULL THEN 'team position'
         END
    INTO inactive
    FROM permit.team_positions tp
    JOIN permit.teams t ON t.id = tp.team_id
    JOIN permit.companies c ON c.id = t.company_id
   WHERE tp.id = NEW.primary_team_position_id;

  IF inactive IS NOT NULL THEN
    RAISE EXCEPTION
      'the % behind team position % is inactive and cannot receive new employee assignments',
      inactive, NEW.primary_team_position_id;
  END IF;

  IF EXISTS (SELECT 1 FROM permit.companies WHERE id = NEW.company_id AND deactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'company % is inactive and cannot receive new employee assignments', NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;


SET default_table_access_method = heap;

--
-- Name: account_audit_events; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.account_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordinal bigint NOT NULL,
    event_type text NOT NULL,
    target_user_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    previous_company_id uuid,
    new_company_id uuid,
    previous_team_position_id uuid,
    new_team_position_id uuid,
    capability_id uuid,
    CONSTRAINT account_audit_events_actor_consistent CHECK ((((event_type = 'EMPLOYEE_PASSWORD_CHANGED'::text) AND (actor_user_id = target_user_id)) OR ((event_type <> 'EMPLOYEE_PASSWORD_CHANGED'::text) AND (actor_user_id <> target_user_id)))),
    CONSTRAINT account_audit_events_type_valid CHECK ((event_type = ANY (ARRAY['EMPLOYEE_ACCOUNT_CREATED'::text, 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER'::text, 'EMPLOYEE_PASSWORD_CHANGED'::text, 'EMPLOYEE_DISPLAY_NAME_CHANGED'::text, 'EMPLOYEE_EMAIL_CHANGED'::text, 'EMPLOYEE_COMPANY_CHANGED'::text, 'EMPLOYEE_TEAM_POSITION_CHANGED'::text, 'EMPLOYEE_PERMISSION_GRANTED'::text, 'EMPLOYEE_PERMISSION_REVOKED'::text, 'EMPLOYEE_DISABLED'::text, 'EMPLOYEE_REENABLED'::text, 'EMPLOYEE_ACCOUNT_DELETED'::text])))
);


--
-- Name: account_audit_events_ordinal_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.account_audit_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_audit_events_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.account_audit_events_ordinal_seq OWNED BY permit.account_audit_events.ordinal;


--
-- Name: app_user_access; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.app_user_access (
    user_id uuid NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL,
    credentials_changed_at timestamp with time zone,
    credential_version bigint DEFAULT 0 NOT NULL,
    credential_reset_pending boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT app_user_access_credential_version_check CHECK ((credential_version >= 0)),
    CONSTRAINT app_user_access_deleted_consistent CHECK (((state = 'DELETED'::text) = (deleted_at IS NOT NULL))),
    CONSTRAINT app_user_access_disabled_consistent CHECK (((state = 'DISABLED'::text) = (disabled_at IS NOT NULL))),
    CONSTRAINT app_user_access_reset_pending_gated CHECK (((NOT credential_reset_pending) OR must_change_password)),
    CONSTRAINT app_user_access_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text, 'DELETED'::text])))
);


--
-- Name: capabilities; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.capabilities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    individually_grantable boolean DEFAULT false NOT NULL,
    CONSTRAINT capabilities_name_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: companies; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.companies (
    id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT companies_code_format CHECK ((code ~ '^[A-Z][A-Z0-9_]*$'::text)),
    CONSTRAINT companies_code_not_blank CHECK ((btrim(code) <> ''::text)),
    CONSTRAINT companies_name_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: initial_ceo_bootstrap; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.initial_ceo_bootstrap (
    singleton boolean DEFAULT true NOT NULL,
    email text NOT NULL,
    auth_user_id uuid,
    status text NOT NULL,
    claim_token uuid,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT initial_ceo_bootstrap_claim_consistent CHECK ((((status = 'RESERVED'::text) AND (claim_token IS NOT NULL) AND (claimed_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = 'COMPLETED'::text) AND (claim_token IS NULL) AND (claimed_at IS NULL) AND (completed_at IS NOT NULL) AND (auth_user_id IS NOT NULL)))),
    CONSTRAINT initial_ceo_bootstrap_singleton_check CHECK (singleton),
    CONSTRAINT initial_ceo_bootstrap_status_check CHECK ((status = ANY (ARRAY['RESERVED'::text, 'COMPLETED'::text])))
);


--
-- Name: issued_document_snapshot_integrity; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.issued_document_snapshot_integrity (
    snapshot_id uuid NOT NULL,
    hash_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT issued_document_snapshot_integrity_hash_version_check CHECK ((hash_version = ANY (ARRAY['PG_JSONB_SHA256_V1'::text, 'SORTED_JSON_SHA256_V1'::text])))
);


--
-- Name: issued_document_snapshots; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.issued_document_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permit_id uuid NOT NULL,
    source_event_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT issued_document_snapshots_hash_not_blank CHECK ((btrim(snapshot_hash) <> ''::text))
);


--
-- Name: jsas; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.jsas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jsa_sequence bigint NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    form_version text,
    form_payload jsonb,
    site_or_wtg text,
    job_description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jsas_form_payload_consistent CHECK ((((form_version IS NULL) AND (form_payload IS NULL)) OR ((form_version IS NOT NULL) AND (form_version = ANY (ARRAY['JSA_V1'::text, 'JSA_V2'::text])) AND (form_payload IS NOT NULL) AND (jsonb_typeof(form_payload) = 'object'::text))))
);


--
-- Name: jsa_number_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.jsa_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jsa_number_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.jsa_number_seq OWNED BY permit.jsas.jsa_sequence;


--
-- Name: notifications; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_user_id uuid NOT NULL,
    permit_id uuid,
    source_event_id uuid NOT NULL,
    notification_type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT notifications_message_not_blank CHECK ((btrim(message) <> ''::text)),
    CONSTRAINT notifications_title_not_blank CHECK ((btrim(title) <> ''::text)),
    CONSTRAINT notifications_type_not_blank CHECK ((btrim(notification_type) <> ''::text))
);


--
-- Name: organization_audit_events; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.organization_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordinal bigint NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid NOT NULL,
    company_id uuid,
    team_id uuid,
    position_id uuid,
    team_position_id uuid,
    previous_name text,
    new_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_audit_events_names_for_renames CHECK ((((event_type = ANY (ARRAY['COMPANY_RENAMED'::text, 'TEAM_RENAMED'::text])) AND (previous_name IS NOT NULL) AND (btrim(previous_name) <> ''::text) AND (new_name IS NOT NULL) AND (btrim(new_name) <> ''::text)) OR ((event_type <> ALL (ARRAY['COMPANY_RENAMED'::text, 'TEAM_RENAMED'::text])) AND (previous_name IS NULL) AND (new_name IS NULL)))),
    CONSTRAINT organization_audit_events_subject_present CHECK (((company_id IS NOT NULL) OR (team_id IS NOT NULL) OR (position_id IS NOT NULL) OR (team_position_id IS NOT NULL))),
    CONSTRAINT organization_audit_events_type_valid CHECK ((event_type = ANY (ARRAY['COMPANY_CREATED'::text, 'COMPANY_RENAMED'::text, 'COMPANY_DEACTIVATED'::text, 'COMPANY_REACTIVATED'::text, 'TEAM_CREATED'::text, 'TEAM_RENAMED'::text, 'TEAM_DEACTIVATED'::text, 'TEAM_REACTIVATED'::text, 'POSITION_CREATED'::text, 'TEAM_POSITION_CREATED'::text, 'TEAM_POSITION_DEACTIVATED'::text, 'TEAM_POSITION_REACTIVATED'::text, 'BASELINE_CAPABILITIES_GRANTED'::text])))
);


--
-- Name: organization_audit_events_ordinal_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.organization_audit_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organization_audit_events_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.organization_audit_events_ordinal_seq OWNED BY permit.organization_audit_events.ordinal;


--
-- Name: permit_document_jobs; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.permit_document_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    storage_path text,
    file_hash text,
    generated_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    renderer_version text,
    expected_file_hash text,
    CONSTRAINT permit_document_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT permit_document_jobs_claim_consistent CHECK (((status = 'PROCESSING'::text) = ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT permit_document_jobs_generated_consistent CHECK ((((status = 'GENERATED'::text) AND (storage_path IS NOT NULL) AND (file_hash IS NOT NULL) AND (generated_at IS NOT NULL)) OR ((status <> 'GENERATED'::text) AND (storage_path IS NULL) AND (file_hash IS NULL) AND (generated_at IS NULL)))),
    CONSTRAINT permit_document_jobs_render_identity_consistent CHECK ((((renderer_version IS NULL) AND (expected_file_hash IS NULL)) OR ((renderer_version = ANY (ARRAY['PDFKIT_V1'::text, 'PDFKIT_V2'::text, 'PDFKIT_V3'::text])) AND (expected_file_hash IS NOT NULL) AND (btrim(expected_file_hash) <> ''::text)))),
    CONSTRAINT permit_document_jobs_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'GENERATED'::text, 'FAILED'::text])))
);


--
-- Name: permit_lifecycle_events; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.permit_lifecycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordinal bigint NOT NULL,
    permit_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT permit_lifecycle_events_event_status_consistent CHECK ((((event_type = 'CREATED'::text) AND (from_status IS NULL) AND (to_status = 'DRAFT'::text)) OR ((event_type = 'SUBMITTED'::text) AND (from_status = 'DRAFT'::text) AND (to_status = 'PENDING_CRO'::text)) OR ((event_type = 'CRO_FORWARDED_HSE'::text) AND (from_status = 'PENDING_CRO'::text) AND (to_status = 'PENDING_HSE'::text)) OR ((event_type = 'HSE_APPROVED'::text) AND (from_status = 'PENDING_HSE'::text) AND (to_status = 'ISSUED'::text)) OR ((event_type = 'CRO_FALLBACK_APPROVED'::text) AND (from_status = 'PENDING_HSE'::text) AND (to_status = 'ISSUED'::text)) OR ((event_type = 'CLOSED'::text) AND (from_status = ANY (ARRAY['ISSUED'::text, 'HELD'::text])) AND (to_status = 'CLOSED'::text)) OR ((event_type = 'CRO_SENT_BACK_TO_APPLICANT'::text) AND (from_status = 'PENDING_CRO'::text) AND (to_status = 'PENDING_CORRECTION'::text)) OR ((event_type = 'APPLICANT_RESUBMITTED'::text) AND (from_status = 'PENDING_CORRECTION'::text) AND (to_status = 'PENDING_CRO'::text)) OR ((event_type = 'HSE_SENT_BACK_TO_CRO'::text) AND (from_status = 'PENDING_HSE'::text) AND (to_status = 'PENDING_CRO'::text)) OR ((event_type = 'HELD'::text) AND (from_status = 'ISSUED'::text) AND (to_status = 'HELD'::text)) OR ((event_type = 'RESUMED'::text) AND (from_status = 'HELD'::text) AND (to_status = 'ISSUED'::text)) OR ((event_type = 'CANCELLED'::text) AND (from_status = ANY (ARRAY['ISSUED'::text, 'HELD'::text])) AND (to_status = 'CANCELLED'::text)) OR ((event_type = 'RENEWED'::text) AND (from_status IS NULL) AND (to_status = 'ISSUED'::text)))),
    CONSTRAINT permit_lifecycle_events_event_type_check CHECK ((event_type = ANY (ARRAY['CREATED'::text, 'SUBMITTED'::text, 'CRO_FORWARDED_HSE'::text, 'HSE_APPROVED'::text, 'CRO_FALLBACK_APPROVED'::text, 'CLOSED'::text, 'CRO_SENT_BACK_TO_APPLICANT'::text, 'APPLICANT_RESUBMITTED'::text, 'HSE_SENT_BACK_TO_CRO'::text, 'HELD'::text, 'RESUMED'::text, 'CANCELLED'::text, 'RENEWED'::text]))),
    CONSTRAINT permit_lifecycle_events_from_status_check CHECK (((from_status IS NULL) OR (from_status = ANY (ARRAY['DRAFT'::text, 'PENDING_CRO'::text, 'PENDING_HSE'::text, 'PENDING_CORRECTION'::text, 'ISSUED'::text, 'HELD'::text])))),
    CONSTRAINT permit_lifecycle_events_to_status_check CHECK ((to_status = ANY (ARRAY['DRAFT'::text, 'PENDING_CRO'::text, 'PENDING_HSE'::text, 'PENDING_CORRECTION'::text, 'ISSUED'::text, 'HELD'::text, 'CLOSED'::text, 'CANCELLED'::text])))
);


--
-- Name: permit_lifecycle_events_ordinal_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.permit_lifecycle_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permit_lifecycle_events_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.permit_lifecycle_events_ordinal_seq OWNED BY permit.permit_lifecycle_events.ordinal;


--
-- Name: permit_number_counters; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.permit_number_counters (
    permit_type text NOT NULL,
    next_value bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT permit_number_counters_next_value_positive CHECK ((next_value >= 1)),
    CONSTRAINT permit_number_counters_type_valid CHECK ((permit_type = ANY (ARRAY['WTG_WORK'::text, 'COLD_WORK'::text, 'HOT_WORK'::text, 'CONFINED_SPACE_ENTRY'::text])))
);


--
-- Name: TABLE permit_number_counters; Type: COMMENT; Schema: permit; Owner: -
--

COMMENT ON TABLE permit.permit_number_counters IS 'Per-permit-type permit number allocator. One row per type; next_value is the number the next permit of that type receives. Advanced only by the permits BEFORE INSERT trigger.';


--
-- Name: permits; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.permits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permit_sequence bigint,
    jsa_id uuid NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    previous_permit_id uuid,
    site_timezone text NOT NULL,
    company text,
    company_other text,
    submitted_at timestamp with time zone,
    issued_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hse_review_started_at timestamp with time zone,
    hse_review_deadline_at timestamp with time zone,
    closed_by uuid,
    closed_at timestamp with time zone,
    closure_remarks text,
    held_by uuid,
    held_at timestamp with time zone,
    hold_reason text,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    permit_type text,
    form_version text,
    form_payload jsonb,
    wind_farm text,
    wtg_number text,
    work_description text,
    loto_number text,
    applicant_display_name text,
    applicant_company_code text,
    applicant_company_name text,
    applicant_identity_kind text,
    applicant_company_id uuid,
    CONSTRAINT permits_applicant_identity_complete CHECK ((((applicant_display_name IS NULL) AND (applicant_company_code IS NULL) AND (applicant_company_name IS NULL) AND (applicant_company_id IS NULL)) OR ((applicant_display_name IS NOT NULL) AND (btrim(applicant_display_name) <> ''::text) AND (applicant_company_code IS NOT NULL) AND (btrim(applicant_company_code) <> ''::text) AND (applicant_company_name IS NOT NULL) AND (btrim(applicant_company_name) <> ''::text) AND (applicant_company_id IS NOT NULL)))),
    CONSTRAINT permits_cancellation_consistent CHECK ((((status = 'CANCELLED'::text) AND (cancelled_by IS NOT NULL) AND (cancelled_at IS NOT NULL)) OR ((status <> 'CANCELLED'::text) AND (cancelled_by IS NULL) AND (cancelled_at IS NULL) AND (cancel_reason IS NULL)))),
    CONSTRAINT permits_closure_consistent CHECK ((((status = 'CLOSED'::text) AND (closed_by IS NOT NULL) AND (closed_at IS NOT NULL)) OR ((status <> 'CLOSED'::text) AND (closed_by IS NULL) AND (closed_at IS NULL) AND (closure_remarks IS NULL)))),
    CONSTRAINT permits_company_other_exclusive CHECK ((((company = 'OTHER'::text) AND (company_other IS NOT NULL) AND (btrim(company_other) <> ''::text)) OR ((company IS DISTINCT FROM 'OTHER'::text) AND (company_other IS NULL)))),
    CONSTRAINT permits_company_other_required CHECK (((company IS DISTINCT FROM 'OTHER'::text) OR ((company_other IS NOT NULL) AND (btrim(company_other) <> ''::text)))),
    CONSTRAINT permits_company_valid CHECK (((company IS NULL) OR (company = ANY (ARRAY['ESET'::text, 'SGRE'::text, 'ZPL'::text, 'OTHER'::text])))),
    CONSTRAINT permits_draft_is_unnumbered CHECK (((status <> 'DRAFT'::text) OR (permit_sequence IS NULL))),
    CONSTRAINT permits_form_payload_typed CHECK (((form_payload IS NULL) OR ((permit_type IS NOT NULL) AND (jsonb_typeof(form_payload) = 'object'::text)))),
    CONSTRAINT permits_form_required_after_draft CHECK (((status = 'DRAFT'::text) OR ((permit_type IS NOT NULL) AND (form_version IS NOT NULL) AND (form_payload IS NOT NULL)))),
    CONSTRAINT permits_form_version_matches_type CHECK ((((permit_type IS NULL) AND (form_version IS NULL)) OR ((permit_type IS NOT NULL) AND (form_version IS NOT NULL) AND (((permit_type = 'WTG_WORK'::text) AND (form_version = ANY (ARRAY['WTG_WORK_V1'::text, 'WTG_WORK_V2'::text]))) OR ((permit_type = 'COLD_WORK'::text) AND (form_version = ANY (ARRAY['COLD_WORK_V1'::text, 'COLD_WORK_V2'::text]))) OR ((permit_type = 'HOT_WORK'::text) AND (form_version = ANY (ARRAY['HOT_WORK_V1'::text, 'HOT_WORK_V2'::text]))) OR ((permit_type = 'CONFINED_SPACE_ENTRY'::text) AND (form_version = ANY (ARRAY['CONFINED_SPACE_ENTRY_V1'::text, 'CONFINED_SPACE_ENTRY_V2'::text]))))))),
    CONSTRAINT permits_hold_consistent CHECK ((((status = 'HELD'::text) AND (held_by IS NOT NULL) AND (held_at IS NOT NULL) AND (hold_reason IS NOT NULL) AND (btrim(hold_reason) <> ''::text)) OR ((status <> 'HELD'::text) AND (held_by IS NULL) AND (held_at IS NULL) AND (hold_reason IS NULL)))),
    CONSTRAINT permits_hse_deadline_exact CHECK (((hse_review_deadline_at IS NULL) OR (hse_review_deadline_at = (hse_review_started_at + '00:05:00'::interval)))),
    CONSTRAINT permits_hse_window_status_consistent CHECK ((((status = ANY (ARRAY['DRAFT'::text, 'PENDING_CRO'::text, 'PENDING_CORRECTION'::text])) AND (hse_review_started_at IS NULL) AND (hse_review_deadline_at IS NULL)) OR ((status = 'PENDING_HSE'::text) AND (hse_review_started_at IS NOT NULL) AND (hse_review_deadline_at IS NOT NULL)) OR ((status = ANY (ARRAY['ISSUED'::text, 'HELD'::text, 'CLOSED'::text, 'CANCELLED'::text])) AND (((hse_review_started_at IS NOT NULL) AND (hse_review_deadline_at IS NOT NULL)) OR ((hse_review_started_at IS NULL) AND (hse_review_deadline_at IS NULL) AND (previous_permit_id IS NOT NULL)))))),
    CONSTRAINT permits_issued_at_consistent CHECK (((status = ANY (ARRAY['ISSUED'::text, 'HELD'::text, 'CLOSED'::text, 'CANCELLED'::text])) = (issued_at IS NOT NULL))),
    CONSTRAINT permits_permit_type_valid CHECK (((permit_type IS NULL) OR (permit_type = ANY (ARRAY['WTG_WORK'::text, 'COLD_WORK'::text, 'HOT_WORK'::text, 'CONFINED_SPACE_ENTRY'::text])))),
    CONSTRAINT permits_previous_not_self CHECK (((previous_permit_id IS NULL) OR (previous_permit_id <> id))),
    CONSTRAINT permits_sequence_required_after_draft CHECK (((status = 'DRAFT'::text) OR (permit_sequence IS NOT NULL))),
    CONSTRAINT permits_site_timezone_not_blank CHECK ((btrim(site_timezone) <> ''::text)),
    CONSTRAINT permits_status_valid CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PENDING_CRO'::text, 'PENDING_HSE'::text, 'PENDING_CORRECTION'::text, 'ISSUED'::text, 'HELD'::text, 'CANCELLED'::text, 'CLOSED'::text]))),
    CONSTRAINT permits_submitted_at_consistent CHECK (((submitted_at IS NULL) OR (status <> 'DRAFT'::text))),
    CONSTRAINT permits_version_positive CHECK ((version > 0))
);


--
-- Name: COLUMN permits.permit_sequence; Type: COMMENT; Schema: permit; Owner: -
--

COMMENT ON COLUMN permit.permits.permit_sequence IS 'The authoritative permit number within its permit_type series. ALWAYS NULL while the permit is a DRAFT - typed or untyped; issued by the database out of the permit type''s own series on the first successful submission, and permanent thereafter.';


--
-- Name: permit_number_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.permit_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permit_number_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.permit_number_seq OWNED BY permit.permits.permit_sequence;


--
-- Name: permit_signatures; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.permit_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permit_id uuid NOT NULL,
    source_event_id uuid NOT NULL,
    signature_role text NOT NULL,
    signer_user_id uuid NOT NULL,
    signer_display_name text NOT NULL,
    signer_team_position_id uuid,
    signer_team_name text,
    signer_position_name text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signer_identity_kind text DEFAULT 'NORMAL'::text NOT NULL,
    CONSTRAINT permit_signatures_display_name_not_blank CHECK ((btrim(signer_display_name) <> ''::text)),
    CONSTRAINT permit_signatures_identity_shape CHECK ((((signer_identity_kind = 'NORMAL'::text) AND (signer_team_position_id IS NOT NULL) AND (signer_team_name IS NOT NULL) AND (btrim(signer_team_name) <> ''::text) AND (signer_position_name IS NOT NULL) AND (btrim(signer_position_name) <> ''::text)) OR ((signer_identity_kind = 'PRIVILEGED'::text) AND (signature_role = 'APPLICANT'::text) AND (signer_team_position_id IS NULL) AND (signer_team_name IS NULL) AND (signer_position_name IS NULL)))),
    CONSTRAINT permit_signatures_role_valid CHECK ((signature_role = ANY (ARRAY['APPLICANT'::text, 'CRO'::text, 'HSE'::text, 'CRO_FALLBACK'::text, 'RENEWAL'::text])))
);


--
-- Name: positions; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT positions_name_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: privileged_access_events; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.privileged_access_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordinal bigint NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    action text NOT NULL,
    actor_user_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT privileged_access_events_action_check CHECK ((action = ANY (ARRAY['GRANTED'::text, 'REVOKED'::text]))),
    CONSTRAINT privileged_access_events_role_check CHECK ((role = ANY (ARRAY['CEO'::text, 'SITE_MANAGER'::text])))
);


--
-- Name: privileged_access_events_ordinal_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.privileged_access_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: privileged_access_events_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.privileged_access_events_ordinal_seq OWNED BY permit.privileged_access_events.ordinal;


--
-- Name: privileged_identities; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.privileged_identities (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT privileged_identities_display_name_not_blank CHECK ((btrim(display_name) <> ''::text))
);


--
-- Name: team_position_capabilities; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.team_position_capabilities (
    team_position_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_positions; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.team_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    position_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    site_manager_assignable boolean DEFAULT false NOT NULL,
    deactivated_at timestamp with time zone
);


--
-- Name: teams; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT teams_name_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: user_capability_grants; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.user_capability_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ordinal bigint NOT NULL,
    user_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    action text NOT NULL,
    actor_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_capability_grants_action_check CHECK ((action = ANY (ARRAY['GRANTED'::text, 'REVOKED'::text]))),
    CONSTRAINT user_capability_grants_not_self CHECK ((actor_user_id <> user_id))
);


--
-- Name: user_capability_grants_ordinal_seq; Type: SEQUENCE; Schema: permit; Owner: -
--

CREATE SEQUENCE permit.user_capability_grants_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_capability_grants_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: permit; Owner: -
--

ALTER SEQUENCE permit.user_capability_grants_ordinal_seq OWNED BY permit.user_capability_grants.ordinal;


--
-- Name: user_team_positions; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.user_team_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_position_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT user_team_positions_period_ordered CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))
);


--
-- Name: whatsapp_outbox_messages; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.whatsapp_outbox_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permit_id uuid NOT NULL,
    source_event_id uuid NOT NULL,
    event_type text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    last_attempted_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_outbox_claim_consistent CHECK (((status = 'PROCESSING'::text) = ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT whatsapp_outbox_event_type_not_blank CHECK ((btrim(event_type) <> ''::text)),
    CONSTRAINT whatsapp_outbox_messages_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT whatsapp_outbox_messages_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'SENT'::text, 'FAILED'::text]))),
    CONSTRAINT whatsapp_outbox_payload_not_blank CHECK ((btrim(payload) <> ''::text)),
    CONSTRAINT whatsapp_outbox_sent_at_consistent CHECK (((status = 'SENT'::text) = (sent_at IS NOT NULL)))
);


--
-- Name: workforce_profiles; Type: TABLE; Schema: permit; Owner: -
--

CREATE TABLE permit.workforce_profiles (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    primary_team_position_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid NOT NULL,
    CONSTRAINT workforce_profiles_display_name_not_blank CHECK ((btrim(display_name) <> ''::text))
);


--
-- Name: account_audit_events ordinal; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events ALTER COLUMN ordinal SET DEFAULT nextval('permit.account_audit_events_ordinal_seq'::regclass);


--
-- Name: jsas jsa_sequence; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.jsas ALTER COLUMN jsa_sequence SET DEFAULT nextval('permit.jsa_number_seq'::regclass);


--
-- Name: organization_audit_events ordinal; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events ALTER COLUMN ordinal SET DEFAULT nextval('permit.organization_audit_events_ordinal_seq'::regclass);


--
-- Name: permit_lifecycle_events ordinal; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_lifecycle_events ALTER COLUMN ordinal SET DEFAULT nextval('permit.permit_lifecycle_events_ordinal_seq'::regclass);


--
-- Name: privileged_access_events ordinal; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_access_events ALTER COLUMN ordinal SET DEFAULT nextval('permit.privileged_access_events_ordinal_seq'::regclass);


--
-- Name: user_capability_grants ordinal; Type: DEFAULT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_capability_grants ALTER COLUMN ordinal SET DEFAULT nextval('permit.user_capability_grants_ordinal_seq'::regclass);


--
-- Name: account_audit_events account_audit_events_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_pkey PRIMARY KEY (id);


--
-- Name: app_user_access app_user_access_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.app_user_access
    ADD CONSTRAINT app_user_access_pkey PRIMARY KEY (user_id);


--
-- Name: capabilities capabilities_name_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.capabilities
    ADD CONSTRAINT capabilities_name_unique UNIQUE (name);


--
-- Name: capabilities capabilities_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (id);


--
-- Name: companies companies_code_key; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.companies
    ADD CONSTRAINT companies_code_key UNIQUE (code);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: initial_ceo_bootstrap initial_ceo_bootstrap_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.initial_ceo_bootstrap
    ADD CONSTRAINT initial_ceo_bootstrap_pkey PRIMARY KEY (singleton);


--
-- Name: issued_document_snapshot_integrity issued_document_snapshot_integrity_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshot_integrity
    ADD CONSTRAINT issued_document_snapshot_integrity_pkey PRIMARY KEY (snapshot_id);


--
-- Name: issued_document_snapshots issued_document_snapshots_permit_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshots
    ADD CONSTRAINT issued_document_snapshots_permit_unique UNIQUE (permit_id);


--
-- Name: issued_document_snapshots issued_document_snapshots_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshots
    ADD CONSTRAINT issued_document_snapshots_pkey PRIMARY KEY (id);


--
-- Name: issued_document_snapshots issued_document_snapshots_source_event_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshots
    ADD CONSTRAINT issued_document_snapshots_source_event_unique UNIQUE (source_event_id);


--
-- Name: jsas jsas_jsa_sequence_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.jsas
    ADD CONSTRAINT jsas_jsa_sequence_unique UNIQUE (jsa_sequence);


--
-- Name: jsas jsas_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.jsas
    ADD CONSTRAINT jsas_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_source_event_recipient_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.notifications
    ADD CONSTRAINT notifications_source_event_recipient_unique UNIQUE (source_event_id, recipient_user_id);


--
-- Name: organization_audit_events organization_audit_events_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_pkey PRIMARY KEY (id);


--
-- Name: permit_document_jobs permit_document_jobs_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_document_jobs
    ADD CONSTRAINT permit_document_jobs_pkey PRIMARY KEY (id);


--
-- Name: permit_document_jobs permit_document_jobs_snapshot_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_document_jobs
    ADD CONSTRAINT permit_document_jobs_snapshot_unique UNIQUE (snapshot_id);


--
-- Name: permit_lifecycle_events permit_lifecycle_events_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_lifecycle_events
    ADD CONSTRAINT permit_lifecycle_events_pkey PRIMARY KEY (id);


--
-- Name: permit_number_counters permit_number_counters_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_number_counters
    ADD CONSTRAINT permit_number_counters_pkey PRIMARY KEY (permit_type);


--
-- Name: permit_signatures permit_signatures_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_pkey PRIMARY KEY (id);


--
-- Name: permit_signatures permit_signatures_source_event_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_source_event_unique UNIQUE (source_event_id);


--
-- Name: permits permits_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_pkey PRIMARY KEY (id);


--
-- Name: positions positions_name_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.positions
    ADD CONSTRAINT positions_name_unique UNIQUE (name);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: privileged_access_events privileged_access_events_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_access_events
    ADD CONSTRAINT privileged_access_events_pkey PRIMARY KEY (id);


--
-- Name: privileged_identities privileged_identities_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_identities
    ADD CONSTRAINT privileged_identities_pkey PRIMARY KEY (user_id);


--
-- Name: team_position_capabilities team_position_capabilities_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_position_capabilities
    ADD CONSTRAINT team_position_capabilities_pkey PRIMARY KEY (team_position_id, capability_id);


--
-- Name: team_positions team_positions_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_positions
    ADD CONSTRAINT team_positions_pkey PRIMARY KEY (id);


--
-- Name: team_positions team_positions_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_positions
    ADD CONSTRAINT team_positions_unique UNIQUE (team_id, position_id);


--
-- Name: teams teams_company_name_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.teams
    ADD CONSTRAINT teams_company_name_unique UNIQUE (company_id, name);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: user_capability_grants user_capability_grants_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_capability_grants
    ADD CONSTRAINT user_capability_grants_pkey PRIMARY KEY (id);


--
-- Name: user_team_positions user_team_positions_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_team_positions
    ADD CONSTRAINT user_team_positions_pkey PRIMARY KEY (id);


--
-- Name: user_team_positions user_team_positions_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_team_positions
    ADD CONSTRAINT user_team_positions_unique UNIQUE (user_id, team_position_id);


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_messages_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.whatsapp_outbox_messages
    ADD CONSTRAINT whatsapp_outbox_messages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_source_event_unique; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.whatsapp_outbox_messages
    ADD CONSTRAINT whatsapp_outbox_source_event_unique UNIQUE (source_event_id);


--
-- Name: workforce_profiles workforce_profiles_pkey; Type: CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.workforce_profiles
    ADD CONSTRAINT workforce_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: account_audit_events_actor_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_actor_idx ON permit.account_audit_events USING btree (actor_user_id, ordinal DESC);


--
-- Name: account_audit_events_capability_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_capability_idx ON permit.account_audit_events USING btree (capability_id);


--
-- Name: account_audit_events_new_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_new_company_idx ON permit.account_audit_events USING btree (new_company_id);


--
-- Name: account_audit_events_new_tp_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_new_tp_idx ON permit.account_audit_events USING btree (new_team_position_id);


--
-- Name: account_audit_events_prev_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_prev_company_idx ON permit.account_audit_events USING btree (previous_company_id);


--
-- Name: account_audit_events_prev_tp_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_prev_tp_idx ON permit.account_audit_events USING btree (previous_team_position_id);


--
-- Name: account_audit_events_target_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX account_audit_events_target_idx ON permit.account_audit_events USING btree (target_user_id, ordinal DESC);


--
-- Name: companies_name_normalized_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX companies_name_normalized_unique ON permit.companies USING btree (lower(btrim(name)));


--
-- Name: notifications_recipient_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX notifications_recipient_idx ON permit.notifications USING btree (recipient_user_id, read_at, created_at DESC);


--
-- Name: organization_audit_events_actor_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX organization_audit_events_actor_idx ON permit.organization_audit_events USING btree (actor_user_id, ordinal DESC);


--
-- Name: organization_audit_events_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX organization_audit_events_company_idx ON permit.organization_audit_events USING btree (company_id, ordinal DESC);


--
-- Name: permit_document_jobs_pending_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permit_document_jobs_pending_idx ON permit.permit_document_jobs USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED'::text, 'PROCESSING'::text]));


--
-- Name: permit_lifecycle_events_actor_user_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permit_lifecycle_events_actor_user_id_idx ON permit.permit_lifecycle_events USING btree (actor_user_id);


--
-- Name: permit_lifecycle_events_event_type_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permit_lifecycle_events_event_type_idx ON permit.permit_lifecycle_events USING btree (event_type);


--
-- Name: permit_lifecycle_events_permit_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permit_lifecycle_events_permit_id_idx ON permit.permit_lifecycle_events USING btree (permit_id);


--
-- Name: permit_signatures_permit_role_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permit_signatures_permit_role_idx ON permit.permit_signatures USING btree (permit_id, signature_role);


--
-- Name: permits_applicant_company_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_applicant_company_id_idx ON permit.permits USING btree (applicant_company_id);


--
-- Name: permits_applicant_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_applicant_company_idx ON permit.permits USING btree (applicant_company_code);


--
-- Name: permits_created_at_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_created_at_idx ON permit.permits USING btree (created_at);


--
-- Name: permits_created_by_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_created_by_idx ON permit.permits USING btree (created_by);


--
-- Name: permits_jsa_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_jsa_id_idx ON permit.permits USING btree (jsa_id);


--
-- Name: permits_permit_type_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_permit_type_idx ON permit.permits USING btree (permit_type);


--
-- Name: permits_permit_type_sequence_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX permits_permit_type_sequence_unique ON permit.permits USING btree (permit_type, permit_sequence) WHERE (permit_type IS NOT NULL);


--
-- Name: permits_previous_permit_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_previous_permit_id_idx ON permit.permits USING btree (previous_permit_id);


--
-- Name: permits_previous_permit_id_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX permits_previous_permit_id_unique ON permit.permits USING btree (previous_permit_id) WHERE (previous_permit_id IS NOT NULL);


--
-- Name: permits_status_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_status_idx ON permit.permits USING btree (status);


--
-- Name: permits_untyped_sequence_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX permits_untyped_sequence_unique ON permit.permits USING btree (permit_sequence) WHERE (permit_type IS NULL);


--
-- Name: permits_wtg_number_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX permits_wtg_number_idx ON permit.permits USING btree (wtg_number) WHERE (wtg_number IS NOT NULL);


--
-- Name: positions_name_normalized_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX positions_name_normalized_unique ON permit.positions USING btree (lower(btrim(name)));


--
-- Name: privileged_access_events_user_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX privileged_access_events_user_id_idx ON permit.privileged_access_events USING btree (user_id);


--
-- Name: teams_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX teams_company_idx ON permit.teams USING btree (company_id);


--
-- Name: teams_company_name_normalized_unique; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX teams_company_name_normalized_unique ON permit.teams USING btree (company_id, lower(btrim(name)));


--
-- Name: user_capability_grants_actor_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX user_capability_grants_actor_idx ON permit.user_capability_grants USING btree (actor_user_id, ordinal DESC);


--
-- Name: user_capability_grants_capability_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX user_capability_grants_capability_idx ON permit.user_capability_grants USING btree (capability_id);


--
-- Name: user_capability_grants_user_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX user_capability_grants_user_idx ON permit.user_capability_grants USING btree (user_id, ordinal DESC);


--
-- Name: user_team_positions_one_current_per_user; Type: INDEX; Schema: permit; Owner: -
--

CREATE UNIQUE INDEX user_team_positions_one_current_per_user ON permit.user_team_positions USING btree (user_id) WHERE (ended_at IS NULL);


--
-- Name: user_team_positions_user_current_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX user_team_positions_user_current_idx ON permit.user_team_positions USING btree (user_id, ended_at);


--
-- Name: user_team_positions_user_id_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX user_team_positions_user_id_idx ON permit.user_team_positions USING btree (user_id);


--
-- Name: whatsapp_outbox_pending_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX whatsapp_outbox_pending_idx ON permit.whatsapp_outbox_messages USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED'::text, 'PROCESSING'::text]));


--
-- Name: workforce_profiles_company_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX workforce_profiles_company_idx ON permit.workforce_profiles USING btree (company_id);


--
-- Name: workforce_profiles_primary_team_position_idx; Type: INDEX; Schema: permit; Owner: -
--

CREATE INDEX workforce_profiles_primary_team_position_idx ON permit.workforce_profiles USING btree (primary_team_position_id);


--
-- Name: account_audit_events account_audit_events_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER account_audit_events_append_only BEFORE DELETE OR UPDATE ON permit.account_audit_events FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: account_audit_events account_audit_events_authoritative_timestamp_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER account_audit_events_authoritative_timestamp_trigger BEFORE INSERT ON permit.account_audit_events FOR EACH ROW EXECUTE FUNCTION permit.account_audit_events_authoritative_timestamp();


--
-- Name: account_audit_events account_audit_events_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER account_audit_events_no_truncate BEFORE TRUNCATE ON permit.account_audit_events FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: app_user_access app_user_access_authoritative_timestamps_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER app_user_access_authoritative_timestamps_trigger BEFORE INSERT OR UPDATE ON permit.app_user_access FOR EACH ROW EXECUTE FUNCTION permit.app_user_access_authoritative_timestamps();


--
-- Name: companies companies_authoritative_created_at_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER companies_authoritative_created_at_trigger BEFORE INSERT OR UPDATE ON permit.companies FOR EACH ROW EXECUTE FUNCTION permit.companies_authoritative_created_at();


--
-- Name: companies companies_freeze_identity_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER companies_freeze_identity_trigger BEFORE UPDATE ON permit.companies FOR EACH ROW EXECUTE FUNCTION permit.companies_freeze_identity();


--
-- Name: companies companies_guard_deactivation_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER companies_guard_deactivation_trigger BEFORE UPDATE ON permit.companies FOR EACH ROW EXECUTE FUNCTION permit.companies_guard_deactivation();


--
-- Name: issued_document_snapshot_integrity issued_document_snapshot_integrity_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER issued_document_snapshot_integrity_append_only BEFORE DELETE OR UPDATE ON permit.issued_document_snapshot_integrity FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: issued_document_snapshot_integrity issued_document_snapshot_integrity_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER issued_document_snapshot_integrity_no_truncate BEFORE TRUNCATE ON permit.issued_document_snapshot_integrity FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: issued_document_snapshots issued_document_snapshots_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER issued_document_snapshots_append_only BEFORE DELETE OR UPDATE ON permit.issued_document_snapshots FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: issued_document_snapshots issued_document_snapshots_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER issued_document_snapshots_no_truncate BEFORE TRUNCATE ON permit.issued_document_snapshots FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: issued_document_snapshots issued_snapshots_event_linkage; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE CONSTRAINT TRIGGER issued_snapshots_event_linkage AFTER INSERT OR UPDATE ON permit.issued_document_snapshots DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION permit.support_event_linkage_guard();


--
-- Name: jsas jsas_authoritative_timestamps_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER jsas_authoritative_timestamps_trigger BEFORE INSERT OR UPDATE ON permit.jsas FOR EACH ROW EXECUTE FUNCTION permit.jsas_authoritative_timestamps();


--
-- Name: jsas jsas_content_editable_only_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER jsas_content_editable_only_trigger BEFORE UPDATE ON permit.jsas FOR EACH ROW EXECUTE FUNCTION permit.jsas_content_editable_only();


--
-- Name: notifications notifications_event_linkage; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE CONSTRAINT TRIGGER notifications_event_linkage AFTER INSERT OR UPDATE ON permit.notifications DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION permit.support_event_linkage_guard();


--
-- Name: notifications notifications_no_delete; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER notifications_no_delete BEFORE DELETE ON permit.notifications FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: notifications notifications_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON permit.notifications FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: notifications notifications_restrict_update_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER notifications_restrict_update_trigger BEFORE UPDATE ON permit.notifications FOR EACH ROW EXECUTE FUNCTION permit.notifications_restrict_update();


--
-- Name: organization_audit_events organization_audit_events_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER organization_audit_events_append_only BEFORE DELETE OR UPDATE ON permit.organization_audit_events FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: organization_audit_events organization_audit_events_authoritative_timestamp_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER organization_audit_events_authoritative_timestamp_trigger BEFORE INSERT ON permit.organization_audit_events FOR EACH ROW EXECUTE FUNCTION permit.organization_audit_events_authoritative_timestamp();


--
-- Name: organization_audit_events organization_audit_events_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER organization_audit_events_no_truncate BEFORE TRUNCATE ON permit.organization_audit_events FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_document_jobs permit_document_jobs_no_delete; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_document_jobs_no_delete BEFORE DELETE ON permit.permit_document_jobs FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_document_jobs permit_document_jobs_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_document_jobs_no_truncate BEFORE TRUNCATE ON permit.permit_document_jobs FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_document_jobs permit_document_jobs_restrict_update_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_document_jobs_restrict_update_trigger BEFORE UPDATE ON permit.permit_document_jobs FOR EACH ROW EXECUTE FUNCTION permit.permit_document_jobs_restrict_update();


--
-- Name: permit_lifecycle_events permit_lifecycle_events_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_lifecycle_events_append_only BEFORE DELETE OR UPDATE ON permit.permit_lifecycle_events FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_lifecycle_events permit_lifecycle_events_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_lifecycle_events_no_truncate BEFORE TRUNCATE ON permit.permit_lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_signatures permit_signatures_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_signatures_append_only BEFORE DELETE OR UPDATE ON permit.permit_signatures FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permit_signatures permit_signatures_authenticity; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE CONSTRAINT TRIGGER permit_signatures_authenticity AFTER INSERT OR UPDATE ON permit.permit_signatures DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION permit.permit_signature_authenticity_guard();


--
-- Name: permit_signatures permit_signatures_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permit_signatures_no_truncate BEFORE TRUNCATE ON permit.permit_signatures FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: permits permits_assign_permit_sequence_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permits_assign_permit_sequence_trigger BEFORE INSERT OR UPDATE ON permit.permits FOR EACH ROW EXECUTE FUNCTION permit.permits_assign_permit_sequence();


--
-- Name: permits permits_freeze_applicant_identity_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER permits_freeze_applicant_identity_trigger BEFORE UPDATE ON permit.permits FOR EACH ROW EXECUTE FUNCTION permit.permits_freeze_applicant_identity();


--
-- Name: permits permits_require_completed_jsa; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE CONSTRAINT TRIGGER permits_require_completed_jsa AFTER INSERT OR UPDATE ON permit.permits DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION permit.permit_requires_completed_jsa();


--
-- Name: privileged_access_events privileged_access_events_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER privileged_access_events_append_only BEFORE DELETE OR UPDATE ON permit.privileged_access_events FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: privileged_access_events privileged_access_events_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER privileged_access_events_no_truncate BEFORE TRUNCATE ON permit.privileged_access_events FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: privileged_access_events privileged_access_events_reject_employee_grant; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER privileged_access_events_reject_employee_grant BEFORE INSERT ON permit.privileged_access_events FOR EACH ROW WHEN ((new.action = 'GRANTED'::text)) EXECUTE FUNCTION permit.reject_privileged_grant_for_employee();


--
-- Name: privileged_identities privileged_identities_authoritative_timestamps_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER privileged_identities_authoritative_timestamps_trigger BEFORE INSERT OR UPDATE ON permit.privileged_identities FOR EACH ROW EXECUTE FUNCTION permit.privileged_identities_authoritative_timestamps();


--
-- Name: privileged_identities privileged_identities_reject_employee; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER privileged_identities_reject_employee BEFORE INSERT OR UPDATE ON permit.privileged_identities FOR EACH ROW EXECUTE FUNCTION permit.reject_privileged_grant_for_employee();


--
-- Name: team_position_capabilities team_position_capabilities_reject_individual; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER team_position_capabilities_reject_individual BEFORE INSERT OR UPDATE ON permit.team_position_capabilities FOR EACH ROW EXECUTE FUNCTION permit.reject_individually_grantable_team_position();


--
-- Name: team_positions team_positions_guard_deactivation_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER team_positions_guard_deactivation_trigger BEFORE UPDATE ON permit.team_positions FOR EACH ROW EXECUTE FUNCTION permit.team_positions_guard_deactivation();


--
-- Name: team_positions team_positions_require_active_team_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER team_positions_require_active_team_trigger BEFORE INSERT ON permit.team_positions FOR EACH ROW EXECUTE FUNCTION permit.team_positions_require_active_team();


--
-- Name: teams teams_guard_deactivation_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER teams_guard_deactivation_trigger BEFORE UPDATE ON permit.teams FOR EACH ROW EXECUTE FUNCTION permit.teams_guard_deactivation();


--
-- Name: teams teams_require_active_company_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER teams_require_active_company_trigger BEFORE INSERT ON permit.teams FOR EACH ROW EXECUTE FUNCTION permit.teams_require_active_company();


--
-- Name: user_capability_grants user_capability_grants_append_only; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_capability_grants_append_only BEFORE DELETE OR UPDATE ON permit.user_capability_grants FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: user_capability_grants user_capability_grants_authoritative_timestamp_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_capability_grants_authoritative_timestamp_trigger BEFORE INSERT ON permit.user_capability_grants FOR EACH ROW EXECUTE FUNCTION permit.user_capability_grants_authoritative_timestamp();


--
-- Name: user_capability_grants user_capability_grants_guard_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_capability_grants_guard_trigger BEFORE INSERT ON permit.user_capability_grants FOR EACH ROW EXECUTE FUNCTION permit.user_capability_grants_guard();


--
-- Name: user_capability_grants user_capability_grants_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_capability_grants_no_truncate BEFORE TRUNCATE ON permit.user_capability_grants FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: user_team_positions user_team_positions_authoritative_period_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_team_positions_authoritative_period_trigger BEFORE INSERT OR UPDATE ON permit.user_team_positions FOR EACH ROW EXECUTE FUNCTION permit.user_team_positions_authoritative_period();


--
-- Name: user_team_positions user_team_positions_require_active_organization_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER user_team_positions_require_active_organization_trigger BEFORE INSERT ON permit.user_team_positions FOR EACH ROW EXECUTE FUNCTION permit.user_team_positions_require_active_organization();


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_event_linkage; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE CONSTRAINT TRIGGER whatsapp_outbox_event_linkage AFTER INSERT OR UPDATE ON permit.whatsapp_outbox_messages DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION permit.support_event_linkage_guard();


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_no_delete; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER whatsapp_outbox_no_delete BEFORE DELETE ON permit.whatsapp_outbox_messages FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_no_truncate; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER whatsapp_outbox_no_truncate BEFORE TRUNCATE ON permit.whatsapp_outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_restrict_update_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER whatsapp_outbox_restrict_update_trigger BEFORE UPDATE ON permit.whatsapp_outbox_messages FOR EACH ROW EXECUTE FUNCTION permit.whatsapp_outbox_restrict_update();


--
-- Name: workforce_profiles workforce_profiles_authoritative_timestamps_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER workforce_profiles_authoritative_timestamps_trigger BEFORE INSERT OR UPDATE ON permit.workforce_profiles FOR EACH ROW EXECUTE FUNCTION permit.workforce_profiles_authoritative_timestamps();


--
-- Name: workforce_profiles workforce_profiles_company_matches_team_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER workforce_profiles_company_matches_team_trigger BEFORE INSERT OR UPDATE ON permit.workforce_profiles FOR EACH ROW EXECUTE FUNCTION permit.workforce_profiles_company_matches_team();


--
-- Name: workforce_profiles workforce_profiles_primary_assignment_current_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER workforce_profiles_primary_assignment_current_trigger BEFORE INSERT OR UPDATE ON permit.workforce_profiles FOR EACH ROW EXECUTE FUNCTION permit.workforce_profiles_primary_assignment_current();


--
-- Name: workforce_profiles workforce_profiles_reject_privileged_identity_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER workforce_profiles_reject_privileged_identity_trigger BEFORE INSERT OR UPDATE ON permit.workforce_profiles FOR EACH ROW EXECUTE FUNCTION permit.workforce_profiles_reject_privileged_identity();


--
-- Name: workforce_profiles workforce_profiles_require_active_organization_trigger; Type: TRIGGER; Schema: permit; Owner: -
--

CREATE TRIGGER workforce_profiles_require_active_organization_trigger BEFORE INSERT OR UPDATE ON permit.workforce_profiles FOR EACH ROW EXECUTE FUNCTION permit.workforce_profiles_require_active_organization();


--
-- Name: account_audit_events account_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_capability_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES permit.capabilities(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_new_company_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_new_company_id_fkey FOREIGN KEY (new_company_id) REFERENCES permit.companies(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_new_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_new_team_position_id_fkey FOREIGN KEY (new_team_position_id) REFERENCES permit.team_positions(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_previous_company_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_previous_company_id_fkey FOREIGN KEY (previous_company_id) REFERENCES permit.companies(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_previous_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_previous_team_position_id_fkey FOREIGN KEY (previous_team_position_id) REFERENCES permit.team_positions(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events account_audit_events_target_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.account_audit_events
    ADD CONSTRAINT account_audit_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: app_user_access app_user_access_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.app_user_access
    ADD CONSTRAINT app_user_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: initial_ceo_bootstrap initial_ceo_bootstrap_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.initial_ceo_bootstrap
    ADD CONSTRAINT initial_ceo_bootstrap_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: issued_document_snapshot_integrity issued_document_snapshot_integrity_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshot_integrity
    ADD CONSTRAINT issued_document_snapshot_integrity_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES permit.issued_document_snapshots(id) ON DELETE RESTRICT;


--
-- Name: issued_document_snapshots issued_document_snapshots_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshots
    ADD CONSTRAINT issued_document_snapshots_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: issued_document_snapshots issued_document_snapshots_source_event_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.issued_document_snapshots
    ADD CONSTRAINT issued_document_snapshots_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES permit.permit_lifecycle_events(id) ON DELETE RESTRICT;


--
-- Name: jsas jsas_created_by_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.jsas
    ADD CONSTRAINT jsas_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.notifications
    ADD CONSTRAINT notifications_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.notifications
    ADD CONSTRAINT notifications_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_source_event_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.notifications
    ADD CONSTRAINT notifications_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES permit.permit_lifecycle_events(id) ON DELETE RESTRICT;


--
-- Name: organization_audit_events organization_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: organization_audit_events organization_audit_events_company_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES permit.companies(id) ON DELETE RESTRICT;


--
-- Name: organization_audit_events organization_audit_events_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_position_id_fkey FOREIGN KEY (position_id) REFERENCES permit.positions(id) ON DELETE RESTRICT;


--
-- Name: organization_audit_events organization_audit_events_team_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_team_id_fkey FOREIGN KEY (team_id) REFERENCES permit.teams(id) ON DELETE RESTRICT;


--
-- Name: organization_audit_events organization_audit_events_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.organization_audit_events
    ADD CONSTRAINT organization_audit_events_team_position_id_fkey FOREIGN KEY (team_position_id) REFERENCES permit.team_positions(id) ON DELETE RESTRICT;


--
-- Name: permit_document_jobs permit_document_jobs_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_document_jobs
    ADD CONSTRAINT permit_document_jobs_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES permit.issued_document_snapshots(id) ON DELETE RESTRICT;


--
-- Name: permit_lifecycle_events permit_lifecycle_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_lifecycle_events
    ADD CONSTRAINT permit_lifecycle_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permit_lifecycle_events permit_lifecycle_events_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_lifecycle_events
    ADD CONSTRAINT permit_lifecycle_events_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: permit_signatures permit_signatures_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: permit_signatures permit_signatures_signer_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_signer_team_position_id_fkey FOREIGN KEY (signer_team_position_id) REFERENCES permit.team_positions(id) ON DELETE RESTRICT;


--
-- Name: permit_signatures permit_signatures_signer_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_signer_user_id_fkey FOREIGN KEY (signer_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permit_signatures permit_signatures_source_event_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permit_signatures
    ADD CONSTRAINT permit_signatures_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES permit.permit_lifecycle_events(id) ON DELETE RESTRICT;


--
-- Name: permits permits_applicant_company_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_applicant_company_id_fkey FOREIGN KEY (applicant_company_id) REFERENCES permit.companies(id) ON DELETE RESTRICT;


--
-- Name: permits permits_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permits permits_closed_by_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permits permits_created_by_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permits permits_held_by_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_held_by_fkey FOREIGN KEY (held_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: permits permits_jsa_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_jsa_id_fkey FOREIGN KEY (jsa_id) REFERENCES permit.jsas(id) ON DELETE RESTRICT;


--
-- Name: permits permits_previous_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.permits
    ADD CONSTRAINT permits_previous_permit_id_fkey FOREIGN KEY (previous_permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: privileged_access_events privileged_access_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_access_events
    ADD CONSTRAINT privileged_access_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: privileged_access_events privileged_access_events_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_access_events
    ADD CONSTRAINT privileged_access_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: privileged_identities privileged_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.privileged_identities
    ADD CONSTRAINT privileged_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: team_position_capabilities team_position_capabilities_capability_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_position_capabilities
    ADD CONSTRAINT team_position_capabilities_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES permit.capabilities(id) ON DELETE CASCADE;


--
-- Name: team_position_capabilities team_position_capabilities_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_position_capabilities
    ADD CONSTRAINT team_position_capabilities_team_position_id_fkey FOREIGN KEY (team_position_id) REFERENCES permit.team_positions(id) ON DELETE CASCADE;


--
-- Name: team_positions team_positions_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_positions
    ADD CONSTRAINT team_positions_position_id_fkey FOREIGN KEY (position_id) REFERENCES permit.positions(id) ON DELETE RESTRICT;


--
-- Name: team_positions team_positions_team_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.team_positions
    ADD CONSTRAINT team_positions_team_id_fkey FOREIGN KEY (team_id) REFERENCES permit.teams(id) ON DELETE RESTRICT;


--
-- Name: teams teams_company_fk; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.teams
    ADD CONSTRAINT teams_company_fk FOREIGN KEY (company_id) REFERENCES permit.companies(id) ON UPDATE RESTRICT ON DELETE RESTRICT;


--
-- Name: user_capability_grants user_capability_grants_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_capability_grants
    ADD CONSTRAINT user_capability_grants_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: user_capability_grants user_capability_grants_capability_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_capability_grants
    ADD CONSTRAINT user_capability_grants_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES permit.capabilities(id) ON DELETE RESTRICT;


--
-- Name: user_capability_grants user_capability_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_capability_grants
    ADD CONSTRAINT user_capability_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: user_team_positions user_team_positions_team_position_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_team_positions
    ADD CONSTRAINT user_team_positions_team_position_id_fkey FOREIGN KEY (team_position_id) REFERENCES permit.team_positions(id) ON DELETE RESTRICT;


--
-- Name: user_team_positions user_team_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.user_team_positions
    ADD CONSTRAINT user_team_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_messages_permit_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.whatsapp_outbox_messages
    ADD CONSTRAINT whatsapp_outbox_messages_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES permit.permits(id) ON DELETE RESTRICT;


--
-- Name: whatsapp_outbox_messages whatsapp_outbox_messages_source_event_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.whatsapp_outbox_messages
    ADD CONSTRAINT whatsapp_outbox_messages_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES permit.permit_lifecycle_events(id) ON DELETE RESTRICT;


--
-- Name: workforce_profiles workforce_profiles_company_fk; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.workforce_profiles
    ADD CONSTRAINT workforce_profiles_company_fk FOREIGN KEY (company_id) REFERENCES permit.companies(id) ON UPDATE RESTRICT ON DELETE RESTRICT;


--
-- Name: workforce_profiles workforce_profiles_primary_assignment_held_by_user; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.workforce_profiles
    ADD CONSTRAINT workforce_profiles_primary_assignment_held_by_user FOREIGN KEY (user_id, primary_team_position_id) REFERENCES permit.user_team_positions(user_id, team_position_id) ON UPDATE RESTRICT ON DELETE RESTRICT;


--
-- Name: workforce_profiles workforce_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: permit; Owner: -
--

ALTER TABLE ONLY permit.workforce_profiles
    ADD CONSTRAINT workforce_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: account_audit_events; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.account_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: app_user_access; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.app_user_access ENABLE ROW LEVEL SECURITY;

--
-- Name: capabilities; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.capabilities ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: initial_ceo_bootstrap; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.initial_ceo_bootstrap ENABLE ROW LEVEL SECURITY;

--
-- Name: issued_document_snapshot_integrity; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.issued_document_snapshot_integrity ENABLE ROW LEVEL SECURITY;

--
-- Name: issued_document_snapshots; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.issued_document_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: jsas; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.jsas ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_audit_events; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.organization_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: permit_document_jobs; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.permit_document_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: permit_lifecycle_events; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.permit_lifecycle_events ENABLE ROW LEVEL SECURITY;

--
-- Name: permit_number_counters; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.permit_number_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: permit_signatures; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.permit_signatures ENABLE ROW LEVEL SECURITY;

--
-- Name: permits; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.permits ENABLE ROW LEVEL SECURITY;

--
-- Name: positions; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.positions ENABLE ROW LEVEL SECURITY;

--
-- Name: privileged_access_events; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.privileged_access_events ENABLE ROW LEVEL SECURITY;

--
-- Name: privileged_identities; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.privileged_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: team_position_capabilities; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.team_position_capabilities ENABLE ROW LEVEL SECURITY;

--
-- Name: team_positions; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.team_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: user_capability_grants; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.user_capability_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: user_team_positions; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.user_team_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_outbox_messages; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.whatsapp_outbox_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_profiles; Type: ROW SECURITY; Schema: permit; Owner: -
--

ALTER TABLE permit.workforce_profiles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--
