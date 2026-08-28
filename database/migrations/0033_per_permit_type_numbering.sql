-- =====================================================================
-- 0033  Per-permit-type permit numbering
-- =====================================================================
--
-- THE RULE THIS IMPLEMENTS.
--
-- Every permit type is numbered in its own independent series:
--
--     COLD_WORK             1, 2, 3, ...
--     HOT_WORK              1, 2, 3, ...
--     WTG_WORK              1, 2, 3, ...
--     CONFINED_SPACE_ENTRY  1, 2, 3, ...
--
-- so Cold Work #1 and Hot Work #1 are two different permits and both are
-- legitimate. THE JSA SERIES IS UNCHANGED and stays one global,
-- continuous sequence across every permit type - `jsas.jsa_sequence`,
-- `jsa_number_seq` and `jsas_jsa_sequence_unique` are not touched by a
-- single statement in this migration.
--
-- WHAT WAS WRONG. Migration 0006 gave `permits.permit_sequence` a column
-- DEFAULT of `nextval('permit_number_seq')` and a global
-- `UNIQUE (permit_sequence)`. One sequence served all four types, so the
-- four series were interleaved fragments of one counter.
--
-- WHY A COUNTER TABLE AND A TRIGGER, NOT FOUR SEQUENCES OR A DEFAULT.
--
--   * A column DEFAULT cannot see another column of the row being
--     inserted, so `DEFAULT next_for(permit_type)` is not expressible. A
--     BEFORE INSERT trigger can, which is why the allocation lives there.
--   * `nextval` is not transactional: a rolled-back permit creation would
--     burn a number and leave a gap in a legal register. `UPDATE ...
--     RETURNING` on a counter row is transactional, so a rolled-back
--     creation returns its number to the series.
--   * The `UPDATE` takes a row lock, so two concurrent creations of the
--     SAME type serialise on that one row and cannot receive the same
--     number; creations of DIFFERENT types touch different rows and do
--     not block each other at all. `UNIQUE (permit_type,
--     permit_sequence)` is the backstop underneath that.
--
-- THE CLIENT CANNOT CHOOSE A NUMBER. The trigger OVERWRITES whatever
-- `permit_sequence` an INSERT supplies for a typed permit. Numbering is
-- the database's, not the caller's - a request cannot ask for a permit
-- number any more than it can ask for someone else's identity.
--
-- EXISTING RECORDS ARE NOT RENUMBERED, AND NOTHING ELSE IS TOUCHED. No
-- permit row is updated or deleted here. Issued snapshots, generated
-- PDFs, file hashes, snapshot hashes, lifecycle events, notifications,
-- JSA numbers, workflow status and applicant identity are all untouched -
-- this migration writes to exactly one new table and changes one column
-- default, one constraint and adds one trigger.
--
-- CONSEQUENCE, STATED PLAINLY: because existing numbers are preserved,
-- each type's counter starts from ONE PAST THE HIGHEST NUMBER THAT TYPE
-- ALREADY HOLDS, not from 1. On a database with live records the series
-- become independent from here on, but they do not restart. Starting
-- every type at 1 requires deleting the existing workflow data, which is
-- a pre-production/UAT operation with its own separately-approved
-- procedure and is deliberately NOT in this migration.
--
-- NO EXPLICIT BEGIN/COMMIT. `db/migrate.ts` already runs each migration
-- file inside a transaction and writes its `schema_migrations` ledger row
-- in that same transaction. A `COMMIT;` inside the file would end the
-- runner's transaction early, so the schema change would land BEFORE the
-- ledger row - and an interruption in that window would leave 0033
-- applied but unrecorded, which the next run would try to apply again and
-- fail on. Migrations 0001-0031 all rely on the runner for this reason.

-- =====================================================================
-- 1. The per-type allocator
-- =====================================================================
--
-- One row per permit type. `next_value` is the number the NEXT permit of
-- that type will receive.
CREATE TABLE permit_number_counters (
  permit_type TEXT PRIMARY KEY,
  next_value BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permit_number_counters_type_valid CHECK (
    permit_type IN ('WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY')
  ),
  CONSTRAINT permit_number_counters_next_value_positive CHECK (next_value >= 1)
);

ALTER TABLE permit_number_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit_number_counters FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE permit_number_counters IS
  'Per-permit-type permit number allocator. One row per type; next_value is the number the next permit of that type receives. Advanced only by the permits BEFORE INSERT trigger.';

-- Seeded from what each type ALREADY holds, so no existing permit number
-- is reused and no existing row is rewritten. A type with no permits yet
-- starts at 1.
INSERT INTO permit_number_counters (permit_type, next_value)
SELECT t.permit_type,
       COALESCE((SELECT max(p.permit_sequence) FROM permits p WHERE p.permit_type = t.permit_type), 0) + 1
  FROM (VALUES ('WTG_WORK'), ('COLD_WORK'), ('HOT_WORK'), ('CONFINED_SPACE_ENTRY')) AS t(permit_type);

