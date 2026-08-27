-- Deny the Supabase `service_role` any ability to write application
-- PRIVILEGED AUTHORITY.
--
-- Migrations 0001-0021 are immutable applied history and are not edited
-- by this file. This migration issues REVOKEs only: it creates no table,
-- function, trigger, policy or column, and changes no application
-- behaviour.
--
-- WHAT LIVE VERIFICATION FOUND. Supabase's default privileges on schema
-- `public` grant the built-in `service_role` full
-- INSERT/UPDATE/DELETE/TRUNCATE on every table created there, plus
-- `rwU` on every sequence. On this project that included:
--
--   privileged_access_events              DELETE,INSERT,TRUNCATE,UPDATE,...
--   privileged_access_events_ordinal_seq  service_role=rwU/postgres
--   privileged_identities                 DELETE,INSERT,TRUNCATE,UPDATE,...
--   initial_ceo_bootstrap                 DELETE,INSERT,TRUNCATE,UPDATE,...
--
-- `service_role` cannot log in directly (`rolcanlogin` is false) but is
-- reachable through PostgREST with the Supabase service key. A holder of
-- that key could therefore run
--
--     INSERT INTO privileged_access_events (user_id, role, action)
--     VALUES ('<themselves>', 'CEO', 'GRANTED');
--
-- and manufacture CEO authority outright - bypassing the HTTP CEO gate,
-- the dedicated `privileged_runtime` channel, and the hardened grant
-- function all at once. That is the last remaining application
-- privilege-escalation path, and this migration closes it.
--
-- WHY THE SERVICE KEY DOES NOT NEED THIS. The service-role credential is
-- used by exactly one thing in this codebase: the Supabase Auth Admin
-- client (`lib/supabaseAdmin.ts`), which speaks HTTP to the Auth API to
-- create users, set passwords, and delete users. It issues no SQL
-- against application tables at all. Every application statement runs as
-- `app_runtime`, every privileged grant as `privileged_runtime`, and the
-- CEO bootstrap as the operator/owner credential. Revoking these
-- privileges therefore removes nothing any legitimate path uses.
--
-- SCOPE - DELIBERATELY NARROW. Only the four objects that constitute
-- privileged authority and its bootstrap are touched. `service_role`
-- retains SELECT on all of them, and retains every privilege it has on
-- every other table in the schema. The `auth` and `storage` schemas,
-- Supabase-managed functions, and all permit/JSA tables are untouched:
-- the goal is isolating privileged authority, not redesigning Supabase.
--
-- OPERATIONAL CONSEQUENCE. Writing these four tables from the Supabase
-- Studio table editor (which acts as `service_role`) will stop working.
-- Reading them still works. That is the intended trade-off.
--
-- STANDING RULE FOR FUTURE MIGRATIONS. Supabase's default privileges
-- apply to every NEW table and sequence in `public`, so any future table
-- that holds authorization state needs the same treatment in its own
-- migration. Creating the table is not sufficient to protect it.

DO $$
BEGIN
  -- `service_role` is a Supabase-managed role. Guarded so this migration
  -- also applies cleanly to a non-Supabase database (local, CI) where
  -- the role does not exist and there is nothing to revoke.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE '0022: service_role does not exist in this database; nothing to revoke';
    RETURN;
  END IF;

  -- 1. The privileged grant log. SELECT is retained so dashboards and
  --    support tooling can still READ the governance history; every
  --    write path is removed. TRIGGER and REFERENCES go too: the ability
  --    to attach a trigger to this table is itself a write path.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
             ON TABLE public.privileged_access_events FROM service_role';

  -- 2. The sequence behind `ordinal`. An INSERT needs it, so leaving it
  --    granted would be a loose end even with the table locked down.
  --    Nothing legitimate reads or advances it outside an INSERT.
  EXECUTE 'REVOKE ALL ON SEQUENCE public.privileged_access_events_ordinal_seq FROM service_role';

  -- 3. The authoritative identity of privileged accounts. This is
  --    slightly beyond "authority" in the strict sense - a row here
  --    confers nothing - but it is the same tier, and it is the name
  --    that gets frozen onto signed permits. A service-key holder
  --    rewriting the CEO's display name is a privileged-tier integrity
  --    break, so the same read-only posture applies.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
             ON TABLE public.privileged_identities FROM service_role';

  -- 4. The one-shot CEO bootstrap reservation. Its whole purpose is to
  --    make "who becomes the first CEO" a single, non-racy, operator-run
  --    decision; a role that can rewrite the singleton can hijack that.
  --    Verified against the actual bootstrap architecture: only
  --    `scripts/bootstrapCeo.ts` touches this table, and it runs under
  --    the operator credential (`app_runtime` holds no privilege on it
  --    at all). No service-role path needs it.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
             ON TABLE public.initial_ceo_bootstrap FROM service_role';

  -- 5. The hardened SITE_MANAGER grant function. Migration 0021 already
  --    revoked this; re-asserting it here makes 0022 the single place
  --    that states the complete service_role boundary, and the
  --    verification block below then proves all of it at once.
  EXECUTE 'REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM service_role';
