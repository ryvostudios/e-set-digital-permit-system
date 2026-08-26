-- Adds the schema foundation for six new backend support features,
-- needed before frontend work begins: in-app notifications, a durable
-- WhatsApp outbox, and immutable issued Permit+JSA document snapshots
-- (plus their PDF-generation job state). Also adds indexes justified by
-- the new permit-search and lifecycle-audit-search endpoints.
--
-- Never edits an already-applied migration (0001-0012). No existing
-- existing business row is mutated; every schema change is additive.
-- The historical section inserts derived snapshots/jobs for already-
-- issued rows and aborts atomically if their authoritative issuance
-- history is corrupt or incomplete.

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
--
-- In-app, persistent, auditable notifications. The recipient is always
-- resolved server-side (creator/applicant, or a user holding the
-- relevant CRO/HSE capability) - never client-supplied (see
-- domain/notifications/recipients.ts). `source_event_id` ties every
-- notification back to the exact append-only lifecycle event that
-- caused it, and - together with `recipient_user_id` - is the
-- idempotency key: a retried/racing transition can never create a
-- second notification for the same recipient about the same event
-- (CONSTRAINT below, not just application-level care).
--
-- Unlike permit_lifecycle_events, this table is NOT purely append-only:
-- a recipient must be able to mark their own notification read. The
-- restricted-update trigger below (`notifications_restrict_update`)
-- allows ONLY `read_at` to change on an UPDATE - every other column,
-- including `read_at` moving back to NULL, is rejected - so "append-only
-- except the read receipt" is enforced at the database level, not just
-- by application code discipline.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  -- Nullable ("permit id where applicable") even though every
  -- notification this batch's application code actually creates is
  -- permit-related - kept nullable rather than NOT NULL so a future,
  -- genuinely non-permit notification type doesn't need a schema change.
  permit_id UUID REFERENCES permits (id) ON DELETE RESTRICT,
  source_event_id UUID NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT notifications_type_not_blank CHECK (btrim(notification_type) <> ''),
  CONSTRAINT notifications_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT notifications_message_not_blank CHECK (btrim(message) <> ''),
  CONSTRAINT notifications_source_event_recipient_unique UNIQUE (source_event_id, recipient_user_id)
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE notifications FROM PUBLIC, anon, authenticated;

-- Serves both "my notifications, newest first" and "my unread
-- notifications" (GET /api/v1/notifications) without a sequential scan.
CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id, read_at, created_at DESC);

CREATE FUNCTION notifications_restrict_update() RETURNS TRIGGER
LANGUAGE plpgsql
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
  THEN
    RAISE EXCEPTION 'only read_at may be updated on notifications - this table is append-only otherwise';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION notifications_restrict_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER notifications_restrict_update_trigger
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_restrict_update();

-- DELETE/TRUNCATE are never legitimate for a notification (no
-- "un-notify" operation exists) - reuses forbid_mutation() from
-- migration 0004_privileged_access.sql, same as every other append-only
-- table in this schema.
CREATE TRIGGER notifications_no_delete
  BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER notifications_no_truncate
  BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- WhatsApp outbox
-- ---------------------------------------------------------------------
--
-- Durable outbox for the company WhatsApp group notification (ISSUED,
-- HELD, RESUMED, CANCELLED, RENEWED, CLOSED - see
-- domain/notifications/whatsappOutbox.ts). A permit transition commits
-- this row in the SAME transaction as the workflow change, so a
-- successful transition never silently loses its outbound message - but
-- actually SENDING it is a separate, later step performed by an
-- external worker/sender, so the transition itself never depends on
-- WhatsApp (or any provider) being reachable.
--
-- `source_event_id` is UNIQUE alone (not composite, unlike
-- notifications): exactly one outbox message per qualifying lifecycle
-- event, regardless of how many humans would eventually read it - the
-- destination is one shared company group, not a per-recipient fan-out.
-- `payload` is a server-generated JSON string (permit number, JSA
-- number, status/action, hold reason where applicable, previous/new
-- permit number for renewal) - never client-influenced, and never
-- contains a secret/credential (SECURITY.md).
--
-- No provider is wired up here (DECISIONS.md's still-open WhatsApp
-- integration method) - `status` starts and stays 'PENDING' until an
-- operator-run sender process (backend/src/scripts/processWhatsappOutbox.ts)
-- successfully delivers it via a configured provider adapter, which does
-- not exist yet either. This table is deliberately just the durable
-- foundation; it is not itself a claim that delivery works.
CREATE TABLE whatsapp_outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
  source_event_id UUID NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  last_attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_outbox_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT whatsapp_outbox_payload_not_blank CHECK (btrim(payload) <> ''),
  CONSTRAINT whatsapp_outbox_source_event_unique UNIQUE (source_event_id),
  CONSTRAINT whatsapp_outbox_sent_at_consistent CHECK (
    (status = 'SENT') = (sent_at IS NOT NULL)
  ),
  CONSTRAINT whatsapp_outbox_claim_consistent CHECK (
    (status = 'PROCESSING') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
  )
);
ALTER TABLE whatsapp_outbox_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE whatsapp_outbox_messages FROM PUBLIC, anon, authenticated;

