-- The applicant-company identity CONTRACT.
--
-- Migrations 0001-0035 are immutable applied history and are not edited
-- by this file. 0035 is LIVE; everything here is additive to it.
--
-- =====================================================================
-- EXPAND -> DEPLOY -> CONTRACT: THIS IS THE **CONTRACT** MIGRATION
-- =====================================================================
--
-- 0035 was the EXPAND step. It added `permits.applicant_company_id`,
-- its foreign key, its index and a deterministic backfill, but did NOT
-- require the column - deliberately, so the then-deployed backend
-- (2a498d5), which writes only the three legacy snapshot columns, could
-- keep submitting and renewing permits while the migration was applied
-- ahead of the deploy. 0035 stated in terms that this was TRANSITIONAL
-- and that `applicant_company_id` was best-effort, not authoritative,
-- until this migration ran.
--
-- The deploy has happened. The live backend is `dba7922`, and it
-- populates `applicant_company_id` on every submission and carries it
-- forward on every renewal. This migration closes the window:
--
--   1. backfill the rows the old backend wrote during the overlap,
--      resolving `applicant_company_code` against `companies.code` and
--      inventing nothing;
--   2. refuse to proceed if any applicant company code does not resolve
--      to exactly one company row;
--   3. prove no completed applicant identity is left without its
--      authoritative company;
--   4. require `applicant_company_id` in the completed branch of
--      `permits_applicant_identity_complete`.
--
-- =====================================================================
-- ROLLBACK IS CLOSED AFTER THIS MIGRATION
-- =====================================================================
--
-- ONCE THIS IS APPLIED, ROLLING THE BACKEND BACK TO ANY BUILD BEFORE
-- `dba7922` IS NOT SAFE FOR APPLICANT-IDENTITY WRITES.
--
-- A pre-`dba7922` backend writes `applicant_display_name`,
-- `applicant_company_code` and `applicant_company_name` and does not
-- know `applicant_company_id`. Against the constraint below that write
-- fails with SQLSTATE 23514 on `permits_applicant_identity_complete`,
-- so permit SUBMIT and RENEW would both break - the exact failure the
-- expand step existed to avoid, reintroduced in the opposite direction.
--
-- Reading is unaffected: an older backend's SELECT lists never name the
-- new column, so permit lists, detail and search continue to work. It is
-- specifically the two identity-freezing writes that stop.
--
-- A rollback past `dba7922` therefore requires a forward migration that
-- relaxes this constraint again, deployed FIRST. There is no ordering in
-- which the old backend and this constraint coexist.
--
-- =====================================================================
-- WHAT THIS MIGRATION DOES NOT TOUCH
-- =====================================================================
--
--   * `applicant_company_code` / `applicant_company_name`. They are the
--     frozen DISPLAY SNAPSHOT of the company as it was at submission
--     (0024), and 0035 kept them exactly so a later company rename
--     cannot alter an issued document. Not one historical value is
--     rewritten here; only the missing `applicant_company_id` is filled.
--   * `permits.company` / `company_other` and their CHECKs - the printed
--     FORM field, settled by 0024 and untouched by 0035.
--   * the foreign key, index and freeze trigger 0035 created. The freeze
--     trigger only rejects a CHANGE to a non-NULL value, so the backfill
--     below - NULL to a real id - passes it, exactly as 0035's own
--     backfill did.
--   * organization CONFIGURATION and LIFECYCLE STATE. No company, team,
--     position, team_position, capability mapping, audit row, RLS policy
--     or grant is created, altered or deleted here, and no
--     `deactivated_at` is set or cleared. The lifecycle guards and the
--     baseline grant function from 0035 are left exactly as they are.
--
--     `public.companies` IS read, in sections 1 and 2: the guard counts
--     the rows a frozen `applicant_company_code` matches, and the
--     backfill joins on `companies.code` to resolve
--     `applicant_company_id`. Both are SELECT-side only - the sole table
--     this migration writes to is `public.permits`, and the sole column
--     it writes is `applicant_company_id`.
--   * `app_runtime` privileges. This migration creates no table,
--     function, sequence or trigger, so it requires NO privilege change
--     of any kind. The organization-management grants remain a PHASE 2
--     prerequisite and are deliberately NOT applied here.

-- =====================================================================
-- 1. Fail closed on an applicant company code that does not resolve
-- =====================================================================
--
-- Checked BEFORE the backfill, so an unresolvable code aborts the
-- migration with a clear message instead of being silently skipped by
-- the UPDATE's join and then rediscovered as a constraint violation.
--
-- "EXACTLY ONE" rather than "at least one": `companies.code` is UNIQUE
-- (0018), so more than one match is currently unrepresentable - but this
-- guard states the requirement it actually depends on rather than
-- relying on a constraint declared in another file.
DO $$
DECLARE
  unresolvable BIGINT;
  sample TEXT;
BEGIN
  SELECT count(*), min(p.applicant_company_code)
    INTO unresolvable, sample
    FROM public.permits p
   WHERE p.applicant_company_code IS NOT NULL
     AND (
       SELECT count(*) FROM public.companies c WHERE c.code = p.applicant_company_code
     ) <> 1;

  IF unresolvable <> 0 THEN
    RAISE EXCEPTION
      '0036 refused: % permit(s) carry an applicant company code that does not resolve to exactly one company (e.g. %); resolve them before contracting the identity',
      unresolvable, sample;
  END IF;
END;
$$;

