-- =====================================================================
-- 0034  A permit number is issued on SUBMISSION, not on creation
-- =====================================================================
--
-- WHAT WAS WRONG.
--
-- Migration 0033 gave each permit type its own series and allocated from
-- it in a BEFORE INSERT trigger - so a number was consumed the moment
-- someone pressed "Apply for permit", before a single field was filled
-- in. A draft abandoned half-finished kept its number for ever, and the
-- operational register then started at HW-2 with HW-1 existing only as
-- an unfinished draft nobody ever submitted.
--
-- A permit number is a record in the company's permit register. A draft
-- is not a permit yet.
--
-- THE RULE THIS IMPLEMENTS.
--
--   * A DRAFT has NO number. `permit_sequence` is NULL, and stays NULL
--     however many times the draft is saved.
--   * The number is issued at the FIRST SUCCESSFUL SUBMISSION, in the
--     same transaction and the same statement as DRAFT -> PENDING_CRO.
--   * Once issued it is permanent: send-back, correction, resubmission,
--     approval, issue, hold, resume, closure and cancellation all keep
--     it, and this migration makes changing it impossible rather than
--     merely discouraged.
--   * A number is never recycled. The counter only ever moves forward.
--
-- WHAT DOES NOT CHANGE. The counter table, the allocator function, the
-- per-type series, the locking, the uniqueness model and the JSA's own
-- global sequence are all exactly as 0033 left them. This migration
-- changes WHEN allocation happens, not how it is made safe.
--
-- 0033 IS EVOLVED, NOT FOUGHT. Its `permit_number_counters`,
-- `allocate_permit_sequence()` and unique indexes are reused untouched;
-- only its trigger - the part that decided WHEN - is replaced.
--
-- THE ALLOCATION REMAINS THE DATABASE'S. Nothing computes "last + 1"
-- anywhere: the trigger below calls the same `allocate_permit_sequence`,
-- which advances one counter row under a row lock. Two people submitting
-- the same permit type at the same instant serialise on that row and
-- receive consecutive numbers; a transaction that rolls back returns its
-- number to the series and consumes nothing.
--
-- A CLIENT STILL CANNOT CHOOSE A NUMBER. A supplied `permit_sequence` is
-- discarded on INSERT and refused on UPDATE.

-- =====================================================================
-- 1. A draft may have no number
-- =====================================================================
ALTER TABLE permits ALTER COLUMN permit_sequence DROP NOT NULL;

-- =====================================================================
-- 2. Allocation moves to the DRAFT -> submitted transition
-- =====================================================================
--
-- One function, both timings, so there is a single place that decides
-- whether a row is entitled to a number:
--
--   INSERT of a DRAFT           -> no number (forced NULL)
--   INSERT of a non-DRAFT       -> a number now (a renewal is created
--                                  directly as ISSUED and never passes
--                                  through DRAFT)
--   INSERT with no permit type  -> the original global series, as before
--   UPDATE leaving DRAFT        -> a number now, if it has none
--   UPDATE of a numbered permit -> the number is frozen
CREATE OR REPLACE FUNCTION public.permits_assign_permit_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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
    NEW.permit_sequence := public.allocate_permit_sequence(NEW.permit_type);
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
    NEW.permit_sequence := public.allocate_permit_sequence(NEW.permit_type);
    RETURN NEW;
  END IF;

  -- Nothing may sit past DRAFT unnumbered by some other path.
  IF NEW.permit_sequence IS NULL THEN
    RAISE EXCEPTION 'permit % cannot leave DRAFT without a permit number', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS permits_assign_permit_sequence_trigger ON permits;
CREATE TRIGGER permits_assign_permit_sequence_trigger
  BEFORE INSERT OR UPDATE ON permits
  FOR EACH ROW EXECUTE FUNCTION public.permits_assign_permit_sequence();

-- =====================================================================
-- 3. The invariant, as a constraint rather than a convention
-- =====================================================================
--
-- A draft is unnumbered. Anything past DRAFT must carry a number - an
-- issued permit with no entry in the register is not a state this system
-- should be able to reach, whatever the application does. This holds for
-- pre-form permits too: every one of them was numbered on insert under
-- the original schema, so none is exempt.
-- Existing data must already satisfy the new invariant. `ADD CONSTRAINT`
-- would refuse it anyway, but with a message that names the constraint
-- rather than the problem, so this checks first and says what is wrong.
-- A permit past DRAFT with no number means the register has a hole, and
-- that is not something to discover from a constraint error.
DO $$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending
    FROM permits
   WHERE status <> 'DRAFT' AND permit_sequence IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION '0034 aborted: % submitted permit(s) carry no permit number', offending;
  END IF;

  /*
    DRAFTS NUMBERED BY THE OLD RULE ARE RELEASED.

    Under 0033 a number was taken at creation, so drafts on this database
    already hold one. Those numbers were never part of the operational
    register - nothing was ever submitted under them - so they are
    returned rather than frozen into a rule that says a draft has no
    number. Only DRAFT rows are touched; nothing submitted, issued or
    closed is altered, and no counter is rewound, so a released number is
    simply never reused.
  */
  SELECT count(*) INTO offending FROM permits WHERE status = 'DRAFT' AND permit_sequence IS NOT NULL;
  IF offending > 0 THEN
    UPDATE permits SET permit_sequence = NULL WHERE status = 'DRAFT' AND permit_sequence IS NOT NULL;
    RAISE NOTICE '0034: released a stale permit number from % draft(s) that had never been submitted', offending;
  END IF;
END;
$$;

ALTER TABLE permits
  ADD CONSTRAINT permits_sequence_required_after_draft CHECK (
    status = 'DRAFT' OR permit_sequence IS NOT NULL
  );

ALTER TABLE permits
  ADD CONSTRAINT permits_draft_is_unnumbered CHECK (
    status <> 'DRAFT' OR permit_sequence IS NULL
  );

COMMENT ON COLUMN permits.permit_sequence IS
  'The authoritative permit number within its permit_type series. ALWAYS NULL while the permit is a DRAFT - typed or untyped; issued by the database out of the permit type''s own series on the first successful submission, and permanent thereafter.';

-- The per-type uniqueness from 0033 is unchanged and needs no edit: SQL
-- treats NULLs as distinct, so any number of unnumbered drafts coexist
-- while two numbered permits of one type still cannot share a number.

-- =====================================================================
-- 4. Self-verification
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'permits'
       AND column_name = 'permit_sequence' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0034 failed: permit_sequence is still NOT NULL, so a draft cannot be unnumbered';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'permits_assign_permit_sequence_trigger' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0034 failed: the permit numbering trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'permits_sequence_required_after_draft'
  ) THEN
    RAISE EXCEPTION '0034 failed: the post-draft numbering invariant is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'permits_draft_is_unnumbered'
  ) THEN
    RAISE EXCEPTION '0034 failed: the unnumbered-draft invariant is missing';
  END IF;

  -- 0033's allocator and counters must still be the ones in use.
  IF to_regclass('public.permit_number_counters') IS NULL THEN
    RAISE EXCEPTION '0034 failed: the per-type counter table from 0033 is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'allocate_permit_sequence'
  ) THEN
    RAISE EXCEPTION '0034 failed: the allocator function from 0033 is missing';
  END IF;

  -- The JSA series is untouched: still global, still uniquely constrained.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'jsas_jsa_sequence_unique'
  ) THEN
    RAISE EXCEPTION '0034 failed: the global JSA uniqueness rule was disturbed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'jsas'
       AND column_name = 'jsa_sequence' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION '0034 failed: the JSA sequence must remain mandatory';
  END IF;
END;
$$;
