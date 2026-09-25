\set ON_ERROR_STOP on
\set ECHO none

-- Provisions the Permit database identities and the empty `permit` schema
-- in the shared E-Set database. Run by the database administrator
-- (Supabase `postgres`), never by an application credential, BEFORE the
-- Permit migration runner installs the baseline. Safe to re-run: existing
-- roles are verified and only their passwords rotated.
--
-- It touches no ESDMS object. It grants nothing on schema `public` and no
-- privilege on any existing table.
--
-- Invocation (passwords read without terminal echo; never in this file,
-- on the command line or in shell history):
--
--   read -rs PERMIT_MIGRATOR_PASSWORD;   export PERMIT_MIGRATOR_PASSWORD
--   read -rs PERMIT_RUNTIME_PASSWORD;    export PERMIT_RUNTIME_PASSWORD
--   read -rs PERMIT_PRIVILEGED_PASSWORD; export PERMIT_PRIVILEGED_PASSWORD
--   psql --no-psqlrc "$ADMIN_DATABASE_URL" -f database/roles/provision-permit-roles.sql
--   unset PERMIT_MIGRATOR_PASSWORD PERMIT_RUNTIME_PASSWORD PERMIT_PRIVILEGED_PASSWORD
--
-- --no-psqlrc and ECHO none are part of the secret-handling boundary
-- (same pattern as the ESDMS provisioning script).
--
-- Roles:
--   permit_migrator   owns schema permit and every Permit object; runs
--                     `npm run migrate` (MIGRATION_DATABASE_URL).
--   permit_runtime    the API login (DATABASE_URL). NOBYPASSRLS; receives
--                     its object privileges from the baseline/migrations.
--   permit_privileged the CEO Site Manager grant path
--                     (PRIVILEGED_DATABASE_URL); EXECUTE on one function.

\getenv migrator_password PERMIT_MIGRATOR_PASSWORD
\getenv runtime_password PERMIT_RUNTIME_PASSWORD
\getenv privileged_password PERMIT_PRIVILEGED_PASSWORD
\getenv transitional_auth_fk PERMIT_TRANSITIONAL_AUTH_FK
\if :{?migrator_password}
\else
  \warn 'ERROR: PERMIT_MIGRATOR_PASSWORD is required.'
  DO $abort$ BEGIN RAISE EXCEPTION 'PERMIT_MIGRATOR_PASSWORD is required'; END $abort$;
\endif
\if :{?runtime_password}
\else
  \warn 'ERROR: PERMIT_RUNTIME_PASSWORD is required.'
  DO $abort$ BEGIN RAISE EXCEPTION 'PERMIT_RUNTIME_PASSWORD is required'; END $abort$;
\endif
\if :{?privileged_password}
\else
  \warn 'ERROR: PERMIT_PRIVILEGED_PASSWORD is required.'
  DO $abort$ BEGIN RAISE EXCEPTION 'PERMIT_PRIVILEGED_PASSWORD is required'; END $abort$;
\endif

-- Validated through extended-query parameters so no password is
-- interpolated into a SELECT or exposed by statement logging.
SELECT length($1) >= 16 AND length($2) >= 16 AND length($3) >= 16
       AND $1 <> $2 AND $1 <> $3 AND $2 <> $3 AS passwords_valid
\bind :'migrator_password' :'runtime_password' :'privileged_password'
\gset
\if :passwords_valid
\else
  \warn 'ERROR: each Permit password must be at least 16 characters and all three must differ.'
  DO $abort$ BEGIN RAISE EXCEPTION 'invalid Permit role passwords'; END $abort$;
\endif

BEGIN;

-- Existing roles are never "repaired": one with an elevated attribute,
-- no LOGIN, or any role membership is rejected before anything changes.
SELECT
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permit_migrator') AS migrator_exists,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permit_runtime') AS runtime_exists,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permit_privileged') AS privileged_exists,
  NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged')
       AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
            OR NOT r.rolcanlogin OR r.rolinherit
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  ) AS existing_roles_safe
\gset
\if :existing_roles_safe
\else
  \warn 'ERROR: an existing Permit role has an elevated attribute, no LOGIN, INHERIT, or a role membership; refusing to alter it.'
  DO $abort$ BEGIN RAISE EXCEPTION 'unsafe existing Permit role'; END $abort$;
\endif

\if :migrator_exists
  ALTER ROLE permit_migrator PASSWORD :'migrator_password';
\else
  CREATE ROLE permit_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
    NOINHERIT CONNECTION LIMIT 3 PASSWORD :'migrator_password';
\endif
\if :runtime_exists
  ALTER ROLE permit_runtime PASSWORD :'runtime_password';
\else
  CREATE ROLE permit_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
    NOINHERIT CONNECTION LIMIT 20 PASSWORD :'runtime_password';
\endif
\if :privileged_exists
  ALTER ROLE permit_privileged PASSWORD :'privileged_password';
\else
  CREATE ROLE permit_privileged LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
    NOINHERIT CONNECTION LIMIT 4 PASSWORD :'privileged_password';
\endif

-- Name resolution never reaches `public`: unqualified Permit SQL resolves
-- in `permit`; pg_temp is pinned last so a temporary object can never
-- shadow a Permit table.
ALTER ROLE permit_migrator SET search_path = pg_catalog, permit, pg_temp;
ALTER ROLE permit_runtime SET search_path = pg_catalog, permit, pg_temp;
ALTER ROLE permit_privileged SET search_path = pg_catalog, permit, pg_temp;

DO $connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO permit_migrator, permit_runtime, permit_privileged',
                 current_database());
END
$connect$;

-- The schema exists before any Permit object and belongs to the migrator.
CREATE SCHEMA IF NOT EXISTS permit AUTHORIZATION permit_migrator;
SELECT pg_get_userbyid(nspowner) = 'permit_migrator' AS schema_owner_ok
  FROM pg_namespace WHERE nspname = 'permit'
\gset
\if :schema_owner_ok
\else
  \warn 'ERROR: schema permit exists but is not owned by permit_migrator.'
  DO $abort$ BEGIN RAISE EXCEPTION 'schema permit has the wrong owner'; END $abort$;
\endif
REVOKE ALL ON SCHEMA permit FROM PUBLIC;

-- TRANSITIONAL (until Permit-owned authentication replaces Supabase Auth):
-- the 0038 baseline still declares user foreign keys to auth.users, which
-- needs REFERENCES on that table. Opt-in only; the auth-removal phase
-- deletes this block and the foreign keys.
\if :{?transitional_auth_fk}
  SELECT :'transitional_auth_fk' = 'yes' AS grant_auth_fk
  \gset
  \if :grant_auth_fk
    GRANT USAGE ON SCHEMA auth TO permit_migrator;
    GRANT REFERENCES (id) ON auth.users TO permit_migrator;
  \endif
\endif

-- Final invariant check (same as the pre-check, after creation).
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles r
   WHERE r.rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged')
     AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
          OR NOT r.rolcanlogin OR r.rolinherit
          OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
) AND (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged')) = 3
  AS roles_safe
\gset
\if :roles_safe
\else
  \warn 'ERROR: Permit roles failed the required attribute invariant.'
  DO $abort$ BEGIN RAISE EXCEPTION 'Permit role verification failed'; END $abort$;
\endif

COMMIT;
\echo 'Permit roles and schema provisioned.'