-- =====================================================================
-- 2. Backfill the deployment-overlap rows
-- =====================================================================
--
-- Deterministic and total: the code resolves 1:1 to a company row, and
-- section 1 has already refused to run otherwise. Only rows still
-- missing the id are touched, and only that one column is written - the
-- frozen code and name snapshots are left exactly as they were.
--
-- This is the same resolve-by-code the EXPAND migration performed; the
-- rows it catches are the ones the pre-`dba7922` backend wrote after
-- 0035 was applied and before the deploy completed.
UPDATE public.permits p
   SET applicant_company_id = c.id
  FROM public.companies c
 WHERE p.applicant_company_code IS NOT NULL
   AND p.applicant_company_id IS NULL
   AND c.code = p.applicant_company_code;

-- =====================================================================
-- 3. Prove the backfill is complete
-- =====================================================================
--
-- A completed applicant identity is one that has a display name: 0024's
-- all-or-nothing rule means the code and name are then present too. Any
-- such row still missing its authoritative company would be rejected by
-- the constraint in section 4, so it is caught HERE, with a message that
-- says what is wrong, rather than as a bare CHECK violation.
DO $$
DECLARE
  incomplete BIGINT;
BEGIN
  SELECT count(*) INTO incomplete
    FROM public.permits
   WHERE applicant_display_name IS NOT NULL
     AND applicant_company_id IS NULL;

  IF incomplete <> 0 THEN
    RAISE EXCEPTION
      '0036: % permit(s) still carry a completed applicant identity with no authoritative company after backfill',
      incomplete;
  END IF;
END;
$$;

-- =====================================================================
-- 4. Require the authoritative company in a completed identity
-- =====================================================================
--
-- The FINAL rule. Identical to 0035's in every respect except the last
-- line of the completed branch, which is restored:
--
--   * a permit with NO applicant identity - every DRAFT, and every
--     permit created before 0024 - keeps all four columns NULL and is
--     accepted. NOTHING here makes an ordinary draft require an
--     applicant identity;
--   * a COMPLETED identity must now carry all four, the authoritative
--     company included.
--
-- Each test stays explicit rather than implied, for the reason 0024
-- spelled out: a predicate on a NULL column evaluates to NULL, and a
-- CHECK only rejects on FALSE, so `IS NOT NULL` must be stated before
-- any test that depends on the value.
--
-- The foreign key from 0035 still independently requires the id to name
-- a real company, and the freeze trigger still makes every one of the
-- four values permanent once written. This constraint adds presence; it
-- does not replace either of those.
ALTER TABLE public.permits DROP CONSTRAINT permits_applicant_identity_complete;
ALTER TABLE public.permits
  ADD CONSTRAINT permits_applicant_identity_complete CHECK (
    (applicant_display_name IS NULL AND applicant_company_code IS NULL
       AND applicant_company_name IS NULL AND applicant_company_id IS NULL)
    OR (
      applicant_display_name IS NOT NULL AND btrim(applicant_display_name) <> ''
      AND applicant_company_code IS NOT NULL AND btrim(applicant_company_code) <> ''
      AND applicant_company_name IS NOT NULL AND btrim(applicant_company_name) <> ''
      AND applicant_company_id IS NOT NULL
    )
  );

-- =====================================================================
-- 5. Self-verification
-- =====================================================================
--
-- The migration asserts its own outcome, so a silently wrong result
-- fails it rather than leaving the identity contract half-applied.
--
-- Deliberately scoped to what THIS migration is responsible for. It does
-- not assert organization row counts: by the time a contract migration
-- runs, runtime organization management may legitimately have created
-- companies, teams or associations, and a count assertion here would
-- fail on a perfectly healthy database. Those invariants belong to
-- 0035's self-verification and to the migration test suites.
DO $$
DECLARE
  actual BIGINT;
  definition TEXT;
BEGIN
  -- No completed identity lacks its authoritative company.
  SELECT count(*) INTO actual
    FROM public.permits
   WHERE applicant_display_name IS NOT NULL AND applicant_company_id IS NULL;
  IF actual <> 0 THEN
    RAISE EXCEPTION '0036: % permit(s) still lack an authoritative applicant company', actual;
  END IF;

  -- No half-written identity exists in either direction.
  SELECT count(*) INTO actual
    FROM public.permits
   WHERE applicant_company_id IS NOT NULL AND applicant_display_name IS NULL;
  IF actual <> 0 THEN
    RAISE EXCEPTION '0036: % permit(s) carry an authoritative company with no applicant identity', actual;
  END IF;

  -- The contract is actually in force, not merely intended.
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO definition
    FROM pg_catalog.pg_constraint
   WHERE conname = 'permits_applicant_identity_complete'
     AND conrelid = 'public.permits'::regclass;
  IF definition IS NULL THEN
    RAISE EXCEPTION '0036: permits_applicant_identity_complete is missing';
  END IF;
  IF position('applicant_company_id IS NOT NULL' IN definition) = 0 THEN
    RAISE EXCEPTION '0036: the applicant identity constraint does not require applicant_company_id';
  END IF;

  -- 0035's foreign key and freeze trigger are still in place: this
  -- migration adds a presence rule on top of them, it does not replace
  -- them.
  SELECT count(*) INTO actual
    FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.permits'::regclass
     AND contype = 'f'
     AND conname = 'permits_applicant_company_id_fkey';
  IF actual <> 1 THEN
    RAISE EXCEPTION '0036: the applicant company foreign key from 0035 is missing';
  END IF;

  SELECT count(*) INTO actual
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.permits'::regclass
     AND tgname = 'permits_freeze_applicant_identity_trigger'
     AND NOT tgisinternal;
  IF actual <> 1 THEN
    RAISE EXCEPTION '0036: the applicant identity freeze trigger from 0035 is missing';
  END IF;
END;
$$;

-- This migration creates no table, function, trigger, policy, sequence
-- or grant, and therefore requires NO `app_runtime` privilege change.
