# Permit in the shared E-Set database

Permit is moving into the company's existing ESDMS Supabase/PostgreSQL
project as an isolated schema, `permit`, beside ESDMS (`public`) and, later,
Attendance (`attendance`). The platform contract is defined in the ESDMS
repository (`docs/PLATFORM_DATABASE_ARCHITECTURE.md` and
`docs/PLATFORM_MIGRATION_PLAN.md`). This document covers only what the Permit
repository implements for it.

**Status:** the namespace foundation (Phase 2) and Permit-owned authentication
(Phase 3 branch) are built and verified on disposable local databases only.
Nothing has been installed in any real database. Standalone production still
uses Supabase Auth; the Phase 3 branch does not.
The standalone Permit database keeps using its historical ledger
(`public.schema_migrations`) and is not touched by this change. The runner in
this change only operates on schema `permit` and refuses to run against the
standalone database (no `permit` schema). Do not deploy it to the standalone
environment. Any standalone hotfix migration needs the previous runner.

## Namespace

- Every Permit object lives in schema `permit`. The runner refuses to run if
  its role can create anything in `public`, and refuses to commit a
  migration that leaves the migration role owning anything outside `permit`.
- Application SQL is unqualified and resolves through the role's
  `search_path = pg_catalog, permit, pg_temp`. `public` is never on the path,
  so an ESDMS object such as `public.positions` (a different table from
  Permit's `positions`) can never be picked up by accident.
- The privileged calls are explicitly qualified as
  `permit.record_site_manager_grant` and `permit.provision_site_manager`
  (`backend/src/db/privilegedPool.ts`).
- There are no cross-schema references to ESDMS. The only external reference
  was transitional: the 20 user foreign keys to Supabase `auth.users` are
  deferred from the fresh baseline and recreated against `permit.users` by
  Phase 3 migration 0039. See [PERMIT_OWNED_AUTH.md](PERMIT_OWNED_AUTH.md).

## Roles

Provisioned by `database/roles/provision-permit-roles.sql` (run by the
database administrator; passwords read from the environment, never
printed). All three are `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
NOCREATEROLE NOREPLICATION NOINHERIT` with no role memberships.

| Role | Used by | Privileges |
| --- | --- | --- |
| `permit_migrator` | `npm run migrate` (`MIGRATION_DATABASE_URL`) | Owns schema `permit` and every Permit object. Nothing outside it. |
| `permit_runtime` | API (`DATABASE_URL`) | The explicit set in `database/baseline/0038_permit_privileges.sql` plus 0039's narrow user/session column grants, with RLS policies on the tables it uses. No DDL, no ledger, no bootstrap state. |
| `permit_privileged` | CEO Site Manager grants and provisioning (`PRIVILEGED_DATABASE_URL`) | `EXECUTE` on `permit.record_site_manager_grant` and `permit.provision_site_manager` only. No table DML. |

**BYPASSRLS is gone.** The standalone `app_runtime` had BYPASSRLS with RLS
enabled and no policies. BYPASSRLS applies to the whole database, so in a
shared database it would bypass row security in every schema. Instead,
`permit_runtime` gets one pass-through policy per table, `TO permit_runtime`
only. That gives the same behaviour as before, confined to `permit`. Table
and column privileges still decide which commands are possible.

**Where the runtime privilege set comes from.** Migrations 0001–0038 grant
only later deltas. The base `app_runtime` grants were applied by hand and
never recorded in a migration. The set in `0038_permit_privileges.sql` is
labelled per line:

- **[M]:** granted by a migration.
- **[D]:** recorded in `DEPLOYMENT.md`.
- **[C]:** reconstructed from the backend's SQL.

Before production, the **[C]** lines must be reconciled against the live
standalone database's catalog (read-only) in the data-migration rehearsal.

## Baseline installation

The 38 historical migrations were written for `public` and for Supabase
roles, and some of them sweep privileges across `public`. Replaying them in
the shared database would affect ESDMS objects. Permit is therefore installed
from a verified baseline of its state at 0038:

| File | Content |
| --- | --- |
| `database/baseline/0038_permit_schema.sql` | Generated. Every table, sequence, constraint, index, function, trigger and RLS flag, in `permit`. |
| `database/baseline/0038_permit_reference_data.sql` | Generated. The seeded catalog rows (capabilities, companies, launch organization, permit-number counters). |
| `database/baseline/0038_permit_privileges.sql` | Hand-written. Default-deny, the runtime and privileged grants, RLS policies, and a self-verification that aborts the installation on any violation. |
| `database/baseline/manifest.json` | SHA-256 of every historical migration and every baseline file. |

**How the baseline was generated** (`database/baseline/tools/generate-baseline.sh`,
disposable cluster only):

1. Replay 0001–0038 into `public` under a local Supabase emulation.
2. Run `ALTER SCHEMA public RENAME TO permit`. The catalog moves every
   OID-bound reference.
3. Rewrite the two things PostgreSQL stores as text, and verify that each
   rewritten reference names a Permit object:
   - `public.` references in function bodies;
   - function `search_path` settings.
4. Dump the result.

Intentional differences from the replay:

- **Schema:** `permit` instead of `public`.
- **Owner:** `permit_migrator`.
- **Ledger:** `permit.schema_migrations`.
- **SECURITY DEFINER functions:** `search_path = pg_catalog, pg_temp`.
- **Three invoker functions** that resolved names through `public` now
  resolve them through `permit`.
- **RLS policies:** added for `permit_runtime`.
- **Browser roles:** no `PUBLIC` or browser-role privileges anywhere.

`backend/src/db/permitBaseline.test.ts` proves structural equivalence object
by object against a fresh replay, allowing only those differences.

**Ledger and history.** The first run of `npm run migrate` against an empty
`permit` schema does the following in one transaction:

1. Checks every historical migration file and every baseline file against
   `manifest.json`.
2. Installs the baseline.
3. Records `0001`–`0038` in `permit.schema_migrations` with
   `applied_via = 'baseline:permit_0038_v1'` and each file's content hash.

The historical files stay in `database/migrations/` unchanged and remain
the audited history. The standalone database's own ledger remains the
record of when they were actually applied. Later runs refuse to continue if
any recorded file has been edited.

`npm run migrate -- --baseline-without-reference-data` installs the baseline
without the seeded rows. Use it only when the installation is the target of
a data migration that brings the real rows with their original identifiers.

## Rules for migrations 0039 and later

- Operate on schema `permit` only; qualify names as `permit.<object>`.
- Every new table: `ENABLE ROW LEVEL SECURITY`. If `permit_runtime` gets any
  privilege on it, also create
  `CREATE POLICY permit_runtime_access ON permit.<t> TO permit_runtime USING (true) WITH CHECK (true)`.
- Grant `permit_runtime` only what the code uses. Prefer column-level
  `UPDATE`. Never `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, DDL or
  ledger access.
- Never grant to `PUBLIC`, `anon`, `authenticated` or `service_role`. New
  functions are not executable by `PUBLIC` by default.
- `SECURITY DEFINER` functions set `search_path = pg_catalog, pg_temp` and
  qualify every object.
- No `public.` objects, no cross-schema references, no role or database
  changes.

The runner enforces the boundary before every commit. A migration that
creates anything outside `permit`, leaves a Permit table without RLS, grants
to `PUBLIC` or a browser role, or gives `permit_runtime` a table without its
policy is rolled back and not recorded.

The Permit advisory lock (`7298183340`) is unchanged and does not collide
with ESDMS's node-pg-migrate lock. **Platform migration lock (Phase 6).**
`npm run migrate` and `npm run data:import-standalone` also take the shared
E-Set platform lock (`1163085140`). ESDMS `db:release` and the Attendance
migration and import tools take the same key. It is a non-blocking try: while
another application's release holds it, the Permit runner stops with
"Another E-Set platform migration or release holds the platform lock"
before any DDL. The API never takes it.

## Moving existing data: `npm run data:import-standalone`

**Order**
1. Provision the roles.
2. Run `npm run migrate -- --baseline-without-reference-data`. This installs
   the baseline and 0039-0042 into an empty `permit` schema. 0039 refuses
   if identity references already hold data, so the import comes after it.
3. Run the import:

```bash
STANDALONE_DATABASE_URL=<standalone, read-only login> \
MIGRATION_DATABASE_URL=<shared database, permit_migrator> \
  npm run data:import-standalone                  # dry run (default)
  npm run data:import-standalone -- --execute     # import, verify, commit
  npm run data:import-standalone -- --verify      # re-reconcile, read-only
```

The tool is `backend/src/db/standaloneImport.ts`.

**Transactions and locks**
- The source is read in one read-only, repeatable-read snapshot.
- The target is written in **one** transaction as `permit_migrator`,
  holding the platform lock and the Permit migration lock.
- The target must not already hold history. A second import is refused;
  use `--verify` instead.

**1. Identities**
- `auth.users` is mapped to `permit.users` through the legacy-import
  contract (`domain/auth/legacyImport.ts`): UUID kept, email normalized,
  only supported bcrypt, and duplicates or unknown formats refused.
- Every value in the 20 former `auth.users` reference columns must name an
  imported identity (`missing_identity` otherwise).
- Accounts without a password are refused unless
  `--allow-accounts-without-password` is given for an approved controlled
  reset.

**2. Copy**
- Every standalone table is copied parents first, with USER triggers
  disabled for the transaction (they stamp new rows) and foreign keys
  enforced. Renewals are copied oldest first.
- Every sequence is set to its standalone position, then triggers are
  re-enabled.

**3. Verification, before commit**
- per-table row count and an order-independent digest over every column
  (timestamps in UTC);
- the identity set (ids, normalized emails, imported hashes);
- zero unresolved references in the 20 relationships;
- sequence positions;
- permit and JSA sequence ranges (the report samples).

Rows that migrations after 0038 seed, such as 0041's CMS capability, are
recognised and excluded from the comparison.

**Modes and exit codes**
- A dry run does all of it and rolls back.
- The report holds counts, digests, ids of problem rows and hash-format
  prefix counts, never emails, hashes or content.
- The exit code is 2 when anything does not reconcile.

After import, the first sign-in with a correct imported bcrypt password
succeeds and is upgraded to Argon2id in the same transaction (see
PERMIT_OWNED_AUTH.md).

**Tests**
- `src/db/standaloneImport.test.ts`: refusals, dry run, execute, all 20
  relationships, first login and upgrade, verify, and refusal of a second
  import.
- `src/db/permitDataCompatibility.test.ts`: every row and sequence is
  identical.
- The synthetic standalone history is `src/test/standaloneHistory.ts`.

## Local disposable verification

Automated, in the normal suite (`npm test`, PGlite):

- `permitBaseline.test.ts`: structural equivalence and reference data.
- `permitPrivileges.test.ts`:
  - the exact runtime privilege set;
  - no privilege lost from the migrations;
  - privileges forbidden by `DEPLOYMENT.md` refused by the database;
  - `permit_privileged` limited to one function;
  - browser roles denied;
  - the real permit lifecycle run as `permit_runtime` under RLS.
- `migrate.test.ts`: baseline and ledger, fail-closed refusals, rollback of
  boundary violations, protection against editing recorded history.
- `permitDataCompatibility.test.ts`: historical rows preserved exactly.

Cross-application rehearsal (real PostgreSQL and a real ESDMS release),
`database/verify/shared-database-rehearsal.sh`:

```bash
PERMIT_REHEARSAL_DISPOSABLE_CLUSTER=yes PGHOST=localhost PGPORT=<port> \
PGUSER=<throwaway superuser> PGPASSFILE=<its passfile> \
ESDMS_BACKEND=<clean ESDMS backend export with node_modules, no .env> \
  database/verify/shared-database-rehearsal.sh
```

The rehearsal:

1. Releases ESDMS with its own `db:release`.
2. Takes an inventory of ESDMS.
3. Provisions the Permit roles and installs the baseline.
4. Proves the ESDMS inventory is byte-identical and that no Permit object
   is in `public`.
5. Proves the denials in both directions with real logins.
6. Re-runs both releases.

Never point either tool at a real database. Both refuse a non-localhost
`PGHOST`.

## Security invariants

1. No Permit role has `BYPASSRLS`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`,
   `REPLICATION` or a role membership.
2. Every Permit table has RLS enabled. Policies apply only to
   `permit_runtime`.
3. `PUBLIC`, `anon`, `authenticated` and `service_role` hold nothing in
   `permit`. The schema is not exposed through the Supabase Data API.
4. Permit roles own and can reach nothing in `public`. `esdms_runtime` can
   reach nothing in `permit`.
5. The ESDMS schema and ledger are unchanged by any Permit installation or
   migration.
6. Secrets and password hashes are never printed, logged or committed.

## Known open items

- **Private-bucket preflight:** resolved in Phase 4. The `storage.buckets`
  query is removed; readiness is checked through the Permit storage provider
  and Permit roles have no access to Supabase's `storage` schema
  (docs/STORAGE_AND_CMS.md).
- **Reconstructed grants:** the **[C]** runtime grants must be reconciled
  against the live standalone catalog.
- **Schema creation by the administrator:** on Supabase, the administrator
  may need `SET` membership in `permit_migrator` to create the schema with
  that owner. Verify during the rehearsal on the company project.
- **UAT reset script:** `database/maintenance/uat_reset_permit_numbering.sql`
  is a hand-run, armed-only tool for the standalone `public` database. In
  the shared database it aborts at its first `public.<table>` existence
  check, before deleting anything. It is not ported to `permit` and must
  never be used in production.
- **Identity foreign keys:** the 20 historical `auth.users` references are
  deferred from the fresh baseline and recreated against `permit.users` by
  0039. The role provisioning script grants no `auth` schema access.
