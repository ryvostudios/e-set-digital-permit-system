-- Permit-owned file storage. Historical 0001-0039 remain untouched.
-- All objects stay in permit; no storage/public/auth schema access is granted.
-- Dropbox credentials are authenticated-encryption envelopes, never plaintext.

CREATE TABLE permit.storage_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'dropbox' CHECK (provider = 'dropbox'),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error','disconnecting')),
  account_id text,
  account_label text,
  credentials text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  token_revision integer NOT NULL DEFAULT 1 CHECK (token_revision > 0),
  last_health_at timestamptz,
  last_error_code text,
  updated_by uuid REFERENCES permit.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_connections_credentials_pair CHECK ((credentials IS NULL) = (account_id IS NULL))
);
CREATE UNIQUE INDEX storage_connections_account_unique ON permit.storage_connections(provider,account_id)
  WHERE account_id IS NOT NULL;
ALTER TABLE permit.storage_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.storage_connections FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON permit.storage_connections TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.storage_connections FOR ALL TO permit_runtime USING (true) WITH CHECK (true);

CREATE TABLE permit.storage_selection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  connection_id uuid REFERENCES permit.storage_connections(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES permit.users(id) ON DELETE RESTRICT
);
INSERT INTO permit.storage_selection(singleton) VALUES (true);
ALTER TABLE permit.storage_selection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.storage_selection FROM PUBLIC;
GRANT SELECT, UPDATE ON permit.storage_selection TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.storage_selection FOR ALL TO permit_runtime USING (true) WITH CHECK (true);

CREATE TABLE permit.storage_oauth_states (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  actor_user_id uuid NOT NULL REFERENCES permit.users(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES permit.user_sessions(id) ON DELETE CASCADE,
  base_connection_id uuid REFERENCES permit.storage_connections(id) ON DELETE RESTRICT,
  verifier_envelope text NOT NULL,
  connection_revision integer NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_oauth_states_expiry_idx ON permit.storage_oauth_states(expires_at);
ALTER TABLE permit.storage_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.storage_oauth_states FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON permit.storage_oauth_states TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.storage_oauth_states FOR ALL TO permit_runtime USING (true) WITH CHECK (true);

-- One row is reserved before network I/O. It pins the connection and
-- deterministic logical name across retries, including ambiguous uploads.
CREATE TABLE permit.file_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('dropbox','legacy_supabase')),
  connection_id uuid REFERENCES permit.storage_connections(id) ON DELETE RESTRICT,
  logical_key text NOT NULL,
  remote_path text NOT NULL,
  remote_id text,
  category text NOT NULL CHECK (category IN ('ISSUED_PDF','CLOSED_PDF','JSA','EVIDENCE','ATTACHMENT','REPORT','EXPORT','BRANDING','CMS_ASSET')),
  related_permit_id uuid REFERENCES permit.permits(id) ON DELETE RESTRICT,
  related_jsa_id uuid REFERENCES permit.jsas(id) ON DELETE RESTRICT,
  document_job_id uuid UNIQUE REFERENCES permit.permit_document_jobs(id) ON DELETE RESTRICT,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 150),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 268435456),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES permit.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','cleanup_pending')),
  CONSTRAINT file_registry_provider_connection CHECK (
    (provider='dropbox' AND connection_id IS NOT NULL) OR
    (provider='legacy_supabase' AND connection_id IS NULL)),
  CONSTRAINT file_registry_logical_unique UNIQUE (provider, connection_id, logical_key),
  CONSTRAINT file_registry_remote_unique UNIQUE (provider, connection_id, remote_path)
);
CREATE INDEX file_registry_connection_state_idx ON permit.file_registry(connection_id,state);
CREATE INDEX file_registry_related_permit_idx ON permit.file_registry(related_permit_id,category);
ALTER TABLE permit.file_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.file_registry FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (remote_id,state) ON permit.file_registry TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.file_registry FOR ALL TO permit_runtime USING (true) WITH CHECK (true);

CREATE FUNCTION permit.file_registry_restrict_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF OLD.state = 'ready' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
     OR NEW.remote_path IS DISTINCT FROM OLD.remote_path
     OR NEW.category IS DISTINCT FROM OLD.category OR NEW.related_permit_id IS DISTINCT FROM OLD.related_permit_id
     OR NEW.related_jsa_id IS DISTINCT FROM OLD.related_jsa_id OR NEW.document_job_id IS DISTINCT FROM OLD.document_job_id
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.immutable IS DISTINCT FROM OLD.immutable THEN
    RAISE EXCEPTION 'file registry identity is immutable';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.file_registry_restrict_update() FROM PUBLIC;
CREATE TRIGGER file_registry_restrict_update BEFORE UPDATE ON permit.file_registry
  FOR EACH ROW EXECUTE FUNCTION permit.file_registry_restrict_update();

CREATE TABLE permit.storage_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES permit.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('CONNECT_STARTED','CONNECTED','CONNECT_FAILED','CONNECTION_TESTED','CONNECTION_TEST_FAILED','ACTIVATED','DEACTIVATED','DISCONNECT_REFUSED','DISCONNECTED','DISCONNECT_FAILED')),
  connection_id uuid REFERENCES permit.storage_connections(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE permit.storage_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permit.storage_audit_events FROM PUBLIC;
GRANT SELECT, INSERT (actor_user_id,event_type,connection_id) ON permit.storage_audit_events TO permit_runtime;
CREATE POLICY permit_runtime_access ON permit.storage_audit_events FOR ALL TO permit_runtime USING (true) WITH CHECK (true);
CREATE TRIGGER storage_audit_append_only BEFORE DELETE OR UPDATE ON permit.storage_audit_events
  FOR EACH ROW EXECUTE FUNCTION permit.forbid_mutation();
CREATE TRIGGER storage_audit_no_truncate BEFORE TRUNCATE ON permit.storage_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION permit.forbid_mutation();
