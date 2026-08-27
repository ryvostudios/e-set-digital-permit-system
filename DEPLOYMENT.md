# Deployment

This document is deployment/operations reference, separate from the
design-intent documents (`ARCHITECTURE.md`, `SECURITY.md`, `DATABASE.md`,
`DECISIONS.md`). It lists what an operator must actually configure or
decide when deploying `backend/` to a real environment, and the current,
honest constraints of the production-hardening implemented so far. It is
not itself authoritative about workflow/business rules - see
`DECISIONS.md` for that.

## Required environment variables

See `backend/.env.example` for the full, documented list. At minimum,
production needs: `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SITE_TIMEZONE`, `CORS_ALLOWED_ORIGINS`. The
backend fails fast (refuses to start) if any required variable is
missing or invalid for the current `NODE_ENV` - see
`backend/src/config/env.ts`. This includes a check that
`SUPABASE_PUBLISHABLE_KEY` isn't accidentally a service-role/secret key
(both the legacy JWT and the new `sb_secret_...` key shape are rejected).

`MIGRATION_DATABASE_URL` is required only by `npm run migrate`; it must use
a deployment-owner login distinct from the restricted `DATABASE_URL`
runtime login. `SUPABASE_SERVICE_ROLE_KEY` is required by the operator-run
CEO bootstrap and by trusted request-side employee account management; it
remains server-only and those endpoints fail closed when it is absent. PDF
access uses the separate Storage-scoped S3 variables in `.env.example`.
Normal API startup does not require either privileged credential.

## Manual production configuration decisions

These are real operator decisions this repository cannot make for you -
they depend on the actual deployment topology:

- **Database roles (provisioned and live-verified).** `DATABASE_URL` uses the
  restricted `app_runtime` login; `MIGRATION_DATABASE_URL` uses the separate
  migration owner and is required only by `npm run migrate`. The normal API
  must never use or fall back to the migration credential. `app_runtime` has
  `LOGIN` and `BYPASSRLS` solely so the backend can operate the intentional
  RLS/default-deny architecture, but is not superuser, cannot create roles or
  databases, does not inherit other roles, does not own the schema, and has no
  `CREATE`/DDL authority on `public`. Its application access is limited to the
  required table/sequence `SELECT` and DML privileges. In particular, the
  lookup tables `teams`, `positions`, and `team_positions` are `SELECT`-only
  (no INSERT, UPDATE, DELETE, or TRUNCATE). It has no access to
  `schema_migrations` or `initial_ceo_bootstrap`, no INSERT/sequence access for
  `privileged_access_events`, and no DELETE/TRUNCATE authority on application
  tables. For private-bucket preflight only, it has `USAGE` on `storage` and
  `SELECT` on `storage.buckets`. Browser `anon` and `authenticated` roles
  remain intentionally default-deny with zero direct application-table grants.
