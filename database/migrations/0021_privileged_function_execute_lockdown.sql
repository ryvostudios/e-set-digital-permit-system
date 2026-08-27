-- Close the Supabase default EXECUTE grant on the privileged grant
-- function.
--
-- Migrations 0001-0020 are immutable applied history and are not edited
-- by this file. 0019 is already applied, which is why this correction is
-- a new migration rather than a change to it.
--
-- WHAT LIVE VERIFICATION FOUND. Migration 0019 revoked EXECUTE on
-- `public.record_site_manager_grant` from PUBLIC, `anon`,
-- `authenticated` and `app_runtime`. On the live Supabase project the
-- function nevertheless came back with:
--
--     proacl = {postgres=X/postgres, service_role=X/postgres}
--
-- because Supabase's default privileges on schema `public` grant EXECUTE
-- to `service_role` on every function created there. A REVOKE listing
-- specific roles cannot remove a grant to a role it does not name, so the
-- lockdown in 0019 was incomplete.
--
-- WHY IT MATTERS. `service_role` is reachable through PostgREST with the
-- Supabase service key (`rolcanlogin` is false, so not by direct login).
-- An EXECUTE grant therefore exposes the function as an RPC to anyone
-- holding that key, which would let them grant SITE_MANAGER by supplying
-- the real CEO's id as the actor - the exact escalation the separate
-- `privileged_runtime` login exists to prevent.
--
-- SCOPE, STATED HONESTLY. This migration removes that one EXECUTE grant.
-- It does NOT resolve the larger, pre-existing fact that `service_role`
-- also holds full DML on `privileged_access_events` and
-- `privileged_identities` (and on every other application table) through
-- the same Supabase defaults, so a holder of the service key can still
-- append a privileged event directly. Narrowing `service_role` across the
-- schema is a project-wide operator decision with its own blast radius -
-- Supabase Studio and other managed tooling rely on those defaults - and
-- must not be taken unilaterally inside a feature migration. See
-- DEPLOYMENT.md and SECURITY.md for the exact proposed SQL and the
-- decision that is still outstanding.
--
-- What DOES already hold against `service_role`: migration 0004's
-- `forbid_mutation` triggers refuse UPDATE, DELETE and TRUNCATE on
-- `privileged_access_events` for EVERY role, including this one and the
-- table owner. The grant log therefore remains append-only and
-- tamper-evident no matter which credential is used; only appending is
-- reachable.

REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM service_role;

-- Re-assert 0019's intended lockdown, so this file alone states the
-- complete intended ACL for the function: EXECUTE belongs to the function
-- owner and to the dedicated `privileged_runtime` login (granted
-- operator-side, post-migration) and to nobody else.
REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM app_runtime';
  END IF;
END;
$$;

-- Self-verification: fail the migration rather than leave a silently
-- over-granted privileged function behind. Only the owner may remain at
-- this point; `privileged_runtime` is granted EXECUTE afterwards by the
-- operator, so it is deliberately not expected here.
DO $$
DECLARE
  unexpected TEXT;
BEGIN
  SELECT string_agg(grantee, ', ') INTO unexpected
    FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name = 'record_site_manager_grant'
     AND grantee <> (
       SELECT pg_catalog.pg_get_userbyid(p.proowner)
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'record_site_manager_grant'
     )
     AND grantee <> 'privileged_runtime';
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION '0021: record_site_manager_grant is still executable by: %', unexpected;
  END IF;
END;
$$;

-- This migration creates no object and requires no `app_runtime`
-- privilege change.
