-- =====================================================================
-- PRE-PRODUCTION / UAT ONLY — destructive permit + JSA workflow reset
-- =====================================================================
--
-- THIS FILE IS NOT A MIGRATION AND MUST NEVER BE RUN AS ONE.
--
-- It lives outside `database/migrations/` on purpose: migrations are
-- applied automatically, in order, to every environment, and this
-- PERMANENTLY DELETES DATA. It runs only by hand, only against a
-- pre-production or UAT database, and only when that has been explicitly
-- approved.
--
-- WHAT IT IS FOR. Migration 0033 makes each permit type its own number
-- series, seeded from the highest number that type already holds. On a
-- database still carrying demo permits the four series therefore continue
-- from the old interleaved global numbers rather than starting at 1.
-- Emptying the register is a decision about DATA, not about schema, so it
-- belongs here rather than in a migration.
--
-- AFTER RUNNING IT, with migration 0033 applied either before or after:
--     COLD_WORK             next permit is 1
--     HOT_WORK              next permit is 1
--     WTG_WORK              next permit is 1
--     CONFINED_SPACE_ENTRY  next permit is 1
--     JSA                   next JSA is 1, still ONE GLOBAL series
--
-- ---------------------------------------------------------------------
-- THE APPEND-ONLY PROTECTIONS, AND WHY THIS TOUCHES THEM
-- ---------------------------------------------------------------------
--
-- Seven permit-workflow tables are append-only: a row-level BEFORE DELETE
-- (or BEFORE UPDATE OR DELETE) trigger running `forbid_mutation()`, which
-- raises unconditionally. That is deliberate and correct - an issued
-- permit's history must not be rewritable by the application, ever. It
-- also means a clean register is unreachable without suspending exactly
-- those seven triggers for exactly this transaction.
--
-- HOW THAT IS DONE SAFELY, and the rules it follows:
--
--   * EXACTLY SEVEN TRIGGERS ARE NAMED, one per table. Nothing is
--     disabled by category - no `DISABLE TRIGGER ALL`, no
--     `DISABLE TRIGGER USER`, no `session_replication_role`.
--   * NO CONSTRAINT OR INTERNAL TRIGGER IS TOUCHED. Foreign keys stay
--     enforced throughout, so the deletion order below is checked by the
--     database rather than trusted. `permits_require_completed_jsa` (a
--     DEFERRABLE constraint trigger) also stays active; the one UPDATE
--     this script performs satisfies it, because every non-DRAFT permit
--     already has a completed JSA.
--   * THE `_no_truncate` TRIGGERS STAY ENABLED. Nothing here truncates.
--   * THE `_restrict_update` TRIGGERS STAY ENABLED. Nothing here updates
--     those tables.
--   * IT ALL HAPPENS IN ONE TRANSACTION. `ALTER TABLE ... DISABLE
--     TRIGGER` is transactional DDL, so any failure - including a failure
--     during the deletes - rolls the protections back on with the data.
--     The tables cannot be left unprotected by a crash.
--   * THE TRIGGERS ARE RE-ENABLED AND VERIFIED BEFORE COMMIT. The final
--     block refuses to commit unless all seven are enabled again.
--
-- ---------------------------------------------------------------------
-- WHAT IS AND IS NOT TOUCHED
-- ---------------------------------------------------------------------
--
-- DELETED: permits, JSAs, lifecycle events, signatures, notifications,
-- WhatsApp outbox rows, issued document snapshots, their integrity rows,
-- and document jobs. Every one is permit-workflow data.
--
-- NOT TOUCHED, and asserted afterwards: every table in the PROTECTED SET
-- declared in section 2 - account access, workforce profiles, companies,
-- teams, positions, team positions, capabilities and their grants,
-- privileged identities, the CEO bootstrap row, account audit, privileged
-- access events, and `schema_migrations`. That set is declared ONCE and
-- used for both the before and after counts, so the two can never drift
-- apart. No schema object is created, altered or dropped; no capability,
-- policy or grant is changed.
--
-- Supabase's own `auth.users` is in another schema and is never
-- referenced here at all.
--
-- STORAGE IS NOT COVERED, AND THIS SCRIPT DOES NOT PRETEND OTHERWISE.
-- The generated PDFs live in the private `issued-permit-documents`
-- bucket, which SQL cannot reach. Their paths are PRINTED as notices
-- before `permit_document_jobs` is emptied - copy them out of the psql
-- output and delete the objects separately, or they are orphaned with no
-- way left to find them.
--
-- ---------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------
--   1. Confirm the target:
--        SELECT current_database(), current_user, inet_server_addr();
--      If there is ANY doubt this is UAT, stop.
--   2. Take a backup you have actually restored from before.
--   3. Connect as the MIGRATION OWNER. `app_runtime` cannot disable a
--      trigger and must never be able to.
--   4. Edit the guard below to 'YES' and run this whole file. Without
--      that edit it aborts having changed nothing.
--   5. Save the STORAGE PATH notices it prints.
--   6. Run the verification queries at the foot.
--
-- The guard is a required manual edit rather than a parameter so that
-- pasting this file into a console cannot, on its own, empty a permit
-- register.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Arming guard
-- ---------------------------------------------------------------------
DO $$
DECLARE
  -- ------------------------------------------------------------------
  -- EDIT THIS TO 'YES' TO ARM THE RESET. It is committed as 'NO', always.
  confirmed TEXT := 'NO';
  -- ------------------------------------------------------------------