-- The sender/worker's only query shape: "give me work to do", oldest
-- first. A partial index (PENDING rows only) stays small regardless of
-- how many messages have already been sent.
CREATE INDEX whatsapp_outbox_pending_idx ON whatsapp_outbox_messages (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');

-- Deliberately NOT append-only (unlike notifications/lifecycle events):
-- the sender legitimately updates status/attempt_count/last_error/
-- sent_at as it retries. RLS + the REVOKE above (no anon/authenticated
-- grants) is the same protection every other backend-only operational
-- table in this schema already relies on.

-- ---------------------------------------------------------------------
-- Immutable issued Permit+JSA document snapshot
-- ---------------------------------------------------------------------
--
-- CORE BUSINESS RULE: once a permit is ISSUED, the business information
-- that was issued must never change - not on Hold/Resume/Cancel/Close,
-- not even for the CEO (this is a stricter rule than ordinary audit-log
-- append-only governance: nobody may EVER rewrite it, full stop). This
-- table is that immutable snapshot, captured atomically in the same
-- transaction as issuance (HSE approval, CRO fallback approval, or
-- renewal's immediate ISSUED creation - see
-- domain/permits/documents.ts::createIssuedDocumentSnapshot, called from
-- domain/permits/service.ts). `snapshot` is enough, on its own, to
-- reproduce exactly the business information that was issued (Permit
-- Number, JSA Number, business fields that actually exist on
-- permits/jsas today, issue/validity metadata, renewal lineage) -
-- PDF generation and storage are a separate, retryable concern
-- (permit_document_jobs below) that read this snapshot but never write
-- it.
--
-- `permit_id` is UNIQUE: a permit is only ever issued once (Hold/Resume/
-- Cancel/Close/Renewal never re-issue the SAME permit row; renewal
-- creates a brand-new permit row, which gets its own new snapshot), so
-- exactly one snapshot per permit is the correct cardinality, and this
-- constraint is also the idempotency guard against a retried issuance
-- transaction creating a second snapshot.
CREATE TABLE issued_document_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permits (id) ON DELETE RESTRICT,
  source_event_id UUID NOT NULL REFERENCES permit_lifecycle_events (id) ON DELETE RESTRICT,
  snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT issued_document_snapshots_hash_not_blank CHECK (btrim(snapshot_hash) <> ''),
  CONSTRAINT issued_document_snapshots_permit_unique UNIQUE (permit_id),
  CONSTRAINT issued_document_snapshots_source_event_unique UNIQUE (source_event_id)
);
ALTER TABLE issued_document_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE issued_document_snapshots FROM PUBLIC, anon, authenticated;

-- Database-enforced immutability, for any role including the backend's
-- own - reuses forbid_mutation() (migration 0004) exactly like
-- permit_lifecycle_events does. No UPDATE, no DELETE, no TRUNCATE, for
-- anyone, ever - this is what actually makes "nobody may rewrite the
-- issued document" true, not merely application-code discipline.
CREATE TRIGGER issued_document_snapshots_append_only
  BEFORE UPDATE OR DELETE ON issued_document_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER issued_document_snapshots_no_truncate
  BEFORE TRUNCATE ON issued_document_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- PDF generation job state (mutable while pending; locked once generated)
