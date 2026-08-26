-- Employee account provisioning and password management.
--
-- Migrations 0001-0016 are immutable, applied history and are never
-- edited by this file. Every change here is additive, except one
-- deliberately REPLACED trigger function (migration 0015's
-- `app_user_access_authoritative_timestamps`), which keeps all of its
-- existing behaviour and only additionally makes the new
-- credential-state timestamp database-authoritative.
--
-- SCOPE: this migration adds application-side ACCOUNT STATE only. It
-- creates no organization data - no team, no position, no team_position,
-- no workforce profile, no employee, no privileged grant. The live
-- database's real organization structure is provisioned by operators and
-- by the account endpoints this migration supports; nothing is guessed
-- here.
--
-- Passwords, temporary passwords and tokens are NEVER stored by this
-- schema. Supabase Auth remains the sole credential store; the columns
-- below record only *whether* a credential change is outstanding and
-- *when* the credential last changed.

-- =====================================================================
-- 1. Application-side account credential state
-- =====================================================================
--
-- `app_user_access` is deliberately the home for this: it is already
-- read on EVERY authenticated request (`middleware/auth.ts::requireAuth`
-- -> `loadAppUserAccess`), so a forced password change and a
-- manager-initiated reset take effect on the very next request without
-- adding a second per-request lookup, and without ever querying
-- `auth.sessions`.
--
-- `must_change_password` defaults to FALSE so applying this migration
-- CANNOT retroactively lock out any already-provisioned identity
-- (notably the bootstrapped CEO): existing rows keep working exactly as
-- they do today. TRUE is only ever written deliberately - by employee
-- provisioning, or by a Site Manager password reset.
ALTER TABLE app_user_access
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN credentials_changed_at TIMESTAMPTZ,
  -- Monotonic application-side ordering for cross-system credential
  -- operations. It is advanced and committed BEFORE a manager touches
  -- Supabase Auth, so an older self-change can never clear a newer gate.
  ADD COLUMN credential_version BIGINT NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
  -- TRUE only while a manager reset has durably gated the account but its
  -- serialized Auth/audit completion has not finished. A self-change may
  -- not start or finish while this marker is set.
  ADD COLUMN credential_reset_pending BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE app_user_access
  ADD CONSTRAINT app_user_access_reset_pending_gated CHECK (
    NOT credential_reset_pending OR must_change_password
  );

-- Existing Team + Positions are deliberately NOT assumed safe for ordinary
-- employee provisioning. An operator/CEO must explicitly approve each
-- assignment out of band; this migration seeds no TRUE value and exposes no
-- API that can change it.
ALTER TABLE team_positions
  ADD COLUMN site_manager_assignable BOOLEAN NOT NULL DEFAULT FALSE;

-- Extends migration 0015's function; every line of its existing
-- behaviour (authoritative created_at/updated_at, and disabled_at
-- pinned to the DISABLED state) is preserved unchanged.
--
-- `credentials_changed_at` becomes database-authoritative in the same
-- way: the application signals "the credential just changed" by writing
-- ANY new value to the column, and the database replaces it with its own
-- `now()`. An application or client clock value can therefore never be
-- persisted, and an unrelated update (e.g. DISABLING an account) leaves
-- the existing credential timestamp untouched rather than silently
-- moving it.
CREATE OR REPLACE FUNCTION public.app_user_access_authoritative_timestamps() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.credentials_changed_at := CASE WHEN NEW.credentials_changed_at IS NULL THEN NULL ELSE now() END;
  ELSE
    NEW.created_at := OLD.created_at;
    IF NEW.credential_version < OLD.credential_version THEN
      RAISE EXCEPTION 'credential_version cannot decrease';
    END IF;
    NEW.credentials_changed_at := CASE
      WHEN NEW.credentials_changed_at IS DISTINCT FROM OLD.credentials_changed_at THEN now()
      ELSE OLD.credentials_changed_at
    END;
  END IF;
  NEW.updated_at := now();
  NEW.disabled_at := CASE WHEN NEW.state = 'DISABLED' THEN COALESCE(OLD.disabled_at, now()) ELSE NULL END;
  RETURN NEW;
