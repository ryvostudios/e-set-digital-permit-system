-- The confirmed launch organization: teams, positions, the Team +
-- Position combinations, their provisioning approval flag, and the
-- initial capability mapping.
--
-- Migrations 0001-0019 are immutable applied history and are not edited
-- by this file. This migration inserts REFERENCE/ORGANIZATION data only.
-- It creates no employee, no workforce profile, no assignment, no
-- privileged identity, and no privileged grant - people are provisioned
-- through the account endpoints, never by a migration.
--
-- WHY THIS IS A MIGRATION AND NOT AN API. The organization structure is
-- operator-owned: no runtime endpoint may invent a team, a position, a
-- Team + Position combination, or a capability mapping, because those
-- are exactly the objects that decide who can approve a permit. Employee
-- provisioning may only place a person INTO an already-approved
-- combination.

-- =====================================================================
-- 0. Precondition
-- =====================================================================
--
-- Refuse to run if any organization data already exists, rather than
-- merging into an unknown structure and silently producing duplicate or
-- conflicting capability mappings.
DO $$
DECLARE
  existing BIGINT;
BEGIN
  SELECT count(*) INTO existing FROM public.teams;
  IF existing <> 0 THEN
    RAISE EXCEPTION '0020 refused: % team(s) already exist; the launch organization must be seeded into an empty structure', existing;
  END IF;
  SELECT count(*) INTO existing FROM public.positions;
  IF existing <> 0 THEN
    RAISE EXCEPTION '0020 refused: % position(s) already exist; the launch organization must be seeded into an empty structure', existing;
  END IF;
  SELECT count(*) INTO existing FROM public.team_position_capabilities;
  IF existing <> 0 THEN
    RAISE EXCEPTION '0020 refused: % capability mapping(s) already exist', existing;
  END IF;
END;
$$;

-- =====================================================================
-- 1. Teams, each owned by exactly one company (migration 0019)
-- =====================================================================
--
-- E-SET runs the site and owns the five operational teams. ZPL and SGRE
-- each have a single organizational team. Team names are unique PER
-- COMPANY, so E-SET's "HSE" team and ZPL's "HSE" POSITION are unrelated
-- objects that can never be confused.
INSERT INTO public.teams (name, company_id)
SELECT team_name, c.id
  FROM (VALUES ('Admin'), ('Civil'), ('WTG'), ('E-BOP'), ('HSE')) AS t (team_name)
  CROSS JOIN public.companies c
 WHERE c.code = 'E_SET';

INSERT INTO public.teams (name, company_id)
SELECT 'ZPL', id FROM public.companies WHERE code = 'ZPL';

INSERT INTO public.teams (name, company_id)
SELECT 'SGRE', id FROM public.companies WHERE code = 'SGRE';

-- =====================================================================
-- 2. Positions
-- =====================================================================
--
-- `positions.name` is globally unique (migration 0002), so a position is
-- a NAME reused across teams, and it is the TEAM + POSITION pair that
-- carries meaning and capabilities. "Team Lead" below is one row shared
-- by Civil, WTG, E-BOP, HSE and SGRE; "Technician" is shared by WTG and
-- E-BOP.
--
-- "Site Manager" here is ZPL's ordinary organizational job title. It is
-- NOT, and can never become, the privileged E-SET SITE_MANAGER system
-- role: privileged authority is read only from `privileged_access_events`
-- and never from a position name.
INSERT INTO public.positions (name) VALUES
  ('Admin Lead'),
  ('Assistant Admin'),
  ('Team Lead'),
  ('Supervisor'),
  ('Worker'),
  ('Engineer'),
  ('Technician'),
  ('CRO'),
  ('Paramedic'),
  ('Site Manager'),
  ('Asset Manager'),
  ('HSE');

