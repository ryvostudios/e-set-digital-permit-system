# Database

This document defines database **design principles** only. It does not
define or finalize an actual schema, tables, columns, or migrations —
those are created during implementation, informed by these principles
and by the accepted decisions in `DECISIONS.md`.

## Platform

- PostgreSQL, hosted on Supabase infrastructure.
- Supabase Auth may be used for identity/authentication.
- Application database access is mediated through the backend
  (Express) application layer — the frontend never queries the database
  directly, and privileged/service-role credentials are never exposed to
  the frontend.

## Integrity Principles

The database is treated as the final authority on data integrity, not
just a storage layer. Design work should plan for:

- **Transactions** around multi-step critical operations (e.g. issuance,
  renewal, closure) so partial writes cannot occur.
- **Optimistic concurrency / version checks** on mutable records, so a
  stale write is rejected (e.g. HTTP 409) rather than silently
  overwriting a newer version.
- **Row locks** for critical operations where optimistic concurrency
  alone is insufficient (e.g. sequential number generation).
- **Unique constraints** on identifiers that must never collide (Permit
  Number, JSA Number).
- **Foreign keys** to preserve referential integrity between permits,
  JSAs, lifecycle events, audit history, users, teams/positions, and
  capability grants.
- **Check constraints** to enforce invariants at the database level as
  defense in depth (e.g. valid state values), backing up — not
  replacing — application-level validation.
- **Controlled state transitions**, so a permit's status can only move
  between states the finalized workflow actually allows.
- **Append-only lifecycle and audit history** — history rows are
  inserted, not mutated or deleted, by ordinary application operations.
- **Immutable issued/closed historical snapshots** where appropriate, so
  that what was actually issued or closed remains reconstructable even
  if the underlying reference data (e.g. team/position names) changes
  later.

## Numbering

- Permit Numbers and JSA Numbers are distinct identifiers with distinct
  lifecycles (see `WORKFLOW.md` for the rules governing when each
  changes vs. stays the same).
- Number generation must eventually be atomic, unique, and
  concurrency-safe — safe under concurrent requests even though normal
  CRO operation assumes one active CRO at a time (see `SECURITY.md`,
  "Backend concurrency protection is still required generally").
- The specific generation mechanism (sequence, locking strategy, format)
  is an implementation detail to be decided when this section is built,
  not decided in this document.

## Time and Timezone

- Time-sensitive workflow rules (midnight validity, HSE 5-minute window)
  depend on authoritative database/backend time and a configured site
  timezone, not client-supplied time.
- Schema design must account for storing/deriving both an authoritative
  timestamp and the site timezone context needed to evaluate midnight
  boundaries correctly.

## Authorization Data

- No direct operational role column on the user record (no `WORKER`,
  `TEAM_LEAD`, `CRO`, `HSE`, etc.). Operational capabilities are derived
  from a Team + Position relationship, per `WORKFLOW.md` /
  `ARCHITECTURE.md`.
- Privileged management access (CEO, Site Manager) is modeled separately
  from Team + Position, consistent with the rule that Team + Position
  must never automatically grant CEO or Site Manager authority.
- Privileged access changes (grants/revocations) must be represented in
  a way that supports audit history, not just current-state flags.

## Audit / History Data

- Lifecycle events (creation, submission, send-backs, resubmission,
  forwarding, approval, fallback approval, issuance, hold, resume,
  renewal, closure, cancellation) are recorded as append-only history,
  including authenticated actor and authoritative timestamp, and
  reason/remarks where applicable.
- History data is not casually overwritten by ordinary application
  operations, including by privileged management users.

## Notifications and issued documents (migration 0013 - applied and live-verified)

- In-app notifications are recipient-scoped and deduplicated by
  `(source_event_id, recipient_user_id)`. Responsibility handoffs abort
  atomically when authoritative Team + Position capability resolution
  finds no eligible CRO/HSE recipient.
- WhatsApp delivery uses a durable outbox. Workers atomically claim rows
  with a token and lease, retry with bounded backoff, and expose the
  lifecycle event id as the provider idempotency key. Provider I/O is
  outside the permit transaction.
- Issued snapshots are immutable. Migration 0013 refuses corrupt
  historical issued rows, then idempotently backfills one snapshot and
  PDF job for every row with authoritative issuance history, including
  currently ISSUED, HELD, CLOSED, CANCELLED, and renewed permits.
  `issuanceOccurredAt` preserves the original lifecycle decision time;
  `snapshotTakenAt` and the snapshot row `created_at` record DB time when
  0013 actually captured the historical snapshot. They are deliberately
  not backdated to issuance.
- PDF jobs use token-owned leases. A retry after upload/crash reconciles
  an existing private object by SHA-256 and never overwrites a completed
  or mismatched immutable document.
- Outbox/document jobs persist only fixed operational error categories;
  raw provider, Storage, database, URL, header, or credential text is
  neither stored nor printed by worker entry points.
- Live verification found every new application table RLS-enabled, no
  direct `anon`/`authenticated` grants, no new policies, and the immutable
  snapshot protections active. The live database contained zero already-
  issued permits, so the historical backfill correctly had zero rows to
  process.
- Migration `0014_fix_trigger_function_search_paths.sql` is applied and
  live-verified. Both affected trigger functions have
  `search_path=pg_catalog`, remain SECURITY INVOKER, and no longer produce
  Supabase `function_search_path_mutable` warnings. It did not change
  their bodies, triggers, permissions, RLS, grants, or policies.

## Migration 0015 (applied and live-verified)

`0015_backend_integrity_hardening.sql` adds backend-only user access state,
the Company/Other check, immutable snapshot hash-version metadata, intended
PDF render identity, monotonic notification receipts, immutable WhatsApp
business fields, and cross-table lifecycle attribution. New public tables
use RLS without browser-role grants/policies; new trigger functions are
SECURITY INVOKER with `search_path=pg_catalog`.

Live verification confirmed migration id 15, complete ACTIVE backfill for the
existing Auth population, RLS/default-deny on both new tables, zero browser-role
grants or policies, active constraints/triggers, no invalid Company/Other or
snapshot-integrity rows, and removal of the temporary migration hash helper.

## What Is Deliberately Not Decided Here

- Actual table names, columns, and types.
- Actual enum values for permit state beyond what `WORKFLOW.md` already
  describes conceptually.
- The exact numbering/generation mechanism.
- The exact concurrency mechanism (locking strategy vs. optimistic
  versioning) per operation.
- Any Supabase-specific feature usage (e.g. Row Level Security) beyond
  the general principle that database access is mediated through the
  backend.

These are implementation decisions made when the relevant section is
actually built, following the principles above and the process in
`SECURITY.md`.
