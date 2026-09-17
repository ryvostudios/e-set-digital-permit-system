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
- Draft permits are unnumbered. A Permit Number is assigned atomically on
  the first successful `DRAFT -> PENDING_CRO` submission.
- Permit numbering uses independent per-type sequences: `WTG-*`, `CW-*`,
  `HW-*`, and `CS-*`. JSA numbering remains one independent global sequence.
- Review, CRO send-back, HSE send-back, correction, resubmission, hold,
  and resume all keep the same Permit Number and same JSA Number.
- Only a post-midnight renewal creates a new Permit Number, keeping the
  same JSA Number.
- Permit and JSA number allocation is database-authoritative, unique,
  atomic, and concurrency-safe.

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

### Permit Templates and Form Content (implemented; migration 0016 applied and live-verified)
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

### Digital Signatures and Workforce Identity (implemented; migration 0016 applied and live-verified)
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

### Employee Accounts and Password Management (implemented; migration 0017 applied and live-verified)
- A Site Manager provisions a normal employee account with an email, a
  real display name, a Team + Position assignment, and a temporary
  password. The temporary password is set directly on the Supabase Auth
  identity and is NEVER stored in any PostgreSQL application table,
  returned by any API, or written to any log.
- Authorization is the CEO / E-SET SITE_MANAGER privileged system role
  itself, derived from the append-only `privileged_access_events` log and
  not grantable through this API. It is deliberately NOT additionally
  gated on a Team + Position capability: CEO and E-SET Site Manager are
  privileged system accounts with no Company, Team, or Position at all, so
  requiring `employee.create` / `employee.reset_password` (which can only
  come from a Team + Position) could be satisfied only by fabricating an
  organizational assignment for them - which the identity model forbids -
  and would otherwise leave account management unreachable for the only
  accounts entitled to perform it. This does not let Team + Position
  confer management authority: a capability is not merely insufficient
  here, it is not consulted at all, and capability authorization is
  untouched everywhere else (permits, JSA, review queues), where it
  governs normal employees. The `employee.create` /
  `employee.reset_password` capability NAMES seeded by migration 0017
  remain in the catalogue but gate nothing; migration 0017 is applied
  history and is not edited.
- CEO remains strictly above Site Manager, and multiple active E-SET Site
  Managers are allowed, each holding the same full Site Manager authority.
  Granting or revoking SITE_MANAGER itself is a CEO-only act, and no
  grant/revoke service exists yet (see migration 0004).
- The normal-employee endpoints fail closed for protected identities: a
  target holding ANY privileged grant (CEO or Site Manager) can never be
  provisioned or reset through them, and a manager may not act on their
  own account there. Protection is derived from `privileged_access_events`,
  never from `user_metadata`, an email pattern, or any client hint. These
  endpoints never write `privileged_access_events` or
  `team_position_capabilities` at all, so they cannot create a CEO, grant
  privileged access, or grant arbitrary capabilities. Employee provisioning
  may use only a Team + Position explicitly approved out of band with
  `site_manager_assignable = TRUE`; migration 0017 defaults every existing
  and future assignment to FALSE and exposes no endpoint for changing it.
- A provisioned or reset account carries `must_change_password = TRUE`
  (`app_user_access`, migration 0017). The BACKEND enforces the
  consequence: `requireAuth` refuses every application route with
  `PASSWORD_CHANGE_REQUIRED` until the change completes, and only
  `GET /auth/me` and `POST /auth/change-password` opt out (via
  `requireAuthDuringPasswordChange`). Enforcement is fail-closed by
  default - a route added later is covered automatically, because
  skipping the gate requires naming a different middleware.
- Because `app_user_access` is already read on every authenticated
  request, a Site Manager reset takes effect on the NEXT request made
  with an already-issued access token: Supabase JWTs stay
  cryptographically valid until they expire, so application-side
  credential state - not Supabase logout - is what actually withdraws
  access immediately. No request ever queries `auth.sessions`.
- Auth and PostgreSQL are not one transaction, so each operation commits
  in an order whose only reachable intermediate state is a SAFE one:
  provisioning creates the Auth identity first (an identity with no
  `app_user_access` row can reach nothing) and compensates by deleting it
  if the single PostgreSQL transaction fails. A manager reset first commits
  `must_change_password = TRUE`, a pending-reset marker, and a monotonically
  increasing credential version, then performs the version-serialized Auth
  update. Failures never reopen access. Self-change captures that version and
  clears the gate only when no newer/pending manager reset exists. Operations
  that call Supabase Auth use an AbortSignal-backed hard HTTP timeout (8-second
  default). The serialized manager-reset transaction applies local lock,
  statement, and idle-in-transaction guards, while manager account operations
  have a separate default burst limit of three, below the default pool size.
  All partial failures remain safely retryable without pretending the two
  systems are atomic.
