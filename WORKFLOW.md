# Workflow

This document describes the permit lifecycle as implemented, deployed and
UAT-verified on branch `feat/authoritative-permit-jsa` (`main` not yet
merged). No rule here is marked UNRESOLVED any longer; `DECISIONS.md`
remains the authoritative open-decisions log for what is still genuinely
undecided, and anything found there must not be invented here.

## Actors

- **Creator** — a permitted team user who creates and submits a permit.
- **CRO** — the on-duty Construction/Control Room Officer (one of four
  CRO personnel; only one is on duty/authenticated at a time in normal
  operation).
- **HSE** — reviewer with a strict 5-minute approval window after CRO
  forwards a permit.
- **CEO / Site Manager** — privileged management tier, separate from
  operational Team + Position capabilities (see below).

## Permit and JSA Numbering

- A **DRAFT has no Permit Number at all.** A draft is a private
  work-in-progress: it may be created, edited and abandoned any number of
  times without consuming a number from the operational register.
- The **Permit Number is assigned atomically on the first successful
  `DRAFT -> PENDING_CRO` submission**, inside the submitting transaction.
  A submission that fails or rolls back leaves the draft unnumbered and
  consumes nothing. Once assigned the number is permanent: it cannot be
  changed, cleared, or stripped by returning the permit to `DRAFT`, and a
  released number is never reused.
- **Each permit type has its own independent series**, allocated by a
  database-side per-type counter under a row lock - never computed by the
  frontend or from application memory:
  - Cold Work - `CW-*`
  - Hot Work - `HW-*`
  - WTG Work - `WTG-*`
  - Confined Space Entry - `CS-*`
- Every JSA has its own **JSA Number**, which remains **one independent
  global sequence** across all permit types.
- The following actions keep both numbers unchanged:
  Review, CRO send-back, HSE send-back, Correction, Resubmission, Hold,
  Resume, Closure.
- **Only renewal after midnight** creates a new Permit Number. Renewal
  keeps the same JSA Number.
- Number generation is atomic, unique and concurrency-safe in the
  DATABASE, which is the sole authority (see `DATABASE.md` and migrations
  `0033`/`0034`).

## Submission Completeness

- A permit or JSA may be submitted **partially completed**. Review exists
  precisely so that CRO and HSE see what was and was not filled in.
- What is refused is a **meaningless or empty submission** - there is
  nothing to review. Everything short of that reaches CRO.

## Permit Validity

- Permits do **not** have rolling 24-hour validity.
- An issued permit is valid only until the next midnight in the
  configured site timezone, regardless of what time it was issued.
  - Issued 09:00 -> expires at 00:00.
  - Issued 23:50 -> expires at 00:00 (same operational day boundary).
- Expiry is evaluated using authoritative backend/database time in the
  configured site timezone — never client/browser/device time.
- After midnight the permit is no longer valid; continued work requires
  CRO renewal.

## Core Review Lifecycle

```
Creator creates & submits
        |
        v
   PENDING_CRO  <---------------------+
        |                             |
        | CRO reviews                 | Applicant corrects & resubmits
        |                             |
        +--> CRO sends back --> PENDING_CORRECTION
        |        (same Permit Number, same JSA Number)
        |
        +--> CRO cancels (from ISSUED/HELD only - see "Cancel")
        |
        +--> CRO holds (from ISSUED only) -> HELD -> Resume -> ISSUED
        |                                          (see "Hold / Resume")
        v
   CRO forwards to HSE
        |
        v
   PENDING_HSE ---- HSE sends back ----> PENDING_CRO (see below)
        |
        v
  HSE review window opens (5 minutes)
```

- Submission always goes to CRO first (`PENDING_CRO`).
- CRO may: review, send back to the applicant for correction, hold an
  `ISSUED` permit, cancel an `ISSUED`/`HELD` permit, or forward to HSE.
- CRO send-back moves the permit to `PENDING_CORRECTION` (preserving the
  same Permit Number and JSA Number) - a distinct, persisted state, not
  a reuse of `DRAFT`. Only the original applicant may edit or resubmit
  it; resubmission returns it to `PENDING_CRO`. See `DECISIONS.md` →
  "Send-Back / Correction" for the full resolved rule.
- CRO forwarding to HSE moves the permit to `PENDING_HSE` and starts the
  HSE review window.

## HSE Five-Minute Window

- HSE receives a 5-minute review window starting when CRO forwards the
  permit.
- During the window, HSE may **approve** (`PENDING_HSE -> ISSUED`) or
  **send back** - but send-back goes to **CRO**, not directly to the
  applicant (`PENDING_HSE -> PENDING_CRO`); CRO then decides whether to
  send it on to the applicant, per the CRO send-back rule above. Sending
  back immediately clears/stops the review window
  (`hse_review_started_at`/`hse_review_deadline_at` both cleared); a
  later re-forward by CRO always opens a completely new 5-minute window,
  never a reused or extended deadline. Both directions preserve the same
  Permit Number and JSA Number, and both HSE approval and HSE send-back
  are gated by the same capability (`permit.hse_review`) - the two
  possible verdicts of one review authority, not two separate grants.