-- ---------------------------------------------------------------------
--
-- Deliberately a SEPARATE table from issued_document_snapshots: the
-- snapshot's business content must never change, but generating and
-- storing the actual PDF file is an external-I/O concern (a well-
-- supported PDF library, then Supabase Storage) that must be retryable
-- without ever touching the snapshot - "PDF generation/storage can retry
-- without changing what was originally issued". Issuance succeeds
-- (snapshot row committed) independent of whether PDF generation/upload
-- has happened yet or ever succeeds - "successful issuance must not
-- depend on an external file service being available".
--
-- `snapshot_id` is UNIQUE: exactly one PDF per issued snapshot (never
-- "a new replacement issued PDF merely because a permit is later held/
-- resumed/cancelled/closed" - those actions never touch this table at
-- all, only Hold/Resume/etc.'s OWN status change does, and even that
-- doesn't reach here). Once `status = 'GENERATED'`, the restricted-
-- update trigger below refuses ANY further UPDATE - the stored
-- `storage_path`/`file_hash` can never be silently replaced with a
-- different file, closing the "replacement of a document with a
-- different snapshot/hash" tamper path.
CREATE TABLE permit_document_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES issued_document_snapshots (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'GENERATED', 'FAILED')),
  storage_path TEXT,
  file_hash TEXT,
  generated_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permit_document_jobs_snapshot_unique UNIQUE (snapshot_id),
  CONSTRAINT permit_document_jobs_generated_consistent CHECK (
    (status = 'GENERATED' AND storage_path IS NOT NULL AND file_hash IS NOT NULL AND generated_at IS NOT NULL)
    OR (status <> 'GENERATED' AND storage_path IS NULL AND file_hash IS NULL AND generated_at IS NULL)
  ),
  CONSTRAINT permit_document_jobs_claim_consistent CHECK (
    (status = 'PROCESSING') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
  )
);
ALTER TABLE permit_document_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE permit_document_jobs FROM PUBLIC, anon, authenticated;

-- The PDF-generation worker's only query shape: pending/failed work,
-- oldest first. Partial index for the same reason as the WhatsApp
-- outbox's above.
CREATE INDEX permit_document_jobs_pending_idx ON permit_document_jobs (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');

CREATE FUNCTION permit_document_jobs_restrict_update() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'GENERATED' THEN
    RAISE EXCEPTION 'permit_document_jobs row % is already GENERATED and is immutable', OLD.id;
  END IF;
  IF NEW.snapshot_id <> OLD.snapshot_id THEN
    RAISE EXCEPTION 'permit_document_jobs.snapshot_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION permit_document_jobs_restrict_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER permit_document_jobs_restrict_update_trigger
  BEFORE UPDATE ON permit_document_jobs
  FOR EACH ROW EXECUTE FUNCTION permit_document_jobs_restrict_update();

CREATE TRIGGER permit_document_jobs_no_delete
  BEFORE DELETE ON permit_document_jobs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER permit_document_jobs_no_truncate
  BEFORE TRUNCATE ON permit_document_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Historical issued-document backfill
-- ---------------------------------------------------------------------
-- Migrations 0001-0012 were already live before this document system
-- existed. Their workflow code made issued Permit/JSA business fields
-- immutable, so those rows can be snapshotted safely now. Refuse the
-- entire migration if any previously-issued permit does not have exactly
-- one authoritative issuance event: silently fabricating or skipping
-- approval metadata would violate the document invariant.
DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM permits p
   WHERE p.issued_at IS NOT NULL
     AND (
       SELECT count(*)
         FROM permit_lifecycle_events e
        WHERE e.permit_id = p.id
          AND e.event_type IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'RENEWED')
     ) <> 1;

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '0013 backfill refused: % issued permit(s) lack exactly one authoritative issuance event', invalid_count;
  END IF;
END;
$$;

