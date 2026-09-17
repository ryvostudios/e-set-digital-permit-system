-- Runtime privileges for the Organization Management API (Phase 2).
--
-- Migrations 0001-0036 are immutable applied history and are not edited
-- by this file. 0035 and 0036 are LIVE; this is additive to them.
--
-- =====================================================================
-- WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM 0035
-- =====================================================================
--
-- 0035 created the organization objects but granted the runtime role
-- NOTHING on them, deliberately: Phase 1 shipped the schema and domain
-- foundation with no mutation route mounted, so nothing could write, and
-- granting early would have widened `app_runtime` before anything used
-- it. DEPLOYMENT.md recorded the delta as a PHASE 2 PREREQUISITE.
--
-- Phase 2 mounts the routes, so the delta is now required. It is applied
-- as its own forward migration rather than by editing 0035, which is
-- live applied history.
--
-- =====================================================================
-- WHAT IS GRANTED, AND WHY EACH ONE
-- =====================================================================
--
-- Every grant below maps to a statement that actually exists in
-- `domain/accounts/organization.ts` or `organizationAudit.ts`. Nothing
-- is granted speculatively:
--
--   INSERT companies              createCompany
--   UPDATE (deactivated_at)       deactivateOrganizationRecord('company')
--   INSERT teams                  createTeam
--   UPDATE (deactivated_at)       deactivateOrganizationRecord('team')
--   INSERT positions              createTeamPosition (mints a new global
--                                 vocabulary row when the name is new)
--   INSERT team_positions         createTeamPosition
--   UPDATE (deactivated_at)       deactivateOrganizationRecord('team_position')
--   INSERT organization_audit_events + sequence USAGE
--                                 recordOrganizationAuditEvent
--   EXECUTE grant_baseline_applicant_capabilities(UUID)
--                                 the ONE capability write path
--
-- =====================================================================
-- WHAT IS DELIBERATELY NOT GRANTED
-- =====================================================================
--
--   * UPDATE on `companies.name` / `teams.name`. There is no rename
--     endpoint in this phase, so a rename privilege would be authority
--     nothing exercises. Deferred until one exists.
--   * UPDATE on `companies.code` / `companies.id`. A rewritten code
--     would silently re-point permits, audit rows and employee profiles.
--     0035 already has a trigger refusing it; withholding the grant
--     means the application cannot even attempt it.
--   * UPDATE on `positions`. 0035 gave that table no lifecycle column by
--     design - it is a globally shared vocabulary, and retiring a
--     designation for one team is a `team_positions` operation.
--   * INSERT, UPDATE or DELETE on `team_position_capabilities`. The
--     bounded SECURITY DEFINER function is the only write path to
--     capability data, and its two capability names are literals inside
--     the function body. Granting the table directly would remove the
--     boundary the whole design depends on - a runtime-created position
--     could then be given CRO or HSE authority.
--   * DELETE or TRUNCATE on any organization table. There is no hard
--     delete in this design; deactivation is the only removal, and
--     historical employees, permits and audit rows must survive.
--   * anything at all on `privileged_access_events`,
--     `privileged_identities` or `record_site_manager_grant()`. CEO and
--     SITE_MANAGER authority remains reachable only through the separate
--     `privileged_runtime` channel, exactly as 0019/0021/0022 left it.
--
-- The UPDATE grants are COLUMN-LEVEL, following the pattern 0023-0027
-- established on `workforce_profiles` and 0030 on `jsas`. Do not replace
-- them with table-level UPDATE.
--
-- =====================================================================
-- PORTABILITY
-- =====================================================================
--
-- `app_runtime` is an operator-created login that exists in deployed
-- environments but not in every local or test database. Following 0025's
-- precedent for `service_role`, this migration WARNs and skips rather
-- than failing when the role is absent, so it remains applicable
-- everywhere. The self-verification block is skipped in the same case -
-- there is nothing to verify.
--
-- THE RISK THAT CREATES, STATED PLAINLY. If the role is absent in
-- PRODUCTION - misspelled, renamed, or not yet created - this migration
-- grants nothing, verifies nothing, and is still recorded in
-- `schema_migrations` as applied. The ledger would then claim a
-- privilege delta that does not exist, and the first organization
-- mutation would fail with 42501.
--
-- The skip is kept because the alternative - failing when the role is
-- absent - would break every local and CI database, and the repository's
-- migration tests run against exactly those. The mitigation is an
-- OPERATOR PREFLIGHT, documented in DEPLOYMENT.md and required before
-- applying this migration:
--
--   SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime';
--
-- If that returns no row, STOP: do not apply 0037 until the role name
-- is confirmed. The WARNING raised below is the second line of defence,
-- not the first.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    -- Local and CI databases have no operator-created login, so this
    -- must not fail there. In PRODUCTION this branch means the
    -- migration is recorded as applied WITHOUT granting anything -
    -- see the PORTABILITY note in the header and the preflight in
    -- DEPLOYMENT.md. WARNING rather than NOTICE so it is visible in
    -- migration output.
    RAISE WARNING '0037: role app_runtime does not exist; NO privilege was granted. In production this means the Organization Management API will fail with 42501 - verify the role name before trusting this run.';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- REVOKES FIRST, AND THAT ORDER IS LOAD-BEARING.
  --
  -- PostgreSQL cannot subtract a column from a TABLE-level grant: a
  -- `GRANT UPDATE ON companies` implies every column, and a later
  -- `REVOKE UPDATE (name)` against it does nothing at all. So any
  -- table-level UPDATE is cleared here, BEFORE the precise column-level
  -- grants below re-establish exactly the intended surface.
  --
  -- WHAT THESE REVOKES DO AND DO NOT REPAIR - stated precisely,
  -- because the distinction decides whether this migration is safe to
  -- rely on:
  --
  --   * a DIRECT grant to `app_runtime`, table-level or column-level,
  --     IS revoked here. An environment where someone ran
  --     `GRANT UPDATE ON companies TO app_runtime` by hand is brought
  --     back to the intended surface by running this migration, and
  --     running it twice is a no-op.
  --   * a privilege reaching `app_runtime` by INHERITANCE - through
  --     membership of another role that holds it - is NOT repaired.
  --     REVOKE ... FROM app_runtime cannot remove what a grantee role
  --     holds, and this migration deliberately does not touch role
  --     memberships or unrelated roles: that blast radius belongs to an
  --     operator decision, not a feature migration.
  --
  -- The inherited case is NOT ignored. The self-verification below
  -- reads EFFECTIVE privilege, so an inherited one makes this migration
  -- FAIL rather than record a surface it did not achieve. It fails
  -- closed; it does not quietly repair.
  -- ---------------------------------------------------------------
  EXECUTE 'REVOKE UPDATE ON TABLE public.companies FROM app_runtime';
  EXECUTE 'REVOKE UPDATE ON TABLE public.teams FROM app_runtime';
  EXECUTE 'REVOKE UPDATE ON TABLE public.team_positions FROM app_runtime';
  EXECUTE 'REVOKE UPDATE ON TABLE public.positions FROM app_runtime';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.team_position_capabilities FROM app_runtime';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE public.companies FROM app_runtime';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE public.teams FROM app_runtime';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE public.positions FROM app_runtime';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE public.team_positions FROM app_runtime';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.organization_audit_events FROM app_runtime';

  -- ---------------------------------------------------------------
  -- Companies: create, and retire. Never rename, never re-code.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT INSERT ON TABLE public.companies TO app_runtime';
  EXECUTE 'GRANT UPDATE (deactivated_at) ON TABLE public.companies TO app_runtime';

  -- ---------------------------------------------------------------
  -- Teams: create, and retire.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT INSERT ON TABLE public.teams TO app_runtime';
  EXECUTE 'GRANT UPDATE (deactivated_at) ON TABLE public.teams TO app_runtime';

  -- ---------------------------------------------------------------
  -- Positions: the global vocabulary. INSERT only - a position row has
  -- no lifecycle column and is never updated.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT INSERT ON TABLE public.positions TO app_runtime';

  -- ---------------------------------------------------------------
  -- Team + Position associations: create, and retire.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT INSERT ON TABLE public.team_positions TO app_runtime';
  EXECUTE 'GRANT UPDATE (deactivated_at) ON TABLE public.team_positions TO app_runtime';

  -- ---------------------------------------------------------------
  -- The append-only organization audit. INSERT and the sequence only:
  -- 0035's forbid_mutation triggers already refuse UPDATE, DELETE and
  -- TRUNCATE for every role including the owner, so the log stays
  -- tamper-evident no matter which credential is used.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT INSERT ON TABLE public.organization_audit_events TO app_runtime';
  EXECUTE 'GRANT USAGE ON SEQUENCE public.organization_audit_events_ordinal_seq TO app_runtime';

  -- ---------------------------------------------------------------
  -- The ONE capability write path. Unlike record_site_manager_grant(),
  -- this SECURITY DEFINER function IS meant for the ordinary runtime
  -- login: it attaches the standard applicant baseline, which is not
  -- privileged authority, and its capability names are literals so no
  -- argument can widen it.
  -- ---------------------------------------------------------------
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_baseline_applicant_capabilities(UUID) TO app_runtime';
END;
$$;