-- =====================================================================
-- 3. Team + Position combinations
-- =====================================================================
INSERT INTO public.team_positions (team_id, position_id)
SELECT t.id, p.id
  FROM (VALUES
    ('E_SET', 'Admin',  'Admin Lead'),
    ('E_SET', 'Admin',  'Assistant Admin'),
    ('E_SET', 'Civil',  'Team Lead'),
    ('E_SET', 'Civil',  'Supervisor'),
    ('E_SET', 'Civil',  'Worker'),
    ('E_SET', 'WTG',    'Team Lead'),
    ('E_SET', 'WTG',    'Engineer'),
    ('E_SET', 'WTG',    'Technician'),
    ('E_SET', 'E-BOP',  'Team Lead'),
    ('E_SET', 'E-BOP',  'CRO'),
    ('E_SET', 'E-BOP',  'Technician'),
    ('E_SET', 'HSE',    'Team Lead'),
    ('E_SET', 'HSE',    'Paramedic'),
    ('ZPL',   'ZPL',    'Site Manager'),
    ('ZPL',   'ZPL',    'Asset Manager'),
    ('ZPL',   'ZPL',    'Engineer'),
    ('ZPL',   'ZPL',    'HSE'),
    ('SGRE',  'SGRE',   'Team Lead')
  ) AS spec (company_code, team_name, position_name)
  JOIN public.companies c ON c.code = spec.company_code
  JOIN public.teams t ON t.company_id = c.id AND t.name = spec.team_name
  JOIN public.positions p ON p.name = spec.position_name;

-- =====================================================================
-- 4. Provisioning approval
-- =====================================================================
--
-- Migration 0017 defaults every Team + Position to NOT assignable and
-- exposes no endpoint that can change the flag. Every combination seeded
-- above is a confirmed NORMAL launch role, so all of them - E-BOP CRO
-- included - are approved here for employee provisioning by CEO or an
-- E-SET Site Manager.
--
-- This flag says only "a manager may place an employee here". It grants
-- nothing by itself; capabilities are the separate mapping in section 5.
-- No privileged CEO/SITE_MANAGER row is created here: privileged system
-- accounts are not Team + Position rows at all.
UPDATE public.team_positions SET site_manager_assignable = TRUE;

-- =====================================================================
-- 5. Initial capability mapping
-- =====================================================================
--
-- Only capability NAMES already seeded by migrations 0005, 0009 and 0017
-- are used; this migration invents no capability.
--
-- 5a. PERMIT APPLICATION - every normal launch Team + Position EXCEPT
--     E-SET E-BOP CRO. The confirmed business rule is that CRO reviews
--     permits and does not apply for them, so CRO is excluded here
--     rather than being given and then denied the ability elsewhere.
--     Applicants from all three companies are included: E-SET, ZPL
--     (Site Manager, Asset Manager, Engineer, HSE) and SGRE (Team Lead).
INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
SELECT tp.id, cap.id
  FROM public.team_positions tp
  JOIN public.teams t ON t.id = tp.team_id
  JOIN public.positions p ON p.id = tp.position_id
  JOIN public.companies c ON c.id = t.company_id
  CROSS JOIN public.capabilities cap
 WHERE cap.name IN ('permit.create', 'permit.submit')
   AND NOT (c.code = 'E_SET' AND t.name = 'E-BOP' AND p.name = 'CRO');

-- 5b. CRO WORKFLOW AUTHORITY - ONLY E-SET E-BOP CRO. This single
--     combination carries CRO review, the CRO send-back, forwarding to
--     HSE, fallback approval after the HSE window expires, and the
--     CRO-only operational actions (hold, resume, cancel, close, renew).
--     No other position, and no other company, receives any of them.
INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
SELECT tp.id, cap.id
  FROM public.team_positions tp
  JOIN public.teams t ON t.id = tp.team_id
  JOIN public.positions p ON p.id = tp.position_id
  JOIN public.companies c ON c.id = t.company_id
  CROSS JOIN public.capabilities cap
 WHERE c.code = 'E_SET' AND t.name = 'E-BOP' AND p.name = 'CRO'
   AND cap.name IN (
     'permit.cro_review',
     'permit.send_back',
     'permit.forward_hse',
     'permit.fallback_approve',
     'permit.hold',
     'permit.resume',
     'permit.cancel',
     'permit.close',
     'permit.renew'
   );

-- 5c. HSE APPROVAL AUTHORITY - ONLY E-SET HSE Team Lead and E-SET HSE
--     Paramedic. `permit.hse_review` gates both the HSE approval and the
--     HSE send-back during HSE review. ZPL's "HSE" position is a
--     different company's team and receives nothing here, so ZPL HSE has
--     zero permit approval authority. SGRE receives no approval
--     authority at all.
INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
SELECT tp.id, cap.id
  FROM public.team_positions tp
  JOIN public.teams t ON t.id = tp.team_id
  JOIN public.positions p ON p.id = tp.position_id
  JOIN public.companies c ON c.id = t.company_id
  CROSS JOIN public.capabilities cap
 WHERE c.code = 'E_SET' AND t.name = 'HSE' AND p.name IN ('Team Lead', 'Paramedic')
   AND cap.name = 'permit.hse_review';

