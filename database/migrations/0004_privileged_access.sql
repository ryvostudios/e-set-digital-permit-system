-- Privileged access foundation (CEO / Site Manager).
--
-- Privileged management access is a separate authority tier from
-- operational Team + Position capabilities, and must never be derived
-- from or grantable via Team + Position (see ARCHITECTURE.md /
-- SECURITY.md / DECISIONS.md). It is represented here as an append-only
-- grant/revoke event log, not a mutable current-state flag, so that the
-- grants and revocations themselves are the audit trail
-- (DATABASE.md: "Privileged access changes... must support audit
-- history, not just current-state flags"). Current status (is this user
-- currently CEO/Site Manager?) is derived by reading the latest event
-- per (user, role), never stored redundantly.
--
-- This migration only stores data. It does not implement, and must not
-- be read as assuming, any specific grant/revoke API or bootstrap
-- mechanism - how the very first CEO is established is not decided in
-- the authoritative docs. `actor_user_id` is nullable to allow for an
-- out-of-band/administrative bootstrap grant with no granting actor;
-- application-level rules (only one active CEO, only CEO grants/revokes
-- Site Manager, a Site Manager cannot grant another Site Manager) are
-- deliberately not implemented here - no grant/revoke service exists
-- yet, so there is no unresolved behavior encoded either.

CREATE TABLE privileged_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('CEO', 'SITE_MANAGER')),
  action TEXT NOT NULL CHECK (action IN ('GRANTED', 'REVOKED')),
  actor_user_id UUID REFERENCES auth.users (id) ON DELETE RESTRICT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE privileged_access_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE privileged_access_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE privileged_access_events_ordinal_seq FROM PUBLIC, anon, authenticated;

CREATE INDEX privileged_access_events_user_id_idx ON privileged_access_events (user_id);

-- Append-only enforcement, at the database level, for any role -
-- including the backend's own (table-owning) role, not just
-- anon/authenticated. RLS and the REVOKE above only stop roles with no
-- privileges on the table; a trigger fires regardless of who is writing,
-- so this is what actually makes UPDATE/DELETE impossible even from a
-- buggy or compromised backend query, not merely hidden by application
-- code. Shared by permit_lifecycle_events (migration
-- 0006_permits_jsa_schema.sql), which is created after this one.
CREATE FUNCTION forbid_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted - this table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

REVOKE ALL ON FUNCTION forbid_mutation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER privileged_access_events_append_only
  BEFORE UPDATE OR DELETE ON privileged_access_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- TRUNCATE bypasses row-level triggers (and RLS) entirely, so it needs
-- its own statement-level trigger to be blocked - the row-level trigger
-- above does not cover it.
CREATE TRIGGER privileged_access_events_no_truncate
  BEFORE TRUNCATE ON privileged_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