- **Employee account management (required before the feature works).**
  For a Site Manager to provision or reset employee accounts, an operator
  must, once, grant that person CEO or E-SET SITE_MANAGER privileged
  access via `privileged_access_events` (the CEO bootstrap CLI does this
  for the first CEO; Site Manager grants remain an operator/CEO action -
  there is still no grant service). That privileged role IS the account-
  management authority and is not grantable through the API.

  Do NOT additionally attach `employee.create` / `employee.reset_password`
  to a Team + Position for a privileged account, and do NOT create a Team,
  Position, or company membership for a CEO or Site Manager in order to
  give them one: a privileged system account has no Company, Team or
  Position, migration `0018` refuses in the database to give one a
  workforce profile, and the endpoints do not consult capabilities. The
  capability NAMES that migration `0017` seeds remain in the catalogue but
  now gate nothing; attaching them to an ordinary employee's Team +
  Position grants that employee no account-management authority whatsoever.

  Account management also requires `SUPABASE_SERVICE_ROLE_KEY`
  to be configured server-side; without it the endpoints return an
  explicit "unavailable" response rather than partially succeeding.
  Configure `SUPABASE_AUTH_ADMIN_TIMEOUT_MS` between 1,000 and 30,000ms
  (default 8,000ms). It is a hard AbortSignal-backed HTTP deadline, not a
  passive Promise timeout. Manager reset additionally uses transaction-local
  lock/statement/idle guards; at defaults, lock acquisition is bounded to 2
  seconds, Auth holds an acquired row lock for at most 8 seconds, and the DB
  terminates an unexpectedly idle reset transaction after 10 seconds.
  An operator/CEO must also explicitly set
  `team_positions.site_manager_assignable = TRUE` for each assignment that
  ordinary employee provisioning may use. The default is FALSE, migration
  `0017` marks none assignable, and no account-management endpoint can change
  this policy flag.

  The restricted `app_runtime` role needs this exact privilege delta
  after `0017` (verify each against the live role - several may already
  be granted):
  ```sql
  GRANT SELECT, INSERT, UPDATE ON TABLE public.app_user_access TO app_runtime;
  GRANT INSERT ON TABLE public.account_audit_events TO app_runtime;
  GRANT USAGE ON SEQUENCE public.account_audit_events_ordinal_seq TO app_runtime;
  GRANT SELECT, INSERT ON TABLE public.user_team_positions TO app_runtime;
  GRANT SELECT, INSERT ON TABLE public.workforce_profiles TO app_runtime;
  GRANT SELECT ON TABLE public.privileged_access_events TO app_runtime;
  ```
  No ownership, no DDL, no schema `CREATE`, no `DELETE`, no `TRUNCATE`,
  and no `schema_migrations` access is added. Supabase Auth Admin actions
  use the server-only Auth Admin credential, never the database runtime
  role.
  Manager employee-create/reset endpoints use the independent per-actor
  `RATE_LIMIT_MANAGER_ACCOUNT_MAX` budget (default 3 per configured window),
  below the default ten-connection pool. Self password change retains
  `RATE_LIMIT_ACCOUNT_MAX` so the manager bound does not impair recovery.

- **Employee company membership (migration 0018 applied and live-verified).**
  Every NORMAL employee's workforce profile must reference exactly one
  authoritative company. The migration seeds only the confirmed `E_SET` /
  E-SET, `ZPL` / ZPL, and `SGRE` / SGRE reference rows, and creates no team,
  position, team_position, profile, employee, or privileged grant. It
  intentionally aborts before creating any 0018 object if a workforce
  profile already exists, because no company may be inferred from email,
  Supabase metadata, Team, or Position. It was applied against zero
  workforce profiles and zero active privileged grants, so no mapping was
  needed; should it ever be re-run elsewhere, inspect the live profile
  population first and never bypass the guard with a guessed company.

  0018 also adds a database guard: a user holding an active CEO or
  SITE_MANAGER grant cannot be given a workforce profile at all. If a live
  privileged identity somehow already has one, that row must be resolved as
  a governance decision before applying 0018 - never by relaxing the guard.
  Note this means a privileged account has no display name, Company, Team,
  or Position anywhere in the schema, and therefore still no signing
  identity; privileged permit application is a separate, unimplemented task.

  The exact **new** `app_runtime` privilege 0018 requires - already applied
  and live-verified in the same maintenance window - is:
  ```sql
  GRANT SELECT ON TABLE public.companies TO app_runtime;
  ```
  That is the entire delta. It is not optional: `resolveSigningIdentity` and
  `/auth/me` both join `companies`, so the grant must land with the
  migration. Verified through the real runtime pool: `app_runtime` reads the
  three companies, while INSERT, UPDATE, DELETE and TRUNCATE on `companies`
  and all access to `schema_migrations` are denied. Existing 0017 privileges already cover inserting
  `company_id` as part of a workforce-profile row, and the new guard reads
  `privileged_access_events`, on which `app_runtime` already holds SELECT.
  Do not grant `app_runtime` INSERT, UPDATE, DELETE, or TRUNCATE on
  `companies`, sequence privileges, EXECUTE on the new trigger functions,
  ownership, DDL, schema `CREATE`, or migration-ledger access. Browser
  `anon` and `authenticated` roles remain default-deny with no table grants
  and no policies.

