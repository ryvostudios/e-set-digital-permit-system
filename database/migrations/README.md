# Migrations

Versioned, plain SQL migration files, applied in filename order by
`backend/src/db/migrate.ts` (run with `npm run migrate` from `backend/`).

## Convention

- Filename: `NNNN_description.sql`, e.g. `0001_create_users_table.sql`.
- `NNNN` is a zero-padded, monotonically increasing sequence number.
- Each file is applied exactly once, inside its own transaction, and
  recorded in the `schema_migrations` table (created automatically).
- Migrations are never edited or renamed after being applied to any
  shared environment — a mistake is corrected with a new migration.
- No down/rollback files: forward-only migrations, consistent with this
  project's append-only/immutable-history principles (see `DATABASE.md`).

## Live migration state

- `0001`-`0016`: applied and live-verified.
- `0013_notifications_outbox_documents.sql`: live verification confirmed
  RLS on every new application table, no direct `anon`/`authenticated`
  grants, no new policies, and active immutable-snapshot protections. The
  live database contained zero already-issued permits, so its historical
  backfill processed zero rows.
- `0014_fix_trigger_function_search_paths.sql`: applied and live-verified;
  both functions have `search_path=pg_catalog`, remain SECURITY INVOKER,
  and no longer produce `function_search_path_mutable` warnings.
- `0015_backend_integrity_hardening.sql`: **APPLIED / LIVE-VERIFIED**. Adds
  fail-closed account access, Company/Other
  integrity, versioned snapshot hashes, intended PDF identity, monotonic
  notification receipts, immutable WhatsApp business fields, and
  same-permit lifecycle linkage. Live checks confirmed migration id 15,
  complete ACTIVE Auth-user backfill, RLS/default-deny and zero browser grants
  or policies on both new tables, invoker-mode triggers with pinned search
  paths, active constraints, clean existing data, and no remaining temporary
  hash helper. `0001`-`0015` are now immutable applied history.

- `0016_permit_jsa_business_forms.sql`: **APPLIED / LIVE-VERIFIED**. Adds
  the workforce signing-identity model
  (`workforce_profiles`), permit/JSA business form content (permit
  template + versioned, strictly-validated JSONB payloads plus derived
  relational projections), authoritative digital signatures
  (`permit_signatures`), and widens the document renderer allowlist to
  include `PDFKIT_V2`. Its live application and integrity checks were
  verified. Its deployment established these continuing invariants:
  1. It **aborts** if any permit is already beyond `DRAFT` - those rows
     predate the form model and their form content cannot be invented.
     This guard remains part of immutable applied history.
  2. It seeds **no** workforce profiles. Until a user is provisioned
     with a profile and a valid primary Team + Position, every action
     that would produce a signature (submit, resubmit, CRO forward, HSE
     approve, CRO fallback approve, renew) fails closed. Provisioning is
     an explicit, separate step performed after this migration.

- `0017_employee_account_password_management.sql`: **APPLIED / LIVE-VERIFIED**. Adds `app_user_access.must_change_password`
  (default FALSE, so no existing identity is retroactively locked out),
  DB-authoritative credential timestamps, monotonic credential versions,
  and a reset-pending marker; extends migration 0015's
  `app_user_access_authoritative_timestamps()` so the credential
  timestamp is database-authoritative too (all pre-existing behaviour
  preserved); adds the append-only, free-text-free `account_audit_events`
  table with DB-authoritative event time; adds default-false explicit
  Site Manager assignability to Team + Positions; and seeds the
  `employee.create` / `employee.reset_password` capability NAMES. It
  marks no assignment TRUE and creates no organization data - no team, position,
  team_position, workforce profile, employee, or privileged grant.

  The restricted `app_runtime` role needs the account-management privilege
  delta documented in DEPLOYMENT.md.