-- =====================================================================
-- 2. Allocation
-- =====================================================================
--
-- The single place a permit number is produced. `UPDATE ... RETURNING`
-- both advances the counter and reports the number it consumed under one
-- row lock, so two concurrent callers of the same type cannot observe
-- the same value.
CREATE OR REPLACE FUNCTION public.allocate_permit_sequence(p_permit_type TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

CREATE OR REPLACE FUNCTION public.permits_assign_permit_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.permit_type IS NULL THEN
    -- Pre-form permits predate the permit type and have no series of
    -- their own; they keep the original global sequence so their numbers
    -- stay meaningful and unique among themselves.
    IF NEW.permit_sequence IS NULL THEN
      NEW.permit_sequence := nextval('permit_number_seq');
    END IF;
    RETURN NEW;
  END IF;

  -- Unconditional: a supplied permit_sequence is discarded. The number
  -- is the database's to issue.
  NEW.permit_sequence := public.allocate_permit_sequence(NEW.permit_type);
  RETURN NEW;
END;
$$;

CREATE TRIGGER permits_assign_permit_sequence_trigger
  BEFORE INSERT ON permits
  FOR EACH ROW EXECUTE FUNCTION public.permits_assign_permit_sequence();

-- The column DEFAULT is removed so the trigger is the ONLY allocator for
-- a typed permit. `permit_number_seq` itself is kept, still owned by the
-- column: it remains the series for pre-form (untyped) permits and
-- records where the global numbering stopped.
ALTER TABLE permits ALTER COLUMN permit_sequence DROP DEFAULT;

-- =====================================================================
-- 3. Uniqueness: per type, not global
-- =====================================================================
--
-- Two partial indexes rather than one plain UNIQUE (permit_type,
-- permit_sequence), because `permit_type` is nullable and SQL treats
-- NULLs as distinct - which would have left pre-form permits with no
-- uniqueness guarantee at all.
ALTER TABLE permits DROP CONSTRAINT permits_permit_sequence_unique;

CREATE UNIQUE INDEX permits_permit_type_sequence_unique
  ON permits (permit_type, permit_sequence)
  WHERE permit_type IS NOT NULL;

CREATE UNIQUE INDEX permits_untyped_sequence_unique
  ON permits (permit_sequence)
  WHERE permit_type IS NULL;

-- =====================================================================
-- 4. The minimum write authority the runtime login needs
-- =====================================================================
-- Guarded by a role-existence check for the same reason as 0019/0021/0030:
-- `app_runtime` is an operator-created login that does not exist in every
-- environment, and must never be CREATED by a migration in source control.
--
-- UPDATE is COLUMN-SCOPED to the two columns the allocator writes, and no
-- INSERT/DELETE/TRUNCATE is granted: the runtime can advance a counter,
-- but cannot add a type, remove one, or empty the table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.permit_number_counters TO app_runtime';
    EXECUTE 'GRANT UPDATE (next_value, updated_at) ON TABLE public.permit_number_counters TO app_runtime';
  END IF;
END;
$$;

-- =====================================================================
-- 5. Self-verification
-- =====================================================================
-- Fail the migration rather than leave a half-applied numbering model,
-- a wrongly-scoped privilege, or a duplicate number behind.
DO $$
DECLARE
  counters BIGINT;
  duplicates BIGINT;
  granted TEXT;
  over_granted TEXT;
BEGIN
  SELECT count(*) INTO counters FROM permit_number_counters;
  IF counters <> 4 THEN
    RAISE EXCEPTION '0033 failed: expected 4 permit number counters, found %', counters;
  END IF;

  -- No seeded counter may hand out a number a permit of that type
  -- already holds.
  IF EXISTS (
    SELECT 1 FROM permit_number_counters c
     WHERE c.next_value <= COALESCE(
       (SELECT max(p.permit_sequence) FROM permits p WHERE p.permit_type = c.permit_type), 0)
  ) THEN
    RAISE EXCEPTION '0033 failed: a counter would reissue an existing permit number';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'permits_assign_permit_sequence_trigger' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0033 failed: the permit numbering trigger is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'permits_permit_sequence_unique'
  ) THEN
    RAISE EXCEPTION '0033 failed: the global permit_sequence uniqueness rule is still present';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE indexname = 'permits_permit_type_sequence_unique')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE indexname = 'permits_untyped_sequence_unique') THEN
    RAISE EXCEPTION '0033 failed: the per-type uniqueness indexes are missing';
  END IF;

  -- Existing data must already satisfy the new rule.
  SELECT count(*) INTO duplicates FROM (
    SELECT permit_type, permit_sequence FROM permits GROUP BY 1, 2 HAVING count(*) > 1
  ) AS d;
  IF duplicates > 0 THEN
    RAISE EXCEPTION '0033 failed: % duplicate (permit_type, permit_sequence) pair(s) already exist', duplicates;
  END IF;

  -- The JSA series is untouched: still global, still uniquely constrained.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'jsas_jsa_sequence_unique'
  ) THEN
    RAISE EXCEPTION '0033 failed: the global JSA uniqueness rule was disturbed';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO granted
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'permit_number_counters'
       AND grantee = 'app_runtime' AND privilege_type = 'UPDATE';
    IF granted IS DISTINCT FROM 'next_value, updated_at' THEN
      RAISE EXCEPTION '0033 failed: app_runtime UPDATE columns on permit_number_counters are [%], expected next_value, updated_at', coalesce(granted, 'none');
    END IF;

    IF has_table_privilege('app_runtime', 'public.permit_number_counters', 'UPDATE') THEN
      RAISE EXCEPTION '0033 failed: app_runtime holds table-level UPDATE on permit_number_counters';
    END IF;
    IF has_table_privilege('app_runtime', 'public.permit_number_counters', 'INSERT')
       OR has_table_privilege('app_runtime', 'public.permit_number_counters', 'DELETE')
       OR has_table_privilege('app_runtime', 'public.permit_number_counters', 'TRUNCATE') THEN
      RAISE EXCEPTION '0033 failed: app_runtime holds INSERT, DELETE or TRUNCATE on permit_number_counters';
    END IF;
  END IF;

  -- The browser-facing roles must hold nothing at all on the counters.
  SELECT string_agg(DISTINCT grantee, ', ') INTO over_granted
    FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'permit_number_counters'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF over_granted IS NOT NULL THEN
    RAISE EXCEPTION '0033 failed: browser-facing role(s) [%] hold privileges on permit_number_counters', over_granted;
  END IF;
END;
$$;