- **Privileged identity and launch organization (migrations 0019, 0020
  and 0021 are APPLIED and live-verified).** 0019 refuses to run
  if any team or assignment already exists, or if any user already holds
  both a workforce profile and an active privileged grant; 0020 refuses
  to seed into a non-empty organization. Verify all three counts are zero
  before applying, and never bypass a guard by deleting or reassigning
  data.

  Applied and verified live: 7 teams, 12 positions, 18 Team + Position
  combinations all `site_manager_assignable`, 17 permit-apply holders
  (E-SET E-BOP CRO excluded), exactly 1 CRO holder and exactly 2 E-SET HSE
  holders, and `employee.*` mapped to no Team + Position.

  The **applied** `app_runtime` privilege delta was:
  ```sql
  GRANT SELECT, INSERT ON TABLE public.privileged_identities TO app_runtime;
  ```
  That is the whole delta, and it contains nothing that can write
  privileged authority. 0020 requires no privilege change at all.

  **`app_runtime` must NOT receive, and 0019 defensively revokes:** INSERT
  (or any privilege) on `privileged_access_events`, USAGE on its
  `ordinal` sequence, and EXECUTE on
  `public.record_site_manager_grant(UUID, UUID, TEXT)`. This is the
  security boundary of the whole privileged tier. Granting EXECUTE to
  `app_runtime` was implemented and then rejected during review: it left
  possession of `DATABASE_URL` alone sufficient to grant SITE_MANAGER,
  because the caller can simply pass the real CEO's id as the actor.
  Route-level CEO checks mean nothing to someone speaking SQL directly,
  and that credential is the one every request already uses.