- `0018_employee_company_membership.sql`: **APPLIED / LIVE-VERIFIED**.
  Adds the backend-only `companies` reference table, seeds
  exactly `E_SET` / E-SET, `ZPL` / ZPL, and `SGRE` / SGRE with deterministic
  identifiers, and adds one required `company_id` to each workforce profile -
  so a NORMAL employee has exactly one company, structurally (one profile row
  per user, one NOT NULL foreign key, no join table). It does not infer
  company from email, Auth metadata, Team, Position, or any other mutable
  hint. The migration therefore aborts before changing schema when any
  workforce profile already exists; an operator must first supply an
  authoritative reviewed mapping in a controlled deployment plan rather than
  inventing values.

  `company_id` is NOT NULL rather than nullable because
  `workforce_profiles` is the ORGANIZATIONAL employee store only:
  migration 0016's composite foreign key already requires a Team + Position
  the same user holds, so a privileged system identity (CEO, E-SET
  SITE_MANAGER) has no row there at all and needs no company. 0018 adds a
  trigger enforcing that direction in the database - a user holding an
  active CEO/SITE_MANAGER grant cannot be given a workforce profile - so no
  path can fabricate an E-SET company, an Admin team, or a "Site Manager"
  position for a privileged account merely to satisfy NOT NULL columns.

  It creates no organization data - no team, position, team_position,
  workforce profile, employee, or privileged grant - and no capability
  mapping. The new table has RLS enabled, no browser grants, and no
  policies; both new functions are SECURITY INVOKER with a pinned
  `search_path`. See DEPLOYMENT.md for the exact runtime-role privilege
  delta (a single `SELECT` on `public.companies`), which was applied in the
  same maintenance window.

  Live verification confirmed: applied to a database with zero workforce
  profiles and zero active privileged grants; recorded exactly once in
  `schema_migrations`; exactly the three seeded companies; the `company_id`
  column, its RESTRICT foreign key and `workforce_profiles_company_idx`
  present; RLS enabled with zero policies; real `anon` and `authenticated`
  SELECT both PERMISSION DENIED; both new functions SECURITY INVOKER with
  `search_path=pg_catalog` and zero SECURITY DEFINER; and, through the real
  `app_runtime` pool, SELECT on `companies` succeeding while INSERT, UPDATE,
  DELETE, TRUNCATE and `schema_migrations` access are all denied.

- `0019_privileged_identity_and_assignment_history.sql`: **APPLIED /
  LIVE-VERIFIED**. Adds `privileged_identities` (the
  authoritative display name of a CEO / E-SET SITE_MANAGER, with no
  company, team or position); closes the privileged/employee invariant in
  its second direction by refusing a privileged GRANT or identity for any
  user holding a workforce profile (a REVOKE is never blocked); binds
  every team to exactly one company and enforces that an employee's
  company owns the team behind their assignment; and adds
  `started_at`/`ended_at` to `user_team_positions` with a partial unique
  index giving each user exactly one CURRENT assignment while preserving
  every past one. It refuses to run if any team or assignment already
  exists, or if any user already holds both a profile and an active
  privileged grant - none of which it will guess or silently repair. It also
  adds `record_site_manager_grant()` - the ONLY `SECURITY DEFINER`
  function in the schema - which a SEPARATE operator-created
  `privileged_runtime` login executes. The ordinary runtime role receives
  neither INSERT on `privileged_access_events` nor EXECUTE on that
  function (0019 revokes it defensively if the role exists), so
  possession of the ordinary database credential alone cannot grant
  SITE_MANAGER. The role the function writes is a hardcoded literal, not
  a parameter, so CEO is unreachable by any argument. The other five new functions are SECURITY
  INVOKER; all six pin `search_path` to `pg_catalog` and fully qualify
  every object. The new table is RLS-enabled with no policies and no
  browser grants.

- `0020_organization_launch_seed.sql`: **APPLIED / LIVE-VERIFIED**. Seeds the confirmed launch organization - 7 teams, 12
  positions, 18 Team + Position combinations - marks all 18 approved for
  employee provisioning, and seeds the initial capability mapping using
  only capability NAMES already seeded by 0005/0009/0017. Permit
  application goes to all combinations except E-SET E-BOP CRO; CRO
  workflow authority and the CRO-only operational actions go to E-SET
  E-BOP CRO alone; `permit.hse_review` goes to E-SET HSE Team Lead and
  Paramedic alone. It creates no table, function, trigger, policy or
  grant and needs no `app_runtime` privilege change, refuses to seed into
  a non-empty organization, and ends with a self-verification block that
  fails the migration if the resulting authorization shape is wrong.

