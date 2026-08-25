# Decisions

This document records accepted decisions for the E-Set Digital Permit
System, and separately tracks decisions that are explicitly **not yet
resolved**. Open decisions must not be assumed or implemented until
confirmed.

## Accepted Decisions

### Project Identity
- This is a new, standalone application, separate from the E-Set Digital
  Management System (different codebase, database, and deployment).
- The V5.19 permit system is a business/workflow reference only; its
  technical architecture is not carried over.

### Technology
- Frontend: React + Vite + TypeScript, as a PWA.
- Backend: Node.js + Express + TypeScript, REST API.
- Database: PostgreSQL via Supabase infrastructure; Supabase Auth may be
  used for identity.
- Validation: Zod. Forms: React Hook Form. Server-state/caching: TanStack
  Query.
- One consistent animation approach will be used; critical permit
  operations never depend on animation.
- API routes are versioned, beginning with `/api/v1/`.
- Architecture starts as a modular monolith; no microservices, Redis,
  Kubernetes, or message brokers without an actual current requirement.

### Authorization
- No directly assigned operational roles. Operational permissions are
  derived: Team + Position -> Capabilities. Backend checks capabilities,
  not role labels.
- Authorization is default-deny.
- Privileged management access (CEO, Site Manager) is separate from
  operational capabilities:
  - Only one active CEO at a time.
  - CEO is not created through the ordinary user-management workflow and
    is specially protected from normal modification/removal.
  - Only the CEO may grant or revoke Site Manager access.
  - A Site Manager cannot grant another Site Manager.
  - Team + Position never automatically grants CEO or Site Manager
    authority.
  - Privileged access changes must be audited.
  - Management privilege does not bypass permit data-integrity
    protections.
- V5.19's `SYSTEM_ADMIN` role is not assumed to exist in this system.

### Numbering
- Every permit has a Permit Number; every JSA has its own JSA Number.
- Review, CRO send-back, HSE send-back, correction, resubmission, hold,
  and resume all keep the same Permit Number and same JSA Number.
- Only a post-midnight renewal creates a new Permit Number, keeping the
  same JSA Number.
- Number generation must eventually be atomic, unique, and
  concurrency-safe.

### Validity
- Permits are valid only until the next midnight in the configured site
  timezone (not a rolling 24-hour window), evaluated using authoritative
  backend/database time — never client/browser/device time.

### Review Workflow
- Submission always goes to CRO first (`PENDING_CRO`).
- CRO may review, send back for correction, and forward to HSE.
  CRO send-back preserves Permit Number and JSA Number.
- CRO forwarding to HSE moves the permit to `PENDING_HSE` and starts a
  strict 5-minute HSE review window,
  enforced via authoritative backend timestamps
  (`hse_review_started_at`, `hse_review_deadline_at`); the browser
  countdown is display-only.
- Within the window, HSE may approve or send back (same Permit Number,
  same JSA Number).
- If HSE does not act within the window, CRO gains fallback approval
  authority. Once CRO performs fallback approval, HSE can no longer act
  on that completed approval cycle.
- Issuance occurs via valid HSE approval or valid CRO fallback approval,
  and records authoritative actor/timestamp plus an audit event.

### CRO Workstation
- Four CRO personnel total; normally one on duty/authenticated at a
  time, using a shared workstation across shifts but individual
  accounts.
- No normal requirement for simultaneous CRO claim/assignment.
- Pending-CRO permits remain in a common queue when no CRO is logged in.
- Every CRO action records the actual authenticated CRO identity.
- Backend concurrency protection is required regardless of the
  single-active-CRO assumption.

### Hold / Resume / Cancel / Closure / Renewal
- Hold and Resume preserve Permit Number and JSA Number, and create
  append-only lifecycle/audit events with actor, timestamp, and
  reason/remarks where applicable.
- Cancellation never deletes a permit; it preserves history and creates
  an audit event.
- Closure is performed only by CRO — there is no creator closure request
  or creator final closure. Closed permits are immutable historical
  records through ordinary operations.
- Renewal occurs after midnight expiry, is performed by CRO, issues a
  new Permit Number, keeps the same JSA Number, and preserves/links the
  previous permit's history without overwriting or deleting it.

### Forms / UI
- Permit UI reflects the official permit form layout; the eventual
  read-only PDF preserves the same field organization and form-style
  presentation.
- Required fields show a red asterisk and are enforced by backend
  validation and database constraints where appropriate.
- Company field includes ESET, SGRE, ZPL, Other; choosing Other allows
  free-text entry.
- Large checkbox sections support a logical "Check All" scoped per
  logical section, not one global checkbox across unrelated sections.

### PDF
- Issued and closed permits get a generated, read-only PDF from
  authoritative backend data, preserving the official form-style layout,
  supporting View and Download, not user-editable within the
  application. No digital-signature functionality is implemented; any
  paper signature boxes are preserved visually unless specified
  otherwise later.

### Notifications
- WhatsApp lifecycle notifications (ISSUED, HOLD, RESUMED, RENEWED,
  CLOSED) are delivered via a future, decoupled agent/integration.
  Permit/database actions never depend on notification delivery
  succeeding; notifications are durable and retryable via an outbox
  pattern, with future idempotency/unique event IDs to prevent
  duplicates. The CRO PC has no WhatsApp agent yet, and the final
  integration method is not decided (see Open Decisions).

