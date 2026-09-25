-- Run while connected AS esdms_runtime (real login). Every attempt to
-- read, write or execute Permit objects must be refused (42501). Rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $check$
DECLARE
  target text;
  attempt text;
  problems text[] := '{}';
  checked int := 0;
BEGIN
  IF current_user <> 'esdms_runtime' THEN
    RAISE EXCEPTION 'run this check as esdms_runtime, not %', current_user;
  END IF;
  IF has_schema_privilege('permit', 'USAGE') OR has_schema_privilege('permit', 'CREATE') THEN
    problems := problems || 'holds a privilege on schema permit'::text;
  END IF;
  FOR target IN SELECT relname FROM pg_class
                 WHERE relnamespace = 'permit'::regnamespace AND relkind = 'r' ORDER BY 1 LOOP
    checked := checked + 1;
    FOREACH attempt IN ARRAY ARRAY[
      format('SELECT * FROM permit.%I LIMIT 1', target),
      format('INSERT INTO permit.%I DEFAULT VALUES', target),
      format('DELETE FROM permit.%I', target),
      format('TRUNCATE permit.%I', target)
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
  BEGIN
    EXECUTE 'SELECT permit.allocate_permit_sequence(''WTG_WORK'')';
    problems := problems || 'ALLOWED: permit.allocate_permit_sequence'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'CREATE TABLE permit.esdms_probe (id int)';
    problems := problems || 'ALLOWED: CREATE TABLE permit.esdms_probe'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF checked < 25 THEN
    problems := problems || format('expected at least 25 permit tables, saw %s', checked);
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'ISOLATION FAILURE for esdms_runtime: %', array_to_string(problems, E'\n');
  END IF;
  RAISE NOTICE 'esdms_runtime cannot read, write or execute any of % Permit tables', checked;
END
$check$;
ROLLBACK;
