-- Let the application READ the administrative audit it already writes.
--
-- Migrations 0001-0030 are immutable applied history and are not edited
-- by this file.
--
-- WHY. `app_runtime` was granted INSERT on `account_audit_events` when
-- the audit was introduced (DEPLOYMENT.md), because writing it was the
-- only thing the application did at the time. The two endpoints that
-- READ it - one employee's administrative history, and the
-- organization-wide Audit Logs screen - therefore fail with SQLSTATE
-- 42501, "permission denied for table account_audit_events". The read
-- authority was simply never provisioned; nothing was revoked, and no
-- route was switched to a different login.
--
-- SELECT AND NOTHING ELSE. No UPDATE, no DELETE, no TRUNCATE, no
-- REFERENCES, no TRIGGER. The table stays append-only for every role
-- including the table owner - `account_audit_events_append_only` and
-- `account_audit_events_no_truncate` (migration 0017) are untouched, and
-- reading a row cannot alter one. There is deliberately no audit
-- mutation endpoint anywhere in the application to pair with this.
--
-- WHY app_runtime AND NOT privileged_runtime. `privileged_runtime` holds
-- zero direct table privileges by design; it exists to EXECUTE the one
-- SECURITY DEFINER grant function and nothing else, and widening it into
-- a table-reading login would be a new posture, not a fix. `app_runtime`
-- is the login every ordinary request already runs as, and it already
-- holds SELECT on the comparably sensitive `privileged_access_events`.
-- Reading this table through the login that already writes it keeps one
-- runtime identity rather than inventing a second read path.
--
-- WHO MAY ACTUALLY SEE IT IS UNCHANGED, AND IS NOT THIS GRANT'S JOB. A
-- database privilege says which login may issue the query; it says
-- nothing about which PERSON may ask for it. Both audit routes are gated
-- on an active CEO or an active E-SET system SITE_MANAGER, resolved from
-- the append-only privileged grant log on every request. An ordinary
-- employee, a CRO, an HSE approver, a ZPL organizational "Site Manager"
-- and a `permit.view_all` holder are all refused 403 before any query
-- runs - see routes/accounts.ts and its tests. This migration does not
-- move that boundary; it only stops the authorized case failing.

-- =====================================================================
-- 1. Preconditions
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'account_audit_events'
  ) THEN
    RAISE EXCEPTION '0031 precondition failed: public.account_audit_events is missing';
  END IF;

  -- The append-only guarantee this grant must not disturb.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.account_audit_events'::regclass
       AND tgname = 'account_audit_events_append_only' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0031 precondition failed: the append-only trigger is missing';
  END IF;
END;
$$;

-- =====================================================================
-- 2. The one missing privilege
-- =====================================================================
-- Guarded by a role-existence check for the same reason as 0019/0021/0030:
-- `app_runtime` is an operator-created login that does not exist in every
-- environment, and must never be CREATED by a migration in source control.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.account_audit_events TO app_runtime';
  END IF;
END;
$$;

-- =====================================================================
-- 3. Self-verification
-- =====================================================================
DO $$
DECLARE
  granted TEXT;
  exposed TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    -- SELECT must now be present. INSERT is deliberately NOT asserted:
    -- it is pre-existing operator-provisioned state that this migration
    -- neither grants nor depends on, and asserting it would make 0031
    -- fail in an environment provisioned differently.
    SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO granted
      FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = 'account_audit_events' AND grantee = 'app_runtime';
    IF NOT has_table_privilege('app_runtime', 'public.account_audit_events', 'SELECT') THEN
      RAISE EXCEPTION '0031 failed: app_runtime still cannot read the audit; it holds [%]', coalesce(granted, 'none');
    END IF;

    -- Nothing destructive came with it. The audit stays append-only.
    IF has_table_privilege('app_runtime', 'public.account_audit_events', 'UPDATE')
       OR has_table_privilege('app_runtime', 'public.account_audit_events', 'DELETE')
       OR has_table_privilege('app_runtime', 'public.account_audit_events', 'TRUNCATE') THEN
      RAISE EXCEPTION '0031 failed: app_runtime gained mutation authority over the audit';
    END IF;
  END IF;

  -- `privileged_runtime` must still hold no direct table privileges at all.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'privileged_runtime') THEN
    IF EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE grantee = 'privileged_runtime') THEN
      RAISE EXCEPTION '0031 failed: privileged_runtime gained a direct table privilege';
    END IF;
  END IF;

  -- The browser-facing roles hold nothing on the audit, table or column.
  SELECT string_agg(DISTINCT grantee, ', ') INTO exposed
    FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'account_audit_events'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION '0031 failed: the audit is exposed to [%]', exposed;
  END IF;

  SELECT string_agg(DISTINCT grantee, ', ') INTO exposed
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'account_audit_events'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION '0031 failed: audit columns are exposed to [%]', exposed;
  END IF;

  -- The append-only triggers are still installed and still not internal.
  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.account_audit_events'::regclass AND NOT tgisinternal
       AND tgname IN ('account_audit_events_append_only', 'account_audit_events_no_truncate')
  ) <> 2 THEN
    RAISE EXCEPTION '0031 failed: the append-only guarantee is no longer intact';
  END IF;
END;
$$;
