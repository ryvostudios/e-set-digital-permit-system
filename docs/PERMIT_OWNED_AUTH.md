# Permit-owned authentication (Phase 3 branch)

This describes the `feature/permit-owned-auth` implementation for a **new,
disposable shared-database installation**. It has not been applied to the
standalone production Permit database. The production data cutover is a later
phase and requires a separate reviewed import and reconciliation runbook.

## Identity, authority, and sessions

`permit.users` owns login identity and credentials. User UUIDs remain the
identifiers used by Permit business records. `app_user_access`, workforce
profiles, Team and Position capabilities, and `privileged_access_events`
still decide authorization; a `permit.users` row alone grants no application
access. All new credentials are Argon2id. Supported imported bcrypt hashes
are verified once and upgraded to Argon2id in the same transaction that opens
the session. An unsupported hash is refused.

Login creates a random opaque token and stores only its SHA-256 digest in
`permit.user_sessions`. The browser receives a Permit-specific, HttpOnly,
host-only, SameSite=Lax cookie, Secure in production. Ordinary sessions
expire after 12 hours; remembered sessions after 14 days. The backend reads
the current session and account state on every protected request. Logout
revokes the database session. Manager reset and account disable revoke all
sessions; a required own-password change revokes the other sessions. Re-enable
does not revive old sessions. Cookie-authenticated mutations and login require
an allowlisted Origin or Referer.

The frontend calls only Permit backend auth endpoints. It does not keep an
access token in browser storage. It clears keys left by the retired Supabase
browser client without reading their values.

## Privileged Site Manager provisioning

The CEO route supplies its **server-resolved session ID**, never a
request-body actor ID, to `permit.provision_site_manager`. The function
rechecks the session's existence, expiry and revocation, the account's active
and password-change state, and the current CEO grant inside the database.
It creates the user, forced-change access row, privileged identity, and
append-only grant/audit event in one function call and one transaction. Any
failed insert rolls the whole operation back.

`permit_migrator` owns the SECURITY DEFINER function. It is a non-superuser
without BYPASSRLS; the function pins `search_path` to `pg_catalog, pg_temp`
and qualifies Permit objects. PUBLIC and browser roles have no EXECUTE.
`permit_privileged` has CONNECT, Permit schema USAGE, and EXECUTE only on
`permit.provision_site_manager` and the session-bound
`permit.record_site_manager_grant`; it has no table DML. The ordinary runtime
login cannot call either function.

## Fresh installation and later existing-data cutover

The fresh path installs the verified 0038 baseline, then migration 0039.
The baseline defers exactly 20 historical `auth.users` foreign keys; 0039
creates `permit.users` and recreates those keys against it with their original
columns and delete actions. The migration refuses to run if any identity
reference already contains data. This prevents an accidental in-place
production migration that could silently strand user references.

The later production cutover must use a copy of the standalone data in a
disposable rehearsal database first. The offline import must extract only the
required identity fields, preserve every UUID, reject missing or duplicate
identities and normalized email collisions, accept only approved bcrypt
formats, and handle accounts without passwords only by an explicitly
approved controlled reset. Import identities before Permit business rows,
validate every user foreign key and row count, and compare the full identity
set before allowing writes. `backend/src/domain/auth/legacyImport.ts` provides
the validation/import contract. `npm run data:import-standalone` (see
SHARED_DATABASE.md) applies it inside the full data import. It was rehearsed
on synthetic data only, and never connected to the production Supabase Auth
service. Production extraction, backup, object copy,
cutover, and rollback still require the separate migration phase.

Document storage's `storage.buckets` readiness query is a known later-phase
blocker under strict schema isolation. It has no extra database grant in this
phase.