- The window is enforced using authoritative backend/database timestamps:
  `hse_review_started_at`, `hse_review_deadline_at`. The browser countdown
  is display-only and has no bearing on authorization. Changing device
  time, JavaScript state, or refreshing the browser must not change
  whether an approval/send-back is valid.
- If HSE does not act within the window, CRO gains **fallback
  approval** authority.
- Once CRO performs fallback approval, HSE must not be able to send
  back or review that completed approval cycle.

### After the window expires (resolved, implemented, UAT-verified)

- **Nothing happens automatically.** No scheduler, job or timer
  transitions a permit because its deadline passed. The permit simply
  stays `PENDING_HSE` until a human acts.
- **HSE does not lose their authority when the window expires.** They may
  still approve or send back; the window governs when CRO's fallback
  becomes AVAILABLE, not when HSE's authority ends.
- **CRO fallback approval becomes available only once the deadline has
  genuinely passed**, evaluated by the database's own clock
  (`now() >= hse_review_deadline_at`) under the same row lock that reads
  the permit - never by the backend's or a browser's clock.
- **The two race safely, with exactly one authoritative winner.** HSE
  approval and CRO fallback approval take the same row lock and both
  require the permit to still be `PENDING_HSE` at the version the actor
  was shown. The first to commit issues the permit; the second is refused
  as a conflict, creates no second issuance, and produces no signature.
  A CRO fallback approval signs as `CRO FALLBACK APPROVAL` and never as
  HSE.

There is deliberately no distinct intermediate state and no time limit on
how long a permit may sit in this gap.

## Issuance

- A permit becomes `ISSUED` via either:
  - valid HSE approval, or
  - valid CRO fallback approval (only after the window has genuinely
    expired).
- Issuance records the authoritative actor and timestamp and creates an
  audit history event.
- Issuance is expected to eventually be implemented atomically.

## CRO Workstation

- Four CRO personnel total; only one on duty/authenticated at a time in
  normal operation, across shifts, on a shared CRO workstation.
- Each CRO authenticates with their own individual account — no shared
  logins.
- No normal requirement for simultaneous CRO claim/assignment of a
  permit.
- If no CRO is logged in, pending-CRO permits remain in a common queue;
  the next on-duty authenticated CRO sees that queue.
- Every CRO action records the actual authenticated CRO identity, not a
  generic "CRO" label.
- Proper logout/session lock is required between shifts.
- Backend concurrency protection is still required generally, even
  though normal operation assumes a single active CRO.

## Hold / Resume

- CRO can **Hold** an `ISSUED` permit (only from `ISSUED` - no
  mid-review state) and later **Resume** it. `ISSUED -> HELD -> ISSUED`.
- A Hold reason is mandatory. Hold and Resume preserve the same Permit
  Number and JSA Number, and both create append-only lifecycle/audit
  events with authenticated actor and authoritative timestamp (plus the
  reason, for Hold).
- While `HELD`, a permit is never valid for work, cannot be edited, and
  cannot be forwarded/approved - only Resume, Cancel, or Close apply to
  it.
- Resume returns the permit to exactly the state it was in before Hold
  (`ISSUED`, same `issued_at`, same original midnight expiry) - it is
  allowed only strictly before that original expiry, using authoritative
  backend time; at or after expiry, Resume fails and the permit must
  instead be Closed (see Closure) and, once expired, Renewed (see
  Renewal). Resume never creates a new permit, never extends or restarts
  validity, and never opens a new HSE review window.

