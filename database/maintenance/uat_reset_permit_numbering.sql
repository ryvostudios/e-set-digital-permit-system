-- =====================================================================
-- PRE-PRODUCTION / UAT ONLY — destructive permit + JSA workflow reset
-- =====================================================================
--
-- THIS FILE IS NOT A MIGRATION AND MUST NEVER BE RUN AS ONE.
--
-- It lives outside `database/migrations/` on purpose: migrations are
-- applied automatically, in order, to every environment, and this
-- DELETES DATA. It runs only by hand, only against a pre-production or
-- UAT database, and only when that has been explicitly approved.
--
-- WHAT IT IS FOR. Migration 0033 makes each permit type its own series
-- but deliberately does not renumber anything, so on a database with
-- existing records each type continues from the highest number it
-- already holds. Starting every type at 1 is only meaningful once the
-- test data is gone - which is a decision about DATA, not about schema,
-- and therefore belongs here.
--
-- AFTER RUNNING IT:
--     COLD_WORK             next permit is 1
--     HOT_WORK              next permit is 1
--     WTG_WORK              next permit is 1
--     CONFINED_SPACE_ENTRY  next permit is 1
--     JSA                   next JSA is 1, still one global series
--
-- WHAT IT DELETES: every permit, every JSA, and the workflow data that
-- hangs off them - lifecycle events, signatures, notifications, WhatsApp
-- outbox rows, issued document snapshots, their integrity rows, and
-- document jobs.
--
-- WHAT IT DOES NOT TOUCH: accounts, workforce profiles, companies, teams,
-- positions, capabilities, permissions, audit of ACCOUNT actions, or any
-- schema object. It creates and drops nothing.
--
-- STORAGE IS NOT COVERED. Deleting `permit_document_jobs` removes the
-- database's record of generated PDFs; the PDF OBJECTS in the private
-- document bucket are not reachable from SQL and must be cleared
-- separately by an operator, or they will be orphaned. Do that in the
-- same maintenance window.
--
-- ---------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------
--   1. Confirm the target. `SELECT current_database(), inet_server_addr();`
--      If there is ANY doubt that this is UAT, stop.
--   2. Take a backup you have actually restored from before.
--   3. Set the guard below to the literal 'YES' and run the whole file
--      as one transaction. Without that edit it aborts having changed
--      nothing.
--   4. Re-run the verification block at the foot and read its output.
--
-- The guard is a required manual edit rather than a parameter so that
-- copy-pasting this file into a console cannot, on its own, delete a
-- production permit register.
-- =====================================================================

BEGIN;

DO $$
DECLARE
  -- ------------------------------------------------------------------
  -- EDIT THIS TO 'YES' TO ARM THE RESET. Leave it as 'NO' in source
  -- control, always.
  confirmed TEXT := 'NO';
  -- ------------------------------------------------------------------
  issued_count BIGINT;
BEGIN
  IF confirmed <> 'YES' THEN
    RAISE EXCEPTION
      'UAT reset is not armed. Edit `confirmed` to ''YES'' only after confirming this is a pre-production database.';
  END IF;

  -- A loud second opinion: a database holding issued permits is very
  -- probably not the one you meant to empty. Comment this block out
  -- deliberately if UAT genuinely holds issued test permits.
  SELECT count(*) INTO issued_count FROM permits WHERE issued_at IS NOT NULL;
  IF issued_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to reset: % permit(s) have been ISSUED. Confirm this is UAT and remove this guard deliberately.', issued_count;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- Delete children before parents. Every table here is permit/JSA
-- workflow data; nothing account-related is referenced.
-- ---------------------------------------------------------------------
DELETE FROM whatsapp_outbox_messages;
DELETE FROM notifications;
DELETE FROM permit_document_jobs;
DELETE FROM issued_document_snapshot_integrity;
DELETE FROM issued_document_snapshots;
DELETE FROM permit_signatures;
DELETE FROM permit_lifecycle_events;

-- Renewal lineage is a self-reference, so the pointers are cleared
-- before the rows are removed.
UPDATE permits SET previous_permit_id = NULL WHERE previous_permit_id IS NOT NULL;
DELETE FROM permits;
DELETE FROM jsas;

-- ---------------------------------------------------------------------
-- Restart the numbering. Per type for permits; ONE GLOBAL SERIES for the
-- JSA, which is unchanged business rule.
-- ---------------------------------------------------------------------
UPDATE permit_number_counters SET next_value = 1, updated_at = now();

-- The pre-form (untyped) permit series, and the JSA series.
ALTER SEQUENCE permit_number_seq RESTART WITH 1;
ALTER SEQUENCE jsa_number_seq RESTART WITH 1;

-- ---------------------------------------------------------------------
-- Verification. Fails the whole transaction if the reset is not exactly
-- what was intended.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  leftover BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM permits) + (SELECT count(*) FROM jsas) INTO leftover;
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'UAT reset incomplete: % permit/JSA row(s) remain', leftover;
  END IF;

  IF EXISTS (SELECT 1 FROM permit_number_counters WHERE next_value <> 1) THEN
    RAISE EXCEPTION 'UAT reset incomplete: a permit type counter is not back at 1';
  END IF;

  IF (SELECT count(*) FROM permit_number_counters) <> 4 THEN
    RAISE EXCEPTION 'UAT reset incomplete: expected 4 permit type counters';
  END IF;
END;
$$;

COMMIT;

-- Run afterwards to see the starting state:
--
--   SELECT permit_type, next_value FROM permit_number_counters ORDER BY permit_type;
--   SELECT last_value, is_called FROM jsa_number_seq;
