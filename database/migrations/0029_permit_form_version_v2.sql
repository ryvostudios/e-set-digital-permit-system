-- Accept the authoritative V2 form contract alongside the live V1 one.
--
-- Migrations 0001-0028 are immutable applied history and are not edited
-- by this file.
--
-- WHY. Migration 0016 pinned the permitted form versions as literals:
-- `permits_form_version_matches_type` allows exactly WTG_WORK_V1 /
-- COLD_WORK_V1 / HOT_WORK_V1 / CONFINED_SPACE_ENTRY_V1, and
-- `jsas_form_payload_consistent` allows exactly JSA_V1. The authoritative
-- fixed-question contract added in the previous change
-- (domain/permits/formsV2.ts) therefore cannot be STORED, only validated.
-- This migration widens those two CHECKs - and nothing else - so both
-- generations are storable while the frontend is migrated.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It creates no table, function,
-- sequence, policy or index; it grants nothing and revokes nothing; it
-- rewrites no row. There is no new ACL surface for service_role, PUBLIC,
-- app_runtime or privileged_runtime to be audited against, and the RLS
-- posture is untouched. Existing V1 rows are not migrated, converted or
-- reformatted - `ALTER TABLE ... ADD CONSTRAINT` re-validates every
-- existing row as it installs, so if a single stored V1 permit or JSA no
-- longer satisfied the widened rule this migration would fail rather
-- than silently accept it.
--
-- WHAT REMAINS REJECTED. Widening is per type, never across types: a
-- WTG_WORK permit may carry WTG_WORK_V1 or WTG_WORK_V2 and nothing else.
-- A cross-version combination such as (WTG_WORK, COLD_WORK_V2) is still
-- impossible, exactly as it was before.

-- =====================================================================
-- 1. Preconditions
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permits_form_version_matches_type') THEN
    RAISE EXCEPTION '0029 precondition failed: permits_form_version_matches_type is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jsas_form_payload_consistent') THEN
    RAISE EXCEPTION '0029 precondition failed: jsas_form_payload_consistent is missing';
  END IF;
END;
$$;

-- =====================================================================
-- 2. permits: allow each type's V1 OR V2 version, and only its own
-- =====================================================================
-- NULL-safe in exactly the same way as 0016's original: a CHECK that
-- evaluates to NULL is SATISFIED in PostgreSQL, so the IS NOT NULL guards
-- are what keep "a version without a type" (and the reverse) genuinely
-- impossible rather than quietly allowed by three-valued logic.
ALTER TABLE permits DROP CONSTRAINT permits_form_version_matches_type;
ALTER TABLE permits ADD CONSTRAINT permits_form_version_matches_type CHECK (
  (permit_type IS NULL AND form_version IS NULL)
  OR (
    permit_type IS NOT NULL AND form_version IS NOT NULL
    AND (
      (permit_type = 'WTG_WORK' AND form_version IN ('WTG_WORK_V1', 'WTG_WORK_V2'))
      OR (permit_type = 'COLD_WORK' AND form_version IN ('COLD_WORK_V1', 'COLD_WORK_V2'))
      OR (permit_type = 'HOT_WORK' AND form_version IN ('HOT_WORK_V1', 'HOT_WORK_V2'))
      OR (permit_type = 'CONFINED_SPACE_ENTRY'
          AND form_version IN ('CONFINED_SPACE_ENTRY_V1', 'CONFINED_SPACE_ENTRY_V2'))
    )
  )
);

-- =====================================================================
-- 3. jsas: allow JSA_V1 or JSA_V2
-- =====================================================================
ALTER TABLE jsas DROP CONSTRAINT jsas_form_payload_consistent;
ALTER TABLE jsas ADD CONSTRAINT jsas_form_payload_consistent CHECK (
  (form_version IS NULL AND form_payload IS NULL)
  OR (
    form_version IS NOT NULL AND form_version IN ('JSA_V1', 'JSA_V2')
    AND form_payload IS NOT NULL AND jsonb_typeof(form_payload) = 'object'
  )
);

-- =====================================================================
-- 4. Verify the result rather than assuming it
-- =====================================================================
DO $$
DECLARE
  permits_def TEXT;
  jsas_def TEXT;
  expected TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO permits_def
    FROM pg_constraint WHERE conname = 'permits_form_version_matches_type';
  SELECT pg_get_constraintdef(oid) INTO jsas_def
    FROM pg_constraint WHERE conname = 'jsas_form_payload_consistent';

  -- BOTH generations must be storable: V1 so existing rows and drafts
  -- keep working, V2 so the authoritative contract can be written.
  FOREACH expected IN ARRAY ARRAY[
    'WTG_WORK_V1', 'WTG_WORK_V2',
    'COLD_WORK_V1', 'COLD_WORK_V2',
    'HOT_WORK_V1', 'HOT_WORK_V2',
    'CONFINED_SPACE_ENTRY_V1', 'CONFINED_SPACE_ENTRY_V2'
  ] LOOP
    IF position(expected IN permits_def) = 0 THEN
      RAISE EXCEPTION '0029 failed: permits form-version rule does not admit %', expected;
    END IF;
  END LOOP;

  IF position('JSA_V1' IN jsas_def) = 0 OR position('JSA_V2' IN jsas_def) = 0 THEN
    RAISE EXCEPTION '0029 failed: the JSA form-version rule must admit both JSA_V1 and JSA_V2';
  END IF;

  -- The permit type must still bind its own versions. If the rule had
  -- been widened into a flat "any known version" list, a WTG_WORK permit
  -- could carry COLD_WORK_V2 - so assert each type is still named
  -- alongside its versions.
  FOREACH expected IN ARRAY ARRAY['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] LOOP
    IF position(expected IN permits_def) = 0 THEN
      RAISE EXCEPTION '0029 failed: permit type % is no longer bound to its own versions', expected;
    END IF;
  END LOOP;

  -- Nothing here may have touched stored content.
  IF EXISTS (
    SELECT 1 FROM public.permits
     WHERE form_version IS NOT NULL
       AND form_version NOT IN (
         'WTG_WORK_V1', 'WTG_WORK_V2', 'COLD_WORK_V1', 'COLD_WORK_V2',
         'HOT_WORK_V1', 'HOT_WORK_V2', 'CONFINED_SPACE_ENTRY_V1', 'CONFINED_SPACE_ENTRY_V2'
       )
  ) THEN
    RAISE EXCEPTION '0029 failed: a stored permit carries an unrecognised form version';
  END IF;
END;
$$;
