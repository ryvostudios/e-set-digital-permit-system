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

INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('119783fb-7776-4992-9ddb-5336bae1a803', 'permit.create', 'Create and edit a draft permit/JSA before submission', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('680809d7-29c7-4250-94e2-51ad6299fdf4', 'permit.submit', 'Submit a draft permit for CRO review', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('c07802b8-3c40-4f9e-b9f7-c000f419808f', 'permit.cro_review', 'Review a pending permit as CRO', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('c0775dce-efba-4394-a963-61fc6ecd15a6', 'permit.send_back', 'Send a permit back to the creator for correction', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('5ecbfa2f-3b81-47a1-8301-ae1416572d78', 'permit.hold', 'Place an issued permit on hold', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('6e43a54e-a986-4d59-ab5f-712b8c80189a', 'permit.resume', 'Resume a held permit', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('3538aaf2-5766-4a01-9577-1ddd7861e621', 'permit.cancel', 'Cancel a permit', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('3615cbfb-51ea-4f77-820d-2f714347f825', 'permit.forward_hse', 'Forward a CRO-reviewed permit to HSE for review', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('956065aa-08b8-45a6-b7b9-f3ae4149f332', 'permit.fallback_approve', 'CRO fallback approval after the HSE review window expires', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('f087729d-0428-48c4-855b-e078d290aebf', 'permit.renew', 'Renew a permit after midnight expiry', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('0c1cbc8a-bff9-4e4d-9f4d-0b49e19205ba', 'permit.close', 'Close an issued permit', '2026-09-25 19:08:06.421633+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('1c07d65c-1c06-4b60-bc55-9f03392dba54', 'permit.hse_review', 'Review a permit pending HSE review and approve it', '2026-09-25 19:08:06.576016+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('46a13b6f-2473-4e28-8b23-4024ce988615', 'employee.create', 'Provision a normal employee account (Site Manager account management)', '2026-09-25 19:08:06.917648+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('36a969a4-4816-4003-8160-73fa6ff0a26f', 'employee.reset_password', 'Set a new temporary password on a normal employee account', '2026-09-25 19:08:06.917648+05', false);
INSERT INTO permit.capabilities (id, name, description, created_at, individually_grantable) VALUES ('734a6000-26ea-4f1c-887e-844baf2b0021', 'permit.view_all', 'See every permit, historical and future, regardless of ownership or review queue', '2026-09-25 19:08:07.16835+05', true);


--
-- Data for Name: companies; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000001', 'E_SET', 'E-SET', '2026-09-25 19:08:06.960016+05', NULL);
INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000002', 'ZPL', 'ZPL', '2026-09-25 19:08:06.960016+05', NULL);
INSERT INTO permit.companies (id, code, name, created_at, deactivated_at) VALUES ('18000000-0000-4000-8000-000000000003', 'SGRE', 'SGRE', '2026-09-25 19:08:06.960016+05', NULL);


--
-- Data for Name: positions; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.positions (id, name, created_at) VALUES ('d0ba45fd-555f-4ec1-9874-c7f4f3f5d438', 'Admin Lead', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('1d8db251-5752-4ce3-baf0-bb03d0cbce52', 'Assistant Admin', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('08081046-6ac7-4bd0-854b-67deae685045', 'Team Lead', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('066bc3a7-aa5d-4ce6-819b-62e01537f96c', 'Supervisor', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('e360e3a7-625f-4940-a787-ab48dd88f6c8', 'Worker', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('73e9988f-9f6b-49ff-9b3c-154975cc10a4', 'Engineer', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('ef6343e5-5fa2-4dc8-b16f-65cbc2b6b2c3', 'Technician', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('a87ecf6c-7555-4184-8f95-bf859ae7af11', 'CRO', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('c65f8d2c-647d-4240-bb72-b8ebd705516c', 'Paramedic', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('e2518f4a-8949-4f26-9730-4825ef130f52', 'Site Manager', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('7c9df860-cc0f-4894-a009-1d9d20a15439', 'Asset Manager', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.positions (id, name, created_at) VALUES ('e330f199-9515-4f87-b64c-e1d32a6e03bf', 'HSE', '2026-09-25 19:08:07.047666+05');


--
-- Data for Name: teams; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('11f5689a-8e95-4324-948c-85e5086615fd', 'Admin', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('58929774-332f-430b-a48b-bd44c2a6661e', 'Civil', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('b37508e0-633d-44a6-bf4c-e1753551e666', 'WTG', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('1235e502-e009-416a-8f01-3ce4b4cb8fda', 'E-BOP', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('98d096cd-272a-426d-98d2-ed65ec16e818', 'HSE', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000001', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('721f6ca9-9173-47e0-a995-c4130b4545e8', 'ZPL', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000002', NULL);
INSERT INTO permit.teams (id, name, created_at, company_id, deactivated_at) VALUES ('42aa1964-a2f3-46fe-b551-a98be07e7335', 'SGRE', '2026-09-25 19:08:07.047666+05', '18000000-0000-4000-8000-000000000003', NULL);


--
-- Data for Name: team_positions; Type: TABLE DATA; Schema: permit; Owner: -
--

INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('27d5e13a-08d0-41e7-8fb9-8ea2bc82ece2', '98d096cd-272a-426d-98d2-ed65ec16e818', 'c65f8d2c-647d-4240-bb72-b8ebd705516c', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('631830e5-629c-4ff0-ac3d-7ea066628fd1', '98d096cd-272a-426d-98d2-ed65ec16e818', '08081046-6ac7-4bd0-854b-67deae685045', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('354502b0-0ad9-4800-b7f2-09ff9d4b67e2', '1235e502-e009-416a-8f01-3ce4b4cb8fda', 'ef6343e5-5fa2-4dc8-b16f-65cbc2b6b2c3', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '1235e502-e009-416a-8f01-3ce4b4cb8fda', 'a87ecf6c-7555-4184-8f95-bf859ae7af11', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('af79068c-7f1e-4eed-8012-681bcbaf61af', '1235e502-e009-416a-8f01-3ce4b4cb8fda', '08081046-6ac7-4bd0-854b-67deae685045', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('2d603d43-b803-4245-8cdc-f7b9b4d11e40', 'b37508e0-633d-44a6-bf4c-e1753551e666', 'ef6343e5-5fa2-4dc8-b16f-65cbc2b6b2c3', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('400aac19-9253-4034-ae9e-69d7e2112377', 'b37508e0-633d-44a6-bf4c-e1753551e666', '73e9988f-9f6b-49ff-9b3c-154975cc10a4', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('5ba8df12-b73e-4282-a885-7a611169814e', 'b37508e0-633d-44a6-bf4c-e1753551e666', '08081046-6ac7-4bd0-854b-67deae685045', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('5b2196c5-43b3-4b3d-a81b-3120ad8efbf6', '58929774-332f-430b-a48b-bd44c2a6661e', 'e360e3a7-625f-4940-a787-ab48dd88f6c8', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('1d91885a-93b6-4318-9f7f-3aada467717e', '58929774-332f-430b-a48b-bd44c2a6661e', '066bc3a7-aa5d-4ce6-819b-62e01537f96c', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('6916bdf2-8959-49a7-ac49-e1ad59cecfd1', '58929774-332f-430b-a48b-bd44c2a6661e', '08081046-6ac7-4bd0-854b-67deae685045', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('1597d47f-03b3-4c1b-8948-4e965b8a922d', '11f5689a-8e95-4324-948c-85e5086615fd', '1d8db251-5752-4ce3-baf0-bb03d0cbce52', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('43a497a8-10a3-491b-9f6b-616e4e256a8a', '11f5689a-8e95-4324-948c-85e5086615fd', 'd0ba45fd-555f-4ec1-9874-c7f4f3f5d438', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('c941f905-0e74-478e-b2fa-35c43fd5d2c3', '721f6ca9-9173-47e0-a995-c4130b4545e8', 'e330f199-9515-4f87-b64c-e1d32a6e03bf', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('2482d251-f383-4fc1-af6a-52316d316155', '721f6ca9-9173-47e0-a995-c4130b4545e8', '73e9988f-9f6b-49ff-9b3c-154975cc10a4', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('50eeb717-ff37-4842-9c35-01fdced86bb3', '721f6ca9-9173-47e0-a995-c4130b4545e8', '7c9df860-cc0f-4894-a009-1d9d20a15439', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('cce1245e-2b2c-44b5-a617-06cd4dae2869', '721f6ca9-9173-47e0-a995-c4130b4545e8', 'e2518f4a-8949-4f26-9730-4825ef130f52', '2026-09-25 19:08:07.047666+05', true, NULL);
INSERT INTO permit.team_positions (id, team_id, position_id, created_at, site_manager_assignable, deactivated_at) VALUES ('c35233e2-3a32-45ea-bff0-e85adbf98378', '42aa1964-a2f3-46fe-b551-a98be07e7335', '08081046-6ac7-4bd0-854b-67deae685045', '2026-09-25 19:08:07.047666+05', true, NULL);


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

INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('WTG_WORK', 1, '2026-09-25 19:08:07.585782+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('COLD_WORK', 1, '2026-09-25 19:08:07.585782+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('HOT_WORK', 1, '2026-09-25 19:08:07.585782+05');
INSERT INTO permit.permit_number_counters (permit_type, next_value, updated_at) VALUES ('CONFINED_SPACE_ENTRY', 1, '2026-09-25 19:08:07.585782+05');


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

INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('27d5e13a-08d0-41e7-8fb9-8ea2bc82ece2', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('27d5e13a-08d0-41e7-8fb9-8ea2bc82ece2', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('631830e5-629c-4ff0-ac3d-7ea066628fd1', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('631830e5-629c-4ff0-ac3d-7ea066628fd1', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('354502b0-0ad9-4800-b7f2-09ff9d4b67e2', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('354502b0-0ad9-4800-b7f2-09ff9d4b67e2', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('af79068c-7f1e-4eed-8012-681bcbaf61af', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('af79068c-7f1e-4eed-8012-681bcbaf61af', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('2d603d43-b803-4245-8cdc-f7b9b4d11e40', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('2d603d43-b803-4245-8cdc-f7b9b4d11e40', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('400aac19-9253-4034-ae9e-69d7e2112377', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('400aac19-9253-4034-ae9e-69d7e2112377', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5ba8df12-b73e-4282-a885-7a611169814e', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5ba8df12-b73e-4282-a885-7a611169814e', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5b2196c5-43b3-4b3d-a81b-3120ad8efbf6', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('5b2196c5-43b3-4b3d-a81b-3120ad8efbf6', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('1d91885a-93b6-4318-9f7f-3aada467717e', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('1d91885a-93b6-4318-9f7f-3aada467717e', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('6916bdf2-8959-49a7-ac49-e1ad59cecfd1', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('6916bdf2-8959-49a7-ac49-e1ad59cecfd1', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('1597d47f-03b3-4c1b-8948-4e965b8a922d', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('1597d47f-03b3-4c1b-8948-4e965b8a922d', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('43a497a8-10a3-491b-9f6b-616e4e256a8a', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('43a497a8-10a3-491b-9f6b-616e4e256a8a', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c941f905-0e74-478e-b2fa-35c43fd5d2c3', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c941f905-0e74-478e-b2fa-35c43fd5d2c3', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('2482d251-f383-4fc1-af6a-52316d316155', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('2482d251-f383-4fc1-af6a-52316d316155', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('50eeb717-ff37-4842-9c35-01fdced86bb3', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('50eeb717-ff37-4842-9c35-01fdced86bb3', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('cce1245e-2b2c-44b5-a617-06cd4dae2869', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('cce1245e-2b2c-44b5-a617-06cd4dae2869', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c35233e2-3a32-45ea-bff0-e85adbf98378', '119783fb-7776-4992-9ddb-5336bae1a803', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('c35233e2-3a32-45ea-bff0-e85adbf98378', '680809d7-29c7-4250-94e2-51ad6299fdf4', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', 'c07802b8-3c40-4f9e-b9f7-c000f419808f', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', 'c0775dce-efba-4394-a963-61fc6ecd15a6', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '5ecbfa2f-3b81-47a1-8301-ae1416572d78', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '6e43a54e-a986-4d59-ab5f-712b8c80189a', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '3538aaf2-5766-4a01-9577-1ddd7861e621', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '3615cbfb-51ea-4f77-820d-2f714347f825', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '956065aa-08b8-45a6-b7b9-f3ae4149f332', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', 'f087729d-0428-48c4-855b-e078d290aebf', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('14dd78e9-81e9-4807-b798-18645a612df0', '0c1cbc8a-bff9-4e4d-9f4d-0b49e19205ba', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('27d5e13a-08d0-41e7-8fb9-8ea2bc82ece2', '1c07d65c-1c06-4b60-bc55-9f03392dba54', '2026-09-25 19:08:07.047666+05');
INSERT INTO permit.team_position_capabilities (team_position_id, capability_id, created_at) VALUES ('631830e5-629c-4ff0-ac3d-7ea066628fd1', '1c07d65c-1c06-4b60-bc55-9f03392dba54', '2026-09-25 19:08:07.047666+05');


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
