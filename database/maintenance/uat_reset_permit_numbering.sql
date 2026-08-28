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
-- NOT TOUCHED, and asserted afterwards: accounts (`auth.users`,
-- `app_users`, `app_user_access`), workforce profiles, companies, teams,
-- positions, team_positions, capabilities, capability grants, user team
-- positions, account audit, privileged access events, the CEO bootstrap
-- row, and `schema_migrations`. No schema object is created, altered or
-- dropped; no capability, policy or grant is changed.
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
CREATE TEMP TABLE uat_reset_protected_before ON COMMIT DROP AS
SELECT 'app_users' AS table_name, count(*) AS rows FROM app_users
UNION ALL SELECT 'app_user_access', count(*) FROM app_user_access
UNION ALL SELECT 'workforce_profiles', count(*) FROM workforce_profiles
UNION ALL SELECT 'companies', count(*) FROM companies
UNION ALL SELECT 'teams', count(*) FROM teams
UNION ALL SELECT 'positions', count(*) FROM positions
UNION ALL SELECT 'team_positions', count(*) FROM team_positions
UNION ALL SELECT 'capabilities', count(*) FROM capabilities
UNION ALL SELECT 'team_position_capabilities', count(*) FROM team_position_capabilities
UNION ALL SELECT 'user_team_positions', count(*) FROM user_team_positions
UNION ALL SELECT 'account_audit_events', count(*) FROM account_audit_events
UNION ALL SELECT 'privileged_access_events', count(*) FROM privileged_access_events
UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations;

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
-- The per-type counters only exist once migration 0033 has been applied.
-- This script is safe in either order:
--   * cleanup BEFORE 0033 - the table is absent, nothing to reset, and
--     0033 then seeds all four counters at 1 from an empty register;
--   * cleanup AFTER 0033  - the counters exist and are set back to 1 here.
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

-- The pre-form (untyped) permit series, and the global JSA series.
-- ALTER SEQUENCE ... RESTART is transactional, so a rollback undoes it.
ALTER SEQUENCE permit_number_seq RESTART WITH 1;
ALTER SEQUENCE jsa_number_seq RESTART WITH 1;

-- ---------------------------------------------------------------------
-- 7. Verification - fails the whole transaction if anything is off
-- ---------------------------------------------------------------------
DO $$
DECLARE
  leftover BIGINT;
  still_disabled TEXT;
  changed TEXT;
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

  -- (e) Nothing outside the permit register moved.
  SELECT string_agg(format('%s (%s -> %s)', b.table_name, b.rows, a.rows), ', ' ORDER BY b.table_name)
    INTO changed
    FROM uat_reset_protected_before b
    JOIN (
      SELECT 'app_users' AS table_name, count(*) AS rows FROM app_users
      UNION ALL SELECT 'app_user_access', count(*) FROM app_user_access
      UNION ALL SELECT 'workforce_profiles', count(*) FROM workforce_profiles
      UNION ALL SELECT 'companies', count(*) FROM companies
      UNION ALL SELECT 'teams', count(*) FROM teams
      UNION ALL SELECT 'positions', count(*) FROM positions
      UNION ALL SELECT 'team_positions', count(*) FROM team_positions
      UNION ALL SELECT 'capabilities', count(*) FROM capabilities
      UNION ALL SELECT 'team_position_capabilities', count(*) FROM team_position_capabilities
      UNION ALL SELECT 'user_team_positions', count(*) FROM user_team_positions
      UNION ALL SELECT 'account_audit_events', count(*) FROM account_audit_events
      UNION ALL SELECT 'privileged_access_events', count(*) FROM privileged_access_events
      UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations
    ) a ON a.table_name = b.table_name
   WHERE a.rows <> b.rows;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'UAT reset refused to commit: protected table(s) changed: %', changed;
  END IF;

  RAISE NOTICE 'UAT reset verified: register empty, seven append-only guards enabled, protected tables unchanged.';
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
