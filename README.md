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

`backend/` is a working Node.js + Express + TypeScript application:
Supabase Auth token verification, Team + Position -> Capabilities
authorization, the permit/JSA domain (draft/submit/CRO review/HSE
review/fallback approval/closure, plus paginated read APIs), database
migrations `0001`-`0011` (applied to the live Supabase project - see
`database/migrations/README.md`), and backend production hardening
(rate limiting, security headers, structured logging, environment
validation, a `/ready` readiness endpoint) - see `PROJECT_CONTEXT.md`
for the precise, current breakdown. `frontend/` is a React + Vite +
TypeScript PWA scaffold with Supabase Auth wired up; no permit-workflow
UI exists yet. Send-back, Hold, Resume, Cancel, Renewal, PDF generation,
and WhatsApp notifications are deliberately not implemented - each is
blocked on a specific unresolved business rule (`DECISIONS.md`'s Open
Decisions), not merely unscheduled.

## Technology

- **Frontend:** React + Vite + TypeScript, built as a PWA
- **Backend:** Node.js + Express + TypeScript, REST API
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

Several workflow rules are intentionally **not yet finalized** (e.g. the
gap between HSE window expiry and CRO fallback approval, and the exact
permit states that allow Hold/Cancel). See the "Open Decisions" section of
[`DECISIONS.md`](./DECISIONS.md) before implementing related behavior.