- Account actions are audited in `account_audit_events`
  (EMPLOYEE_ACCOUNT_CREATED, EMPLOYEE_PASSWORD_RESET_BY_MANAGER,
  EMPLOYEE_PASSWORD_CHANGED) - append-only, and with NO free-text column,
  so a password or token is structurally impossible to record.

### Company Membership and Privileged System Identities (implemented foundation; migration 0018 applied and live-verified)
- There are two account categories, and they are not the same kind of
  thing. A NORMAL EMPLOYEE is an organizational identity: Company, Team,
  Position, name, email, credentials. A PRIVILEGED SYSTEM ACCOUNT (CEO,
  E-SET SITE_MANAGER) is not an organizational employee for authorization
  purposes at all.
- Every normal employee belongs to EXACTLY ONE company, through the single
  `workforce_profiles.company_id` reference. The confirmed initial
  companies are exactly `E_SET` / E-SET, `ZPL` / ZPL, and `SGRE` / SGRE.
  Because `workforce_profiles` is keyed by `user_id` and `company_id` is
  NOT NULL, zero companies and multiple companies are unrepresentable, not
  merely rejected - there is no join table that could hold a second
  membership.
- Company is authoritative server-side data. It is never inferred from an
  email address or its domain, Supabase `user_metadata`, a permit payload,
  client state, a Team name, or a Position name. Employee provisioning
  accepts one strict company CODE, resolves it against the backend-only
  `companies` table, and fails closed on an unknown or missing company
  BEFORE any Supabase Auth identity is created, so an invalid company can
  never leave a half-provisioned Auth user behind. The client cannot
  supply a company name, a company object, a database identifier, or a
  list of companies (`.strict()` request schema). No endpoint can create a
  company.
- CEO and E-SET SITE_MANAGER have NO Company, NO Team and NO Position, and
  no fabricated membership is created to satisfy database constraints.
  This needs no nullable column: `workforce_profiles` has been the
  ORGANIZATIONAL employee store since migration 0016, whose composite
  foreign key already requires a Team + Position the same user actually
  holds - so a privileged identity has no row there at all. Migration 0018
  enforces that direction in the DATABASE: a user holding an active
  CEO/SITE_MANAGER grant cannot be given a workforce profile.
- A ZPL "Site Manager" is an ordinary ZPL organizational POSITION and is
  completely different from the privileged E-SET SITE_MANAGER system
  authority. Privileged status is read only from `privileged_access_events`
  - never from a Position name, a Team name, an email pattern, or
  `user_metadata` - so the two can never be confused.
- E-SET privileged Site Managers are granted and revoked by the CEO;
  multiple active E-SET Site Managers are allowed and each holds the same
  full Site Manager authority; a Site Manager cannot grant CEO authority.
  The grant/revoke service itself is still unimplemented (migration 0004).
- `/auth/me` exposes the caller's own authoritative `company` (code and
  name) inside `profile` for a normal employee, and `privilegedRoles` for
  their own active privileged grants. A privileged system account
  therefore reports `profile: null` with a non-empty `privilegedRoles` - it
  is never presented as a normal E-SET company member.
- This is identity/profile foundation only. Permit workflow authorization
  is unchanged by 0018: CRO approval remains E-SET E-BOP -> CRO only, HSE
  approval remains E-SET HSE -> Team Lead / Paramedic only, ZPL HSE has no
  permit approval authority, and hold/resume/cancel/close/renew remain
  CRO-only. No company-specific permit rule is introduced.
- Migration 0018 guesses no membership. It aborts before creating any
  object when a workforce profile already exists, so an operator must
  supply an explicit reviewed mapping rather than have one invented. It
  was applied against a database holding zero workforce profiles and zero
  active privileged grants, so no mapping was required and none was
  invented.

### Organization Structure (implemented; migrations 0019 + 0020 applied and live-verified)
- Teams belong to exactly ONE company (`teams.company_id`, migration
  0019), and a team name is unique per company rather than globally. This
  is what makes "ZPL HSE is not an E-SET permit HSE approver" structural:
  E-SET's `HSE` team and ZPL's `HSE` POSITION are different objects, and a
  ZPL employee cannot be placed on an E-SET team at all - the database
  refuses a workforce profile whose company does not own the team behind
  its assignment.
