-- Privileged system identities, the two-directional privileged/employee
-- invariant, company-owned teams, and one-current-assignment history.
--
-- Migrations 0001-0018 are immutable applied history and are not edited
-- by this file. Everything here is additive except two deliberately
-- widened constraints on tables created earlier (`teams`,
-- `user_team_positions`), both of which are empty in every environment
-- this migration is allowed to run against - see the guards below.
--
-- SCOPE: identity and organizational STRUCTURE only. This migration
-- creates no team, position, team_position, employee, profile, or
-- privileged grant; the launch organization is seeded separately by
-- 0020. No permit, JSA, snapshot, or signature behaviour changes here.

-- =====================================================================
-- 0. Preconditions
-- =====================================================================
--
-- This migration widens `teams` and `user_team_positions` in ways that
-- would otherwise need an operator-reviewed backfill (which company does
-- an existing team belong to? which of a user's several assignments is
-- the current one?). Rather than guess either answer, it refuses to run
-- when there is anything to guess. Both tables are empty in the live
-- database: no migration through 0018 seeds organization data, and
-- employee provisioning has never run.
DO $$
DECLARE
  team_count BIGINT;
  assignment_count BIGINT;
  privileged_employee_count BIGINT;
BEGIN
  SELECT count(*) INTO team_count FROM public.teams;
  IF team_count <> 0 THEN
    RAISE EXCEPTION
      '0019 refused: % existing team(s) have no authoritative company owner; team-company mapping must be resolved before migration',
      team_count;
  END IF;

  SELECT count(*) INTO assignment_count FROM public.user_team_positions;
  IF assignment_count <> 0 THEN
    RAISE EXCEPTION
      '0019 refused: % existing assignment(s) have no authoritative current/ended state; assignment history must be resolved before migration',
      assignment_count;
  END IF;

  -- The invariant this migration is about to enforce must already hold,
  -- or enforcing it would leave unreachable rows behind.
  SELECT count(*) INTO privileged_employee_count
    FROM (
      SELECT DISTINCT ON (user_id, role) user_id, action
        FROM public.privileged_access_events
       ORDER BY user_id, role, ordinal DESC
    ) latest
    JOIN public.workforce_profiles wp ON wp.user_id = latest.user_id
   WHERE latest.action = 'GRANTED';
  IF privileged_employee_count <> 0 THEN
    RAISE EXCEPTION
      '0019 refused: % user(s) hold an active privileged grant AND a workforce profile; this must be resolved as a governance decision, never by deleting either record',
      privileged_employee_count;
  END IF;
END;
$$;

-- =====================================================================
-- 1. Authoritative privileged system identity
-- =====================================================================
--
-- CEO and E-SET SITE_MANAGER are privileged SYSTEM accounts. They have
-- no Company, no Team and no Position, so `workforce_profiles` (the
-- ORGANIZATIONAL employee store, whose composite foreign key requires a
-- Team + Position the user actually holds) can never hold their name.
-- This table is the authoritative home for that one fact: their personal
-- display name.
--
-- It stores IDENTITY ONLY. Privilege itself is NOT duplicated here -
-- whether a user is currently CEO or SITE_MANAGER is still derived
-- solely from the latest `privileged_access_events` row per role
-- (migration 0004). A row here is therefore not a grant, confers
-- nothing, and cannot be used to escalate; a user with a row here and no
-- active grant is simply a named identity with no authority at all.
--
-- There is deliberately no company_id, team, position, email, or
-- metadata column: the display name is server-authoritative and is never
-- derived from an email address, an email domain, or Supabase
-- `user_metadata`.
CREATE TABLE public.privileged_identities (
  user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT privileged_identities_display_name_not_blank CHECK (btrim(display_name) <> '')
);

-- Timestamps are database-authoritative, matching migrations 0015/0016
-- exactly: SECURITY INVOKER, pinned search_path, `created_at` preserved
-- across updates so a rename cannot rewrite when the identity was
-- established.
CREATE FUNCTION public.privileged_identities_authoritative_timestamps() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.privileged_identities_authoritative_timestamps() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER privileged_identities_authoritative_timestamps_trigger
  BEFORE INSERT OR UPDATE ON public.privileged_identities
  FOR EACH ROW EXECUTE FUNCTION public.privileged_identities_authoritative_timestamps();

