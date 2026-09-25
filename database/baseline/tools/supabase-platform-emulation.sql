-- GENERATION/TEST FIXTURE ONLY. Never run against a real database.
--
-- A local stand-in for the Supabase platform objects that Permit
-- migrations 0001-0038 assume already exist: the browser roles, the
-- `auth.users` table referenced by user foreign keys, Supabase's default
-- privileges on `public`, pgcrypto in `extensions`, and the
-- `rls_auto_enable` event trigger that 0001 hardens. It mirrors the
-- emulation the backend migration tests already use
-- (backend/src/db/auditImmutability.test.ts). It is used only to replay the
-- historical migrations on a disposable cluster so that the final 0038
-- schema can be captured as the `permit` baseline. It is NOT part of the
-- shared-database architecture.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
GRANT USAGE ON SCHEMA auth TO postgres;
GRANT SELECT, REFERENCES ON auth.users TO postgres;
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE command record;
BEGIN
  FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF command.object_type = 'table' AND command.schema_name = 'public' THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
    END IF;
  END LOOP;
END; $$;
ALTER FUNCTION public.rls_auto_enable() OWNER TO postgres;
CREATE EVENT TRIGGER rls_auto_enable_trigger ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.rls_auto_enable();