- The confirmed launch structure, seeded by migration 0020 and by nothing
  else: E-SET Admin (Admin Lead, Assistant Admin), Civil (Team Lead,
  Supervisor, Worker), WTG (Team Lead, Engineer, Technician), E-BOP (Team
  Lead, CRO, Technician), HSE (Team Lead, Paramedic); ZPL (Site Manager,
  Asset Manager, Engineer, HSE); SGRE (Team Lead). `positions.name` is
  globally unique, so "Team Lead" is one row shared by five teams - it is
  always the Team + Position PAIR that carries meaning.
- Every one of the 18 launch combinations is approved for employee
  provisioning (`site_manager_assignable = TRUE`), E-BOP CRO included.
  The flag means only "a manager may place an employee here" and grants
  nothing.
- Initial capability mapping, seeded by 0020 and asserted by the
  migration's own self-verification block:
  - Permit application (`permit.create`, `permit.submit`): all 17 normal
    launch combinations EXCEPT E-SET E-BOP CRO. CRO reviews permits and
    does not apply for them.
  - CRO workflow authority (`permit.cro_review`, `permit.send_back`,
    `permit.forward_hse`, `permit.fallback_approve`, `permit.hold`,
    `permit.resume`, `permit.cancel`, `permit.close`, `permit.renew`):
    ONLY E-SET E-BOP CRO. Each of those capabilities is held by exactly
    one Team + Position in the whole system.
  - HSE approval (`permit.hse_review`, which gates both HSE approval and
    the HSE send-back): ONLY E-SET HSE Team Lead and E-SET HSE Paramedic.
    ZPL HSE and SGRE hold none.
  - Account management is NOT mapped to any Team + Position, by design.
- No migration seeds a person: no employee, workforce profile,
  assignment, privileged identity, or privileged grant is created by
  0019 or 0020.

### Runtime Organization Management (Phase 1 implemented; migration 0035 NOT yet applied)
- **The "organization structure is operator-owned" decision above is
  INTENTIONALLY SUPERSEDED.** That entry records the launch structure as
  seeded "by migration 0020 and by nothing else", and 0020 itself states
  that no runtime endpoint may invent a team, a position or a Team +
  Position combination. A confirmed product requirement now says the CEO
  and an authorized E-SET System Site Manager must manage Companies,
  Teams and Team + Position associations at runtime - for E-SET, ZPL and
  SGRE as well as for companies created later. The earlier entry is left
  intact as the record of what was true then; this entry is what holds
  now.
- The hierarchy stays exactly as 0002/0019/0020 built it: Company -> Team
  -> Team + Position association -> capabilities. `teams.company_id` is
  NOT NULL, so an association reaches a company only through its team and
  can never span two. No default team is created: a company legitimately
  exists with zero teams until an administrator adds them.
- `positions.name` remains a globally unique SHARED vocabulary. Adding
  "Supervisor" to a second team reuses the one row; retiring a
  designation for one team deactivates that team's ASSOCIATION, never the
  shared row. `positions` therefore has no `deactivated_at` at all -
  lifecycle belongs to companies, teams and team_positions.
- **THE BASELINE CAPABILITY POLICY, IN FULL:** *Runtime organization
  management may automatically grant only the standard applicant
  capabilities `permit.create` and `permit.submit` to a newly created
  Team + Position association. It never grants privileged workflow or
  administrative authority. Privileged authority remains explicitly
  controlled by the existing authoritative capability/access model.*
- That IS an automatic grant, and it is deliberate: 0020 gave those two
  capabilities to 17 of the 18 launch combinations, so "can apply for a
  permit" is the normal state of an employee rather than a privilege.
  Without it a new company's employees could log in and do nothing.
- The grant is bounded by construction, not by convention. It travels
  through `grant_baseline_applicant_capabilities()` - a SECURITY DEFINER
  function whose two capability names are LITERALS in database code,
  modelled on 0019's `record_site_manager_grant()`, which hardcodes its
  role for the same reason. The function takes only a team_position id:
  there is no parameter through which a caller could request
  `permit.cro_review`, `permit.hse_review` or `employee.create`, and
  `app_runtime` receives NO INSERT/UPDATE/DELETE on
  `team_position_capabilities`, so the function cannot be bypassed
  either. It raises rather than creating a half-capable association when
  either baseline capability is missing.
- A NAME IS NEVER AUTHORITY, unchanged. A Position named CRO, HSE
  Officer, Site Manager or CEO receives the same two baseline
  capabilities as one named Electrician. Capability resolution joins
  `team_position_capabilities` and never reads a name; privileged
  CEO/SITE_MANAGER status still comes only from
  `privileged_access_events`, which no organization code path touches.
