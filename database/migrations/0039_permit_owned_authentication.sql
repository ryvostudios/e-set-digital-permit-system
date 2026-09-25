-- 0039: Permit-owned authentication identity.
--
-- SHARED E-SET DATABASE ONLY. Runs as permit_migrator, inside schema
-- permit, after the verified 0038 baseline (database/baseline). Touches no
-- other schema: not ESDMS's public, and not Supabase's auth.
--
-- WHAT IT DOES
--   1. permit.users: the authentication identity (who is this?) and its
--      credential. It is NOT a source of authority: app_user_access,
--      workforce profiles, Team + Position capabilities and the privileged
--      grant log keep answering "what may this person do?".
--   2. permit.user_sessions: server-side sessions, so logout, reset,
--      disable and delete revoke real sessions immediately. The browser
--      holds an opaque random token; only its SHA-256 digest is stored.
--   3. The 20 user foreign keys that pointed at Supabase auth.users in the
--      standalone database (deferred out of the baseline) are re-created
--      against permit.users with the same names, columns and ON DELETE
--      actions. User ids are preserved exactly: permit.users.id is the
--      same UUID the Supabase identity had.
--
-- ORDERING WITH A DATA MIGRATION. Identities and application rows are
-- imported AFTER this migration, into the final schema. This migration
-- therefore refuses to run while any user reference already holds a value:
-- that would mean rows exist whose identity it cannot vouch for.

DO $guard$
DECLARE
  ref text[];
  found boolean;
BEGIN
  FOREACH ref SLICE 1 IN ARRAY ARRAY[
    ['account_audit_events', 'actor_user_id'], ['account_audit_events', 'target_user_id'],
    ['app_user_access', 'user_id'], ['initial_ceo_bootstrap', 'auth_user_id'],
    ['jsas', 'created_by'], ['notifications', 'recipient_user_id'],
    ['organization_audit_events', 'actor_user_id'], ['permit_lifecycle_events', 'actor_user_id'],
    ['permit_signatures', 'signer_user_id'], ['permits', 'cancelled_by'], ['permits', 'closed_by'],
    ['permits', 'created_by'], ['permits', 'held_by'], ['privileged_access_events', 'actor_user_id'],
    ['privileged_access_events', 'user_id'], ['privileged_identities', 'user_id'],
    ['user_capability_grants', 'actor_user_id'], ['user_capability_grants', 'user_id'],
    ['user_team_positions', 'user_id'], ['workforce_profiles', 'user_id']
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM permit.%I WHERE %I IS NOT NULL)', ref[1], ref[2]) INTO found;
    IF found THEN
      RAISE EXCEPTION '0039 refused: permit.%.% already references users; import identities after this migration', ref[1], ref[2];
    END IF;
  END LOOP;
END
$guard$;

