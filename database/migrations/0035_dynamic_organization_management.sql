-- Runtime organization management: dynamic Companies, Teams and
-- Team + Position associations, with an authoritative permit applicant
-- company.
--
-- Migrations 0001-0034 are immutable applied history and are not edited
-- by this file. Everything here is additive to the schema they produce.
--
-- =====================================================================
-- EXPAND -> DEPLOY -> CONTRACT: THIS IS THE **EXPAND** MIGRATION
-- =====================================================================
--
-- It is deliberately compatible with BOTH the currently deployed
-- backend and the new one, so it can be applied first, with no outage:
--
--   1. APPLY THIS MIGRATION. The running backend keeps submitting and
--      renewing permits, because section 5's completeness rule does not
--      yet require the column that backend does not write.
--   2. DEPLOY the backend that populates `applicant_company_id`.
--   3. LIVE-VERIFY submit / renew / read / organization directory.
--   4. CONTRACT, in a LATER migration: backfill anything the old
--      backend wrote during the overlap, prove nothing is left, and
--      only then make `applicant_company_id` mandatory.
--
-- The reverse order is NOT supported: the new backend selects
-- `applicant_company_id` in every permit list query and reads
-- `deactivated_at` in the organization directory, so it requires this
-- migration to be applied first.
--
-- THE CONTRACT MIGRATION IS NOT IN THE REPOSITORY YET, ON PURPOSE.
-- `npm run migrate` applies EVERY pending file in one batch and cannot
-- target a single migration (see backend/src/db/migrate.ts), so a 0036
-- sitting in this directory would be applied in the same run as this
-- file and would close the compatibility window immediately.
--
-- =====================================================================
-- WHAT THIS SUPERSEDES, DELIBERATELY
-- =====================================================================
--
-- Migration 0020 states that the organization structure is
-- operator-owned and that "no runtime endpoint may invent a team, a
-- position, a Team + Position combination, or a capability mapping",
-- and DECISIONS.md records the launch structure as seeded "by migration
-- 0020 and by nothing else". That decision is INTENTIONALLY SUPERSEDED
-- here by a confirmed product requirement: the CEO and an authorized
-- E-SET System Site Manager must be able to manage Companies, Teams and
-- Team + Position associations at runtime, for the seeded companies as
-- well as for new ones.
--
-- The part of 0020's reasoning that still holds is kept structurally:
-- those objects "are exactly the objects that decide who can approve a
-- permit". So runtime management is allowed to create organization
-- STRUCTURE, and is allowed to grant exactly one thing - the standard
-- applicant baseline - through one bounded SECURITY DEFINER function
-- whose capability names are literals. It can never reach
-- `permit.cro_review`, `permit.hse_review`, the CRO-only operational
-- actions, or any account-management capability, and it can never reach
-- `privileged_access_events` at all.
--
-- THE CONFIRMED BASELINE POLICY, STATED IN FULL:
--
--   Runtime organization management may automatically grant only the
--   standard applicant capabilities `permit.create` and `permit.submit`
--   to a newly created Team + Position association. It never grants
--   privileged workflow or administrative authority. Privileged
--   authority remains explicitly controlled by the existing
--   authoritative capability/access model.
--
-- A NAME IS NEVER AUTHORITY. A Position named 'CRO', 'HSE Officer',
-- 'Site Manager' or 'CEO' created through this mechanism receives the
-- two baseline capabilities and nothing else, exactly like a Position
-- named 'Electrician'. Capability resolution
-- (`authz/capabilities.ts`) joins `team_position_capabilities` and
-- never reads a name; privileged status is read only from
-- `privileged_access_events`. Neither is changed by this migration.
--
-- =====================================================================
-- WHAT THIS MIGRATION DOES NOT TOUCH
-- =====================================================================
--
--   * `permits.company` / `permits.company_other` and their CHECK
--     constraints. That column is the CLIENT-SUPPLIED PRINTED FORM
--     FIELD ("Company field includes ESET, SGRE, ZPL, Other; choosing
--     Other allows free-text entry" - 0006), carrying historical values
--     written under the old client-supplied rules. Migration 0024
--     already decided it stays exactly as it is, and converting a form
--     answer into a foreign key would mutate history. Its vocabulary is
--     the form's vocabulary, not an authorization boundary.
--   * `positions` gains NO lifecycle column. `positions.name` is a
--     globally unique shared vocabulary - "Team Lead" is one row used
--     by five E-SET teams and SGRE - so deactivating the row would pull
--     the designation from every company at once. Lifecycle belongs to
--     companies, teams and team_positions.
--   * every seeded row: the 3 companies (and their codes), 7 teams, 12
--     positions, 18 associations and every capability mapping are
--     unchanged, and section 6 asserts that.
--   * `authz/capabilities.ts`'s resolution query, `privileged_access_events`,
--     and every permit workflow rule.

-- =====================================================================
-- 0. Preconditions
-- =====================================================================
--
-- Refuse to run against a database whose organization baseline is not
-- what this migration assumes, rather than building runtime management
-- on top of an unknown structure.
DO $$
DECLARE
  baseline BIGINT;
  seeded BIGINT;
BEGIN
  SELECT count(*) INTO baseline FROM public.capabilities
   WHERE name IN ('permit.create', 'permit.submit');
  IF baseline <> 2 THEN
    RAISE EXCEPTION
      '0035 refused: expected both baseline applicant capabilities to exist, found %', baseline;
  END IF;

  SELECT count(*) INTO seeded FROM public.companies WHERE code IN ('E_SET', 'ZPL', 'SGRE');
  IF seeded <> 3 THEN
    RAISE EXCEPTION '0035 refused: expected the 3 seeded companies, found %', seeded;
  END IF;

  -- A frozen applicant identity that cannot be resolved to a company row
  -- would be silently dropped by section 5's backfill. Refuse instead.
  IF EXISTS (
    SELECT 1 FROM public.permits p
     WHERE p.applicant_company_code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.code = p.applicant_company_code)
  ) THEN
    RAISE EXCEPTION
      '0035 refused: one or more permits carry a frozen applicant company code with no companies row';
  END IF;
