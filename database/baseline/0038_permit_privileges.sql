-- Permit baseline privileges (hand-written, reviewed).
--
-- Installed by the Permit migration runner as permit_migrator, in the same
-- transaction as 0038_permit_schema.sql, before the ledger records the
-- baseline. Nothing here touches any schema other than `permit`.
--
-- WHY THIS FILE EXISTS. In the historical standalone database the runtime
-- login `app_runtime` had BYPASSRLS and every table had RLS enabled with
-- no policies. BYPASSRLS is a cluster-wide role attribute: in the shared
-- E-Set database it would bypass row security on every schema the role
-- can reach. `permit_runtime` therefore has NOBYPASSRLS and receives:
--   * exactly the table/column/sequence privileges the backend uses, and
--   * one policy per such table, `permit_runtime_access`, TO permit_runtime
--     only - equivalent to the old bypass but confined to schema permit.
-- Table privileges still decide which commands are possible; the policy
-- only makes RLS pass-through for this one role.
--
-- PROVENANCE OF THE RUNTIME PRIVILEGE SET. Migrations 0001-0038 grant only
-- the later deltas; the base app_runtime grants were applied by an
-- operator and never recorded in a migration. The set below is:
--   [M] granted by a migration (0030, 0031, 0033, 0037, 0038);
--   [D] recorded as applied in DEPLOYMENT.md (0017, 0018, 0019, 0023-0027,
--       and the 0024 table-level permits grant);
--   [C] reconstructed from backend SQL (backend/src/**, non-test) where no
--       record exists. Must be reconciled against the live standalone
--       catalog in the data-migration rehearsal before production.
-- Everything DEPLOYMENT.md says app_runtime must NOT hold is absent and is
-- asserted absent by the verification at the end of this file.

-- ---------------------------------------------------------------------
-- 1. Default deny for everyone else (PUBLIC and Supabase browser roles).
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA permit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA permit FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA permit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA permit FROM PUBLIC;

DO $deny$
DECLARE
  browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = browser_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA permit FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA permit FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA permit FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA permit FROM %I', browser_role);
    END IF;
  END LOOP;
END
$deny$;

-- Functions created by later Permit migrations are not executable by
-- PUBLIC unless a migration grants it deliberately.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA permit TO permit_runtime, permit_privileged;

-- ---------------------------------------------------------------------
-- 2. permit_runtime table privileges.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON permit.account_audit_events TO permit_runtime;               -- [D] 0017, [M] 0031
GRANT SELECT, INSERT, UPDATE ON permit.app_user_access TO permit_runtime;            -- [D] 0017
GRANT SELECT ON permit.capabilities TO permit_runtime;                               -- [D]
GRANT SELECT, INSERT ON permit.companies TO permit_runtime;                          -- [D] 0018, [M] 0037
GRANT UPDATE (deactivated_at) ON permit.companies TO permit_runtime;                 -- [M] 0037
GRANT SELECT, INSERT ON permit.issued_document_snapshot_integrity TO permit_runtime;  -- [C]
GRANT SELECT, INSERT ON permit.issued_document_snapshots TO permit_runtime;           -- [C]
GRANT SELECT, INSERT ON permit.jsas TO permit_runtime;                               -- [D] 0030 text
GRANT UPDATE (form_version, form_payload, site_or_wtg, job_description)
  ON permit.jsas TO permit_runtime;                                                  -- [M] 0030
GRANT SELECT, INSERT ON permit.notifications TO permit_runtime;                      -- [C]
GRANT UPDATE (read_at) ON permit.notifications TO permit_runtime;                    -- [C]
GRANT INSERT ON permit.organization_audit_events TO permit_runtime;                  -- [M] 0037
GRANT SELECT, INSERT ON permit.permit_document_jobs TO permit_runtime;               -- [C]
GRANT UPDATE (status, claim_token, claimed_at, attempt_count, next_attempt_at, last_error,
              storage_path, file_hash, expected_file_hash, renderer_version, generated_at, updated_at)
  ON permit.permit_document_jobs TO permit_runtime;                                  -- [C]
GRANT SELECT, INSERT ON permit.permit_lifecycle_events TO permit_runtime;            -- [C]
GRANT SELECT ON permit.permit_number_counters TO permit_runtime;                     -- [M] 0033
GRANT UPDATE (next_value, updated_at) ON permit.permit_number_counters TO permit_runtime; -- [M] 0033
GRANT SELECT, INSERT ON permit.permit_signatures TO permit_runtime;                  -- [C]
GRANT SELECT, INSERT, UPDATE ON permit.permits TO permit_runtime;                    -- [D] 0024
GRANT SELECT, INSERT ON permit.positions TO permit_runtime;                          -- [D], [M] 0037
GRANT SELECT ON permit.privileged_access_events TO permit_runtime;                   -- [D] 0017
GRANT SELECT, INSERT ON permit.privileged_identities TO permit_runtime;              -- [D] 0019
GRANT SELECT ON permit.team_position_capabilities TO permit_runtime;                 -- [D]
GRANT SELECT, INSERT ON permit.team_positions TO permit_runtime;                     -- [D], [M] 0037
GRANT UPDATE (deactivated_at) ON permit.team_positions TO permit_runtime;            -- [M] 0037
GRANT SELECT, INSERT ON permit.teams TO permit_runtime;                              -- [D], [M] 0037
GRANT UPDATE (deactivated_at) ON permit.teams TO permit_runtime;                     -- [M] 0037
GRANT SELECT, INSERT ON permit.user_capability_grants TO permit_runtime;             -- [D] 0023
GRANT SELECT, INSERT ON permit.user_team_positions TO permit_runtime;                -- [D] 0017
GRANT UPDATE (ended_at) ON permit.user_team_positions TO permit_runtime;             -- [D] 0023
GRANT SELECT, INSERT ON permit.whatsapp_outbox_messages TO permit_runtime;           -- [C]
GRANT UPDATE (status, claim_token, claimed_at, attempt_count, next_attempt_at, last_attempted_at,
              last_error, sent_at)
  ON permit.whatsapp_outbox_messages TO permit_runtime;                              -- [C]
GRANT SELECT, INSERT ON permit.workforce_profiles TO permit_runtime;                 -- [D] 0017
GRANT UPDATE (display_name, company_id, primary_team_position_id)
  ON permit.workforce_profiles TO permit_runtime;                                    -- [D] 0023
-- No privilege at all on permit.initial_ceo_bootstrap (operator bootstrap only).

-- Sequences behind runtime INSERT defaults and the permit-number trigger.
GRANT USAGE ON SEQUENCE permit.account_audit_events_ordinal_seq TO permit_runtime;      -- [D] 0017
GRANT USAGE ON SEQUENCE permit.jsa_number_seq TO permit_runtime;                        -- [C]
GRANT USAGE ON SEQUENCE permit.organization_audit_events_ordinal_seq TO permit_runtime; -- [M] 0037
GRANT USAGE ON SEQUENCE permit.permit_lifecycle_events_ordinal_seq TO permit_runtime;   -- [C]
GRANT USAGE ON SEQUENCE permit.permit_number_seq TO permit_runtime;                     -- [C] legacy untyped path
GRANT USAGE ON SEQUENCE permit.user_capability_grants_ordinal_seq TO permit_runtime;    -- [D] 0023
-- No privilege on permit.privileged_access_events_ordinal_seq.

-- Functions the runtime calls directly or through an invoker trigger.
GRANT EXECUTE ON FUNCTION permit.allocate_permit_sequence(text) TO permit_runtime;
GRANT EXECUTE ON FUNCTION permit.grant_baseline_applicant_capabilities(uuid) TO permit_runtime;      -- [M] 0037
GRANT EXECUTE ON FUNCTION permit.organization_required_coverage_gap(uuid, uuid, uuid) TO permit_runtime; -- [M] 0038

-- ---------------------------------------------------------------------
-- 3. permit_privileged: the complete privilege set (DEPLOYMENT.md 0019).
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION permit.record_site_manager_grant(uuid, uuid, text) TO permit_privileged;

-- ---------------------------------------------------------------------
-- 4. Row security: one pass-through policy per runtime-visible table.
-- ---------------------------------------------------------------------
DO $policies$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'permit'::regnamespace
       AND c.relkind = 'r'
       AND (has_table_privilege('permit_runtime', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            OR has_any_column_privilege('permit_runtime', c.oid, 'SELECT, INSERT, UPDATE'))
     ORDER BY 1
  LOOP
    EXECUTE format(
      'CREATE POLICY permit_runtime_access ON %s AS PERMISSIVE FOR ALL TO permit_runtime USING (true) WITH CHECK (true)',
      target);
  END LOOP;
END
$policies$;

-- ---------------------------------------------------------------------
-- 5. Self-verification. Any failure aborts the whole installation.
-- ---------------------------------------------------------------------
DO $verify$
DECLARE
  problem text;
BEGIN
  -- Role attributes.
  SELECT string_agg(rolname, ', ') INTO problem
    FROM pg_catalog.pg_roles
   WHERE rolname IN ('permit_runtime', 'permit_privileged', 'permit_migrator')
     AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'Permit role has a forbidden attribute: %', problem;
  END IF;

  -- Every Permit table keeps RLS on.
  SELECT string_agg(relname, ', ') INTO problem
    FROM pg_catalog.pg_class
   WHERE relnamespace = 'permit'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is disabled on: %', problem;
  END IF;

  -- Policies exist only for permit_runtime.
  SELECT string_agg(tablename || '/' || policyname, ', ') INTO problem
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'permit' AND roles <> ARRAY['permit_runtime']::name[];
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'Policy applies to a role other than permit_runtime: %', problem;
  END IF;

  -- No PUBLIC or browser-role privilege anywhere in the schema.
  SELECT string_agg(DISTINCT kind || ':' || name, ', ') INTO problem FROM (
    SELECT 'table' AS kind, c.relname AS name, a.grantee
      FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'permit'::regnamespace
    UNION ALL
    SELECT 'function', p.proname, a.grantee
      FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.pronamespace = 'permit'::regnamespace
    UNION ALL
    SELECT 'schema', n.nspname, a.grantee
      FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
     WHERE n.nspname = 'permit'
  ) acl
  WHERE acl.grantee = 0
     OR acl.grantee IN (SELECT oid FROM pg_catalog.pg_roles
                         WHERE rolname IN ('anon', 'authenticated', 'service_role'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC or a browser role holds a Permit privilege: %', problem;
  END IF;

  -- Column-level DELETE/TRUNCATE/REFERENCES/TRIGGER never reach runtime roles.
  SELECT string_agg(c.relname || ':' || a.privilege_type, ', ') INTO problem
    FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.relnamespace = 'permit'::regnamespace
     AND a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('permit_runtime', 'permit_privileged'))
     AND a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime role holds a forbidden table privilege: %', problem;
  END IF;

  -- DEPLOYMENT.md "must NOT receive" rules for the ordinary runtime.
  IF has_table_privilege('permit_runtime', 'permit.initial_ceo_bootstrap', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('permit_runtime', 'permit.privileged_access_events', 'INSERT, UPDATE, DELETE')
     OR has_sequence_privilege('permit_runtime', 'permit.privileged_access_events_ordinal_seq', 'USAGE, SELECT, UPDATE')
     OR has_function_privilege('permit_runtime', 'permit.record_site_manager_grant(uuid, uuid, text)', 'EXECUTE')
     OR has_table_privilege('permit_runtime', 'permit.privileged_identities', 'UPDATE, DELETE')
     OR has_table_privilege('permit_runtime', 'permit.team_position_capabilities', 'INSERT, UPDATE, DELETE')
     OR has_any_column_privilege('permit_runtime', 'permit.team_position_capabilities', 'INSERT, UPDATE')
     OR has_any_column_privilege('permit_runtime', 'permit.positions', 'UPDATE')
     OR has_column_privilege('permit_runtime', 'permit.companies', 'code', 'UPDATE')
     OR has_column_privilege('permit_runtime', 'permit.companies', 'name', 'UPDATE')
     OR has_column_privilege('permit_runtime', 'permit.teams', 'name', 'UPDATE')
     OR has_table_privilege('permit_runtime', 'permit.jsas', 'UPDATE')
     OR has_table_privilege('permit_runtime', 'permit.workforce_profiles', 'UPDATE')
     OR has_table_privilege('permit_runtime', 'permit.user_team_positions', 'UPDATE')
     OR has_schema_privilege('permit_runtime', 'permit', 'CREATE') THEN
    RAISE EXCEPTION 'permit_runtime holds a privilege DEPLOYMENT.md forbids';
  END IF;

  -- permit_privileged: EXECUTE on exactly one function, nothing else.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'permit'::regnamespace
                AND (has_table_privilege('permit_privileged', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                     OR (c.relkind = 'r' AND has_any_column_privilege('permit_privileged', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
                     OR (c.relkind = 'S' AND has_sequence_privilege('permit_privileged', c.oid, 'USAGE, SELECT, UPDATE'))))
     OR (SELECT count(*) FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'permit'::regnamespace
            AND has_function_privilege('permit_privileged', p.oid, 'EXECUTE')) <> 1
     OR NOT has_function_privilege('permit_privileged', 'permit.record_site_manager_grant(uuid, uuid, text)', 'EXECUTE')
     OR has_schema_privilege('permit_privileged', 'permit', 'CREATE') THEN
    RAISE EXCEPTION 'permit_privileged privilege set is not exactly EXECUTE on record_site_manager_grant';
  END IF;

  -- Every function pins its search_path; SECURITY DEFINER pins pg_temp last.
  SELECT string_agg(proname, ', ') INTO problem
    FROM pg_catalog.pg_proc
   WHERE pronamespace = 'permit'::regnamespace
     AND (proconfig IS NULL
          OR (prosecdef AND NOT proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
          OR array_to_string(proconfig, ',') ~* 'public');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'Function search_path is not pinned safely: %', problem;
  END IF;
END
$verify$;
