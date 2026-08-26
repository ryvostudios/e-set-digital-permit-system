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

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` are optional -
the backend starts and the full permit workflow (including issuance)
works without them. They gate exactly two things, both manual/
operator-run, never part of normal request handling: the CEO bootstrap
CLI and uploading the immutable issued Permit+JSA PDF to Supabase
Storage. Neither is configured in any environment as of this document's
last update - see "Manual production configuration decisions" below.

## Manual production configuration decisions

These are real operator decisions this repository cannot make for you -
they depend on the actual deployment topology:

- **`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET`.** Required
  before you can run `npm run bootstrap:ceo` or before generated Permit+
  JSA PDFs can actually be uploaded/downloaded. Create a PRIVATE
  (non-public) Storage bucket in the Supabase project first, set
  `SUPABASE_STORAGE_BUCKET` to its name (defaults to
  `issued-permit-documents` if you name it that), and set
  `SUPABASE_SERVICE_ROLE_KEY` to that project's service-role key from the
  Supabase Dashboard (Project Settings -> API). Never commit this value,
  never put it in any frontend-facing config, and never set it as
  `SUPABASE_PUBLISHABLE_KEY` (or vice versa - `env.ts` refuses to start
  if the two are identical). Until this is configured: PDF generation
  jobs stay in a retryable `PENDING`/`FAILED` state (permit issuance
  itself is completely unaffected), and `npm run bootstrap:ceo` refuses
  to run.
- **Provisioning the first CEO.** Run `npm run bootstrap:ceo` from
  `backend/`, with `SUPABASE_SERVICE_ROLE_KEY` configured and
  `BOOTSTRAP_CEO_EMAIL` / `BOOTSTRAP_CEO_PASSWORD` (and optionally
  `BOOTSTRAP_CEO_NAME`) set in the environment for that one invocation
  only. It creates or resolves the Supabase Auth user and grants CEO via
  the existing `privileged_access_events` model - see `DECISIONS.md` →
  "CEO Bootstrap". It refuses to run if an active CEO already exists.
  A database singleton reservation serializes concurrent initial runs.
  If Auth creation succeeds before a transient database failure, retry
  after the five-minute reservation lease reuses the matching Auth user
  rather than creating another identity.
  After a successful run: require a password change on that account's
  first login, enable MFA before production go-live, and remove
  `BOOTSTRAP_CEO_EMAIL`/`BOOTSTRAP_CEO_PASSWORD` from the environment -
  they have no further use once bootstrap succeeds, and leaving them set
  is an unnecessary credential to protect.
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
  wildcard (rejected by `env.ts` in production anyway).
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
- **Applying migrations.** `database/migrations/0001`-`0014` are applied
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
it. Confirm it is enabled for the production project before go-live;
this document is where that manual step is tracked, since no code
change here can verify or enforce it.

## Health vs. readiness

- `GET /api/v1/health` - liveness. Always 200 if the process is up; does
  no dependency checks. Use for "is the process alive" only.
- `GET /api/v1/ready` - readiness. Checks the database with a cheap
  `SELECT 1`; 200 if reachable, 503 otherwise. Use for "should traffic
  be routed to this instance."

Neither endpoint reveals connection strings, hostnames, or raw driver
error detail.

## Structured logs

Every request produces one JSON log line (method, path, status,
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