END;
$$;

-- =====================================================================
-- 1. Organization lifecycle and identity integrity
-- =====================================================================
--
-- Deactivation is the ONLY removal. There is no hard delete anywhere in
-- this design: every foreign key into organization data is already
-- ON DELETE RESTRICT, and employees, permits, audit rows and capability
-- history must survive an organizational change untouched.
ALTER TABLE public.companies      ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE public.teams          ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE public.team_positions ADD COLUMN deactivated_at TIMESTAMPTZ;

-- Duplicate prevention that a concurrent request cannot slip past. The
-- application generates a company code and retries on conflict; these
-- indexes are what make that safe, NOT a read-then-write pre-check.
-- `companies.code` is already UNIQUE (0018) and `teams (company_id, name)`
-- already UNIQUE (0019); these add case/whitespace-insensitive names.
CREATE UNIQUE INDEX companies_name_normalized_unique
  ON public.companies (lower(btrim(name)));
CREATE UNIQUE INDEX teams_company_name_normalized_unique
  ON public.teams (company_id, lower(btrim(name)));
CREATE UNIQUE INDEX positions_name_normalized_unique
  ON public.positions (lower(btrim(name)));

-- A generated code is machine-readable and never client-chosen. The
-- format is asserted in the database so no application path can store a
-- lowercase, punctuated, or decorated code. The three seeded codes
-- (E_SET, ZPL, SGRE) already satisfy it.
ALTER TABLE public.companies
  ADD CONSTRAINT companies_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]*$');

-- A company's identity is immutable after creation. The display NAME may
-- be corrected; `id` and `code` may not, because permits, audit rows and
-- employee profiles reference them and a rewritten code would silently
-- re-point history. Enforced in the database so no endpoint, script or
-- future migration path can rename an identity by accident.
CREATE FUNCTION public.companies_freeze_identity() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'company id is immutable (company %)', OLD.id;
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'company code is immutable (company %, code %)', OLD.id, OLD.code;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.companies_freeze_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER companies_freeze_identity_trigger
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_freeze_identity();

-- =====================================================================
-- 2. Deactivation guards
-- =====================================================================
--
-- Deactivation NEVER cascades: deactivating a company does not write
-- `deactivated_at` on its teams, and deactivating a team does not write
-- it on its associations. What an inactive ancestor does instead is make
-- its descendants unusable for NEW work, which sections 2b/2c enforce by
-- reading the whole chain rather than by mutating rows.

