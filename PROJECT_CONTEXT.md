# Project Context

## What This Is

E-Set Digital Permit System is a new, production Progressive Web
Application for managing work permits: creation, CRO review, HSE review,
issuance, hold/resume, cancellation, renewal, and closure, with full
audit history.

It will be developed in VS Code, version-controlled with Git/GitHub, and
built step by step, one verified section at a time.

## Relationship to Other Systems

- **E-Set Digital Management System** — a separate, unrelated application.
  This project shares no code, database, or deployment with it.
- **V5.19 legacy permit system** — a business/workflow reference only.
  Its rules around numbering, CRO/HSE review, and closure inform this
  system's workflow requirements, but its technical architecture must
  not be copied into this system. Notably, V5.19's `SYSTEM_ADMIN` role is
  **not** assumed to exist here (see [[DECISIONS.md]]).

## Current State (as of this document)

The authoritative Permit + JSA work is complete on branch
`feat/authoritative-permit-jsa`, deployed to the live project, and
verified in hosted UAT. **`main` has not been merged yet.** Known-good
checkpoint: `a52cbe2`.

This is a snapshot of what is verified, not a statement of requirements -
`DECISIONS.md`'s Open Decisions govern what is still genuinely
unresolved.

### Database

- Migrations `0001`-`0034` are applied and live-verified against the live
  Supabase project. **There is no outstanding migration.** See
  `database/migrations/README.md` for the per-migration ledger.
- `0032_pdf_renderer_v3.sql` (the `PDFKIT_V3` renderer identity),
  `0033_per_permit_type_numbering.sql` (per-type counters and the
  per-type uniqueness rule) and `0034_permit_number_on_submission.sql`
  (allocation moved to submission) are all **APPLIED / LIVE / RECORDED**.

### Numbering

- A **DRAFT carries no permit number.** Nothing is consumed by creating,
  editing or abandoning one.
- The number is **assigned atomically on the first successful
  `DRAFT -> PENDING_CRO` submission**, from the permit type's own
  database-side counter, and is permanent thereafter. A failed or
  rolled-back submission consumes nothing.
- **Independent per-type series are live and UAT-verified:** Cold Work
  `CW-*`, Hot Work `HW-*`, WTG Work `WTG-*`, Confined Space Entry
  `CS-*`. `CW-1`, `CW-2`, `HW-1`, `WTG-1` and `CS-1` were all observed on
  the hosted environment.
- **JSA numbering remains one independent global sequence** across all
  permit types.

### Workflow

- **Partial submissions are accepted.** A permit or JSA may be submitted
  incomplete - review exists to see what was and was not filled in. Only
  a meaningless or empty submission is refused.
- CRO forwards to HSE and that forward **starts the 5-minute HSE review
  window**, timed by the database.
- **HSE can approve immediately.** After the window expires, an
  authorized CRO's **fallback approval becomes available**; nothing
  approves automatically, and no scheduler or timer transitions a permit
  because a deadline passed.
- **HSE approval and CRO fallback approval race safely**, sharing a row
  lock, with exactly one authoritative winner; the loser is refused as a
  conflict and creates no second issuance or signature. See
  `DECISIONS.md` → "HSE Window Expiry and CRO Fallback".
- **HSE retains read-only access** to a permit it reviewed, after
  issuance and through `HELD`/`CANCELLED`/`CLOSED`, and **gains no
  post-issuance action**. `DRAFT`, `PENDING_CRO` and `PENDING_CORRECTION`
  remain invisible to HSE.
- An authorized CRO can **Hold, Resume and Close**.
- **The closing actor is recorded as the CRO who actually performed the
  closure**, which need not be the CRO who forwarded or authorized the
  permit; the record shows the closure and the frozen authorization as
  separate facts, and the closing actor is named on its own lifecycle
  event.

### Issued documents

- **Issued PDF generation is live**, through the backend document worker.
- **`PDFKIT_V3` output is live**, including the blue vector checkmarks
  used for every selected checklist and multi-select value.
- **Issued PDFs remain immutable** after Hold, Resume and Closure: no new
  snapshot, no new document job, and no change to renderer version,
  expected file hash or storage path. `PDFKIT_V1`/`V2` output is
  byte-unchanged and pinned by test.

### Frontend

- A complete React + TypeScript PWA covering the whole agreed surface -
  application across all four templates, the paper-form Permit and JSA
  editors, CRO and HSE review, records/detail/history, the secured PDF
  action, notifications, the employee lifecycle, and CEO-only Site
  Manager administration.
- Success messages are live: **"Permit issued successfully."** (HSE
  approval and CRO fallback approval) and **"Permit closed successfully."**
  Each appears only after the backend confirms the transition, never on a
  failed request, and is not re-shown by a refresh.
