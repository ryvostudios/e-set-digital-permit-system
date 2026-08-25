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

### Send-Back / Correction (resolves former Open Decision #6)
- CRO may send a `PENDING_CRO` permit back to the original applicant for
  correction. The resulting persisted status is `PENDING_CORRECTION` - a
  distinct, explicitly-named state, not a reuse of `DRAFT` (reusing
  `DRAFT` would conflate "never submitted" with "sent back after CRO
  review" and lose the review history that produced it).
- Only the original applicant (`created_by`) may edit a
  `PENDING_CORRECTION` permit (the same edit authority/capability,
  `permit.create`, as editing a `DRAFT`) or resubmit it
  (`permit.submit` - the same capability as the original submission,
  since resubmission is the same "finalize and send to CRO" authority).
  Resubmission returns the permit to `PENDING_CRO`.
- HSE may send a `PENDING_HSE` permit back to CRO - never directly to
  the applicant. The resulting status is `PENDING_CRO` (not a new
  status): CRO then reviews it like any other `PENDING_CRO` permit,
  including being able to send it on to the applicant per the rule
  above. Authorized by `permit.hse_review` - the same capability that
  gates HSE's approval - since both are HSE's two possible verdicts on
  one pending review, not two separately-grantable authorities.
- HSE send-back immediately clears the HSE review window
  (`hse_review_started_at`/`hse_review_deadline_at` both `NULL`) - "the
  timer stops immediately." When CRO forwards the permit to HSE again
  (after any correction cycle), the existing forward-to-HSE transition
  unconditionally opens a fresh window from the current time - it never
  reuses or extends a prior deadline, and this required no change to
  that transition to be true.
- Both send-back directions, and resubmission, preserve the Permit
  Number and JSA Number, and are fully auditable: every step remains in
  the append-only lifecycle history, including every prior send-back/
  resubmit/forward cycle a permit has been through.

### Hold / Resume (resolves former Open Decision #2)
- Only CRO (`permit.hold`) may place a permit on Hold, and only from
  `ISSUED` - no mid-review state may be held. `HELD -> ISSUED` (Resume)
  is the only path back; there is no other transition out of `HELD`
  except Resume, Cancel, or Close.
- A Hold reason is mandatory (non-empty), recorded with the
  authenticated actor and DB-authoritative timestamp - enforced both at
  the API validation layer and, as defense in depth, by a database CHECK
  constraint.
- A `HELD` permit is never valid for work (`isValid` is always `false`
  while held, regardless of time of day) and cannot be edited, forwarded,
  or HSE-approved - only CRO Hold-related actions (Resume, Cancel, Close)
  apply to it.
- Only CRO (`permit.resume`) may Resume, and only strictly before the
  permit's ORIGINAL midnight expiry (computed from its unchanged
  `issued_at`/site timezone, using authoritative backend time - never
  client-supplied). At or after that expiry, Resume fails; the permit
  must be Closed (see below) instead. Resume never creates a new permit,
  never restarts or extends validity, and never opens a new HSE review
  window - it changes only `status` (back to `ISSUED`) and clears the
  hold metadata; `issued_at` is untouched.
- Hold and Resume preserve the same Permit Number and JSA Number, and
  each creates its own append-only lifecycle/audit event (actor,
  authoritative timestamp, and the reason for Hold).

### Cancel (resolves former Open Decision #3)
- Only CRO (`permit.cancel`) may cancel, and only from `ISSUED` or
  `HELD` - not `DRAFT`, `PENDING_CRO`, `PENDING_HSE`, `PENDING_CORRECTION`,
  `CLOSED`, or (already) `CANCELLED`. Cancellation is permanent: a
  `CANCELLED` permit cannot resume, be edited, submitted, forwarded,
  approved, closed, or mutated through any other normal workflow action
  - every other mutating function already only applies to one or two
    specific source statuses and rejects anything else, so this
    immutability requires no separate mechanism.