-- =====================================================================
-- Self-verification: the EFFECTIVE privilege surface, proved
-- =====================================================================
--
-- `has_table_privilege` is NOT sufficient on its own for UPDATE. A
-- column-level grant - `GRANT UPDATE (name) ON companies` - leaves
-- `has_table_privilege(..., 'UPDATE')` FALSE while the role can still
-- rewrite that column. So every UPDATE assertion below enumerates the
-- table's REAL columns from the catalogue and checks
-- `has_column_privilege` on each one, rather than asking a single
-- table-level question.
--
-- Enumerating from `information_schema.columns` rather than listing
-- column names also means a column added by a LATER migration is
-- covered automatically: it starts out forbidden and stays forbidden
-- until someone deliberately widens this list.
--
-- These functions report EFFECTIVE privilege, so a privilege reaching
-- `app_runtime` through role membership is caught here too. This
-- migration does NOT attempt to repair that case - see the note on
-- corrective revokes above - it FAILS, which is the safe direction.
DO $$
DECLARE
  col TEXT;
  fn_oid OID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    RETURN;
  END IF;

  -- -------------------------------------------------------------
  -- 1. REQUIRED privileges, each present
  -- -------------------------------------------------------------
  IF NOT has_table_privilege('app_runtime', 'public.companies', 'INSERT') THEN
    RAISE EXCEPTION '0037: app_runtime cannot INSERT companies';
  END IF;
  IF NOT has_column_privilege('app_runtime', 'public.companies', 'deactivated_at', 'UPDATE') THEN
    RAISE EXCEPTION '0037: app_runtime cannot retire a company';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'public.teams', 'INSERT') THEN
    RAISE EXCEPTION '0037: app_runtime cannot INSERT teams';
  END IF;
  IF NOT has_column_privilege('app_runtime', 'public.teams', 'deactivated_at', 'UPDATE') THEN
    RAISE EXCEPTION '0037: app_runtime cannot retire a team';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'public.positions', 'INSERT') THEN
    RAISE EXCEPTION '0037: app_runtime cannot INSERT positions';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'public.team_positions', 'INSERT') THEN
    RAISE EXCEPTION '0037: app_runtime cannot INSERT team_positions';
  END IF;
  IF NOT has_column_privilege('app_runtime', 'public.team_positions', 'deactivated_at', 'UPDATE') THEN
    RAISE EXCEPTION '0037: app_runtime cannot retire a team position';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'public.organization_audit_events', 'INSERT') THEN
    RAISE EXCEPTION '0037: app_runtime cannot write the organization audit';
  END IF;
  IF NOT has_sequence_privilege(
       'app_runtime', 'public.organization_audit_events_ordinal_seq', 'USAGE') THEN
    RAISE EXCEPTION '0037: app_runtime cannot use the organization audit ordinal sequence';
  END IF;
  -- Resolved by OID, not by a rendered signature string: signature
  -- text is formatted differently across PostgreSQL builds and a
  -- mis-parse here would silently skip the check.
  SELECT p.oid INTO fn_oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'grant_baseline_applicant_capabilities';
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION '0037: grant_baseline_applicant_capabilities() is missing';
  END IF;
  IF NOT has_function_privilege('app_runtime', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '0037: app_runtime cannot grant the applicant baseline';
  END IF;

  -- -------------------------------------------------------------
  -- 2. The UPDATE surface is EXACTLY `deactivated_at`, per table
  -- -------------------------------------------------------------
  --
  -- Column by column, from the catalogue. This is what proves
  -- `companies.code`, `companies.id`, `companies.name`,
  -- `teams.company_id`, `team_positions.site_manager_assignable` and
  -- every other column are not writable - including through a
  -- column-level grant that a table-level check would miss.
  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'companies'
  LOOP
    IF col <> 'deactivated_at'
       AND has_column_privilege('app_runtime', 'public.companies', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on companies.% - only deactivated_at is permitted', col;
    END IF;
  END LOOP;

  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams'
  LOOP
    IF col <> 'deactivated_at'
       AND has_column_privilege('app_runtime', 'public.teams', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on teams.% - only deactivated_at is permitted', col;
    END IF;
  END LOOP;

  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'team_positions'
  LOOP
    IF col <> 'deactivated_at'
       AND has_column_privilege('app_runtime', 'public.team_positions', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on team_positions.% - only deactivated_at is permitted', col;
    END IF;
  END LOOP;

  -- `positions` has NO lifecycle column by design: not one of its
  -- columns may be updated.
  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'positions'
  LOOP
    IF has_column_privilege('app_runtime', 'public.positions', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on positions.% - the global vocabulary is never updated', col;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------
  -- 3. Capability data: no write path but the bounded function
  -- -------------------------------------------------------------
  IF has_table_privilege('app_runtime', 'public.team_position_capabilities', 'INSERT')
     OR has_table_privilege('app_runtime', 'public.team_position_capabilities', 'DELETE')
     OR has_table_privilege('app_runtime', 'public.team_position_capabilities', 'TRUNCATE') THEN
    RAISE EXCEPTION
      '0037: app_runtime can write capability data directly; the bounded function must be the only path';
  END IF;
  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'team_position_capabilities'
  LOOP
    IF has_column_privilege('app_runtime', 'public.team_position_capabilities', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on team_position_capabilities.%', col;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------
  -- 4. No hard delete, anywhere in the organization
  -- -------------------------------------------------------------
  FOR col IN
    SELECT unnest(ARRAY['companies', 'teams', 'positions', 'team_positions',
                        'organization_audit_events', 'team_position_capabilities'])
  LOOP
    IF has_table_privilege('app_runtime', 'public.' || col, 'DELETE') THEN
      RAISE EXCEPTION '0037: app_runtime holds DELETE on %, but this design has no hard delete', col;
    END IF;
    IF has_table_privilege('app_runtime', 'public.' || col, 'TRUNCATE') THEN
      RAISE EXCEPTION '0037: app_runtime holds TRUNCATE on %', col;
    END IF;
  END LOOP;

  -- The organization audit is append-only: INSERT yes, rewrite never.
  FOR col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organization_audit_events'
  LOOP
    IF has_column_privilege('app_runtime', 'public.organization_audit_events', col, 'UPDATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime has an effective UPDATE privilege on organization_audit_events.% - the audit is append-only', col;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------
  -- 5. The privileged authority channel stays closed
  -- -------------------------------------------------------------
  --
  -- SELECT is deliberately NOT asserted against here:
  -- `resolvePrivilegedAccess()` reads `privileged_access_events` on
  -- every authorized request, and that read is exactly how CEO and
  -- SITE_MANAGER authority is resolved. What must never exist is a
  -- MUTATION path.
  FOR col IN SELECT unnest(ARRAY['privileged_access_events', 'privileged_identities'])
  LOOP
    IF has_table_privilege('app_runtime', 'public.' || col, 'INSERT')
       OR has_table_privilege('app_runtime', 'public.' || col, 'DELETE')
       OR has_table_privilege('app_runtime', 'public.' || col, 'TRUNCATE') THEN
      RAISE EXCEPTION
        '0037: app_runtime holds a mutation privilege on % - privileged authority must stay on the privileged_runtime channel', col;
    END IF;
  END LOOP;

  FOR col IN
    SELECT c.table_name || '.' || c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name IN ('privileged_access_events', 'privileged_identities')
  LOOP
    IF has_column_privilege(
         'app_runtime', 'public.' || split_part(col, '.', 1), split_part(col, '.', 2), 'UPDATE') THEN
      RAISE EXCEPTION '0037: app_runtime has an effective UPDATE privilege on %', col;
    END IF;
  END LOOP;

  -- The grant-writing function is reserved to `privileged_runtime`
  -- (0019/0021/0022). Its signature is read from the catalogue rather
  -- than assumed, so a future signature change cannot make this check
  -- silently pass against a function that no longer exists.
  SELECT p.oid INTO fn_oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_site_manager_grant';

  IF fn_oid IS NOT NULL AND has_function_privilege('app_runtime', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      '0037: app_runtime can EXECUTE record_site_manager_grant - privileged grants belong to the privileged_runtime login alone';
  END IF;
END;
$$;

-- This migration creates no table, function, trigger, policy, sequence
-- or column, and changes no data. It adjusts privileges only.