ALTER TABLE public.privileged_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.privileged_identities FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 2. The privileged/employee invariant, enforced in BOTH directions
-- =====================================================================
--
-- A user must NEVER be simultaneously a normal organizational employee
-- and an active CEO / SITE_MANAGER. Migration 0018 closed one direction
-- (an already-privileged user cannot be given a workforce profile). The
-- other direction is closed here, so the pair of rules is symmetric and
-- neither an application bug nor an operator script can produce the
-- forbidden combination:
--
--   0018  workforce profile  <-  blocked for an actively privileged user
--   0019  privileged GRANT   <-  blocked for a user holding a profile
--   0019  privileged identity <- blocked for a user holding a profile
--
-- FAIL CLOSED, never convert: nothing here deletes an employee's
-- profile, ends their assignment, or rewrites history in order to make a
-- grant succeed. Promoting a normal employee to a privileged account is
-- not an automatic workflow; if it is ever wanted it must be an explicit,
-- separately designed transition.
CREATE FUNCTION public.reject_privileged_grant_for_employee() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workforce_profiles WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION
      'user % is a normal workforce employee and must not be granted privileged system access; retire the organizational identity first as an explicit transition',
      NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_privileged_grant_for_employee() FROM PUBLIC, anon, authenticated;

-- Only a GRANT is blocked. A REVOKE must always remain possible: if the
-- forbidden combination ever existed, withdrawing authority is the safe
-- direction and must never be the operation that a guard prevents.
CREATE TRIGGER privileged_access_events_reject_employee_grant
  BEFORE INSERT ON public.privileged_access_events
  FOR EACH ROW WHEN (NEW.action = 'GRANTED')
  EXECUTE FUNCTION public.reject_privileged_grant_for_employee();

CREATE TRIGGER privileged_identities_reject_employee
  BEFORE INSERT OR UPDATE ON public.privileged_identities
  FOR EACH ROW EXECUTE FUNCTION public.reject_privileged_grant_for_employee();