### Data Integrity
- No silent overwrite: stale writes (e.g. editing an outdated version)
  must be rejected (e.g. HTTP 409), not silently applied.
- Critical operations (approval, hold, resume, cancel, renewal, closure,
  Permit Number generation, JSA Number generation) must eventually be
  atomic and concurrency-safe. Management/privileged users do not bypass
  these protections.

### Production Hardening
- Rate limiting is backend-wide, in-memory, per-instance
  (`express-rate-limit`'s default store) - consistent with "no
  microservices/Redis/etc. without an actual current requirement"
  (Technology, above) at this project's current single-instance scale.
  This is a deliberate, documented tradeoff, not an oversight: see
  `DEPLOYMENT.md` for the exact horizontal-scaling constraint it implies
  and what replacing it (a shared/Redis-backed store) would require.
- A global limit applies to every request regardless of authentication
  state (so authenticating can never exempt a client from it); a
  stricter limit, keyed by authenticated actor id, applies in addition
  to every state-changing permit endpoint. This backend has no
  password login/signup endpoint of its own (the frontend authenticates
  directly against Supabase Auth), so there is no separate "login route"
  to rate-limit; the mutation-endpoint limit is the closest equivalent.
- Trusted-proxy configuration (`TRUST_PROXY_CIDRS`) is an explicit
  address/network allowlist, never a hop count and never a wildcard -
  a hop count trusts any address that many hops back, which cannot tell
  a real reverse proxy apart from an attacker directly connecting and
  forging that many `X-Forwarded-For` entries itself. This is not
  sufficient on its own: it is only meaningful given the additional,
  required network-topology constraint that the backend is not publicly
  reachable except through that proxy (firewall/security-group/private
  network) - see `DEPLOYMENT.md`'s "Network topology requirement."
- Every numeric/timing environment variable (port, database pool size/
  timeouts, rate-limit window/counts, pagination page size) has a
  documented, enforced practical range, not just "must be a positive
  integer" - an unbounded value is itself a footgun (e.g. a
  millisecond delay is a Node timer value internally, with its own
  overflow ceiling; an unbounded pagination offset is a pathological
  database query). Out-of-range configuration fails startup/the request
  validation it applies to; it is never silently clamped to the nearest
  valid value.

### Development Process
- Development proceeds section by section: implement, run/verify
  manually, lint, typecheck, test, build, security-review, inspect
  `git diff`/`git status`, then commit — before starting the next
  section.

## Open Decisions

These are explicitly **unresolved** and must not be implemented until
confirmed. Do not invent behavior for these.

1. **HSE window expired, fallback approval not yet performed.**
   What is permitted, if anything, during the gap after the HSE
   5-minute window has expired but before CRO has actually performed
   fallback approval? (E.g.: can HSE still act during this gap? Is there
   a distinct intermediate state? Is there a time limit on how long a
   permit can sit in this gap?) See `WORKFLOW.md` → "HSE Five-Minute
   Window."

2. **Allowed states for Hold.**
   The exact set of permit states from which CRO may place a permit on
   Hold is not finalized (e.g. only `ISSUED`, or also mid-review
   states?). See `WORKFLOW.md` → "Hold / Resume."

3. **Allowed states for Cancel.**
   The exact set of permit states from which CRO may cancel a permit is
   not finalized and must be explicitly defined before implementation.
   See `WORKFLOW.md` → "Cancel."

4. **WhatsApp integration method.**
   The final mechanism for WhatsApp group/agent integration (which
   provider/API, how the CRO PC agent is installed, how it authenticates
   to the WhatsApp group) is not decided and requires research/
   verification before implementation. See `ARCHITECTURE.md` →
   "Notifications (Future)."

5. **Whether closure remarks are mandatory.**
   WORKFLOW.md requires CRO closure to record "the authoritative actor,
   timestamp, and any closure information/remarks required by the
   finalized closure form," but whether remarks must be non-empty (vs.
   optional) is not finalized. Migration `0010` /
   `backend/src/domain/permits/service.ts::closePermit` store closure
   remarks as optional - supported, never required - specifically so
   validation can be tightened later without a data migration. See
   `WORKFLOW.md` → "Closure."

6. **CRO/HSE send-back target state.**
   WORKFLOW.md/DECISIONS.md describe the *action* ("CRO may... send back
   for correction"; "HSE may approve or send back to the original
   creator for correction") and confirm it preserves the Permit/JSA
   numbers, but never name the resulting persisted `status` - unlike
   `PENDING_CRO`/`PENDING_HSE`/`ISSUED`/`CLOSED`, which are all
   explicitly named. Not implemented pending that decision. See
   `WORKFLOW.md` → "Core Review Lifecycle" / "HSE Five-Minute Window."

7. **Status of a renewed permit.**
   WORKFLOW.md's Renewal section confirms the *numbering* rule (new
   Permit Number, same JSA Number, previous permit preserved/linked) but
   does not state what `status` the newly-created permit starts in -
   e.g. whether it is issued directly by CRO (continuing the same
   authorization) or must re-enter CRO/HSE review. Not implemented
   pending that decision. See `WORKFLOW.md` → "Renewal."

Additional open questions may be appended here as they are identified
during future sections; each new entry should record enough context to
be actionable later (what's undecided, why it matters, where it's
referenced).
