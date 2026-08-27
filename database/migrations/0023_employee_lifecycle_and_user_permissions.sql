-- Employee account lifecycle (disable / re-enable / CEO deletion),
-- administrative account auditing, and INDIVIDUAL user-level permissions.
--
-- Migrations 0001-0022 are immutable applied history and are not edited
-- by this file. Three objects created by earlier migrations are widened
-- here - `app_user_access.state`, `account_audit_events`'s event-type
-- CHECK, and migration 0015/0017's timestamp trigger function. That
-- pattern is precedented: migration 0017 already replaced 0015's trigger
-- function the same way, from its own file.

-- =====================================================================
-- 1. Account lifecycle: a terminal DELETED state
-- =====================================================================
--
-- CEO-only permanent deletion must remove the ability to log in FOREVER
-- while preserving every operational and historical record. Deleting the
-- `app_user_access` row is not an option and never will be: `permits`,
-- `permit_signatures`, `account_audit_events`, `workforce_profiles` and
-- `user_team_positions` all reference `auth.users` with ON DELETE
-- RESTRICT, precisely so history cannot be cascaded away.
--
-- So deletion is a TOMBSTONE. `state = 'DELETED'` is terminal: the
-- account keeps its row, its assignment history, its audit trail and
-- every permit it ever signed, but `requireAuth` already refuses any
-- state other than 'ACTIVE', so access ends immediately and a stale JWT
-- is worthless on its very next request. The Supabase Auth identity is
-- removed separately by the service, which is what makes the login
-- permanently unusable rather than merely blocked.
--
-- DELETED is deliberately NOT reachable back to ACTIVE (enforced below),
-- which is exactly what distinguishes it from DISABLED.
ALTER TABLE public.app_user_access
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE public.app_user_access DROP CONSTRAINT app_user_access_state_check;
ALTER TABLE public.app_user_access
  ADD CONSTRAINT app_user_access_state_check CHECK (state IN ('ACTIVE', 'DISABLED', 'DELETED'));

ALTER TABLE public.app_user_access
  ADD CONSTRAINT app_user_access_deleted_consistent CHECK (
    (state = 'DELETED') = (deleted_at IS NOT NULL)
  );

-- Extends migration 0017's function (which itself extended 0015's).
-- Every line of the existing behaviour is preserved verbatim; the only
-- additions are `deleted_at` becoming database-authoritative in exactly
-- the same way `disabled_at` already is, and the terminal-state guard.
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
    -- DELETED is terminal. Nothing may bring an account back from it -
    -- not a re-enable, not a bug, not a hand-written UPDATE.
    IF OLD.state = 'DELETED' AND NEW.state <> 'DELETED' THEN
      RAISE EXCEPTION 'a DELETED account is terminal and cannot be reactivated';
    END IF;
    NEW.credentials_changed_at := CASE
      WHEN NEW.credentials_changed_at IS DISTINCT FROM OLD.credentials_changed_at THEN now()
      ELSE OLD.credentials_changed_at
    END;
  END IF;
  NEW.updated_at := now();
  NEW.disabled_at := CASE WHEN NEW.state = 'DISABLED' THEN COALESCE(OLD.disabled_at, now()) ELSE NULL END;
  NEW.deleted_at := CASE WHEN NEW.state = 'DELETED' THEN COALESCE(OLD.deleted_at, now()) ELSE NULL END;
  RETURN NEW;
END;
$$;

