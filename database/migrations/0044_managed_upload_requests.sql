-- A03 (pre-production audit): idempotent CMS asset uploads.
--
-- One row per logical upload, identified by the uploading user and a
-- client-generated request id. The registry reservation of that upload is
-- derived from this row's id (logical key cms/<id>.png), so a retry resumes
-- the same reservation and remote path instead of creating a new one. The
-- request fingerprint (purpose, label and the SHA-256 of the submitted bytes)
-- must match on every retry; the created asset is recorded once.
-- A request id is scoped to its user: another user's identical id is a
-- different request.

CREATE TABLE permit.managed_upload_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES permit.users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation = 'CMS_ASSET'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id uuid UNIQUE REFERENCES permit.cms_logo_assets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT managed_upload_requests_actor_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX managed_upload_requests_unfinished_idx ON permit.managed_upload_requests(actor_user_id, created_at)
  WHERE asset_id IS NULL;
ALTER TABLE permit.managed_upload_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.managed_upload_requests FROM PUBLIC;
GRANT SELECT, INSERT ON permit.managed_upload_requests TO permit_runtime;
GRANT UPDATE (asset_id) ON permit.managed_upload_requests TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.managed_upload_requests FOR ALL TO permit_runtime USING (true) WITH CHECK (true);

-- An asset is recorded once and never re-pointed.
CREATE FUNCTION permit.managed_upload_requests_restrict_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF OLD.asset_id IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'managed upload request identity is immutable';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.managed_upload_requests_restrict_update() FROM PUBLIC;
CREATE TRIGGER managed_upload_requests_restrict_update BEFORE UPDATE ON permit.managed_upload_requests
  FOR EACH ROW EXECUTE FUNCTION permit.managed_upload_requests_restrict_update();