- A cancellation reason is optional (not mandated by any current
  documented rule, unlike Hold's) - free-text remarks are accepted when
  given.
- Cancellation never deletes a permit; it preserves the Permit Number,
  JSA Number, and full history, and creates an audit event recording the
  actor, authoritative timestamp, and (if given) the reason.

### Closure
- Closure is performed only by CRO — there is no creator closure request
  or creator final closure. `ISSUED -> CLOSED` and, since Hold was
  resolved above, `HELD -> CLOSED` are both allowed (CRO may close a
  Held permit directly, whether before or after its midnight expiry -
  useful specifically so a Held permit that reaches midnight can be
  Closed and then Renewed, per the Renewal rule below). Closed permits
  are immutable historical records through ordinary operations.

### Renewal (resolves former Open Decision #7)
- Renewal is CRO-only (`permit.renew`). The permit being renewed MUST
  already be `CLOSED`, and renewal is allowed only after THAT permit's
  own midnight expiry has passed (using its unchanged `issued_at`/site
  timezone and authoritative backend time) - regardless of when it
  happened to be closed, since closing before vs. after midnight doesn't
  change when renewal becomes allowed.
- Renewal creates a brand-new permit record - it is not a status
  transition of the old one, which is never written to and remains
  `CLOSED` and untouched. The new permit: gets a new Permit Number (the
  same atomic/concurrency-safe sequence every permit uses); reuses the
  SAME JSA (same `jsa_id`, same JSA Number - never a new or copied JSA,
  never an edit to historical JSA data); links back via
  `previous_permit_id`; is created directly as `ISSUED` with a fresh
  `issued_at` (its own new midnight boundary); and carries over
  `created_by`, `company`, `company_other`, and `site_timezone` from the
  old permit (the same underlying applicant/work/site continuing, not a
  new submission). It goes through NO CRO review, NO HSE review, and has
  NO 5-minute HSE timer - both HSE-window columns are `NULL` on a
  renewed permit, a carve-out in `permits_hse_window_status_consistent`
  that applies only when `previous_permit_id` is set.
- At most one renewal may ever exist for a given old permit - enforced
  by a database-level uniqueness constraint on the new permit's
  `previous_permit_id` (not merely an application-level check), so a
  race between two concurrent renewal attempts on the same old permit
  can never both succeed.
- Renewal is recorded as its own lifecycle event on the NEW permit only
  (`RENEWED`, `NULL -> ISSUED`, directly analogous to how `CREATED`
  records `NULL -> DRAFT`) - the link back to the source permit is the
  new row's real foreign key (`previous_permit_id`), not a lifecycle
  event field, so the OLD permit's own event history is never touched by
  a later renewal, consistent with it remaining genuinely immutable.
- A plain "new permit" (via `POST /permits`, unrelated to renewal) is
  unaffected by any of this: it always gets a NEW Permit Number AND a
  NEW JSA Number, exactly as before.

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
   permit can sit in this gap?) Note: this batch's HSE send-back is
   still deliberately NOT time-gated either, for the same reason
   (`hseApprove`/`hseSendBackToCro` both have no deadline check) - that
   is consistent with this remaining unresolved, not a resolution of it.
   See `WORKFLOW.md` → "HSE Five-Minute Window."

2. **WhatsApp integration method.**
   The final mechanism for WhatsApp group/agent integration (which
   provider/API, how the CRO PC agent is installed, how it authenticates
   to the WhatsApp group) is not decided and requires research/
   verification before implementation. See `ARCHITECTURE.md` →
   "Notifications (Future)."

3. **Whether closure remarks are mandatory.**
   WORKFLOW.md requires CRO closure to record "the authoritative actor,
   timestamp, and any closure information/remarks required by the
   finalized closure form," but whether remarks must be non-empty (vs.
   optional) is not finalized. Migration `0010` /
   `backend/src/domain/permits/service.ts::closePermit` store closure
   remarks as optional - supported, never required - specifically so
   validation can be tightened later without a data migration. See
   `WORKFLOW.md` → "Closure."

Former items #2 (allowed states for Hold), #3 (allowed states for
Cancel), #6 (CRO/HSE send-back target state), and #7 (status of a
renewed permit) are now RESOLVED - see "Send-Back / Correction", "Hold /
Resume", "Cancel", and "Renewal" under Accepted Decisions above.

Additional open questions may be appended here as they are identified
during future sections; each new entry should record enough context to
be actionable later (what's undecided, why it matters, where it's
referenced).