-- =====================================================================
-- 2. Administrative account audit
-- =====================================================================
--
-- Migration 0017 deliberately gave `account_audit_events` NO free-text
-- column, so a password, token or secret is structurally impossible to
-- record. That property is preserved exactly: the columns added here are
-- FOREIGN KEYS to reference data, never text. There is still nowhere for
-- a secret to go.
--
-- The table remains append-only for every role including the table owner
-- (0017's `forbid_mutation` triggers), so an administrative history
-- cannot be edited or erased after the fact.
ALTER TABLE public.account_audit_events DROP CONSTRAINT account_audit_events_type_valid;
ALTER TABLE public.account_audit_events
  ADD CONSTRAINT account_audit_events_type_valid CHECK (
    event_type IN (
      'EMPLOYEE_ACCOUNT_CREATED',
      'EMPLOYEE_PASSWORD_RESET_BY_MANAGER',
      'EMPLOYEE_PASSWORD_CHANGED',
      'EMPLOYEE_DISPLAY_NAME_CHANGED',
      'EMPLOYEE_EMAIL_CHANGED',
      'EMPLOYEE_COMPANY_CHANGED',
      'EMPLOYEE_TEAM_POSITION_CHANGED',
      'EMPLOYEE_PERMISSION_GRANTED',
      'EMPLOYEE_PERMISSION_REVOKED',
      'EMPLOYEE_DISABLED',
      'EMPLOYEE_REENABLED',
      'EMPLOYEE_ACCOUNT_DELETED'
    )
  );

-- Structured, non-free-text detail. Every column is nullable because
-- each applies to only one event type, and every one is a foreign key to
-- authoritative reference data - so "which company did they move from"
-- is answerable without ever storing a caller-supplied string.
ALTER TABLE public.account_audit_events
  ADD COLUMN previous_company_id UUID REFERENCES public.companies (id) ON DELETE RESTRICT,
  ADD COLUMN new_company_id UUID REFERENCES public.companies (id) ON DELETE RESTRICT,
  ADD COLUMN previous_team_position_id UUID REFERENCES public.team_positions (id) ON DELETE RESTRICT,
  ADD COLUMN new_team_position_id UUID REFERENCES public.team_positions (id) ON DELETE RESTRICT,
  ADD COLUMN capability_id UUID REFERENCES public.capabilities (id) ON DELETE RESTRICT;

CREATE INDEX account_audit_events_prev_company_idx ON public.account_audit_events (previous_company_id);
CREATE INDEX account_audit_events_new_company_idx ON public.account_audit_events (new_company_id);
CREATE INDEX account_audit_events_prev_tp_idx ON public.account_audit_events (previous_team_position_id);
CREATE INDEX account_audit_events_new_tp_idx ON public.account_audit_events (new_team_position_id);
CREATE INDEX account_audit_events_capability_idx ON public.account_audit_events (capability_id);

-- =====================================================================
-- 3. INDIVIDUAL user-level permissions
-- =====================================================================
--
-- "View all permits" is granted to a PERSON, not to a Team + Position.
-- That is the whole point: two Civil Workers may legitimately differ on
-- it, so modelling it organizationally would be wrong and would also
-- hand it to everyone who ever holds that combination.
--
-- Not every capability may be granted this way. `permit.close` or
-- `permit.cro_review` as an individual grant would silently bypass the
-- Team + Position -> Capability model that decides who can act on a
-- permit. So a capability must be explicitly marked individually
-- grantable, and only `permit.view_all` is - enforced by trigger, not by
-- convention.
ALTER TABLE public.capabilities
  ADD COLUMN individually_grantable BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO public.capabilities (name, description, individually_grantable) VALUES
  ('permit.view_all', 'See every permit, historical and future, regardless of ownership or review queue', TRUE);

-- Append-only, exactly like `privileged_access_events`: the grant and
-- revoke events ARE the audit trail, current status is derived from the
-- latest event per (user, capability), and nothing can be edited or
-- deleted afterwards - including by the backend.
CREATE TABLE public.user_capability_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  capability_id UUID NOT NULL REFERENCES public.capabilities (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('GRANTED', 'REVOKED')),
  -- The CEO or Site Manager who made the change. Never client-supplied.
  actor_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_capability_grants_not_self CHECK (actor_user_id <> user_id)
);

ALTER TABLE public.user_capability_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_capability_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.user_capability_grants_ordinal_seq FROM PUBLIC, anon, authenticated;

CREATE INDEX user_capability_grants_user_idx ON public.user_capability_grants (user_id, ordinal DESC);
CREATE INDEX user_capability_grants_capability_idx ON public.user_capability_grants (capability_id);
CREATE INDEX user_capability_grants_actor_idx ON public.user_capability_grants (actor_user_id, ordinal DESC);

