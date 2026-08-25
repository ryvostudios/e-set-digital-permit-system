# Architecture

## Target Stack

**Frontend**
- React
- Vite
- TypeScript
- Progressive Web App (installable; specific offline permit behavior is
  not yet designed, and permit correctness must never depend on offline
  behavior)

**Backend**
- Node.js
- Express
- TypeScript
- REST API, versioned routes beginning with `/api/v1/`

**Database / Infrastructure**
- PostgreSQL, using Supabase infrastructure
- Supabase Auth may be used for identity/authentication
- Database access is controlled through the backend application layer —
  the frontend never talks to the database directly
- Privileged/service-role credentials must never be exposed to the
  frontend or committed to the repository

**Validation**
- Zod, used at API boundaries (and shared between frontend/backend where
  a genuine reuse case exists)

**Frontend Forms**
- React Hook Form

**Server-state / API caching**
- TanStack Query

**Animations**
- One consistent animation approach/library, chosen when the frontend is
  actually started (not yet selected)
- Animations must be purposeful, smooth, accessible, and
  performance-conscious
- Critical permit operations (submit, review, approve, hold, resume,
  cancel, renew, close) must never depend on an animation completing or
  succeeding

## Trust Boundary

```
React PWA          = untrusted client
Express backend     = application/business authority
PostgreSQL/Supabase  = final data integrity authority
```

The frontend is never trusted to authorize an operation. Hiding or
disabling a button in React is a UX convenience only — it is not a
security control. Every privileged or state-changing operation must be
independently authorized and validated server-side, and further
constrained by the database where practical (constraints, foreign keys,
controlled state transitions).

## Request Flow

```
React PWA
    -> HTTPS REST API
    -> Express
    -> Authentication
    -> Authorization (capability check, default-deny)
    -> Validation (Zod)
    -> Business / workflow services
    -> Database layer
    -> PostgreSQL / Supabase
```

Every layer in this chain is expected to exist for state-changing permit
operations. No layer may be skipped because an earlier layer "already
checked."

## Secrets and Credentials

- No privileged database credentials, service-role keys, database
  passwords, or production secrets may appear in frontend code, frontend
  bundles, or Git history.
- Secrets live in backend-only environment configuration, excluded from
  version control (`.gitignore` already excludes `.env` / `.env.*`).

## Module Principles

- **Modular monolith** initially: one deployable backend application,
  internally organized into clearly bounded modules (e.g. permits, review
  workflow, identity/authorization, notifications, PDF generation) rather
  than split into services.
- Do not introduce microservices, Redis, Kubernetes, message brokers, or
  other scaling infrastructure unless an actual, current requirement
  justifies it. Scalability is addressed through clear module boundaries
  and interfaces, not premature infrastructure.
- Each module has a single, clear responsibility. Avoid cross-module
  reach-through (e.g. notification code writing permit rows directly).
- Reuse existing components/hooks/services/types/validators/utilities
  when there is a genuine reuse case; do not build abstractions ahead of
  a real second use.
- Keep the frontend and backend in sync on shared types where it
  meaningfully reduces duplication or drift risk (e.g. permit status
  enums, capability names), without creating tight coupling that blocks
  independent deployment.

## Authorization Model

Operational permissions are **not** assigned directly as roles. There is
no `WORKER`, `TEAM_LEAD`, `CRO`, or `HSE` role attached directly to a
user account.

Instead:

```
TEAM + POSITION -> CAPABILITIES
```

Example: a user on Team `E-BOP` with Position `CRO` resolves to a set of
capabilities such as `permit.cro_review`, `permit.send_back`,
`permit.hold`, `permit.resume`, `permit.cancel`, `permit.forward_hse`,
`permit.fallback_approve`, `permit.renew`, `permit.close`.

The backend authorizes actions by checking **capabilities**, never
frontend-supplied role labels or UI state. Authorization is **default
deny**: an action is rejected unless an explicit capability grants it.

Privileged management access (CEO, Site Manager) is a separate authority
tier from Team + Position capabilities — see `WORKFLOW.md` and
`DECISIONS.md` for the specific rules governing it. Team + Position must
never automatically grant CEO or Site Manager authority.

## Data Integrity as an Architectural Concern

The database is the final authority on data integrity, not just storage.
Critical workflow operations (approval, hold, resume, cancel, renewal,
closure, Permit Number generation, JSA Number generation) are expected to
eventually be implemented as atomic, concurrency-safe operations using
transactions, optimistic concurrency (version checks), row locks where
needed, and appropriate constraints. See `DATABASE.md` and `SECURITY.md`
for detail. Management/privileged users do not bypass these protections.

## Notifications (Future)

WhatsApp lifecycle notifications are an asynchronous, best-effort
integration layered on top of committed permit transactions, not a
dependency of them:

```
Permit transaction commits
    -> durable notification/outbox record
    -> WhatsApp agent/integration
    -> send
    -> report SENT/FAILED
```

Permit/database actions must remain valid and complete even if WhatsApp
delivery is unavailable, delayed, or fails. The specific integration
method is not yet decided (see `DECISIONS.md`).

## Production Hardening

The backend includes: backend-wide rate limiting (in-memory,
per-instance - a deliberate application of "no infrastructure without an
actual current requirement" below; see `DEPLOYMENT.md` for the
documented scaling constraint this implies), security response headers,
a bounded request body size, sanitized error responses (no stack
traces/SQL/internal detail ever reach a client), strict startup
environment validation (fails fast on missing/invalid production
config), a `/ready` readiness endpoint alongside the existing `/health`
liveness endpoint, and structured per-request logging (correlation id;
never logs tokens, the `Authorization` header, or request/response
bodies). See `SECURITY.md`'s "Implemented Production Hardening" and
`DEPLOYMENT.md` for detail and the manual configuration this still
requires per deployment.

## Scalability Principle

Design modules and interfaces so the system can later support additional
permit types, teams/positions, capabilities, reports, integrations,
notification methods, and general scale — without building that
infrastructure now.