BEGIN
  IF confirmed <> 'YES' THEN
    RAISE EXCEPTION
      'UAT reset is not armed. Edit `confirmed` to ''YES'' only after confirming this is a pre-production database.';
  END IF;
END;
$$;

-- There is deliberately NO "refuse if a permit was ever ISSUED" guard.
-- Issued and closed demo permits are exactly what this clears, and a
-- guard that always has to be removed by hand is not a safety feature.
-- The arming guard above is the one that matters.

-- ---------------------------------------------------------------------
-- 2. What is about to be destroyed, and what must survive
-- ---------------------------------------------------------------------
-- The surviving counts are captured now and asserted unchanged at the
-- end, so "accounts and workforce are untouched" is proven rather than
-- promised.
--
-- THE SET IS DECLARED ONCE, HERE, and read again by the verification in
-- section 7. An earlier version of this script wrote the list out twice
-- and included `app_users`, which does not exist in this schema - the run
-- aborted on it before any destructive statement, which is the behaviour
-- one wants, but the list should not have been able to drift or to name a
-- table nobody had checked. Both problems are structural, and both are
-- fixed by having exactly one list and verifying every name in it really
-- exists before anything is deleted.
CREATE TEMP TABLE uat_reset_protected_tables (table_name TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO uat_reset_protected_tables (table_name) VALUES
  ('account_audit_events'),
  ('app_user_access'),
  ('capabilities'),
  ('companies'),
  ('initial_ceo_bootstrap'),
  ('positions'),
  ('privileged_access_events'),
  ('privileged_identities'),
  ('schema_migrations'),
  ('team_position_capabilities'),
  ('team_positions'),
  ('teams'),
  ('user_capability_grants'),
  ('user_team_positions'),
  ('workforce_profiles');

CREATE TEMP TABLE uat_reset_protected_before (table_name TEXT PRIMARY KEY, rows BIGINT NOT NULL) ON COMMIT DROP;

DO $$
DECLARE
  protected TEXT;
  observed BIGINT;
BEGIN
  FOR protected IN SELECT table_name FROM uat_reset_protected_tables ORDER BY table_name LOOP
    -- A protected table that is not there is a schema mismatch, not
    -- something to skip: stop now, before anything is deleted.
    IF to_regclass('public.' || quote_ident(protected)) IS NULL THEN
      RAISE EXCEPTION
        'UAT reset aborted: protected table public.% does not exist. The protected set in this script does not match this database - check it before running anything destructive.', protected;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', protected) INTO observed;
    INSERT INTO uat_reset_protected_before (table_name, rows) VALUES (protected, observed);
  END LOOP;
  RAISE NOTICE 'Protected set verified: % table(s) present and counted.',
    (SELECT count(*) FROM uat_reset_protected_before);
END;
$$;

-- ---------------------------------------------------------------------
-- 2b. The permit domain must look the way this script expects
-- ---------------------------------------------------------------------
-- Every table below is emptied in section 4. If the schema has moved and
-- one of them is not there, stop now: a half-cleared permit domain is
-- worse than an uncleared one, and guessing is not an option when the
-- next statement is a DELETE.
DO $$
DECLARE
  domain_table TEXT;
BEGIN
  FOREACH domain_table IN ARRAY ARRAY[
    'permits', 'jsas', 'permit_lifecycle_events', 'permit_signatures',
    'notifications', 'whatsapp_outbox_messages',
    'issued_document_snapshots', 'issued_document_snapshot_integrity',
    'permit_document_jobs'
  ] LOOP
    IF to_regclass('public.' || quote_ident(domain_table)) IS NULL THEN
      RAISE EXCEPTION
        'UAT reset aborted: permit-domain table public.% does not exist. The schema does not match this script - check it before running anything destructive.', domain_table;
    END IF;
  END LOOP;
  RAISE NOTICE 'Permit domain verified: 9 table(s) present and ready to clear.';
END;
$$;

DO $$
DECLARE
  path TEXT;
  paths BIGINT := 0;
BEGIN
  RAISE NOTICE '--- UAT reset: permit register before ---';
  FOR path IN
    SELECT format('  %s: %s permit(s), highest number %s',
                  coalesce(permit_type, '(pre-form)'), count(*), max(permit_sequence))
      FROM permits GROUP BY permit_type ORDER BY permit_type
  LOOP
    RAISE NOTICE '%', path;
  END LOOP;

  -- THE ONLY RECORD OF WHERE THE PDFs LIVE. Once permit_document_jobs is
  -- emptied there is no way to find these objects from SQL.
  RAISE NOTICE '--- Storage objects requiring SEPARATE deletion (bucket: issued-permit-documents) ---';
  FOR path IN SELECT storage_path FROM permit_document_jobs WHERE storage_path IS NOT NULL ORDER BY storage_path
  LOOP
    paths := paths + 1;
    RAISE NOTICE '  %', path;
  END LOOP;
  IF paths = 0 THEN
    RAISE NOTICE '  (none recorded)';
  ELSE
    RAISE NOTICE '  % object(s). SQL CANNOT DELETE THESE - remove them from Storage separately.', paths;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Suspend exactly the seven append-only DELETE guards
-- ---------------------------------------------------------------------
-- Named individually and re-enabled in section 5. Every other trigger on
-- every one of these tables - the TRUNCATE guards, the UPDATE restrictors,
-- the foreign keys - stays exactly as it is.
ALTER TABLE whatsapp_outbox_messages          DISABLE TRIGGER whatsapp_outbox_no_delete;
ALTER TABLE notifications                     DISABLE TRIGGER notifications_no_delete;
ALTER TABLE permit_document_jobs              DISABLE TRIGGER permit_document_jobs_no_delete;
ALTER TABLE issued_document_snapshot_integrity DISABLE TRIGGER issued_document_snapshot_integrity_append_only;
ALTER TABLE issued_document_snapshots         DISABLE TRIGGER issued_document_snapshots_append_only;
ALTER TABLE permit_signatures                 DISABLE TRIGGER permit_signatures_append_only;
ALTER TABLE permit_lifecycle_events           DISABLE TRIGGER permit_lifecycle_events_append_only;

-- ---------------------------------------------------------------------
-- 4. Delete, children before parents
-- ---------------------------------------------------------------------
-- Every foreign key here is ON DELETE RESTRICT - nothing cascades - so
-- this order is enforced by the database, not merely intended:
--
--   whatsapp_outbox_messages  -> permits, permit_lifecycle_events
--   notifications             -> permits, permit_lifecycle_events
--   permit_document_jobs      -> issued_document_snapshots
--   ..._snapshot_integrity    -> issued_document_snapshots
--   issued_document_snapshots -> permits, permit_lifecycle_events
--   permit_signatures         -> permits, permit_lifecycle_events
--   permit_lifecycle_events   -> permits
--   permits                   -> jsas, permits (self, renewal lineage)
--
-- Every notification and outbox row carries a NOT NULL
-- `source_event_id` referencing a permit lifecycle event, so all of them
-- are permit-derived: there is no account-only row in either table to
-- preserve.
DELETE FROM whatsapp_outbox_messages;
DELETE FROM notifications;
DELETE FROM permit_document_jobs;
DELETE FROM issued_document_snapshot_integrity;
DELETE FROM issued_document_snapshots;
DELETE FROM permit_signatures;
DELETE FROM permit_lifecycle_events;

-- The renewal lineage is a self-reference with ON DELETE RESTRICT, which
-- is checked per row rather than at end of statement, so the pointers are
-- cleared before the rows go. `permits_require_completed_jsa` is still
-- enabled and passes: it only inspects non-DRAFT permits, and those all
-- have a completed JSA already.
UPDATE permits SET previous_permit_id = NULL WHERE previous_permit_id IS NOT NULL;
DELETE FROM permits;
DELETE FROM jsas;

-- ---------------------------------------------------------------------
-- 5. Restore the append-only protections
-- ---------------------------------------------------------------------
-- Before COMMIT, and verified in section 7.
ALTER TABLE whatsapp_outbox_messages          ENABLE TRIGGER whatsapp_outbox_no_delete;
ALTER TABLE notifications                     ENABLE TRIGGER notifications_no_delete;
ALTER TABLE permit_document_jobs              ENABLE TRIGGER permit_document_jobs_no_delete;
ALTER TABLE issued_document_snapshot_integrity ENABLE TRIGGER issued_document_snapshot_integrity_append_only;
ALTER TABLE issued_document_snapshots         ENABLE TRIGGER issued_document_snapshots_append_only;
ALTER TABLE permit_signatures                 ENABLE TRIGGER permit_signatures_append_only;
ALTER TABLE permit_lifecycle_events           ENABLE TRIGGER permit_lifecycle_events_append_only;

-- ---------------------------------------------------------------------
-- 6. Restart the numbering
-- ---------------------------------------------------------------------
-- PER TYPE for permits; ONE GLOBAL SERIES for the JSA, which is unchanged
-- business rule.
--
-- AFTER MIGRATION 0034 a permit number is issued on the first successful
-- submission, not at creation - so once this has run, a newly created
-- draft carries NO number ("Not assigned") and the first permit of each
-- type SUBMITTED becomes WTG-1 / CW-1 / HW-1 / CS-1. Setting the counters
-- back to 1 is what makes that first submission start the register at 1.
--
-- 0033 IS APPLIED ON THE LIVE DATABASE, so the counters exist and are
-- reset here. The conditional remains for a database that predates it -
-- a fresh environment being built up from scratch - where there is
-- simply nothing to reset and 0033 then seeds all four counters at 1
-- from an empty register.
DO $$
BEGIN
  IF to_regclass('public.permit_number_counters') IS NOT NULL THEN
    UPDATE permit_number_counters SET next_value = 1, updated_at = now();
    RAISE NOTICE 'permit_number_counters reset: all four types start at 1.';
  ELSE
    RAISE NOTICE 'permit_number_counters does not exist yet - migration 0033 will seed all four types at 1.';
  END IF;
END;
$$;

-- The two permit-domain sequences, and only those: the legacy pre-form
-- permit series (which after 0034 can only ever be drawn on by a
-- pre-form row created past DRAFT, and never by a draft), and the global
-- JSA series, so the next JSA created is JSA 1. No other sequence in the
-- database is touched. `ALTER SEQUENCE ... RESTART` is transactional, so
-- a rollback undoes it.
ALTER SEQUENCE permit_number_seq RESTART WITH 1;
ALTER SEQUENCE jsa_number_seq RESTART WITH 1;

-- ---------------------------------------------------------------------
-- 7. Verification - fails the whole transaction if anything is off
-- ---------------------------------------------------------------------
DO $$
DECLARE
  leftover BIGINT;
  still_disabled TEXT;
  protected TEXT;
  observed BIGINT;
  expected BIGINT;
  jsa_next BIGINT;
BEGIN
  -- (a) The register is empty and nothing was orphaned behind it.
  SELECT (SELECT count(*) FROM permits)
       + (SELECT count(*) FROM jsas)
       + (SELECT count(*) FROM permit_lifecycle_events)
       + (SELECT count(*) FROM permit_signatures)
       + (SELECT count(*) FROM notifications)
       + (SELECT count(*) FROM whatsapp_outbox_messages)
       + (SELECT count(*) FROM issued_document_snapshots)
       + (SELECT count(*) FROM issued_document_snapshot_integrity)
       + (SELECT count(*) FROM permit_document_jobs)
    INTO leftover;
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'UAT reset incomplete: % permit/JSA workflow row(s) remain', leftover;
  END IF;

  -- (b) EVERY append-only guard is back on. 'O' = enabled (origin).
  SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ' ORDER BY t.tgname) INTO still_disabled
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND t.tgenabled <> 'O'
     AND t.tgname IN (
       'whatsapp_outbox_no_delete', 'notifications_no_delete', 'permit_document_jobs_no_delete',
       'issued_document_snapshot_integrity_append_only', 'issued_document_snapshots_append_only',
       'permit_signatures_append_only', 'permit_lifecycle_events_append_only'
     );
  IF still_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'UAT reset refused to commit: append-only trigger(s) still disabled: %', still_disabled;
  END IF;

  -- (c) All seven are actually present - a renamed or dropped guard must
  -- not pass as "not disabled".
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname IN (
         'whatsapp_outbox_no_delete', 'notifications_no_delete', 'permit_document_jobs_no_delete',
         'issued_document_snapshot_integrity_append_only', 'issued_document_snapshots_append_only',
         'permit_signatures_append_only', 'permit_lifecycle_events_append_only')) <> 7 THEN
    RAISE EXCEPTION 'UAT reset refused to commit: expected all seven append-only guards to exist';
  END IF;

  -- (d) The per-type counters, if they exist yet.
  IF to_regclass('public.permit_number_counters') IS NOT NULL THEN
    IF (SELECT count(*) FROM permit_number_counters) <> 4 THEN
      RAISE EXCEPTION 'UAT reset incomplete: expected 4 permit type counters';
    END IF;
    IF EXISTS (SELECT 1 FROM permit_number_counters WHERE next_value <> 1) THEN
      RAISE EXCEPTION 'UAT reset incomplete: a permit type counter is not back at 1';
    END IF;
  END IF;

  -- (d2) The JSA series starts again at 1, so the first JSA created after
  -- this is JSA 1. `is_called = false` means the next `nextval` returns
  -- `last_value` itself rather than the one after it.
  SELECT last_value INTO jsa_next FROM jsa_number_seq;
  IF jsa_next <> 1 OR (SELECT is_called FROM jsa_number_seq) THEN
    RAISE EXCEPTION 'UAT reset incomplete: the JSA sequence would not start again at 1';
  END IF;

  -- (e) Nothing outside the permit register moved. Re-counted from the
  -- SAME declared set as section 2, so the before and after lists cannot
  -- disagree about which tables are protected.
  FOR protected IN SELECT table_name FROM uat_reset_protected_tables ORDER BY table_name LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', protected) INTO observed;
    SELECT rows INTO expected FROM uat_reset_protected_before WHERE table_name = protected;
    IF expected IS NULL THEN
      RAISE EXCEPTION 'UAT reset refused to commit: no before-count was taken for protected table %', protected;
    END IF;
    IF observed <> expected THEN
      RAISE EXCEPTION 'UAT reset refused to commit: protected table % changed (% -> %)', protected, expected, observed;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM uat_reset_protected_before) <> (SELECT count(*) FROM uat_reset_protected_tables) THEN
    RAISE EXCEPTION 'UAT reset refused to commit: the protected set was not fully counted before the deletes';
  END IF;

  RAISE NOTICE 'UAT reset verified: register empty, seven append-only guards enabled, % protected table(s) unchanged.',
    (SELECT count(*) FROM uat_reset_protected_tables);
END;
$$;

COMMIT;

-- =====================================================================
-- Run afterwards to confirm the starting state
-- =====================================================================
--
--   SELECT permit_type, next_value FROM permit_number_counters ORDER BY permit_type;
--   SELECT last_value, is_called FROM jsa_number_seq;
--   SELECT last_value, is_called FROM permit_number_seq;
--   SELECT count(*) FROM permits;   -- 0
--   SELECT count(*) FROM jsas;      -- 0
--
-- And the Storage objects the notices listed still need deleting from the
-- private `issued-permit-documents` bucket - SQL did not and cannot
-- remove them.
