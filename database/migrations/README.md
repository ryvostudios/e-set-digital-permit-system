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

Migrations are added section by section as each is implemented. Permit
and JSA business schema (permits, JSAs, audit tables, etc.) is added in
later, scoped implementation sections — not here.
