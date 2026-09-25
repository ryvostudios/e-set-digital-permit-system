-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Regenerate with database/baseline/tools/generate-baseline.sh.
--
-- Permit reference data at migration 0038 (seeded catalog rows and sequence positions). Omitted when installing as a data-migration target.
--
-- Source: Permit migrations 0001-0038 (hashes in manifest.json), replayed on
-- a disposable cluster and moved from schema public to schema permit.
-- Installed only by the Permit migration runner, as permit_migrator, in
-- one transaction together with 0038_permit_privileges.sql.
--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: capabilities; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('009b5ea4-b03c-4669-92d7-4fca1a9d5abc', 'permit.create', 'Create and edit a draft permit/JSA before submission', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('12f0a5cb-59ab-468a-bbac-ee6e3ba90799', 'permit.submit', 'Submit a draft permit for CRO review', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('25d722ec-7b92-4854-9f5b-a6e293a38197', 'permit.cro_review', 'Review a pending permit as CRO', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('c4485b9e-fc7f-4f8c-aad1-262d905b2312', 'permit.send_back', 'Send a permit back to the creator for correction', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('46ebb84e-c069-43f4-815b-fdc0a21113b0', 'permit.hold', 'Place an issued permit on hold', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('fd23e056-e3bd-4e28-8537-1730cf82314a', 'permit.resume', 'Resume a held permit', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('13c2ca06-8f2c-4682-9a9b-af4cb1cd70df', 'permit.cancel', 'Cancel a permit', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('4aece5c4-4111-46d1-a3bf-1960dc107aae', 'permit.forward_hse', 'Forward a CRO-reviewed permit to HSE for review', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('16340cbb-3c31-4027-ba70-5448122a184c', 'permit.fallback_approve', 'CRO fallback approval after the HSE review window expires', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('cbc806fc-e2cf-4ab9-8c6d-bd3aa2d388f4', 'permit.renew', 'Renew a permit after midnight expiry', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('bc64ccac-a94b-40e1-9c64-adb6fae1dd17', 'permit.close', 'Close an issued permit', '2026-09-25 18:55:35.469674+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('9ae92b84-0f7b-4e64-a95e-9381abfb38df', 'permit.hse_review', 'Review a permit pending HSE review and approve it', '2026-09-25 18:55:35.608189+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('212cc25e-3d22-4d81-8141-a272fa4bc0f8', 'employee.create', 'Provision a normal employee account (Site Manager account management)', '2026-09-25 18:55:35.912381+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('fd708d22-fbaf-40f7-a1fd-13a7a79d2407', 'employee.reset_password', 'Set a new temporary password on a normal employee account', '2026-09-25 18:55:35.912381+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('5cb4ad9f-1d30-45b3-b47c-b4225e2d763c', 'permit.view_all', 'See every permit, historical and future, regardless of ownership or review queue', '2026-09-25 18:55:36.153592+05', true);


--
-- Data for Name: companies; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000001', 'E_SET', 'E-SET', '2026-09-25 18:55:35.948797+05', NULL);
INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000002', 'ZPL', 'ZPL', '2026-09-25 18:55:35.948797+05', NULL);
INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000003', 'SGRE', 'SGRE', '2026-09-25 18:55:35.948797+05', NULL);


--
-- Data for Name: positions; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.positions (id, name, created_at) VALUES ('4f918964-def9-492e-a04a-2df82f087219', 'Admin Lead', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('a3061e81-2646-4dbd-ba16-586d0bc572df', 'Assistant Admin', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('78ebb372-8bff-4bf5-8773-2bbfa8d57a29', 'Team Lead', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('d1bcdd1d-7f19-45a4-b3c0-acad8b2affea', 'Supervisor', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('d6a272be-754d-48a4-b2a2-79d7890a2638', 'Worker', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('779cc0f1-ab8a-41dc-bd33-35933a2a5e84', 'Engineer', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('dde8a2f8-6c32-4307-870a-7daea8391b84', 'Technician', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('a278ae81-8177-44c2-a3a5-fd642a87a377', 'CRO', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('816f4aab-1720-4628-9de4-bdabfade2a8f', 'Paramedic', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('75b6688d-9d74-4bd8-9748-638f7f14005b', 'Site Manager', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('fa021ef5-f154-4aa6-a0c6-1c9ce95b8e84', 'Asset Manager', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('86791c87-eaa2-49ac-9fbf-d74fe86e5e16', 'HSE', '2026-09-25 18:55:36.038691+05');


--
-- Data for Name: teams; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('d76269fe-529b-4a15-9723-7228809cd4b8', 'Admin', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('cd4b2848-24c3-4660-aa84-601fce9f4bbe', 'Civil', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('ae0aa863-fcf2-4dfc-a893-32c1bcfe3397', 'WTG', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('40473dfe-cf9f-4cc4-9ba6-c5296cf41b34', 'E-BOP', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('0f224202-b1eb-4513-9e53-95e43f4df876', 'HSE', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('31218e91-111f-402f-b1ed-551d41dca51d', 'ZPL', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000002', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('244146ca-ccd1-452f-8f3c-75de2df90f90', 'SGRE', '2026-09-25 18:55:36.038691+05', '18000000-0000-4000-8000-000000000003', NULL);


--
-- Data for Name: team_positions; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('c65d612b-07f2-4ded-9e6b-d5154702107f', '0f224202-b1eb-4513-9e53-95e43f4df876', '816f4aab-1720-4628-9de4-bdabfade2a8f', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('5913e395-524e-4770-bbfc-639bdf22376e', '0f224202-b1eb-4513-9e53-95e43f4df876', '78ebb372-8bff-4bf5-8773-2bbfa8d57a29', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('890d3d37-1625-467c-97b2-2dc625255c8b', '40473dfe-cf9f-4cc4-9ba6-c5296cf41b34', 'dde8a2f8-6c32-4307-870a-7daea8391b84', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '40473dfe-cf9f-4cc4-9ba6-c5296cf41b34', 'a278ae81-8177-44c2-a3a5-fd642a87a377', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('d752dc1f-aa4f-4d85-a83c-ad7859ed7629', '40473dfe-cf9f-4cc4-9ba6-c5296cf41b34', '78ebb372-8bff-4bf5-8773-2bbfa8d57a29', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('b8ca9454-9277-4c64-ada1-9273bef241b1', 'ae0aa863-fcf2-4dfc-a893-32c1bcfe3397', 'dde8a2f8-6c32-4307-870a-7daea8391b84', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('b2899f06-3723-4831-b4a9-18285b03ef3a', 'ae0aa863-fcf2-4dfc-a893-32c1bcfe3397', '779cc0f1-ab8a-41dc-bd33-35933a2a5e84', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('56f19dd0-1508-479f-a8e1-332ad408db10', 'ae0aa863-fcf2-4dfc-a893-32c1bcfe3397', '78ebb372-8bff-4bf5-8773-2bbfa8d57a29', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('96eff16b-a699-4a2b-95fa-f3e1947d1412', 'cd4b2848-24c3-4660-aa84-601fce9f4bbe', 'd6a272be-754d-48a4-b2a2-79d7890a2638', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('d079090f-78c4-451f-81ec-0b3478eb7484', 'cd4b2848-24c3-4660-aa84-601fce9f4bbe', 'd1bcdd1d-7f19-45a4-b3c0-acad8b2affea', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('662536f0-a638-466c-8a73-3c0a5322e098', 'cd4b2848-24c3-4660-aa84-601fce9f4bbe', '78ebb372-8bff-4bf5-8773-2bbfa8d57a29', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('24290a81-f8dd-4b61-88d4-6dd25b9096ae', 'd76269fe-529b-4a15-9723-7228809cd4b8', 'a3061e81-2646-4dbd-ba16-586d0bc572df', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('b1efafba-54bc-49b6-862d-b1d804c3f341', 'd76269fe-529b-4a15-9723-7228809cd4b8', '4f918964-def9-492e-a04a-2df82f087219', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('c44f2eb9-61fc-45b8-8b57-84b1e9c73eef', '31218e91-111f-402f-b1ed-551d41dca51d', '86791c87-eaa2-49ac-9fbf-d74fe86e5e16', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('744a6ee6-a548-4460-8d43-48395ea43790', '31218e91-111f-402f-b1ed-551d41dca51d', '779cc0f1-ab8a-41dc-bd33-35933a2a5e84', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('f05e7225-8b1e-438d-b2ce-587224712734', '31218e91-111f-402f-b1ed-551d41dca51d', 'fa021ef5-f154-4aa6-a0c6-1c9ce95b8e84', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('57d41d38-62dd-46f2-957f-47eed64fbdb1', '31218e91-111f-402f-b1ed-551d41dca51d', '75b6688d-9d74-4bd8-9748-638f7f14005b', '2026-09-25 18:55:36.038691+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('6b82d323-8dc4-44a3-8da4-e08ea832bb5b', '244146ca-ccd1-452f-8f3c-75de2df90f90', '78ebb372-8bff-4bf5-8773-2bbfa8d57a29', '2026-09-25 18:55:36.038691+05', true, NULL);


--
-- Data for Name: account_audit_events; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: app_user_access; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: initial_ceo_bootstrap; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: jsas; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: permits; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: permit_lifecycle_events; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: issued_document_snapshots; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: issued_document_snapshot_integrity; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: notifications; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: organization_audit_events; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: permit_document_jobs; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: permit_number_counters; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('WTG_WORK', 1, '2026-09-25 18:55:36.553095+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('COLD_WORK', 1, '2026-09-25 18:55:36.553095+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('HOT_WORK', 1, '2026-09-25 18:55:36.553095+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('CONFINED_SPACE_ENTRY', 1, '2026-09-25 18:55:36.553095+05');


--
-- Data for Name: permit_signatures; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: privileged_access_events; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: privileged_identities; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: team_position_capabilities; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c65d612b-07f2-4ded-9e6b-d5154702107f', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c65d612b-07f2-4ded-9e6b-d5154702107f', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5913e395-524e-4770-bbfc-639bdf22376e', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5913e395-524e-4770-bbfc-639bdf22376e', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('890d3d37-1625-467c-97b2-2dc625255c8b', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('890d3d37-1625-467c-97b2-2dc625255c8b', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('d752dc1f-aa4f-4d85-a83c-ad7859ed7629', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('d752dc1f-aa4f-4d85-a83c-ad7859ed7629', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b8ca9454-9277-4c64-ada1-9273bef241b1', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b8ca9454-9277-4c64-ada1-9273bef241b1', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b2899f06-3723-4831-b4a9-18285b03ef3a', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b2899f06-3723-4831-b4a9-18285b03ef3a', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('56f19dd0-1508-479f-a8e1-332ad408db10', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('56f19dd0-1508-479f-a8e1-332ad408db10', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('96eff16b-a699-4a2b-95fa-f3e1947d1412', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('96eff16b-a699-4a2b-95fa-f3e1947d1412', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('d079090f-78c4-451f-81ec-0b3478eb7484', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('d079090f-78c4-451f-81ec-0b3478eb7484', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('662536f0-a638-466c-8a73-3c0a5322e098', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('662536f0-a638-466c-8a73-3c0a5322e098', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('24290a81-f8dd-4b61-88d4-6dd25b9096ae', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('24290a81-f8dd-4b61-88d4-6dd25b9096ae', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b1efafba-54bc-49b6-862d-b1d804c3f341', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('b1efafba-54bc-49b6-862d-b1d804c3f341', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c44f2eb9-61fc-45b8-8b57-84b1e9c73eef', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c44f2eb9-61fc-45b8-8b57-84b1e9c73eef', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('744a6ee6-a548-4460-8d43-48395ea43790', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('744a6ee6-a548-4460-8d43-48395ea43790', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('f05e7225-8b1e-438d-b2ce-587224712734', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('f05e7225-8b1e-438d-b2ce-587224712734', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('57d41d38-62dd-46f2-957f-47eed64fbdb1', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('57d41d38-62dd-46f2-957f-47eed64fbdb1', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('6b82d323-8dc4-44a3-8da4-e08ea832bb5b', '009b5ea4-b03c-4669-92d7-4fca1a9d5abc', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('6b82d323-8dc4-44a3-8da4-e08ea832bb5b', '12f0a5cb-59ab-468a-bbac-ee6e3ba90799', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '25d722ec-7b92-4854-9f5b-a6e293a38197', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', 'c4485b9e-fc7f-4f8c-aad1-262d905b2312', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '46ebb84e-c069-43f4-815b-fdc0a21113b0', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', 'fd23e056-e3bd-4e28-8537-1730cf82314a', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '13c2ca06-8f2c-4682-9a9b-af4cb1cd70df', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '4aece5c4-4111-46d1-a3bf-1960dc107aae', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', '16340cbb-3c31-4027-ba70-5448122a184c', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', 'cbc806fc-e2cf-4ab9-8c6d-bd3aa2d388f4', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('e9166422-cdc0-4485-a40c-c904a4f78959', 'bc64ccac-a94b-40e1-9c64-adb6fae1dd17', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c65d612b-07f2-4ded-9e6b-d5154702107f', '9ae92b84-0f7b-4e64-a95e-9381abfb38df', '2026-09-25 18:55:36.038691+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5913e395-524e-4770-bbfc-639bdf22376e', '9ae92b84-0f7b-4e64-a95e-9381abfb38df', '2026-09-25 18:55:36.038691+05');


--
-- Data for Name: user_capability_grants; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: user_team_positions; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: whatsapp_outbox_messages; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Data for Name: workforce_profiles; Type: TABLE DATA; Schema: permit; Owner: -
--



--
-- Name: account_audit_events_ordinal_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.account_audit_events_ordinal_seq', 1, false);


--
-- Name: jsa_number_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.jsa_number_seq', 1, false);


--
-- Name: organization_audit_events_ordinal_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.organization_audit_events_ordinal_seq', 1, false);


--
-- Name: permit_lifecycle_events_ordinal_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.permit_lifecycle_events_ordinal_seq', 1, false);


--
-- Name: permit_number_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.permit_number_seq', 1, false);


--
-- Name: privileged_access_events_ordinal_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.privileged_access_events_ordinal_seq', 1, false);


--
-- Name: user_capability_grants_ordinal_seq; Type: SEQUENCE SET; Schema: permit; Owner: -
--

SELECT pg_catalog.setval('permit.user_capability_grants_ordinal_seq', 1, false);


--
-- PostgreSQL database dump complete
--
