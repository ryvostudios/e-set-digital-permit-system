-- GENERATION ONLY. Runs inside the disposable replay database after
-- `ALTER SCHEMA public RENAME TO permit`. The rename moves every
-- OID-bound reference (tables, columns, defaults, constraints, indexes,
-- triggers, sequences, comments) with the catalog. Two things are stored
-- as TEXT and do not move, so they are rewritten here and verified:
--   1. `public.<object>` references inside function bodies;
--   2. `search_path` settings pinned on functions.
-- Every rewritten reference must name a Permit object; anything else
-- aborts generation.
\set ON_ERROR_STOP on

DO $rewrite$
DECLARE
  fn record;
  tok text;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname, p.prosrc FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'permit'::regnamespace
  LOOP
    FOR tok IN
      SELECT DISTINCT m[1] FROM regexp_matches(fn.prosrc, '\mpublic\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS m
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                      WHERE c.relnamespace = 'permit'::regnamespace AND c.relname = tok)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                          WHERE q.pronamespace = 'permit'::regnamespace AND q.proname = tok) THEN
        RAISE EXCEPTION 'function % references public.% which is not a Permit object', fn.proname, tok;
      END IF;
    END LOOP;
    IF fn.prosrc ~* '\mpublic\s*\.' THEN
      EXECUTE regexp_replace(pg_catalog.pg_get_functiondef(fn.oid), '\mpublic\.', 'permit.', 'g');
    END IF;
  END LOOP;

  -- Invoker functions that resolved unqualified Permit names through
  -- `public` now resolve them through `permit`.
  FOR fn IN
    SELECT p.oid FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'permit'::regnamespace
       AND array_to_string(p.proconfig, ',') = 'search_path=pg_catalog, public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, permit', fn.oid::regprocedure);
  END LOOP;

  -- SECURITY DEFINER hardening: pg_temp is searched first for relations
  -- unless it is listed explicitly, so pin it last.
  FOR fn IN
    SELECT p.oid FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'permit'::regnamespace AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', fn.oid::regprocedure);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'permit'::regnamespace
                AND (p.prosrc ~* '\mpublic\s*\.' OR array_to_string(p.proconfig, ',') ~* 'public')) THEN
    RAISE EXCEPTION 'a Permit function still references schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'permit'::regnamespace AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION 'a Permit function has no pinned search_path';
  END IF;
END
$rewrite$;