END;
$$;

-- =====================================================================
-- 2. Account audit trail
-- =====================================================================
--
-- Deliberately has NO free-text column. The three recorded facts are the
-- event type, who did it, and to whom - which is exactly what the
-- account audit requirement asks for, and means a password, temporary
-- password, token or other secret is STRUCTURALLY impossible to write
-- here, rather than merely forbidden by convention.
--
-- Append-only for every role including the backend's own, using the same
-- forbid_mutation() mechanism as privileged_access_events (0004),
-- permit_lifecycle_events (0006) and permit_signatures (0016).
CREATE TABLE account_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  event_type TEXT NOT NULL,
  -- The account the event happened TO.
  target_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  -- The authenticated identity that performed it. Never client-supplied.
  actor_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_audit_events_type_valid CHECK (
    event_type IN (
      'EMPLOYEE_ACCOUNT_CREATED',
      'EMPLOYEE_PASSWORD_RESET_BY_MANAGER',
      'EMPLOYEE_PASSWORD_CHANGED'
    )
  ),
  -- A self-service password change is always performed BY its own
  -- account; a manager action never is. This makes "a manager reset
  -- recorded as if the employee did it themselves" (and the reverse)
  -- impossible to store, not just unlikely.
  CONSTRAINT account_audit_events_actor_consistent CHECK (
    (event_type = 'EMPLOYEE_PASSWORD_CHANGED' AND actor_user_id = target_user_id)
    OR (event_type <> 'EMPLOYEE_PASSWORD_CHANGED' AND actor_user_id <> target_user_id)
  )
);
ALTER TABLE account_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE account_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE account_audit_events_ordinal_seq FROM PUBLIC, anon, authenticated;

-- DEFAULT now() alone is not authoritative because INSERT can explicitly
-- supply another value. Force the database clock for every audit row.
CREATE FUNCTION public.account_audit_events_authoritative_timestamp() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.account_audit_events_authoritative_timestamp() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER account_audit_events_authoritative_timestamp_trigger
  BEFORE INSERT ON account_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.account_audit_events_authoritative_timestamp();

CREATE INDEX account_audit_events_target_idx ON account_audit_events (target_user_id, ordinal DESC);
CREATE INDEX account_audit_events_actor_idx ON account_audit_events (actor_user_id, ordinal DESC);

CREATE TRIGGER account_audit_events_append_only
  BEFORE UPDATE OR DELETE ON account_audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER account_audit_events_no_truncate
  BEFORE TRUNCATE ON account_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- =====================================================================
-- 3. Account-management capability catalogue
-- =====================================================================
--
-- Named with the established `<domain>.<action>` convention already used
-- by every seeded capability (permit.create, permit.send_back,
-- permit.fallback_approve, ...).
--
-- Seeding a name grants NOTHING by itself: no `team_position_capabilities`
-- row is created here, exactly as in migrations 0005 and 0009. These
-- capabilities are additionally NOT sufficient on their own - the
-- account endpoints also require the caller to hold CEO or Site Manager
-- privileged access (`privileged_access_events`), which Team + Position
-- can never grant. See backend/src/authz/accountManagement.ts.
INSERT INTO capabilities (name, description) VALUES
  ('employee.create', 'Provision a normal employee account (Site Manager account management)'),
  ('employee.reset_password', 'Set a new temporary password on a normal employee account');

-- No policy is created, no anon/authenticated grant is issued, and no
-- SECURITY DEFINER function is introduced anywhere in this migration.
-- The new table follows the established RLS-enabled + REVOKE ALL FROM
-- PUBLIC, anon, authenticated pattern, and the replaced trigger function
-- remains SECURITY INVOKER with a pinned search_path (migration 0014's
-- hardening).
