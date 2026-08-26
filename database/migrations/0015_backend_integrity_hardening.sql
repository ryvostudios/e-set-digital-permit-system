-- Backend security and integrity hardening. Migrations 0001-0014 are
-- immutable, applied history; every change here is additive or replaces
-- only trigger-function behavior explicitly tightened by this migration.

-- Immediate application-level account access. Existing Auth identities
-- are activated transactionally so rollout never relies on a missing row
-- meaning ACTIVE; all later authentication fails closed on a missing row.
CREATE TABLE app_user_access (
  user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  CONSTRAINT app_user_access_disabled_consistent CHECK (
    (state = 'DISABLED') = (disabled_at IS NOT NULL)
  )
);
CREATE FUNCTION public.app_user_access_authoritative_timestamps() RETURNS TRIGGER
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
  NEW.disabled_at := CASE WHEN NEW.state = 'DISABLED' THEN COALESCE(OLD.disabled_at, now()) ELSE NULL END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_user_access_authoritative_timestamps() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER app_user_access_authoritative_timestamps_trigger
  BEFORE INSERT OR UPDATE ON app_user_access
  FOR EACH ROW EXECUTE FUNCTION public.app_user_access_authoritative_timestamps();
ALTER TABLE app_user_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_user_access FROM PUBLIC, anon, authenticated;
INSERT INTO app_user_access (user_id, state)
SELECT id, 'ACTIVE' FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Enforce the already-agreed Company/Other contract against existing
-- data before installing the permanent constraint. Corrupt rows abort
-- the whole migration rather than being silently rewritten.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.permits
     WHERE (company = 'OTHER' AND (company_other IS NULL OR btrim(company_other) = ''))
        OR (company IS DISTINCT FROM 'OTHER' AND company_other IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'existing permits violate the company/company_other invariant';
  END IF;
END;
$$;
ALTER TABLE public.permits
  ADD CONSTRAINT permits_company_other_exclusive CHECK (
    (company = 'OTHER' AND company_other IS NOT NULL AND btrim(company_other) <> '')
    OR (company IS DISTINCT FROM 'OTHER' AND company_other IS NULL)
  );

-- Hash-contract metadata is kept in its own immutable one-to-one table,
-- avoiding any UPDATE to the already-immutable snapshot rows. Historical
-- migration-backfill hashes used PostgreSQL jsonb text; application-created
-- hashes used sorted compact JSON. New rows explicitly use the latter.
CREATE TABLE issued_document_snapshot_integrity (
  snapshot_id UUID PRIMARY KEY REFERENCES issued_document_snapshots (id) ON DELETE RESTRICT,
  hash_version TEXT NOT NULL CHECK (hash_version IN ('PG_JSONB_SHA256_V1', 'SORTED_JSON_SHA256_V1')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE issued_document_snapshot_integrity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE issued_document_snapshot_integrity FROM PUBLIC, anon, authenticated;

-- Reproduce the application's recursively sorted, compact JSON contract
-- inside this migration session. pg_temp keeps this rollout-only helper out
-- of the permanent schema; explicit qualification makes recursion immune to
-- caller-controlled search_path values.
CREATE FUNCTION pg_temp.sorted_json_v1(input_value JSONB) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  serialized TEXT;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_jsonb(key)::text || ':' || pg_temp.sorted_json_v1(value), ',' ORDER BY key COLLATE "C"), '') || '}'
        INTO serialized FROM jsonb_each(input_value);
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(pg_temp.sorted_json_v1(value), ',' ORDER BY ordinal), '') || ']'
        INTO serialized FROM jsonb_array_elements(input_value) WITH ORDINALITY AS elements(value, ordinal);
    ELSE
      serialized := input_value::text;
  END CASE;
  RETURN serialized;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM issued_document_snapshots
     WHERE snapshot_hash <> encode(digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex')
       AND snapshot_hash <> encode(digest(convert_to(pg_temp.sorted_json_v1(snapshot), 'UTF8'), 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'existing issued snapshot hash does not match a recognized hash contract';
  END IF;
END;
$$;

INSERT INTO issued_document_snapshot_integrity (snapshot_id, hash_version)
SELECT id,
       CASE
         WHEN snapshot_hash = encode(digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex')
           THEN 'PG_JSONB_SHA256_V1'
         WHEN snapshot_hash = encode(digest(convert_to(pg_temp.sorted_json_v1(snapshot), 'UTF8'), 'sha256'), 'hex')
           THEN 'SORTED_JSON_SHA256_V1'
       END
  FROM issued_document_snapshots;
DROP FUNCTION pg_temp.sorted_json_v1(JSONB);
CREATE TRIGGER issued_document_snapshot_integrity_append_only
  BEFORE UPDATE OR DELETE ON issued_document_snapshot_integrity
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER issued_document_snapshot_integrity_no_truncate
  BEFORE TRUNCATE ON issued_document_snapshot_integrity
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Persist the intended deterministic renderer/file identity before upload.
ALTER TABLE permit_document_jobs
  ADD COLUMN renderer_version TEXT,
  ADD COLUMN expected_file_hash TEXT;
ALTER TABLE permit_document_jobs
  ADD CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
    (renderer_version IS NULL AND expected_file_hash IS NULL)
    OR (renderer_version = 'PDFKIT_V1' AND expected_file_hash IS NOT NULL AND btrim(expected_file_hash) <> '')
  );
CREATE OR REPLACE FUNCTION public.permit_document_jobs_restrict_update() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'GENERATED' THEN
    RAISE EXCEPTION 'generated document job is immutable';
  END IF;
  IF NEW.snapshot_id <> OLD.snapshot_id
     OR (OLD.renderer_version IS NOT NULL AND NEW.renderer_version IS DISTINCT FROM OLD.renderer_version)
     OR (OLD.expected_file_hash IS NOT NULL AND NEW.expected_file_hash IS DISTINCT FROM OLD.expected_file_hash)
  THEN
    RAISE EXCEPTION 'document attribution and established render identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- A read receipt may be written once and then remains immutable. The
-- function stays SECURITY INVOKER and resolves no caller-controlled name.
CREATE OR REPLACE FUNCTION public.notifications_restrict_update() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.recipient_user_id <> OLD.recipient_user_id
     OR NEW.permit_id IS DISTINCT FROM OLD.permit_id
     OR NEW.source_event_id <> OLD.source_event_id
     OR NEW.notification_type <> OLD.notification_type
     OR NEW.title <> OLD.title
     OR NEW.message <> OLD.message
     OR NEW.created_at <> OLD.created_at
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
  THEN
    RAISE EXCEPTION 'notification business fields and an existing read receipt are immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- Freeze WhatsApp business/audit attribution while preserving the worker's
-- token-owned operational state machine. SENT rows are final.
CREATE FUNCTION public.whatsapp_outbox_restrict_update() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'SENT' THEN
    RAISE EXCEPTION 'a SENT WhatsApp outbox row is immutable';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.permit_id <> OLD.permit_id
     OR NEW.source_event_id <> OLD.source_event_id
     OR NEW.event_type <> OLD.event_type
     OR NEW.payload <> OLD.payload
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'WhatsApp outbox business fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_outbox_restrict_update() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER whatsapp_outbox_restrict_update_trigger
  BEFORE UPDATE ON whatsapp_outbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_outbox_restrict_update();
CREATE TRIGGER whatsapp_outbox_no_delete
  BEFORE DELETE ON whatsapp_outbox_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER whatsapp_outbox_no_truncate
  BEFORE TRUNCATE ON whatsapp_outbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Cross-table attribution: every support row must point to a lifecycle
-- event belonging to the same permit. Extra type checks protect issuance
-- snapshots and the deliberately renamed ISSUED WhatsApp event.
CREATE FUNCTION public.support_event_linkage_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  authoritative_type TEXT;
  authoritative_permit UUID;
BEGIN
  SELECT event_type, permit_id INTO authoritative_type, authoritative_permit
    FROM public.permit_lifecycle_events WHERE id = NEW.source_event_id;
  IF authoritative_permit IS NULL OR NEW.permit_id IS DISTINCT FROM authoritative_permit THEN
    RAISE EXCEPTION 'support row lifecycle event does not belong to its permit';
  END IF;
  IF TG_TABLE_NAME = 'issued_document_snapshots'
     AND authoritative_type NOT IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'RENEWED') THEN
    RAISE EXCEPTION 'snapshot source is not an issuance lifecycle event';
  END IF;
  IF TG_TABLE_NAME = 'whatsapp_outbox_messages'
     AND NOT (
       ((to_jsonb(NEW)->>'event_type') = 'ISSUED' AND authoritative_type IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED'))
       OR ((to_jsonb(NEW)->>'event_type') = authoritative_type
           AND (to_jsonb(NEW)->>'event_type') IN ('HELD', 'RESUMED', 'CANCELLED', 'RENEWED', 'CLOSED'))
     ) THEN
    RAISE EXCEPTION 'WhatsApp event type does not match its lifecycle event';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.support_event_linkage_guard() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notifications n JOIN permit_lifecycle_events e ON e.id = n.source_event_id
     WHERE n.permit_id IS DISTINCT FROM e.permit_id
  ) OR EXISTS (
    SELECT 1 FROM whatsapp_outbox_messages w JOIN permit_lifecycle_events e ON e.id = w.source_event_id
     WHERE w.permit_id IS DISTINCT FROM e.permit_id
        OR NOT (
          (w.event_type = 'ISSUED' AND e.event_type IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED'))
          OR (w.event_type = e.event_type AND w.event_type IN ('HELD', 'RESUMED', 'CANCELLED', 'RENEWED', 'CLOSED'))
        )
  ) OR EXISTS (
    SELECT 1 FROM issued_document_snapshots s JOIN permit_lifecycle_events e ON e.id = s.source_event_id
     WHERE s.permit_id IS DISTINCT FROM e.permit_id
        OR e.event_type NOT IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'RENEWED')
  ) THEN
    RAISE EXCEPTION 'existing support rows violate lifecycle attribution integrity';
  END IF;
END;
$$;

CREATE CONSTRAINT TRIGGER notifications_event_linkage
  AFTER INSERT OR UPDATE ON notifications
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION public.support_event_linkage_guard();
CREATE CONSTRAINT TRIGGER whatsapp_outbox_event_linkage
  AFTER INSERT OR UPDATE ON whatsapp_outbox_messages
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION public.support_event_linkage_guard();
CREATE CONSTRAINT TRIGGER issued_snapshots_event_linkage
  AFTER INSERT OR UPDATE ON issued_document_snapshots
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION public.support_event_linkage_guard();
