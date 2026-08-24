# Security

Security is reviewed at every development section, not only at the end
of the project. This document defines the standing security/integrity
requirements and the per-section gate every implementation step must
pass.

## Core Principles

- **Default-deny authorization.** An action is rejected unless an
  explicit capability grants it. Absence of a rule means "no."
- **Least privilege.** Capabilities and privileged access grant only
  what is required for the role.
- **Server-side authorization only.** The React PWA is untrusted. Hiding
  or disabling UI is a UX convenience, never a security control. Every
  privileged or state-changing operation is authorized in the Express
  backend, based on capabilities, not frontend labels or client state.
- **Database constraints as defense in depth.** Constraints, foreign
  keys, and controlled state transitions back up application-level
  authorization; they are a second layer, not a replacement for it.
- **Validate all untrusted input** at the API boundary (Zod), including
  input that "should" already be valid because the frontend enforces it.
- **No secrets in Git or frontend code.** No privileged database
  credentials, service-role keys, passwords, or production secrets in
  frontend bundles or version control.
- **Secure session/authentication handling**, including proper
  logout/session lock, relevant to CRO shift handover.
- **Rate limiting** where appropriate, particularly on authentication and
  other abuse-sensitive endpoints.
- **Request-size limits** on API input.
- **Protection against stale updates** (see Data Integrity below).
- **Atomic workflow changes** for critical state transitions.
- **Audit privileged actions**, including management privilege grants
  and revocations.
- **Avoid IDOR/BOLA** — every object access is authorized against the
  authenticated user's actual capabilities/ownership, not trusted from
  client-supplied identifiers alone.
- **Avoid privilege escalation** — in particular, Team + Position
  assignment must never be usable to obtain CEO or Site Manager
  authority, and Site Manager must never be able to grant another Site
  Manager.
- **Protect against SQL injection** — parameterized queries / query
  builder usage only, no raw string interpolation of untrusted input.
- **Protect against XSS** — output encoding and safe rendering practices
  on the frontend, especially anywhere permit content (free-text
  "Other" company entry, remarks/reasons) is displayed.
- **CSRF protection** where the chosen authentication architecture
  requires it (e.g. if cookie-based sessions are used).
- **Production HTTPS** for all traffic.
- **Secure backups/recovery** for the production database.
- **Immutable historical data** where required (issued/closed permit
  snapshots, audit/lifecycle history).

## Authorization Model Requirements

- No operational role (`WORKER`, `TEAM_LEAD`, `CRO`, `HSE`, etc.) is
  directly assigned to a user account. Operational permissions are
  derived: `TEAM + POSITION -> CAPABILITIES`.
- The backend checks capabilities (e.g. `permit.cro_review`,
  `permit.hold`, `permit.forward_hse`, `permit.fallback_approve`), never
  frontend-supplied role names.
- Every CRO/HSE action records the actual authenticated actor identity.

## Privileged Management Access

Privileged management authority (CEO, Site Manager) is separate from
operational Team + Position capabilities, and carries its own security
requirements:

- Only one active CEO at a time.
- CEO is not created through the ordinary user-management workflow, and
  is specially protected from normal modification/removal.
- Only the CEO may grant or revoke Site Manager privileged access.
- A Site Manager cannot grant another Site Manager.
- Team + Position assignment must never automatically confer CEO or Site
  Manager authority.
- All privileged access changes (grant/revoke of Site Manager, any CEO
  transition) must be audited.
- Management privilege does not bypass permit data-integrity protections
  — a CEO or Site Manager is still subject to the same optimistic
  concurrency, state-transition, and validation rules as any other actor
  performing a workflow action.
- V5.19's legacy `SYSTEM_ADMIN` role is not assumed to exist in this
  system (see `DECISIONS.md`).

## Data Integrity / No Silent Overwrite

Preventing silent data overwrite is a core production requirement, to be
enforced (in later implementation) using:

- database transactions
- optimistic concurrency / version checks
- row locks for critical operations
- unique constraints, foreign keys, check constraints
- controlled state transitions
- append-only lifecycle events and audit history
- immutable issued/closed historical snapshots where appropriate

Example: if a user loaded a permit at version 7 and the database has
since moved to version 8, saving the stale version 7 must produce a
conflict response (e.g. HTTP 409) — never a silent overwrite of version
8.

Operations that must eventually be atomic and concurrency-safe: approval,
Hold, Resume, Cancel, renewal, closure, Permit Number generation, and
JSA Number generation. Management/privileged users do not bypass these
protections.

## Time and Enforcement Integrity

- The HSE 5-minute review window is enforced using authoritative
  backend/database timestamps (`hse_review_started_at`,
  `hse_review_deadline_at`), never client-reported time. The visible
  countdown is display-only.
- Permit validity (midnight expiry) is evaluated using authoritative
  backend/database time in the configured site timezone, never
  client/browser/device time.
- Changing device time, JavaScript state, or refreshing the browser must
  not change any authorization or validity outcome.

## Notification Security

- WhatsApp lifecycle notifications are decoupled from the permit
  transaction (outbox pattern); notification failures never invalidate
  or block a committed permit action.
- Future message processing must use idempotency/unique event IDs to
  prevent duplicate sends.

## Development Security Gate (per implementation section)

Every implementation section must pass this gate before commit:

1. Inspect the current authoritative repository state.
2. Implement only the scoped section — no unrelated modules touched.
3. Run the feature manually (functional check).
4. Run lint.
5. Run TypeScript typecheck.
6. Run relevant automated tests.
7. Run production build, when applicable.
8. Perform a proportional security/data-integrity review of the change
   (proportional to the sensitivity of what changed — e.g. an
   authorization or numbering change warrants a closer look than a
   read-only display change).
9. Inspect `git diff` and `git status`.
10. Commit only after the section is known-good.

Sections are not stacked unverified — each section is verified and
committed before the next begins.