- `site_manager_assignable` becomes API-writable, which 0017 said no API
  could do. It is set TRUE only on INSERT of a brand-new association the
  same authorized administrator just created - never by UPDATE of an
  existing one, and never from a request field. The flag means only "a
  manager may place an employee here" and grants nothing.
- **Deactivation is the only removal; there is no hard delete.** It never
  cascades. It is refused while an ACTIVE employee depends on the record
  (the administrator reassigns or disables the person first), and refused
  when it would push a REQUIRED capability below its coverage minimum.
- **Required coverage is a short explicit list, NOT a global rule.** Only
  `permit.cro_review` and `permit.hse_review` are protected, each with a
  minimum of ONE active holder. There is deliberately no invariant that
  every capability must always have a holder: an optional capability may
  legitimately fall to zero, and organization lifecycle operations must
  not become permanently blocked because one did.
- **A degraded requirement must not freeze the organization either.** The
  bar is `LEAST(minimum, current)`, not the minimum alone: an action is
  refused only when it NEWLY breaks a minimum, or REDUCES coverage that
  is already short. An action that leaves the count untouched is always
  allowed, however degraded the state - otherwise a requirement that had
  fallen below its minimum would block every unrelated retirement,
  including the reassignments needed to restore it. With both configured
  minimums at 1 the "already short but above zero" case is unreachable
  today; the rule is written for a minimum raised later.
- Both the list and the minimum are DERIVED FROM THE WORKFLOW, not
  chosen. `domain/permits/workflowSideEffects.ts` fails closed in exactly
  two places: `onPermitSubmittedOrResubmitted` / `onHseSentBackToCro`
  throw `ResponsibilityRecipientUnavailableError('CRO')` when
  `resolveCroRecipients()` returns none, and `onForwardedToHse` throws
  the HSE equivalent. With no CRO an applicant cannot submit at all; with
  no HSE a CRO cannot forward. Both tests are `length === 0` - AT LEAST
  ONE - so the minimum is 1, never a specific count.
