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

Migrations are added section by section as each is implemented. Permit
and JSA business schema (permits, JSAs, audit tables, etc.) is added in
later, scoped implementation sections — not here.