- `0021_privileged_function_execute_lockdown.sql`: **APPLIED /
  LIVE-VERIFIED**. Removes the Supabase default `EXECUTE` grant that
  `service_role` received on `public.record_site_manager_grant`, which
  0019's role-listed REVOKE could not remove because it did not name that
  role. Live verification found the function's ACL was
  `{postgres=X/postgres, service_role=X/postgres}`; it is now
  `{postgres=X/postgres}`. The migration re-asserts the full intended
  lockdown and ends with a self-verification block that fails rather than
  leave the privileged function over-granted. It does NOT address the
  broader, pre-existing fact that `service_role` holds full DML on every
  application table - see DEPLOYMENT.md for that outstanding decision.

- `0022_service_role_privilege_hardening.sql`: **APPLIED / LIVE-VERIFIED**. Revokes from the Supabase `service_role` every
  write privilege on `privileged_access_events`, `privileged_identities`
  and `initial_ceo_bootstrap`, all privileges on
  `privileged_access_events_ordinal_seq`, and EXECUTE on
  `record_site_manager_grant` - closing the last path by which a holder
  of the Supabase service key could manufacture CEO or SITE_MANAGER
  authority directly through PostgREST. SELECT is retained on all of
  them. It issues REVOKEs only: no table, function, trigger, policy or
  column is created or altered, no other schema or role is touched, and
  no `app_runtime` privilege changes. A self-verification block proves
  each denial with `has_*_privilege` and fails the migration otherwise,
  while confirming the operator/owner bootstrap path still works.

- `0023_employee_lifecycle_and_user_permissions.sql` through
  `0027_service_role_function_hardening.sql`: **APPLIED / LIVE-VERIFIED**.
  Their exact new `app_runtime` delta is:
  `SELECT, INSERT` on `user_capability_grants`; `USAGE` on its ordinal
  sequence; `UPDATE(display_name, company_id, primary_team_position_id)`
  on `workforce_profiles`; and `UPDATE(ended_at)` on
  `user_team_positions`. Neither employee table receives table-level
  UPDATE, and no identity/assignment key column is writable. See
  `DEPLOYMENT.md` for the executable grant statements.

  Migration 0025 removes all public application table/sequence mutation
  from `service_role`; 0027 removes its inherited EXECUTE from every
  non-extension public application function. Live effective-privilege and
  rolled-back attempt audits verified both boundaries.

- `0032_pdf_renderer_v3.sql`: **APPLIED / LIVE.**
  Widens the document renderer allowlist a second time, to admit
  `PDFKIT_V3`: the renderer that draws the issued PDF as the controlled
  form it is (masthead, identity band, numbered sections, bordered field
  grids, checklist bands with the printed YES/NO/N-A columns, tick grids,
  signature bands), so the PDF and the on-screen document read as one
  piece of paperwork.

  The allowlist is **widened, never replaced** — `PDFKIT_V1` and
  `PDFKIT_V2` stay valid — and the migration touches no data at all:

  1. Every `GENERATED` document keeps its bytes, its file hash and its
     storage object. Nothing is re-rendered or re-hashed.
  2. Every job that already pinned a `renderer_version` keeps it, and the
     application renders that job with that renderer. A V1/V2 job is
     never re-rendered by V3.
  3. Only a job that has pinned nothing yet — a permit issued after this
     deploys — establishes `PDFKIT_V3`.

  The document estate is therefore intentionally mixed afterwards:
  permits issued before it keep the document they were issued with, which
  is the correct outcome for an immutable record rather than something to
  correct with a backfill. It aborts if any job row carries a
  renderer identity outside the allowlist.

  No form contract, snapshot, snapshot hash, capability, policy or grant
  is touched.

- `0033_per_permit_type_numbering.sql`: **APPLIED / LIVE.** Gives each
  permit type its own number series, allocated by a database-side
  per-type counter (`permit_number_counters` +
  `allocate_permit_sequence()`) under a row lock, with uniqueness
  enforced per `(permit_type, permit_sequence)` rather than globally. The
  JSA series is untouched and remains one global sequence. It renumbered
  nothing: each type's counter was seeded from the highest number that
  type already held.

