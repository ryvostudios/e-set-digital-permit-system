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

### PDF (immutable issued Permit+JSA document - implemented this batch)
- Issued and closed permits get a generated, read-only PDF from
  authoritative backend data, preserving the official form-style layout,
  supporting View and Download, not user-editable within the
  application. No digital-signature functionality is implemented; any
  paper signature boxes are preserved visually unless specified
  otherwise later.
- CORE BUSINESS RULE: every ISSUED permit has exactly ONE combined PDF
  containing the Permit then the JSA (never two separate PDFs).
- The instant a permit is ISSUED (HSE approval, CRO fallback approval, or
  renewal's immediate ISSUED creation), an immutable business-content
  snapshot is captured atomically in the SAME transaction
  (`issued_document_snapshots`, migration `0013`) - Permit Number, JSA
  Number, every currently-existing permit/JSA business field, and
  issue/validity metadata. Once written, this snapshot can never be
  updated, deleted, or truncated by anyone - including the CEO or Site
  Manager - a stricter rule than ordinary audit-log append-only
  governance, database-enforced the same way `permit_lifecycle_events`
  already is.
- Migration `0013` applies the same invariant to pre-existing issued
  permits (including currently HELD/CLOSED/CANCELLED and renewals): it
  derives metadata only from the unique authoritative approval/renewal
  lifecycle event, aborts on missing/ambiguous history, and inserts one
  snapshot/job idempotently.
- Later Hold, Resume, Cancel, Close, and Renewal are additive operational
  events only - none of them ever rewrites the originally issued
  snapshot or its PDF. Renewal creates a brand-new permit with its OWN
  new snapshot (new Permit Number, same JSA Number/content, a recorded
  link to the previous permit); the old permit's snapshot is untouched.
- Actual PDF file generation/upload is a separate, retryable job
  (`permit_document_jobs`) that reads only the immutable snapshot -
  issuance succeeds and commits independent of whether PDF
  generation/storage has happened yet, or ever succeeds. Once a job
  reaches `GENERATED`, its stored file reference/hash can never be
  changed to point at a different file.
- PDF workers use atomic token/lease claims. After an upload-success/
  database-finalization crash, retry downloads the deterministic private
  object and compares SHA-256 with freshly generated bytes from the
  immutable snapshot: equal bytes are finalized; unequal bytes fail
  closed and are never overwritten. Downloads repeat the file-hash
  check before serving.
- Storage is a PRIVATE Supabase Storage bucket
  (`SUPABASE_STORAGE_BUCKET`), accessed only via a server-only
  service-role credential (`SUPABASE_SERVICE_ROLE_KEY`) - never exposed
  to the frontend, and left genuinely unset in every environment so far
  (a manual production configuration step - see `DEPLOYMENT.md`). Without
  it, PDF jobs simply stay retryable/pending; issuance itself is
  unaffected either way.
- `GET /api/v1/permits/:id/pdf` authorizes permit visibility BEFORE ever
  looking up the document (same pattern as permit detail/history), only
  ever serves the immutable issued PDF, and returns an explicit
  processing/unavailable status - never a fake PDF - if generation or
  storage hasn't completed.

### Notifications (in-app - implemented)
- In-app notifications are database-backed, persistent, and auditable
  (`notifications` table, migration `0013`). The recipient is always
  resolved server-side from the authoritative Team + Position ->
  Capabilities model (or the permit's own `created_by`) - a client can
  never choose or influence who receives a notification. A user reached
  via more than one Team + Position assignment is notified once, not
  once per assignment.
- Workflow handoffs create notifications atomically with the permit
  transition that causes them (same database transaction - a successful
  transition never silently loses its notification): applicant
  submit/resubmit -> every current CRO recipient; CRO forwards to HSE ->
  every current HSE recipient; HSE sends back -> every current CRO
  recipient; CRO sends back for correction -> the original applicant;
  issuance (HSE approval or CRO fallback approval) -> the applicant AND
  every current CRO recipient; Hold/Resume/Cancel/Close -> the applicant;
  Renewal -> the applicant, identifying the NEW Permit Number.
- `GET /api/v1/notifications` (bounded pagination, `?unread=true` filter)
  and `POST /api/v1/notifications/:id/read` are recipient-scoped only - a
  notification belonging to another user is never visible or markable,
  and (like every other object-access check in this API) responds 404,
  not 403, for one that exists but isn't the caller's.
- Idempotent via a database uniqueness constraint on
  (`source_event_id`, `recipient_user_id`) - a retried or racing
  transition can never create a duplicate notification for the same
  recipient about the same event.
- Responsibility-changing handoffs (submit, resubmit, forward to HSE,
  HSE send-back to CRO) require a non-empty authoritative destination
  recipient set. Empty resolution aborts the transaction with a conflict;
  status, lifecycle, notifications and side effects all roll back.

### Notifications (WhatsApp outbox - foundation implemented, provider still open)
- The company WhatsApp group message (ISSUED, HELD - with the mandatory
  hold reason, RESUMED, CANCELLED, RENEWED - with both the previous and
  new Permit Number, CLOSED) now has a durable, idempotent OUTBOX
  foundation (`whatsapp_outbox_messages`, migration `0013`), enqueued
  atomically with the same permit transition, in the same transaction -
  exactly one message per qualifying lifecycle event, and the permit
  transition itself never depends on WhatsApp, or any provider, being
  reachable.
- The actual send mechanism is a pluggable `WhatsappProvider` interface
  (`backend/src/domain/notifications/whatsappOutbox.ts`) with only one
  implementation shipped so far: `disabledWhatsappProvider`, which always
  reports failure with a clear "not configured" reason rather than faking
  delivery. `npm run outbox:whatsapp:process` is the operator-run sender
  (not invoked automatically - no cron/scheduler exists in this
  codebase) that will use a real provider once one is selected.
- Workers atomically claim rows with a token and expiring lease; only the
  active token may mark delivery success/failure, stale claims can be
  recovered, retries use bounded backoff, and `source_event_id` is
  supplied to providers as their idempotency key.
- **Which provider/API to integrate remains the open WhatsApp
  integration-method decision** - see Open Decision #2, unchanged by this
  batch. Building the outbox foundation is not the same as resolving that
  decision.

### Permit Templates and Form Content (implemented; migration 0016 unapplied)
- V1 ships exactly four permit templates - `WTG_WORK`, `COLD_WORK`,
  `HOT_WORK`, `CONFINED_SPACE_ENTRY` - plus one shared `JSA_V1`. A
  permit's template is fixed when the draft is created and can never be
  changed by a client; its `form_version` is derived server-side from
  the template, and the database refuses any type/version pair that
  disagrees.
- Storage is hybrid: workflow/search/lifecycle fields stay relational,
  while the template-specific and JSA form CONTENT is a versioned JSONB
  payload validated by a strict Zod schema before it is ever written.
  Unknown properties are rejected, and a payload shaped for one template
  can never be stored against another. The promoted relational columns
  (`wind_farm`, `wtg_number`, `work_description`, `loto_number`,
  `jsas.site_or_wtg`, `jsas.job_description`) are server-derived
  projections written in the same statement as the payload, never
  independently client-supplied.
- The schemas reproduce the STRUCTURE of the real supplied forms. Where
  the supplied forms did not give the individual checklist questions (or
  an option list's exact options), those sections are modelled as
  repeatable labelled rows rather than guessed - see "Open Decisions"
  below. Cold Work's Nature of Work and Hazards lists were supplied
  verbatim and are hard-coded.
- A permit may be incomplete only while it is still a `DRAFT`. Leaving
  `DRAFT` requires the template, form version, payload, and a completed
  linked JSA - enforced by the API and, independently, by database
  constraints.
- Opening a record shows Permit, JSA, and History. List/search responses
  are summaries and never carry a form payload; only permit detail does.

### Digital Signatures and Workforce Identity (implemented; migration 0016 unapplied)
- A signature is never typed, chosen, or uploaded. The applicant signs by
  performing the authenticated submission; CRO signs by performing the
  authenticated CRO authorization (forward to HSE); HSE signs by
  performing the authenticated approval; CRO fallback approval signs as
  `CRO FALLBACK APPROVAL` and NEVER produces an HSE signature. No API
  accepts a signer name, designation, or user id.
- Signing identity comes from `workforce_profiles` (display name plus a
  primary Team + Position that is the authoritative SIGNING DESIGNATION).
  The primary assignment must be one that same user actually holds -
  enforced by a composite foreign key onto `user_team_positions`, not
  merely by application code.
- Authorization is UNCHANGED: capabilities still derive only from
  Team + Position -> Capabilities. The signing designation grants
  nothing.
- FAIL CLOSED: with no profile, or a primary assignment the user does not
  hold, the signing action is refused and its whole transaction rolls
  back. There is deliberately no fallback to an email address, Supabase
  `user_metadata`, a client-supplied name, or a client-supplied position.
- Every signature's identity is COPIED into the signature row at the
  moment it is made, and then frozen again into the immutable issued
  snapshot, so a later rename, re-designation, or account change can
  never alter a historical document. The database independently enforces
  that a signature names the authenticated actor of its own lifecycle
  event, belongs to that event's permit, and matches the exact event type
  its role can come from.
- The issued PDF renders Permit page(s) -> JSA page 1 -> JSA page 2 from
  the immutable snapshot alone, and the same snapshot always renders
  byte-identical bytes. Renewal reuses the same JSA and inherits the
  previous permit's frozen signatures, adding the renewing CRO's own
  renewal signature; nothing is re-resolved from a live profile.

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

### Permit Search / Lifecycle Audit Search (implemented this batch)
- `GET /api/v1/permits/search` and the extended `GET /api/v1/permits/:id/history`
  (optional `eventType`/`actorUserId`/`fromStatus`/`toStatus`/
  `occurredFrom`/`occurredTo`/pagination filters) reuse the EXACT SAME
  access model as every other read endpoint
  (`domain/permits/access.ts::canViewPermit`/`STATUS_VIEW_CAPABILITIES`,
  via the new `computeViewableStatuses`) - a search can never reveal a
  permit, or a lifecycle event on a permit, the caller could not already
  view directly. No broader access was added merely to support search.
- Filters map only to genuinely existing columns (Permit Number, JSA
  Number, status, `created_by`, company, date range for permits;
  event/action type, actor, from/to status, date range for lifecycle
  events) - no business field was invented to support search.
- The COUNT query and the returned-rows query are always built from the
  identical WHERE clause and parameter list
  (`domain/permits/search.ts::buildSearchWhere`) - result count and
  returned rows can never diverge in authorization scope.
- History search is READ ONLY - it adds no update/delete/history-editing
  capability; the table's existing append-only database triggers make
  that impossible regardless of what a query asks for.
- `GET /permits/:id/history` with NO filter/pagination query parameters
  preserves its original, pre-existing response shape exactly
  (unfiltered, unpaginated, under the `events` key alone); supplying any
  filter switches to the new paginated/filtered response (adds a
  `pagination` block) - the endpoint was extended, not duplicated into a
  second competing API.

### CEO Bootstrap (implemented this batch)
- The very first CEO is provisioned by a server-only CLI
  (`npm run bootstrap:ceo`, `backend/src/scripts/bootstrapCeo.ts`) -
  never through public signup, a UI flow, or any HTTP endpoint. It
  reuses the EXISTING privileged-access model (`privileged_access_events`,
  migration `0004`) rather than inventing a second privilege
  architecture - it creates/resolves a real Supabase Auth user via the
  Admin API and inserts the very first `GRANTED`/`CEO` row, with a NULL
  `actor_user_id` (the out-of-band administrative bootstrap grant that
  table's schema already anticipated - see that migration's own doc
  comment).
- Refuses to run at all without `SUPABASE_SERVICE_ROLE_KEY` configured,
  and refuses to create a second active CEO if one is already granted -
  it never silently creates a duplicate. The password is read from an
  environment variable and is never logged; operator next-steps
  (mandatory first-login password change, enabling MFA before production
  go-live, removing the bootstrap credentials from the environment
  afterward) are printed on success and documented in `DEPLOYMENT.md`.

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
   "Notifications (Future)." The durable outbox foundation this decision
   will plug into is now built (see "Notifications (WhatsApp outbox -
   foundation implemented, provider still open)" under Accepted
   Decisions) - only the actual provider/send mechanism remains open.

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

4. **The exact checklist questions and option lists on the real forms.**
   The supplied permit/JSA forms gave their SECTIONS (General Work,
   Electrical Work, Mechanical Work, Hydraulic Work, Work at Heights,
   General Requirements, Equipment Condition, PPE, the HSE checklist
   groups, Hot Work's Nature of Work / Type of Hazard, Confined Space
   Entry's Nature of Work / Type of Hazard) but not, in every case, the
   individual printed questions or options. Those were deliberately NOT
   invented: each such section is modelled as repeatable labelled rows,
   so the real wording travels with the rendered form.
   What IS enforced today: every section printed on a form must carry at
   least one answered item (`NA` counts - an item that does not apply is
   recorded as answered, never omitted), item text must be non-blank, no
   item may appear twice within a section, no HSE checklist band may
   appear twice, answers are restricted to `YES`/`NO`/`NA`, and a
   Confined Space Entry gas-test band must carry at least one reading
   with no identical reading recorded twice. A permit or JSA with an
   empty safety section can therefore no longer be submitted, stored,
   issued, or rendered.
   What remains open: WHICH items each section must contain. Confirming
   the authoritative per-template item catalogue (ideally with stable
   item IDs) would let these become fixed, server-validated item sets
   that also reject an unknown or omitted required item; until then two
   permits of the same template can still carry differently-labelled -
   though never empty - checklist rows.

Additional open questions may be appended here as they are identified
during future sections; each new entry should record enough context to
be actionable later (what's undecided, why it matters, where it's
referenced).
