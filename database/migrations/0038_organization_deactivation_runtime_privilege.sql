-- Fix the runtime privilege required by the organization deactivation
-- lifecycle guards introduced in 0035.
--
-- 0035 intentionally created organization_required_coverage_gap() as
-- SECURITY INVOKER and revoked PUBLIC execution. The deactivation
-- triggers call that helper while running under the ordinary runtime
-- role, so app_runtime must be able to EXECUTE it.
--
-- 0037 granted UPDATE (deactivated_at) on the organization tables but
-- omitted this transitive function dependency. As a result, otherwise
-- valid deactivation attempts fail with a database permission error and
-- roll back.
--
-- This migration grants ONLY EXECUTE on the read-only coverage helper.
-- It grants no additional table write authority and does not alter any
-- schema or data.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles
     WHERE rolname = 'app_runtime'
  ) THEN
    RAISE WARNING
      '0038: role app_runtime does not exist; organization deactivation runtime privilege was not granted';
    RETURN;
  END IF;

  EXECUTE
    'GRANT EXECUTE ON FUNCTION public.organization_required_coverage_gap(UUID, UUID, UUID) TO app_runtime';
END;
$$;

-- ---------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------

DO $$
DECLARE
  fn_oid OID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles
     WHERE rolname = 'app_runtime'
  ) THEN
    RETURN;
  END IF;

  SELECT p.oid
    INTO fn_oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n
      ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'organization_required_coverage_gap'
     AND p.pronargs = 3;

  IF fn_oid IS NULL THEN
    RAISE EXCEPTION
      '0038: organization_required_coverage_gap(uuid, uuid, uuid) is missing';
  END IF;

  IF NOT has_function_privilege('app_runtime', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      '0038: app_runtime cannot execute organization_required_coverage_gap()';
  END IF;
END;
$$;