- `0034_permit_number_on_submission.sql`: **APPLIED / LIVE.** Recorded in
  the migration ledger and verified on the live project; there is no
  outstanding migration. It moves ALLOCATION from 0033's `BEFORE INSERT`
  trigger to the `DRAFT -> submitted` transition, so a draft never
  consumes a permit number:

  1. `permit_sequence` becomes nullable, and a DRAFT is always NULL —
     typed or untyped, newly created or saved a hundred times, and
     whatever number a request tries to supply.
  2. The number is issued inside the submitting transaction, from the
     permit type's own counter. A submission that fails or rolls back
     leaves an unnumbered DRAFT and consumes nothing.
  3. Once issued it is permanent: it cannot be changed, cleared, or
     stripped by pushing the permit back to DRAFT, and it is never
     recycled.
  4. Two constraints make the rule structural rather than conventional:
     `permits_draft_is_unnumbered` and
     `permits_sequence_required_after_draft`.

  It aborts if any non-DRAFT permit has no number. Drafts that 0033 had
  already numbered are RELEASED (set back to NULL) — those numbers were
  never in the operational register, because nothing was ever submitted
  under them — and no counter is rewound, so a released number is never
  reused. Nothing submitted, issued or closed is altered.

  0033's counter table, allocator function and unique indexes are reused
  unchanged; only its trigger is replaced.

  UAT-verified on the live project: drafts carry no number; a number is
  issued on the first successful submission and never afterwards changes;
  and each type draws from its own series - `CW-1`, `CW-2`, `HW-1`,
  `WTG-1`, `CS-1` were all observed. The JSA series remains one
  independent global sequence.

- `0035_dynamic_organization_management.sql`: **APPLIED / LIVE. EXPAND
  STEP of an EXPAND -> DEPLOY -> CONTRACT rollout** - it is compatible
  with BOTH the currently deployed backend and the new one, so it is
  applied FIRST, with no outage. It adds `permits.applicant_company_id`
  but does NOT yet require it, so a backend that does not write the
  column still satisfies `permits_applicant_identity_complete`. The
  CONTRACT migration that makes the column mandatory is deliberately
  NOT in this directory yet: `npm run migrate` applies every pending
  file in one batch and cannot target a single migration, so a `0036`
  here would be applied in the same run and close the compatibility
  window immediately. Phase 1
  of runtime Organization Management. Adds `deactivated_at` to
  `companies`, `teams` and `team_positions` (deliberately NOT to
  `positions`, which is a globally shared vocabulary row); normalized
  unique name indexes on all three of companies/teams/positions; a
  `companies_code_format` CHECK and a trigger making `companies.id` and
  `companies.code` immutable; deactivation guards that refuse to retire a
  record while an ACTIVE employee depends on it and refuse any
  deactivation that would push a REQUIRED capability below its coverage
  minimum - an explicit two-entry list (`permit.cro_review`,
  `permit.hse_review`, minimum 1 each, derived from the two places
  `workflowSideEffects.ts` fails closed), NOT a global "every capability
  needs a holder" rule, and bounded by `LEAST(minimum, current)` so an
  already-degraded requirement blocks only actions that reduce it
  further, never unrelated ones;
  insert guards so an inactive company/team/association accepts no new
  structure and no new assignment; the append-only
  `organization_audit_events` table; and
  `grant_baseline_applicant_capabilities()` - a bounded SECURITY DEFINER
  function whose capability names are LITERALS, so runtime organization
  management can attach `permit.create` + `permit.submit` and nothing
  else.

  It also makes the permit applicant company authoritative:
  `permits.applicant_company_id` is a real foreign key to `companies`,
  backfilled deterministically from the frozen `applicant_company_code`,
  and the completeness CHECK's closed `IN ('E_SET','ZPL','SGRE')` list
  becomes "present and non-blank" plus that foreign key. The freeze
  trigger is extended to the new column. `permits.company` /
  `company_other` and their CHECKs are NOT touched - that column is the
  printed FORM field (0006), not identity, and 0024 already settled that
  it stays as it is.

  It seeds no organization data and deactivates nothing. A
  self-verification block re-asserts the launch shape afterwards: 3
  companies with unchanged codes/names, 7 teams, 12 positions, 18
  associations, exactly 1 `permit.cro_review` holder and exactly 2
  `permit.hse_review` holders. Verified by
  `backend/src/db/migration0035.test.ts`, which runs the real SQL.

  This migration INTENTIONALLY SUPERSEDES 0020's "organization structure
  is operator-owned" decision; see DECISIONS.md. It needs the
  `app_runtime` privilege delta documented in DEPLOYMENT.md - which is a
  PHASE 2 prerequisite, not a Phase 1 one, without
  which the new domain code cannot write.

