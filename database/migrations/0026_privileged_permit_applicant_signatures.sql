-- Layer 3: distinguish frozen normal/privileged applicant identity and
-- allow a privileged applicant signature without fabricating workforce data.
ALTER TABLE public.permits
  ADD COLUMN applicant_identity_kind TEXT,
  DROP CONSTRAINT permits_applicant_identity_complete,
  ADD CONSTRAINT permits_applicant_identity_complete CHECK (
    (applicant_identity_kind IS NULL AND applicant_display_name IS NULL
      AND applicant_company_code IS NULL AND applicant_company_name IS NULL)
    OR (applicant_identity_kind IN ('NORMAL', 'PRIVILEGED')
      AND applicant_display_name IS NOT NULL AND btrim(applicant_display_name) <> ''
      AND applicant_company_code IN ('E_SET', 'ZPL', 'SGRE')
      AND applicant_company_name IS NOT NULL AND btrim(applicant_company_name) <> '')
  );

CREATE OR REPLACE FUNCTION public.permits_freeze_applicant_identity() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.applicant_identity_kind IS NOT NULL AND NEW.applicant_identity_kind IS DISTINCT FROM OLD.applicant_identity_kind THEN
    RAISE EXCEPTION 'the applicant identity kind of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_display_name IS NOT NULL AND NEW.applicant_display_name IS DISTINCT FROM OLD.applicant_display_name THEN
    RAISE EXCEPTION 'the applicant identity of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_code IS NOT NULL AND NEW.applicant_company_code IS DISTINCT FROM OLD.applicant_company_code THEN
    RAISE EXCEPTION 'the applicant company of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  IF OLD.applicant_company_name IS NOT NULL AND NEW.applicant_company_name IS DISTINCT FROM OLD.applicant_company_name THEN
    RAISE EXCEPTION 'the applicant company name of permit % is frozen and cannot be changed', OLD.id;
  END IF;
  RETURN NEW;
END; $$;

ALTER TABLE public.permit_signatures
  ADD COLUMN signer_identity_kind TEXT NOT NULL DEFAULT 'NORMAL',
  ALTER COLUMN signer_team_position_id DROP NOT NULL,
  ALTER COLUMN signer_team_name DROP NOT NULL,
  ALTER COLUMN signer_position_name DROP NOT NULL,
  DROP CONSTRAINT permit_signatures_team_name_not_blank,
  DROP CONSTRAINT permit_signatures_position_name_not_blank,
  ADD CONSTRAINT permit_signatures_identity_shape CHECK (
    (signer_identity_kind = 'NORMAL' AND signer_team_position_id IS NOT NULL
      AND signer_team_name IS NOT NULL AND btrim(signer_team_name) <> ''
      AND signer_position_name IS NOT NULL AND btrim(signer_position_name) <> '')
    OR (signer_identity_kind = 'PRIVILEGED' AND signature_role = 'APPLICANT'
      AND signer_team_position_id IS NULL AND signer_team_name IS NULL AND signer_position_name IS NULL)
  );

-- No new public object or privilege. Existing RLS/default-deny remains.