See `DECISIONS.md` → "Hold / Resume" for the full resolved rule
(formerly Open Decision #2).

## Cancel

- Only CRO can cancel, and only from `ISSUED` or `HELD` - not `DRAFT`,
  `PENDING_CRO`, `PENDING_HSE`, `PENDING_CORRECTION`, `CLOSED`, or
  (already) `CANCELLED`.
- Cancellation never deletes the permit; it preserves historical data and
  creates an audit/lifecycle event (actor, authoritative timestamp, and
  an optional reason - not mandatory).
- Cancellation is permanent: a cancelled permit cannot resume, be
  edited, submitted, forwarded, approved, closed, or mutated through any
  other normal workflow action.

See `DECISIONS.md` → "Cancel" for the full resolved rule (formerly Open
Decision #3).

## Closure

Closure replaces the old V5.19 closure workflow. There is **no** creator
closure request and **no** creator final closure step.

```
ISSUED -> CRO CLOSE -> CLOSED
HELD   -> CRO CLOSE -> CLOSED
```

- Only CRO closes a permit, from `ISSUED` or `HELD` - closing a `HELD`
  permit works both before and after its midnight expiry (this is the
  intended path when a held permit needs to continue past midnight: CRO
  closes it, then renews it - see Renewal).
- Closure records the authoritative actor, timestamp, and any
  closure information/remarks required by the finalized closure form.
- **The closing CRO need not be the CRO who forwarded or authorized the
  permit**, and very often is not - work runs for hours and shifts
  change. The record shows both facts separately: the frozen CRO
  authorization on the issued document says who authorized the work, and
  the closure record says who signed it off as finished. Neither is ever
  inferred from the other, and the closure is shown in its own section on
  the record and named on its own lifecycle event.
- **Closure does not regenerate the issued PDF.** It creates no new
  snapshot and no new document job; the renderer version, expected file
  hash and storage path of the issued document are untouched. The same
  document remains downloadable, byte-identical, after closure. Hold and
  Resume leave it equally untouched.
- Closed permits are treated as immutable historical records through
  ordinary application operations.

## Renewal

- Renewal occurs after a permit becomes invalid at midnight, and only
  once that permit has been Closed - renewal is not available for a
  permit that is merely expired but still `ISSUED`/`HELD`.
- CRO performs the renewal (`permit.renew`).
- Renewal issues a **new Permit Number** and keeps the **same JSA
  Number**. Example: Permit `CW-1045` / JSA `JSA-0234` renews to Permit
  `CW-1046` / JSA `JSA-0234`.
- The previous permit is preserved, untouched, and linked historically
  to the renewed permit (`previous_permit_id`); renewal never overwrites
  or deletes prior permit history, and never creates or edits a JSA.
- The renewed permit starts directly `ISSUED` - it does not re-enter CRO
  or HSE review, and has no HSE review window/timer. It carries forward
  the same applicant, company, and site as the permit it renews.
- At most one renewal may exist per old permit, enforced at the database
  level (not just in application code), so a race between two concurrent
  renewal attempts can never both succeed.

See `DECISIONS.md` → "Renewal" for the full resolved rule (formerly Open
Decision #7).

## Lifecycle Audit Events

The full, implemented event set: `CREATED`, `SUBMITTED`,
`CRO_SENT_BACK_TO_APPLICANT`, `APPLICANT_RESUBMITTED`,
`CRO_FORWARDED_HSE`, `HSE_SENT_BACK_TO_CRO`, `HSE_APPROVED`,
`CRO_FALLBACK_APPROVED`, `HELD`, `RESUMED`, `CANCELLED`, `CLOSED`,
`RENEWED`. Each is recorded with the exact `from_status`/`to_status`
pair it represents (database-enforced - see migration `0012`), the
authenticated actor, an authoritative timestamp, and a reason where one
was given. Audit/lifecycle history is append-only and must not be
casually overwritten - `RENEWED` in particular is recorded only on the
NEW permit's own history (`NULL -> ISSUED`); the OLD permit's history is
never touched by its own renewal.

## Notifications

In-app notifications are implemented: every workflow handoff (submit/
resubmit, CRO forward-to-HSE, HSE send-back, CRO send-back, issuance,
Hold, Resume, Cancel, Close, Renewal) creates a recipient-scoped
notification atomically with the transition itself. See `DECISIONS.md` →
"Notifications (in-app - implemented)" for the full recipient rules and
`GET /api/v1/notifications` / `POST /api/v1/notifications/:id/read`.

Submit/resubmit/forward/HSE-send-back are responsibility handoffs: if
the authoritative destination CRO/HSE recipient set is empty, the whole
transition aborts with conflict and no lifecycle/notification side effect
commits.

Lifecycle notifications to the company WhatsApp group (`ISSUED`, `HELD`,
`RESUMED`, `CANCELLED`, `RENEWED`, `CLOSED`) have a durable, idempotent outbox
foundation implemented; the actual WhatsApp provider/send integration
remains not implemented - see `DECISIONS.md`'s open WhatsApp-integration-
method decision. Permit/database actions never depend on notification
delivery succeeding (see `ARCHITECTURE.md`).

## Read Access After Issuance

Reading a permit is not the same authority as acting on it. The HSE
reviewer who approved a permit **keeps read-only access to it after
issuance and through every later state** (`ISSUED`, `HELD`, `CANCELLED`,
`CLOSED`), and **gains no post-issuance action**: hold, resume, cancel
and close remain CRO's alone. This adds no permit to HSE's view - each of
those states is reachable only through `PENDING_HSE`, which HSE could
already read - and the states before their queue (`DRAFT`,
`PENDING_CRO`, `PENDING_CORRECTION`) remain invisible to them.

## Related Open Decisions

See `DECISIONS.md` → "Open Decisions" for the authoritative, current
list - as of this revision: the WhatsApp integration method, whether
closure remarks are mandatory, and the authoritative per-template
checklist item catalogue. (Allowed states for Hold, allowed states for
Cancel, CRO/HSE send-back target state, the status of a renewed permit,
and the HSE-window-expired-but-not-yet-fallback-approved gap are all
resolved - see `DECISIONS.md` → Accepted Decisions and "After the window
expires" above.)