WITH backfill_clock AS (
  SELECT now() AS snapshot_taken_at
), historical AS (
  SELECT
    p.*,
    j.jsa_sequence,
    j.created_by AS jsa_created_by,
    j.created_at AS jsa_created_at,
    e.id AS issuance_event_id,
    e.event_type AS issuance_event_type,
    e.actor_user_id AS issuance_actor_user_id,
    e.occurred_at AS issuance_occurred_at,
    previous.permit_sequence AS previous_permit_sequence,
    backfill_clock.snapshot_taken_at
  FROM permits p
  JOIN jsas j ON j.id = p.jsa_id
  JOIN permit_lifecycle_events e
    ON e.permit_id = p.id
   AND e.event_type IN ('HSE_APPROVED', 'CRO_FALLBACK_APPROVED', 'RENEWED')
  LEFT JOIN permits previous ON previous.id = p.previous_permit_id
  CROSS JOIN backfill_clock
  WHERE p.issued_at IS NOT NULL
), snapshots AS (
  SELECT historical.*, jsonb_build_object(
    'permitId', id,
    'permitNumber', permit_sequence::text,
    'jsaId', jsa_id,
    'jsaNumber', jsa_sequence::text,
    'status', 'ISSUED',
    'company', company,
    'companyOther', company_other,
    'createdBy', created_by,
    'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'issuedAt', to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char((((issued_at AT TIME ZONE site_timezone)::date + 1)::timestamp AT TIME ZONE site_timezone) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'siteTimezone', site_timezone,
    'previousPermitId', previous_permit_id,
    'previousPermitNumber', previous_permit_sequence::text,
    'jsaCreatedBy', jsa_created_by,
    'jsaCreatedAt', to_char(jsa_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'issuanceEventId', issuance_event_id,
    'issuanceEventType', issuance_event_type,
    'issuanceActorUserId', issuance_actor_user_id,
    'issuanceOccurredAt', to_char(issuance_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'snapshotTakenAt', to_char(snapshot_taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) AS snapshot_document
  FROM historical
), inserted AS (
  INSERT INTO issued_document_snapshots (permit_id, source_event_id, snapshot, snapshot_hash, created_at)
  SELECT id, issuance_event_id, snapshot_document,
         encode(digest(convert_to(snapshot_document::text, 'UTF8'), 'sha256'), 'hex'),
         snapshot_taken_at
    FROM snapshots
  ON CONFLICT (permit_id) DO NOTHING
  RETURNING id
)
INSERT INTO permit_document_jobs (snapshot_id)
SELECT s.id
  FROM issued_document_snapshots s
  JOIN permits p ON p.id = s.permit_id
 WHERE p.issued_at IS NOT NULL
ON CONFLICT (snapshot_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Initial CEO bootstrap singleton/reservation
-- ---------------------------------------------------------------------
-- This is coordination state only; authoritative CEO authorization
-- remains privileged_access_events. The single fixed primary-key row is
-- the database invariant that prevents two concurrent bootstrap CLIs
-- from establishing two initial CEOs while Supabase Auth creation occurs
-- outside PostgreSQL. A short lease permits safe recovery after a crash.
CREATE TABLE initial_ceo_bootstrap (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  email TEXT NOT NULL,
  auth_user_id UUID REFERENCES auth.users (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'COMPLETED')),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT initial_ceo_bootstrap_claim_consistent CHECK (
    (status = 'RESERVED' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND claim_token IS NULL AND claimed_at IS NULL AND completed_at IS NOT NULL AND auth_user_id IS NOT NULL)
  )
);
ALTER TABLE initial_ceo_bootstrap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE initial_ceo_bootstrap FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- Search/filter indexes
-- ---------------------------------------------------------------------
--
-- Justified by the new GET /api/v1/permits/search and the extended
-- GET /api/v1/permits/:id/history filters (domain/permits/validation.ts,
-- routes/permits.ts) - both are always additionally scoped by the same
-- access-control predicate every other read endpoint already uses
-- (created_by = caller OR status in the caller's capability-granted set)
-- and by a specific permit_id for history, so these indexes support the
-- actual filters added, not a speculative future need.
CREATE INDEX permits_created_at_idx ON permits (created_at);
CREATE INDEX permit_lifecycle_events_event_type_idx ON permit_lifecycle_events (event_type);
CREATE INDEX permit_lifecycle_events_actor_user_id_idx ON permit_lifecycle_events (actor_user_id);

-- No new privilege/RLS model, no SECURITY DEFINER, no anon/authenticated
-- grants anywhere in this migration - every new table follows the exact
-- RLS-enabled + REVOKE ALL FROM PUBLIC, anon, authenticated pattern
-- every existing table already uses (the backend connects with its own
-- unrestricted role via DATABASE_URL, not through PostgREST anon/
-- authenticated roles).