- **Dedicated privileged database role (operator-created, required before
  CEO Site Manager administration works).** Create a SEPARATE login and
  give the backend its connection string as `PRIVILEGED_DATABASE_URL`.
  Choose and store the password out of band - it must never appear in a
  migration, in source, in a doc example, in a test, or in git.

  ```sql
  -- Password supplied by the operator at creation time; never committed.
  CREATE ROLE privileged_runtime
    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

  GRANT CONNECT ON DATABASE <database> TO privileged_runtime;
  GRANT USAGE ON SCHEMA public TO privileged_runtime;
  GRANT EXECUTE ON FUNCTION
    public.record_site_manager_grant(UUID, UUID, TEXT) TO privileged_runtime;
  ```

  That is its COMPLETE privilege set. It must have no SELECT on any
  application table, no INSERT/UPDATE/DELETE/TRUNCATE anywhere, no schema
  `CREATE`, no ownership, no `schema_migrations` access, no sequence
  privileges, and no EXECUTE on any other function. It is neither the
  migration owner nor `postgres`, and the Supabase `service_role` key is
  not a database credential and must never be used as one. `NOBYPASSRLS`
  is deliberate: unlike `app_runtime` it never needs to read past RLS,
  because it reads nothing - the `SECURITY DEFINER` function does all the
  work under the function owner's rights.

  The backend uses this login through a small dedicated pool
  (`backend/src/db/privilegedPool.ts`, max 2 connections) whose exported
  surface is only `recordSiteManagerGrant` / `recordSiteManagerRevoke` -
  no pool, client, or generic query escapes it, so no permit, account, or
  notification service can reach through it.

  There are then TWO independent gates on every grant/revoke, neither
  sufficient alone: the HTTP layer re-resolves the authenticated caller as
  an active CEO, and the database function independently re-derives the
  supplied actor's CEO status. A leaked `app_runtime` credential passes
  neither, because it cannot reach the function at all.

  If `PRIVILEGED_DATABASE_URL` is absent the CEO-only Site Manager
  endpoints return a sanitized 503 (`privileged_management_unavailable`)
  and every other endpoint is unaffected - the backend starts and serves
  normally. Connection strings and passwords never reach a log line;
  database errors are sanitized through `toSafeDbErrorMessage`.

  **`service_role` privilege hardening (migration 0022 - APPLIED and
  live-verified).** Live verification of 0019/0020 found
  that Supabase's default privileges on schema `public` gave the built-in
  `service_role` full `INSERT/UPDATE/DELETE/TRUNCATE` on
  `privileged_access_events`, `privileged_identities` and
  `initial_ceo_bootstrap`, plus `rwU` on the grant log's sequence.
  `service_role` cannot log in directly (`rolcanlogin = false`) but is
  reachable through PostgREST with the Supabase service key, so a holder
  of that key could insert a CEO grant directly and bypass every other
  gate. Migration 0022 revokes exactly those write privileges (SELECT is
  retained) and re-asserts the function lockdown from 0021, then verifies
  its own result with `has_table_privilege` / `has_sequence_privilege` /
  `has_function_privilege` and fails the migration if anything remains.

  It is deliberately narrow: only those four objects. The `auth` and
  `storage` schemas, Supabase-managed functions, and every permit/JSA
  table are untouched, and `service_role` keeps all its other privileges.
  0022 requires no `app_runtime` privilege change and creates no object.

  Operational consequence: writing those four tables from the Supabase
  Studio table editor (which acts as `service_role`) will stop working;
  reading them still works. Confirm nothing in your Supabase workflow
  writes them before applying.

  Live-verified after applying: every one of INSERT, UPDATE, DELETE,
  TRUNCATE, TRIGGER and REFERENCES is now false for `service_role` on all
  three tables; USAGE/SELECT/UPDATE on the grant-log sequence are false;
  EXECUTE on the grant function is false and its ACL is
  `{postgres=X/postgres}`. SELECT is retained on all three tables. Proven
  by attempt as well as by catalog: under `SET LOCAL ROLE service_role`
  every write, `nextval`, and function call is rejected with
  `permission denied`, while SELECT still succeeds.

  Standing rule: Supabase's default privileges apply to every NEW table
  and sequence in `public`, so any future table holding authorization
  state must revoke them in its own migration.

  **Completed / live-verified by 0025 and 0027.** `service_role` now has
  zero effective INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES on every
  public application table, zero write privilege on every public sequence,
  and zero EXECUTE on every non-extension public application function.
  SELECT remains for read-only support tooling. Auth Admin continues to use
  the service credential over Supabase HTTP; it performs no application SQL.

  **Pre-existing gap this exposes:** `npm run bootstrap:ceo` connects with
  `DATABASE_URL` (`app_runtime`) and writes a CEO grant directly, so it
  needs INSERT on `privileged_access_events` AND access to
  `initial_ceo_bootstrap` - neither of which `app_runtime` has, and
  neither of which it should be given. That is why no CEO has ever been
  bootstrapped here. Run the one-time bootstrap under the **operator**
  credential (point `DATABASE_URL` at it for that single invocation)
  rather than widening the runtime role for an operator action. Note
  `privileged_runtime` cannot do it either: it can only grant
  SITE_MANAGER, never CEO.

  Do NOT grant `app_runtime` UPDATE or DELETE on `privileged_identities`,
  DELETE on `user_team_positions`, any privilege on `teams`, `positions`,
  `team_positions` or `team_position_capabilities` beyond the SELECT it
  already holds, ownership, DDL, schema `CREATE`, or migration-ledger
  access. Browser `anon` and `authenticated` remain default-deny with no
  table grants and no policies.

  Migrations 0023-0027 are **APPLIED / LIVE-VERIFIED**. Their exact new
  `app_runtime` privilege delta was applied by the migration owner:

  ```sql
  GRANT SELECT, INSERT
  ON TABLE public.user_capability_grants
  TO app_runtime;

  GRANT USAGE
  ON SEQUENCE public.user_capability_grants_ordinal_seq
  TO app_runtime;

  GRANT UPDATE (display_name, company_id, primary_team_position_id)
  ON TABLE public.workforce_profiles
  TO app_runtime;

  GRANT UPDATE (ended_at)
  ON TABLE public.user_team_positions
  TO app_runtime;
  ```

  These are column-level UPDATE grants. Do not replace either with
  table-level UPDATE, and do not grant UPDATE on `user_id`,
  `team_position_id`, `started_at`, timestamps, or other columns. No new
  DELETE, TRUNCATE, REFERENCES, TRIGGER, CREATE, ownership, or DDL access
  is required. The individual-capability table's database trigger permits
  only capabilities explicitly marked `individually_grantable` (currently
  only `permit.view_all`), so INSERT cannot manufacture workflow authority.

  Live catalog checks and rolled-back attempts confirmed both table-level
  UPDATE privileges remain false; identity/assignment key updates,
  privileged grants/functions/sequences, schema creation, bootstrap state,
  and the migration ledger are all denied to `app_runtime`.

  `BOOTSTRAP_CEO_NAME` is now REQUIRED by `npm run bootstrap:ceo`: a CEO
  is a privileged system account whose only identity field is their
  authoritative personal display name. The bootstrap refuses to adopt a
  pre-existing Auth identity that belongs to a normal employee.

