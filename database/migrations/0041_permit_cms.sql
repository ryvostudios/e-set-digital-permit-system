-- Permit-only CMS. Historical document bytes and the 0038 baseline are unchanged.
-- Administrative authority is granted to individuals explicitly, never to a
-- Team + Position. The CEO retains independent privileged authority in code.
INSERT INTO permit.capabilities(name,description,individually_grantable)
VALUES ('permit.cms.manage','Manage Permit branding and application content',true);

CREATE TABLE permit.cms_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  organization_name text NOT NULL DEFAULT 'E-Set Engineering Services'
    CHECK (length(organization_name) BETWEEN 1 AND 120),
  web_logo_asset_id uuid,
  pwa_icon_asset_id uuid,
  -- Application content: one public, plain-text notice on the sign-in page.
  sign_in_notice text NOT NULL DEFAULT '' CHECK (length(sign_in_notice) <= 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES permit.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO permit.cms_settings(singleton) VALUES(true);
ALTER TABLE permit.cms_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.cms_settings FROM PUBLIC;
GRANT SELECT, UPDATE (organization_name,web_logo_asset_id,pwa_icon_asset_id,sign_in_notice,revision,updated_by,updated_at)
  ON permit.cms_settings TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.cms_settings FOR ALL TO permit_runtime USING(true) WITH CHECK(true);

CREATE TABLE permit.cms_logo_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL UNIQUE REFERENCES permit.file_registry(id) ON DELETE RESTRICT,
  display_label text NOT NULL CHECK (length(display_label) BETWEEN 1 AND 80),
  purpose text NOT NULL CHECK (purpose IN ('PDF_LOGO','WEB_LOGO','PWA_ICON')),
  active boolean NOT NULL DEFAULT false,
  -- At most four PDF logos print at once (the masthead band has four
  -- equal slots on an A4 page); order is the slot, left to right.
  display_order smallint NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 3),
  applicable_document_types text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (applicable_document_types <@ ARRAY['ISSUED_PERMIT','CLOSED_PERMIT','JSA']::text[]),
  created_by uuid NOT NULL REFERENCES permit.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE permit.cms_settings
  ADD CONSTRAINT cms_settings_web_logo_fk FOREIGN KEY (web_logo_asset_id)
  REFERENCES permit.cms_logo_assets(id) ON DELETE RESTRICT;
ALTER TABLE permit.cms_settings
  ADD CONSTRAINT cms_settings_pwa_icon_fk FOREIGN KEY (pwa_icon_asset_id)
  REFERENCES permit.cms_logo_assets(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX cms_active_pdf_logo_order ON permit.cms_logo_assets(display_order)
  WHERE purpose='PDF_LOGO' AND active;
ALTER TABLE permit.cms_logo_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.cms_logo_assets FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (active,display_order,applicable_document_types) ON permit.cms_logo_assets TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.cms_logo_assets FOR ALL TO permit_runtime USING(true) WITH CHECK(true);

CREATE FUNCTION permit.cms_logo_asset_restrict_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.file_id IS DISTINCT FROM OLD.file_id
    OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CMS asset identity is immutable';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.cms_logo_asset_restrict_update() FROM PUBLIC;
CREATE TRIGGER cms_logo_asset_restrict_update BEFORE UPDATE ON permit.cms_logo_assets
  FOR EACH ROW EXECUTE FUNCTION permit.cms_logo_asset_restrict_update();

CREATE TABLE permit.cms_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES permit.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN
    ('SETTING_CHANGED','LOGO_UPLOADED','LOGO_ACTIVATED','LOGO_DEACTIVATED',
     'LOGO_ORDER_CHANGED','PDF_BRANDING_CHANGED','WEB_LOGO_CHANGED','PWA_ICON_CHANGED','CONTENT_CHANGED')),
  asset_id uuid REFERENCES permit.cms_logo_assets(id) ON DELETE RESTRICT,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 2048),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE permit.cms_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.cms_audit_events FROM PUBLIC;
GRANT SELECT, INSERT (actor_user_id,event_type,asset_id,detail) ON permit.cms_audit_events TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.cms_audit_events FOR ALL TO permit_runtime USING(true) WITH CHECK(true);
CREATE TRIGGER cms_audit_append_only BEFORE DELETE OR UPDATE ON permit.cms_audit_events
  FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();
CREATE TRIGGER cms_audit_no_truncate BEFORE TRUNCATE ON permit.cms_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();
