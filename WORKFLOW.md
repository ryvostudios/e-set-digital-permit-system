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
        | CRO reviews                 | Creator corrects & resubmits
        |                             |
        +--> CRO sends back ----------+   (same Permit Number, same JSA Number)
        |
        +--> CRO cancels (where allowed)
        |
        +--> CRO holds (where allowed) -> Resume (post-Resume state
        |                                          UNRESOLVED)
        |
        v
   CRO forwards to HSE
        |
        v
   PENDING_HSE
        |
        v
  HSE review window opens (5 minutes)
```

- Submission always goes to CRO first (`PENDING_CRO`).
- CRO may: review, send back to creator for correction, hold (where the
  finalized workflow allows — **UNRESOLVED**, see below), cancel (where
  allowed — **UNRESOLVED**), or forward to HSE.
- CRO send-back preserves the same Permit Number and JSA Number; creator
  corrects and resubmits, and the permit re-enters the controlled review
  workflow.
- CRO forwarding to HSE moves the permit to `PENDING_HSE` and starts the
  HSE review window.

## HSE Five-Minute Window

- HSE receives a 5-minute review window starting when CRO forwards the
  permit.
- During the valid window, HSE may **approve** or **send back** to the
  original creator for correction (same Permit Number, same JSA Number).
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

- CRO can **Hold** a permit and later **Resume** it.
- Hold and Resume preserve the same Permit Number and JSA Number.
- Both actions create append-only lifecycle/audit events, including
  authenticated actor, authoritative timestamp, and reason/remarks where
  applicable.

**UNRESOLVED:** The exact set of permit states from which Hold is
allowed (e.g. only `ISSUED`? also mid-review states?) is not finalized.
Do not invent this — see `DECISIONS.md`. The permit state that Resume
transitions to is likewise not finalized; do not assume it automatically
returns to whatever state preceded Hold.

## Cancel

- CRO can cancel a permit where the finalized workflow permits
  cancellation.
- Cancellation never deletes the permit; it preserves historical data and
  creates an audit/lifecycle event.

**UNRESOLVED:** The exact set of permit states from which cancellation is
allowed is not finalized and must be explicitly defined before
implementation — see `DECISIONS.md`.

## Closure

Closure replaces the old V5.19 closure workflow. There is **no** creator
closure request and **no** creator final closure step.

```
ISSUED -> CRO CLOSE -> CLOSED
```

- Only CRO closes a permit.
- Closure records the authoritative actor, timestamp, and any
  closure information/remarks required by the finalized closure form.
- Closed permits are treated as immutable historical records through
  ordinary application operations.

## Renewal

- Renewal occurs after a permit becomes invalid at midnight.
- CRO performs the renewal.
- Renewal issues a **new Permit Number** and keeps the **same JSA
  Number**. Example: Permit `CW-1045` / JSA `JSA-0234` renews to Permit
  `CW-1046` / JSA `JSA-0234`.
- The previous permit is preserved and linked historically to the
  renewed permit; renewal never overwrites or deletes prior permit
  history.

## Lifecycle Audit Events (indicative)

Exact event names are finalized during implementation, but the expected
event set includes: `CREATED`, `SUBMITTED`, `CRO_SENT_BACK`,
`RESUBMITTED`, `CRO_FORWARDED_HSE`, `HSE_SENT_BACK`, `HSE_APPROVED`,
`CRO_FALLBACK_APPROVED`, `ISSUED`, `HELD`, `RESUMED`, `RENEWED`,
`CLOSED`, `CANCELLED`. Audit/lifecycle history is append-only and must
not be casually overwritten.

## Notifications (Future)

Desired lifecycle notifications (WhatsApp, via future integration):
`ISSUED`, `HOLD`, `RESUMED`, `RENEWED`, `CLOSED`. Permit/database actions
never depend on notification delivery succeeding (see `ARCHITECTURE.md`).

## Related Open Decisions

See `DECISIONS.md` → "Open Decisions" for the authoritative list,
including: the HSE-window-expired-but-not-yet-fallback-approved gap,
allowed states for Hold, and allowed states for Cancel.
