-- Authoritative one-company-per-NORMAL-EMPLOYEE workforce membership.
--
-- Migrations 0001-0017 are immutable applied history. This migration is
-- additive and deliberately refuses to guess existing profile membership.
--
-- WHO THIS TABLE IS FOR. `workforce_profiles` is, and remains, the
-- ORGANIZATIONAL EMPLOYEE profile store. Migration 0016 already made
-- that structural: `primary_team_position_id` is NOT NULL and its
-- composite foreign key requires an assignment the same user actually
-- holds in `user_team_positions`. A privileged system identity (CEO,
-- E-SET SITE_MANAGER) has NO Team and NO Position, so it has no row here
-- at all - and therefore needs no company.
--
-- That is why `company_id` is NOT NULL rather than nullable:
--
--   normal employee  -> exactly one company (one profile row, one
--                       non-null company FK - not zero, not many)
--   CEO / SITE_MANAGER -> no profile row, hence no company, no Team and
--                       no Position, WITHOUT any nullable column that a
--                       normal employee could also slip through.
--
-- A nullable `company_id` would have weakened the employee invariant to
-- protect an identity class that is not stored in this table in the
-- first place. Privileged display-name storage is deliberately NOT
-- introduced here (see DECISIONS.md - it is the next task, together
-- with privileged permit application).

DO $$
DECLARE
  existing_profile_count BIGINT;
BEGIN
  SELECT count(*) INTO existing_profile_count FROM public.workforce_profiles;
  IF existing_profile_count <> 0 THEN
    RAISE EXCEPTION
      '0018 refused: % workforce profile(s) have no authoritative company mapping; company membership must be resolved before migration',
      existing_profile_count;
  END IF;
END;
$$;

-- =====================================================================
-- 1. Authoritative company reference data
-- =====================================================================
--
-- Backend-only, exactly like every other application table in this
-- schema: RLS enabled, no policy, and no anon/authenticated grant, so
-- the browser can never read or write it directly. The runtime role
-- receives SELECT only (see DEPLOYMENT.md) - there is no API, migration
-- hook, or provisioning path that can create a company, so a company can
-- never be minted by an employee-provisioning request.
CREATE TABLE public.companies (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT companies_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT companies_name_not_blank CHECK (btrim(name) <> '')
);

CREATE FUNCTION public.companies_authoritative_created_at() RETURNS TRIGGER
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
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.companies_authoritative_created_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER companies_authoritative_created_at_trigger
  BEFORE INSERT OR UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_authoritative_created_at();

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.companies FROM PUBLIC, anon, authenticated;

-- Exactly the three confirmed companies, with deterministic identifiers
-- so every environment agrees. `E_SET` is the company CODE; `E-SET` is
-- its display name.
INSERT INTO public.companies (id, code, name) VALUES
  ('18000000-0000-4000-8000-000000000001', 'E_SET', 'E-SET'),
  ('18000000-0000-4000-8000-000000000002', 'ZPL', 'ZPL'),
  ('18000000-0000-4000-8000-000000000003', 'SGRE', 'SGRE');

-- =====================================================================
-- 2. Exactly one company per employee profile
-- =====================================================================
--
-- `workforce_profiles` is keyed by `user_id`, so one row per user plus
-- one NOT NULL foreign key IS "exactly one company" - structurally, not
-- by convention. There is no join table, so multiple company membership
-- is not merely rejected by the API, it is unrepresentable.
ALTER TABLE public.workforce_profiles
  ADD COLUMN company_id UUID NOT NULL,
  ADD CONSTRAINT workforce_profiles_company_fk
    FOREIGN KEY (company_id) REFERENCES public.companies (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Supports the ON DELETE/UPDATE RESTRICT checks on the referencing side,
-- for the same reason migration 0016 indexes `primary_team_position_id`
-- (PostgreSQL creates no index there by default).
CREATE INDEX workforce_profiles_company_idx
  ON public.workforce_profiles (company_id);

-- =====================================================================
-- 3. A privileged system identity is never an organizational employee
-- =====================================================================
--
-- CEO and E-SET SITE_MANAGER are privileged SYSTEM accounts, not normal
-- organizational employees: no Company, no Team, no Position. The
-- authoritative source for "is this user privileged?" is the append-only
-- `privileged_access_events` log (migration 0004) - never a role label,
-- an email pattern, a Position NAME, or `user_metadata`.
--
-- Enforced in the database, not only in application code, so that no
-- provisioning path, operator script, or future endpoint can give a
-- privileged identity a fabricated E-SET company membership, an Admin
-- team, or a "Site Manager" position merely to satisfy this table's NOT
-- NULL columns.
--
-- Note the direction: this guards the profile side. Whether an existing
-- employee may be PROMOTED to a privileged role (which would require
-- retiring their organizational profile first) is a governance decision
-- for the privileged grant/revoke service, which does not exist yet
-- (see migration 0004's notes) - so no rule is invented for it here.
CREATE FUNCTION public.workforce_profiles_reject_privileged_identity() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT DISTINCT ON (role) role, action
          FROM public.privileged_access_events
         WHERE user_id = NEW.user_id
         ORDER BY role, ordinal DESC
      ) latest
     WHERE latest.action = 'GRANTED'
  ) THEN
    RAISE EXCEPTION
      'user % holds privileged system access (CEO/SITE_MANAGER) and must not be given an organizational company, team or position profile',
      NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workforce_profiles_reject_privileged_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workforce_profiles_reject_privileged_identity_trigger
  BEFORE INSERT OR UPDATE ON public.workforce_profiles
  FOR EACH ROW EXECUTE FUNCTION public.workforce_profiles_reject_privileged_identity();

-- No browser policy/grant and no SECURITY DEFINER function is introduced
-- anywhere in this migration. The only new runtime-role privilege it
-- requires is SELECT on public.companies (DEPLOYMENT.md); the guard
-- above reads `privileged_access_events`, on which the runtime role
-- already holds SELECT.
