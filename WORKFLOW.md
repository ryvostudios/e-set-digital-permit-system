# Workflow

This document describes the known permit lifecycle. Rules explicitly
marked **UNRESOLVED** are not to be implemented until finalized — see
`DECISIONS.md` for the authoritative open-decisions log.

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

- Every permit has a **Permit Number**.
- Every JSA has its own **JSA Number**.
- The following actions keep both numbers unchanged:
  Review, CRO send-back, HSE send-back, Correction, Resubmission, Hold,
  Resume.
- **Only renewal after midnight** creates a new Permit Number. Renewal
  keeps the same JSA Number.
- Number generation must eventually be atomic, unique, and
  concurrency-safe (see `DATABASE.md`).

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

**UNRESOLVED:** The period after the 5-minute window has expired but
before CRO has actually performed fallback approval is not defined (can
HSE still act during this gap? is there a distinct state?). Do not invent
this rule — see `DECISIONS.md`.

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

## Related Open Decisions

See `DECISIONS.md` → "Open Decisions" for the authoritative, current
list - as of this revision: the HSE-window-expired-but-not-yet-
fallback-approved gap, the WhatsApp integration method, and whether
closure remarks are mandatory. (Allowed states for Hold, allowed states
for Cancel, CRO/HSE send-back target state, and the status of a renewed
permit were resolved in this same revision - see `DECISIONS.md` →
Accepted Decisions.)