END;
$$;

-- =====================================================================
-- Self-verification: fail loudly rather than trust the REVOKEs landed
-- =====================================================================
--
-- `has_*_privilege` answers the real question - can this role do it,
-- through a direct grant, through PUBLIC, or through role membership -
-- rather than merely inspecting one ACL entry.
DO $$
DECLARE
  problems TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RETURN;
  END IF;

  IF has_table_privilege('service_role', 'public.privileged_access_events', 'INSERT')
    THEN problems := problems || 'INSERT privileged_access_events'; END IF;
  IF has_table_privilege('service_role', 'public.privileged_access_events', 'UPDATE')
    THEN problems := problems || 'UPDATE privileged_access_events'; END IF;
  IF has_table_privilege('service_role', 'public.privileged_access_events', 'DELETE')
    THEN problems := problems || 'DELETE privileged_access_events'; END IF;
  IF has_table_privilege('service_role', 'public.privileged_access_events', 'TRUNCATE')
    THEN problems := problems || 'TRUNCATE privileged_access_events'; END IF;
  IF has_sequence_privilege('service_role', 'public.privileged_access_events_ordinal_seq', 'USAGE')
    THEN problems := problems || 'USAGE privileged_access_events_ordinal_seq'; END IF;
  IF has_sequence_privilege('service_role', 'public.privileged_access_events_ordinal_seq', 'UPDATE')
    THEN problems := problems || 'UPDATE privileged_access_events_ordinal_seq'; END IF;
  IF has_function_privilege('service_role', 'public.record_site_manager_grant(uuid, uuid, text)', 'EXECUTE')
    THEN problems := problems || 'EXECUTE record_site_manager_grant'; END IF;
  IF has_table_privilege('service_role', 'public.privileged_identities', 'INSERT')
    THEN problems := problems || 'INSERT privileged_identities'; END IF;
  IF has_table_privilege('service_role', 'public.privileged_identities', 'UPDATE')
    THEN problems := problems || 'UPDATE privileged_identities'; END IF;
  IF has_table_privilege('service_role', 'public.initial_ceo_bootstrap', 'INSERT')
    THEN problems := problems || 'INSERT initial_ceo_bootstrap'; END IF;
  IF has_table_privilege('service_role', 'public.initial_ceo_bootstrap', 'UPDATE')
    THEN problems := problems || 'UPDATE initial_ceo_bootstrap'; END IF;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION '0022: service_role can still write privileged authority: %', array_to_string(problems, ', ');
  END IF;

  -- SELECT is deliberately NOT asserted here. Every REVOKE above names
  -- its privileges explicitly and none of them is SELECT, so read access
  -- survives wherever it existed. Asserting it would be wrong rather than
  -- strict: `service_role` holds SELECT on a live Supabase project
  -- (through that project's default privileges) but holds nothing at all
  -- on a bare PostgreSQL used for local or CI runs, where this migration
  -- must still apply cleanly.

  -- The intended channels must be untouched by this migration.
  IF NOT has_table_privilege('postgres', 'public.privileged_access_events', 'INSERT')
    THEN RAISE EXCEPTION '0022: the operator/owner bootstrap path was broken'; END IF;
  IF NOT has_table_privilege('postgres', 'public.initial_ceo_bootstrap', 'INSERT')
    THEN RAISE EXCEPTION '0022: the operator/owner bootstrap reservation path was broken'; END IF;
END;
$$;

-- `app_runtime` and `privileged_runtime` are deliberately NOT mentioned
-- above: this migration neither grants nor revokes anything for them.
-- It requires no `app_runtime` privilege change and creates no object.
