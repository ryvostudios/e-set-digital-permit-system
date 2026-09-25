#!/usr/bin/env bash
# DISPOSABLE LOCAL REHEARSAL of the shared E-Set database:
#   ESDMS in `public` (released by ESDMS's own `npm run db:release`)
#   + Permit in `permit` (provision-permit-roles.sql + the Permit runner)
# in ONE throwaway database, then proves:
#   * ESDMS's schema, grants, functions, triggers, policies, ledger and
#     roles are byte-identical before and after Permit is installed;
#   * no Permit object lands in `public`;
#   * permit_runtime / permit_privileged cannot reach ESDMS, and
#     esdms_runtime cannot reach Permit (real logins, real refusals);
#   * both releases are re-runnable afterwards (ESDMS db:release passes
#     again; the Permit runner has nothing pending).
#
# Never point this at a real database. Requirements:
#   PERMIT_REHEARSAL_DISPOSABLE_CLUSTER=yes
#   PGHOST=localhost, PGPORT, PGUSER (superuser of a throwaway cluster),
#   PGPASSFILE for that superuser
#   ESDMS_BACKEND=<an ESDMS backend checkout with node_modules and NO .env>
# All role passwords are generated into a private temporary directory,
# never printed, and deleted on exit. Reports go to REHEARSAL_REPORT_DIR
# (default: a new temporary directory, printed at the end).
set -euo pipefail

[[ "${PERMIT_REHEARSAL_DISPOSABLE_CLUSTER:-}" == "yes" ]] \
  || { echo "Refusing: set PERMIT_REHEARSAL_DISPOSABLE_CLUSTER=yes for a throwaway cluster." >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1|::1) ;; *) echo "Refusing: PGHOST must be localhost." >&2; exit 1 ;; esac
[[ -d "${ESDMS_BACKEND:-}/node_modules" ]] || { echo "ESDMS_BACKEND must be an ESDMS backend checkout with node_modules." >&2; exit 1; }
[[ ! -e "$ESDMS_BACKEND/.env" ]] || { echo "Refusing: ESDMS_BACKEND contains a .env; use a clean export." >&2; exit 1; }

VERIFY="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$VERIFY/../.." && pwd)"
DB=eset_platform_rehearsal
REPORT="${REHEARSAL_REPORT_DIR:-$(mktemp -d)}"
SECRETS="$(umask 077 && mktemp -d)"
trap 'rm -rf "$SECRETS"' EXIT
PSQL=(psql --no-psqlrc -X -q -v ON_ERROR_STOP=1)
ESDMS_TABLES="users,employees,employee_personal_details,employee_compensation_records,ipos,ipo_lines,material_demand_pricing_lines,cloud_storage_connections,governance_audit_log,positions,pgmigrations"

ROLES=(esdms_owner esdms_runtime permit_migrator permit_runtime permit_privileged)
for role in "${ROLES[@]}"; do (umask 077 && openssl rand -hex 24 > "$SECRETS/$role"); done
{ cat "$PGPASSFILE"; for role in "${ROLES[@]}"; do echo "$PGHOST:$PGPORT:$DB:$role:$(cat "$SECRETS/$role")"; done; } > "$SECRETS/pgpass"
chmod 600 "$SECRETS/pgpass"
url() { echo "postgresql://$1:$(cat "$SECRETS/$1")@$PGHOST:$PGPORT/$DB"; }
as_role() { local role=$1; shift; PGPASSFILE="$SECRETS/pgpass" PGUSER="$role" "${PSQL[@]}" -d "$DB" "$@"; }

step() { printf '\n== %s\n' "$1"; }

step "1. Fresh database with the Supabase platform state"
"${PSQL[@]}" -d postgres <<SQL
DROP DATABASE IF EXISTS $DB;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esdms_owner') THEN
    CREATE ROLE esdms_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB; END IF;
END \$\$;
SQL
PW="$(cat "$SECRETS/esdms_owner")" "${PSQL[@]}" -d postgres <<'SQL'
\getenv pw PW
ALTER ROLE esdms_owner PASSWORD :'pw';
SQL
"${PSQL[@]}" -d postgres -c "CREATE DATABASE $DB OWNER esdms_owner"
"${PSQL[@]}" -d "$DB" -c "ALTER SCHEMA public OWNER TO esdms_owner"
"${PSQL[@]}" -d "$DB" -f "$VERIFY/platform-stub.sql"

