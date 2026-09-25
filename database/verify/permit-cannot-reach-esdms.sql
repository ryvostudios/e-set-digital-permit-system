-- Run while connected AS permit_runtime and again AS permit_privileged
-- (real logins). Every attempt to read, write, alter or execute ESDMS
-- objects must be refused with insufficient_privilege (42501); any success
-- or any other outcome fails the check. Nothing is left behind: the whole
-- check runs in one transaction that is rolled back.
--
--   psql -v esdms_tables=users,employees,... -f permit-cannot-reach-esdms.sql
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('rehearsal.esdms_tables', :'esdms_tables', true) AS configured \gset rehearsal_
DO $check$
DECLARE
  target text;
  first_column text;
  attempt text;
  problems text[] := '{}';
  fn regprocedure;
BEGIN
  IF current_user NOT IN ('permit_runtime', 'permit_privileged') THEN
    RAISE EXCEPTION 'run this check as a Permit runtime login, not %', current_user;
  END IF;
  IF 'public' = ANY (current_schemas(false)) THEN
    RAISE EXCEPTION '% resolves names through schema public: %', current_user, current_schemas(false);
  END IF;

  FOREACH target IN ARRAY string_to_array(current_setting('rehearsal.esdms_tables'), ',') LOOP
    SELECT quote_ident(a.attname) INTO first_column FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', target)::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum LIMIT 1;
    FOREACH attempt IN ARRAY ARRAY[
      format('SELECT * FROM public.%I LIMIT 1', target),
      format('INSERT INTO public.%I DEFAULT VALUES', target),
      format('UPDATE public.%I SET %s = %s', target, first_column, first_column),
      format('DELETE FROM public.%I', target),
      format('TRUNCATE public.%I', target),
      format('ALTER TABLE public.%I ADD COLUMN permit_probe int', target),
      format('DROP TABLE public.%I', target)
    ] LOOP
      BEGIN
        EXECUTE attempt;
        problems := problems || ('ALLOWED: ' || attempt);
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
        WHEN OTHERS THEN problems := problems || (SQLSTATE || ' (not 42501): ' || attempt);
      END;
    END LOOP;
  END LOOP;

  FOREACH attempt IN ARRAY ARRAY['CREATE TABLE public.permit_probe (id int)', 'CREATE SCHEMA permit_probe'] LOOP
    BEGIN
      EXECUTE attempt;
      problems := problems || ('ALLOWED: ' || attempt);
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN OTHERS THEN problems := problems || (SQLSTATE || ' (not 42501): ' || attempt);
    END;
  END LOOP;

  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
               AND has_function_privilege(p.oid, 'EXECUTE') LOOP
    problems := problems || ('EXECUTE allowed on ESDMS function ' || fn::text);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    problems := problems || 'owns an ESDMS relation'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'ISOLATION FAILURE for %: %', current_user, array_to_string(problems, E'\n');
  END IF;
  RAISE NOTICE '% cannot read, write, alter, drop or execute any of % ESDMS tables or public functions',
    current_user, cardinality(string_to_array(current_setting('rehearsal.esdms_tables'), ','));
END
$check$;
ROLLBACK;
