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
- Database: migrations `0001`-`0015` are applied and live-verified
  against the live Supabase project (`yfxnigovfmngypbgcnaw`) - Supabase
  security hardening; Team + Position -> Capabilities authorization;
  privileged-access [CEO/Site Manager] data-model foundation; Permit/JSA
  schema; CRO review and HSE review with 5-minute fallback approval;
  CRO-only permit closure; the permit-status read-performance index; and
  the Permit workflow completion schema (adds the
  `PENDING_CORRECTION`/`HELD`/`CANCELLED` statuses, hold/cancellation
  columns and CHECK constraints, the renewal-uniqueness index, and every
  new lifecycle event type - see `database/migrations/README.md`).
  Migration `0012_permit_workflow_completion.sql` has been applied and
  live-verified successfully: migration recorded, new workflow statuses/
  constraints live, hold/cancel invariants valid, renewal uniqueness
  active, lifecycle append-only protections intact, RLS/default-deny
  intact, no anon/authenticated direct grants, no new policies, no
  data-integrity violations found.
  Migration `0013_notifications_outbox_documents.sql` (notifications,
  the WhatsApp outbox, immutable issued-document snapshots, their PDF
  job state, and justified search/audit indexes) is applied and live-
  verified. All new tables are RLS-enabled, there are no direct `anon`/
  `authenticated` grants or new policies, and immutable snapshot
  protections are active. The live database contained zero already-
  issued permits, so the historical backfill had zero rows to process.
  Migration `0014_fix_trigger_function_search_paths.sql` is applied and
  live-verified. Both affected functions now have
  `search_path=pg_catalog`, remain SECURITY INVOKER, and no longer trigger
  the Supabase `function_search_path_mutable` warnings. All five support-
  feature tables remain RLS-enabled, with zero direct `anon`/
  `authenticated` grants and zero policies added; no security regression
  was found, and Performance Advisor findings are informational only.
  Migration `0015_backend_integrity_hardening.sql` is **APPLIED /
  LIVE-VERIFIED**. It adds application account disabling,
  credential-boundary support, and database integrity constraints without
  changing agreed workflow semantics.
