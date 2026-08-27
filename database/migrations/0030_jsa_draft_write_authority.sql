-- Least-privilege JSA draft-write authority.
--
-- Migrations 0001-0029 are immutable applied history and are not edited
-- by this file.
--
-- WHY. `updateLinkedJsa` (domain/permits/service.ts) is the ONLY code
-- path that ever updates a JSA row, and it writes exactly four columns:
--
--     UPDATE jsas
--        SET form_version = $1, form_payload = $2::jsonb,
--            site_or_wtg = $3, job_description = $4
--      WHERE id = $5
--
-- `app_runtime` holds INSERT and SELECT on `jsas` but no UPDATE at all -
-- the one workflow table where it is missing - so that statement fails
-- with SQLSTATE 42501 and the JSA half of "Save Draft" has never worked.
-- The evidence is in the data: of the four JSA rows in the live
-- database, zero have ever held a payload. This is generation-independent
-- and breaks V1 exactly as much as V2.
--
-- WHAT THIS GRANTS, AND WHY NOT MORE. Table-level UPDATE would hand the
-- runtime login authority over every column of `jsas` including `id`,
-- `jsa_sequence`, `created_by`, `created_at` and `updated_at` - the row
-- identity, the authoritative permit-number lineage, and the row
-- provenance. None of that is ever written by the application. So this
-- grants COLUMN-LEVEL UPDATE on exactly the four columns above and
-- nothing else, following the model migration 0023 already established
-- for `workforce_profiles` and `user_team_positions` (DEPLOYMENT.md:
-- "These are column-level UPDATE grants. Do not replace either with
-- table-level UPDATE"). No DELETE, no TRUNCATE, no REFERENCES, no
-- TRIGGER, no ownership, no DDL. `service_role` and `privileged_runtime`
-- are untouched, and PUBLIC/anon/authenticated keep nothing.
--
-- WHY A GRANT ALONE IS NOT ENOUGH. A column privilege says WHICH columns
-- may be written; it cannot say WHEN. With the grant alone, the runtime
-- login could rewrite the safety content of a JSA belonging to an
-- ISSUED, CLOSED or CANCELLED permit - the exact historical record the
-- system exists to keep honest. Application code refuses that today, but
-- "the application checks it" is not a database guarantee: a defect in
-- one route, or any future caller, would silently rewrite history. So
-- the second half of this migration is a trigger that rejects mutation
-- of JSA content whenever the linked permit is no longer editable.
--
-- The trigger is the authority; the grant is merely the reach.

-- =====================================================================
-- 1. Preconditions
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'jsas'
  ) THEN
    RAISE EXCEPTION '0030 precondition failed: public.jsas is missing';
  END IF;

  -- The four columns this migration authorizes must all exist, or the
  -- grant below would name a column that no longer matches the code.
  IF (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'jsas'
       AND column_name IN ('form_version', 'form_payload', 'site_or_wtg', 'job_description')
  ) <> 4 THEN
    RAISE EXCEPTION '0030 precondition failed: the four JSA content columns are not all present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'permits' AND column_name = 'jsa_id'
  ) THEN
    RAISE EXCEPTION '0030 precondition failed: permits.jsa_id is missing';
  END IF;
END;
$$;

-- =====================================================================
-- 2. Historical immutability: content may change only while editable
-- =====================================================================
-- A JSA row is shared by the whole renewal lineage of its permit
-- (migration 0006: a renewal reuses the SAME jsa row rather than copying
-- it), so "the linked permit" is genuinely plural and the rule is
-- universal, not existential: EVERY permit pointing at this JSA must
-- currently be editable. One ISSUED permit in the lineage freezes the
-- JSA, which is precisely the intent - that JSA is now the safety basis
-- of work that has been authorized.
--
-- EDITABLE means DRAFT or PENDING_CORRECTION, matching the application
-- constant `EDITABLE_STATUSES` exactly. PENDING_CORRECTION is
-- deliberately included: a permit sent back by the CRO for correction is
-- not history, it is work in progress, and its JSA must remain
-- correctable. Hard-coding DRAFT alone would make the database refuse
-- what the workflow legitimately allows, breaking the correction path.
--
-- Only a REAL content change is challenged. `IS DISTINCT FROM` means an
-- UPDATE that rewrites the same values, or that touches only
-- `updated_at`, passes untouched - including the BEFORE trigger from
-- migration 0016 that maintains the timestamps.
--
-- SECURITY INVOKER, and deliberately so. If row-level security were ever
-- to hide a linked permit from the caller, this function would see fewer
-- linked permits, not more - and because the rule additionally requires
-- at least one linked permit to be visible, that failure mode is a
-- refusal, never a silent permission. It fails closed.
CREATE FUNCTION public.jsas_content_editable_only() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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
    FROM public.permits
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
REVOKE ALL ON FUNCTION public.jsas_content_editable_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER jsas_content_editable_only_trigger
  BEFORE UPDATE ON jsas
  FOR EACH ROW EXECUTE FUNCTION public.jsas_content_editable_only();

-- =====================================================================
-- 3. The minimum write authority the runtime login needs
-- =====================================================================
-- Guarded by a role-existence check for the same reason as 0019/0021:
-- `app_runtime` is an operator-created login that does not exist in
-- every environment, and must never be CREATED by a migration in source
-- control.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT UPDATE (form_version, form_payload, site_or_wtg, job_description)
               ON TABLE public.jsas TO app_runtime';
  END IF;
END;
$$;

-- =====================================================================
-- 4. Self-verification
-- =====================================================================
-- Fail the migration rather than leave a wrongly-scoped privilege or a
-- missing guard behind.
DO $$
DECLARE
  granted TEXT;
  over_granted TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'jsas_content_editable_only_trigger' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0030 failed: the JSA historical-immutability trigger is missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    -- Exactly the four intended columns, no more and no fewer.
    SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO granted
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'jsas'
       AND grantee = 'app_runtime' AND privilege_type = 'UPDATE';
    IF granted IS DISTINCT FROM 'form_payload, form_version, job_description, site_or_wtg' THEN
      RAISE EXCEPTION '0030 failed: app_runtime UPDATE columns on jsas are [%], expected the four content columns', coalesce(granted, 'none');
    END IF;

    -- Column privileges must not have become a table privilege, and no
    -- destructive authority may have come with them.
    IF has_table_privilege('app_runtime', 'public.jsas', 'UPDATE') THEN
      RAISE EXCEPTION '0030 failed: app_runtime holds table-level UPDATE on jsas';
    END IF;
    IF has_table_privilege('app_runtime', 'public.jsas', 'DELETE')
       OR has_table_privilege('app_runtime', 'public.jsas', 'TRUNCATE') THEN
      RAISE EXCEPTION '0030 failed: app_runtime holds DELETE or TRUNCATE on jsas';
    END IF;
  END IF;

  -- The browser-facing roles must still hold nothing at all on jsas.
  SELECT string_agg(DISTINCT grantee, ', ') INTO over_granted
    FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'jsas'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF over_granted IS NOT NULL THEN
    RAISE EXCEPTION '0030 failed: jsas is exposed to [%]', over_granted;
  END IF;

  SELECT string_agg(DISTINCT grantee, ', ') INTO over_granted
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'jsas'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF over_granted IS NOT NULL THEN
    RAISE EXCEPTION '0030 failed: jsas columns are exposed to [%]', over_granted;
  END IF;

  -- RLS must still be on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'jsas' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '0030 failed: row-level security is no longer enabled on jsas';
  END IF;
END;
$$;