-- NOT mapped here, deliberately:
--   * `employee.create` / `employee.reset_password` - account management
--     is privileged CEO / E-SET SITE_MANAGER authority only, never a
--     Team + Position capability (see authz/accountManagement.ts).
--   * any individual "view all permits" permission - that is a per-USER
--     grant by design, not an organizational role.

-- =====================================================================
-- 6. Self-verification
-- =====================================================================
--
-- The seed asserts its own shape, so a silently mis-joined INSERT fails
-- the migration instead of producing a subtly wrong authorization model.
DO $$
DECLARE
  actual BIGINT;
BEGIN
  SELECT count(*) INTO actual FROM public.teams;
  IF actual <> 7 THEN RAISE EXCEPTION '0020: expected 7 teams, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.positions;
  IF actual <> 12 THEN RAISE EXCEPTION '0020: expected 12 positions, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.team_positions;
  IF actual <> 18 THEN RAISE EXCEPTION '0020: expected 18 team positions, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.team_positions WHERE NOT site_manager_assignable;
  IF actual <> 0 THEN RAISE EXCEPTION '0020: % team position(s) are not assignable', actual; END IF;

  -- Exactly one combination may act as CRO, and it is E-SET E-BOP CRO.
  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name = 'permit.cro_review';
  IF actual <> 1 THEN RAISE EXCEPTION '0020: expected exactly 1 CRO review holder, found %', actual; END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
    JOIN public.team_positions tp ON tp.id = tpc.team_position_id
    JOIN public.teams t ON t.id = tp.team_id
    JOIN public.positions p ON p.id = tp.position_id
    JOIN public.companies c ON c.id = t.company_id
   WHERE cap.name = 'permit.cro_review'
     AND c.code = 'E_SET' AND t.name = 'E-BOP' AND p.name = 'CRO';
  IF actual <> 1 THEN RAISE EXCEPTION '0020: CRO review is not held by E-SET E-BOP CRO'; END IF;

  -- Exactly two combinations may approve as HSE, both E-SET HSE.
  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name = 'permit.hse_review';
  IF actual <> 2 THEN RAISE EXCEPTION '0020: expected exactly 2 HSE review holders, found %', actual; END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
    JOIN public.team_positions tp ON tp.id = tpc.team_position_id
    JOIN public.teams t ON t.id = tp.team_id
    JOIN public.companies c ON c.id = t.company_id
   WHERE cap.name = 'permit.hse_review'
     AND NOT (c.code = 'E_SET' AND t.name = 'HSE');
  IF actual <> 0 THEN RAISE EXCEPTION '0020: % non E-SET-HSE holder(s) of HSE review', actual; END IF;

  -- 17 of the 18 combinations may apply for a permit; CRO may not.
  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name = 'permit.create';
  IF actual <> 17 THEN RAISE EXCEPTION '0020: expected 17 permit.create holders, found %', actual; END IF;

  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
    JOIN public.team_positions tp ON tp.id = tpc.team_position_id
    JOIN public.teams t ON t.id = tp.team_id
    JOIN public.positions p ON p.id = tp.position_id
    JOIN public.companies c ON c.id = t.company_id
   WHERE cap.name IN ('permit.create', 'permit.submit')
     AND c.code = 'E_SET' AND t.name = 'E-BOP' AND p.name = 'CRO';
  IF actual <> 0 THEN RAISE EXCEPTION '0020: E-SET E-BOP CRO must not be able to apply for a permit'; END IF;

  -- Account management is never a Team + Position capability.
  SELECT count(*) INTO actual
    FROM public.team_position_capabilities tpc
    JOIN public.capabilities cap ON cap.id = tpc.capability_id
   WHERE cap.name IN ('employee.create', 'employee.reset_password');
  IF actual <> 0 THEN RAISE EXCEPTION '0020: account-management capabilities must not be mapped to any Team + Position'; END IF;
END;
$$;

-- This migration creates no table, function, trigger, policy or grant,
-- and therefore requires NO change to `app_runtime` privileges.
