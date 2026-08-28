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

**The authoritative Permit + JSA workflow is complete, deployed and
verified in hosted UAT** on branch `feat/authoritative-permit-jsa`
(checkpoint `a52cbe2`). **`main` has not been merged yet.** See
[`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) for the current, accurate
implementation snapshot - including what remains genuinely open - before
assuming anything below.

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
Database migrations `0001`-`0034` are applied and live-verified against
the live Supabase project, with **no outstanding migration** (see
`database/migrations/README.md` for the per-migration ledger) - `0012` is
the workflow-completion schema (Send-Back/Hold/Resume/Cancel/Renewal),
`0013` adds notifications, outbox/document support and the historical
issued-document backfill, `0032` adds the `PDFKIT_V3` renderer identity,
`0033` gives each permit type its own number series, and `0034` moves
number allocation to the first successful submission so a draft never
consumes one.

Permit numbering is database-authoritative and UAT-verified: a DRAFT has
no number; the number is assigned atomically on the first successful
`DRAFT -> PENDING_CRO` submission and is permanent thereafter; each type
draws from its own series (Cold Work `CW-*`, Hot Work `HW-*`, WTG Work
`WTG-*`, Confined Space Entry `CS-*`); and JSA numbering remains one
independent global sequence.
Backend production hardening (rate limiting, security headers, structured logging,
environment validation, a `/ready` readiness endpoint) is also in place
- see `PROJECT_CONTEXT.md` for the precise, current breakdown. The actual
WhatsApp provider
integration and Supabase Storage/PDF credentials remain unconfigured -
each is either an unresolved business rule (`DECISIONS.md`'s Open
Decisions) or a manual production-configuration step (`DEPLOYMENT.md`),
not merely unscheduled.

`frontend/` is a complete React + TypeScript application covering the
whole agreed product surface: sign-in with Remember Me, the forced
first-login password change, an operational home screen, permit
application across all four templates with the paper-form Permit and JSA
editors, CRO and HSE review queues, permit records/detail/history, the
secured PDF action, notifications, the full employee lifecycle, and
CEO-only Site Manager administration - all rendered from what
`GET /auth/me` and the permit/account APIs actually return. Frontend
authorization is presentation only; every screen re-asks the backend and
shows its refusal honestly. See [`frontend/README.md`](./frontend/README.md)
for its architecture, public environment variables, PWA caching policy,
and the operator prerequisites it fails closed on.

Issued PDF generation is live through the backend document worker, and
`PDFKIT_V3` renders the authoritative Permit + JSA pages. An issued PDF is
immutable: Hold, Resume and Closure create no new snapshot or document
job and change no renderer version, hash or storage path. What is still
open is formal sign-off of the exact per-template checklist item lists
(`DECISIONS.md` open decision #3) - nothing beyond the supplied forms is
guessed.

## Technology

- **Frontend:** React + Vite + TypeScript, built as a PWA
- **Backend:** Node.js 24.x + Express + TypeScript, REST API (`engines` is
  authoritative; CI/deployment must use the same major)
- **Database:** PostgreSQL via Supabase infrastructure
- **Routing:** React Router
- **Validation:** Zod (backend; the backend is the authority on every
  request contract, and the frontend surfaces its field-level issues
  rather than duplicating the rules)
- **Frontend testing:** Vitest + Testing Library (jsdom)

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for full detail and rationale.

## Development Approach

Development proceeds section by section: implement one section, verify it
(lint, typecheck, tests, build, manual check, security review), inspect
`git diff`/`git status`, then commit. Sections are not stacked unverified.

## Status of Open Decisions

Two workflow rules remain intentionally **not yet finalized** - the
WhatsApp integration method and whether closure remarks are mandatory -
alongside sign-off of the per-template checklist item catalogue. (The
allowed states for Hold/Cancel, the CRO/HSE send-back target state, the
status of a renewed permit, and the gap between HSE window expiry and CRO
fallback approval are now resolved and implemented.) See the "Open
Decisions" section of [`DECISIONS.md`](./DECISIONS.md) before
implementing related behavior.

The remaining production/operator blockers are explicit: Supabase
leaked-password protection and privileged-account MFA are not enabled and
live-verified; and explicit site scoping is required before a second
site/security domain uses this database. (The private PDF bucket and
Storage-scoped S3 credentials are now configured, and issued-document
generation is live.)
