-- Complete the service_role application-object boundary for functions.
-- Migration 0025 removed every public application table/sequence write,
-- but Supabase default privileges had independently granted service_role
-- EXECUTE on application functions. Auth Admin uses service_role only over
-- Supabase HTTP and needs no SQL EXECUTE on this project's public routines.
-- Extension-owned routines are excluded; auth/storage schemas are untouched.

DO $$
DECLARE
  target RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE '0027: service_role does not exist in this database; nothing to revoke';
    RETURN;
  END IF;

  FOR target IN
    SELECT p.oid::regprocedure AS ident
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
     ORDER BY p.oid::regprocedure::text
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM service_role', target.ident);
  END LOOP;
END;
$$;

DO $$
DECLARE
  offender TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RETURN;
  END IF;

  SELECT p.oid::regprocedure::text INTO offender
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
     )
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
   ORDER BY p.oid::regprocedure::text
   LIMIT 1;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '0027: service_role can still execute application function %', offender;
  END IF;
END;
$$;

-- No table, sequence, schema, role, auth, or storage privilege is changed.
-- app_runtime and privileged_runtime are untouched.