- **Private PDF Storage.** Create the configured bucket manually as
  private (`public=false`), restrict MIME types to `application/pdf`, and
  set a sensible non-null size limit. Configure the four Storage S3
  variables and `SUPABASE_DOCUMENT_BUCKET`; do not use the Auth Admin
  service-role key. Worker/download preflight verifies the exact bucket
  metadata and fails closed without upload when privacy cannot be proved.
- **Provisioning the first CEO.** Run `npm run bootstrap:ceo` from
  `backend/`, with `SUPABASE_SERVICE_ROLE_KEY` configured and
  `BOOTSTRAP_CEO_EMAIL` / `BOOTSTRAP_CEO_PASSWORD` (and optionally
  `BOOTSTRAP_CEO_NAME`) set in the environment for that one invocation
  only. The restricted `app_runtime` role intentionally cannot access
  `initial_ceo_bootstrap` or insert `privileged_access_events`, so this
  isolated operator command also requires a separately authorized database
  login supplied as its `DATABASE_URL` for that invocation. Never start the
  normal API with that privileged connection. The command creates or resolves
  the Supabase Auth user and grants CEO via
  the existing `privileged_access_events` model - see `DECISIONS.md` →
  "CEO Bootstrap". It refuses to run if an active CEO already exists.
  A database singleton reservation serializes concurrent initial runs.
  If Auth creation succeeds before a transient database failure, retry
  after the five-minute reservation lease reuses the matching Auth user
  rather than creating another identity.
  After a successful run: require a password change on that account's
  first login, enable and live-verify privileged-account MFA before production
  go-live, and remove
  `BOOTSTRAP_CEO_EMAIL`/`BOOTSTRAP_CEO_PASSWORD` from the environment -
  they have no further use once bootstrap succeeds, and leaving them set
  is an unnecessary credential to protect.
- **Application account state.** Migration 0015 initializes every existing
  `auth.users` identity as ACTIVE. Every future server-side provisioning flow
  must insert the matching ACTIVE `app_user_access` row transactionally;
  missing rows fail closed. Offboarding changes the row to DISABLED with
  DB-authoritative timestamps instead of deleting the Auth identity/history.
  No public provisioning or disable endpoint is introduced here.