- Frontend authorization is presentation only; every screen re-asks the
  backend and shows its refusal honestly.

### Hosted UAT verification

The following were exercised end to end on the hosted environment:
draft -> partial submit; per-type numbering including `CW-1`, `CW-2`,
`HW-1`, `WTG-1`, `CS-1`; CRO review and forward; HSE immediate approval;
CRO fallback approval after 5 minutes; PDF generation and download;
Hold -> Resume with its lifecycle history; closure with the actual
closing actor recorded in the closure section and history; the issued PDF
unchanged after closure; and HSE read-only access after issuance.

### Still genuinely open

- No WhatsApp provider is selected or configured - the outbox reports
  messages as pending/failed until one is (`DECISIONS.md` open decision
  #1).
- Whether closure remarks are mandatory is not finalized; they are stored
  as optional today (`DECISIONS.md` open decision #2).
- The authoritative per-template checklist item catalogue is not signed
  off (`DECISIONS.md` open decision #3).
- Supabase leaked-password protection and privileged-account MFA are not
  enabled/live-verified - both remain go-live blockers (`DEPLOYMENT.md`).
- Explicit site scoping must be designed before a second site or security
  domain shares this database.
- Backend production hardening (rate limiting, security headers,
  structured request logging with a correlation id, environment
  validation, `/ready` alongside `/health`, and an explicit trusted-proxy
  allowlist) is in place; see `DEPLOYMENT.md` for the manual production
  configuration it depends on and the single-instance constraint on the
  in-memory rate limiter.

## Core Scope

- Permit creation and submission by permitted team users.
- Sequential review: CRO first, then HSE (with a strict 5-minute review
  window and CRO fallback approval authority).
- Permit issuance with authoritative actor/timestamp recording.
- Midnight-based validity (not rolling 24-hour), evaluated using
  authoritative backend/database time in the configured site timezone.
- Hold / Resume of permits by CRO.
- Cancellation by CRO (preserving history, no deletion).
- Closure by CRO only (no creator-initiated closure).
- Renewal after midnight expiry, issuing a new Permit Number while
  preserving the same JSA Number and linking to permit history.
- Read-only immutable issued PDFs are implemented and LIVE: the private
  Supabase Storage bucket and Storage-scoped S3 credentials are
  configured, the backend document worker generates the issued document,
  and `PDFKIT_V3` renders the authoritative Permit + JSA pages. Upload
  never uses Auth Admin. What remains open is sign-off of the exact
  per-template checklist item lists (`DECISIONS.md` open decision #3) -
  those must not be invented, and any later change to them extends the DB
  schema, validation, draft APIs, snapshot schema/version and renderer
  together.
- Durable, non-blocking in-app notifications - implemented. Durable,
  non-blocking WhatsApp lifecycle notifications via a future provider
  integration (permit actions never depend on notification delivery) -
  outbox foundation implemented, provider not yet selected.
- Capability-based authorization derived from Team + Position, plus a
  separate privileged management tier (CEO, Site Manager).

## Explicitly Out of Scope (for now)

- The four permit templates and the JSA are implemented from the supplied
  forms and driven by a server-side catalogue, and their sections,
  checklists, PPE/hazard bands, isolation points and gas-test records are
  live and UAT-verified. What is still NOT settled is formal sign-off of
  the exact item lists per template (`DECISIONS.md` open decision #3);
  nothing beyond what the supplied forms specify is guessed, and later
  official changes must extend the DB schema, validation, draft APIs,
  snapshot schema/version, and renderer together.
- Before a second site/security domain shares this database, explicit site
  scoping must be designed across permits, assignments, queues, recipients,
  notifications, search, and relevant history/reporting.

- Microservices, message brokers, Redis, Kubernetes, or other scaling
  infrastructure not justified by an actual current requirement.
- Digital signature functionality.
- Any assumption about the final WhatsApp integration method.
- Automatic time-based transitions of any kind: nothing in this system
  approves, expires, or closes a permit because a clock passed a value.
  Every transition is performed by an authenticated actor.

## How to Use This Documentation Set

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — target stack, trust boundaries, module principles.
- [`WORKFLOW.md`](./WORKFLOW.md) — permit lifecycle states and transitions, with open questions flagged.
- [`SECURITY.md`](./SECURITY.md) — security/integrity requirements and per-section development gates.
- [`DATABASE.md`](./DATABASE.md) — database design principles only (no schema yet).
- [`DECISIONS.md`](./DECISIONS.md) — accepted decisions and the authoritative open-decisions log.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — manual production configuration and deployment-time constraints (not workflow/business rules).

These files are the authoritative source of truth for requirements
EXCEPT where actual code, migrations and configuration already supersede
them - which, for the Permit + JSA workflow, they now do. Where a
document and the live system disagree, the live system and its tests are
the fact and the document is the bug.
