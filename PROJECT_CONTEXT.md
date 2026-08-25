# Project Context

## What This Is

E-Set Digital Permit System is a new, production Progressive Web
Application for managing work permits: creation, CRO review, HSE review,
issuance, hold/resume, cancellation, renewal, and closure, with full
audit history.

It will be developed in VS Code, version-controlled with Git/GitHub, and
built step by step, one verified section at a time.

## Relationship to Other Systems

- **E-Set Digital Management System** — a separate, unrelated application.
  This project shares no code, database, or deployment with it.
- **V5.19 legacy permit system** — a business/workflow reference only.
  Its rules around numbering, CRO/HSE review, and closure inform this
  system's workflow requirements, but its technical architecture must
  not be copied into this system. Notably, V5.19's `SYSTEM_ADMIN` role is
  **not** assumed to exist here (see [[DECISIONS.md]]).

## Current State (as of this document)

Implementation has begun and proceeds section by section, per
`SECURITY.md`'s development gate. This is a snapshot, not authoritative
requirements - the other documents in this set (and `DECISIONS.md`'s
Open Decisions) govern what's actually confirmed or still unresolved.

- Backend: Node.js + Express + TypeScript app (Supabase Auth token
  verification, CORS, environment validation, PostgreSQL connection pool
  and migration runner).
- Frontend: React + Vite + TypeScript PWA scaffold with Supabase Auth;
  no permit-workflow UI has been built yet.
- Database: migrations `0001`-`0011` exist under `database/migrations/`
  and are already applied to the live Supabase project
  (`yfxnigovfmngypbgcnaw`) - Supabase security hardening; Team + Position
  -> Capabilities authorization; privileged-access [CEO/Site Manager]
  data-model foundation; Permit/JSA schema; CRO review and HSE review
  with 5-minute fallback approval; CRO-only permit closure; and the
  permit-status read-performance index.
  Migration `0011_permit_status_index.sql` has been applied and
  live-verified successfully. See `database/migrations/README.md`.
- Backend permit domain (`backend/src/domain/permits/`,
  `backend/src/routes/permits.ts`, `backend/src/routes/auth.ts`): draft
  creation/update/submission, CRO forward-to-HSE, HSE approval, CRO
  fallback approval, and CRO closure are implemented, plus read APIs for
  frontend integration - the caller's own effective capabilities
  (`GET /auth/me`), the caller's own permit list (`GET /permits/mine`),
  a capability-gated status queue (`GET /permits/queue?status=...`),
  permit detail with its JSA/computed validity/available-actions hint
  (`GET /permits/:id`), and lifecycle history (`GET /permits/:id/history`).
  `GET /permits/mine` and `GET /permits/queue` are paginated
  (`page`/`pageSize`, safe defaults, hard maximum page size of 100, and
  a hard maximum on the COMPUTED offset - `(page - 1) * pageSize` may
  not exceed 100,000, rejected with 400 rather than silently clamped,
  since `pageSize` alone can turn an innocuous-looking `page` into a
  pathological offset - see
  `domain/permits/validation.ts::{paginationQuerySchema,MAX_PAGINATION_OFFSET}`).
  Send-back,
  Hold, Resume, Cancel, Renewal, PDF generation, and WhatsApp
  notifications are not implemented - each is blocked on a specific
  unresolved business rule, not merely unscheduled; see `DECISIONS.md`'s
  Open Decisions (items 1-3, 6-7) for exactly what is undecided.
- Production hardening: backend-wide rate limiting (global + a stricter,
  identity-keyed limit on mutation endpoints - `middleware/rateLimit.ts`),
  security headers (`helmet`), a bounded JSON body limit with sanitized
  malformed-JSON/oversized-body handling, an explicit trusted-proxy
  address/network allowlist (`TRUST_PROXY_CIDRS` - never a hop count or
  a wildcard; see `config/trustProxy.ts`), a `/ready` readiness endpoint
  alongside the existing `/health` liveness endpoint, structured
  per-request logging with a correlation id (`middleware/requestLog.ts` -
  never logs tokens/headers/bodies), and startup-time environment
  hardening (fail-fast validation with documented practical bounds on
  every numeric/timing config value - port, DB pool/timeouts, rate-limit
  window/counts - and a guard against a service-role key being placed in
  `SUPABASE_PUBLISHABLE_KEY`). See `DEPLOYMENT.md` for the manual
  production configuration this still requires (in particular,
  `TRUST_PROXY_CIDRS` and the network-topology requirement it depends on
  - the backend must not be reachable except through the configured
  proxy) and the documented single-instance constraint on the in-memory
  rate limiter.

## Core Scope

- Permit creation and submission by permitted team users.
- Sequential review: CRO first, then HSE (with a strict 5-minute review
  window and CRO fallback approval authority).
- Permit issuance with authoritative actor/timestamp recording.
- Midnight-based validity (not rolling 24-hour), evaluated using
  authoritative backend/database time in the configured site timezone.
- Hold / Resume of permits by CRO.
- Cancellation by CRO (preserving history, no deletion).
- Closure by CRO only (no creator-initiated closure).
- Renewal after midnight expiry, issuing a new Permit Number while
  preserving the same JSA Number and linking to permit history.
- Read-only PDF generation for issued and closed permits, reflecting the
  official form layout.
- Durable, non-blocking WhatsApp lifecycle notifications (future
  integration; permit actions must never depend on notification delivery).
- Capability-based authorization derived from Team + Position, plus a
  separate privileged management tier (CEO, Site Manager).

## Explicitly Out of Scope (for now)

- Microservices, message brokers, Redis, Kubernetes, or other scaling
  infrastructure not justified by an actual current requirement.
- Digital signature functionality.
- Any assumption about the final WhatsApp integration method.
- Any application code, dependency installation, or database schema —
  these begin only after this documentation baseline is accepted and
  implementation proceeds section by section.

## How to Use This Documentation Set

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — target stack, trust boundaries, module principles.
- [`WORKFLOW.md`](./WORKFLOW.md) — permit lifecycle states and transitions, with open questions flagged.
- [`SECURITY.md`](./SECURITY.md) — security/integrity requirements and per-section development gates.
- [`DATABASE.md`](./DATABASE.md) — database design principles only (no schema yet).
- [`DECISIONS.md`](./DECISIONS.md) — accepted decisions and the authoritative open-decisions log.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — manual production configuration and deployment-time constraints (not workflow/business rules).

These files are the authoritative source of truth for requirements until
superseded by actual code, migrations, and configuration once
implementation begins.
