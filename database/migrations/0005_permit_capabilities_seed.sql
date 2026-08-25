-- Capability catalog for the documented Permit workflow.
--
-- `permit.cro_review`, `permit.send_back`, `permit.hold`, `permit.resume`,
-- `permit.cancel`, `permit.forward_hse`, `permit.fallback_approve`,
-- `permit.renew`, `permit.close` are taken verbatim from ARCHITECTURE.md's
-- authorization model example. `permit.create` and `permit.submit` are
-- added for the Creator's own create/submit actions described in
-- WORKFLOW.md ("Creator ... creates and submits a permit"), which is not
-- given a literal capability name there.
--
-- Seeding a name here grants nothing by itself - no
-- team_position_capabilities rows are created by this migration, and no
-- route besides permit draft create/update/submit enforces any of these
-- capabilities yet.
INSERT INTO capabilities (name, description) VALUES
  ('permit.create', 'Create and edit a draft permit/JSA before submission'),
  ('permit.submit', 'Submit a draft permit for CRO review'),
  ('permit.cro_review', 'Review a pending permit as CRO'),
  ('permit.send_back', 'Send a permit back to the creator for correction'),
  ('permit.hold', 'Place an issued permit on hold'),
  ('permit.resume', 'Resume a held permit'),
  ('permit.cancel', 'Cancel a permit'),
  ('permit.forward_hse', 'Forward a CRO-reviewed permit to HSE for review'),
  ('permit.fallback_approve', 'CRO fallback approval after the HSE review window expires'),
  ('permit.renew', 'Renew a permit after midnight expiry'),
  ('permit.close', 'Close an issued permit');