esdms_release() {
  (cd "$ESDMS_BACKEND" && \
    MIGRATION_DATABASE_URL="$(url esdms_owner)" DATABASE_URL="$(url esdms_runtime)" \
    ESDMS_RUNTIME_PASSWORD="$(cat "$SECRETS/esdms_runtime")" npm run --silent db:release) \
    > "$REPORT/$1" 2>&1 || { echo "ESDMS db:release failed (see $REPORT/$1)" >&2; exit 1; }
}
permit_migrate() {
  (cd "$REPO/backend" && \
    MIGRATION_DATABASE_URL="$(url permit_migrator)" DATABASE_URL="$(url permit_runtime)" DB_SSL=false \
    SUPABASE_URL=https://placeholder.supabase.test SUPABASE_PUBLISHABLE_KEY=placeholder SITE_TIMEZONE=Asia/Karachi \
    npx tsx src/db/migrate.ts) > "$REPORT/$1" 2>&1 || { echo "Permit migrate failed (see $REPORT/$1)" >&2; exit 1; }
  tail -1 "$REPORT/$1"
}
inventory() { "${PSQL[@]}" -d "$DB" -f "$VERIFY/esdms-public-inventory.sql" > "$REPORT/$1"; }

step "2. ESDMS release (its own db:release: migrate, provision esdms_runtime, verify)"
esdms_release esdms-release-1.log
echo "ESDMS migrations applied: $("${PSQL[@]}" -d "$DB" -Atc 'SELECT count(*) FROM public.pgmigrations')"
inventory esdms-before.txt
echo "ESDMS inventory lines: $(wc -l < "$REPORT/esdms-before.txt" | tr -d ' ')"

step "3. Provision Permit roles and the empty permit schema"
PERMIT_MIGRATOR_PASSWORD="$(cat "$SECRETS/permit_migrator")" PERMIT_RUNTIME_PASSWORD="$(cat "$SECRETS/permit_runtime")" \
PERMIT_PRIVILEGED_PASSWORD="$(cat "$SECRETS/permit_privileged")" PERMIT_TRANSITIONAL_AUTH_FK=yes \
  psql --no-psqlrc -X -q -d "$DB" -f "$REPO/database/roles/provision-permit-roles.sql"

step "4. Permit runner as permit_migrator (installs the 0038 baseline)"
permit_migrate permit-migrate-1.log

step "5. ESDMS unchanged"
inventory esdms-after.txt
diff -u "$REPORT/esdms-before.txt" "$REPORT/esdms-after.txt" > "$REPORT/esdms-diff.txt" \
  || { echo "ESDMS CHANGED - see $REPORT/esdms-diff.txt" >&2; exit 1; }
echo "ESDMS inventory identical ($(wc -l < "$REPORT/esdms-after.txt" | tr -d ' ') lines)"
public_permit=$("${PSQL[@]}" -d "$DB" -Atc "
  SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.relnamespace = 'public'::regnamespace AND r.rolname LIKE 'permit\_%'")
[[ "$public_permit" == 0 ]] || { echo "Permit objects found in public" >&2; exit 1; }
echo "Permit objects in public: 0"

step "6. Role attributes and ownership"
"${PSQL[@]}" -d "$DB" -At <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged', 'esdms_runtime')
              AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'an application role has an elevated attribute';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
              WHERE r.rolname LIKE 'permit\_%' AND c.relnamespace <> 'permit'::regnamespace
                AND c.relnamespace <> 'pg_toast'::regnamespace) THEN
    RAISE EXCEPTION 'a Permit role owns a relation outside schema permit';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
              WHERE r.rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged')) THEN
    RAISE EXCEPTION 'a Permit role is a member of another role';
  END IF;
END $$;
SELECT rolname || ': super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createdb=' || rolcreatedb
       || ' createrole=' || rolcreaterole || ' inherit=' || rolinherit
  FROM pg_roles WHERE rolname IN ('permit_migrator', 'permit_runtime', 'permit_privileged', 'esdms_runtime') ORDER BY 1;
SQL

step "7. Cross-application denial (real logins)"
for role in permit_runtime permit_privileged; do
  as_role "$role" -v esdms_tables="$ESDMS_TABLES" -f "$VERIFY/permit-cannot-reach-esdms.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'
done
as_role esdms_runtime -f "$VERIFY/esdms-cannot-reach-permit.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'

step "8. Permit runtime login resolves Permit names through its own schema"
as_role permit_runtime -At -c "SELECT 'search_path=' || current_setting('search_path') || ' schemas=' || current_schemas(false)::text || ' permits_visible=' || (SELECT count(*) FROM permits) || ' seeded_capabilities=' || (SELECT count(*) FROM capabilities)"

step "9. Both releases are re-runnable in the shared database"
esdms_release esdms-release-2.log
echo "ESDMS db:release passed again with Permit installed"
inventory esdms-after-rerelease.txt
diff -u "$REPORT/esdms-before.txt" "$REPORT/esdms-after-rerelease.txt" > "$REPORT/esdms-rerelease-diff.txt" \
  || { echo "ESDMS re-release changed ESDMS - see $REPORT/esdms-rerelease-diff.txt" >&2; exit 1; }
permit_migrate permit-migrate-2.log

step "Rehearsal passed. Reports: $REPORT"
