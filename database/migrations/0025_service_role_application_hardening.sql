-- Final application-table `service_role` hardening sweep.
--
-- Migrations 0001-0024 are immutable applied history and are not edited
-- by this file. This migration issues REVOKEs only: it creates and
-- alters no object and changes no application behaviour.
--
-- WHY. Migration 0022 removed `service_role`'s write access to the
-- PRIVILEGED tier (`privileged_access_events`, `privileged_identities`,
-- `initial_ceo_bootstrap`). Everything else in `public` still carried
-- Supabase's default full DML for that role - a live inventory found 20
-- tables and 5 sequences. The consequence is narrower than the
-- privileged-tier hole but real and of the same kind: a holder of the
-- Supabase service key could insert a row into
-- `team_position_capabilities` or `user_team_positions` and hand itself
-- CRO authority - `permit.close`, `permit.cancel`, `permit.renew` - or
-- write `app_user_access` to re-enable a disabled account, or forge
-- `permit_signatures`, `permits` and `issued_document_snapshots`
-- outright. None of that goes through any application gate.
--
-- WHY IT IS SAFE TO REMOVE. Verified against every call site, not
-- assumed: the service-role credential is used by exactly one module in
-- this codebase, `lib/supabaseAdmin.ts`, which speaks HTTP to the
-- Supabase Auth API (create user, set password, delete user). It issues
-- no SQL against any application table. Application SQL runs as
-- `app_runtime`, privileged grants as `privileged_runtime`, migrations
-- and the CEO bootstrap as the operator/owner. PDF storage uses its own
-- Storage-scoped S3 credential, not this role.
--
-- SCOPE. Schema `public` only - this project's own application tables.
-- The `auth` and `storage` schemas, Supabase-managed functions, and
-- everything Supabase needs to operate are untouched, so Auth, Storage
-- and PostgREST continue to work exactly as before. `SELECT` is retained
-- everywhere so dashboards, support queries and the Studio table viewer
-- keep working read-only.
--
-- OPERATIONAL CONSEQUENCE. Writing application tables from the Supabase
-- Studio table editor (which acts as `service_role`) stops working;
-- reading them does not. Data fixes become an operator-credential task,
-- which is the intent: a change to authorization state should leave a
-- trace and require the deliberate credential, not a dashboard click.
--
-- STANDING RULE. Supabase's default privileges apply to every NEW table
-- and sequence created in `public`, so this sweep does not protect
-- objects added later. Every future migration that creates a table must
-- revoke these privileges itself; the verification block below will not
-- catch a table that does not exist yet.

DO $$
DECLARE
  target RECORD;
  revoked_tables INT := 0;
  revoked_sequences INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE '0025: service_role does not exist in this database; nothing to revoke';
    RETURN;
  END IF;

  -- Every ordinary table in `public`. Revoking write while retaining
  -- SELECT is expressed explicitly so the intent survives review, and so
  -- a future reader can see that read access was a decision rather than
  -- an oversight.
  FOR target IN
    SELECT c.oid::regclass AS ident
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM service_role',
      target.ident);
    revoked_tables := revoked_tables + 1;
  END LOOP;

  -- Sequences: USAGE/UPDATE are what an INSERT needs, so leaving them
  -- would be a loose end behind every locked-down table.
  FOR target IN
    SELECT c.oid::regclass AS ident
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
     ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE USAGE, UPDATE ON SEQUENCE %s FROM service_role', target.ident);
    revoked_sequences := revoked_sequences + 1;
  END LOOP;

  RAISE NOTICE '0025: hardened % table(s) and % sequence(s) against service_role writes',
    revoked_tables, revoked_sequences;
END;
$$;

-- =====================================================================
-- Self-verification
-- =====================================================================
--
-- Fail the migration rather than leave a single writable application
-- object behind. `has_*_privilege` answers the effective question -
-- direct grant, PUBLIC, or role membership - not merely what one ACL
-- entry says.
DO $$
DECLARE
  offender TEXT;
  problems TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RETURN;
  END IF;

  FOR offender IN
    SELECT c.oid::regclass::text
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND (
         has_table_privilege('service_role', c.oid, 'INSERT')
         OR has_table_privilege('service_role', c.oid, 'UPDATE')
         OR has_table_privilege('service_role', c.oid, 'DELETE')
         OR has_table_privilege('service_role', c.oid, 'TRUNCATE')
       )
  LOOP
    problems := problems || offender;
  END LOOP;

  FOR offender IN
    SELECT c.oid::regclass::text
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
       AND (
         has_sequence_privilege('service_role', c.oid, 'USAGE')
         OR has_sequence_privilege('service_role', c.oid, 'UPDATE')
       )
  LOOP
    problems := problems || ('sequence ' || offender);
  END LOOP;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION '0025: service_role can still write: %', array_to_string(problems, ', ');
  END IF;

  -- The capability model specifically: these are the two tables whose
  -- rows decide who may act on a permit, so they get a named check
  -- rather than relying only on the sweep above.
  IF has_table_privilege('service_role', 'public.team_position_capabilities', 'INSERT')
    OR has_table_privilege('service_role', 'public.user_team_positions', 'INSERT') THEN
    RAISE EXCEPTION '0025: service_role can still manufacture operational capabilities';
  END IF;
END;
$$;

-- `app_runtime`, `privileged_runtime`, `anon` and `authenticated` are
-- not mentioned above: this migration neither grants nor revokes
-- anything for them, and requires no privilege change of its own.