-- ---------------------------------------------------------------------
-- 1. Identity and credential
-- ---------------------------------------------------------------------
CREATE TABLE permit.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored normalized, so equality IS case-insensitive identity. NULL only
  -- for a deleted account, whose login has been destroyed (the row stays:
  -- history references it with ON DELETE RESTRICT).
  email TEXT,
  password_hash TEXT,
  password_scheme TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (
    email IS NULL OR (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1)),
  -- argon2id: every credential this application writes. bcrypt_legacy:
  -- a hash imported from Supabase Auth, verified once and replaced by
  -- argon2id on the first successful sign-in. Nothing else is accepted.
  CONSTRAINT users_password_scheme_known CHECK (password_scheme IN ('argon2id', 'bcrypt_legacy')),
  CONSTRAINT users_password_pairing CHECK ((password_hash IS NULL) = (password_scheme IS NULL)),
  CONSTRAINT users_argon2id_format CHECK (password_scheme IS DISTINCT FROM 'argon2id' OR password_hash LIKE '$argon2id$v=19$%'),
  CONSTRAINT users_bcrypt_format CHECK (
    password_scheme IS DISTINCT FROM 'bcrypt_legacy' OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  CONSTRAINT users_credential_requires_email CHECK (password_hash IS NULL OR email IS NOT NULL)
);
ALTER TABLE permit.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit.users FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 2. Server-side sessions
-- ---------------------------------------------------------------------
CREATE TABLE permit.user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES permit.users (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT user_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT user_sessions_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT user_sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user_id_active_idx ON permit.user_sessions (user_id) WHERE revoked_at IS NULL;
ALTER TABLE permit.user_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit.user_sessions FROM PUBLIC;

-- A revocation is final: once set, revoked_at can never be cleared or
-- moved, so a revoked session can never be brought back.
CREATE FUNCTION permit.user_sessions_revocation_is_final() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked session cannot be restored or re-dated';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'only revocation may change a session';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.user_sessions_revocation_is_final() FROM PUBLIC;
CREATE TRIGGER user_sessions_revocation_is_final
  BEFORE UPDATE ON permit.user_sessions
  FOR EACH ROW EXECUTE FUNCTION permit.user_sessions_revocation_is_final();

-- ---------------------------------------------------------------------
-- 3. User references move from auth.users to permit.users
-- ---------------------------------------------------------------------
-- DROP ... IF EXISTS only matters for an installation made from a baseline
-- that still carried the Supabase references; the current baseline has none.
ALTER TABLE permit.account_audit_events
  DROP CONSTRAINT IF EXISTS account_audit_events_actor_user_id_fkey,
  ADD CONSTRAINT account_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS account_audit_events_target_user_id_fkey,
  ADD CONSTRAINT account_audit_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.app_user_access
  DROP CONSTRAINT IF EXISTS app_user_access_user_id_fkey,
  ADD CONSTRAINT app_user_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.initial_ceo_bootstrap
  DROP CONSTRAINT IF EXISTS initial_ceo_bootstrap_auth_user_id_fkey,
  ADD CONSTRAINT initial_ceo_bootstrap_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.jsas
  DROP CONSTRAINT IF EXISTS jsas_created_by_fkey,
  ADD CONSTRAINT jsas_created_by_fkey FOREIGN KEY (created_by) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.notifications
  DROP CONSTRAINT IF EXISTS notifications_recipient_user_id_fkey,
  ADD CONSTRAINT notifications_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_actor_user_id_fkey,
  ADD CONSTRAINT organization_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.permit_lifecycle_events
  DROP CONSTRAINT IF EXISTS permit_lifecycle_events_actor_user_id_fkey,
  ADD CONSTRAINT permit_lifecycle_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.permit_signatures
  DROP CONSTRAINT IF EXISTS permit_signatures_signer_user_id_fkey,
  ADD CONSTRAINT permit_signatures_signer_user_id_fkey FOREIGN KEY (signer_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.permits
  DROP CONSTRAINT IF EXISTS permits_cancelled_by_fkey,
  ADD CONSTRAINT permits_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS permits_closed_by_fkey,
  ADD CONSTRAINT permits_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS permits_created_by_fkey,
  ADD CONSTRAINT permits_created_by_fkey FOREIGN KEY (created_by) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS permits_held_by_fkey,
  ADD CONSTRAINT permits_held_by_fkey FOREIGN KEY (held_by) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.privileged_access_events
  DROP CONSTRAINT IF EXISTS privileged_access_events_actor_user_id_fkey,
  ADD CONSTRAINT privileged_access_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS privileged_access_events_user_id_fkey,
  ADD CONSTRAINT privileged_access_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.privileged_identities
  DROP CONSTRAINT IF EXISTS privileged_identities_user_id_fkey,
  ADD CONSTRAINT privileged_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.user_capability_grants
  DROP CONSTRAINT IF EXISTS user_capability_grants_actor_user_id_fkey,
  ADD CONSTRAINT user_capability_grants_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES permit.users (id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS user_capability_grants_user_id_fkey,
  ADD CONSTRAINT user_capability_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;
ALTER TABLE permit.user_team_positions
  DROP CONSTRAINT IF EXISTS user_team_positions_user_id_fkey,
  ADD CONSTRAINT user_team_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE CASCADE;
ALTER TABLE permit.workforce_profiles
  DROP CONSTRAINT IF EXISTS workforce_profiles_user_id_fkey,
  ADD CONSTRAINT workforce_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES permit.users (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 4. Runtime privileges (least privilege; column-level where possible)
-- ---------------------------------------------------------------------
-- Sign-in must read the stored hash to verify it; nothing else about a
-- user is readable, and no route returns these columns.
GRANT SELECT (id, email, password_hash, password_scheme) ON permit.users TO permit_runtime;
GRANT INSERT (email, password_hash, password_scheme) ON permit.users TO permit_runtime;
GRANT UPDATE (email, password_hash, password_scheme, updated_at) ON permit.users TO permit_runtime;
GRANT SELECT ON permit.user_sessions TO permit_runtime;
GRANT INSERT (user_id, token_hash, expires_at) ON permit.user_sessions TO permit_runtime;
GRANT UPDATE (revoked_at) ON permit.user_sessions TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.users
  AS PERMISSIVE FOR ALL TO permit_runtime USING (true) WITH CHECK (true);
CREATE POLICY permit_runtime_access ON permit.user_sessions
  AS PERMISSIVE FOR ALL TO permit_runtime USING (true) WITH CHECK (true);
-- permit_privileged receives nothing: its only capability stays EXECUTE on
-- permit.record_site_manager_grant.

-- 5. Session-bound privileged operations. Owned by permit_migrator (the
-- existing non-superuser, NOBYPASSRLS schema/function owner). No new role
-- memberships, table grants or cross-schema privileges are introduced.
-- The session UUID is random, internal-only, and resolved by authentication
-- middleware; it is never a request-body actor UUID or a browser token.
CREATE FUNCTION permit.require_ceo_session(p_session_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE actor uuid;
BEGIN
  SELECT s.user_id INTO actor FROM permit.user_sessions s WHERE s.id = p_session_id;
  IF actor IS NULL THEN RAISE EXCEPTION 'privileged operation refused' USING ERRCODE = '42501'; END IF;
  -- Same lock order as reset/disable: account, then session. Concurrent
  -- logout/disable/reset either wins first or waits for this operation.
  PERFORM 1 FROM permit.app_user_access a
    WHERE a.user_id = actor AND a.state = 'ACTIVE'
      AND NOT a.must_change_password AND NOT a.credential_reset_pending FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'privileged operation refused' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM permit.user_sessions s WHERE s.id = p_session_id
    AND s.user_id = actor AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM (SELECT DISTINCT ON (role) role, action
      FROM permit.privileged_access_events WHERE user_id = actor ORDER BY role, ordinal DESC) latest
    WHERE role = 'CEO' AND action = 'GRANTED'
  ) THEN RAISE EXCEPTION 'privileged operation refused' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END
$fn$;
REVOKE ALL ON FUNCTION permit.require_ceo_session(uuid) FROM PUBLIC;

-- Remove the UUID-only impersonation path. Same signature, but its first
-- argument is now an authenticated internal session ID, never an actor ID.
DROP FUNCTION permit.record_site_manager_grant(uuid, uuid, text);
CREATE FUNCTION permit.record_site_manager_grant(p_session_id uuid, p_target_user_id uuid, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE actor uuid; current_action text;
BEGIN
  actor := permit.require_ceo_session(p_session_id);
  IF p_action IS NULL OR p_action NOT IN ('GRANTED', 'REVOKED') OR p_target_user_id IS NULL
     OR p_target_user_id = actor THEN
    RAISE EXCEPTION 'privileged operation refused' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM permit.app_user_access WHERE user_id = p_target_user_id AND state <> 'DELETED' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM permit.privileged_identities WHERE user_id = p_target_user_id)
     OR EXISTS (SELECT 1 FROM permit.workforce_profiles WHERE user_id = p_target_user_id)
     OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (role) role, action FROM permit.privileged_access_events
       WHERE user_id = p_target_user_id ORDER BY role, ordinal DESC) latest WHERE role = 'CEO' AND action = 'GRANTED') THEN
    RAISE EXCEPTION 'privileged operation refused' USING ERRCODE = '42501';
  END IF;
  SELECT action INTO current_action FROM permit.privileged_access_events
    WHERE user_id = p_target_user_id AND role = 'SITE_MANAGER' ORDER BY ordinal DESC LIMIT 1;
  IF current_action = p_action OR (current_action IS NULL AND p_action = 'REVOKED') THEN
    RAISE EXCEPTION 'privileged state conflict' USING ERRCODE = '23514';
  END IF;
  INSERT INTO permit.privileged_access_events (user_id, role, action, actor_user_id, reason)
    VALUES (p_target_user_id, 'SITE_MANAGER', p_action, actor, 'SITE_MANAGER authority changed by CEO');
  -- A withdrawn privilege cannot survive through an old session.
  IF p_action = 'REVOKED' THEN
    UPDATE permit.user_sessions SET revoked_at = now() WHERE user_id = p_target_user_id AND revoked_at IS NULL;
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION permit.record_site_manager_grant(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION permit.record_site_manager_grant(uuid, uuid, text) TO permit_privileged;

CREATE FUNCTION permit.provision_site_manager(p_session_id uuid, p_email text, p_password_hash text, p_display_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE actor uuid; target uuid;
BEGIN
  actor := permit.require_ceo_session(p_session_id);
  IF p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 254 OR position('@' IN p_email) < 2
     OR p_password_hash IS NULL OR p_password_hash !~ '^\$argon2id\$v=19\$m=65536,(t=3,p=4|p=4,t=3)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'
     OR p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'invalid provisioning input' USING ERRCODE = '23514';
  END IF;
  INSERT INTO permit.users (email, password_hash, password_scheme)
    VALUES (lower(btrim(p_email)), p_password_hash, 'argon2id') RETURNING id INTO target;
  INSERT INTO permit.app_user_access (user_id, state, must_change_password, credentials_changed_at)
    VALUES (target, 'ACTIVE', true, now());
  -- System identity: no fabricated company/team/workforce membership.
  INSERT INTO permit.privileged_identities (user_id, display_name) VALUES (target, btrim(p_display_name));
  -- The append-only grant IS the privileged audit, in this same transaction.
  INSERT INTO permit.privileged_access_events (user_id, role, action, actor_user_id, reason)
    VALUES (target, 'SITE_MANAGER', 'GRANTED', actor, 'SITE_MANAGER provisioned by CEO');
  RETURN target;
END
$fn$;
REVOKE ALL ON FUNCTION permit.provision_site_manager(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION permit.provision_site_manager(uuid, text, text, text) TO permit_privileged;