- Backend notifications/outbox/documents domain
  (`backend/src/domain/notifications/`,
  `backend/src/domain/permits/{documents,search,workflowSideEffects}.ts`,
  `backend/src/routes/notifications.ts`, extensions to
  `backend/src/routes/permits.ts`): in-app notifications, a durable
  WhatsApp outbox foundation, immutable issued Permit+JSA PDF generation,
  permit search, and lifecycle/audit search are now implemented - see
  `DECISIONS.md`'s "Notifications (in-app - implemented)", "Notifications
  (WhatsApp outbox - foundation implemented, provider still open)", "PDF
  (immutable issued Permit+JSA document - implemented this batch)", and
  "Permit Search / Lifecycle Audit Search" sections for the full,
  authoritative detail. In summary:
  - `GET /api/v1/notifications` / `POST /api/v1/notifications/:id/read` -
    recipient-scoped, paginated, unread-filterable.
  - `GET /api/v1/permits/search` - Permit Number, JSA Number, status,
    `createdBy`, company, and date-range filters, scoped by the exact
    same access model as every other read endpoint.
  - `GET /api/v1/permits/:id/history` now additionally accepts optional
    filter/pagination query parameters (event type, actor, from/to
    status, date range) - unchanged, unfiltered/unpaginated behavior when
    none are supplied.
  - `GET /api/v1/permits/:id/pdf` - authorizes permit visibility before
    any document lookup; serves only the immutable issued PDF once
    generated and SHA-256 verified; returns an explicit processing/unavailable status
    otherwise, never a fake file.
  - A CEO bootstrap CLI (`npm run bootstrap:ceo`,
    `backend/src/scripts/bootstrapCeo.ts`) provisions the very first CEO
    via the existing `privileged_access_events` model - never a public
    endpoint.
  - Two operator-run background processors, neither invoked
    automatically (`npm run outbox:whatsapp:process`,
    `npm run documents:process`).
  - Migration 0013 refuses incomplete or ambiguous historical issuance
    history and idempotently creates one immutable snapshot/PDF job for
    every earlier issued permit. Historical issuance time remains the
    lifecycle event time, while snapshot capture/row creation use the
    actual DB backfill time. Responsibility handoffs abort with 409
    when authoritative CRO/HSE recipient resolution is empty. Both
    workers use atomic token-owned leases; PDF retries hash-reconcile an
    already-uploaded immutable object. Worker failures persist/log only
    fixed safe categories, never raw external exceptions. CEO bootstrap uses a database
    singleton reservation and safely reuses a matching Auth identity.
  - **Genuine manual/external blockers, not yet resolved by this batch:**
    (1) no real WhatsApp provider is selected or configured - the outbox always
    reports messages as failed/pending until one is (`DECISIONS.md`'s
    open decision #2); (2) the private PDF bucket and Storage-scoped S3
    credentials are not configured - PDF generation jobs remain in their
    documented safe-pending state until an operator configures them (see
    `DEPLOYMENT.md`). Auth Admin service-role authority remains separate and is
    used only for CEO bootstrap.
  - The live backend now uses the restricted `app_runtime` PostgreSQL login for
    `DATABASE_URL`; migrations use a distinct owner in
    `MIGRATION_DATABASE_URL`. Runtime smoke tests covered readiness and all
    required application reads, including the SELECT-only `teams`, `positions`,
    and `team_positions` lookups. The runtime role has no schema ownership/DDL,
    migration-ledger/bootstrap access, application DELETE/TRUNCATE, or browser
    role exposure; its `storage.buckets` SELECT is preflight-only.
- Backend permit domain (`backend/src/domain/permits/`,
  `backend/src/routes/permits.ts`, `backend/src/routes/auth.ts`): the
  full agreed Permit workflow is now implemented - draft creation/
  update/submission; CRO review (forward-to-HSE, send-back to applicant,
  `permit.send_back`); applicant correction/resubmission
  (`PENDING_CORRECTION -> PENDING_CRO`, `permit.submit`); HSE review
  (approval, send-back to CRO - never directly to the applicant -
  `permit.hse_review`, both with no time gate, matching the still-open
  HSE-window-gap decision); CRO fallback approval; Hold/Resume of an
  `ISSUED` permit (`permit.hold`/`permit.resume`, mandatory hold reason,
  Resume time-gated to strictly before the permit's original midnight
  expiry); Cancel of an `ISSUED`/`HELD` permit, permanently
  (`permit.cancel`); Close from `ISSUED` or `HELD` (`permit.close`); and
  Renewal of a `CLOSED`, midnight-expired permit into a brand-new
  `ISSUED` permit with a new Permit Number, the same JSA, and no
  re-review (`permit.renew`, database-uniqueness-enforced against double
  renewal) - plus the full set of read APIs for frontend integration:
  the caller's own effective capabilities (`GET /auth/me`), the caller's
  own permit list (`GET /permits/mine`), a capability-gated status queue
  (`GET /permits/queue?status=...`), permit detail with its JSA/computed
  validity/available-actions hint (`GET /permits/:id`), and lifecycle
  history (`GET /permits/:id/history`).
  `GET /permits/mine` and `GET /permits/queue` are paginated
  (`page`/`pageSize`, safe defaults, hard maximum page size of 100, and
  a hard maximum on the COMPUTED offset - `(page - 1) * pageSize` may
  not exceed 100,000, rejected with 400 rather than silently clamped,
  since `pageSize` alone can turn an innocuous-looking `page` into a
  pathological offset - see
  `domain/permits/validation.ts::{paginationQuerySchema,MAX_PAGINATION_OFFSET}`).
  In-app notifications, the WhatsApp outbox foundation, immutable issued
  Permit+JSA PDF generation, permit search, and lifecycle/audit search
  are now implemented (see above); the actual WhatsApp provider
  integration is not - see `DECISIONS.md`'s Open Decisions for what's
  still genuinely unresolved (the HSE-window gap, the WhatsApp
  integration method, and whether closure remarks are mandatory).
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
- Read-only immutable PDF infrastructure for the currently defined skeletal
  Permit/JSA data contract is implemented (see above); the official form
  fields/layout remain a production blocker and must not be invented. Supabase
  Storage upload requires manual, not-yet-live-verified private-bucket
  configuration and Storage-scoped S3 credentials; it never uses Auth Admin.
- Durable, non-blocking in-app notifications - implemented. Durable,
  non-blocking WhatsApp lifecycle notifications via a future provider
  integration (permit actions never depend on notification delivery) -
  outbox foundation implemented, provider not yet selected.
- Capability-based authorization derived from Team + Position, plus a
  separate privileged management tier (CEO, Site Manager).

## Explicitly Out of Scope (for now)

- **PRODUCTION BLOCKER:** official Permit and JSA field definitions and form
  layout must be supplied and agreed before the frontend/immutable PDF
  contract is final. No PPE/hazard/isolation/signature/equipment fields are
  guessed here. Later official fields must extend the DB schema, validation,
  draft APIs, snapshot schema/version, and renderer together.
- Before a second site/security domain shares this database, explicit site
  scoping must be designed across permits, assignments, queues, recipients,
  notifications, search, and relevant history/reporting.

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