-- =====================================================================
-- 3. Teams belong to exactly one company
-- =====================================================================
--
-- Without this, "HSE" would be a single global team and a ZPL employee
-- could be assigned to it, silently inheriting E-SET HSE permit-approval
-- authority through the Team + Position -> Capability model. Binding
-- each team to one company makes the confirmed rule - ZPL HSE has NO
-- permit approval authority, and only E-SET E-BOP CRO / E-SET HSE
-- approve - structural rather than procedural.
--
-- It also gives employee provisioning and employee updates a real
-- integrity check: an assignment whose team belongs to another company
-- is refused by the database, not merely by request validation.
ALTER TABLE public.teams
  ADD COLUMN company_id UUID NOT NULL,
  ADD CONSTRAINT teams_company_fk
    FOREIGN KEY (company_id) REFERENCES public.companies (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX teams_company_idx ON public.teams (company_id);

-- A team name is unique per company rather than globally, so each
-- company may own its own "HSE" or "Admin" team without colliding.
ALTER TABLE public.teams DROP CONSTRAINT teams_name_unique;
ALTER TABLE public.teams ADD CONSTRAINT teams_company_name_unique UNIQUE (company_id, name);

-- An employee's company must equal the company that owns the team behind
-- their primary assignment. Enforced on the profile side, where both
-- facts are visible at once.
CREATE FUNCTION public.workforce_profiles_company_matches_team() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  team_company UUID;
BEGIN
  SELECT t.company_id INTO team_company
    FROM public.team_positions tp
    JOIN public.teams t ON t.id = tp.team_id
   WHERE tp.id = NEW.primary_team_position_id;
  IF team_company IS NULL THEN
    RAISE EXCEPTION 'primary team position % does not resolve to a team', NEW.primary_team_position_id;
  END IF;
  IF team_company <> NEW.company_id THEN
    RAISE EXCEPTION
      'employee company % does not own the team behind assignment %; cross-company assignment is not permitted',
      NEW.company_id, NEW.primary_team_position_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workforce_profiles_company_matches_team() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workforce_profiles_company_matches_team_trigger
  BEFORE INSERT OR UPDATE ON public.workforce_profiles
  FOR EACH ROW EXECUTE FUNCTION public.workforce_profiles_company_matches_team();

-- =====================================================================
-- 4. Exactly one CURRENT assignment, with history preserved
-- =====================================================================
--
-- A normal employee holds exactly one active Team + Position at a time,
-- but every assignment they have ever held must remain readable. Rather
-- than deleting the old row on a transfer (which would destroy history
-- and, worse, is refused outright by migration 0016's ON DELETE RESTRICT
-- composite foreign key from `workforce_profiles`), an assignment is
-- ENDED in place by stamping `ended_at`.
--
--   ended_at IS NULL      -> the one current assignment
--   ended_at IS NOT NULL  -> preserved history, never deleted
--
-- The partial unique index is what makes "exactly one current" a
-- database fact rather than an application convention. The pre-existing
-- UNIQUE (user_id, team_position_id) is intentionally KEPT: migration
-- 0016's composite foreign key depends on it. Its consequence is that
-- returning to a previously-held Team + Position reactivates that same
-- history row instead of inserting a duplicate, which is also why
-- `ended_at` is nullable-in-place rather than an append-only log.
ALTER TABLE public.user_team_positions
  ADD COLUMN started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD CONSTRAINT user_team_positions_period_ordered CHECK (ended_at IS NULL OR ended_at >= started_at);

CREATE UNIQUE INDEX user_team_positions_one_current_per_user
  ON public.user_team_positions (user_id)
  WHERE ended_at IS NULL;

CREATE INDEX user_team_positions_user_current_idx
  ON public.user_team_positions (user_id, ended_at);

-- `started_at` is database-authoritative on insert and immutable
-- afterwards; `ended_at` is database-authoritative whenever it changes
-- from NULL to set, so no application or client clock can backdate or
-- forward-date a period. Clearing `ended_at` (reactivating a previously
-- held assignment) is permitted and simply makes the row current again.
CREATE FUNCTION public.user_team_positions_authoritative_period() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.started_at := now();
    NEW.created_at := now();
    IF NEW.ended_at IS NOT NULL THEN NEW.ended_at := now(); END IF;
  ELSE
    NEW.started_at := CASE
      WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NULL THEN now()
      ELSE OLD.started_at
    END;
    NEW.created_at := OLD.created_at;
    NEW.ended_at := CASE
      WHEN NEW.ended_at IS NULL THEN NULL
      WHEN OLD.ended_at IS NULL THEN now()
      ELSE OLD.ended_at
    END;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_team_positions_authoritative_period() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_team_positions_authoritative_period_trigger
  BEFORE INSERT OR UPDATE ON public.user_team_positions
  FOR EACH ROW EXECUTE FUNCTION public.user_team_positions_authoritative_period();

-- An employee's primary assignment must be one they CURRENTLY hold. The
-- composite foreign key from migration 0016 already proves they hold it;
-- this adds that it has not been ended, so a transferred employee's
-- signing designation and `/auth/me` profile can never resolve through a
-- retired assignment.
CREATE FUNCTION public.workforce_profiles_primary_assignment_current() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_team_positions
     WHERE user_id = NEW.user_id
       AND team_position_id = NEW.primary_team_position_id
       AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'primary assignment % is not a CURRENT assignment held by user %',
      NEW.primary_team_position_id, NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workforce_profiles_primary_assignment_current() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workforce_profiles_primary_assignment_current_trigger
  BEFORE INSERT OR UPDATE ON public.workforce_profiles
  FOR EACH ROW EXECUTE FUNCTION public.workforce_profiles_primary_assignment_current();

-- =====================================================================
-- 5. SITE_MANAGER administration, without handing the runtime role the
--    ability to mint a CEO
-- =====================================================================
--
-- THE PROBLEM. The CEO-only Site Manager endpoints must append
-- GRANTED/REVOKED rows at request time, which naively means granting
-- `app_runtime` INSERT on `privileged_access_events`. That would be a
-- real privilege-escalation surface, not a theoretical one: anyone
-- holding the runtime database credential could bypass HTTP entirely and
-- run
--
--     INSERT INTO privileged_access_events (user_id, role, action)
--     VALUES ('<themselves>', 'CEO', 'GRANTED');
--
-- making themselves CEO. Route-level CEO checks are irrelevant to
-- someone speaking SQL directly. It would also silently reverse the
-- containment boundary DEPLOYMENT.md states explicitly - that
-- `app_runtime` has "no INSERT/sequence access for
-- `privileged_access_events`" - which is precisely what keeps a leaked
-- runtime credential inside the operational tier. That credential
-- already permits self-assignment to any Team + Position (and therefore
-- any operational capability); the privileged tier is the one boundary
-- it cannot currently cross, and it must stay that way.
--
-- THE REPAIR. A SEPARATE LOGIN. The ordinary runtime role gets neither
-- INSERT on the table nor EXECUTE on this function - it has no route to
-- privileged authority at all. EXECUTE belongs solely to a dedicated
-- `privileged_runtime` login (CONNECT + schema USAGE + this one EXECUTE,
-- and no table privilege whatsoever), which the backend uses through a
-- separate bounded pool reserved for CEO administration
-- (backend/src/db/privilegedPool.ts). Granting EXECUTE to `app_runtime`
-- was considered and rejected: it would have left possession of
-- `DATABASE_URL` alone sufficient to grant SITE_MANAGER, simply by
-- passing the real CEO's id as the actor. The role written is the
-- hardcoded literal
-- 'SITE_MANAGER' - it is not a parameter, so no argument, injection, or
-- caller mistake can produce a CEO grant through this path. The function
-- re-derives the actor's CEO status from authoritative database state
-- using the same latest-event-per-role rule the application uses, so it
-- cannot be talked into acting for a non-CEO.
--
-- SECURITY DEFINER IS REQUIRED HERE, and this is the only such function
-- in the schema. A SECURITY INVOKER function would execute as
-- `app_runtime` and would therefore need the direct INSERT this design
-- exists to avoid, defeating the entire point. It is hardened per
-- migration 0014: `search_path` is pinned to `pg_catalog`, every object
-- is fully schema-qualified, and EXECUTE is revoked from
-- PUBLIC/anon/authenticated (the operator grants EXECUTE to
-- `app_runtime` alone - see DEPLOYMENT.md).
--
-- RESIDUAL RISK, STATED PLAINLY. Compromise of BOTH the ordinary runtime
-- credential AND the separate privileged credential would still allow a
-- SITE_MANAGER grant, because the database cannot authenticate an HTTP
-- caller and must trust the actor id it is given. It can never allow a
-- CEO grant from either: the role is not a parameter. Compromise of the
-- ordinary runtime credential alone - by far the larger exposure, since
-- it is what every request already uses - grants no privileged authority
-- whatsoever.
--
-- The append-only guarantee is untouched: migration 0004's
-- `forbid_mutation` triggers refuse UPDATE/DELETE/TRUNCATE for every
-- role including the table owner, so nothing written through this
-- function can later be edited or erased.
CREATE FUNCTION public.record_site_manager_grant(
  p_actor_user_id UUID,
  p_target_user_id UUID,
  p_action TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor_is_ceo BOOLEAN;
  target_is_ceo BOOLEAN;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('GRANTED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid privileged action %', p_action;
  END IF;
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'both an actor and a target are required';
  END IF;
  IF p_actor_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'a CEO may not change their own privileged role';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM public.privileged_access_events
       WHERE user_id = p_actor_user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.role = 'CEO' AND latest.action = 'GRANTED'
  ) INTO actor_is_ceo;
  IF NOT actor_is_ceo THEN
    RAISE EXCEPTION 'only an active CEO may administer SITE_MANAGER';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.app_user_access WHERE user_id = p_target_user_id) THEN
    RAISE EXCEPTION 'target account % does not exist', p_target_user_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (role) role, action
        FROM public.privileged_access_events
       WHERE user_id = p_target_user_id
       ORDER BY role, ordinal DESC
    ) latest WHERE latest.role = 'CEO' AND latest.action = 'GRANTED'
  ) INTO target_is_ceo;
  IF target_is_ceo THEN
    RAISE EXCEPTION 'the CEO tier is not administrable through SITE_MANAGER administration';
  END IF;

  IF p_action = 'GRANTED' THEN
    -- Redundant with the trigger in section 2, deliberately: this path
    -- must refuse a promotion on its own terms, not merely as a side
    -- effect of a guard someone could later reason about separately.
    IF EXISTS (SELECT 1 FROM public.workforce_profiles WHERE user_id = p_target_user_id) THEN
      RAISE EXCEPTION 'user % is a normal workforce employee and cannot receive privileged access', p_target_user_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.privileged_identities WHERE user_id = p_target_user_id) THEN
      RAISE EXCEPTION 'user % has no authoritative privileged identity', p_target_user_id;
    END IF;
  END IF;

  -- 'SITE_MANAGER' is a hardcoded literal, never a parameter.
  INSERT INTO public.privileged_access_events (user_id, role, action, actor_user_id, reason)
  VALUES (
    p_target_user_id,
    'SITE_MANAGER',
    p_action,
    p_actor_user_id,
    CASE WHEN p_action = 'GRANTED' THEN 'SITE_MANAGER granted by CEO' ELSE 'SITE_MANAGER revoked by CEO' END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- The ordinary runtime login must NOT be able to call this, even though
-- the backend code that uses it runs under that login for everything
-- else. EXECUTE is granted (operator-side, post-migration) only to the
-- dedicated `privileged_runtime` role - see DEPLOYMENT.md. Revoking here
-- as well is belt-and-braces: PostgreSQL grants EXECUTE to PUBLIC by
-- default, and while the REVOKE above already removes that, an operator
-- who later grants it to `app_runtime` by mistake would silently
-- reintroduce the escalation this whole design exists to prevent.
--
-- Guarded by a role-existence check because `app_runtime` is an
-- operator-created login that does not exist in every environment (and
-- must never be created, with or without a password, by a migration in
-- source control).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_site_manager_grant(UUID, UUID, TEXT) FROM app_runtime';
  END IF;
END;
$$;

-- Except for `record_site_manager_grant` in section 5 - whose SECURITY
-- DEFINER status is justified, hardened and scoped there - no browser
-- policy or grant, and no other SECURITY DEFINER function, is introduced
-- anywhere in this migration. The new runtime-role privileges required
-- are SELECT/INSERT on `privileged_identities` plus EXECUTE on that one
-- function, and deliberately NOT INSERT on `privileged_access_events`
-- (DEPLOYMENT.md). The guards read `workforce_profiles`,
-- `privileged_access_events`, `teams`, `team_positions` and
-- `user_team_positions`, on all of which the runtime role already holds
-- SELECT.
