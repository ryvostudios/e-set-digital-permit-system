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
  snapshots, audit/lifecycle history). Implemented: once a permit is
  ISSUED, its business-content snapshot (`issued_document_snapshots`,
  migration `0013`) can never be updated, deleted, or truncated by
  anyone - including the CEO or Site Manager - a stricter rule than
  ordinary audit-log append-only governance, enforced at the database
  level the same way `permit_lifecycle_events` already is. The generated
  PDF's stored file reference/hash is likewise locked once generation
  succeeds.
  Migration 0013 transactionally backfills every earlier issued permit
  from its unique authoritative issuance lifecycle event, refusing the
  migration if any such event is missing or ambiguous. PDF downloads
  verify private object bytes against the immutable stored hash.

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
- **Initial CEO provisioning** (implemented): the very first CEO is
  created only by a server-only CLI (`npm run bootstrap:ceo`), never
  through public signup, a UI flow, or any HTTP endpoint - there is no
  code path that lets a request, authenticated or not, create or grant
  CEO access. It refuses to run without a server-only service-role
  credential configured, refuses to create a second active CEO if one
  already exists, never derives authorization from Supabase Auth
  `user_metadata`, and never logs the bootstrap password. See
  `DECISIONS.md` → "CEO Bootstrap" and `DEPLOYMENT.md`.

  A fixed-key database reservation prevents concurrent initial-CEO
  creation; its lease lets retry reconcile an Auth identity created
  before a transient database failure.

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

## Implemented Production Hardening

The requirements above that are backend-cross-cutting (rather than
specific to one workflow section) are implemented as of the
production-hardening batch:

- **Rate limiting**: backend-wide (`middleware/rateLimit.ts`) - a
  generous global limit on every `/api/v1` request (IP-keyed, so
  authenticating never exempts a client from it), and a stricter limit
  on every state-changing permit endpoint, keyed by authenticated actor
  id once `requireAuth` has run (so switching IP/network doesn't reset
  an authenticated caller's budget). This backend has no password
  login/signup endpoint of its own (Supabase Auth is called directly by
  the frontend), so there is no separate "login route" to rate-limit the
  way this guidance usually implies - the mutation limiter is the
  closest equivalent. The limiter store is in-memory/per-instance - see
  `DEPLOYMENT.md` for the documented horizontal-scaling constraint this
  implies; it is not silently presented as more scalable than it is.
- **Request-size limits**: JSON bodies are capped (`app.ts`); an
  oversized or malformed body gets a sanitized 413/400, never a stack
  trace or a generic 500.
- **Production-safe error responses**: the central error handler
  (`app.ts`) never returns a stack trace, raw error message, or SQL to a
  client; database errors are always passed through
  `db/pool.ts::toSafeDbErrorMessage` before being logged, and never
  logged or returned verbatim.
  WhatsApp/PDF workers follow the same rule: provider and Storage
  exceptions become fixed safe categories in `last_error`, and their CLI
  entry points emit sanitized structured failures without raw messages.
- **Secure session/authentication handling**: `requireAuth` verifies the
  Supabase access token server-side on every request (never trusts a
  client-supplied identity) and fails closed (401) on any missing,
  malformed, or invalid/expired token or verification error - see
  `middleware/auth.ts`.

## Notification Security

- **In-app notifications** (implemented): the recipient is always
  resolved server-side from the authoritative Team + Position ->
  Capabilities model (or the permit's own `created_by`) -
  `domain/notifications/recipients.ts`. A client can never create a
  notification for, or choose the recipient of, an arbitrary user; there
  is no client-facing "create notification" endpoint at all - every
  notification is a side effect of an authorized workflow transition.
  `GET /api/v1/notifications` and `POST /api/v1/notifications/:id/read`
  are scoped by `recipient_user_id = caller` only - a notification
  belonging to another user is never visible or markable (404, not 403,
  for one that exists but isn't the caller's - the same IDOR-safe
  pattern as every other object-access check in this API). Idempotent
  via a database uniqueness constraint on
  (`source_event_id`, `recipient_user_id`) - a retried/racing transition
  can never create a duplicate.
- **WhatsApp outbox** (implemented, provider not yet selected): decoupled
  from the permit transaction (outbox pattern) - a permit transition only
  ever writes a local, durable outbox row inside its own transaction;
  notification/outbox failures never invalidate or block a committed
  permit action, and the transition never depends on WhatsApp (or any
  provider) being reachable. The destination is never client-influenced
  (always the one configured company group, resolved server-side once a
  provider exists). Idempotent via a database uniqueness constraint on
  `source_event_id` - exactly one outbox message per qualifying lifecycle
  event, even under a retried/racing transition. The message payload is
  server-generated only, and never contains a credential/secret.
- No workflow notification or outbox message text can cause log/header
  injection: every value rendered into a title/message/payload is either
  a server-derived Permit/JSA number or free text that already passed
  this codebase's `.trim().max(2000)` validation on the way in
  (`domain/permits/validation.ts`) - no raw client input is ever embedded
  unvalidated.

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