- Migration 0020's `exactly 1 permit.cro_review holder` and `exactly 2
  permit.hse_review holders` are **launch-data SHAPE assertions, not
  permanent required counts.** That block's own stated purpose is that
  "the seed asserts its own shape, so a silently mis-joined INSERT fails
  the migration"; it runs once at migration time and nothing re-checks a
  count at runtime. 0035 re-asserts the same two numbers for the same
  shape-checking reason - to prove it changed no seeded data - and that
  is explicitly NOT the runtime rule.
- The required list is hardcoded as literals in
  `organization_required_coverage_gap()` rather than expressed as a new
  capability-policy column. There is no existing authoritative mechanism
  for marking required coverage (`individually_grantable` from 0023 is a
  different axis), and literals in trusted database code is the idiom
  this schema already uses to bound authority. Coverage is never derived
  from a capability NAMING heuristic.
- The permit applicant company is now authoritative:
  `permits.applicant_company_id` is a foreign key to `companies`.
  `applicant_company_code`/`applicant_company_name` keep exactly the role
  0024 gave them - a frozen display snapshot - and stop being a closed
  vocabulary. `permits.company` is untouched: it is the printed FORM
  field, and a company outside the three printed options renders through
  the `OTHER` + `company_other` escape hatch the form has always had.
  That mapping is generic, so adding a company never needs a code change.

### Organization Rollout: EXPAND -> DEPLOY -> CONTRACT (0035 is the EXPAND step)
- A deployment compatibility audit proved that a single all-at-once 0035
  would have required a maintenance window. With the final
  `applicant_company_id` requirement in place, the CURRENTLY DEPLOYED
  backend fails every permit SUBMIT and RENEW with `23514` on
  `permits_applicant_identity_complete`, because it does not write that
  column. In the other direction the new backend fails with `42703` on a
  0034 database - and not only on writes: `applicant_company_id` is in
  `PERMIT_SUMMARY_COLUMNS`, so every permit LIST read breaks too.
- 0035 is therefore the EXPAND step. It adds the column, its foreign key,
  its index and its deterministic backfill, and relaxes the closed
  `IN ('E_SET','ZPL','SGRE')` code list - but does NOT yet require
  `applicant_company_id` in the complete branch. Both backends satisfy
  it, so it can be applied before the deploy with no outage. This is
  TRANSITIONAL: until the contract migration runs,
  `applicant_company_id` is best-effort, not authoritative, and nothing
  may be built on the assumption that it is always present.
- BACKEND-FIRST REMAINS UNSUPPORTED, deliberately. The new backend
  requires 0035; there is no ordering in which it may be deployed first.
- The CONTRACT migration is deliberately NOT in the repository yet.
  `npm run migrate` (backend/src/db/migrate.ts) reads every `.sql` file,
  sorts it, filters to unapplied and applies ALL of them in one loop. It
  accepts no target argument, so a `0036` present in the directory would
  be applied in the same batch as 0035 and would close the compatibility
  window at once. It is added only after the new backend is live-verified.
- Rollout order: apply 0035 -> deploy the backend -> live-verify submit /
  renew / read / organization directory -> add and apply the contract
  migration, which backfills anything the old backend wrote during the
  overlap, proves nothing is left, and only then makes the column
  mandatory. Steps 1-3 are COMPLETE: 0035 is live, `dba7922` is deployed,
  and the window was verified with a deliberate old-backend write.
- `0036_permit_applicant_company_contract.sql` is the CONTRACT step,
  written and not yet applied. **Once it is applied, rolling the backend
  back past `dba7922` is not safe for applicant-identity writes:** an
  older build writes the three legacy snapshot columns and not
  `applicant_company_id`, which the contracted constraint rejects with
  `23514`, stopping permit SUBMIT and RENEW. Reads are unaffected. A
  rollback would require a forward migration relaxing the constraint,
  deployed first - there is no ordering in which the old backend and the
  contracted constraint coexist.
- PHASE 1 NEEDS NO `app_runtime` ORGANIZATION GRANT. No Organization
  Management mutation route is mounted in Phase 1, so nothing writes a
  company, team, position, association or organization audit row, and the
  existing permit workflow needs none of those privileges. The grants are
  a Phase 2 prerequisite; `UPDATE (name)` on `companies`/`teams` is
  deferred further still, until rename endpoints actually exist.

### Organization Management API (Phase 2 implemented; migration 0037 NOT yet applied)
- **Authority reuses the EXISTING mechanism; no second one was created.**
  Every organization route uses the same `authorize()` gate the employee
  administration mutations already use - CEO or E-SET SITE_MANAGER,
  resolved per request from the append-only `privileged_access_events`
  log. Nothing reads a company, team or position NAME to decide anything.
  An employee whose position is called `CEO`, `Site Manager`, `CRO`,
  `HSE` or `Administrator` gets the same 403 as any other employee; the
  ZPL "Site Manager" job title confers nothing, exactly as before.
- Seven routes, all under `/api/v1/admin/organization`: one read
  (`/structure`), three creates (company, team, team + position) and
  three deactivations (company, team, team-position). There is NO rename
  route, NO delete route and NO capability-management route in this
  phase, and tests assert each of those paths is unrouted rather than
  merely unimplemented.
- **The create routes are nested under their parent; deactivation is
  flat.** `POST .../companies/:companyId/teams/:teamId/positions` rather
  than a flat `/teams/:teamId/positions`, because
  `createTeamPosition()` resolves the team with
  `WHERE t.id = $1 AND t.company_id = $2` - a Phase 1 safety property
  with its own test. A flat route would force the company to be derived
  from the very team id being checked, making the check tautological and
  quietly removing it. A deactivation target is a single row with no
  parent claim to cross-check, so those stay flat.
- **The admin directory is a SECOND current-state reader, not a widened one.**
  `loadOrganization` answers "which combinations may an employee be
  placed into right now?" and is consumed by the employee forms: it
  returns only assignable, fully-active combinations. The new
  `loadOrganizationAdministration`, served at `/admin/organization/structure`,
  returns the active management tree by stable UUID, preserving active
  companies with no teams and active teams with no positions. Retired
  rows remain stored and append-only-audited but are absent from normal
  operational screens. Widening the first reader would have started
  offering retired combinations in the employee forms, which the
  database refuses anyway.
- POSITION_CREATED is emitted ONLY when a global `positions` row is
  genuinely minted. `INSERT ... ON CONFLICT DO NOTHING RETURNING` is
  what distinguishes minting from reusing the shared row; an audit that
  claimed a position was created every time an association was made
  would be describing something that did not happen.
- `app_runtime` INSERT on `privileged_identities` is a REQUIRED contract,
  not drift. A 0037 preflight flagged it as stale; it is not. Migration
  0019's applied delta grants it (DEPLOYMENT.md), and the CEO-only
  `POST /admin/site-managers` endpoint writes that row on the ordinary
  connection - only the GRANT travels over `privileged_runtime`. The
  distinction 0019 drew still holds: a `privileged_identities` row is a
  NAME and confers nothing, while `privileged_access_events` IS
  authority. So the ordinary login may CREATE an identity but must never
  rewrite or remove one, and may not touch the authority log at all.
  0037 enforces exactly that split.
- 0037's self-verification proves the EFFECTIVE privilege surface, column
  by column from the catalogue, because `has_table_privilege(...,
  'UPDATE')` is FALSE when only a column-level grant exists and would
  therefore miss `GRANT UPDATE (name) ON companies`. Its revokes repair
  DIRECT grants; a privilege inherited through role membership is NOT
  repaired - the migration FAILS on it rather than recording a surface it
  did not achieve, and deliberately does not touch role memberships.
- The request can never carry authority. Every schema is `.strict()` and
  names only a display name: there is no `code` field (the server
  generates it and 0035 freezes it), no capability, no
  `siteManagerAssignable`, no privileged marker and no id. Supplying one
  is a 400, not a silently ignored key.
- A runtime-created Team + Position still receives EXACTLY
  `permit.create` + `permit.submit`, through the bounded SECURITY
  DEFINER function, whatever the position is named. Phase 2 adds no new
  capability path and no generic grant function.
- **The database stays the final integrity authority.** 0035's lifecycle
  guards - active-employee dependencies, and required CRO/HSE coverage
  with its do-not-worsen-a-degraded-requirement rule - are never
  bypassed and never duplicated as a stricter application check. The
  domain recognises their refusals and the route layer maps them to a
  clean 409; a raw PostgreSQL error never reaches a client.
- Migration 0037 grants the ten runtime privileges Phase 2 needs and
  actively REVOKES rename, re-code, delete, truncate and direct
  capability writes. Its revokes run BEFORE its grants because PostgreSQL
  cannot subtract a column from a table-level grant - which also makes it
  corrective and idempotent.
- EMPLOYEE PROVISIONING IS STILL CLOSED TO THE SEEDED THREE, deliberately.
  `createEmployeeBodySchema`, `updateEmployeeBodySchema` and
  `employeeListQuerySchema` still use `z.enum(COMPANY_CODES)`, so an
  employee cannot yet be created in a runtime company. That is PHASE 4
  work and does not block Phase 2, which manages structure only.

### Privileged System Identities (implemented; migration 0019 applied and live-verified)
- `privileged_identities` (migration 0019) is the authoritative home for
  a CEO's or E-SET SITE_MANAGER's personal display name - the one
  identity field a privileged system account has. It holds no company,
  team, position, email, or metadata, and a name is never derived from an
  email address or `user_metadata`.
- IDENTITY IS NOT AUTHORITY. A row there confers nothing; whether a user
  is currently CEO or SITE_MANAGER is still derived exclusively from the
  latest `privileged_access_events` row per role. A named identity with
  no active grant has exactly the authority of an unnamed one: none.
- The privileged/employee invariant is now closed in BOTH directions:
  migration 0018 refuses a workforce profile for an actively privileged
  user, and migration 0019 refuses a privileged GRANT - and a privileged
  identity - for a user holding a workforce profile. A REVOKE is never
  blocked, because withdrawing authority must always be possible.
- Promotion is not a workflow. Nothing deletes an employee's profile,
  ends their assignment, or rewrites history to let a grant succeed; a
  normal employee simply cannot become a privileged account. If that is
  ever wanted it must be an explicit, separately designed transition.
- The CEO bootstrap CLI now requires `BOOTSTRAP_CEO_NAME`, writes the
  CEO's `privileged_identities` row in the same transaction as the grant,
  and REFUSES to adopt a pre-existing Auth identity that belongs to a
  normal employee (checked once before the reservation is finalized and
  again inside the transaction, with migration 0019's trigger as the
  final backstop).

### Privileged Role Administration (implemented; CEO-only)
- Only the CEO may establish, grant, or revoke SITE_MANAGER. A Site
  Manager holds full authority over NORMAL employees and none whatsoever
  over the privileged tier: they cannot create a CEO, mint another Site
  Manager, or grant/revoke any privileged role. Enforced by requiring the
  CEO role specifically, not merely "some privileged role".
- Multiple active E-SET Site Managers are expected and supported; each
  holds identical full Site Manager authority. Nothing is a singleton.
- `POST /admin/site-managers` establishes a new privileged account: a new
  Auth identity, an authoritative display name, a SITE_MANAGER grant, and
  `must_change_password = TRUE`, using the same Auth-first/compensate
  ordering as employee provisioning. It never touches
  `workforce_profiles`, `user_team_positions`, or a company.
- `POST /admin/site-managers/:id/grant` re-grants a previously revoked
  Site Manager. It cannot bootstrap a bare Auth id: the target must
  already have a privileged identity, so authority always has a name
  behind it. `.../revoke` withdraws authority while leaving the account,
  its name and its login intact, and takes effect on the target's very
  next request.
- `privileged_access_events` is append-only and records actor, target,
  role, action and reason, so the grant log IS the audit trail for this
  tier and cannot be edited or deleted - including by the backend.
- PRIVILEGED WRITES USE A SEPARATE DATABASE LOGIN. The ordinary
  `app_runtime` credential has no INSERT on the grant log, no sequence
  privilege, and no EXECUTE on the function that writes it - it has no
  route to privileged authority at all. Grants and revokes travel over a
  dedicated `privileged_runtime` login (CONNECT + schema USAGE + EXECUTE
  on one hardened function, and no table privilege whatsoever) through a
  small pool whose only exported operations are
  `recordSiteManagerGrant`/`recordSiteManagerRevoke`. Possession of
  `DATABASE_URL` alone is therefore NOT sufficient to grant SITE_MANAGER,
  even by passing the real CEO's id as the actor - which is exactly why
  granting `app_runtime` EXECUTE was rejected.
- Two independent gates guard every change, neither sufficient alone: the
  HTTP layer re-resolves the caller as an active CEO, and migration
  0019's `record_site_manager_grant()` independently re-derives the
  supplied actor's CEO status, hardcodes the role literal `SITE_MANAGER`
  (never a parameter, so CEO is unreachable by any argument), and refuses
  a self-change, a CEO target, a workforce employee, or a target with no
  privileged identity. It is the only SECURITY DEFINER function in the
  schema; justification, hardening and residual risk are documented in
  the migration and DEPLOYMENT.md.
- AUTHORITY IS SEPARATED BY DATABASE ROLE, not only by application code.
  `app_runtime` cannot write privileged authority; `privileged_runtime`
  can only EXECUTE the hardened SITE_MANAGER function and cannot create a
  CEO; `service_role` is Auth Admin only and, after migration 0022,
  cannot write `privileged_access_events`, `privileged_identities` or
  `initial_ceo_bootstrap` at all; the operator/owner credential is the
  only channel that can create a CEO. Supabase's default privileges had
  silently given `service_role` full DML on all of those, which migration
  0022 revokes (SELECT retained) with a fail-loud self-verification
  block. Any future table holding authorization state must do the same in
  its own migration - creating it is not enough.
- Independently of every privilege above, migration 0004's
  `forbid_mutation` triggers make the grant log append-only for EVERY
  role including the table owner, so recorded governance history cannot
  be rewritten or erased by any credential.
- When the privileged channel is unconfigured, CEO administration returns
  a sanitized 503 and every other endpoint is unaffected. A failed grant
  during Site Manager creation leaves a named account holding NO
  privilege and no capabilities - less authority than intended, never
  more - and the CEO simply retries the grant.

### One Current Assignment, With History (implemented; migration 0019)
- A normal employee holds exactly ONE current Team + Position at a time.
  `user_team_positions.ended_at IS NULL` marks it, and a partial unique
  index on `(user_id) WHERE ended_at IS NULL` makes "exactly one" a
  database fact rather than an application convention.
- History is preserved in place: a transfer stamps `ended_at` on the old
  row and adds the new one. Nothing is ever deleted - migration 0016's
  ON DELETE RESTRICT composite foreign key would refuse it anyway, and
  destroying history to enforce uniqueness is explicitly not the design.
- ONLY THE CURRENT ASSIGNMENT GRANTS ANYTHING. `resolveUserCapabilities`,
  `resolveUserIdsWithCapabilities` (notification recipients),
  `resolveSigningIdentity`, and `/auth/me` all filter to
  `ended_at IS NULL`. Without that filter a transferred employee would
  retain the capabilities of every role they had ever held - a CRO who
  moved to Civil could still close permits - which is exactly what the
  one-current-assignment rule exists to prevent.
- An employee's primary assignment must be one they CURRENTLY hold
  (0019 trigger), so a transferred employee's signing designation and
  profile can never resolve through a retired assignment.
- `started_at`/`ended_at` are database-authoritative and cannot be
  backdated by an application or client clock.

### Not yet implemented (next backend layers)
- **Privileged permit application.** CEO and E-SET SITE_MANAGER may apply
  for permits, with the E-SET business context derived server-side (never
  client-selectable) and with ONLY their personal name shown in the
  applicant identity field and on the PDF - no "CEO", "Site Manager" or
  "E-SET" beside it. NOT yet implemented. The authoritative privileged
  display-name store now exists (migration 0019), but `permit_signatures`
  (migration 0016) still requires a Team + Position on every signature
  row, so a signature identity that carries none needs its own migration.
  Until then a privileged account has no signing identity and every
  action that would produce a signature fails closed for them.
- **Server-derived permit applicant identity.** For normal employees the
  applicant name and Company must come from the authenticated authoritative
  profile and be uneditable by the applicant, with the paper wording
  `Mr. [NAME] of Company [COMPANY]`. Today `permits.company` is still the
  client-supplied `ESET` / `SGRE` / `ZPL` / `OTHER` form field from
  migration 0006, whose values are a different vocabulary from the 0018
  company CODES (`E_SET` / `ZPL` / `SGRE`). Reconciling the two and
  deriving the field server-side is a separate task with its own
  migration; issued snapshots and PDFs stay immutable, so no historical
  record is rewritten.
- **View-all-permits permission.** A persistent, grantable/revocable
  "view all permits" access for a normal employee of any company, on top
  of the existing own-permits default and the authorized workflow review
  queues. The capability does not exist in the schema today and 0018 does
  not touch permit access, so it needs its own migration and is the next
  task, not part of the company foundation.

### Remember Me (frontend requirement - NOT implemented in this batch)
- The login screen must offer a `[ ] Remember me` checkbox. CHECKED: the
  Supabase session may persist across a browser restart. UNCHECKED: the
  session is browser-session scoped. Default UNCHECKED.
- This is purely a frontend session-storage behaviour; the backend is
  already compatible with either and needs no change. Remember Me must
  never bypass JWT verification, the ACTIVE/DISABLED check,
  `must_change_password`, capability authorization, or the credential
  reset restrictions - all of which are enforced server-side on every
  request regardless of how the session was stored.

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

### HSE Window Expiry and CRO Fallback (formerly Open Decision #1; implemented, UAT-verified)
- **Nothing happens automatically when the 5-minute window expires.** No
  scheduler, job or timer exists in this codebase to transition a permit
  because a deadline passed; the permit stays `PENDING_HSE` until a human
  acts. Eligibility is evaluated only when someone actually attempts an
  action.
- **HSE keeps their authority after expiry.** They may approve
  immediately, and they may still approve or send back during the gap.
  The window decides when CRO's fallback becomes AVAILABLE, not when
  HSE's authority ends. This is why `hseApprove` and `hseSendBackToCro`
  have no deadline check - previously noted as merely "consistent with
  this being unresolved", and now the resolved rule.
- **CRO fallback approval requires the deadline to have genuinely
  passed**, computed by the database (`now() >= hse_review_deadline_at`)
  under the same row lock that reads the permit - never by the backend's
  or a browser's clock.
- **The race has exactly one authoritative winner.** Both approvals take
  the same row lock and both require the permit to still be
  `PENDING_HSE` at the expected version. The first to commit issues the
  permit; the loser is refused as a conflict, creates no second issuance
  and no second signature. A fallback approval signs as `CRO FALLBACK
  APPROVAL` and never produces an HSE signature.
- **No distinct intermediate state, and no time limit** on how long a
  permit may sit in the gap. Neither was invented.
- The browser's countdown is display-only: it pairs the DB-authoritative
  deadline with the server's clock as read, so a wrong device clock
  cannot make the window look open or closed. It authorizes nothing.

## Open Decisions

These are explicitly **unresolved** and must not be implemented until
confirmed. Do not invent behavior for these.

1. **WhatsApp integration method.**
   The final mechanism for WhatsApp group/agent integration (which
   provider/API, how the CRO PC agent is installed, how it authenticates
   to the WhatsApp group) is not decided and requires research/
   verification before implementation. See `ARCHITECTURE.md` →
   "Notifications (Future)." The durable outbox foundation this decision
   will plug into is now built (see "Notifications (WhatsApp outbox -
   foundation implemented, provider still open)" under Accepted
   Decisions) - only the actual provider/send mechanism remains open.

2. **Whether closure remarks are mandatory.**
   WORKFLOW.md requires CRO closure to record "the authoritative actor,
   timestamp, and any closure information/remarks required by the
   finalized closure form," but whether remarks must be non-empty (vs.
   optional) is not finalized. Migration `0010` /
   `backend/src/domain/permits/service.ts::closePermit` store closure
   remarks as optional - supported, never required - specifically so
   validation can be tightened later without a data migration. See
   `WORKFLOW.md` → "Closure."

Former items #1 (the HSE-window-expired gap), #2 (allowed states for
Hold), #3 (allowed states for Cancel), #6 (CRO/HSE send-back target
state), and #7 (status of a renewed permit) are now RESOLVED - see "HSE
Window Expiry and CRO Fallback", "Send-Back / Correction", "Hold /
Resume", "Cancel", and "Renewal" under Accepted Decisions above.

3. **The exact checklist questions and option lists on the real forms.**
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
