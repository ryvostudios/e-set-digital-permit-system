-- PDFKIT_V4: the V3 controlled-document layout plus the CMS branding band
-- (organization name and up to four logos) frozen in the issued snapshot.
--
-- Issued PDFs are content-addressed: a job pins its renderer identity and
-- file hash the first time it renders. V1-V3 are therefore untouched and
-- keep producing exactly their bytes; only jobs that have not pinned an
-- identity yet render with V4. This migration only widens the allowed set.
ALTER TABLE permit.permit_document_jobs
  DROP CONSTRAINT permit_document_jobs_render_identity_consistent,
  ADD CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
    (renderer_version IS NULL AND expected_file_hash IS NULL) OR
    (renderer_version = ANY (ARRAY['PDFKIT_V1', 'PDFKIT_V2', 'PDFKIT_V3', 'PDFKIT_V4'])
      AND expected_file_hash IS NOT NULL AND btrim(expected_file_hash) <> ''));
