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

No migrations exist yet. Business schema (permits, JSAs, users,
teams/positions, capabilities, audit tables, etc.) is added in later,
scoped implementation sections — not here.