-- ---------------------------------------------------------------------
-- 2a. REQUIRED coverage: an organization action may not drop a
--     capability with a mandatory operational minimum below it.
-- ---------------------------------------------------------------------
--
-- THIS IS NOT A GLOBAL "EVERY CAPABILITY NEEDS A HOLDER" RULE, and must
-- not become one. Most capabilities are optional: one may legitimately
-- have zero active holders, and organization lifecycle operations must
-- not be permanently blocked because an optional capability is no longer
-- assigned anywhere. Only the capabilities listed below are protected.
--
-- WHERE THE LIST COMES FROM. The permit workflow FAILS CLOSED at exactly
-- two points, in `domain/permits/workflowSideEffects.ts`:
--
--   onPermitSubmittedOrResubmitted / onHseSentBackToCro
--     -> resolveCroRecipients(), and `recipients.length === 0` throws
--        ResponsibilityRecipientUnavailableError('CRO')
--   onForwardedToHse
--     -> resolveHseRecipients(), and `recipients.length === 0` throws
--        ResponsibilityRecipientUnavailableError('HSE')
--
-- With no CRO the applicant cannot submit at all; with no HSE the CRO
-- cannot forward. Those are the only two capability coverages the
-- running system requires, so those are the only two guarded here.
-- `permit.create` / `permit.submit` are deliberately NOT included: they
-- are the ordinary applicant baseline, held by most associations, and
-- nothing fails closed on their absence.
--
-- WHERE THE MINIMUM COMES FROM. Those same checks test `length === 0` -
-- AT LEAST ONE - never a specific number. Migration 0020's
-- self-verification asserts exactly 1 `permit.cro_review` holder and
-- exactly 2 `permit.hse_review` holders, but that block's stated purpose
-- is that "the seed asserts its own SHAPE, so a silently mis-joined
-- INSERT fails the migration"; it runs once, at migration time, and
-- nothing re-checks a count at runtime. Those counts are therefore
-- launch-data assertions, NOT permanent required counts, and the runtime
-- minimum below is 1. Section 6 still re-asserts 1 and 2 for the same
-- shape-checking reason, against data this migration must not change.
--
-- The minimum is a column rather than an implied 1 so that a future
-- change to a requirement is an explicit edit to this list, not a new
-- mechanism.
--
-- "Active" means the whole chain is active: the association, its team,
-- and the team's company. That is what makes deactivating the E-SET HSE
-- TEAM refuse for the same reason deactivating its Paramedic association
-- would.
--
-- Returns the name of the first REQUIRED capability whose coverage this
-- change would newly break or further worsen, or NULL when the change is
-- safe. See the HAVING clause for the exact rule.
CREATE FUNCTION public.organization_required_coverage_gap(
  p_company_id UUID,
  p_team_id UUID,
  p_team_position_id UUID
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT required.name
    FROM (VALUES
      ('permit.cro_review', 1),
      ('permit.hse_review', 1)
    ) AS required (name, minimum)
    JOIN public.capabilities cap ON cap.name = required.name
    JOIN public.team_position_capabilities tpc ON tpc.capability_id = cap.id
    JOIN public.team_positions tp ON tp.id = tpc.team_position_id
    JOIN public.teams t ON t.id = tp.team_id
    JOIN public.companies c ON c.id = t.company_id
   WHERE tp.deactivated_at IS NULL
     AND t.deactivated_at IS NULL
     AND c.deactivated_at IS NULL
   GROUP BY required.name, required.minimum
  -- `count(*)` is coverage as it stands; the FILTERed count is coverage
  -- as it WOULD stand, excluding whatever this action retires.
  --
  -- A DEGRADED REQUIREMENT MUST NOT FREEZE THE ORGANIZATION. Comparing
  -- the post-action count against the minimum alone would refuse every
  -- deactivation for as long as coverage sat below it - including
  -- actions that have nothing to do with the capability, and including
  -- the very reassignments an administrator needs in order to restore
  -- coverage. So the bar is LEAST(minimum, current): an action is
  -- refused only when it NEWLY breaks the minimum, or REDUCES a count
  -- that is already short. An action that leaves the count untouched is
  -- always allowed, whatever the state.
  --
  --   min 1, now 1, after 0  -> 0 < least(1,1)=1  REFUSED  (newly breaks)
  --   min 1, now 0, after 0  -> 0 < least(1,0)=0  allowed  (unrelated)
  --   min 2, now 1, after 0  -> 0 < least(2,1)=1  REFUSED  (worsens)
  --   min 2, now 1, after 1  -> 1 < least(2,1)=1  allowed  (unrelated)
  --   min 2, now 3, after 1  -> 1 < least(2,3)=2  REFUSED  (newly breaks)
  --
  -- A capability with NO active holder at all produces no group here, so
  -- it is allowed - which is the same answer this predicate gives for
  -- `now 0, after 0`, so the two paths agree.
  HAVING count(*) FILTER (
           WHERE NOT (
             (p_company_id       IS NOT NULL AND c.id  = p_company_id)
             OR (p_team_id          IS NOT NULL AND t.id  = p_team_id)
             OR (p_team_position_id IS NOT NULL AND tp.id = p_team_position_id)
           )
         ) < LEAST(required.minimum, count(*))
   ORDER BY required.name
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.organization_required_coverage_gap(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2b. An organization record may not be deactivated while an ACTIVE
--     employee still depends on it.
-- ---------------------------------------------------------------------
--
-- The administrator must first reassign the employee, or disable the
-- account, before the structure beneath them can be retired. Nothing
-- here deletes or disables an employee to make a deactivation succeed.
CREATE FUNCTION public.companies_guard_deactivation() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM public.workforce_profiles wp
    JOIN public.app_user_access a ON a.user_id = wp.user_id
   WHERE wp.company_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'company % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := public.organization_required_coverage_gap(NEW.id, NULL, NULL);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating company % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.companies_guard_deactivation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER companies_guard_deactivation_trigger
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_guard_deactivation();

CREATE FUNCTION public.teams_guard_deactivation() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM public.workforce_profiles wp
    JOIN public.app_user_access a ON a.user_id = wp.user_id
    JOIN public.team_positions tp ON tp.id = wp.primary_team_position_id
   WHERE tp.team_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'team % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := public.organization_required_coverage_gap(NULL, NEW.id, NULL);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating team % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.teams_guard_deactivation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER teams_guard_deactivation_trigger
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.teams_guard_deactivation();

CREATE FUNCTION public.team_positions_guard_deactivation() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  dependents BIGINT;
  gap TEXT;
BEGIN
  IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO dependents
    FROM public.workforce_profiles wp
    JOIN public.app_user_access a ON a.user_id = wp.user_id
   WHERE wp.primary_team_position_id = NEW.id AND a.state = 'ACTIVE';
  IF dependents <> 0 THEN
    RAISE EXCEPTION
      'team position % still has % active employee(s); reassign or disable them before deactivating it',
      NEW.id, dependents;
  END IF;

  gap := public.organization_required_coverage_gap(NULL, NULL, NEW.id);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION
      'deactivating team position % would leave required capability % below its required coverage', NEW.id, gap;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.team_positions_guard_deactivation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER team_positions_guard_deactivation_trigger
  BEFORE UPDATE ON public.team_positions
  FOR EACH ROW EXECUTE FUNCTION public.team_positions_guard_deactivation();

-- ---------------------------------------------------------------------
-- 2c. An inactive record accepts no NEW structure and no NEW people.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.teams_require_active_company() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = NEW.company_id AND deactivated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'company % is inactive and cannot receive new teams', NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.teams_require_active_company() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER teams_require_active_company_trigger
  BEFORE INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.teams_require_active_company();

CREATE FUNCTION public.team_positions_require_active_team() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.teams t
      JOIN public.companies c ON c.id = t.company_id
     WHERE t.id = NEW.team_id
       AND (t.deactivated_at IS NOT NULL OR c.deactivated_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'team % is inactive, or belongs to an inactive company, and cannot receive new positions',
      NEW.team_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.team_positions_require_active_team() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER team_positions_require_active_team_trigger
  BEFORE INSERT ON public.team_positions
  FOR EACH ROW EXECUTE FUNCTION public.team_positions_require_active_team();

-- An employee may only be placed into a fully active chain. Checked on
-- INSERT always, and on UPDATE only when the placement itself changes -
-- so an unrelated display-name correction on an employee whose company
-- was later retired is never blocked by this rule.
CREATE FUNCTION public.workforce_profiles_require_active_organization() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  inactive TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.primary_team_position_id IS NOT DISTINCT FROM OLD.primary_team_position_id THEN
    RETURN NEW;
  END IF;

  SELECT CASE
           WHEN c.deactivated_at IS NOT NULL THEN 'company'
           WHEN t.deactivated_at IS NOT NULL THEN 'team'
           WHEN tp.deactivated_at IS NOT NULL THEN 'team position'
         END
    INTO inactive
    FROM public.team_positions tp
    JOIN public.teams t ON t.id = tp.team_id
    JOIN public.companies c ON c.id = t.company_id
   WHERE tp.id = NEW.primary_team_position_id;

  IF inactive IS NOT NULL THEN
    RAISE EXCEPTION
      'the % behind team position % is inactive and cannot receive new employee assignments',
      inactive, NEW.primary_team_position_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.companies WHERE id = NEW.company_id AND deactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'company % is inactive and cannot receive new employee assignments', NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workforce_profiles_require_active_organization()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workforce_profiles_require_active_organization_trigger
  BEFORE INSERT OR UPDATE ON public.workforce_profiles
  FOR EACH ROW EXECUTE FUNCTION public.workforce_profiles_require_active_organization();

-- The assignment history table gets the same rule on its own INSERT, so
-- a new CURRENT assignment cannot be opened against a retired
-- association even if it is written without touching the profile row.
-- Closing an assignment (`ended_at`) is never blocked.
CREATE FUNCTION public.user_team_positions_require_active_organization() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.team_positions tp
      JOIN public.teams t ON t.id = tp.team_id
      JOIN public.companies c ON c.id = t.company_id
     WHERE tp.id = NEW.team_position_id
       AND (tp.deactivated_at IS NOT NULL
            OR t.deactivated_at IS NOT NULL
            OR c.deactivated_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'team position % is inactive, or sits under an inactive team or company, and cannot receive new assignments',
      NEW.team_position_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_team_positions_require_active_organization()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_team_positions_require_active_organization_trigger
  BEFORE INSERT ON public.user_team_positions
  FOR EACH ROW EXECUTE FUNCTION public.user_team_positions_require_active_organization();

-- =====================================================================
-- 3. The bounded baseline capability grant
-- =====================================================================
--
-- The ONE way runtime organization management may write
-- `team_position_capabilities`. Modelled directly on 0019's
-- `record_site_manager_grant()` - the schema's other SECURITY DEFINER
-- function - and on the same principle: the values that decide authority
-- are LITERALS IN TRUSTED DATABASE CODE, not parameters. The only
-- argument is which association to equip.
--
-- `app_runtime` receives NO INSERT, UPDATE or DELETE on
-- `team_position_capabilities` (see DEPLOYMENT.md). It cannot widen the
-- grant by passing a different capability, because there is no parameter
-- to pass one through, and it cannot bypass the function, because it has
-- no direct write privilege on the table at all.
--
-- FAILS SAFELY. If either baseline capability is missing - corrupt seed,
-- half-applied environment - the function raises rather than creating a
-- Team + Position that silently carries one capability or none. The
-- caller runs it inside the same transaction as the association INSERT,
-- so the association and its baseline are all-or-nothing.
CREATE FUNCTION public.grant_baseline_applicant_capabilities(p_team_position_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  available BIGINT;
  attached BIGINT;
BEGIN
  IF p_team_position_id IS NULL THEN
    RAISE EXCEPTION 'a team position is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_positions WHERE id = p_team_position_id) THEN
    RAISE EXCEPTION 'team position % does not exist', p_team_position_id;
  END IF;

  SELECT count(*) INTO available
    FROM public.capabilities
   WHERE name IN ('permit.create', 'permit.submit');
  IF available <> 2 THEN
    RAISE EXCEPTION
      'the baseline applicant capabilities are not both defined (found %); refusing to create a partially capable Team + Position',
      available;
  END IF;

  INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
  SELECT p_team_position_id, c.id
    FROM public.capabilities c
   WHERE c.name IN ('permit.create', 'permit.submit')
  ON CONFLICT DO NOTHING;

  -- Prove the postcondition rather than assume it: after this call the
  -- association holds both baseline capabilities, or the transaction
  -- fails.
  SELECT count(*) INTO attached
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities c ON c.id = tpc.capability_id
   WHERE tpc.team_position_id = p_team_position_id
     AND c.name IN ('permit.create', 'permit.submit');
  IF attached <> 2 THEN
    RAISE EXCEPTION
      'team position % did not receive both baseline applicant capabilities (has %)',
      p_team_position_id, attached;
  END IF;
END;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default, and Supabase adds
-- `service_role` on top. Both are removed here; `service_role` is named
-- explicitly because 0021 established that a role-listed REVOKE cannot
-- remove a grant it does not name, and 0027 removed its inherited
-- EXECUTE from every other public function.
REVOKE ALL ON FUNCTION public.grant_baseline_applicant_capabilities(UUID)
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_baseline_applicant_capabilities(UUID) FROM service_role';
  END IF;
END;
$$;

-- EXECUTE is granted to `app_runtime` operator-side, post-migration -
-- see DEPLOYMENT.md. Unlike `record_site_manager_grant()`, this one IS
-- meant for the ordinary runtime login: it grants the applicant
-- baseline, which is not privileged authority.

-- =====================================================================
-- 4. Append-only organization audit
-- =====================================================================
--
-- A SIBLING of `account_audit_events`, not an extension of it.
-- That table requires `target_user_id` NOT NULL REFERENCES auth.users
-- and constrains actor <> target for every manager event; a
-- COMPANY_CREATED event has no target user, and making that column
-- nullable would weaken a constraint that currently makes "a manager
-- reset recorded as if the employee did it themselves" impossible to
-- store. So the same architecture is reused rather than a second
-- logging system invented: append-only through 0004's
-- `forbid_mutation()`, a database-authoritative timestamp, RLS on with
-- no policy, and no browser grant.
--
-- FREE TEXT, DELIBERATELY AND NARROWLY. 0017 gave the account audit no
-- free-text column so a secret was structurally impossible to record.
-- Here `previous_name`/`new_name` are the two exceptions, because for a
-- rename the NAME IS the audited value and no reference row can express
-- it. Every endpoint that writes them handles organization names only -
-- never a password, token or credential - and both are bounded by the
-- same validated API schema that produced them.
CREATE TABLE public.organization_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  event_type TEXT NOT NULL,
  -- The authenticated privileged identity that performed it. Never
  -- client-supplied.
  actor_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  company_id       UUID REFERENCES public.companies (id)      ON DELETE RESTRICT,
  team_id          UUID REFERENCES public.teams (id)          ON DELETE RESTRICT,
  position_id      UUID REFERENCES public.positions (id)      ON DELETE RESTRICT,
  team_position_id UUID REFERENCES public.team_positions (id) ON DELETE RESTRICT,
  previous_name TEXT,
  new_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_audit_events_type_valid CHECK (
    event_type IN (
      'COMPANY_CREATED',
      'COMPANY_RENAMED',
      'COMPANY_DEACTIVATED',
      'COMPANY_REACTIVATED',
      'TEAM_CREATED',
      'TEAM_RENAMED',
      'TEAM_DEACTIVATED',
      'TEAM_REACTIVATED',
      'POSITION_CREATED',
      'TEAM_POSITION_CREATED',
      'TEAM_POSITION_DEACTIVATED',
      'TEAM_POSITION_REACTIVATED',
      'BASELINE_CAPABILITIES_GRANTED'
    )
  ),
  -- Every event names the entity it happened to. A rename additionally
  -- carries both names; nothing else may.
  CONSTRAINT organization_audit_events_subject_present CHECK (
    company_id IS NOT NULL OR team_id IS NOT NULL
    OR position_id IS NOT NULL OR team_position_id IS NOT NULL
  ),
  CONSTRAINT organization_audit_events_names_for_renames CHECK (
    (event_type IN ('COMPANY_RENAMED', 'TEAM_RENAMED')
       AND previous_name IS NOT NULL AND btrim(previous_name) <> ''
       AND new_name IS NOT NULL AND btrim(new_name) <> '')
    OR (event_type NOT IN ('COMPANY_RENAMED', 'TEAM_RENAMED')
       AND previous_name IS NULL AND new_name IS NULL)
  )
);
ALTER TABLE public.organization_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organization_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.organization_audit_events_ordinal_seq FROM PUBLIC, anon, authenticated;

-- DEFAULT now() alone is not authoritative, because an INSERT may supply
-- another value. Force the database clock for every audit row, exactly
-- as `account_audit_events` does.
CREATE FUNCTION public.organization_audit_events_authoritative_timestamp() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.organization_audit_events_authoritative_timestamp()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER organization_audit_events_authoritative_timestamp_trigger
  BEFORE INSERT ON public.organization_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.organization_audit_events_authoritative_timestamp();

CREATE INDEX organization_audit_events_company_idx
  ON public.organization_audit_events (company_id, ordinal DESC);
CREATE INDEX organization_audit_events_actor_idx
  ON public.organization_audit_events (actor_user_id, ordinal DESC);

CREATE TRIGGER organization_audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.organization_audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_audit_events_no_truncate
  BEFORE TRUNCATE ON public.organization_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- =====================================================================
-- 5. Authoritative permit applicant company
-- =====================================================================
--
-- WHICH FIELD IS WHICH. 0024 introduced `applicant_company_code` /
-- `applicant_company_name` as the SERVER-DERIVED, permanently frozen
-- applicant identity, written once at submission and never rewritten -
-- explicitly distinguishing them from `permits.company`, the
-- client-supplied form field. So the authoritative one is the 0024
-- identity, and that is the one this section binds to `companies`.
--
-- `applicant_company_id` becomes the authoritative relationship.
-- `applicant_company_code` and `applicant_company_name` REMAIN, and
-- remain frozen, as the display snapshot the issued document renders -
-- 0024 froze the name precisely "so a later rename of the company itself
-- cannot alter an issued document". Their closed E_SET/ZPL/SGRE list is
-- what goes, not the columns.
ALTER TABLE public.permits
  ADD COLUMN applicant_company_id UUID REFERENCES public.companies (id) ON DELETE RESTRICT;

-- Deterministic backfill: the frozen code resolves 1:1 to a seeded
-- company row, and section 0 already refused to run if any code did not.
-- Existing code/name snapshots are NOT touched - only the new column is
-- filled, so no issued document, hash or PDF changes.
UPDATE public.permits p
   SET applicant_company_id = c.id
  FROM public.companies c
 WHERE p.applicant_company_code IS NOT NULL
   AND c.code = p.applicant_company_code
   AND p.applicant_company_id IS NULL;

DO $$
DECLARE
  unresolved BIGINT;
BEGIN
  SELECT count(*) INTO unresolved
    FROM public.permits
   WHERE applicant_company_code IS NOT NULL AND applicant_company_id IS NULL;
  IF unresolved <> 0 THEN
    RAISE EXCEPTION '0035: % permit(s) have a frozen applicant company that did not resolve', unresolved;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- THIS IS THE **EXPAND** HALF OF AN EXPAND -> DEPLOY -> CONTRACT ROLLOUT.
-- THE RULE BELOW IS TRANSITIONAL AND IS NOT THE FINAL INVARIANT.
-- ---------------------------------------------------------------------
--
-- `applicant_company_id` is added, backfilled and foreign-keyed above,
-- but the completeness rule does NOT yet require it. That is deliberate,
-- and it is the entire reason this migration can be applied BEFORE the
-- backend that writes the column:
--
--   * the CURRENTLY DEPLOYED backend writes `applicant_display_name`,
--     `applicant_company_code` and `applicant_company_name` and knows
--     nothing about `applicant_company_id`. Requiring the column here
--     would make every permit SUBMIT and RENEW fail with 23514 on this
--     constraint for as long as that backend is live - a guaranteed
--     outage window between migration and deploy.
--   * the NEW backend already populates all four. It is satisfied by
--     this rule and by the final one, so it needs no second change.
--
-- So during the overlap a row written by the old backend may carry a
-- complete legacy identity with a NULL `applicant_company_id`. Those
-- rows are exactly what the CONTRACT migration backfills - using the
-- same deterministic resolve-by-code the backfill above already
-- performs - before it tightens this constraint to require the column.
--
-- WHAT IS NOT RELAXED. Every other part of 0024's rule is intact: an
-- identity is still all-NULL or fully present, each field is still
-- explicitly tested for NOT NULL and non-blank (a bare IN (...) on a
-- NULL column evaluates to NULL, and a CHECK only rejects on FALSE), and
-- a half-written identity is still unrepresentable. The freeze trigger
-- still makes every written value permanent. What IS removed is the
-- closed IN ('E_SET','ZPL','SGRE') list, which the foreign key expresses
-- properly once the column is populated - that removal is the point of
-- the change, not a weakening.
--
-- UNTIL THE CONTRACT MIGRATION RUNS, `applicant_company_id` IS
-- BEST-EFFORT, NOT AUTHORITATIVE. Nothing should be built on the
-- assumption that it is always present.
ALTER TABLE public.permits DROP CONSTRAINT permits_applicant_identity_complete;
ALTER TABLE public.permits
  ADD CONSTRAINT permits_applicant_identity_complete CHECK (
    (applicant_display_name IS NULL AND applicant_company_code IS NULL
       AND applicant_company_name IS NULL AND applicant_company_id IS NULL)
    OR (
      applicant_display_name IS NOT NULL AND btrim(applicant_display_name) <> ''
      AND applicant_company_code IS NOT NULL AND btrim(applicant_company_code) <> ''
      AND applicant_company_name IS NOT NULL AND btrim(applicant_company_name) <> ''
    )
  );

-- Extends 0024's freeze to the new column. Every existing check is
-- preserved verbatim; one is added. Replacing the function body (rather
-- than the trigger) follows 0034's precedent for revising an earlier
-- migration's behaviour forward.
CREATE OR REPLACE FUNCTION public.permits_freeze_applicant_identity() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.applicant_display_name IS NOT NULL
     AND NEW.applicant_display_name IS DISTINCT FROM OLD.applicant_display_name THEN
    RAISE EXCEPTION 'the applicant identity of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_code IS NOT NULL
     AND NEW.applicant_company_code IS DISTINCT FROM OLD.applicant_company_code THEN
    RAISE EXCEPTION 'the applicant company of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_name IS NOT NULL
     AND NEW.applicant_company_name IS DISTINCT FROM OLD.applicant_company_name THEN
    RAISE EXCEPTION 'the applicant company name of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_id IS NOT NULL
     AND NEW.applicant_company_id IS DISTINCT FROM OLD.applicant_company_id THEN
    RAISE EXCEPTION 'the applicant company identity of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX permits_applicant_company_id_idx ON public.permits (applicant_company_id);

-- =====================================================================
-- 6. Self-verification
-- =====================================================================
--
-- The migration asserts its own outcome, so a silently wrong result
-- fails the migration instead of producing a subtly different
-- authorization model. Every count below is the launch shape from 0020,
-- re-asserted AFTER this migration's changes.
DO $$
DECLARE
  actual BIGINT;
  gap TEXT;
BEGIN
  SELECT count(*) INTO actual FROM public.companies;
  IF actual <> 3 THEN RAISE EXCEPTION '0035: expected 3 companies, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.companies
   WHERE (code, name) IN (('E_SET', 'E-SET'), ('ZPL', 'ZPL'), ('SGRE', 'SGRE'));
  IF actual <> 3 THEN RAISE EXCEPTION '0035: the seeded company codes or names changed'; END IF;

  SELECT count(*) INTO actual FROM public.teams;
  IF actual <> 7 THEN RAISE EXCEPTION '0035: expected 7 teams, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.positions;
  IF actual <> 12 THEN RAISE EXCEPTION '0035: expected 12 positions, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.team_positions;
  IF actual <> 18 THEN RAISE EXCEPTION '0035: expected 18 team positions, found %', actual; END IF;

  -- Nothing is retired by this migration.
  SELECT count(*) INTO actual FROM public.companies WHERE deactivated_at IS NOT NULL;
  IF actual <> 0 THEN RAISE EXCEPTION '0035: % company/companies were deactivated', actual; END IF;
  SELECT count(*) INTO actual FROM public.teams WHERE deactivated_at IS NOT NULL;
  IF actual <> 0 THEN RAISE EXCEPTION '0035: % team(s) were deactivated', actual; END IF;
  SELECT count(*) INTO actual FROM public.team_positions WHERE deactivated_at IS NOT NULL;
  IF actual <> 0 THEN RAISE EXCEPTION '0035: % team position(s) were deactivated', actual; END IF;

  -- 0020's authorization invariants, unchanged.
  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name = 'permit.cro_review';
  IF actual <> 1 THEN RAISE EXCEPTION '0035: expected exactly 1 CRO review holder, found %', actual; END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name = 'permit.hse_review';
  IF actual <> 2 THEN RAISE EXCEPTION '0035: expected exactly 2 HSE review holders, found %', actual; END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name IN ('employee.create', 'employee.reset_password');
  IF actual <> 0 THEN RAISE EXCEPTION '0035: account-management capabilities must not be mapped to any Team + Position'; END IF;

  -- The required-coverage guard must consider the launch organization
  -- safe as it stands; a NULL argument set names no entity, so nothing
  -- is excluded from the count.
  gap := public.organization_required_coverage_gap(NULL, NULL, NULL);
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION '0035: required capability % is already below its required coverage', gap;
  END IF;

  -- The baseline grant is exactly two capabilities, neither privileged.
  SELECT count(*) INTO actual FROM public.capabilities
   WHERE name IN ('permit.create', 'permit.submit') AND NOT individually_grantable;
  IF actual <> 2 THEN RAISE EXCEPTION '0035: the baseline applicant capabilities are not both attachable to a Team + Position'; END IF;

  -- Every permit that EXISTED BEFORE this migration and carries an
  -- applicant identity now carries its authoritative company too, and
  -- no permit lost one. This asserts the BACKFILL, not an ongoing
  -- invariant: during the deployment overlap the old backend will
  -- write further rows with a NULL `applicant_company_id`, which is
  -- expected and is what the contract migration resolves.
  SELECT count(*) INTO actual FROM public.permits
   WHERE applicant_company_code IS NOT NULL AND applicant_company_id IS NULL;
  IF actual <> 0 THEN RAISE EXCEPTION '0035: % permit(s) have an unresolved applicant company', actual; END IF;
END;
$$;

-- =====================================================================
-- Runtime privileges
-- =====================================================================
--
-- This migration creates objects the runtime role cannot use until the
-- operator applies the privilege delta in DEPLOYMENT.md. The delta is
-- deliberately column-level for UPDATE, matching 0023-0027's pattern on
-- `workforce_profiles`, so the runtime credential cannot rewrite a
-- company's `code` or `id` even if the application tried:
--
--   GRANT INSERT ON TABLE public.companies TO app_runtime;
--   GRANT UPDATE (name, deactivated_at) ON TABLE public.companies TO app_runtime;
--   GRANT INSERT ON TABLE public.teams TO app_runtime;
--   GRANT UPDATE (name, deactivated_at) ON TABLE public.teams TO app_runtime;
--   GRANT INSERT ON TABLE public.positions TO app_runtime;
--   GRANT INSERT ON TABLE public.team_positions TO app_runtime;
--   GRANT UPDATE (deactivated_at) ON TABLE public.team_positions TO app_runtime;
--   GRANT INSERT ON TABLE public.organization_audit_events TO app_runtime;
--   GRANT USAGE ON SEQUENCE public.organization_audit_events_ordinal_seq TO app_runtime;
--   GRANT EXECUTE ON FUNCTION public.grant_baseline_applicant_capabilities(UUID) TO app_runtime;
--
-- `permits` needs nothing: `app_runtime` already holds table-level
-- SELECT/INSERT/UPDATE there (0024), which covers the new column.
--
-- DO NOT grant `app_runtime` INSERT, UPDATE or DELETE on
-- `team_position_capabilities`, UPDATE on `companies.code`/`id`, or
-- DELETE/TRUNCATE on any organization table. The baseline function is
-- the only write path to capability data, and it is bounded by literals.