- `0036_permit_applicant_company_contract.sql`: **APPLIED / LIVE.
  CONTRACT STEP** of the rollout 0035 began. 0035 is live and the
  `dba7922` backend is deployed, so the compatibility window it opened
  can now be closed. 0036:

  1. refuses to run if any permit's `applicant_company_code` does not
     resolve to EXACTLY ONE `companies` row - checked before anything is
     written, so an unresolvable code aborts with a clear message rather
     than being silently skipped by the backfill's join;
  2. backfills `applicant_company_id` for the deployment-overlap rows,
     resolving by code and inventing nothing;
  3. fails if any completed applicant identity still lacks its
     authoritative company;
  4. tightens `permits_applicant_identity_complete` so a COMPLETED
     identity must carry all four columns, `applicant_company_id`
     included. A permit with NO applicant identity - every DRAFT - keeps
     all four NULL and remains valid; nothing here forces a draft to
     have an applicant.

  It rewrites no frozen snapshot: `applicant_company_code` and
  `applicant_company_name` keep exactly the values 0024 froze, and only
  the missing id is filled. It touches no organization object, creates
  no table, function, trigger, sequence, policy or grant, and therefore
  needs NO `app_runtime` privilege change. The organization-management
  grants remain a Phase 2 prerequisite.

  **ROLLBACK IS CLOSED AFTER THIS MIGRATION.** A backend older than
  `dba7922` writes the three legacy snapshot columns and not
  `applicant_company_id`; against the contracted constraint that write
  fails with `23514`, so permit SUBMIT and RENEW both break. Reads are
  unaffected (an older SELECT list never names the column). Rolling back
  past `dba7922` therefore requires a forward migration relaxing the
  constraint, deployed first. Verified by
  `backend/src/db/migration0036.test.ts`, which runs the real 0035 and
  0036 SQL in sequence.

- `0037_organization_management_runtime_privileges.sql`: **NOT YET
  APPLIED.** The Phase 2 runtime privilege delta. 0035 created the
  organization objects and granted `app_runtime` nothing on them - Phase
  1 mounted no mutation route, so nothing could write and granting early
  would have widened the runtime role before anything used it. Phase 2
  mounts the routes, so the minimum privileges are granted here, in a
  forward migration rather than by editing live history.

  It grants exactly ten privileges, each mapping to a statement that
  exists in `domain/accounts/organization.ts` / `organizationAudit.ts`:
  INSERT on `companies`, `teams`, `positions`, `team_positions` and
  `organization_audit_events`; `UPDATE (deactivated_at)` on the three
  lifecycle tables; USAGE on the audit ordinal sequence; and EXECUTE on
  `grant_baseline_applicant_capabilities(UUID)`.

  It deliberately grants NO rename (`UPDATE (name)` on companies/teams -
  no rename endpoint exists), no `UPDATE` on `companies.code`/`id`, no
  `UPDATE` on `positions` (no lifecycle column by design), no direct
  write on `team_position_capabilities` (the bounded SECURITY DEFINER
  function stays the only capability write path), and no DELETE or
  TRUNCATE anywhere.

  REVOKES RUN BEFORE GRANTS, and that order is load-bearing: PostgreSQL
  cannot subtract a column from a table-level grant, so any table-level
  `UPDATE` is cleared first and the precise column-level grants then
  re-establish the intended surface. That also makes the migration
  CORRECTIVE - an environment where someone granted too much by hand is
  brought back to the intended surface by running it - and idempotent.

  It creates no table, function, trigger, policy, sequence or column and
  changes no data; it adjusts privileges only, and skips with a NOTICE
  where the operator-created `app_runtime` role does not exist. Verified
  by `backend/src/db/migration0037.test.ts`, which asserts both that
  every required privilege is present and that every forbidden one is
  absent.

Migrations are added section by section as each is implemented. Permit
and JSA business schema (permits, JSAs, audit tables, etc.) is added in
later, scoped implementation sections — not here.
