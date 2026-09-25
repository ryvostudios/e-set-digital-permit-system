#!/usr/bin/env bash
# Regenerates the `permit` baseline (database/baseline/0038_*.sql and
# manifest.json) from the historical migrations 0001-0038.
#
# DISPOSABLE LOCAL CLUSTER ONLY. It creates and drops its own scratch
# database, replays 0001-0038 into `public` under the Supabase platform
# emulation, renames that schema to `permit`, rewrites the text-stored
# references (tools/rewrite-namespace.sql) and dumps the result.
#
# Requirements: psql/pg_dump on PATH; PGHOST (localhost only), PGPORT,
# PGUSER (a superuser of the throwaway cluster) and a PGPASSFILE. No
# password is ever passed on the command line or printed.
#
#   PERMIT_BASELINE_DISPOSABLE_CLUSTER=yes database/baseline/tools/generate-baseline.sh
set -euo pipefail

if [[ "${PERMIT_BASELINE_DISPOSABLE_CLUSTER:-}" != "yes" ]]; then
  echo "Refusing: set PERMIT_BASELINE_DISPOSABLE_CLUSTER=yes to confirm a throwaway cluster." >&2
  exit 1
fi
case "${PGHOST:-}" in
  localhost|127.0.0.1|::1) ;;
  *) echo "Refusing: PGHOST must be localhost for baseline generation." >&2; exit 1 ;;
esac

TOOLS="$(cd "$(dirname "$0")" && pwd)"
BASELINE="$(dirname "$TOOLS")"
MIGRATIONS="$(cd "$BASELINE/../migrations" && pwd)"
DB=permit_baseline_replay
PSQL=(psql --no-psqlrc -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres <<SQL
DROP DATABASE IF EXISTS $DB;
DO \$\$ BEGIN
  -- Supabase's migration owner and the operator-created Permit roles, as
  -- they existed when 0001-0038 were applied.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN BYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'privileged_runtime') THEN
    CREATE ROLE privileged_runtime NOLOGIN NOBYPASSRLS NOINHERIT; END IF;
END \$\$;
CREATE DATABASE $DB OWNER postgres;
SQL
"${PSQL[@]}" -d $DB -c "ALTER SCHEMA public OWNER TO postgres"
"${PSQL[@]}" -d $DB -f "$TOOLS/supabase-platform-emulation.sql"
"${PSQL[@]}" -d $DB -c "ALTER DATABASE $DB SET search_path = \"\$user\", public, extensions"
# The historical runner's ledger, which 0003 hardens.
PGOPTIONS="-c role=postgres" "${PSQL[@]}" -d $DB -c "CREATE TABLE public.schema_migrations (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"

count=0
for file in "$MIGRATIONS"/[0-9][0-9][0-9][0-9]_*.sql; do
  # The baseline represents the standalone history, 0001-0038. Later
  # migrations are shared-database migrations applied by the runner.
  [[ $((10#$(basename "$file" | cut -c1-4))) -le 38 ]] || continue
  PGOPTIONS="-c role=postgres" "${PSQL[@]}" -d $DB -1 -f "$file" >/dev/null 2>&1 \
    || { echo "Replay failed at $(basename "$file")" >&2; exit 1; }
  count=$((count + 1))
done
[[ $count -eq 38 ]] || { echo "Expected 38 historical migrations, found $count" >&2; exit 1; }

"${PSQL[@]}" -d $DB <<'SQL'
-- Remove the platform emulation; only Permit-owned objects remain.
DROP EVENT TRIGGER rls_auto_enable_trigger;
DROP FUNCTION public.rls_auto_enable();
-- The historical ledger stays with the historical database; the shared
-- installation records its history in permit.schema_migrations (runner).
DROP TABLE public.schema_migrations;
ALTER SCHEMA public RENAME TO permit;
-- The 20 user foreign keys to Supabase's auth.users are NOT part of the
-- installed baseline: migration 0039 re-creates each one, with the same
-- name, columns and ON DELETE action, against permit.users. Deferring them
-- means a shared-database installation never needs any privilege on the
-- Supabase-managed auth schema. backend/src/db/permitBaseline.test.ts
-- proves exactly these 20 are the difference.
DO $defer$
DECLARE
  fk record;
  deferred int := 0;
BEGIN
  FOR fk IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
             WHERE contype = 'f' AND confrelid = 'auth.users'::regclass LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    deferred := deferred + 1;
  END LOOP;
  IF deferred <> 20 THEN
    RAISE EXCEPTION 'expected 20 auth.users foreign keys to defer, found %', deferred;
  END IF;
END
$defer$;
SQL
"${PSQL[@]}" -d $DB -f "$TOOLS/rewrite-namespace.sql"

header() {
  cat <<EOF
-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Regenerate with database/baseline/tools/generate-baseline.sh.
--
-- $1
--
-- Source: Permit migrations 0001-0038 (hashes in manifest.json), replayed on
-- a disposable cluster and moved from schema public to schema permit.
-- Installed only by the Permit migration runner, as permit_migrator, in
-- one transaction together with 0038_permit_privileges.sql.
EOF
}

strip_dump() {
  # Drop psql-only \restrict lines, the schema's own CREATE/COMMENT (the
  # schema is provisioned by database/roles/provision-permit-roles.sql),
  # dump-tool noise, and the PostgreSQL 17-only transaction_timeout setting
  # (the target server may be older); keep every object definition verbatim.
  grep -v -E '^\\(un)?restrict ' \
    | grep -v -E '^CREATE SCHEMA permit;$|^COMMENT ON SCHEMA permit IS ' \
    | grep -v -E '^-- Dumped (from|by) ' \
    | grep -v -E '^SET transaction_timeout = 0;$'
}

{ header "Permit schema objects at migration 0038 (tables, sequences, constraints, indexes, functions, triggers, RLS)."
  pg_dump -d $DB --schema=permit --schema-only --no-owner --no-privileges --no-tablespaces | strip_dump
} > "$BASELINE/0038_permit_schema.sql"

{ header "Permit reference data at migration 0038 (seeded catalog rows and sequence positions). Omitted when installing as a data-migration target."
  pg_dump -d $DB --schema=permit --data-only --column-inserts --no-owner --no-privileges | strip_dump
} > "$BASELINE/0038_permit_reference_data.sql"

# Exactly one trailing newline (pg_dump ends with blank lines).
perl -0pi -e 's/\n+\z/\n/' "$BASELINE/0038_permit_schema.sql" "$BASELINE/0038_permit_reference_data.sql"

"${PSQL[@]}" -d postgres -c "DROP DATABASE $DB"

node "$TOOLS/write-manifest.mjs"
echo "Baseline regenerated from $count migrations."
