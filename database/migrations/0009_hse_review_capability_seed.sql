-- ARCHITECTURE.md's authorization-model example lists capabilities for a
-- CRO position only (permit.cro_review, permit.forward_hse,
-- permit.fallback_approve, ...); it names no capability for HSE's own
-- review/approval action. That action is nonetheless clearly part of the
-- documented workflow (WORKFLOW.md "HSE Five-Minute Window": "HSE may
-- approve or send back"), so - matching how permit.create/permit.submit
-- were added for the Creator's action in an earlier migration -
-- `permit.hse_review` is added here, named consistently with the
-- existing `permit.cro_review`. Seeding it grants nothing by itself; no
-- position is given this capability by this migration.
INSERT INTO capabilities (name, description) VALUES
  ('permit.hse_review', 'Review a permit pending HSE review and approve it');
