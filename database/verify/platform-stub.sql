-- DISPOSABLE REHEARSAL ONLY. Never run against a real database.
--
-- The Supabase platform state the shared E-Set database already has before
-- either application is released: the browser roles, pgcrypto installed in
-- `extensions` (so ESDMS's `CREATE EXTENSION IF NOT EXISTS pgcrypto` is a
-- no-op, as on Supabase), Supabase's default search_path, and an
-- `auth.users` TEST STUB for Permit's transitional Supabase Auth foreign
-- keys. Run as the throwaway cluster's superuser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
END $$;
