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

- `0001`-`0015`: applied and live-verified.
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

Migrations are added section by section as each is implemented. Permit
and JSA business schema (permits, JSAs, audit tables, etc.) is added in
later, scoped implementation sections — not here.
