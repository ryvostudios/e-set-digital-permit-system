-- =====================================================================
-- 0032  Document renderer allowlist: admit PDFKIT_V3
-- =====================================================================
--
-- WHAT THIS DOES, AND ALL IT DOES.
--
-- `permit_document_jobs.renderer_version` names the renderer whose exact
-- bytes a job is pinned to, next to the `expected_file_hash` of those
-- bytes. Migration 0015 introduced the pair and pinned it to
-- 'PDFKIT_V1'; migration 0016 WIDENED the allowlist to admit 'PDFKIT_V2'
-- when the combined Permit + JSA document was introduced. This widens it
-- once more, for 'PDFKIT_V3': the renderer that draws the authoritative
-- document as the controlled form it is - masthead, identity band,
-- numbered sections, bordered field grids, checklist bands with the
-- printed YES/NO/N-A columns, tick grids and signature bands - so the
-- issued PDF and the on-screen document read as one piece of paperwork.
--
-- THE ALLOWLIST IS WIDENED, NEVER REPLACED. 'PDFKIT_V1' and 'PDFKIT_V2'
-- remain valid so every historical job row stays valid, and the
-- restrict-update trigger from 0015 still refuses to change an
-- already-established renderer_version/expected_file_hash, or to touch a
-- GENERATED row at all.
--
-- WHY NO DATA IS TOUCHED. An issued document is content-addressed: its
-- stored bytes, its file hash and the snapshot hash behind it must go on
-- agreeing for the life of the record. So nothing here re-renders,
-- rewrites, deletes or re-hashes anything:
--
--   * Every GENERATED document keeps its bytes, its file hash and its
--     storage object, untouched and unregenerated.
--   * Every job that has ALREADY pinned a renderer_version keeps it, and
--     the application renders that job with that renderer - a V1/V2 job
--     is never re-rendered by V3.
--   * Only a job that has pinned NOTHING yet - a permit issued after
--     this deploys - establishes 'PDFKIT_V3'.
--
-- Consequently the document estate is intentionally mixed after this
-- migration: permits issued before it keep the document they were issued
-- with. That is the correct outcome for an immutable record, not a
-- shortfall to be corrected by a backfill.
--
-- NO FORM CONTRACT CHANGES. This migration does not touch permits, jsas,
-- form_version, form_payload, issued_document_snapshots or any snapshot
-- hash. The WTG permit's `permitStartAt`/`permitExpiryAt` and every other
-- stored form field are exactly as they were.
--
-- SECURITY SURFACE: none. No table is created, no column is added, no
-- capability is seeded, no policy is created or altered, no grant is
-- issued to anon or authenticated, and no function or trigger is
-- redefined. The document bucket stays private and every download keeps
-- going through the existing server-side authorization and hash
-- verification.
--
-- Idempotent: dropping the constraint IF EXISTS and re-adding it makes a
-- re-run a no-op.

BEGIN;

ALTER TABLE permit_document_jobs
  DROP CONSTRAINT IF EXISTS permit_document_jobs_render_identity_consistent;

-- A row already carrying an identity outside the allowlist would make the
-- new constraint invalid. `ADD CONSTRAINT` would refuse it anyway, but
-- with a message that names the constraint rather than the problem, so
-- this checks first and says exactly what is wrong.
DO $$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending
    FROM permit_document_jobs
   WHERE renderer_version IS NOT NULL
     AND renderer_version NOT IN ('PDFKIT_V1', 'PDFKIT_V2', 'PDFKIT_V3');
  IF offending > 0 THEN
    RAISE EXCEPTION 'migration 0032 aborted: % job row(s) carry an unknown renderer_version', offending;
  END IF;
END
$$;

ALTER TABLE permit_document_jobs
  ADD CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
    (renderer_version IS NULL AND expected_file_hash IS NULL)
    OR (
      renderer_version IN ('PDFKIT_V1', 'PDFKIT_V2', 'PDFKIT_V3')
      AND expected_file_hash IS NOT NULL
      AND btrim(expected_file_hash) <> ''
    )
  );

COMMIT;
