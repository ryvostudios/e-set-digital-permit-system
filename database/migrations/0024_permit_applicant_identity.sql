-- Server-derived, permanently frozen permit applicant identity.
--
-- This migration does not edit any preceding migration. Everything here
-- is additive to the schema produced by 0001-0023.
--
-- THE PROBLEM. `permits.company` (migration 0006) is a CLIENT-SUPPLIED
-- form field - the applicant picks `ESET` / `SGRE` / `ZPL` / `OTHER`
-- themselves - and the applicant's NAME appears nowhere on the permit
-- row at all; it is reachable only by joining the live
-- `workforce_profiles` row of `created_by`. Both are wrong for the
-- confirmed model: a client must not be able to state which company it
-- applied on behalf of, and a permit issued last year must keep showing
-- the name and company the applicant had AT THE TIME, not whatever their
-- profile says today.
--
-- THE DESIGN. Three frozen columns, written ONCE by the server at the
-- immutable boundary (submission, the same act that produces the
-- applicant signature) and never rewritten afterwards - enforced by
-- trigger, not by convention. They are derived from authoritative state:
--
--   normal employee    -> workforce_profiles.display_name
--                         + the company behind their CURRENT assignment
--   CEO / SITE_MANAGER -> privileged_identities.display_name
--                         + E_SET, derived server-side
--
-- The client supplies none of it and cannot influence any of it.
--
-- WHY NOT REUSE `permits.company`. That column keeps a different
-- vocabulary (`ESET`, and an `OTHER` free-text escape hatch) and already
-- carries historical values written under the old client-supplied rules.
-- Rewriting it would mutate history. It is therefore left exactly as it
-- is, and the authoritative applicant company is the new
-- `applicant_company_code`, which uses the real company CODE from
-- migration 0018 (`E_SET` / `ZPL` / `SGRE`) and has no `OTHER`.
--
-- NULLABLE BY NECESSITY, NOT BY CHOICE. A DRAFT has no applicant
-- identity yet, and every permit that already exists was created before
-- this migration. A partial CHECK below therefore requires the identity
-- to be COMPLETE once any part of it is present, so a half-frozen
-- identity is unrepresentable.

ALTER TABLE public.permits
  -- The applicant's authoritative personal name, frozen at submission.
  -- For a privileged applicant this is their personal name and NOTHING
  -- else: no "CEO", no "Site Manager", no company is ever appended here,
  -- because this column is what the paper form's applicant line renders.
  ADD COLUMN applicant_display_name TEXT,
  -- The company CODE from migration 0018, never a client label.
  ADD COLUMN applicant_company_code TEXT,
  -- The company's display name at the time, frozen so a later rename of
  -- the company itself cannot alter an issued document either.
  ADD COLUMN applicant_company_name TEXT,
  -- Each NOT NULL test is explicit rather than implied. A CHECK that
  -- relied on `applicant_company_code IN (...)` alone would silently
  -- ACCEPT a half-written identity: with the column NULL that predicate
  -- evaluates to NULL, and a CHECK only rejects on FALSE. Spelling out
  -- IS NOT NULL first makes the branch evaluate to FALSE instead, which
  -- is what actually makes a partial identity unrepresentable.
  ADD CONSTRAINT permits_applicant_identity_complete CHECK (
    (applicant_display_name IS NULL AND applicant_company_code IS NULL AND applicant_company_name IS NULL)
    OR (
      applicant_display_name IS NOT NULL AND btrim(applicant_display_name) <> ''
      AND applicant_company_code IS NOT NULL AND applicant_company_code IN ('E_SET', 'ZPL', 'SGRE')
      AND applicant_company_name IS NOT NULL AND btrim(applicant_company_name) <> ''
    )
  );

-- The applicant identity is frozen: once written it is immutable, for
-- every role including the table owner. This is the same guarantee the
-- issued snapshot already has, applied one level earlier so that the
-- value the snapshot copies cannot drift between submission and
-- issuance either.
--
-- Clearing it back to NULL is refused as well - "unfreeze then rewrite"
-- would otherwise be a two-step bypass of exactly this rule.
CREATE FUNCTION public.permits_freeze_applicant_identity() RETURNS TRIGGER
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
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.permits_freeze_applicant_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER permits_freeze_applicant_identity_trigger
  BEFORE UPDATE ON public.permits
  FOR EACH ROW EXECUTE FUNCTION public.permits_freeze_applicant_identity();

-- Supports "every permit applied for on behalf of company X", which the
-- view-all and records screens filter on.
CREATE INDEX permits_applicant_company_idx ON public.permits (applicant_company_code);

-- No new table, policy, browser grant, or SECURITY DEFINER function is
-- introduced. `app_runtime` already holds SELECT/INSERT/UPDATE on
-- `permits`, so this migration requires NO privilege change.
