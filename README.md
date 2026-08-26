# E-Set Digital Permit System

A production Progressive Web Application for creating, reviewing, issuing,
and closing work permits (Permit-to-Work / JSA-linked permits) with a
CRO -> HSE review workflow, midnight-based validity, renewal, hold/resume,
and full audit history.

This is a **new, separate application** from the E-Set Digital Management
System. It is not a fork, extension, or module of it, and shares no
runtime, database, or codebase with it.

The previous V5.19 permit system (paper/legacy digital workflow) is used
only as a **business and workflow reference**. Its technical architecture
is not being ported into this system.

## Project Stage

**Backend implementation in progress; frontend workflow UI not yet
started.** This repository's documentation set is still the
authoritative source of truth for anything not yet superseded by actual
code/migrations - see [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) for
the current, accurate implementation snapshot before assuming anything
below.

- [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) — current-state summary and scope
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — target stack, trust boundaries, module principles
- [`WORKFLOW.md`](./WORKFLOW.md) — permit lifecycle and open workflow questions
- [`SECURITY.md`](./SECURITY.md) — security/integrity requirements and dev gates
- [`DATABASE.md`](./DATABASE.md) — database design principles (no schema yet)
- [`DECISIONS.md`](./DECISIONS.md) — accepted decisions and open decisions log
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — manual production configuration and deployment-time constraints

`backend/` is a working Node.js + Express + TypeScript application
implementing the full agreed Permit workflow: draft creation/submission,
CRO review (forward-to-HSE, send-back to applicant), applicant
correction/resubmission, HSE review (approval, send-back to CRO),
CRO fallback approval, Hold/Resume, Cancel, Close, and Renewal - plus
paginated read APIs, permit search, filtered lifecycle/audit search,
in-app notifications, a durable WhatsApp outbox foundation, and
immutable issued Permit+JSA PDF generation - all under Team + Position ->
Capabilities authorization with Supabase Auth token verification.
Database migrations `0001`-`0015` are applied and live-verified against
the live Supabase project (see `database/migrations/README.md`) - `0012`
is the workflow-completion schema (Send-Back/Hold/Resume/Cancel/Renewal),
and `0013` adds notifications, outbox/document support, an atomic
historical issued-document backfill, leased worker claims, and the
initial-CEO singleton reservation. Migration `0014` pins the safe search
path of two `0013` trigger functions without changing their behavior and
security mode. Migration `0015_backend_integrity_hardening.sql` is
**APPLIED / LIVE-VERIFIED**; its account-disable and cross-table/document/
outbox integrity protections are active without changing workflow.
Backend production hardening (rate limiting, security headers, structured logging,
environment validation, a `/ready` readiness endpoint) is also in place
- see `PROJECT_CONTEXT.md` for the precise, current breakdown. `frontend/`
is a React + Vite + TypeScript PWA scaffold with Supabase Auth wired up;
no permit-workflow UI exists yet. The actual WhatsApp provider
integration and Supabase Storage/PDF credentials remain unconfigured -
each is either an unresolved business rule (`DECISIONS.md`'s Open
Decisions) or a manual production-configuration step (`DEPLOYMENT.md`),
not merely unscheduled.

**Production blocker:** the official Permit/JSA field definitions and form
layout have not yet been supplied. The immutable snapshot/PDF infrastructure
is sound for the current skeletal schema, but its final business contract and
frontend must not be treated as complete or extended with guessed fields.

## Technology

- **Frontend:** React + Vite + TypeScript, built as a PWA
- **Backend:** Node.js 24.x + Express + TypeScript, REST API (`engines` is
  authoritative; CI/deployment must use the same major)
- **Database:** PostgreSQL via Supabase infrastructure
- **Validation:** Zod
- **Forms:** React Hook Form
- **Server-state/caching:** TanStack Query

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for full detail and rationale.

## Development Approach

Development proceeds section by section: implement one section, verify it
(lint, typecheck, tests, build, manual check, security review), inspect
`git diff`/`git status`, then commit. Sections are not stacked unverified.

## Status of Open Decisions

A few workflow rules remain intentionally **not yet finalized** - the
gap between HSE window expiry and CRO fallback approval, the WhatsApp
integration method, and whether closure remarks are mandatory. (The
allowed states for Hold/Cancel, the CRO/HSE send-back target state, and
the status of a renewed permit are now resolved and implemented.) See
the "Open Decisions" section of [`DECISIONS.md`](./DECISIONS.md) before
implementing related behavior.

The remaining production/operator blockers are also explicit: the private
PDF bucket and Storage-scoped S3 credentials are not configured; Supabase
leaked-password protection and privileged-account MFA are not enabled and
live-verified; the official Permit/JSA form and fields and final human-visible
number format are unresolved; and explicit site scoping is required before a
second site/security domain uses this database.