- **Running the WhatsApp outbox / PDF-generation processors.** Neither
  `npm run outbox:whatsapp:process` nor `npm run documents:process` is
  invoked automatically by this backend (no cron/scheduler exists in
  this codebase - see `ARCHITECTURE.md`'s scaling principle). Schedule
  them externally (platform cron, a scheduled job, etc.) at whatever
  interval fits actual usage once (respectively) a real WhatsApp provider
  is wired into `WhatsappProvider`
  (`backend/src/domain/notifications/whatsappOutbox.ts`) and Storage is
  configured. Running either command before that is safe - pending items
  simply stay pending/retryable with a clear "not configured" reason,
  never a false "sent"/"generated".
  Workers use atomic token-owned claims with five-minute leases and
  bounded retry delays. For PDF upload/crash recovery, an existing
  deterministic object is downloaded and hash-compared; a match is
  finalized, while a mismatch fails closed and is never overwritten.

- **`TRUST_PROXY_CIDRS`.** If this backend runs behind any reverse
  proxy/load balancer/ingress (nearly always true in production), this
  MUST list that proxy's real address(es)/network(s) - e.g.
  `10.0.0.5` or `10.0.1.0/24`, or the preset `loopback` if the proxy runs
  on the same host. Left unset (the default), every request appears to
  come from the proxy's own IP - collapsing all clients into one bucket
  for IP-keyed rate limiting and making `req.ip` useless for anything
  else. This is an explicit address/network **allowlist**, not a hop
  count: Express/proxy-addr trusts `X-Forwarded-For` only from a
  connection whose immediate peer address is actually in this list,
  walking backwards through the chain until it reaches one that isn't -
  see `backend/src/config/trustProxy.ts`. `env.ts` refuses to start if
  any entry isn't a real, specific IP/CIDR/preset - in particular, a
  literal `*` or a full-range wildcard (`0.0.0.0/0`, `::/0`) is always
  rejected, never silently accepted as "trust everything".
  **A trusted-proxy allowlist is not, by itself, a security boundary -
  see "Network topology requirement" below, which this list depends on
  being true.**
- **`CORS_ALLOWED_ORIGINS`.** The real, exact frontend origin(s) - no
  wildcard. Production accepts only canonical credential-free HTTPS root
  origins: no path, query, fragment, or userinfo.
- **Rate limit tuning** (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_GLOBAL_MAX`,
  `RATE_LIMIT_MUTATION_MAX`) - the shipped defaults are reasonable
  starting points, not measured for this deployment's actual traffic.
  Revisit them once real usage is observed, within the bounds `env.ts`
  enforces (1,000-3,600,000ms window; 1-10,000 global request max;
  1-1,000 mutation request max - values outside these fail startup, they
  are never silently clamped).
- **Database pool/timeout tuning** (`DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`,
  `DB_CONNECTION_TIMEOUT_MS`) - shipped defaults are reasonable; `env.ts`
  bounds each (1-100 connections; 0-3,600,000ms idle timeout;
  0-60,000ms connect timeout) so a typo can't silently create an
  unbounded pool or an overflowing internal timer value.

## Network topology requirement (required, not optional, in production)

`TRUST_PROXY_CIDRS` tells Express *which already-connected peer to
believe* about `X-Forwarded-For` - it cannot stop a client from
connecting to this backend directly in the first place. If the backend
process is reachable from the public internet at all, a client can
simply skip the reverse proxy, connect directly, and send whatever
`X-Forwarded-For` value it wants - the allowlist never even comes into
play, because the check is "does the immediate peer match", and the
attacker's own connection *is* the immediate peer. Trusting hop count or
addresses is therefore only meaningful under this additional,
non-negotiable requirement:

- **The backend's origin must not be publicly reachable except through
  the configured reverse proxy/load balancer.** Enforce this with actual
  network controls - a firewall, cloud security-group rule, or private
  network/VPC placement that makes the backend's listening port
  unreachable from the public internet by any path other than the
  proxy. `TRUST_PROXY_CIDRS` is not a substitute for this; it is only
  correct once this is true.
- The addresses/networks configured in `TRUST_PROXY_CIDRS` must actually
  match the real infrastructure (the proxy/load balancer's real,
  current address or subnet) - not a guess, not a placeholder, and not
  widened "to be safe."
- Never use a wildcard or all-address value for proxy trust (`env.ts`
  already refuses `*`, `0.0.0.0/0`, and `::/0` at startup - this is a
  hard rule, not a style preference).
- If the deployment platform's reverse proxy/load balancer's address(es)
  can change (autoscaling, IP rotation), `TRUST_PROXY_CIDRS` must be
  updated to match - a stale allowlist entry that no longer matches the
  real proxy silently falls back to "trust proxy disabled" behavior for
  that traffic (safe, but wrong `req.ip`), not a security hole; an
  allowlist entry that's too broad (e.g. an entire cloud provider's IP
  range instead of the specific load balancer) is the actual risk to
  avoid.
- **Database TLS** (`DB_SSL`, `DB_CA_CERT_PATH`) - production must use
  `DB_SSL=true` (enforced by `env.ts`); set `DB_CA_CERT_PATH` if the
  platform's default trusted CA store doesn't already cover Supabase's
  CA.
- **Applying migrations.** `database/migrations/0001`-`0015` are applied
  and live-verified against the current Supabase project
  (`yfxnigovfmngypbgcnaw`) - see `PROJECT_CONTEXT.md`. Migration
  `0012_permit_workflow_completion.sql` (the Send-Back/Hold/Resume/
  Cancel/Renewal schema) has been applied and live-verified: migration
  recorded, new workflow statuses/constraints live, hold/cancel
  invariants valid, renewal uniqueness active, lifecycle append-only
  protections intact, RLS/default-deny intact, no anon/authenticated
  direct grants, no new policies, no data-integrity violations found.
  Migration `0013_notifications_outbox_documents.sql` (notifications, the
  WhatsApp outbox, immutable issued-document snapshots and their PDF job
  state, and justified search/audit indexes) is applied and live-verified.
  Every new table has RLS enabled; there are no direct `anon`/
  `authenticated` grants or new policies; immutable snapshot protections
  are active. The live database contained zero already-issued permits, so
  its historical backfill had zero rows to process. Migration
  `0014_fix_trigger_function_search_paths.sql` is applied and live-
  verified: both affected functions have `search_path=pg_catalog`, both
  remain SECURITY INVOKER, and the two Security Advisor mutable-search-
  path warnings are gone. All five support-feature tables remain RLS-
  enabled, with zero direct `anon`/`authenticated` grants and zero added
  policies. No security regression was found; the Performance Advisor
  reports informational items only.
  Migration `0015_backend_integrity_hardening.sql` is **APPLIED / LIVE-
  VERIFIED**. Migration id 15 is recorded; the existing Auth user was
  backfilled ACTIVE; both new tables are RLS-enabled/default-deny with zero
  browser grants or policies; all integrity constraints and invoker-mode,
  `search_path=pg_catalog` triggers were verified; and no invalid company or
  snapshot-integrity data was found. The temporary hash helper is absent.
  Running `npm run migrate` (from `backend/`) against a database applies
  whatever hasn't been applied yet, in order; nothing here changes that
  process.

## Rate limiting - production scaling constraint

`backend/src/middleware/rateLimit.ts` implements rate limiting entirely
in-process, in-memory (`express-rate-limit`'s default `MemoryStore`) -
deliberately, per `ARCHITECTURE.md`'s "no infrastructure without an
actual current requirement" (this backend runs as a single instance
today).

**This is per-instance, not distributed.** If this backend is ever run
as more than one instance behind a load balancer:

- Each instance enforces the configured limits independently, so a
  client that gets routed across N instances can send up to roughly N
  times the configured limit.
- A client "counted" against the limit on one instance is invisible to
  another instance.

This is safe and correct for the project's current actual scale (one
deployable backend application - `ARCHITECTURE.md`'s "modular
monolith"). It is explicitly **not** horizontally-scalable rate
limiting, and must not be presented or relied on as such. If/when this
backend is horizontally scaled, replace the store with a shared one
(e.g. a Redis-backed `express-rate-limit` store) before doing so -
`buildRateLimiter` in `rateLimit.ts` is the single place that change
would be made.

## Supabase Auth: leaked-password protection

Supabase Auth offers a "leaked password protection" setting (checks
new/changed passwords against known-breach corpora) that is configured
in the Supabase Dashboard (Authentication -> Policies), not in this
repository - there is no migration or backend code path that controls
it. It is currently reported **disabled** and is a **GO-LIVE BLOCKER**.
Enable and live-verify it before go-live;
this document is where that manual step is tracked, since no code
change here can verify or enforce it.

Privileged-account MFA is likewise not yet enforced or live-verified and
remains a separate go-live blocker; ordinary permit routes must not acquire an
invented MFA requirement.

## Health vs. readiness

- `GET /api/v1/health` - liveness. Always 200 if the process is up; does
  no dependency checks. Use for "is the process alive" only.
- `GET /api/v1/ready` - readiness. Checks the database with a cheap
  `SELECT 1`; 200 if reachable, 503 otherwise. Use for "should traffic
  be routed to this instance."

Neither endpoint reveals connection strings, hostnames, or raw driver
error detail.

## Structured logs

Every request admitted by the application limiter produces one JSON log line (method, path, status,
duration, a correlation `requestId` - also echoed back as the
`X-Request-Id` response header). 401/403 responses additionally log an
`auth_failure`/`authz_failure` event; 5xx responses log a
`server_error`/`unhandled_error` event. Startup/shutdown produce their
own structured events. None of this ever includes the `Authorization`
header, a bearer token, cookies, or request/response bodies - see the
doc comment in `backend/src/middleware/requestLog.ts`. There is no log
aggregation/shipping configured here - logs go to stdout/stderr, and
capturing them (e.g. into a hosting platform's log viewer, or a real
log pipeline) is a deployment-environment concern, not something this
repository configures.

## What this batch deliberately did not add

Consistent with `ARCHITECTURE.md`'s scaling principle: no Redis, no
external log/metrics service, no APM agent, no container
orchestration-specific readiness/liveness probes beyond the two plain
HTTP endpoints above. Add these when an actual, current requirement
(not a hypothetical future one) justifies them.
