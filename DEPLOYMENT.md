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

## Manual production configuration decisions

These are real operator decisions this repository cannot make for you -
they depend on the actual deployment topology:

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
- **Applying migrations.** `database/migrations/0001`-`0011` are applied
  and live-verified against the current Supabase project
  (`yfxnigovfmngypbgcnaw`) - see `PROJECT_CONTEXT.md`. No migration was
  added by the production-hardening batch that introduced this
  document. Running `npm run migrate` (from `backend/`) against a new/
  different database applies whatever hasn't been applied yet, in
  order; nothing here changes that process.

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