CREATE FUNCTION public.user_capability_grants_authoritative_timestamp() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_capability_grants_authoritative_timestamp() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_capability_grants_authoritative_timestamp_trigger
  BEFORE INSERT ON public.user_capability_grants
  FOR EACH ROW EXECUTE FUNCTION public.user_capability_grants_authoritative_timestamp();

-- Append-only for EVERY role, reusing migration 0004's mechanism.
CREATE TRIGGER user_capability_grants_append_only
  BEFORE UPDATE OR DELETE ON public.user_capability_grants
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER user_capability_grants_no_truncate
  BEFORE TRUNCATE ON public.user_capability_grants
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

-- The escalation guard. Two independent rules, both enforced by the
-- database rather than by the service that happens to write the row:
--
--   1. Only a capability explicitly marked `individually_grantable` may
--      be granted to a person. Everything else - CRO review, close,
--      renew, HSE review, employee.create - remains reachable ONLY
--      through Team + Position, so no individual grant can ever
--      manufacture workflow or account-management authority.
--   2. Individual grants are for NORMAL employees. A privileged system
--      account already has full visibility through its role and must not
--      accumulate organizational permissions; granting one would blur
--      the very separation migrations 0018/0019 enforce.
CREATE FUNCTION public.user_capability_grants_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.capabilities
     WHERE id = NEW.capability_id AND individually_grantable
  ) THEN
    RAISE EXCEPTION
      'capability % may not be granted to an individual user; only Team + Position grants it',
      NEW.capability_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM public.privileged_access_events
       WHERE user_id = NEW.user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.action = 'GRANTED'
  ) THEN
    RAISE EXCEPTION
      'user % is a privileged system account and does not receive individual organizational permissions',
      NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_capability_grants_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_capability_grants_guard_trigger
  BEFORE INSERT ON public.user_capability_grants
  FOR EACH ROW EXECUTE FUNCTION public.user_capability_grants_guard();

-- `permit.view_all` must never leak into the organizational model.
-- Migration 0020 mapped it to nothing; this makes that permanent rather
-- than a fact about one seed file.
CREATE FUNCTION public.reject_individually_grantable_team_position() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.capabilities
     WHERE id = NEW.capability_id AND individually_grantable
  ) THEN
    RAISE EXCEPTION
      'capability % is an INDIVIDUAL permission and must not be attached to a Team + Position',
      NEW.capability_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_individually_grantable_team_position() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER team_position_capabilities_reject_individual
  BEFORE INSERT OR UPDATE ON public.team_position_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.reject_individually_grantable_team_position();

-- =====================================================================
-- 4. Self-verification
-- =====================================================================
DO $$
DECLARE
  actual BIGINT;
BEGIN
  SELECT count(*) INTO actual FROM public.capabilities WHERE individually_grantable;
  IF actual <> 1 THEN
    RAISE EXCEPTION '0023: expected exactly 1 individually grantable capability, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM public.capabilities WHERE individually_grantable AND name <> 'permit.view_all';
  IF actual <> 0 THEN
    RAISE EXCEPTION '0023: an unexpected capability is marked individually grantable';
  END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities c ON c.id = tpc.capability_id
   WHERE c.individually_grantable;
  IF actual <> 0 THEN
    RAISE EXCEPTION '0023: an individual capability is mapped to a Team + Position';
  END IF;
END;
$$;

-- No browser policy or grant, and no SECURITY DEFINER function, is
-- introduced by this migration. The new runtime-role privileges it
-- requires are SELECT/INSERT on `user_capability_grants` plus USAGE on
-- its sequence, and UPDATE on `app_user_access` (already held). Employee
-- lifecycle writes are deliberately column-scoped: UPDATE(display_name,
-- company_id, primary_team_position_id) on `workforce_profiles` and
-- UPDATE(ended_at) on `user_team_positions` - see DEPLOYMENT.md. There is
-- no table-level UPDATE grant on either table.
